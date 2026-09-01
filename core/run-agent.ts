// The one ReAct loop every agent runs through, and every channel adapter
// (CLI, HTTP, ...) calls unchanged — only their AgentConfig and modelCall
// differ. runAgent itself does no I/O and holds no state between calls:
// callers own conversation history, which is what lets the same function
// serve a one-shot CLI invocation and a long-lived chat session.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { Gate, RuleSet, ConsoleApprover, type Approver, type Scope, type Decision, type Condition } from 'actauth'
import { SkillGarden } from 'skillgarden'
import { BudgetTracker, type Message as BudgetMessage } from './budget.js'
import { Compactor } from './compaction.js'
import { ToolLane, type ToolCall as LaneCall, type SafetyClassifier } from 'toollane'
import { Recovery } from './recovery.js'
import type { AgentConfig, ApproverChannel, QuestionHandler, ToolDefinition, ToolSchema } from '#core/agent-config.js'
import { loadAgentModule } from './discover-agents.js'
import { agentAsTool } from './agent-as-tool.js'
import { loadGatewayToolsFromDir } from './gateway-tools.js'
import { systemTools, createAskUserTool, CliQuestionHandler, isDurableQuestionHandler, type PendingQuestion } from './system-tools/index.js'
import { resolveHttpNotifier } from './http-notifier.js'
import type { LoopEvent } from './loop-events.js'
import { CRASH_RECOVERY_CONTINUATION } from './session-store.js'
export { systemTools } from './system-tools/index.js'
export type * from './loop-events.js'

// Resolved relative to *this file's own location* (via import.meta.url),
// not process.cwd() — the same reasoning core/agent-registry.ts's own
// agentsDir uses. In dev (tsx), this file lives in core/ with agents/ one
// level up, at repo root. In the built dist/, this file is
// dist/core/run-agent.js with dist/agents/**/*.js (tsc-compiled,
// preserving the source tree's shape) one level up from *it* the same
// way — cwd is irrelevant to either case, only "one level up from this
// module" is reliably right in both. skillsDirs/rules don't need this:
// actauth.yml/SKILL.md are plain data copied verbatim into the image (see
// Dockerfile), so they exist at the same cwd-relative path either way; a
// tools/index.ts is real code that only exists compiled, at a different
// relative location, once dist/ is what's actually running.
const agentsRootDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents')

// agentsRootDir above is right when agents/ is compiled alongside core/
// into the same dist/ tree (this repo's own reference agents; also this
// repo's own Dockerfile, which copies dist/agents/**/*.js this way) — but
// a project that only *depends on* the published loopengine package has
// no dist/agents/<name> inside node_modules/loopengine at all, just its
// own agents/<name>/ at the project root, found only via process.cwd(),
// the same way loadRules/skillsDirs already resolve their own (data, not
// code) defaults. Tried first since it's this repo's own existing,
// tested behavior; process.cwd() only kicks in when nothing's built
// there to find — so this repo's own agents are unaffected either way.
function resolveAgentCodeDir(name: string, subpath: string, indexRequired: boolean): string {
  const built = join(agentsRootDir, name, subpath)
  const builtExists = indexRequired
    ? existsSync(join(built, 'index.ts')) || existsSync(join(built, 'index.js'))
    : existsSync(built)
  return builtExists ? built : join(process.cwd(), 'agents', name, subpath)
}

// Same "resolved relative to this file's own location" reasoning as
// agentsRootDir above, but system-skills/ is a same-level sibling of
// run-agent.ts itself (both live directly under core/ — see package.json's
// own "files" list), not one level up the way agents/ is, so this one
// stays a direct join with no '..'.
export const systemSkillsDir = join(dirname(fileURLToPath(import.meta.url)), 'system-skills')

// Tools every agent gets (see systemTools' own doc comment) are merged
// in *first*, not last — combined with keeping each name's *last*
// occurrence (a plain Map naturally does this: re-setting an existing
// key overwrites its value without moving it), that means an agent's
// own tool of the same name (config.tools, a subagent, a gateway source)
// always wins over the system default, never the reverse. Also used to
// dedupe the *array itself*, not just resolution at call time — without
// this, a name collision would still show up twice in toolSchemas,
// confusing (or rejected outright by) a real model API.
export function dedupeToolsByName(list: ToolDefinition[]): ToolDefinition[] {
  return [...new Map(list.map((t) => [t.name, t])).values()]
}

export interface ModelContentBlock {
  type: string
  /** text blocks, and thinking blocks (a model's own chain-of-thought,
   * e.g. DeepSeek's `reasoning_content` sibling field, or — if a
   * model-calls/* adapter ever opts into it — Anthropic's own `thinking`
   * content block). Reuses this same field rather than adding a
   * thinking-only one, since both are just "a string of the model's own
   * words." Carried opaquely: loopengine never reads or reasons about
   * this text itself, only round-trips it back verbatim on the next
   * request that includes this message — some reasoning-mode providers
   * (DeepSeek's thinking mode, confirmed live; Anthropic's extended
   * thinking, documented the same way) reject the request outright if a
   * prior turn's reasoning gets silently dropped on the way back in,
   * once the conversation has tool_calls in it. */
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
  /** tool_result blocks: the actauth decision's own reason this call was
   * allowed (e.g. "matched rule '...'"). Extra metadata riding alongside
   * `content`, not folded into it — every model-calls/* adapter
   * explicitly whitelists which fields it forwards to a real model API,
   * so this never reaches the model, only a caller (the playground)
   * inspecting stored history directly. */
  reason?: string
}

export interface ModelResponse {
  stop_reason: string
  content: ModelContentBlock[]
}

