#!/usr/bin/env node
// Channel adapter #1: command line.
//
//   npx tsx adapters/cli.ts --agent customer-service --session s1 "order A-1001 arrived broken"
//
// Omit --session for a one-off ask — each such call gets its own fresh,
// isolated session (a random id, printed to stderr so it can be reused
// with --session <id> later if you want to continue that exact
// conversation). Pass --session explicitly to have two calls share one
// ongoing conversation on purpose.
//
//   npx tsx adapters/cli.ts --agent customer-service --json "order A-1001 arrived broken"
//
// --json prints the same typed LoopEvent stream adapters/http.ts's SSE
// route sends (see loop-events.ts) as one JSON object per line on stdout,
// ending with a 'done'/'error' event — nothing human-readable mixed in,
// so it's pipeable straight into `jq` or another process. Without --json,
// stdout stays human-oriented (just the final answer text) and events go
// to stderr as a one-line summary each, same as before.
//
// Owns: parsing argv, loading/saving this session's history, printing the
// result to stdout. Everything else is runAgent. Uses REDIS_URL if set
// (see session-store.ts createSessionStore), a local .sessions/ dir
// otherwise — either way, safe for concurrent invocations against the
// same --session.
import { randomUUID } from 'node:crypto'
import { getEntry, listAgents } from '../core/agent-registry.js'
import { createSessionStore } from '../core/session-store.js'
import { runAgent } from '#core/run-agent.js'
import type { LoopEvent } from '#core/loop-events.js'

function parseArgs(argv: string[]) {
  let agent = ''
  let session: string | undefined
  let json = false
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent') agent = argv[++i]
    else if (argv[i] === '--session') session = argv[++i]
    else if (argv[i] === '--json') json = true
    else rest.push(argv[i])
  }
  return { agent, session, json, message: rest.join(' ') }
}

/** One NDJSON line per event — see this file's own header comment for
 * why --json mode never mixes human-readable text into stdout. */
function printJsonEvent(event: LoopEvent): void {
  console.log(JSON.stringify(event))
}

async function main() {
  const { agent, session, json, message } = parseArgs(process.argv.slice(2))
  const entry = getEntry(agent)
  if (!entry) {
    console.error(`unknown agent '${agent}'. available: ${listAgents().join(', ')}`)
    process.exit(1)
  }
  if (!message) {
    console.error('usage: cli.ts --agent <name> [--session <id>] [--json] "<message>"')
    process.exit(1)
  }

  // No --session means "a fresh, one-off ask," not "join whatever the
  // default conversation happens to be" — a shared 'default' bucket would
  // silently accumulate history across every untagged invocation forever,
  // splicing unrelated one-off asks into a single ever-growing session.
  const sessionId = session ?? randomUUID()
  // In --json mode this is the stream's own first line (mirroring
  // adapters/http.ts's SSE 'session' event) — not also duplicated to
  // stderr, so a consumer piping stdout gets exactly one place to learn
  // the generated id from, same as an SSE client does.
  if (json) printJsonEvent({ type: 'session', sessionId })
  else if (!session) console.error(`[session] ${sessionId} (pass --session ${sessionId} to continue this conversation)`)

  const sessions = createSessionStore()
  try {
    // SessionStore itself is agent-agnostic — the same --session id reused
    // across two different agents would otherwise read and write the same
    // underlying log (see adapters/http.ts's identical fix). Namespacing
    // by agent name here is what actually keeps them isolated.
    const text = await sessions.withSession(`${agent}:${sessionId}`, async (history) => {
      const result = await runAgent(entry.config, entry.createModelCall(), message, history, {
        channel: 'cli',
        onEvent: json
          ? printJsonEvent
          : (event) => {
              const { type, ...detail } = event
              console.error(`[${type}]`, detail)
            },
      })
      // Same synthetic 'done' event adapters/http.ts's streaming route
      // sends once a turn is over — covers a genuine finish and both
      // synthetic stopReasons alike (see loop-events.ts's own DoneEvent
      // doc comment), so a --json consumer always sees exactly one
      // terminal event regardless of how the turn actually ended.
      if (json) printJsonEvent({ type: 'done', text: result.text, ...(result.stopReason ? { stopReason: result.stopReason } : {}) })
      return { newMessages: result.newMessages, result: result.text }
    })
    if (!json) console.log(text)
  } catch (err) {
    // Mirrors adapters/http.ts's own in-band 'error' SSE event — in
    // --json mode the turn may already have written partial output to
    // stdout, so the failure needs to land there too, not just as an
    // uncaught rejection's stack trace on stderr.
    if (json) {
      printJsonEvent({ type: 'error', error: err instanceof Error ? err.message : String(err) })
      process.exitCode = 1
      return
    }
    throw err
  } finally {
    await sessions.close()
  }
}

main()
