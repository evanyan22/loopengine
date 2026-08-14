// The declarative surface a user fills in to define a new agent. Nothing
// here runs anything — run-agent.ts is the one place that interprets it.
import type { Rule, Decision, Scope, Approver } from 'actauth'
import type { SafetyClassifier } from 'toollane'

/** A single AgentConfig.scope field's value — see that field's own doc
 * comment for the full explanation of when each form applies. */
export type ScopeValue =
  | string
  | ((headers: Record<string, string | string[] | undefined>, body: Record<string, unknown>) => string | undefined)

export interface ToolSchema {
  name: string
  description: string
  /** JSON schema sent to the model so it knows how to call the tool. */
  input_schema: Record<string, unknown>
}

export interface ToolDefinition extends ToolSchema {
  execute: (input: Record<string, unknown>) => Promise<unknown>
}

export interface AgentConfig {
  /** Also doubles as the ActAuth scope.agent segment. */
  name: string
  systemPrompt: string
  /** Hand-written tools. Default []. */
  tools?: ToolDefinition[]
  /** ActAuth rules, e.g. { scopePattern: 'default/production/customer-service', tool: 'issue_refund', decision: 'ask' } */
  rules: Rule[]
  /** Decision when no rule matches. Default 'ask' — new tools are opt-in, not silently allowed. */
  defaultDecision?: Decision
  /** Default ConsoleApprover (blocks on stdin) — pass e.g. a Slack-backed Approver for unattended agents. */
  approver?: Approver
  /** ActAuth tenant/environment for this agent. Each field is either a
   * plain string (fixed for every request — environment usually is) or a
   * function resolving it per request from headers/body (tenant often
   * needs to be, since who's calling can vary request to request).
   * Function values receive headers, not just the body: scope feeds
   * ActAuth's permission decisions directly, so it has to come from
   * something verified (an Authorization/API-key header checked against
   * your own mapping), never a raw client-asserted body field — trusting
   * the body would let any caller claim to be any tenant and inherit
   * that tenant's rules. A resolver returning undefined is a real auth
   * failure (adapters/http.ts responds 401), not "fall back to the
   * default" — if "no header at all" should resolve to some default
   * tenant rather than a rejection, the resolver itself must return that
   * value explicitly, not undefined. Omit a field (or `scope` entirely)
   * to use run-agent.ts's own hardcoded default for it.
   *
   * Only adapters/http.ts can actually call a function value (it alone
   * has headers/body to call it with) — run-agent.ts itself never sees a
   * request, so it treats any field that's still a function by the time
   * it gets there (the standalone/CLI paths, which pass this config to
   * runAgent directly, skipping that resolution) as unset and falls back
   * to its own hardcoded default, rather than spreading a function value
   * into what ActAuth expects to be a plain string. */
  scope?: { [K in keyof Omit<Scope, 'agent'>]?: ScopeValue }
  /** SKILL.md directories this agent can discover and invoke. Omit if the agent has no skills. */
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
  /** Which tools ToolLane may run in a parallel lane. Default: none (every tool runs solo). */
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
   * Body-only, unlike the `scope` field above — a spoofed session key
   * only lets someone read/continue the wrong *conversation*; it doesn't
   * grant elevated tool permissions the way a spoofed tenant would. Real
   * verified-identity session keys (deriving this from an auth header
   * instead of a client-asserted body field like customerEmail) are a
   * legitimate future need, but nothing in this repo has a concrete use
   * for it yet — no sense widening this signature speculatively before
   * there's a real consumer to shape it around. */
  sessionIdFor?: (body: Record<string, unknown>) => string | undefined
}
