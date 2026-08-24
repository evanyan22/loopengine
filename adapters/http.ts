// Channel adapter #2: HTTP API. Deliberately built on node:http, not a
// framework — the point is that runAgent doesn't care what's calling it,
// so the adapter has no special integration surface to show off.
//
//   npx tsx adapters/http.ts
//
//   # single JSON response, once the whole loop finishes — customer-service
//   # defines its own sessionIdFor (see agents/customer-service/index.ts),
//   # so its request bodies key sessions off customerEmail; other agents
//   # take a plain sessionId field instead, or omit it entirely for a
//   # fresh one-off session (see defaultSessionIdFor below) — either way
//   # the response body echoes back whichever sessionId was actually used
//   curl -X POST localhost:8787/agents/customer-service/messages \
//     -H 'content-type: application/json' \
//     -d '{"customerEmail":"a@example.com","message":"order A-1001 arrived broken"}'
//
//   # same request, but as it happens: one SSE event per loop step
//   curl -N -X POST localhost:8787/agents/customer-service/messages/stream \
//     -H 'content-type: application/json' \
//     -d '{"customerEmail":"a@example.com","message":"order A-1001 arrived broken"}'
//
// Owns: routing by agent name, request/response shape, and (via
// SessionStore.withSession) making sure two concurrent requests for the
// *same* session don't race on read-modify-write of that session's
// history. What counts as "the same session" is deliberately not this
// file's call — see AgentConfig.sessionIdFor and defaultSessionIdFor below.
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { getEntry, listAgents, type RegistryEntry } from '../agent-registry.js'
import { createSessionStore } from '../session-store.js'
import { runAgent, loadRules, loadDefaultTools } from '../run-agent.js'
import type { AgentConfig } from '../agent-config.js'
import { playgroundHtml } from './playground.js'
import { agentsConfigPageHtml } from './agents-config-page.js'
import { agentsListPageHtml } from './agents-list-page.js'

const sessions = createSessionStore()

