// The one ReAct loop every agent runs through, and every channel adapter
// (CLI, HTTP, ...) calls unchanged — only their AgentConfig and modelCall
// differ. runAgent itself does no I/O and holds no state between calls:
// callers own conversation history, which is what lets the same function
// serve a one-shot CLI invocation and a long-lived chat session.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { Gate, RuleSet, ConsoleApprover, type Scope, type Decision, type Condition } from 'actauth'
import { SkillGarden } from 'skillgarden'
import { ContextClipper, type Message as ContextClipMessage } from 'contextclip'
import { ToolLane, type ToolCall as LaneCall, type SafetyClassifier } from 'toollane'
import { Reflow } from 'reflowkit'
import type { AgentConfig, ToolDefinition, ToolSchema } from './agent-config.js'
import { loadAgentModule } from './discover-agents.js'
import { agentAsTool } from './agent-as-tool.js'

// Resolved relative to *this file's own location* (via import.meta.url),
// not process.cwd() — the same reasoning agent-registry.ts's own
// agentsDir uses. In dev (tsx), this file and agents/ are both source
// .ts, side by side. In the built dist/, this file is dist/run-agent.js
// and its sibling agents/ is dist/agents/**/*.js (tsc-compiled) — cwd is
// irrelevant to either case, only "next to this module" is reliably
// right in both. skillsDirs/rules don't need this: actauth.yml/SKILL.md
// are plain data copied verbatim into the image (see Dockerfile), so
// they exist at the same cwd-relative path either way; a tools/index.ts
// is real code that only exists compiled, at a different relative
// location, once dist/ is what's actually running.
const agentsRootDir = join(dirname(fileURLToPath(import.meta.url)), 'agents')

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
  /** The ActAuth tenant this call runs as — feeds the Gate's scope, so it
   * governs which rules apply. runAgent() never sees a request, so it
   * can't call AgentConfig.tenantFor itself; adapters/http.ts resolves it
   * per request and passes the result here. Default `'default'`, same as
   * omitting it — every standalone/CLI caller (which never has a request
   * to resolve tenantFor from) gets that default automatically. */
  tenant?: string
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

interface RawYamlRule {
  name?: string
  scope: string
  tool: string
  decision: Decision
  when?: Condition
}

/** Parses a loopengine actauth.yml — same shape as examples/actauth.yml
 * in the actauth package, except each rule's `scope` only needs
 * tenant/environment (a wildcard/wildcard, wildcard/staging, or
 * acme-corp/production pair, say) — the agent segment is appended
 * automatically from AgentConfig.name, then handed to actauth's own
 * RuleSet.fromRaw (not fromYamlFile, which
 * expects the full 3-segment scope already baked into the file). A
 * per-agent actauth.yml (this repo's own convention: one file, one
 * agent, path derived from the agent's own name — see
 * agents/customer-service/actauth.yml) can only ever describe rules for
 * that one agent anyway, so repeating its name in every single rule is
 * exactly the kind of boilerplate skillsDirs/rules/tools' own defaults
 * already avoid elsewhere in this file. */
function loadYamlRules(path: string, agentName: string): RuleSet {
  const raw = (parseYaml(readFileSync(path, 'utf8')) ?? {}) as { default_decision?: Decision; rules?: RawYamlRule[] }
  // A rule already ending in /<agentName> — the old, full 3-segment habit,
  // or examples/actauth.yml copied verbatim — is left alone rather than
  // getting a second, invalid segment appended; only the new 2-segment
  // (tenant/environment) form actually needs the suffix.
  const rules = (raw.rules ?? []).map((r) => ({
    ...r,
    scope: r.scope.endsWith(`/${agentName}`) ? r.scope : `${r.scope}/${agentName}`,
  }))
  return RuleSet.fromRaw({ default_decision: raw.default_decision, rules })
}