/** loopengine's own conversation-message type — a superset of
 * budget.ts's own `{role, content: string}`: `content` can also be a
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
  /** Emitted at each loop step for callers that want visibility (logging, UI, tests) —
   * see loop-events.ts's own header comment for why this is a single typed
   * union rather than a string name plus untyped detail. Default: no-op. */
  onEvent?: (event: LoopEvent) => void
  /** The ActAuth tenant this call runs as — feeds the Gate's scope, so it
   * governs which rules apply. runAgent() never sees a request, so it
   * can't call AgentConfig.tenantFor itself; adapters/http.ts resolves it
   * per request and passes the result here. Default `'default'`, same as
   * omitting it — every standalone/CLI caller (which never has a request
   * to resolve tenantFor from) gets that default automatically. */
  tenant?: string
  /** This call's own session id (the *raw* one — see adapters/http.ts's
   * own rawSessionId/storageSessionId distinction, this is the former),
   * if the caller has one. runAgent() never sees a request or a
   * SessionStore itself, so it can't derive this on its own — passed
   * through purely so a pending ask_user question can be tagged with
   * which session raised it (see system-tools/ask_user.ts's own
   * PendingQuestion.sessionId), letting a caller list/answer questions
   * scoped to one conversation instead of every one this process has ever
   * seen. Omitted (a standalone script, most CLI usage) just means a
   * pending question can't be session-scoped — still fine, it's still
   * agent-scoped either way. */
  sessionId?: string
  /** Which channel this call is on — checked below against `'http'`,
   * the only value `AgentConfig.httpNotifier` ever matches (see that
   * field's own doc comment). Omitted (a standalone script, a bespoke
   * dispatcher with no fixed channel identity) means `httpNotifier` is
   * never consulted at all — `approver` below is the only thing that
   * applies. */
  channel?: ApproverChannel
  /** This call's own default Approver for 'ask' decisions, when
   * `AgentConfig.httpNotifier` doesn't supply one (only possible on the
   * `http` channel, and only when it lists `'approval'`) — the seam an
   * adapter uses to pick whichever approver actually fits its own channel
   * (ConsoleApprover for a real terminal, a fresh WebchatApprover per
   * streamed turn, a WebhookApprover for a background dispatcher,
   * ...) without every agent needing to hardcode one itself. `http`'s own
   * `httpNotifier`, if it covers `'approval'`, still wins outright over
   * this — the agent author's own explicit choice *for that channel*
   * beats whatever the adapter would otherwise default to (see Gate
   * construction below) — `cli`/`http_stream` have no such override at
   * all, so this is the only thing that ever applies there. Default, if
   * neither is given: actauth's own ConsoleApprover, same as always.
   *
   * Can be a DurableApprover (WebhookApprover, ...) instead of a live
   * one — see HUMAN_IN_THE_LOOP.md. A background/cron dispatcher calling
   * runAgent() directly is exactly this same kind of caller, and should
   * pass its own durable default here the same way adapters/http.ts's
   * stream route passes a fresh WebchatApprover. */
  approver?: Approver
  /** Fired the instant the system ask_user tool registers a new pending
   * question — this is the seam that decides between a real, answerable
   * pending question (something adapters/http.ts's own /questions REST
   * endpoints, or an SSE push, can resolve later) and a blocking terminal
   * prompt with nowhere else to go (see system-tools/ask_user.ts's own
   * promptOnConsole).
   *
   * Deliberately its own option, not inferred from onEvent above —
   * onEvent means "please tell me about loop events" (adapters/cli.ts
   * passes one purely to log them), not "I have a way to actually answer
   * a question later." Conflating the two was a real bug: it made a
   * plain `loopengine run` hang forever registering an unanswerable
   * question instead of just prompting in the terminal it's already
   * attached to — confirmed live before this existed. Only an adapter
   * that genuinely has an answering mechanism (adapters/http.ts, for both
   * its routes) should pass this. */
  onQuestionPending?: (question: PendingQuestion) => void
  /** This call's own default QuestionHandler — question-side sibling of
   * `approver` above, same precedence (`AgentConfig.httpNotifier`, when it
   * covers `'question'` on the `http` channel, still wins outright over
   * this) and the same `LiveQuestionHandler | DurableQuestionHandler`
   * union `approver` itself is, duck-typed the same way (see
   * `isDurableQuestionHandler`). Default, if neither this nor
   * `httpNotifier` supplies one: `new CliQuestionHandler()` — same role
   * `new ConsoleApprover()` plays for `approver`.
   *
   * One real, current asymmetry versus `approver`: only the *durable*
   * half of this union is actually wired into the loop below — a
   * `system_ask_user` call only ever consults this field to decide
   * live-vs-durable; the live case still always falls through to
   * `onQuestionPending`/the tool's own independent live resolution
   * (unchanged from before this field existed), never actually calling
   * a live `QuestionHandler` resolved here. See HUMAN_IN_THE_LOOP.md's
   * "Durable questions" section for why: fully wiring the live half too
   * would mean moving system_ask_user's answer-collection inline into
   * this loop (changing today's batching semantics — right now a
   * pending question is deferred past the whole tool_use batch scan,
   * unlike a live approval) and a breaking change to createAskUserTool's
   * own signature — deliberately deferred rather than done half-carefully
   * here. */
  questionHandler?: QuestionHandler
}

export interface RunAgentResult {
  /** Final assistant text for this turn. */
  text: string
  /** Full conversation so far, including this turn — pass back in as
   * `history` on the next call to continue the conversation. Opaque to
   * the caller: store/transmit it, don't inspect or mutate it. */
  history: Message[]
  /** Exactly what this turn added — safe to durably append regardless of
   * whether compaction.ts's own recovery reshaped `history` mid-turn. A caller
   * that persists conversations (see session-store.ts) should use this
   * instead of diffing `history` by length against what it loaded: that
   * only works if `history` only ever grows, which stops being true the
   * moment recovery can shrink/rewrite it, not just extend it. */
  newMessages: Message[]
  /** Set when the loop stopped for a reason other than the model
   * producing a final answer with no more tool_use blocks — `text` in
   * either case is a synthetic notice, not something the model said.
   * Absent on a normal finish.
   *
   * 'max_turns': hit config.maxTurns without a final answer.
   *
   * 'denied': a human denied at least one requested tool call this turn
   * (see actauth's own 'ask'/'deny' decisions) — the loop stops right
   * there instead of feeding "denied: ..." back to the model and letting
   * it keep going on its own, the same way Claude Code itself stops an
   * entire pending batch rather than quietly carrying out the parts you
   * didn't object to. A denial cancels the *whole* turn's batch, not
   * just the call(s) that were themselves denied — any other call the
   * model requested in the same turn, even one already approved, never
   * runs either (see the loop's own body); it gets a "skipped", not a
   * "denied", tool_result, since it was never evaluated against its own
   * rule.
   *
   * 'pending_approval' / 'pending_question': at least one requested tool
   * call is durably pending a DurableApprover decision, or at least one
   * `system_ask_user` call is durably pending a DurableQuestionHandler
   * answer (see HUMAN_IN_THE_LOOP.md) — same "the whole batch stops here"
   * shape as 'denied', except this isn't a rejection: any already-run
   * sibling call in the same batch still ran (see the loop's own
   * bucket-then-execute), captured in `pending.resultsSoFar`, and the
   * turn resumes later via resumeAgent() once every pendingId in
   * `pending.outstanding` is resolved — not by sending another message
   * the way 'denied' recovers. A batch can mix both kinds (a gated tool
   * call and an `system_ask_user` call in the same model response) — both
   * land in the same `pending.outstanding`, since the one dangling
   * assistant tool_use message can only ever get one completing
   * tool_result message; `stopReason` reports 'pending_approval' for that
   * mixed case too (only a batch with *no* approval items at all reports
   * 'pending_question'). `newMessages` ends at the dangling assistant
   * tool_use message, same crash-recovery shape session-store.ts's own
   * hasUnresolvedToolCall already detects — entered on purpose here,
   * not by accident. runAgent() does no I/O (see this module's own
   * header comment): turning `pending` into a durable TurnCheckpoint
   * (core/durable-approvals.ts) is the caller's job. */
  stopReason?: 'max_turns' | 'denied' | 'pending_approval' | 'pending_question'
  /** Set only when stopReason is 'pending_approval' or 'pending_question'. */
  pending?: {
    /** tool_result blocks already computed this batch — safely
     * auto-allowed calls that ran immediately despite a gated/asked
     * sibling still being outstanding. Not yet pushed into `newMessages`/
     * `history`: incomplete until every outstanding item below is
     * resolved too, and a real model API expects one complete
     * tool_result message per assistant tool_use message, not a partial
     * one now and a follow-up later. */
    resultsSoFar: ModelContentBlock[]
    /** One entry per tool call still awaiting a durable decision, keyed
     * by the pendingId its DurableApprover/DurableQuestionHandler handed
     * out — what an incoming resolution actually names. `kind`
     * distinguishes which of the two this is — for 'question', `args` is
     * `{ question, options }` and `reason` is the question text itself
     * (there's no separate ActAuth "reason" for a question the way there
     * is for a gated tool call's decision). */
    outstanding: PendingItem[]
  }
}

