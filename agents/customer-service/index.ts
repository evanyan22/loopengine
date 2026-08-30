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
import type { AgentConfig, HttpNotifierConfig } from '#core/agent-config.js'

// A plain POST /messages caller (a webhook, another backend, anything
// that isn't a human watching this exact response) is exactly the case
// AgentConfig.httpNotifier exists for — see that field's own doc comment
// (core/agent-config.ts) and core/http-notifier.ts. One config covers
// what used to be up to four separate ones here: an approvers.http
// override, a questionHandlers.http override, onRunStart, and onRunFinish
// each hand-wired their own webhook call (an earlier version of this file
// did exactly that — see git history). Only set when this agent's own
// webhook is actually configured, same "don't invent a target" reasoning
// adapters/http.ts's own LOOPENGINE_DEFAULT_WEBHOOK_URL fallback uses —
// unset, this agent falls straight through to the library's own live
// defaults on every channel, including http (ConsoleApprover, blocking on
// stdin) — there's no more agent-level auto-approving stand-in for that
// case (an earlier version of both this file and agents/file-agent/index.ts
// had one; it existed purely to re-derive the same webhook credentials a
// real approver already has, which is exactly the duplication
// httpNotifier exists to remove — see HttpNotifierConfig's own doc
// comment).
const httpWebhookUrl = process.env.CUSTOMER_SERVICE_WEBHOOK_URL
const httpWebhookSecret = process.env.CUSTOMER_SERVICE_WEBHOOK_SECRET
const httpNotifier: HttpNotifierConfig | undefined =
  httpWebhookUrl && httpWebhookSecret
    ? {
        channel: 'webhook',
        config: { webhookUrl: httpWebhookUrl, webhookSecret: httpWebhookSecret },
        events: ['approval', 'question', 'agentStart', 'agentFinish'],
      }
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
  //
  // No approvers/questionHandlers/onRunStart/onRunFinish here at all —
  // httpNotifier covers all four when it's set (http only; cli/http_stream
  // keep the library's own live defaults automatically, with nothing to
  // configure), and when it's unset there's nothing agent-specific to
  // fall back to for any of them either.
  httpNotifier,
  sessionIdFor,
  // Resolved per request by tenantFor above, since who's calling can vary
  // request to request. Only adapters/http.ts can actually call this (see
  // AgentConfig.tenantFor's own doc comment) — running this agent through
  // adapters/cli.ts, or any other caller with no request to resolve it
  // from, always sees 'default' instead.
  tenantFor,
}