/** Resolves AgentConfig.rules the same way skillsDirs resolves its own
 * default: an inline array is used as-is (full 3-segment scopePattern,
 * unchanged — see loadYamlRules for why only the YAML form gets the
 * agent segment auto-appended); omitted entirely defaults to
 * `agents/<name>/actauth.yml`, this repo's own folder-form convention.
 * Unlike skillsDirs, a missing *default* file falls back to an empty
 * ruleset rather than propagating the raw ENOENT — permissions failing
 * shouldn't crash the whole call. That fallback defaults to `'deny'`, not
 * the inline-array form's `'ask'`: no `actauth.yml` at all means this
 * agent's permission story was never actually written, which is a
 * stricter unknown than "written, but this one tool has no rule" — 'ask'
 * still runs an Approver that could auto-approve, while 'deny' refuses
 * outright until real rules exist. `defaultDecision`, if set, still wins
 * over that. An *explicitly* given path that doesn't exist is a real
 * configuration bug, though, and still throws — only the silent, implicit
 * default gets this forgiveness.
 *
 * Exported (alongside loadDefaultTools below) so adapters/http.ts's
 * GET /agents/:name/config route can show the same rules runAgent() would
 * actually enforce, not a re-derived guess at them. */
export function loadRules(config: AgentConfig): RuleSet {
  if (Array.isArray(config.rules)) return new RuleSet(config.rules, config.defaultDecision ?? 'ask')

  const usingDefaultPath = config.rules === undefined
  const path = config.rules ?? `agents/${config.name}/actauth.yml`
  try {
    return loadYamlRules(path, config.name)
  } catch (err) {
    if (usingDefaultPath && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return new RuleSet([], config.defaultDecision ?? 'deny')
    }
    throw err
  }
}

/** Resolves AgentConfig.tools the same way loadRules resolves its own
 * default: an explicit array (including `[]`) is used as-is; omitted
 * entirely defaults to importing `agents/<name>/tools/index.{ts,js}`
 * (this repo's own aggregation-file convention — see
 * `agents/customer-service/tools/index.ts`) and using its exported
 * `tools`. A missing file there is not an error — a flat-file agent with
 * no tools folder at all (or one merging in dynamically-loaded tools, like
 * `agents/file-agent/index.ts`'s Composio ones, so it can't just rely on
 * this default) just gets `[]`, same as if it had explicitly set that. A
 * module that *does* exist but throws while importing, or doesn't export
 * `tools` at all, is a real bug and is not swallowed. */
export async function loadDefaultTools(config: AgentConfig): Promise<ToolDefinition[]> {
  const toolsDir = join(agentsRootDir, config.name, 'tools')
  for (const indexName of ['index.ts', 'index.js']) {
    const indexPath = join(toolsDir, indexName)
    if (!existsSync(indexPath)) continue
    const mod = (await import(pathToFileURL(indexPath).href)) as { tools?: ToolDefinition[] }
    if (!Array.isArray(mod.tools)) {
      throw new Error(`${indexPath} does not export a 'tools' array — every agents/<name>/tools/index file must.`)
    }
    return mod.tools
  }
  return []
}

/** Auto-loads agents/<name>/subagents/<child>/index.{ts,js} — each one a
 * full AgentConfig, wrapped with agentAsTool and merged into `config`'s
 * own tools, no import or AgentConfig.tools edit required. Unlike
 * loadDefaultTools, this always runs regardless of whether `config.tools`
 * was left to its own default or set explicitly — see AgentConfig.tools's
 * own doc comment for why subagents are a distinct concern from
 * hand-written tools. A missing subagents/ folder is just `[]`, same
 * missing-is-fine treatment tools/ and skills/ get; a subdirectory with
 * neither index.ts nor index.js is skipped, same as resolveModulePath's
 * own handling in discover-agents.ts.
 *
 * Each subagent is loaded via loadAgentModule — the same per-module
 * resolution discoverAgents itself uses — so a subagent's own `config`
 * goes through this exact same function again the next time *it* runs
 * (inside agentAsTool's execute, via runAgent). That's what makes nesting
 * (a subagent with its own subagents/ folder) work with no extra
 * recursion code: it's just this function being called again, one level
 * down. A folder can't be its own ancestor, so this can't cycle the way a
 * hand-wired agentAsTool(getEntry(...)) call elsewhere could. */