// Used when an AgentConfig doesn't define its own sessionIdFor — a plain
// client-supplied key, same shape adapters/cli.ts's --session flag
// already uses. Deriving a session key from something richer (a
// customer's email, a Slack channel, a support ticket ID, ...) is
// business logic specific to what that agent is for, so it belongs on
// the AgentConfig, not hardcoded here for every agent this adapter might
// ever route to.
function defaultSessionIdFor(body: Record<string, unknown>): string | undefined {
  const sessionId = body.sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

// An agent-defined sessionIdFor always wins outright when present — for
// customer-service that's a real, stable identity (a customerEmail hash),
// and it returning undefined (no customerEmail in the body) is a genuine
// validation failure, not "start me an anonymous session." Only the
// *default*, agent-agnostic fallback auto-generates one: a missing
// sessionId there just means "no ongoing conversation to resume," the
// same thing omitting --session now means for adapters/cli.ts, not an
// error — see the response body for how the caller learns what id got
// used.
function sessionIdFor(config: AgentConfig, body: Record<string, unknown>): string | undefined {
  if (config.sessionIdFor) return config.sessionIdFor(body)
  return defaultSessionIdFor(body) ?? randomUUID()
}

// Resolves AgentConfig.tenantFor against this request's headers/body —
// run-agent.ts itself never sees a request, so this per-request
// resolution has to happen here, before that point (see
// AgentConfig.tenantFor's own doc comment). Returning undefined is a real
// auth failure, not "use 'default'" — if "no header at all" should mean
// 'default' rather than a rejection, the resolver itself must return
// 'default' explicitly. No tenantFor at all is not a failure, though —
// it just means this agent doesn't need per-request tenants, so every
// request is the 'default' tenant.
function resolveTenant(
  config: AgentConfig,
  headers: IncomingMessage['headers'],
  body: Record<string, unknown>,
): { ok: true; value: string } | { ok: false } {
  if (!config.tenantFor) return { ok: true, value: 'default' }
  const result = config.tenantFor(headers, body)
  return result === undefined ? { ok: false } : { ok: true, value: result }
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

interface ParsedRequest {
  entry: RegistryEntry
  message: string
  /** Whatever the caller sent (or, for the default fallback, what got
   * generated) — echo this back in the response so a client that omitted
   * sessionId can capture it and resume the same conversation next time. */
  rawSessionId: string
  /** The actual SessionStore key — tenant-, environment-, and agent-namespaced, never what goes in a response. */
  storageSessionId: string
  /** This request's resolved tenant — pass straight through as
   * RunAgentOptions.tenant on every runAgent call in this file. */
  tenant: string
}

type ParseResult = { ok: true; value: ParsedRequest } | { ok: false; status: number; error: string }

// Shared by both routes: resolve the agent, validate the body, compute
// the session key. Neither route commits to a response shape until this
// has succeeded — the streaming route in particular must not send SSE
// headers until it knows the request is actually going to run.
async function parseRequest(req: IncomingMessage, agentName: string): Promise<ParseResult> {
  const entry = getEntry(agentName)
  if (!entry) return { ok: false, status: 404, error: `unknown agent '${agentName}'` }

  const body = await readJsonBody(req)
  const message = String(body.message ?? '')
  const rawSessionId = sessionIdFor(entry.config, body)
  if (!message) return { ok: false, status: 400, error: 'message is required' }
  // Only reachable when the agent defines its own sessionIdFor and it
  // returned undefined — the default fallback (sessionIdFor above) always
  // produces something, generating one rather than leaving this undefined.
  if (!rawSessionId) return { ok: false, status: 400, error: 'could not derive a session id from the request body' }

  const tenantResolution = resolveTenant(entry.config, req.headers, body)
  if (!tenantResolution.ok) return { ok: false, status: 401, error: 'could not verify tenant for this request' }
  const tenant = tenantResolution.value

  // SessionStore itself is agent-agnostic — it has no idea which agent is
  // calling withSession, so two different agents given the same sessionId
  // (e.g. a client that reuses one ID across agents, or two agents whose
  // sessionIdFor happens to produce the same value) would otherwise read
  // and write the exact same underlying log, splicing one agent's history
  // into another's. Namespacing by agent name here is what actually
  // prevents that — confirmed live: before this, calling file-agent then
  // rag-agent with the same sessionId fed rag-agent file-agent's entire
  // prior conversation as context.
  //
  // Also namespaced by tenant and environment, for the same reason: two
  // different tenants (or environments) whose sessionIdFor happens to
  // produce the same raw id would otherwise collide on the exact same
  // underlying log, splicing one tenant's/environment's conversation into
  // another's. environment is a deployment-wide setting (LOOPENGINE_ENV),
  // not resolved per-request the way tenant is — same reasoning
  // run-agent.ts's own Scope construction uses.
  const environment = process.env.LOOPENGINE_ENV ?? 'production'
  return {
    ok: true,
    value: { entry, message, rawSessionId, tenant, storageSessionId: `${tenant}:${environment}:${agentName}:${rawSessionId}` },
  }
}

// Backs GET /agents/:name/config (the JSON API behind the /agents/config
// page below). Reuses loadRules/loadDefaultTools rather than re-deriving
// AgentConfig's defaults independently — so this always shows exactly what
// runAgent() would actually resolve and enforce, not a second guess at it
// that could drift out of sync. Never includes AgentModelConfig.apiKey or
// any function value (approver, isSafeTool, sessionIdFor, tenantFor) —
// those either aren't JSON-serializable or would leak a secret; each is
// reported as 'custom' vs its default instead.
async function describeAgent(entry: RegistryEntry): Promise<Record<string, unknown>> {
  const { config } = entry
  const tools = config.tools ?? (await loadDefaultTools(config))
  const rules = loadRules(config)
  const rulesSource = Array.isArray(config.rules)
    ? 'inline'
    : config.rules !== undefined
      ? `file: ${config.rules}`
      : `default: agents/${config.name}/actauth.yml`

  return {
    name: config.name,
    systemPrompt: config.systemPrompt,
    model: config.model
      ? { provider: config.model.provider, model: config.model.model, maxTokens: config.model.maxTokens }
      : 'custom (module exports its own createModelCall)',
    maxTurns: config.maxTurns ?? 25,
    contextBudgetTokens: config.contextBudgetTokens ?? 8000,
    skillIndexBudgetTokens: config.skillIndexBudgetTokens ?? 200,
    skillsDirs: config.skillsDirs ?? [`agents/${config.name}/skills`],
    tools: tools.map((t) => ({ name: t.name, description: t.description, safe: t.safe === true, input_schema: t.input_schema })),
    permissions: {
      source: rulesSource,
      defaultDecision: rules.defaultDecision,
      rules: rules.rules,
    },
    isSafeTool: config.isSafeTool ? 'custom' : "default (each tool's own `safe` flag)",
    sessionIdFor: config.sessionIdFor ? 'custom' : 'default (client-supplied `sessionId` field)',
    tenantFor: config.tenantFor ? 'custom' : "none (every request is the 'default' tenant)",
    approver: config.approver ? 'custom' : 'default (ConsoleApprover)',
  }
}

// GET /agents content-negotiates on this: a browser navigating there sends
// an Accept header that prefers text/html, so it gets agentsListPageHtml
// below; fetch()'s own default Accept (`*/*`, the same default every
// fetch('/agents') call in playground.ts/agents-config-page.ts/
// agents-list-page.ts itself already relies on) does not include
// text/html, so this can't silently break an existing JSON consumer.
function prefersHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html')
}

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function handleMessages(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
  const parsed = await parseRequest(req, agentName)
  if (!parsed.ok) {
    res.writeHead(parsed.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: parsed.error }))
    return
  }
  const { entry, message, rawSessionId, storageSessionId, tenant } = parsed.value

  const text = await sessions.withSession(storageSessionId, async (history) => {
    // Fresh modelCall per request — see agent-registry.ts.
    const result = await runAgent(entry.config, entry.createModelCall(), message, history, { tenant })
    return { newMessages: result.newMessages, result: result.text }
  })

  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text, sessionId: rawSessionId }))
}