/** One requested call still awaiting a durable decision — either a gated
 * tool call (`kind: 'approval'`) or a `system_ask_user` call (`kind:
 * 'question'`), unified into one array so a batch mixing both shares
 * exactly one checkpoint (see RunAgentResult.stopReason's own doc
 * comment for why that has to be true). */
export interface PendingItem {
  kind: 'approval' | 'question'
  toolUseId: string
  tool: string
  args: Record<string, unknown>
  pendingId: string
  reason: string
}

/** budget.ts/compaction.ts only ever need a flat string per message to
 * estimate token usage — neither needs to understand tool_use/tool_result
 * structure, so this is a one-way, read-only projection, never something
 * that needs to be un-projected back. */
function flattenForBudget(message: Message): BudgetMessage {
  if (typeof message.content === 'string') return { role: message.role, content: message.content }
  const text = message.content
    .map((block) => {
      if (block.type === 'text' || block.type === 'thinking') return block.text ?? ''
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
async function loadToolsFromDir(toolsDir: string): Promise<ToolDefinition[]> {
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

export async function loadDefaultTools(config: AgentConfig): Promise<ToolDefinition[]> {
  return loadToolsFromDir(resolveAgentCodeDir(config.name, 'tools', true))
}

/** Every other folder-form default in this file (loadDefaultTools,
 * loadRules, the skillsDirs default below) resolves against
 * `agents/<name>/` — correct for a top-level agent, where that's exactly
 * where its module lives, but wrong for a subagent: its `config` only
 * carries its own bare name (e.g. 'billing-agent'), not the nested folder
 * loadSubagentAsTools actually found it in
 * (`agents/support-orchestrator/subagents/billing-agent/`). Left alone,
 * an omitted `tools`/`rules`/`skillsDirs` on a subagent would silently
 * resolve against `agents/billing-agent/...` instead — empty, if no such
 * top-level folder exists, or worse, some *unrelated* top-level agent's
 * tools/rules/skills, if one happens to share the same name.
 *
 * This patches exactly those three fields — only when the subagent's own
 * config left them unset — to resolve against `dir`, its real folder,
 * before it's ever handed to agentAsTool/runAgent. An explicit value on
 * the subagent's own config (its author opted out on purpose) is always
 * left untouched. `rules` gets the same "missing file is fine, empty
 * deny-everything ruleset" fallback loadRules's own default path gets —
 * computed here instead of left to loadRules, since leaving `rules`
 * unset would have it fall through to loadRules's *own* (wrong,
 * name-based) default path instead of this one.
 *
 * `gateway-tools.yml` (see gateway-tools.ts) gets the same dir-correctness
 * fix, but merged in unconditionally rather than gated on `tools` being
 * unset — same reasoning loadSubagentAsTools' own unconditional merge into
 * the top-level tools line has: gateway-registered tools are an
 * operator/admin concern, distinct from hand-written `tools`, so setting
 * `tools` explicitly shouldn't opt a subagent out of its own
 * gateway-tools.yml the way it opts out of the tools/ folder default. */
async function resolveSubagentConfig(config: AgentConfig, dir: string): Promise<AgentConfig> {
  const resolved = { ...config }

  const baseTools = resolved.tools === undefined ? await loadToolsFromDir(join(dir, 'tools')) : resolved.tools
  resolved.tools = [...baseTools, ...(await loadGatewayToolsFromDir(dir))]

  if (resolved.rules === undefined) {
    const rulesPath = join(dir, 'actauth.yml')
    if (existsSync(rulesPath)) {
      resolved.rules = rulesPath
    } else {
      resolved.rules = []
      resolved.defaultDecision = resolved.defaultDecision ?? 'deny'
    }
  }

  if (resolved.skillsDirs === undefined) {
    resolved.skillsDirs = [join(dir, 'skills')]
  }

  return resolved
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
 * resolution discoverAgents itself uses — then patched by
 * resolveSubagentConfig (see its own doc comment for why) before being
 * wrapped. Its own `config` goes through this exact same function again
 * the next time *it* runs (inside agentAsTool's execute, via runAgent).
 * That's what makes nesting (a subagent with its own subagents/ folder)
 * work with no extra recursion code: it's just this function being
 * called again, one level down. A folder can't be its own ancestor, so
 * this can't cycle the way a hand-wired agentAsTool(getEntry(...)) call
 * elsewhere could. */
export async function loadSubagentAsTools(config: AgentConfig): Promise<ToolDefinition[]> {
  const subagentsDir = resolveAgentCodeDir(config.name, 'subagents', false)
  if (!existsSync(subagentsDir)) return []

  const tools: ToolDefinition[] = []
  for (const dirent of readdirSync(subagentsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue

    const dir = join(subagentsDir, dirent.name)
    const indexPath = ['index.ts', 'index.js'].map((n) => join(dir, n)).find((p) => existsSync(p))
    if (!indexPath) continue

    const label = `agents/${config.name}/subagents/${dirent.name}/index`
    const subagent = await loadAgentModule(indexPath, label)
    const subagentConfig = await resolveSubagentConfig(subagent.config, dir)
    tools.push(agentAsTool(subagentConfig, subagent.createModelCall))
  }
  return tools
}

/** Everything a turn needs that depends only on `config`/`options`, not on
 * this specific call's messages — shared, unchanged, between a fresh
 * runAgent() call and a resumeAgent() one, which is exactly why it's
 * split out: both build one of these once, then hand it to runLoop below
 * along with whatever messages/starter message is actually theirs. */
interface TurnContext {
  modelCall: ModelCall
  log: (event: LoopEvent) => void
  scope: Scope
  sessionId: string | undefined
  skillGarden: SkillGarden
  toolsByName: Map<string, ToolDefinition>
  systemToolInstances: Set<ToolDefinition>
  toolSchemas: ToolSchema[]
  systemPrompt: string
  budgetTracker: BudgetTracker
  compactor: Compactor
  gate: Gate
  toolLane: ToolLane
  maxTurns: number
  tailMessages: number
  /** The real, unmodified ask_user ToolDefinition this call built (see
   * systemToolInstances' own doc comment on why identity, not name,
   * is what makes a same-named override a deliberate opt-out) — the
   * durable-question branch in the loop below checks
   * `toolsByName.get(block.name!) === askUserTool`, not
   * `block.name === 'system_ask_user'`, for exactly that reason: an
   * agent that overrode the name with its own ToolDefinition must still
   * fall through to gate.evaluate() like any other tool, not get silently
   * swallowed into the durable-question bucket just because the name
   * matches. */
  askUserTool: ToolDefinition
  /** Resolved the same channel-keyed way `approver` (fed into `gate`
   * above) is, with the same real hard default (`new CliQuestionHandler()`,
   * playing `new ConsoleApprover()`'s role) — see
   * RunAgentOptions.questionHandler's own doc comment. Never undefined,
   * unlike `approver` needing none: duck-typed via `isDurableQuestionHandler`
   * in the loop below the same way Gate distinguishes a live from a
   * durable Approver — see that same doc comment for the one real gap
   * versus `approver` (only the durable branch is actually wired to this
   * resolved value; the live branch still ignores it). */
  questionHandler: QuestionHandler
  /** AgentConfig.httpNotifier, already resolved (see http-notifier.ts's
   * own doc comment) — runAgent/resumeAgent read .onRunStart/.onRunFinish
   * off of this same resolution for their own lifecycle-hook fallback,
   * rather than calling resolveHttpNotifier a second time. */
  httpNotifier: ReturnType<typeof resolveHttpNotifier>
}

async function buildTurnContext(config: AgentConfig, modelCall: ModelCall, options: RunAgentOptions): Promise<TurnContext> {
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
  // agents/<name>/subagents/* and agents/<name>/gateway-tools.yml (see
  // gateway-tools.ts) are both merged in on top either way — see
  // loadSubagentAsTools's own doc comment for why neither is gated by
  // whether `tools` was explicit.
  // systemTools go first and are deduped by name (dedupeToolsByName keeps
  // each name's *last* occurrence) — so config.tools/subagents/gateway
  // tools always win over a same-named system default, never the
  // reverse, even though systemTools is merged in unconditionally
  // (unlike the others below, it's not gated on `tools` being omitted).
  // ask_user is built fresh per call, not part of the static systemTools
  // array — its onPending needs options.onQuestionPending, not `log`
  // (options.onEvent's own fallback) — see RunAgentOptions.onQuestionPending's
  // own doc comment for why those two are deliberately not the same thing.
  const askUserTool = createAskUserTool({ agent: config.name, sessionId: options.sessionId }, options.onQuestionPending)

  const tools = dedupeToolsByName([
    ...systemTools,
    askUserTool,
    ...(config.tools ?? (await loadDefaultTools(config))),
    ...(await loadSubagentAsTools(config)),
    ...(await loadGatewayToolsFromDir(join(process.cwd(), 'agents', config.name))),
  ])

  // Omitted entirely (undefined): default to this agent's own
  // agents/<name>/skills — the folder-form convention every agent in
  // this repo already follows (see agent-config.ts's skillsDirs doc
  // comment). An explicit `[]` is a real opt-out of the agent's *own*
  // skills dir, but systemSkillsDir is still always included below —
  // same "not opt-out-able the normal way" as systemTools above.
  // SkillGarden's own missing-directory handling (discoverSkillFiles
  // walks best-effort, no throw) is what makes pointing this at a folder
  // that doesn't exist (a flat-file agent with no skills at all)
  // harmless: an empty index, not an error.
  const skillsDirs = config.skillsDirs ?? [`agents/${config.name}/skills`]
  const skillGarden = new SkillGarden({ dirs: [...skillsDirs, systemSkillsDir], indexBudgetTokens: config.skillIndexBudgetTokens ?? 200 })
  const skillIndex = skillGarden.buildIndex().included

  // Also the tail-preservation window recover() below relies on — kept as
  // one named constant so the two can never drift out of sync.
  const tailMessages = 4
  // Two separate objects, not one — budget.ts's BudgetTracker (read-only
  // check) and compaction.ts's Compactor (the actual recovery) are
  // deliberately distinct capabilities now, constructed with the same
  // budgetTokens/softThreshold so a nudge firing and compaction's own
  // recovery target agree — see budget.ts's own BudgetTrackerOptions doc
  // comment.
  const budgetTracker = new BudgetTracker({ budgetTokens: config.contextBudgetTokens ?? 8000 })
  const compactor = new Compactor({ budgetTokens: config.contextBudgetTokens ?? 8000, softThreshold: budgetTracker.softThreshold, tailMessages })
  const rules = loadRules(config)
  // AgentConfig.httpNotifier only ever stands in for the http channel —
  // see its own doc comment for why cli/http_stream never consult it at
  // all, not even as a fallback.
  const httpNotifier = resolveHttpNotifier(config)
  // httpNotifier.approver, when the http channel has one, wins outright
  // over options.approver — the same "the agent's own explicit choice for
  // this channel beats whatever the adapter would otherwise default to"
  // precedent a channel-keyed override always had here. This ordering
  // matters in practice, not just on paper: adapters/http.ts's own plain
  // /messages route always passes *some* options.approver (its own
  // deployment-wide durable default, or a live tracked one) — checking
  // httpNotifier first is what lets a single agent's own httpNotifier
  // actually take effect there, rather than being silently shadowed by
  // that per-deployment default every time.
  const approver = (options.channel === 'http' ? httpNotifier.approver : undefined) ?? options.approver ?? new ConsoleApprover()
  const gate = new Gate(rules, approver)
  // Exact mirror of approver's own resolution above, same reasoning and
  // same ordering (httpNotifier checked before options.questionHandler,
  // not after — see approver's own comment for why that order matters in
  // practice, not just on paper) — see RunAgentOptions.questionHandler's
  // own doc comment for the one place this still isn't a full mirror of
  // approver (only the durable branch below actually reads this; the live
  // branch keeps resolving independently, via onQuestionPending).
  const questionHandler: QuestionHandler =
    (options.channel === 'http' ? httpNotifier.questionHandler : undefined) ?? options.questionHandler ?? new CliQuestionHandler()
  // No explicit isSafeTool: fall back to each called tool's own `safe`
  // flag (looked up by name) rather than defaulting every tool to unsafe
  // outright — see ToolDefinition.safe's own doc comment for why this is
  // the less powerful of the two (name-only, no per-call nuance).
  const isSafeTool: SafetyClassifier =
    config.isSafeTool ?? ((call) => tools.some((t) => t.name === call.name && t.safe === true))
  const toolLane = new ToolLane({ isSafe: isSafeTool })

  const toolsByName = new Map(tools.map((t) => [t.name, t]))
  // Object identity, not name — an agent that overrides a system tool's
  // name with its own ToolDefinition (dedupeToolsByName's own "config
  // wins" rule above) is a deliberate opt-out, and that override should
  // still go through the agent's own rules like anything else; only the
  // genuine, unmodified system implementation always bypasses the gate.
  // ask_user in particular can't be gated at all without a real deadlock:
  // it's the mechanism a human uses to answer the agent, so requiring a
  // human decision just to *ask* one is circular, not just redundant —
  // and every default_decision this repo's own agents actually use
  // ('ask' or 'deny', see loadRules' own doc comment) would otherwise
  // catch it, since neither system tool ever appears in an agent's own
  // actauth.yml.
  const systemToolInstances = new Set<ToolDefinition>([...systemTools, askUserTool])
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

  return {
    modelCall,
    log,
    scope,
    sessionId: options.sessionId,
    skillGarden,
    toolsByName,
    systemToolInstances,
    toolSchemas,
    systemPrompt,
    budgetTracker,
    compactor,
    gate,
    toolLane,
    maxTurns,
    tailMessages,
    askUserTool,
    questionHandler,
    httpNotifier,
  }
}

/** The turn's actual ReAct loop — shared by runAgent (a fresh turn, its
 * own starterMessage is the user's own message) and resumeAgent (a
 * paused turn's completing tool_result message as starterMessage,
 * picking up right where run-agent.ts's own bucket-then-execute left
 * off — see RunAgentResult.stopReason's own 'pending_approval' doc
 * comment). `messages`/`newMessages` are owned by the caller (built
 * fresh in each case) but mutated here via pushMessage, same as the
 * single function this was split out of always did. */
async function runLoop(ctx: TurnContext, messages: Message[], newMessages: Message[], starterMessage: Message): Promise<RunAgentResult> {
  const { modelCall, log, scope, sessionId, skillGarden, toolsByName, systemToolInstances, toolSchemas, systemPrompt, budgetTracker, compactor, gate, toolLane, maxTurns, tailMessages, askUserTool, questionHandler } = ctx

  function pushMessage(message: Message): void {
    messages.push(message)
    newMessages.push(message)
  }

  const recovery = new Recovery<Message[]>({
    onPromptTooLong: async (currentMessages) => {
      // newMessages (this turn's own content — not durably stored
      // anywhere else yet) must never be handed to the compactor at all.
      // An earlier version of this reconciliation tried to recover
      // newMessages *after* compaction by reusing whatever the
      // compactor's synthetic head contained — that's unsound: its cheap
      // "drain" stage doesn't produce a head at all, it just deletes old
      // messages outright, trusting there's a durable copy elsewhere.
      // That trust is only valid for the *prior* portion; only that
      // portion is safe to compact at all.
      const priorCount = currentMessages.length - newMessages.length
      const priorPortion = currentMessages.slice(0, priorCount)

      const result = await compactor.recover(priorPortion.map(flattenForBudget))
      log({ type: 'prompt:compaction', from: currentMessages.length, to: result.messages.length + newMessages.length })
      if (result.action === 'unchanged') return currentMessages

      // Same tail-preservation reuse as before, just scoped to
      // priorPortion alone now — newMessages is appended back whole,
      // always, regardless of how large it's grown this turn.
      const preservedTailCount = Math.min(tailMessages, priorPortion.length)
      const structuredTail = priorPortion.slice(priorPortion.length - preservedTailCount)
      const newHead = result.messages.slice(0, result.messages.length - preservedTailCount)
      const recovered = [...newHead, ...structuredTail, ...newMessages]

      // Recovery.call() only ever returns {value, recoveries, truncated} —
      // it never hands back whatever `currentMessages` became after a
      // retry, so recovery would otherwise only ever affect the one
      // retried call. Reassigning the outer `messages` binding here (this
      // hook is the only place that has both the recovered array and a
      // reason to persist it) is what makes recovery durable: every
      // subsequent budgetTracker.check() in this loop, and the `history`
      // this function eventually returns, both see the compacted
      // conversation from this point on — not the original, ever-growing
      // one. newMessages itself needs no reconciliation at all — it was
      // never part of what could be compacted away.
      messages = recovered
      return recovered
    },
  })

  pushMessage(starterMessage)

  let turn = 0

  for (;;) {
    turn++
    if (turn > maxTurns) {
      const text = `Stopped after ${maxTurns} turns without a final answer — the agent may be stuck in a loop.`
      pushMessage({ role: 'assistant', content: text })
      log({ type: 'loop:max_turns', maxTurns })
      return { text, history: messages, newMessages, stopReason: 'max_turns' }
    }

    const budget = budgetTracker.check(messages.map(flattenForBudget))
    log({ type: 'budget:check', ...budget })
    if (budget.action === 'nudge' && budget.nudge) pushMessage(budget.nudge)

    // recovery.call()'s own return also includes `recoveries` (which of
    // its three failure modes fired this call) and `truncated` — not
    // used here: prompt:compaction above already reports the one
    // recovery type that's actually wired to a real hook (onPromptTooLong),
    // and there's no second type yet to justify a second, more generic
    // event just to aggregate it (see PromptCompactionEvent's own doc
    // comment for the removed 'recovery:summary').
    const { value: response } = await recovery.call((msgs) => modelCall(msgs, systemPrompt, toolSchemas), messages)

    // The model's full response — text and tool_use blocks alike, with
    // real ids — becomes this turn's assistant message verbatim. Every
    // tool_use block emitted here gets a matching tool_result pushed
    // below before the loop continues; a real model API expects exactly
    // that pairing on the next request, not a prose summary of it.
    pushMessage({ role: 'assistant', content: response.content })

    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use')

    if (toolUseBlocks.length === 0) {
      const text = response.content.find((b) => b.type === 'text')?.text ?? ''
      log({ type: 'loop:done', text })
      return { text, history: messages, newMessages }
    }

    // The model's own text alongside a tool_use request (its "I'll do X"
    // preamble) is already durable via pushMessage above, but the only
    // *live* SSE event that ever carries assistant text is 'done', which
    // fires once at the very end of the whole turn — a live caller
    // watching this turn in progress (adapters/http.ts's streaming route,
    // the playground) would otherwise jump straight from "thinking..." to
    // an approval/question card with zero explanation, and only ever see
    // this sentence later, after a refresh replays stored history —
    // confirmed live.
    const preambleText = response.content.find((b) => b.type === 'text')?.text
    if (preambleText) log({ type: 'assistant:text', text: preambleText })

    const resultBlocks: ModelContentBlock[] = []
    const approvedCalls: LaneCall[] = []
    const deniedTools: string[] = []
    // A DurableApprover/DurableQuestionHandler deferred this call to a
    // durable record instead of resolving it inline (see
    // HUMAN_IN_THE_LOOP.md) — collected separately from
    // approvedCalls/deniedTools since it's neither run now nor denied now.
    // No tool_result is pushed for these yet; the batch's post-loop
    // handling below decides what happens to them. One shared array for
    // both kinds (not two parallel ones) — see PendingItem's own doc
    // comment for why a mixed batch has to share one checkpoint.
    const pending: PendingItem[] = []
    // Keyed by tool_use id — approvedCalls (a toollane LaneCall) has no
    // room for extra fields of its own, and toolLane.run's own results
    // only carry `id`/`name`/status, not anything about the *decision*
    // that let a call through in the first place (or what it was even
    // called with). This is what lets the reason still get attached to
    // the right tool_result once execution finishes below, and lets the
    // 'tool:result' live event (see below) report the same args a
    // resumed/refreshed view of this same call would show, without
    // changing toollane's own types.
    const approvedMetaById = new Map<string, { reason: string; args: Record<string, unknown> }>()

    for (const block of toolUseBlocks) {
      // Skill invocation injects instructions into context; it isn't a
      // real tool call and doesn't need ActAuth gating or ToolLane
      // scheduling — but it's still a tool_use block the model emitted,
      // so it still needs a tool_result to answer it, same as any other.
      if (block.name === 'Skill' && skillGarden) {
        const body = skillGarden.invoke(block.input!.skill as string, block.input?.args as string | undefined)
        log({ type: 'skill:loaded', skill: block.input!.skill as string })
        resultBlocks.push({ type: 'tool_result', tool_use_id: block.id!, content: body })
        continue
      }

      // Checked before the systemToolInstances bypass just below (which
      // would otherwise auto-run ask_user's own execute() straight away,
      // in-process) — when the resolved QuestionHandler for this channel
      // is durable (isDurableQuestionHandler — see its own doc comment,
      // mirroring Gate's isDurableApprover), a system_ask_user call gets
      // the exact same bucket-then-execute treatment a durably-gated tool
      // call gets from gate.evaluate() below, never actually invoking the
      // tool's own execute()/onPending live path at all. See PendingItem's
      // own doc comment for why this shares `pending` with approvals
      // rather than its own separate array. Identity, not name
      // (`toolsByName.get(...) === askUserTool`, not `block.name ===
      // 'system_ask_user'`) — same reasoning the systemToolInstances check
      // just below already uses: an agent that deliberately overrode the
      // name with its own ToolDefinition must still fall through to
      // gate.evaluate() like any other tool, not get silently swallowed
      // into the durable-question bucket just because the name happens to
      // match. The *live* case (questionHandler resolved to something,
      // just not durable — including the hard CliQuestionHandler default)
      // deliberately falls through to the systemToolInstances bypass below
      // unchanged — see RunAgentOptions.questionHandler's own doc comment
      // for why that half isn't wired to this resolved value yet.
      if (toolsByName.get(block.name!) === askUserTool && isDurableQuestionHandler(questionHandler)) {
        const question = String(block.input?.question ?? '')
        const questionOptions = Array.isArray(block.input?.options) ? block.input.options.map(String) : undefined
        const { pendingId } = questionHandler.notifyPendingQuestion(question, questionOptions, scope.agent, sessionId)
        // No 'tool:started'/'tool:result' here — same reasoning the
        // durably-gated 'pending' branch below has: nothing to report
        // until a resolve call answers it, later, possibly in a
        // different process.
        pending.push({ kind: 'question', toolUseId: block.id!, tool: block.name!, args: { question, options: questionOptions }, pendingId, reason: question })
        continue
      }

      // See systemToolInstances' own doc comment above — bypasses
      // gate.evaluate entirely, not just auto-approves through it, since
      // ask_user itself can be the approver's own only way to ask a human
      // anything in the first place.
      if (systemToolInstances.has(toolsByName.get(block.name!)!)) {
        log({ type: 'actauth:decision', tool: block.name!, decision: 'allow', reason: 'system tool — always allowed' })
        approvedMetaById.set(block.id!, { reason: 'system tool — always allowed', args: block.input ?? {} })
        // Fired the moment the decision is in, not once execution finishes
        // (see the 'tool:started' vs 'tool:result' split below) — a system
        // tool can still be slow, and this is the one path that had no
        // interactive card of its own to show something sooner.
        log({ type: 'tool:started', id: block.id!, tool: block.name!, args: block.input ?? {}, detailText: 'system tool — always allowed' })
        approvedCalls.push({
          id: block.id!,
          name: block.name!,
          execute: () => toolsByName.get(block.name!)!.execute(block.input ?? {}),
        })
        continue
      }

      const decision = await gate.evaluate(block.name!, block.input ?? {}, scope)
      log({ type: 'actauth:decision', tool: block.name!, decision: decision.decision, reason: decision.reason })
      if (decision.decision === 'allow') {
        approvedMetaById.set(block.id!, { reason: decision.reason, args: block.input ?? {} })
        // Fired the instant the decision is in, not once execution
        // finishes below — closes what would otherwise be a multi-second
        // silent gap while a slow call runs. Always emitted, whether or
        // not a human was actually asked live: run-agent.ts itself has no
        // notion of "already shown elsewhere" — that's a rendering
        // decision, and belongs to whichever channel adapter is actually
        // presenting this turn (see web/playground.ts's own
        // wasAskedInteractively, which decides whether this duplicates an
        // approval card already on screen), not to the engine loop.
        log({ type: 'tool:started', id: block.id!, tool: block.name!, args: block.input ?? {}, detailText: decision.reason })
        approvedCalls.push({
          id: block.id!,
          name: block.name!,
          execute: () => toolsByName.get(block.name!)!.execute(block.input ?? {}),
        })
      } else if (decision.decision === 'pending') {
        // No 'tool:started'/'tool:result' here — unlike a live 'ask',
        // this call isn't running and isn't decided yet; it genuinely
        // has nothing to report until a resolve call answers it, later,
        // possibly in a different process. See 'loop:pending_approval'
        // below (once every block in the batch is known) for the live
        // signal this batch needed a durable decision.
        pending.push({ kind: 'approval', toolUseId: block.id!, tool: block.name!, args: block.input ?? {}, pendingId: decision.pendingId!, reason: decision.reason })
      } else {
        // Every requested tool gets exactly one tool_result back — a
        // denied call is not simply dropped, or the model has no way to
        // tell "denied" apart from "hasn't run yet" and may just
        // re-request it forever. Recorded even though this turn is about
        // to stop (see deniedTools below) — a later message continuing
        // this same session still needs a complete, consistent history,
        // not a dangling tool_use with no answer.
        deniedTools.push(block.name!)
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id!,
          content: `denied: ${decision.reason}`,
          is_error: true,
        })
        // Always emitted — see the 'allow' branch's own comment above on
        // why this engine loop no longer decides whether a live UI
        // already has some other representation of this decision on
        // screen (an approval card that went through an interactive
        // ask). That's a rendering call, made by whichever channel
        // adapter is presenting this turn.
        log({ type: 'tool:result', id: block.id!, tool: block.name!, args: block.input ?? {}, detailText: decision.reason, statusText: 'Denied.' })
      }
    }

    if (deniedTools.length > 0) {
      // A denial cancels the *whole* batch, not just the call(s) that
      // were themselves denied — an approved sibling call from the same
      // turn never runs at all, same reasoning Claude Code itself stops
      // an entire pending batch rather than quietly carrying out the
      // parts you didn't object to. Every approved call still gets
      // exactly one tool_result back regardless (the model emitted a
      // tool_use for it, so it needs an answer) — "skipped", not
      // "denied": it was never evaluated against its own rule, a
      // *different* call in the same turn was what stopped it.
      for (const call of approvedCalls) {
        log({ type: 'loop:skipped', name: call.name, deniedTools })
        const skipReason = `a sibling tool call in this turn (${deniedTools.join(', ')}) was denied`
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: `skipped: ${skipReason}`,
          is_error: true,
        })
        // A skipped call never went through gate.evaluate at all — no
        // approver, no interactive card, nothing live ever showed it was
        // even requested. Same reasoning as the straight-denied case
        // just above.
        log({ type: 'tool:result', id: call.id, tool: call.name, args: approvedMetaById.get(call.id)?.args, detailText: skipReason, statusText: 'Skipped.' })
      }
      // A pending call/question closes exactly the same way an
      // approved-but-never-run one does above — see HUMAN_IN_THE_LOOP.md's
      // own "denial closes the checkpoint immediately" semantics: since
      // this never actually becomes a checkpoint (the batch is resolved
      // synchronously right here), there's nothing durable left dangling —
      // only the DurableApprover's/DurableQuestionHandler's own pendingId
      // record, orphaned but harmless: a resolve call against it later
      // finds no checkpoint at all (never created) and no-ops, same as any
      // other unknown pendingId.
      for (const pendingItem of pending) {
        log({ type: 'loop:skipped', name: pendingItem.tool, deniedTools })
        const skipReason = `a sibling tool call in this turn (${deniedTools.join(', ')}) was denied`
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: pendingItem.toolUseId,
          content: `skipped: ${skipReason}`,
          is_error: true,
        })
        log({ type: 'tool:result', id: pendingItem.toolUseId, tool: pendingItem.tool, args: pendingItem.args, detailText: skipReason, statusText: 'Skipped.' })
      }
    } else {
      // result.id is the same id LaneCall.id was given above — the exact
      // per-call identity that makes it possible to link a result back
      // to the specific tool_use block that requested it, even when
      // several calls ran in the same parallel lane. The old
      // flattened-text design could only link by tool *name*, ambiguous
      // the moment two calls to the same tool ran in one turn.
      for await (const result of toolLane.run(approvedCalls)) {
        const summary = result.status === 'fulfilled' ? JSON.stringify(result.value) : `ERROR: ${result.error}`
        const meta = approvedMetaById.get(result.id)
        log({ type: 'toollane:result', name: result.name, summary })
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: result.id,
          content: summary,
          is_error: result.status === 'rejected',
          reason: meta?.reason,
        })
        // Always emitted — this is what turns the earlier 'tool:started'
        // event's "Running…" placeholder into the real outcome (matched
        // by the same id), for every call regardless of how it got
        // approved. See the 'allow' branch's own comment above: deciding
        // whether this duplicates an approval card already on screen is
        // a rendering call for the channel adapter presenting this turn,
        // not something this engine loop tracks.
        log({
          type: 'tool:result',
          id: result.id,
          tool: result.name,
          args: meta?.args,
          detailText: meta?.reason,
          statusText: result.status === 'fulfilled' ? 'Approved.' : 'Error.',
        })
      }

      // At least one call this batch is durably pending — resultBlocks is
      // incomplete (missing an entry for every pending item) and must
      // NOT be pushed as the completing tool_result message: a real model
      // API expects exactly one, complete, tool_result per tool_use
      // message, not a partial one now and a follow-up later. Stop here
      // instead — newMessages already ends at the dangling assistant
      // tool_use message pushed above, the same crash-recovery shape
      // session-store.ts's own hasUnresolvedToolCall already detects (see
      // RunAgentResult.stopReason's own doc comment). Turning this into a
      // durable TurnCheckpoint is the caller's job — this loop does no I/O.
      if (pending.length > 0) {
        // A mixed batch (both kinds present) reports 'pending_approval' —
        // see RunAgentResult.stopReason's own doc comment for why that's
        // the right call, not an arbitrary tie-break.
        const stopReason = pending.some((p) => p.kind === 'approval') ? 'pending_approval' : 'pending_question'
        log({ type: stopReason === 'pending_question' ? 'loop:pending_question' : 'loop:pending_approval', pendingIds: pending.map((p) => p.pendingId) })
        return {
          text: `Stopped — awaiting durable ${stopReason === 'pending_question' ? 'answer' : 'approval'} for: ${pending.map((p) => p.tool).join(', ')}.`,
          history: messages,
          newMessages,
          stopReason,
          pending: { resultsSoFar: resultBlocks, outstanding: pending },
        }
      }
    }

    pushMessage({ role: 'user', content: resultBlocks })

    // Stop here, don't loop back for another model call — same reasoning
    // Claude Code itself stops and waits for you rather than working
    // around a tool call you just rejected, instead of silently handing
    // "denied: ..." to the model and letting it decide on its own what to
    // try next (retry the same tool, reach for a different one, or just
    // talk its way past the refusal).
    if (deniedTools.length > 0) {
      const text = `Stopped — you denied: ${deniedTools.join(', ')}. Send another message to continue.`
      pushMessage({ role: 'assistant', content: text })
      log({ type: 'loop:denied', deniedTools })
      return { text, history: messages, newMessages, stopReason: 'denied' }
    }
  }
}

