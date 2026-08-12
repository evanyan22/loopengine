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
  const reflow = new Reflow<Message[]>({
    onPromptTooLong: async (currentMessages) => {
      const result = await contextClip.recover(currentMessages.map(flattenForContextClip))
      log('reflow:recover', { from: currentMessages.length, to: result.messages.length })
      if (result.action === 'unchanged') return currentMessages

      // recover() guarantees the most recent `tailMessages` are never
      // touched — reuse the original structured messages for that slice,
      // so tool_use/tool_result fidelity survives recovery. Only the
      // collapsed head becomes new, synthetic plain-text messages;
      // draining/summarizing genuinely destroys per-message structure,
      // so there's nothing more precise to preserve there.
      const preservedTailCount = Math.min(tailMessages, currentMessages.length)
      const structuredTail = currentMessages.slice(currentMessages.length - preservedTailCount)
      const newHead = result.messages.slice(0, result.messages.length - preservedTailCount)
      return [...newHead, ...structuredTail]
    },
  })

  // Optional on AgentConfig — an MCP-only agent's tools are populated by
  // load-agent.ts before this ever runs, but default defensively here too
  // in case a config reaches runAgent without going through it.
  const tools = config.tools ?? []
  const toolsByName = new Map(tools.map((t) => [t.name, t]))
  const toolSchemas: ToolSchema[] = tools.map(({ name, description, input_schema }) => ({
    name,
    description,
    input_schema,
  }))

  const systemPrompt = skillIndex.length
    ? `${config.systemPrompt}\n\nAvailable skills:\n${skillIndex.map((s) => `- ${s.name}: ${s.description}`).join('\n')}`
    : config.systemPrompt

  let messages: Message[] = [...history, { role: 'user', content: userMessage }]

  for (;;) {
    const budget = contextClip.check(messages.map(flattenForContextClip))
    log('contextclip:check', budget)
    if (budget.action === 'nudge' && budget.nudge) messages.push(budget.nudge)

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
    messages.push({ role: 'assistant', content: response.content })

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use')

    if (toolUseBlocks.length === 0) {
      const text = response.content.find((b) => b.type === 'text')?.text ?? ''
      log('loop:done', text)
      return { text, history: messages }
    }

    const resultBlocks: ModelContentBlock[] = []
    const approvedCalls: LaneCall[] = []

    for (const block of toolUseBlocks) {
      // Skill invocation injects instructions into context; it isn't a
      // real tool call and doesn't need ActAuth gating or ToolLane
      // scheduling — but it's still a tool_use block the model emitted,
      // so it still needs a tool_result to answer it, same as any other.
      if (block.name === 'Skill' && skillGarden) {
        const body = skillGarden.invoke(block.input!.skill as string)
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

    messages.push({ role: 'user', content: resultBlocks })
  }
}
