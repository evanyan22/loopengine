// The one ReAct loop every agent runs through, and every channel adapter
// (CLI, HTTP, ...) calls unchanged — only their AgentConfig and modelCall
// differ. runAgent itself does no I/O and holds no state between calls:
// callers own conversation history, which is what lets the same function
// serve a one-shot CLI invocation and a long-lived chat session.
import { Gate, RuleSet, ConsoleApprover, type Scope } from 'actauth'
import { SkillGarden } from 'skillgarden'
import { ContextClipper, type Message as ContextClipMessage } from 'contextclip'
import { ToolLane, type ToolCall as LaneCall } from 'toollane'
import { Reflow } from 'reflowkit'
import type { AgentConfig, ToolSchema } from './agent-config.js'

export interface ModelContentBlock {
  type: string
  /** text blocks. */
  text?: string
  /** tool_use blocks: this call's own id (referenced by a later tool_result). */
  id?: string
  /** tool_use blocks. */
  name?: string
  /** tool_use blocks. */
  input?: Record<string, unknown>
  /** tool_result blocks: id of the tool_use block this result answers. */
  tool_use_id?: string
  /** tool_result blocks: the tool's output (or denial/error message). */
  content?: string
  /** tool_result blocks: true if the tool call failed or was denied. */
  is_error?: boolean
}

export interface ModelResponse {
  stop_reason: string
  content: ModelContentBlock[]
}

/** loopengine's own conversation-message type — a superset of
 * ContextClip's `{role, content: string}`: `content` can also be a
 * `ModelContentBlock[]`, the same block shape `ModelResponse.content`
 * already used, so a model's tool_use requests and this loop's
 * tool_result replies round-trip with real per-call identity
 * (`tool_use_id`) instead of being flattened into prose. Plain-string
 * content (a user's message, a skill's injected body, a synthetic
 * compaction note) is just as valid — nothing requires every message to
 * be block-structured. */
export interface Message {
  role: string
  content: string | ModelContentBlock[]
}

/** Swap the Anthropic SDK in here — this is the only seam a real API call needs. */
export type ModelCall = (messages: Message[], system: string, tools: ToolSchema[]) => Promise<ModelResponse>

export interface RunAgentOptions {
  /** Emitted at each loop step for callers that want visibility (logging, UI, tests). Default: no-op. */
  onEvent?: (event: string, detail: unknown) => void
}

export interface RunAgentResult {
  /** Final assistant text for this turn. */
  text: string
  /** Full conversation so far, including this turn — pass back in as
   * `history` on the next call to continue the conversation. Opaque to
   * the caller: store/transmit it, don't inspect or mutate it. */
  history: Message[]
  /** Exactly what this turn added — safe to durably append regardless of
   * whether ContextClip recovery reshaped `history` mid-turn. A caller
   * that persists conversations (see session-store.ts) should use this
   * instead of diffing `history` by length against what it loaded: that
   * only works if `history` only ever grows, which stops being true the
   * moment recovery can shrink/rewrite it, not just extend it. */
  newMessages: Message[]
  /** Set to 'max_turns' if the loop stopped because it hit
   * config.maxTurns, not because the model produced a final answer with
   * no more tool_use blocks — `text` in that case is a synthetic notice,
   * not something the model said. Absent on a normal finish. */
  stopReason?: 'max_turns'
}

/** ContextClip only ever needs a flat string per message to estimate
 * token usage — it doesn't need to understand tool_use/tool_result
 * structure, so this is a one-way, read-only projection, never something
 * that needs to be un-projected back. */
function flattenForContextClip(message: Message): ContextClipMessage {
  if (typeof message.content === 'string') return { role: message.role, content: message.content }
  const text = message.content
    .map((block) => {
      if (block.type === 'text') return block.text ?? ''
      if (block.type === 'tool_use') return `[tool_use ${block.name}(${JSON.stringify(block.input)})]`
      if (block.type === 'tool_result') {
        return `[tool_result for ${block.tool_use_id}]${block.is_error ? ' ERROR' : ''}: ${block.content ?? ''}`
      }
      return `[${block.type}]`
    })
    .join('\n')
  return { role: message.role, content: text }
}

