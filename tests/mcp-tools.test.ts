import { describe, expect, it, vi } from 'vitest'

const connect = vi.fn(async () => {})
const listTools = vi.fn()
const callTool = vi.fn()
const close = vi.fn(async () => {})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({ connect, listTools, callTool, close })),
}))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}))

const { connectMcpTools } = await import('../mcp-tools.js')

describe('connectMcpTools', () => {
  it('wraps each discovered MCP tool as a ToolDefinition', async () => {
    listTools.mockResolvedValueOnce({
      tools: [
        {
          name: 'read_text_file',
          description: 'Reads a file',
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
        },
      ],
    })

    const { tools } = await connectMcpTools({ command: 'fake-server' })

    expect(connect).toHaveBeenCalledTimes(1)
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('read_text_file')
    expect(tools[0].description).toBe('Reads a file')
    expect(tools[0].input_schema).toEqual({ type: 'object', properties: { path: { type: 'string' } } })
  })

  it('falls back to the tool name when the server gives no description', async () => {
    listTools.mockResolvedValueOnce({
      tools: [{ name: 'no_desc_tool', inputSchema: { type: 'object' } }],
    })

    const { tools } = await connectMcpTools({ command: 'fake-server' })

    expect(tools[0].description).toBe('no_desc_tool')
  })

  it('execute() forwards to callTool and joins text content blocks', async () => {
    listTools.mockResolvedValueOnce({
      tools: [{ name: 'read_text_file', inputSchema: { type: 'object' } }],
    })
    callTool.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
      isError: false,
    })

    const { tools } = await connectMcpTools({ command: 'fake-server' })
    const result = await tools[0].execute({ path: '/tmp/a.txt' })

    expect(callTool).toHaveBeenCalledWith({ name: 'read_text_file', arguments: { path: '/tmp/a.txt' } })
    expect(result).toBe('line one\nline two')
  })

  it('execute() returns { error } when the server reports isError', async () => {
    listTools.mockResolvedValueOnce({
      tools: [{ name: 'read_text_file', inputSchema: { type: 'object' } }],
    })
    callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: 'ENOENT: no such file' }],
      isError: true,
    })

    const { tools } = await connectMcpTools({ command: 'fake-server' })
    const result = await tools[0].execute({ path: '/missing' })

    expect(result).toEqual({ error: 'ENOENT: no such file' })
  })

  it('close() closes the underlying client', async () => {
    listTools.mockResolvedValueOnce({ tools: [] })

    const connection = await connectMcpTools({ command: 'fake-server' })
    await connection.close()

    expect(close).toHaveBeenCalledTimes(1)
  })
})
