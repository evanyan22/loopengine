// A second, unrelated agent — different persona, different tools —
// proving runAgent doesn't know or care what kind of agent it's driving.
// Only this folder and its AgentConfig change.
//
// Everything about this one agent lives under this folder: tools/ (one
// file per tool — split out since that's where real bulk accumulates as
// more tools get added), skills/, and actauth.yml (the permission story —
// which tool, which rule, which scope pattern governs it) alongside it.
// Scope resolution and the AgentConfig assembly stay here, in index.ts,
// since they're tied to this agent's own request-handling code
// (tenantFor, sessionIdFor) in a way the rules themselves aren't.
import { createHash } from 'node:crypto'
import type { AgentConfig } from '../../agent-config.js'
import { createDeepSeekModelCall } from '../../model-calls/deepseek-model-call.js'
import { runAgent, type ModelCall } from '../../run-agent.js'
import { tools } from './tools/index.js'

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

// Resolves tenant from a header, never the body — see AgentConfig.scope's
// own doc comment for why that distinction matters (scope feeds ActAuth's
// permission decisions directly, so it has to come from something
// verified). No x-api-key at all resolves to the plain 'default' tenant
// explicitly — a real resolution, not a rejection — so every existing
// curl example that never set one still works exactly as before this
// existed. Only a *present but wrong* key is treated as a real auth
// failure (401): rules below give 'acme-corp' more autonomy than
// 'default' gets, so silently falling back to 'default' on a bad key
// would be safe, not dangerous — but a caller presenting a key at all is
// asserting an identity, and getting that silently ignored instead of
// rejected is exactly the kind of thing that's confusing to debug, so
// it's rejected outright instead.
function tenantFor(headers: Record<string, string | string[] | undefined>): string | undefined {
  const apiKey = headers['x-api-key']
  if (apiKey === undefined) return 'default'
  if (typeof apiKey !== 'string') return undefined
  return API_KEY_TENANTS[apiKey] // undefined for an unrecognized key -> reject
}

// Deployment-time constant, deliberately not read from anything in an
// incoming request — a client asserting "treat me as staging" would be a
// straightforward way to get production's stricter rules bypassed. Set
// this per deployment (e.g. in the staging environment's own env vars),
// never derived from caller-supplied data. Matches run-agent.ts's own
// default ('production') when unset, so not setting this changes nothing.
const ENVIRONMENT = process.env.LOOPENGINE_ENV ?? 'production'

export const config: AgentConfig = {
  name: 'customer-service',
  systemPrompt: 'You are a support agent for Acme. Be concise and empathetic. Never promise a refund before issue_refund succeeds.',
  // environment is a plain string (fixed for this deployment — see
  // ENVIRONMENT above); tenant is a function instead, resolved per
  // request by tenantFor above, since who's calling can vary request to
  // request in a way environment never does. Only adapters/http.ts can
  // actually call tenantFor (see AgentConfig.scope's own doc comment) —
  // the standalone run below never does, so it always sees 'default'.
  scope: { tenant: tenantFor, environment: ENVIRONMENT },
  tools,
  // The permission story (which tool, which rule, which scope resolution
  // governs it) lives as data now, not a TypeScript array literal — see
  // agents/customer-service/actauth.yml, which has the exact same rules
  // (and the reasoning behind each one) this array used to hold inline.
  rules: 'agents/customer-service/actauth.yml',
  approver: {
    async requestApproval(tool, args, _scope, reason) {
      console.log(`  [actauth] approval requested for ${tool}(${JSON.stringify(args)}) — ${reason}`)
      console.log('  [actauth] auto-approved for this demo (swap in SlackApprover to page a human for real refunds)')
      return true
    },
  },
  // Both read-only lookups run together in ToolLane's parallel lane —
  // issue_refund and send_email have side effects, so each still gets
  // its own solo lane.
  isSafeTool: (call) => call.name === 'lookup_order' || call.name === 'get_shipment_details',
  sessionIdFor,
  // Scoped to this agent's own skills/ subdirectory, not any shared root —
  // see file-agent.ts's skillsDirs comment for why (discovery has no
  // per-agent filtering, so pointing at a shared root would leak skills
  // across agents). skillsDirs is a plain path resolved against the
  // process's cwd, not this file's own location, so it's the full
  // project-relative path even though this file lives right next to it.
  skillsDirs: ['agents/customer-service/skills'],
}

// Real DeepSeek model call, not the SIMULATED turn-counting one every
// other demo agent still uses — see README's "Wiring a real model"
// section for the general pattern this follows.
//
// Built lazily inside createModelCall(), memoized after that, rather than
// once at module-eval time the way file-agent.ts's connectComposioSource
// call is: agent-registry.ts's discoverAgents() imports every agent
// module at startup, for every agent, not just this one — constructing
// this eagerly would mean the whole server fails to start whenever
// DEEPSEEK_API_KEY isn't set, even to run file-agent alone. Memoizing
// after first use (rather than rebuilding per call) is safe because the
// returned ModelCall is a pure function of the messages you pass it, so
// it's reusable across every session/request — unlike the stateful
// simulated one this replaces, which counted its own calls and needed a
// fresh instance per session.
let modelCall: ModelCall | undefined
export function createModelCall(): ModelCall {
  modelCall ??= createDeepSeekModelCall({ model: 'deepseek-v4-pro' })
  return modelCall
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAgent(config, createModelCall(), 'Customer says order A-1001 arrived broken and wants a refund.', [], {
    onEvent: (event, detail) => console.log(`[${event}]`, detail),
  }).then((result) => console.log('\n[final]', result.text))
}