/** Invokes an AgentConfig.onRunStart/onRunFinish callback per its own
 * never-awaited contract (see AgentConfig's own doc comments on each) —
 * whether `call()` throws synchronously or returns a rejected Promise,
 * the failure is logged, never surfaced to (or awaited by) the loop that
 * triggered it. One shared implementation for both hooks and both of
 * runAgent/resumeAgent's own call sites, rather than four copies of the
 * same try/catch-and-maybe-.catch dance. */
function fireLifecycleHook(label: 'onRunStart' | 'onRunFinish', agentName: string, call: () => void | Promise<void>): void {
  try {
    const result = call()
    if (result && typeof result.catch === 'function') {
      result.catch((err) => console.error(`[loopengine] ${label} threw for agent '${agentName}':`, err))
    }
  } catch (err) {
    console.error(`[loopengine] ${label} threw for agent '${agentName}':`, err)
  }
}

/** `cli` and `http_stream` both already deliver the start/finish signal
 * to whoever's actually waiting, synchronously, as part of that channel's
 * own normal response — a terminal that just ran the command, or an SSE
 * connection that already carries its own `session`/`done` events on the
 * exact same stream. Firing onRunStart/onRunFinish there too would just
 * be a second, redundant copy of information the caller already has, so
 * neither hook is invoked for those two channels — not left to each
 * implementation to notice and filter out itself the way `channel` in
 * the fired context still lets you filter *within* the channels this
 * does fire for (`http`, or no channel at all — a bespoke script has no
 * such guaranteed synchronous delivery to assume either way, so it still
 * fires there). */
