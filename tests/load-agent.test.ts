import { describe, expect, it, vi } from 'vitest'
import type { StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { ToolDefinition } from '../agent-config.js'
import type { McpConnection } from '../mcp-tools.js'

const connectMcpTools = vi.fn<(params: StdioServerParameters) => Promise<McpConnection>>()
vi.mock('../mcp-tools.js', () => ({ connectMcpTools: (...args: unknown[]) => connectMcpTools(...(args as [StdioServerParameters])) }))

const { loadAgent } = await import('../load-agent.js')

function tool(name: string, tag: string): ToolDefinition {
  return {
    name,
    description: tag,
    input_schema: { type: 'object', properties: {} },
    execute: async () => tag,
  }
}

/** ToolDefinition carries an `execute` closure, so two structurally
 * identical tools are never reference-equal — compare on tag instead. */
async function tagsOf(tools: ToolDefinition[] | undefined): Promise<string[]> {
  return Promise.all((tools ?? []).map((t) => t.execute({}) as Promise<string>))
}

describe('loadAgent', () => {
  it('passes through unchanged when there are no mcpServers', async () => {
    const config = { name: 'a', systemPrompt: 'x', rules: [], tools: [tool('read_file', 'handwritten')] }

    const loaded = await loadAgent(config)

    expect(loaded.config.tools?.map((t) => t.name)).toEqual(['read_file'])
    expect(await tagsOf(loaded.config.tools)).toEqual(['handwritten'])
    expect(connectMcpTools).not.toHaveBeenCalled()
    await expect(loaded.close()).resolves.toBeUndefined()
  })

  it('defaults tools to [] when there are no mcpServers and none were hand-written', async () => {
    const config = { name: 'a', systemPrompt: 'x', rules: [] }
    const loaded = await loadAgent(config)
    expect(loaded.config.tools).toEqual([])
  })

  it('merges hand-written and MCP-discovered tools', async () => {
    const close = vi.fn(async () => {})
    connectMcpTools.mockResolvedValueOnce({ tools: [tool('list_dir', 'mcp')], close })

    const config = {
      name: 'a',
      systemPrompt: 'x',
      rules: [],
      tools: [tool('read_file', 'handwritten')],
      mcpServers: [{ command: 'fake-mcp-server' }],
    }

    const loaded = await loadAgent(config)

    expect(loaded.config.tools?.map((t) => t.name).sort()).toEqual(['list_dir', 'read_file'])
    await loaded.close()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('lets an MCP tool win over a hand-written tool with the same name', async () => {
    connectMcpTools.mockResolvedValueOnce({
      tools: [tool('read_file', 'from-mcp')],
      close: async () => {},
    })

    const config = {
      name: 'a',
      systemPrompt: 'x',
      rules: [],
      tools: [tool('read_file', 'handwritten')],
      mcpServers: [{ command: 'fake-mcp-server' }],
    }

    const loaded = await loadAgent(config)

    expect(loaded.config.tools?.map((t) => t.name)).toEqual(['read_file'])
    expect(await tagsOf(loaded.config.tools)).toEqual(['from-mcp'])
  })

  it('connects multiple MCP servers and closes all of them', async () => {
    const closeA = vi.fn(async () => {})
    const closeB = vi.fn(async () => {})
    connectMcpTools.mockResolvedValueOnce({ tools: [tool('a_tool', 'a')], close: closeA })
    connectMcpTools.mockResolvedValueOnce({ tools: [tool('b_tool', 'b')], close: closeB })

    const config = {
      name: 'a',
      systemPrompt: 'x',
      rules: [],
      mcpServers: [{ command: 'server-a' }, { command: 'server-b' }],
    }

    const loaded = await loadAgent(config)

    expect(loaded.config.tools?.map((t) => t.name).sort()).toEqual(['a_tool', 'b_tool'])
    await loaded.close()
    expect(closeA).toHaveBeenCalledTimes(1)
    expect(closeB).toHaveBeenCalledTimes(1)
  })
})