export async function runAgent(
  config: AgentConfig,
  modelCall: ModelCall,
  userMessage: string,
  history: Message[] = [],
  options: RunAgentOptions = {},
): Promise<RunAgentResult> {
  const log = options.onEvent ?? (() => {})
  const scope: Scope = { tenant: 'default', environment: 'production', ...config.scope, agent: config.name }

  const skillGarden = config.skillsDirs?.length
    ? new SkillGarden({ dirs: config.skillsDirs, indexBudgetTokens: config.skillIndexBudgetTokens ?? 200 })
    : null
  const skillIndex = skillGarden?.buildIndex().included ?? []

  // Also the tail-preservation window recover() below relies on — kept as
  // one named constant so the two can never drift out of sync.
  const tailMessages = 4
  const contextClip = new ContextClipper({ budgetTokens: config.contextBudgetTokens ?? 8000, tailMessages })
  const rules = new RuleSet(config.rules, config.defaultDecision ?? 'ask')
  const gate = new Gate(rules, config.approver ?? new ConsoleApprover())
  const toolLane = new ToolLane({ isSafe: config.isSafeTool ?? (() => false) })

  let messages: Message[] = [...history, { role: 'user', content: userMessage }]

  // Tracked in parallel with `messages`, but never rewritten wholesale by
  // recovery the way `messages` is — this is the actual, authoritative
  // answer to "what did this turn add," independent of how many times (if
  // any) the head of `messages` got drained/summarized along the way. See
  // pushMessage() below and the reconciliation inside onPromptTooLong.
  let newMessages: Message[] = [{ role: 'user', content: userMessage }]

  function pushMessage(message: Message): void {
    messages.push(message)
    newMessages.push(message)
  }

  const reflow = new Reflow<Message[]>({
    onPromptTooLong: async (currentMessages) => {
      // newMessages (this turn's own content — not durably stored
      // anywhere else yet) must never be handed to ContextClip at all.
      // An earlier version of this reconciliation tried to recover
      // newMessages *after* compaction by reusing whatever ContextClip's
      // synthetic head contained — that's unsound: ContextClip's cheap
      // "drain" stage doesn't produce a head at all, it just deletes old
      // messages outright, trusting there's a durable copy elsewhere.
      // That trust is only valid for the *prior* portion; only that
      // portion is safe to compact at all.
      const priorCount = currentMessages.length - newMessages.length
      const priorPortion = currentMessages.slice(0, priorCount)

      const result = await contextClip.recover(priorPortion.map(flattenForContextClip))
      log('reflow:recover', { from: currentMessages.length, to: result.messages.length + newMessages.length })
      if (result.action === 'unchanged') return currentMessages

      // Same tail-preservation reuse as before, just scoped to
      // priorPortion alone now — newMessages is appended back whole,
      // always, regardless of how large it's grown this turn.
      const preservedTailCount = Math.min(tailMessages, priorPortion.length)
      const structuredTail = priorPortion.slice(priorPortion.length - preservedTailCount)
      const newHead = result.messages.slice(0, result.messages.length - preservedTailCount)
      const recovered = [...newHead, ...structuredTail, ...newMessages]

      // Reflow.call() only ever returns {value, recoveries, truncated} —
      // it never hands back whatever `currentMessages` became after a
      // retry, so recovery would otherwise only ever affect the one
      // retried call. Reassigning the outer `messages` binding here (this
      // hook is the only place that has both the recovered array and a
      // reason to persist it) is what makes recovery durable: every
      // subsequent contextClip.check() in this loop, and the `history`
      // this function eventually returns, both see the compacted
      // conversation from this point on — not the original, ever-growing
      // one. newMessages itself needs no reconciliation at all — it was
      // never part of what could be compacted away.
      messages = recovered
      return recovered
    },
  })

  // Optional on AgentConfig — an agent can have zero tools.
  const tools = config.tools ?? []
  const toolsByName = new Map(tools.map((t) => [t.name, t]))
  const toolSchemas: ToolSchema[] = tools.map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }))

  // The system prompt below only ever listed skill names/descriptions as
  // prose — nothing told a real model it could actually call a tool named
  // "Skill" to invoke one, so it never would have. One shared schema, not
  // one per skill: the skill's own name is an *input*, exactly what keeps
  // the tool list cheap regardless of how many skills exist — the whole
  // point of SkillGarden's index-now-load-later design. See the
  // toolUseBlocks loop below for where this is actually answered.
  if (skillIndex.length) {
    toolSchemas.push({
      name: 'Skill',
      description: 'Invoke one of the available skills listed in the system prompt, by name.',
      input_schema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: 'Name of the skill to invoke, exactly as listed.' },
          args: {
            type: 'string',
            description: 'Optional arguments for the skill body — substituted for $ARGUMENTS/$1/$2 placeholders.',
          },
        },
        required: ['skill'],
      },
    })
  }

  const systemPrompt = skillIndex.length
    ? `${config.systemPrompt}\n\nAvailable skills:\n${skillIndex.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`
    : config.systemPrompt

  // Nothing else in this loop bounds a model stuck re-requesting the same
  // (or ping-ponging) tool calls forever — checked before spending a model
  // call on the (maxTurns + 1)-th turn, not after.
  const maxTurns = config.maxTurns ?? 25
  let turn = 0

  for (;;) {
    turn++
    if (turn > maxTurns) {
      const text = `Stopped after ${maxTurns} turns without a final answer — the agent may be stuck in a loop.`
      pushMessage({ role: 'assistant', content: text })
      log('loop:max_turns', { maxTurns })
      return { text, history: messages, newMessages, stopReason: 'max_turns' }
    }

    const budget = contextClip.check(messages.map(flattenForContextClip))
    log('contextclip:check', budget)
    if (budget.action === 'nudge' && budget.nudge) pushMessage(budget.nudge)

    const { value: response, recoveries } = await reflow.call(
      (msgs) => modelCall(msgs, systemPrompt, toolSchemas),
      messages,
    )
    if (recoveries.length > 0) log('reflow:recoveries', recoveries)

    // The model's full response — text and tool_use blocks alike, with
    // real ids — becomes this turn's assistant message verbatim. Every
    // tool_use block emitted here gets a matching tool_result pushed
    // below before the loop continues; a real model API expects exactly
    // that pairing on the next request, not a prose summary of it.
    pushMessage({ role: 'assistant', content: response.content })

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use')

    if (toolUseBlocks.length === 0) {
      const text = response.content.find((b) => b.type === 'text')?.text ?? ''
      log('loop:done', text)
      return { text, history: messages, newMessages }
    }

    const resultBlocks: ModelContentBlock[] = []
    const approvedCalls: LaneCall[] = []

    for (const block of toolUseBlocks) {
      // Skill invocation injects instructions into context; it isn't a
      // real tool call and doesn't need ActAuth gating or ToolLane
      // scheduling — but it's still a tool_use block the model emitted,
      // so it still needs a tool_result to answer it, same as any other.
      if (block.name === 'Skill' && skillGarden) {
        const body = skillGarden.invoke(block.input!.skill as string, block.input?.args as string | undefined)
        log('skillgarden:invoke', block.input!.skill)
        resultBlocks.push({ type: 'tool_result', tool_use_id: block.id!, content: body })
        continue
      }

      const decision = await gate.evaluate(block.name!, block.input ?? {}, scope)
      log('actauth:decision', { tool: block.name, decision: decision.decision, reason: decision.reason })
      if (decision.decision === 'allow') {
        approvedCalls.push({
          id: block.id!,
          name: block.name!,
          execute: () => toolsByName.get(block.name!)!.execute(block.input ?? {}),
        })
      } else {
        // Every requested tool gets exactly one tool_result back — a
        // denied call is not simply dropped, or the model has no way to
        // tell "denied" apart from "hasn't run yet" and may just
        // re-request it forever.
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id!,
          content: `denied: ${decision.reason}`,
          is_error: true,
        })
      }
    }

    // result.id is the same id LaneCall.id was given above — the exact
    // per-call identity that makes it possible to link a result back to
    // the specific tool_use block that requested it, even when several
    // calls ran in the same parallel lane. The old flattened-text design
    // could only link by tool *name*, ambiguous the moment two calls to
    // the same tool ran in one turn.
    for await (const result of toolLane.run(approvedCalls)) {
      const summary = result.status === 'fulfilled' ? JSON.stringify(result.value) : `ERROR: ${result.error}`
      log('toollane:result', { name: result.name, summary })
      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: result.id,
        content: summary,
        is_error: result.status === 'rejected',
      })
    }

    pushMessage({ role: 'user', content: resultBlocks })
  }
}