async function handleMessagesStream(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
  const parsed = await parseRequest(req, agentName)
  if (!parsed.ok) {
    // Headers not sent yet — still a plain JSON error response, not SSE.
    res.writeHead(parsed.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: parsed.error }))
    return
  }
  const { entry, message, rawSessionId, storageSessionId, tenant } = parsed.value

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  // First event, always — same reason handleMessages echoes sessionId in
  // its JSON body: a caller that omitted sessionId needs some way to
  // learn what got generated in order to resume this conversation later.
  writeSseEvent(res, 'session', { sessionId: rawSessionId })

  try {
    await sessions.withSession(storageSessionId, async (history) => {
      // onEvent already fires at every loop step (contextclip:check,
      // actauth:decision, toollane:result, ...) — streaming is just
      // forwarding those, not a separate code path through runAgent.
      const result = await runAgent(entry.config, entry.createModelCall(), message, history, {
        tenant,
        onEvent: (event, detail) => writeSseEvent(res, event, detail),
      })
      writeSseEvent(res, 'done', { text: result.text })
      return { newMessages: result.newMessages, result: result.text }
    })
  } catch (err) {
    // Headers are already sent by this point, so an error becomes an SSE
    // event, not an HTTP status code.
    writeSseEvent(res, 'error', { error: String(err) })
  } finally {
    res.end()
  }
}

const server = createServer(async (req, res) => {
  // One catch-all around both routes. node:http does not catch rejections
  // from an async request listener itself — an uncaught one here doesn't
  // just fail the request, it crashes the whole process (confirmed: an
  // unhandled rejection anywhere in a route took the entire server down
  // before this existed). handleMessagesStream's own try/catch below
  // still handles errors *after* SSE headers are sent (those need an
  // in-band `error` event, not a fresh status code) — this is the
  // backstop for everything before that point, for both routes.
  try {
    // Query strings (the browser pages below link to each other with
    // ?agent=<name> to deep-link a preselected agent) would otherwise
    // break every exact-match/regex `$`-anchored route below, which only
    // ever expected a bare path — stripped once here rather than in each
    // route individually.
    const pathname = (req.url ?? '/').split('?')[0]

    const streamMatch = req.method === 'POST' && pathname.match(/^\/agents\/([^/]+)\/messages\/stream$/)
    if (streamMatch) {
      await handleMessagesStream(req, res, decodeURIComponent(streamMatch[1]))
      return
    }

    // Dev playground: a browser client on top of the two routes above,
    // rendering the same SSE events /messages/stream already emits — see
    // adapters/playground.ts. GET, not POST, and an exact path match
    // (neither has a :name segment), so no risk of colliding with the
    // regexes above (already partitioned by method).
    if (req.method === 'GET' && pathname === '/playground') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(playgroundHtml)
      return
    }
    if (req.method === 'GET' && pathname === '/agents') {
      if (prefersHtml(req)) {
        res.writeHead(200, { 'content-type': 'text/html' }).end(agentsListPageHtml)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ agents: listAgents().map((name) => ({ name, systemPrompt: getEntry(name)!.config.systemPrompt })) }),
      )
      return
    }

    // Browser page: lists every registered agent and renders its full
    // config (tools, permissions, sessionIdFor, ...) via the JSON route
    // below — see adapters/agents-config-page.ts. A fixed two-segment path,
    // so it can't collide with the three-segment /agents/:name/config
    // regex right below it.
    if (req.method === 'GET' && pathname === '/agents/config') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(agentsConfigPageHtml)
      return
    }

    const configMatch = req.method === 'GET' && pathname.match(/^\/agents\/([^/]+)\/config$/)
    if (configMatch) {
      const agentName = decodeURIComponent(configMatch[1])
      const entry = getEntry(agentName)
      if (!entry) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await describeAgent(entry)))
      return
    }

    const match = req.method === 'POST' && pathname.match(/^\/agents\/([^/]+)\/messages$/)
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }))
      return
    }

    await handleMessages(req, res, decodeURIComponent(match[1]))
  } catch (err) {
    if (res.headersSent) {
      res.end()
    } else {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(err) }))
    }
  }
})

const port = Number(process.env.PORT ?? 8787)
server.listen(port, () => console.log(`agent API listening on :${port}`))

async function shutdown() {
  server.close()
  await sessions.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
