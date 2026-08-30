// The declarative surface a user fills in to define a new agent. Nothing
// here runs anything — run-agent.ts is the one place that interprets it.
import type { Rule, Decision, Scope } from 'actauth'
import type { Redis } from 'ioredis'
import type { SafetyClassifier } from 'toollane'

/** Which channel a runAgent() call is on — the value RunAgentOptions.channel
 * carries, checked against directly by AgentConfig.httpNotifier's own
 * resolution (see its own doc comment for why it only ever matches
 * `'http'`). `cli`/`http_stream` always get the library's own live
 * defaults (`ConsoleApprover`, `CliQuestionHandler`, or whatever live
 * approver/questionHandler the adapter itself passes as
 * `RunAgentOptions.approver`/`questionHandler`) — there's no
 * AgentConfig-level way to override either for those two channels
 * specifically; only `http` has one, via `httpNotifier`. */
export type ApproverChannel = 'cli' | 'http' | 'http_stream'

/** A pending system_ask_user question — defined here, not in
 * core/system-tools/ask_user.ts, purely so LiveQuestionHandler/
 * DurableQuestionHandler below can reference it without a circular import
 * (ask_user.ts already imports from this file for
 * ToolDefinition/DurableQuestionHandler); ask_user.ts re-exports this same
 * type for its own module's callers. */
export interface PendingQuestion {
  id: string
  question: string
  /** Suggested answers, if the model gave any — never the only allowed
   * answer, a human can still respond with free text either way. */
  options?: string[]
  /** Which agent raised this — always known (config.name), so listing can
   * always at least be scoped per-agent even without a session id. */
  agent: string
  /** Which conversation raised this, if the caller has one (see
   * RunAgentOptions.sessionId's own doc comment for when it doesn't). */
  sessionId?: string
  requestedAt: string
}

/** The question-side sibling of actauth's own `DurableApprover` — fires a
 * notification and returns a `pendingId` immediately, never awaited for
 * the actual answer (see HUMAN_IN_THE_LOOP.md's "Durable questions"
 * section). Lives here, in loopengine, rather than in actauth: unlike a
 * tool-call approval, `system_ask_user` (core/system-tools/ask_user.ts)
 * is loopengine's own system tool — it never goes through actauth's
 * `Gate` at all (see that file's own doc comment on why it can't be
 * gated), so actauth has no reason to know it exists. Positional args,
 * mirroring `DurableApprover.requestDurableApproval(tool, args, scope,
 * reason)`'s own shape. The built-in implementations are
 * `core/http-notify-triggers/webhook.ts`'s `WebhookNotifier` and its
 * slack.ts/lark.ts/email.ts siblings. */
export interface DurableQuestionHandler {
  notifyPendingQuestion(question: string, options: string[] | undefined, agent: string, sessionId: string | undefined): { pendingId: string }
}

/** The question-side sibling of actauth's own `LiveApprover` — awaited
 * directly for the human's actual answer, same call shape
 * `DurableQuestionHandler.notifyPendingQuestion` has except this one
 * blocks and returns the real answer instead of a `pendingId`. `onPending`
 * mirrors `WebchatApprover`'s own notification hook, but stays a per-call
 * argument here rather than a constructor option — see
 * `WebchatQuestionHandler`'s own doc comment (core/system-tools/ask_user.ts)
 * for why a question, unlike an approval, only ever needs one shared
 * registry, not a fresh instance per turn. The two built-in
 * implementations are `WebchatQuestionHandler` and `CliQuestionHandler`
 * (both core/system-tools/ask_user.ts). */
export interface LiveQuestionHandler {
  requestQuestion(question: string, options: string[] | undefined, agent: string, sessionId: string | undefined, onPending?: (question: PendingQuestion) => void): Promise<string>
}

/** `RunAgentOptions.questionHandler`'s own type — mirrors actauth's own
 * `Approver = LiveApprover | DurableApprover` union exactly, resolved the
 * same `http`-only-fallback way `httpNotifier` resolves an approver, and
 * duck-typed (`core/system-tools/ask_user.ts`'s `isDurableQuestionHandler`)
 * the identical way `Gate` distinguishes a live from a durable `Approver`. */
