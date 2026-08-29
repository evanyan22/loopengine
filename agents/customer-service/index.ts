// A second, unrelated agent — different persona, different tools —
// proving runAgent doesn't know or care what kind of agent it's driving.
// Only this folder and its AgentConfig change.
//
// Everything about this one agent lives under this folder: tools/ (one
// file per tool — split out since that's where real bulk accumulates as
// more tools get added), skills/, and actauth.yml (the permission story —
// which tool, which rule, which scope pattern governs it) alongside it.
// Tenant resolution and the AgentConfig assembly stay here, in index.ts,
// since they're tied to this agent's own request-handling code
// (tenantFor, sessionIdFor) in a way the rules themselves aren't.
import { createHash } from 'node:crypto'
import type { AgentConfig } from '#core/agent-config.js'
import { DurableWebApprover, type LiveApprover } from 'actauth'
import { DurableWebQuestionHandler } from '#core/system-tools/index.js'

// cli and http_stream (a real human, live, right now) keep auto-
// approving for this demo — see below for why http is different.
const demoApprover: LiveApprover = {
  async requestApproval(tool, args, _scope, reason) {
    console.log(`  [actauth] approval requested for ${tool}(${JSON.stringify(args)}) — ${reason}`)
    console.log('  [actauth] auto-approved for this demo (swap in SlackApprover to page a human for real refunds)')
    return true
  },
}

// http specifically goes durable instead: a plain POST /messages caller
// (a webhook, another backend, anything that isn't a human watching this
// exact response) is exactly the case DurableWebApprover exists for —
// see DURABLE_APPROVALS.md. Only constructed when this agent's own
// webhook is actually configured, same "don't invent a target" reasoning
// adapters/http.ts's own LOOPENGINE_DEFAULT_WEBHOOK_URL fallback uses —
// falls back to the same demoApprover above otherwise, so this agent
// still runs out of the box with nothing configured.
const httpWebhookUrl = process.env.CUSTOMER_SERVICE_WEBHOOK_URL
const httpWebhookSecret = process.env.CUSTOMER_SERVICE_WEBHOOK_SECRET
const httpApprover =
  httpWebhookUrl && httpWebhookSecret
    ? new DurableWebApprover({ webhookUrl: httpWebhookUrl, signingSecret: httpWebhookSecret })
    : demoApprover

// Question-side sibling of httpApprover above, for system_ask_user (see
// DURABLE_APPROVALS.md's "Durable questions" section) — same "goes
// durable on http, only when this agent's own webhook is configured"
// reasoning, but no demoApprover-style fallback: unlike a boolean
// approve/deny, there's no sensible way to auto-generate a free-text
// answer to an arbitrary clarifying question, so there's nothing to
// stand in for a human here. Left unset when unconfigured — falls
// straight through to the http channel's own default (either
// adapters/http.ts's own deployment-wide DurableWebQuestionHandler, if
// *that's* configured, or the live WebQuestionHandler registry
// otherwise), not to a fake answer. cli/http_stream get no override
// either, for the same reason — both already default to the right thing
// (CliQuestionHandler / WebQuestionHandler) via run-agent.ts's own
// channel resolution, with no per-agent auto-answer to substitute in the
// way demoApprover substitutes for a human's yes/no.
const questionWebhookUrl = process.env.CUSTOMER_SERVICE_QUESTION_WEBHOOK_URL ?? httpWebhookUrl
const questionWebhookSecret = process.env.CUSTOMER_SERVICE_QUESTION_WEBHOOK_SECRET ?? httpWebhookSecret
const httpQuestionHandler =
  questionWebhookUrl && questionWebhookSecret
    ? new DurableWebQuestionHandler({ webhookUrl: questionWebhookUrl, signingSecret: questionWebhookSecret })
    : undefined

