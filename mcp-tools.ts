// Wraps a real MCP server's tools as ToolDefinition[] — the same shape as
// any hand-written tool (agent-config.ts), so they drop straight into
// AgentConfig.tools. Neither run-agent.ts nor ActAuth nor ToolLane know or
// care that these particular tools proxy to a subprocess speaking MCP
// instead of running in-process; permission gating and execution still go
// through the exact same path as lookup_order or read_file.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolDefinition } from './agent-config.js'

export interface McpConnection {
  tools: ToolDefinition[]
  close: () => Promise<void>
}

/** Spawns an MCP server over stdio, discovers its tools via listTools(),
 * and wraps each one so execute() forwards to callTool() on the real
 * server. Call close() when the agent is done with it (or on process
 * shutdown) to kill the child process. */
export async function connectMcpTools(serverParams: StdioServerParameters): Promise<McpConnection> {
  const client = new Client({ name: 'loopengine', version: '0.0.1' })
  await client.connect(new StdioClientTransport(serverParams))

  const { tools } = await client.listTools()

  const toolDefs: ToolDefinition[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? tool.name,
    input_schema: tool.inputSchema as Record<string, unknown>,
    execute: async (input) => {
      const result = await client.callTool({ name: tool.name, arguments: input })
      const text = (result.content as Array<{ type: string; text?: string }>)
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      return result.isError ? { error: text } : text
    },
  }))

  return { tools: toolDefs, close: () => client.close() }
}

export interface SuggestedToolRule {
  name: string
  description: string
  /** A starting point only — never apply this without reading it. */
  suggestedDecision: 'allow' | 'ask'
  reason: string
}

/** Connects to an MCP server just long enough to list its tools and
 * suggest — never decide — an ActAuth allow/ask split, using each tool's
 * self-reported `annotations.readOnlyHint` if the server provides one.
 *
 * This exists specifically *because* that hint can't be trusted blindly:
 * the MCP spec's own doc comment on ToolAnnotations says so outright —
 * "Clients should never make tool use decisions based on ToolAnnotations
 * received from untrusted servers" — since it's the server grading its
 * own homework, and a malicious or just-buggy one could self-report
 * `readOnlyHint: true` on something destructive. So this only ever
 * *suggests*: still connects for real, still surfaces exactly what the
 * server claims, but the actual `rules`/`isSafeTool` decision is always
 * something a human reads and commits to in code, same as
 * mcp-filesystem-agent.ts's hand-curated READ_ONLY_TOOLS today — this
 * just replaces re-reading server docs by hand with one command. See
 * scripts/suggest-mcp-rules.ts for a runnable CLI wrapper. */
export async function suggestToolRules(serverParams: StdioServerParameters): Promise<SuggestedToolRule[]> {
  const client = new Client({ name: 'loopengine', version: '0.0.1' })
  await client.connect(new StdioClientTransport(serverParams))
  try {
    const { tools } = await client.listTools()
    return tools.map((tool): SuggestedToolRule => {
      const hint = tool.annotations?.readOnlyHint
      if (hint === true) {
        return {
          name: tool.name,
          description: tool.description ?? tool.name,
          suggestedDecision: 'allow',
          reason: 'server self-reports readOnlyHint: true — unverified, confirm before trusting',
        }
      }
      return {
        name: tool.name,
        description: tool.description ?? tool.name,
        suggestedDecision: 'ask',
        reason:
          hint === false
            ? 'server self-reports readOnlyHint: false (likely mutating)'
            : 'server reported no readOnlyHint — defaulting to ask until reviewed',
      }
    })
  } finally {
    await client.close()
  }
}
