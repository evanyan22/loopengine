#!/usr/bin/env node
// Probes an MCP server once and prints a starting point for its ActAuth
// rules and isSafeTool set — the same "probe it once" step
// agents/mcp-filesystem-agent.ts's READ_ONLY_TOOLS comment describes
// doing by hand. This does not decide anything: read the output, verify
// each tool actually behaves the way its self-reported readOnlyHint
// claims, then copy what you've confirmed into your own AgentConfig.
//
//   npx tsx scripts/suggest-mcp-rules.ts --scope default/production/my-agent -- \
//     npx -y @modelcontextprotocol/server-filesystem /some/dir
import { suggestToolRules } from '../mcp-tools.js'

function parseArgs(argv: string[]): { scope: string; command: string; commandArgs: string[] } {
  const dashDash = argv.indexOf('--')
  if (dashDash === -1) {
    throw new Error('usage: suggest-mcp-rules.ts [--scope <pattern>] -- <command> [args...]')
  }
  const ownArgs = argv.slice(0, dashDash)
  const [command, ...commandArgs] = argv.slice(dashDash + 1)
  if (!command) {
    throw new Error('missing MCP server command after --')
  }

  let scope = 'default/production/my-agent'
  for (let i = 0; i < ownArgs.length; i++) {
    if (ownArgs[i] === '--scope') scope = ownArgs[++i]
  }

  return { scope, command, commandArgs }
}

async function main() {
  const { scope, command, commandArgs } = parseArgs(process.argv.slice(2))

  console.log(`Connecting to: ${command} ${commandArgs.join(' ')}\n`)
  const suggestions = await suggestToolRules({ command, args: commandArgs })

  console.log(
    '⚠ These are unverified server self-reports (MCP\'s own spec says clients\n' +
      '  should never make tool-use decisions from them). Read each one, confirm\n' +
      '  it actually behaves as claimed, then copy what you\'ve verified below.\n',
  )

  for (const s of suggestions) {
    console.log(`${s.suggestedDecision.padEnd(5)} ${s.name}`)
    console.log(`      ${s.description}`)
    console.log(`      (${s.reason})\n`)
  }

  const allow = suggestions.filter((s) => s.suggestedDecision === 'allow').map((s) => s.name)

  console.log('--- Starting point for your AgentConfig (verify before using) ---\n')
  console.log(`const READ_ONLY_TOOLS = new Set(${JSON.stringify(allow, null, 2)})\n`)
  console.log(
    'rules: [...READ_ONLY_TOOLS].map((tool) => ({\n' +
      `  scopePattern: '${scope}',\n` +
      "  tool,\n  decision: 'allow' as const,\n})),\n" +
      "defaultDecision: 'ask',\n" +
      'isSafeTool: (call) => READ_ONLY_TOOLS.has(call.name),',
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