function shouldFireLifecycleHooks(channel: ApproverChannel | undefined): boolean {
  return channel !== 'cli' && channel !== 'http_stream'
}

export async function runAgent(
  config: AgentConfig,
  modelCall: ModelCall,
  userMessage: string,
  history: Message[] = [],
  options: RunAgentOptions = {},
): Promise<RunAgentResult> {
  const ctx = await buildTurnContext(config, modelCall, options)
  // config.onRunStart, if set, still wins outright over notifier's own
  // derived hook — see NotifierConfig's own doc comment on precedence.
  const onRunStart = config.onRunStart ?? (options.channel === 'http' ? ctx.httpNotifier.onRunStart : undefined)
  if (onRunStart && shouldFireLifecycleHooks(options.channel)) {
    fireLifecycleHook('onRunStart', config.name, () =>
      onRunStart({ agent: config.name, tenant: ctx.scope.tenant, sessionId: options.sessionId, channel: options.channel, trigger: 'message' }),
    )
  }
  const result = await runLoop(ctx, [...history], [], { role: 'user', content: userMessage })
  const onRunFinish = config.onRunFinish ?? (options.channel === 'http' ? ctx.httpNotifier.onRunFinish : undefined)
  if (onRunFinish && !result.pending && shouldFireLifecycleHooks(options.channel)) {
    fireLifecycleHook('onRunFinish', config.name, () =>
      onRunFinish({ agent: config.name, tenant: ctx.scope.tenant, sessionId: options.sessionId, channel: options.channel, text: result.text, stopReason: result.stopReason as 'max_turns' | 'denied' | undefined }),
    )
  }
  return result
}