export type QuestionHandler = LiveQuestionHandler | DurableQuestionHandler

/** Which of the four durable/lifecycle concerns an HttpNotifierConfig
 * should cover — 'approval'/'question' make that concern durable on the
 * `http` channel (a signed webhook standing in for a live human),
 * 'agentStart'/'agentFinish' wire `onRunStart`/`onRunFinish` to the same
 * webhook instead of requiring them written out by hand. Listing only
 * some of the four is deliberate, not partial config — an agent that
 * wants durable approvals but a live (blocking) question flow lists just
 * `['approval']`. */
export type HttpNotifierEvent = 'approval' | 'question' | 'agentStart' | 'agentFinish'

/** `channel: 'database'`/`'redis'`'s own narrower `events` — both are
 * approval-only backends (a row/queue entry, not a notification to
 * anyone), with no `DurableQuestionHandler` or lifecycle-sender
 * equivalent at all — see `core/http-notify-triggers/database.ts`'s own
 * doc comment for why. Listing `'question'`/`'agentStart'`/`'agentFinish'`
 * for either channel wouldn't be a type error under the plain
 * `HttpNotifierEvent[]` these two used before, just silently inert; this
 * narrower type catches that at the config-authoring boundary instead. */
export type ApprovalOnlyHttpNotifierEvent = 'approval'

/** A `sendEmail` function, passed in rather than a hardcoded provider —
 * see `core/http-notify-triggers/email.ts`'s own doc comment for why
 * (an SMTP client/provider SDK is a dependency this package deliberately
 * doesn't carry). */
export type SendEmail = (to: string, subject: string, html: string) => Promise<void>

/** One row `channel: 'database'` (`core/http-notify-triggers/database.ts`)
 * inserts per pending approval — implement `insert()` against whatever
 * real database/ORM you already have (a single INSERT, a Prisma/Drizzle
 * create call, anything); `DatabaseApprover` needs nothing else
 * from it. */
export interface PendingApprovalRow {
  pendingId: string
  tool: string
  args: Record<string, unknown>
  scope: Scope
  reason: string
  requestedAt: string
}

export interface PendingApprovalsRepository {
  insert(row: PendingApprovalRow): Promise<void>
}

