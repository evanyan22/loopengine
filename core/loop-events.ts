// The canonical, typed shape of everything that can happen over the
// lifecycle of one runAgent() turn — the single schema run-agent.ts emits
// and every channel adapter (cli.ts, http.ts's stream + plain routes,
// playground.ts) consumes, instead of each adapter maintaining its own ad
// hoc understanding of event names and payload shapes (previously
// onEvent(event: string, detail: unknown) — a string name with an
// unrelated, unchecked payload per adapter).
//
// A variant's `type` field doubles as the wire event name:
// adapters/http.ts's SSE stream writes `event: <type>` verbatim (see
// writeSseEvent), and adapters/cli.ts's --json mode writes one
// `JSON.stringify(event)` line per event, `type` included. Renaming a
// variant here is a wire-format change for both — check playground.ts's
// handleFrame (the only consumer that branches on specific types, rather
// than just displaying whatever arrives) before doing so.
//
// Two families of variant:
//  - Emitted directly by runAgent()'s own loop (budget:check through
//    loop:done below) — one per meaningful step of the ReAct loop itself.
//  - Synthesized by adapters/http.ts around a turn (session, approval:
//    pending, question:pending, done, error) — not something runAgent()
//    itself knows about (session ids, HTTP-level errors), but still part
//    of the same lifecycle a caller observes, so they belong in the one
//    union every consumer matches against rather than a second, parallel
//    type living only in http.ts.
import type { CheckResult } from './budget.js'
import type { Decision, PendingApproval } from 'actauth'
import type { PendingQuestion } from './system-tools/index.js'

/** BudgetTracker's own read-only budget check, run once per loop turn
 * before the model call — reported unchanged (spread, not renamed) so
 * this never drifts from whatever budget.ts's own CheckResult actually
 * contains. */
export type BudgetCheckEvent = { type: 'budget:check' } & CheckResult

/** compaction.ts's own recovery kicked in because the prompt was rejected as
 * too large — `from`/`to` are message-array lengths (this turn's own
 * newMessages included), not token counts; see run-agent.ts's own
 * recovery.call onPromptTooLong hook. Named after *what triggered it and
 * what happened* (the prompt was too long, so it got compacted), not
 * after which module did the work — "compaction:recover" still didn't
 * say this only ever fires for the prompt-too-long case specifically,
 * same problem contextclip:check's own rename from a package name was
 * fixing in the first place.
 *
 * No sibling event for recovery.ts's other two failure modes
 * (media-too-large, truncated output) — neither has an onMediaTooLarge/
 * onTruncated hook actually wired up in run-agent.ts today, so neither
 * can currently fire at all. A prior 'recovery:summary' aggregate event
 * covering all three was removed for being ~100% redundant with this one
 * while that's true; it can come back once a second real recovery type
 * exists to aggregate. */
export interface PromptCompactionEvent {
  type: 'prompt:compaction'
  from: number
  to: number
}

/** The model's own "I'll do X" preamble alongside a tool_use request —
 * the only *live* signal of assistant text mid-turn (the final answer
 * only ever arrives via 'loop:done'/'done', once, at the very end). */
export interface AssistantTextEvent {
  type: 'assistant:text'
  text: string
}

/** One ActAuth Gate.evaluate() outcome per requested tool call — 'allow'
 * here can still mean a human was asked interactively and said yes (see
 * run-agent.ts's own wasAskedInteractively); this event fires regardless,
 * the interactive case just also gets its own approval:pending. */
export interface ActauthDecisionEvent {
  type: 'actauth:decision'
  tool: string
  decision: Decision
  reason: string
}

/** A tool call's decision is in and it's about to run (or, for a system
 * tool, already bypassed the gate entirely) — fired the instant that's
 * known, not once execution finishes, so a live caller can show
 * "Running…" immediately instead of a silent gap. Matched to its later
 * 'tool:result' by `id` (the model's own tool_use id). */
export interface ToolStartedEvent {
  type: 'tool:started'
  id: string
  tool: string
  args: Record<string, unknown>
  detailText: string
}

/** A tool call's resolution — auto-allowed, interactively approved,
 * denied, or skipped alike. `args`/`detailText` are omitted for some
 * skipped/denied paths that never had them resolved (see run-agent.ts's
 * own call sites). */
export interface ToolResultEvent {
  type: 'tool:result'
  id: string
  tool: string
  args?: Record<string, unknown>
  detailText?: string
  statusText: string
}

/** ToolLane's own raw fulfil/reject outcome, logged alongside (not
 * instead of) the richer 'tool:result' above — kept as its own event
 * since it's toollane's own vocabulary (`summary`, not `statusText`), not
 * reshaped to match. */