// This agent's own session-key derivation — a customer's identity (their
// email) is what "one conversation" means here, so that mapping lives on
// this AgentConfig rather than being hardcoded in adapters/http.ts for
// every agent it might ever route to (file-agent, rag-agent, ... have no
// concept of "customer" at all). Hashed so raw emails never end up in
// Redis keys / filenames; conversationId lets one customer have more than
// one thread (defaults to a single ongoing conversation per customer).
//
// customerEmail is only ever client-asserted here, never verified —
// anyone can send someone else's email and get routed straight into that
// person's existing session. A real fix means deriving this from a
// validated auth token instead, which needs a real auth backend this demo
// doesn't have — see AgentConfig.sessionIdFor's own doc comment for why
// that's a deliberately deferred, not forgotten, gap.
function sessionIdFor(body: Record<string, unknown>): string | undefined {
  const customerEmail = typeof body.customerEmail === 'string' ? body.customerEmail.trim() : ''
  if (!customerEmail) return undefined
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : 'default'
  const hash = createHash('sha256').update(customerEmail.toLowerCase()).digest('hex').slice(0, 24)
  return `customer-${hash}-${conversationId}`
}

// Maps a caller's API key to the tenant they're verified to be calling
// as — stands in for a real lookup (a database, an auth provider) a
// production deployment would use instead. Real key material, not real
// customers: this is illustrative demo data, not a secret.
const API_KEY_TENANTS: Record<string, string> = {
  'acme-trusted-key': 'acme-corp',
}

// Resolves tenant from a header, never the body — see
// AgentConfig.tenantFor's own doc comment for why that distinction
// matters (tenant feeds ActAuth's permission decisions directly, so it
// has to come from something verified). No x-api-key at all resolves to
// the plain 'default' tenant explicitly — a real resolution, not a
// rejection — so every existing curl example that never set one still
// works exactly as before this existed. Only a *present but wrong* key is
// treated as a real auth failure (401): rules below give 'acme-corp' more
// autonomy than 'default' gets, so silently falling back to 'default' on
// a bad key would be safe, not dangerous — but a caller presenting a key
// at all is asserting an identity, and getting that silently ignored
// instead of rejected is exactly the kind of thing that's confusing to
// debug, so it's rejected outright instead.
//
// Environment isn't handled here at all — it's not an AgentConfig
// concern anymore (see AgentConfig.tenantFor's own doc comment): every
// agent's environment is just process.env.LOOPENGINE_ENV, resolved once
// by run-agent.ts/adapters/http.ts themselves.
function tenantFor(headers: Record<string, string | string[] | undefined>): string | undefined {
  const apiKey = headers['x-api-key']
  if (apiKey === undefined) return 'default'
  if (typeof apiKey !== 'string') return undefined
  return API_KEY_TENANTS[apiKey] // undefined for an unrecognized key -> reject
}

export const config: AgentConfig = {
  name: 'customer-service',
  systemPrompt: 'You are a support agent for Acme. Be concise and empathetic. Never promise a refund before issue_refund succeeds.',
  // No createModelCall exported at all — discoverAgents synthesizes one
  // from this, lazily and memoized (see AgentModelConfig's own doc
  // comment), the same real DeepSeek call this agent used to build by
  // hand. Not the SIMULATED turn-counting one every other demo agent
  // still uses — see README's "Wiring a real model" section.
  model: { provider: 'deepseek', model: 'deepseek-v4-pro' },
  // No tools here — it defaults to importing
  // agents/customer-service/tools/index.js (see AgentConfig.tools's own
  // doc comment), the same tools this used to import and assign directly.
  // No rules here — it defaults to agents/customer-service/actauth.yml
  // (see AgentConfig.rules's own doc comment), the same path this used
  // to set explicitly. The permission story (which tool, which rule,
  // which scope resolution governs it) lives as data there, not a
  // TypeScript array literal.
  approvers: { cli: demoApprover, http: httpApprover, http_stream: demoApprover },
  questionHandlers: { http: httpQuestionHandler },
  sessionIdFor,
  // Resolved per request by tenantFor above, since who's calling can vary
  // request to request. Only adapters/http.ts can actually call this (see
  // AgentConfig.tenantFor's own doc comment) — running this agent through
  // adapters/cli.ts, or any other caller with no request to resolve it
  // from, always sees 'default' instead.
  tenantFor,
}