/** The `http` channel's one notification config — replaces what used to
 * be up to three separate fields (a channel-keyed `approvers.http`
 * override, `onRunStart`, `onRunFinish`) with the single shape almost
 * every real deployment actually wants: one webhook, receiving whichever
 * of approvals/questions/lifecycle events it asks for. Resolved by
 * `core/http-notifier.ts`'s `resolveHttpNotifier` — see that module for
 * the actual `WebhookNotifier`/signed-POST construction.
 *
 * Only ever consulted for the `http` channel, and only as a fallback
 * *there*: `RunAgentOptions.approver`/`questionHandler` (an adapter's own
 * per-call default — `adapters/http.ts`'s plain route always passes one)
 * still loses to this when it's set, the same "the agent's own explicit
 * choice for this channel wins outright over whatever the adapter would
 * otherwise default to" precedent a channel-keyed override always had
 * here — but an explicit `AgentConfig.onRunStart`/`onRunFinish`, if also
 * set, still wins outright over this field's own derived hooks (no
 * per-call value competes with those the way `options.approver` does).
 *
 * `cli`/`http_stream` never consult this at all, not even as a fallback
 * — they keep the library's own live defaults (`ConsoleApprover`,
 * `CliQuestionHandler`, or whatever live approver the adapter passes as
 * `RunAgentOptions.approver`) automatically, with nothing to configure.
 * This isn't a limitation to work around: a durable webhook stands in
 * for a human who isn't there to answer live, which is exactly what
 * `http` (no open connection to block on) needs and `cli`/`http_stream`
 * (a real human already attached, live, right now) don't. There's also
 * no more AgentConfig-level way to give `cli`/`http_stream` their own
 * custom *live* approver, the way a former `approvers.cli`/
 * `approvers.http_stream` entry could — see `RunAgentOptions.approver`'s
 * own doc comment if a specific call genuinely needs one; a whole demo
 * agent auto-approving on every channel (this repo used to have two)
 * turned out to be exactly the "config re-deriving the same webhook
 * settings a real approver already has" duplication this field exists
 * to remove, not a use case worth keeping a separate field alive for.
 *
 * Six channels ship today, `resolveHttpNotifier` (`core/http-notifier.ts`)
 * switches on which — each one's own sending-side class lives under
 * `core/http-notify-triggers/`:
 *   - `'webhook'` — a signed HMAC-SHA256 POST, via
 *     `http-notify-triggers/webhook.ts`'s `WebhookNotifier` (one
 *     instance for both concerns, same shape as `'slack'`/`'lark'`/
 *     `'email'` below — not actauth's own `WebhookApprover` plus a
 *     separate loopengine question class anymore; see that file's own
 *     doc comment for why they merged) — plus the lifecycle sender
 *     neither approvals nor questions needed on their own.
 *   - `'slack'` — bot-token `chat.postMessage`, via
 *     `http-notify-triggers/slack.ts`'s `SlackNotifier`.
 *   - `'lark'` — Lark/Feishu's own card API, via
 *     `http-notify-triggers/lark.ts`'s `LarkNotifier` (lower
 *     confidence on exact card-schema field names — see that file's own
 *     header comment).
 *   - `'email'` — a `sendEmail` callback plus a signed, expiring
 *     magic-link token per approval/question, via
 *     `http-notify-triggers/email.ts`'s `EmailNotifier`.
 *   - `'database'`/`'redis'` — not a notification channel at all (see
 *     `ApprovalOnlyHttpNotifierEvent`'s own doc comment): a row insert or
 *     a queue push for a separate worker/dashboard to poll, via
 *     `http-notify-triggers/database.ts`'s `DatabaseApprover`/
 *     `http-notify-triggers/redis.ts`'s `RedisQueueApprover`.
 *     `'approval'` is the only event either ever does anything with.
 *
 * `'webhook'`/`'slack'`/`'lark'`/`'email'` post an interactive message
 * (buttons, a card, or a link) for `'approval'`/`'question'`, and a plain
 * announcement (no buttons — nothing to resolve) for
 * `'agentStart'`/`'agentFinish'`. The discriminated union shape (`channel`
 * plus a matching `config`) is what lets a future kind be added later as
 * another member, not another AgentConfig field. For anything none of
 * these cover (a channel not listed above, a live `QuestionHandler` on
 * `http`, ...) set `onRunStart`/`onRunFinish` directly instead, or pass a
 * custom `RunAgentOptions.approver`/`questionHandler` from your own
 * adapter — this field is sugar over the common cases, never a
 * replacement for everything those can express. */
export type HttpNotifierConfig =
  | { channel: 'webhook'; config: { webhookUrl: string; webhookSecret: string }; events: HttpNotifierEvent[] }
  | { channel: 'slack'; config: { botToken: string; channelId: string }; events: HttpNotifierEvent[] }
  | { channel: 'lark'; config: { appId: string; appSecret: string; chatId: string }; events: HttpNotifierEvent[] }
  | {
      channel: 'email'
      config: { to: string; sendEmail: SendEmail; resolveBaseUrl: string; answerBaseUrl: string; signingSecret: string; linkTtlMs?: number }
      events: HttpNotifierEvent[]
    }
  | { channel: 'database'; config: { repository: PendingApprovalsRepository }; events: ApprovalOnlyHttpNotifierEvent[] }
  | { channel: 'redis'; config: { redis: Redis; queueKey?: string }; events: ApprovalOnlyHttpNotifierEvent[] }