export interface ToolLaneResultEvent {
  type: 'toollane:result'
  name: string
  summary: string
}

/** A `Skill` tool_use block was resolved to a real skill body via
 * SkillGarden's own lazy "index-now-load-later" design — not gated by
 * ActAuth (see run-agent.ts's own comment on why Skill invocation isn't
 * a real tool call). Named after what happened (the skill's full body
 * got loaded), not after which library method was called — same
 * reasoning budget:check's own rename from contextclip:check used. */
export interface SkillLoadEvent {
  type: 'skill:loaded'
  skill: string
}

/** An approved call never ran because a sibling call in the same turn's
 * batch was denied — the whole batch cancels together (see
 * RunAgentResult.stopReason's own doc comment). */
export interface LoopSkippedEvent {
  type: 'loop:skipped'
  name: string
  deniedTools: string[]
}

/** Hit config.maxTurns without the model producing a final answer. */
export interface LoopMaxTurnsEvent {
  type: 'loop:max_turns'
  maxTurns: number
}

/** A human denied at least one requested tool call this turn — the whole
 * turn stops right there (see RunAgentResult.stopReason). */
export interface LoopDeniedEvent {
  type: 'loop:denied'
  deniedTools: string[]
}

/** The loop's own final answer — the model produced text with no more
 * tool_use blocks. Distinct from the adapter-level 'done' below: this
 * only ever means a genuine finish, never a synthetic max_turns/denied
 * notice (see adapters/http.ts's own 'done', which covers all three). */
export interface LoopDoneEvent {
  type: 'loop:done'
  text: string
}

/** Every event runAgent() itself can emit via RunAgentOptions.onEvent —
 * not the adapter-synthesized ones below, which no caller of runAgent()
 * itself ever produces. */
export type RunAgentLoopEvent =
  | BudgetCheckEvent
  | PromptCompactionEvent
  | AssistantTextEvent
  | ActauthDecisionEvent
  | ToolStartedEvent
  | ToolResultEvent
  | ToolLaneResultEvent
  | SkillLoadEvent
  | LoopSkippedEvent
  | LoopMaxTurnsEvent
  | LoopDeniedEvent
  | LoopDoneEvent

/** adapters/http.ts echoing back which session id this turn used — first
 * event of every streamed turn, so a caller that omitted sessionId can
 * capture what got generated. Not something runAgent() itself knows
 * (session ids are resolved per-request by the adapter, before runAgent
 * is even called). */
export interface SessionEvent {
  type: 'session'
  sessionId: string
}

/** A tool call needs a human 'ask' decision, live — spreads actauth's own
 * PendingApproval verbatim (id/tool/args/scope/reason/requestedAt)
 * alongside `type`, so this never drifts from whatever that package
 * actually returns. */
export type ApprovalPendingEvent = { type: 'approval:pending' } & PendingApproval

/** The system ask_user tool raised a genuinely ambiguous question — same
 * spread-verbatim reasoning as ApprovalPendingEvent above, against
 * system-tools/ask_user.ts's own PendingQuestion. */
export type QuestionPendingEvent = { type: 'question:pending' } & PendingQuestion

/** The turn is over — covers a genuine finish and both synthetic
 * stopReasons (max_turns/denied) alike, the one event every caller can
 * treat as "nothing more is coming" regardless of which of the three it
 * was (see RunAgentResult.stopReason's own doc comment). */
export interface DoneEvent {
  type: 'done'
  text: string
  stopReason?: 'max_turns' | 'denied'
}

/** Something failed after the response was already committed (SSE
 * headers sent, or a background turn already running) — surfaced in-band
 * rather than as an HTTP status code, since it's too late for one. */
export interface ErrorEvent {
  type: 'error'
  error: string
}

/** Synthesized by adapters/http.ts around a turn — session ids and
 * HTTP-level errors aren't things runAgent() itself produces, but they're
 * still part of the same lifecycle a caller observes end to end. */
export type AdapterLoopEvent = SessionEvent | ApprovalPendingEvent | QuestionPendingEvent | DoneEvent | ErrorEvent

/** The full wire vocabulary — what run-agent.ts emits via onEvent, plus
 * what adapters/http.ts (and, in --json mode, adapters/cli.ts) layers
 * around it. This is "the standard output" every channel adapter is a
 * projection of: adapters/http.ts's SSE stream writes one of these per
 * frame; its plain /messages route collects the whole array into an
 * `events` response field; adapters/cli.ts's --json mode writes one per
 * NDJSON line; web/playground.ts is just a UI rendering whichever of
 * those two HTTP routes it's talking to. */
export type LoopEvent = RunAgentLoopEvent | AdapterLoopEvent

export type LoopEventType = LoopEvent['type']
