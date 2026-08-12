// A third example agent — proves MCP support is config-driven: this file
// is a plain `config` + `createModelCall()`, exactly like file-agent.ts
// and customer-service-agent.ts. It has zero hand-written tools; every
// one comes from mcpServers, resolved by load-agent.ts at load time
// against the official @modelcontextprotocol/server-filesystem (a real
// subprocess, not a mock).
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import type { AgentConfig } from './agent-config.js'
import { runAgent, type ModelCall } from './run-agent.js'
import { loadAgent } from './load-agent.js'

const SANDBOX_DIR = new URL('./mcp-sandbox', import.meta.url).pathname
const NOTES_PATH = `${SANDBOX_DIR}/notes.txt`

// Runs once whenever this module is loaded — standalone or through the
// registry — not just in the `main` guard below, since mcpServers needs
// the directory to already exist the moment loadAgent() connects to it.
// A real MCP-backed agent would usually point at a directory that
// already exists; this seeding is purely to make the demo self-contained
// and reproducible. Sync and idempotent: never clobbers an existing
// notes.txt, so it's safe to re-import (e.g. across HTTP requests).
mkdirSync(SANDBOX_DIR, { recursive: true })
if (!existsSync(NOTES_PATH)) writeFileSync(NOTES_PATH, 'Q1 revenue grew 12% year over year.\n')

// Tools this server exposes that only read — safe to allow outright and
// run in parallel. Anything not listed here (write_file, edit_file,
// create_directory, move_file, ...) falls through to defaultDecision:
// 'ask' below. These names come from having probed the server once
// (`client.listTools()`); load-agent.ts doesn't need to know them —
// they're just rule data, the same way a hand-written tool's rules are.
const READ_ONLY_TOOLS = new Set([
  'read_text_file',
  'read_multiple_files',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'get_file_info',
  'search_files',
  'list_allowed_directories',
])

export const config: AgentConfig = {
  name: 'mcp-filesystem-agent',
  systemPrompt: 'You summarize the contents of files in the sandbox directory.',
  mcpServers: [
    {
      command: 'node',
      args: ['node_modules/@modelcontextprotocol/server-filesystem/dist/index.js', SANDBOX_DIR],
    },
  ],
  rules: [...READ_ONLY_TOOLS].map((tool) => ({
    scopePattern: 'default/production/mcp-filesystem-agent',
    tool,
    decision: 'allow' as const,
  })),
  defaultDecision: 'ask',
  approver: {
    async requestApproval(tool, args, _scope, reason) {
      console.log(`  [actauth] approval requested for ${tool}(${JSON.stringify(args)}) — ${reason}`)
      console.log('  [actauth] auto-approved for this demo')
      return true
    },
  },
  isSafeTool: (call) => READ_ONLY_TOOLS.has(call.name),
}

// SIMULATED model call — see file-agent.ts for why this is a factory.
// The tool names/schemas it targets are real (probed against the live
// server), but the decision of *which* tool to call each turn is canned.
export function createModelCall(): ModelCall {
  let turn = 0
  return async () => {
    turn++
    if (turn === 1) {
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'list_directory', input: { path: SANDBOX_DIR } }] }
    }
    if (turn === 2) {
      return {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't2', name: 'read_text_file', input: { path: NOTES_PATH } }],
      }
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done — notes.txt says Q1 revenue grew 12% year over year.' }] }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { config: loaded, close } = await loadAgent(config)
  try {
    const result = await runAgent(loaded, createModelCall(), 'Summarize notes.txt in the sandbox directory.', [], {
      onEvent: (event, detail) => console.log(`[${event}]`, detail),
    })
    console.log('\n[final]', result.text)
  } finally {
    await close()
  }
}