/** Declares which real ModelCall an agent module wants built for it, so
 * the module doesn't have to export its own `createModelCall` —
 * `discoverAgents` synthesizes one instead (see `discover-agents.ts`),
 * lazily and memoized, the same pattern
 * `agents/customer-service/index.ts`'s own hand-written `createModelCall`
 * used before this existed. Each provider's own `createXModelCall`
 * factory (`model-calls/*.ts`) still exists and still works standalone —
 * this is a convenience for the common case, not a replacement; still
 * export your own `createModelCall` for anything this can't express (a
 * canned/simulated `ModelCall` for a demo, a custom SDK client, a
 * provider this doesn't list). `model` is required for `openai`/
 * `deepseek` (no safe hardcoded default — a flagship model name changes
 * too often to bake one in) but optional for `anthropic` (defaults to
 * `'claude-sonnet-5'`), mirroring each factory's own options exactly. */
export type AgentModelConfig =
  | { provider: 'anthropic'; model?: string; apiKey?: string; maxTokens?: number }
  | { provider: 'openai'; model: string; apiKey?: string; maxTokens?: number }
  | { provider: 'deepseek'; model: string; apiKey?: string; maxTokens?: number; baseURL?: string }

export interface ToolSchema {
  name: string
  description: string
  /** JSON schema sent to the model so it knows how to call the tool. */
  input_schema: Record<string, unknown>
}

export interface ToolDefinition extends ToolSchema {
  execute: (input: Record<string, unknown>) => Promise<unknown>
  /** Safe to run in ToolLane's parallel lane alongside other safe calls —
   * true for a read-only tool with no side effects and no shared mutable
   * state (a lookup, a search), false/omitted for anything that mutates
   * something (a refund, an email, a write). Only consulted as a default
   * when `AgentConfig.isSafeTool` isn't set — see that field's own doc
   * comment for why a classifier function (call-level, agent-level) is
   * the more powerful of the two and takes full precedence when given. */
  safe?: boolean
}