/** Continues a turn durably paused on RunAgentResult.stopReason ===
 * 'pending_approval' — see HUMAN_IN_THE_LOOP.md for the full design.
 * `history` is durable session history including the dangling assistant
 * tool_use message the pause left behind (exactly what a caller's
 * SessionStore.getHistory/withSession already returns — this needs no
 * special resumed-session handling, since that message is real, already
 * on disk). `resolution` is the *complete* set of tool_result blocks
 * answering that message — every entry from a resolved TurnCheckpoint's
 * own resultsSoFar, once its outstanding is empty; assembling that is the
 * caller's job (core/durable-approvals.ts's own CheckpointStore only
 * stores it, it doesn't execute tools or know when a batch is complete —
 * see that module's own doc comment), not something this function
 * derives on its own.
 *
 * Pushes `resolution` as the completing message and picks the loop back
 * up from there — a fresh model call, now with the full picture, exactly
 * like a synchronous 'ask' would have continued if it hadn't needed to
 * pause at all. Can itself return with stopReason 'pending_approval'
 * again (the model's next round of tool calls hits another durably-gated
 * one), 'denied', 'max_turns', or a genuine finish — runLoop handles all
 * of those uniformly regardless of how this turn started. */
export async function resumeAgent(
  config: AgentConfig,
  modelCall: ModelCall,
  history: Message[],
  resolution: ModelContentBlock[],
  options: RunAgentOptions = {},
): Promise<RunAgentResult> {
  const ctx = await buildTurnContext(config, modelCall, options)
  const onRunStart = config.onRunStart ?? (options.channel === 'http' ? ctx.httpNotifier.onRunStart : undefined)
  if (onRunStart && shouldFireLifecycleHooks(options.channel)) {
    fireLifecycleHook('onRunStart', config.name, () =>
      onRunStart({ agent: config.name, tenant: ctx.scope.tenant, sessionId: options.sessionId, channel: options.channel, trigger: 'resolution' }),
    )
  }
  // sessions.withSession's own load (adapters/http.ts's respondAfterResolution)
  // runs through the exact same hasUnresolvedToolCall check real crash
  // recovery uses — a durable pause deliberately leaves the identical
  // dangling-tool_use shape (see HUMAN_IN_THE_LOOP.md's own "same
  // crash-recovery shape... entered on purpose"), so session-store.ts has
  // no way to tell the two apart and injects its own synthetic
  // CRASH_RECOVERY_CONTINUATION message regardless. Only resumeAgent
  // itself knows, by the fact that it's being called at all with a real
  // resolution in hand, that this wasn't a crash — so it's the only place
  // that can safely strip that message back out before it ends up wedged
  // between the assistant's tool_calls message and the tool_result
  // answering it, which every OpenAI-wire-compatible provider rejects
  // outright (an assistant message with tool_calls must be immediately
  // followed by one tool message per call, nothing in between).
  const lastMessage = history[history.length - 1]
  const effectiveHistory = lastMessage?.role === 'user' && lastMessage.content === CRASH_RECOVERY_CONTINUATION ? history.slice(0, -1) : history
  const result = await runLoop(ctx, [...effectiveHistory], [], { role: 'user', content: resolution })
  const onRunFinish = config.onRunFinish ?? (options.channel === 'http' ? ctx.httpNotifier.onRunFinish : undefined)
  if (onRunFinish && !result.pending && shouldFireLifecycleHooks(options.channel)) {
    fireLifecycleHook('onRunFinish', config.name, () =>
      onRunFinish({ agent: config.name, tenant: ctx.scope.tenant, sessionId: options.sessionId, channel: options.channel, text: result.text, stopReason: result.stopReason as 'max_turns' | 'denied' | undefined }),
    )
  }
  return result
}
