// Channel adapter #2: HTTP API. Deliberately built on node:http, not a
// framework — the point is that runAgent doesn't care what's calling it,
// so the adapter has no special integration surface to show off.
//
//   npx tsx adapters/http.ts
//
//   # single JSON response, once the whole loop finishes
//   curl -X POST localhost:8787/agents/customer-service/messages \
//     -H 'content-type: application/json' \
//     -d '{"customerEmail":"a@example.com","message":"order A-1001 arrived broken"}'
//
//   # same request, but as it happens: one SSE event per loop step
//   curl -N -X POST localhost:8787/agents/customer-service/messages/stream \
//     -H 'content-type: application/json' \
//     -d '{"customerEmail":"a@example.com","message":"order A-1001 arrived broken"}'
//
// Owns: routing by agent name, request/response shape, mapping a customer
// identity to a session, and (via SessionStore.withSession) making sure
// two concurrent requests from the *same* customer don't race on
// read-modify-write of that customer's history. Different customers get
// different session keys and never touch each other's state — same
// guarantee, no extra code, because sessions are keyed by customer
// identity, not by request.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import { getEntry, closeRegistry, type RegistryEntry } from '../agent-registry.js'
import { createSessionStore } from '../session-store.js'
import { runAgent } from '../run-agent.js'

const sessions = createSessionStore()

// Customer email -> session key. Hashed so raw emails never end up in
// Redis keys / filenames; conversationId lets one customer have more than
// one thread (defaults to a single ongoing conversation per customer).
function sessionIdFor(customerEmail: string, conversationId = 'default'): string {
  const hash = createHash('sha256').update(customerEmail.trim().toLowerCase()).digest('hex').slice(0, 24)
  return `customer-${hash}-${conversationId}`
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
  sessionId: string
}

type ParseResult = { ok: true; value: ParsedRequest } | { ok: false; status: number; error: string }

// Shared by both routes: resolve the agent, validate the body, compute
// the session key. Neither route commits to a response shape until this
// has succeeded — the streaming route in particular must not send SSE
// headers until it knows the request is actually going to run.
async function parseRequest(req: IncomingMessage, agentName: string): Promise<ParseResult> {
  const entryPromise = getEntry(agentName)
  if (!entryPromise) return { ok: false, status: 404, error: `unknown agent '${agentName}'` }

  const body = await readJsonBody(req)
  const customerEmail = String(body.customerEmail ?? '')
  const message = String(body.message ?? '')
  const conversationId = body.conversationId ? String(body.conversationId) : undefined
  if (!customerEmail || !message) {
    return { ok: false, status: 400, error: 'customerEmail and message are required' }
  }

  // Resolved once per agent then cached (agent-registry.ts) — for an MCP
  // agent this is where the subprocess connection actually happens, but
  // only on the first request that ever hits it.
  const entry = await entryPromise
  return { ok: true, value: { entry, message, sessionId: sessionIdFor(customerEmail, conversationId) } }
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
  const { entry, message, sessionId } = parsed.value

  const text = await sessions.withSession(sessionId, async (history) => {
    // Fresh modelCall per request — see agent-registry.ts.
    const result = await runAgent(entry.config, entry.createModelCall(), message, history)
    return { history: result.history, result: result.text }
  })

  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text }))
}

async function handleMessagesStream(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
  const parsed = await parseRequest(req, agentName)
  if (!parsed.ok) {
    // Headers not sent yet — still a plain JSON error response, not SSE.
    res.writeHead(parsed.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: parsed.error }))
    return
  }
  const { entry, message, sessionId } = parsed.value

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  try {
    await sessions.withSession(sessionId, async (history) => {
      // onEvent already fires at every loop step (contextclip:check,
      // actauth:decision, toollane:result, ...) — streaming is just
      // forwarding those, not a separate code path through runAgent.
      const result = await runAgent(entry.config, entry.createModelCall(), message, history, {
        onEvent: (event, detail) => writeSseEvent(res, event, detail),
      })
      writeSseEvent(res, 'done', { text: result.text })
      return { history: result.history, result: result.text }
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
  // agent whose loader rejects, e.g. a dead MCP connection, took the
  // entire server down before this existed). handleMessagesStream's own
  // try/catch below still handles errors *after* SSE headers are sent
  // (those need an in-band `error` event, not a fresh status code) — this
  // is the backstop for everything before that point, for both routes.
  try {
    const streamMatch = req.method === 'POST' && req.url?.match(/^\/agents\/([^/]+)\/messages\/stream$/)
    if (streamMatch) {
      await handleMessagesStream(req, res, decodeURIComponent(streamMatch[1]))
      return
    }

    const match = req.method === 'POST' && req.url?.match(/^\/agents\/([^/]+)\/messages$/)
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
  await closeRegistry()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