export interface AgentConfig {
  /** Also doubles as the ActAuth scope.agent segment. */
  name: string
  systemPrompt: string
  /** Required only when this agent is wrapped with `agentAsTool` (see
   * agent-as-tool.ts) — the ToolDefinition.description shown to a
   * *parent* agent's model, so it knows when to delegate here.
   * `systemPrompt` isn't a substitute: it's instructions for this agent
   * itself, not a pitch to a caller deciding whether to invoke it.
   * `agentAsTool` throws if this is missing. Irrelevant for an agent
   * that's only ever run directly (via runAgent/CLI/HTTP), so it's
   * optional here rather than required on every AgentConfig. */
  toolDescription?: string
  /** See AgentModelConfig's own doc comment. Omit entirely and the module
   * must export its own `createModelCall` instead — `discoverAgents`
   * throws at startup on a module with neither. */
  model?: AgentModelConfig
  /** Hand-written tools. An explicit array (including `[]`) is used as-is.
   * Omit entirely and it defaults to importing
   * `agents/<name>/tools/index.{ts,js}` and using its exported `tools` —
   * this repo's own aggregation-file convention (see
   * `agents/customer-service/tools/index.ts`), resolved next to
   * `run-agent.ts` itself (not `process.cwd()`, unlike `skillsDirs`/
   * `rules` — that file is real compiled code, not data, so it has to be
   * found next to whichever build of `run-agent.ts` is actually running).
   * A missing file there is just `[]`, not an error — same
   * missing-is-fine treatment `skillsDirs` gets. An agent that needs to
   * merge in tools from somewhere else too (e.g.
   * `agents/file-agent/index.ts`'s Composio-sourced ones) can't rely on
   * this default and still needs to set `tools` explicitly.
   *
   * Unlike this field, `agents/<name>/subagents/*` (see
   * agent-as-tool.ts) is *always* merged in on top of whatever `tools`
   * resolves to, explicit array or default alike — subagents are a
   * distinct concern (delegation) from hand-written tools (integration
   * code), so setting `tools` explicitly doesn't opt an agent out of its
   * own subagents/ folder the way it opts out of the tools/ default. */
  tools?: ToolDefinition[]
  /** ActAuth rules — either inline (handy for tests and small/synthetic
   * configs) or a path to an `actauth.yml` file (same shape as
   * `examples/actauth.yml` in the actauth package: top-level
   * `default_decision` + a `rules:` list with `scope`/`tool`/`decision`/
   * optional `when`), resolved against `process.cwd()` the same way
   * `skillsDirs` is. A real agent with more than a couple of rules should
   * use the file form — see agents/customer-service/actauth.yml — since a
   * permission story with `when` conditions and per-tenant/environment
   * scoping reads better as data than as a TypeScript array literal.
   * `defaultDecision` below only applies to the inline-array form; the
   * file form carries its own `default_decision` and ignores it.
   *
   * Omit entirely and it defaults to `agents/<name>/actauth.yml` — same
   * folder-form convention `skillsDirs` defaults to. Unlike `skillsDirs`,
   * a missing file there doesn't silently mean "no rules apply" as if
   * every tool were pre-approved — it falls back to an empty ruleset
   * governed by `defaultDecision` (default `'deny'` here, stricter than
   * the inline-array form's `'ask'` default: no file at all means this
   * agent's permission story was never written, not just incomplete), so
   * an agent with no `actauth.yml` yet refuses every tool outright,
   * rather than either crashing or silently allowing/asking. */
  rules?: Rule[] | string
  /** Decision when no rule matches, for the inline-array `rules` form only.
   * Default 'ask' — new tools are opt-in, not silently allowed. */
  defaultDecision?: Decision
  /** The `http` channel's notification config — see
   * `HttpNotifierConfig`'s own doc comment for the full precedence rules
   * and why it only ever touches that one channel. There's no equivalent
   * for `cli`/`http_stream`: both always get the library's own live
   * defaults, with nothing to configure. */
  httpNotifier?: HttpNotifierConfig
  /** Fires once, fire-and-forget, at the start of every `runAgent()`/
   * `resumeAgent()` call on the `http` channel (or no channel at all —
   * see below) — the "someone triggered this agent" signal, for
   * visibility into unattended/cron-triggered runs specifically. Never
   * fires for `cli`/`http_stream`: both already deliver the "it started"
   * signal to whoever's waiting synchronously, as part of that channel's
   * own normal response (a terminal that just ran the command; an SSE
   * connection carrying its own `session` event on the same stream) — a
   * second, redundant copy of information the caller already has, so
   * loopengine itself skips it there rather than leaving every
   * implementation to notice and filter it out. A caller with no
   * `channel` at all (a bespoke script) still fires, since there's no
   * such guaranteed synchronous delivery to assume for it either way.
   * `trigger` distinguishes a fresh message from a durable resume (a
   * human just answered/approved something) — an implementation that
   * only cares about the former (the common "announce a new
   * cron-triggered run started" case) checks that field itself;
   * loopengine doesn't guess which one you care about. Never awaited: an
   * implementation that returns a Promise has its rejection caught and
   * logged, not surfaced to the loop — a failed announcement shouldn't
   * fail the turn that triggered it. See `HUMAN_IN_THE_LOOP.md` for the
   * problem this and `onRunFinish` below solve. */
  onRunStart?: (context: {
    agent: string
    tenant: string
    sessionId?: string
    channel?: ApproverChannel
    trigger: 'message' | 'resolution'
  }) => void | Promise<void>
  /** Fires once, fire-and-forget, whenever a turn reaches a genuine
   * terminal outcome — `loop:done`, `max_turns`, or `denied` — never for
   * `pending_approval`/`pending_question` (those are paused, not
   * finished), and never for `cli`/`http_stream` for the exact same
   * "that channel already delivered this synchronously" reasoning
   * `onRunStart` above has (an SSE connection's own `done` event *is*
   * this signal, already). This is `onRunFinish`, not `onRunStart`'s own
   * mirror by accident: the actual gap it closes is durability-specific —
   * the caller that sent the original message may be long disconnected
   * by the time a durably-paused turn resumes and finishes (see
   * `HUMAN_IN_THE_LOOP.md`'s own section on this). Same never-awaited
   * contract as `onRunStart` above. */
  onRunFinish?: (context: {
    agent: string
    tenant: string
    sessionId?: string
    channel?: ApproverChannel
    text: string
    stopReason?: 'max_turns' | 'denied'
  }) => void | Promise<void>
  /** Resolves the ActAuth tenant for a request, from headers (never the
   * body: tenant feeds permission decisions directly, so it has to come
   * from something verified — an Authorization/API-key header checked
   * against your own mapping — never a raw client-asserted body field
   * that would let any caller claim to be any tenant and inherit that
   * tenant's rules). Only `adapters/http.ts` can actually call this (it
   * alone has a request's headers to call it with) — `run-agent.ts`
   * itself never sees a request, so `runAgent()`'s standalone/CLI callers
   * always get the `'default'` tenant, the same as omitting this field
   * entirely. Returning `undefined` is a real auth failure
   * (`adapters/http.ts` responds `401`), not "fall back to `'default'`"
   * — if "no header at all" should resolve to `'default'` rather than a
   * rejection, the resolver itself must return `'default'` explicitly.
   *
   * There's no equivalent `environment` field: environment is a
   * deployment-wide setting (`LOOPENGINE_ENV`, default `'production'`),
   * not something that varies by agent or by request. */
  tenantFor?: (headers: Record<string, string | string[] | undefined>, body: Record<string, unknown>) => string | undefined
  /** SKILL.md directories this agent can discover and invoke, resolved
   * against `process.cwd()` (not this config's own file location). Omit
   * entirely and it defaults to `agents/<name>/skills` — this repo's own
   * folder-form convention (see `agents/customer-service/skills/`) — which
   * is harmless even if that folder doesn't exist (a flat-file agent with
   * no skills at all just gets an empty index, not an error). Pass `[]`
   * explicitly instead of omitting the field to opt out of that default. */
  skillsDirs?: string[]
  skillIndexBudgetTokens?: number
  contextBudgetTokens?: number
  /** Hard cap on model calls in one runAgent() invocation — the only thing
   * that stops a model stuck re-requesting the same (or ping-ponging)
   * tool calls forever, which nothing else in this loop bounds. Default
   * 25. Hitting it ends the turn the same way running out of tools to
   * call does — a real result, not a thrown error — with
   * RunAgentResult.stopReason set to 'max_turns' so a caller can tell the
   * difference from a normal finish. */
  maxTurns?: number
  /** Which tools ToolLane may run in a parallel lane. Takes full
   * precedence over each tool's own `ToolDefinition.safe` flag when set —
   * it's strictly more powerful (a function of the whole call, not just
   * the tool's static definition, so it can vary by agent or, if you
   * thread args through, by the call's own input). Omit it to fall back
   * to each called tool's own `safe` flag instead (looked up by name);
   * omit both and every tool runs solo. */
  isSafeTool?: SafetyClassifier
  /** How adapters/http.ts derives a session key from a request body — this
   * is business logic ("what counts as one conversation" is agent-
   * specific: a customer, a Slack channel, a ticket, ...), not a channel-
   * adapter concern, so it lives here rather than being hardcoded in the
   * adapter. Return undefined to signal "this body doesn't identify a
   * session" (the adapter responds 400). Omit entirely to use the
   * adapter's default — a client-supplied `sessionId` field, the same
   * shape adapters/cli.ts's --session flag already uses.
   *
   * Body-only, unlike `tenantFor` above — a spoofed session key only lets
   * someone read/continue the wrong *conversation*; it doesn't grant
   * elevated tool permissions the way a spoofed tenant would. Real
   * verified-identity session keys (deriving this from an auth header
   * instead of a client-asserted body field like customerEmail) are a
   * legitimate future need, but nothing in this repo has a concrete use
   * for it yet — no sense widening this signature speculatively before
   * there's a real consumer to shape it around. */
  sessionIdFor?: (body: Record<string, unknown>) => string | undefined
}