async function loadSubagentTools(config: AgentConfig): Promise<ToolDefinition[]> {
  const subagentsDir = join(agentsRootDir, config.name, 'subagents')
  if (!existsSync(subagentsDir)) return []

  const tools: ToolDefinition[] = []
  for (const dirent of readdirSync(subagentsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue

    const indexPath = ['index.ts', 'index.js'].map((n) => join(subagentsDir, dirent.name, n)).find((p) => existsSync(p))
    if (!indexPath) continue

    const label = `agents/${config.name}/subagents/${dirent.name}/index`
    const subagent = await loadAgentModule(indexPath, label)
    tools.push(agentAsTool(subagent.config, subagent.createModelCall))
  }
  return tools
}

export async function runAgent(
  config: AgentConfig,
  modelCall: ModelCall,
  userMessage: string,
  history: Message[] = [],
  options: RunAgentOptions = {},
): Promise<RunAgentResult> {
  const log = options.onEvent ?? (() => {})
  // tenant: resolved by the caller (adapters/http.ts calls
  // AgentConfig.tenantFor with the request's headers/body; every other
  // caller — adapters/cli.ts, a standalone script — has no request to
  // resolve it from, so it never passes this option and gets 'default').
  // environment: a deployment-wide setting,
  // not a per-agent or per-request one — always LOOPENGINE_ENV, same
  // everywhere this process runs, never something an AgentConfig defines.
  const scope: Scope = { tenant: options.tenant ?? 'default', environment: process.env.LOOPENGINE_ENV ?? 'production', agent: config.name }

  // Optional on AgentConfig — an agent can have zero tools. Explicit
  // (including `[]`) is used as-is; omitted entirely defaults to
  // importing agents/<name>/tools/index.{ts,js} — see loadDefaultTools's
  // own doc comment for the full reasoning and the cases that can't use it.
  // agents/<name>/subagents/* is merged in on top either way — see
  // loadSubagentTools's own doc comment for why that one isn't gated by
  // whether `tools` was explicit.
  const tools = [...(config.tools ?? (await loadDefaultTools(config))), ...(await loadSubagentTools(config))]

  // Omitted entirely (undefined): default to this agent's own
  // agents/<name>/skills — the folder-form convention every agent in
  // this repo already follows (see agent-config.ts's skillsDirs doc
  // comment). An explicit `[]` is a real opt-out, not "unset," and skips
  // the default — SkillGarden's own missing-directory handling
  // (discoverSkillFiles walks best-effort, no throw) is what makes
  // pointing this at a folder that doesn't exist (a flat-file agent with
  // no skills at all) harmless: an empty index, not an error.
  const skillsDirs = config.skillsDirs ?? [`agents/${config.name}/skills`]
  const skillGarden = skillsDirs.length ? new SkillGarden({ dirs: skillsDirs, indexBudgetTokens: config.skillIndexBudgetTokens ?? 200 }) : null
  const skillIndex = skillGarden?.buildIndex().included ?? []

  // Also the tail-preservation window recover() below relies on — kept as
  // one named constant so the two can never drift out of sync.
  const tailMessages = 4
  const contextClip = new ContextClipper({ budgetTokens: config.contextBudgetTokens ?? 8000, tailMessages })
  const rules = loadRules(config)
  const gate = new Gate(rules, config.approver ?? new ConsoleApprover())
  // No explicit isSafeTool: fall back to each called tool's own `safe`
  // flag (looked up by name) rather than defaulting every tool to unsafe
  // outright — see ToolDefinition.safe's own doc comment for why this is
  // the less powerful of the two (name-only, no per-call nuance).
  const isSafeTool: SafetyClassifier =
    config.isSafeTool ?? ((call) => tools.some((t) => t.name === call.name && t.safe === true))
  const toolLane = new ToolLane({ isSafe: isSafeTool })

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
