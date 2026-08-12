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
