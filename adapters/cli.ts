#!/usr/bin/env node
// Channel adapter #1: command line.
//
//   npx tsx adapters/cli.ts --agent customer-service --session s1 "order A-1001 arrived broken"
//
// Owns: parsing argv, loading/saving this session's history, printing the
// result to stdout. Everything else is runAgent. Uses REDIS_URL if set
// (see session-store.ts createSessionStore), a local .sessions/ dir
// otherwise — either way, safe for concurrent invocations against the
// same --session.
import { getEntry, listAgents, closeRegistry } from '../agent-registry.js'
import { createSessionStore } from '../session-store.js'
import { runAgent } from '../run-agent.js'

function parseArgs(argv: string[]) {
  let agent = ''
  let session = 'default'
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--agent') agent = argv[++i]
    else if (argv[i] === '--session') session = argv[++i]
    else rest.push(argv[i])
  }
  return { agent, session, message: rest.join(' ') }
}

async function main() {
  const { agent, session, message } = parseArgs(process.argv.slice(2))
  const entryPromise = getEntry(agent)
  if (!entryPromise) {
    console.error(`unknown agent '${agent}'. available: ${listAgents().join(', ')}`)
    process.exit(1)
  }
  if (!message) {
    console.error('usage: cli.ts --agent <name> [--session <id>] "<message>"')
    process.exit(1)
  }

  const sessions = createSessionStore()
  try {
    // getEntry() may spawn a subprocess (MCP agents) — this await is
    // where that connection actually happens.
    const entry = await entryPromise
    // SessionStore itself is agent-agnostic — the same --session id reused
    // across two different agents would otherwise read and write the same
    // underlying log (see adapters/http.ts's identical fix). Namespacing
    // by agent name here is what actually keeps them isolated.
    const text = await sessions.withSession(`${agent}:${session}`, async (history) => {
      const result = await runAgent(entry.config, entry.createModelCall(), message, history, {
        onEvent: (event, detail) => console.error(`[${event}]`, detail),
      })
      return { history: result.history, result: result.text }
    })
    console.log(text)
  } finally {
    await sessions.close()
    await closeRegistry()
  }
}

main()
