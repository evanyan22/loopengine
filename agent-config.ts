// The declarative surface a user fills in to define a new agent. Nothing
// here runs anything — run-agent.ts is the one place that interprets it.
import type { Rule, Decision, Approver } from 'actauth'
import type { SafetyClassifier } from 'toollane'

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
  /** Default ConsoleApprover (blocks on stdin) — pass e.g. a Slack-backed Approver for unattended agents. */
  approver?: Approver
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
