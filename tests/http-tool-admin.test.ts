import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHttpTool, HttpToolExistsError, HttpToolIndexShapeError, HttpToolNameError, type HttpToolSpec } from '../web/http-tool-admin.js'

// createHttpTool resolves agents/<name>/... the same way gateway-tools.ts's
// own agentDir does — so, same as tests/gateway-tools.test.ts, this fixture
// lives under a real, dedicated agent dir inside the repo's actual agents/,
// cleaned up after each test.
const AGENT_NAME = 'http-tool-fixture-agent'
const AGENT_DIR = join(process.cwd(), 'agents', AGENT_NAME)
const TOOLS_DIR = join(AGENT_DIR, 'tools')

afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

function spec(overrides: Partial<HttpToolSpec> = {}): HttpToolSpec {
  return {
    name: 'lookup_order_status',
    description: "Look up an order's status",
    fields: [{ name: 'orderId', type: 'string', required: true }],
    method: 'GET',
    url: 'https://api.example.com/orders/{orderId}',
    headers: [],
    sendFieldsAsJsonBody: false,
    ...overrides,
  }
}

describe('createHttpTool', () => {
  it('writes agents/<name>/tools/<tool>.ts and a fresh tools/index.ts, and returns the real, callable tool', async () => {
    const { path, tool } = await createHttpTool(AGENT_NAME, spec())

    expect(path).toBe(join(TOOLS_DIR, 'lookup_order_status.ts'))
    expect(existsSync(path)).toBe(true)
    expect(tool.name).toBe('lookup_order_status')
    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
    })

    const indexSource = readFileSync(join(TOOLS_DIR, 'index.ts'), 'utf8')
    expect(indexSource).toContain("import { lookupOrderStatus } from './lookup_order_status.js'")
    expect(indexSource).toContain('export const tools: ToolDefinition[] = [lookupOrderStatus]')
  })

  it('appends to an existing tools/index.ts with exactly one new import and one new array entry', async () => {
    mkdirSync(TOOLS_DIR, { recursive: true })
    writeFileSync(
      join(TOOLS_DIR, 'index.ts'),
      "import type { ToolDefinition } from 'loopengine'\nimport { lookupOrder } from './lookup_order.js'\n\nexport const tools: ToolDefinition[] = [lookupOrder]\n",
    )

    await createHttpTool(AGENT_NAME, spec({ name: 'issue_refund', fields: [{ name: 'orderId', type: 'string', required: true }] }))

    const indexSource = readFileSync(join(TOOLS_DIR, 'index.ts'), 'utf8')
    expect(indexSource.match(/^import /gm)?.length).toBe(3)
    expect(indexSource).toContain("import { issueRefund } from './issue_refund.js'")
    expect(indexSource).toContain('export const tools: ToolDefinition[] = [lookupOrder, issueRefund]')
  })

  it('throws HttpToolIndexShapeError, and writes nothing to index.ts, when tools/index.ts has an unrecognized shape', async () => {
    mkdirSync(TOOLS_DIR, { recursive: true })
    writeFileSync(join(TOOLS_DIR, 'index.ts'), 'export const tools = buildTools()\n')

    await expect(createHttpTool(AGENT_NAME, spec())).rejects.toThrow(HttpToolIndexShapeError)
    // the tool file itself is still written; only the index patch is refused
    expect(existsSync(join(TOOLS_DIR, 'lookup_order_status.ts'))).toBe(true)
    expect(readFileSync(join(TOOLS_DIR, 'index.ts'), 'utf8')).toBe('export const tools = buildTools()\n')
  })

  it('throws HttpToolExistsError, and writes nothing, when the tool file already exists', async () => {
    await createHttpTool(AGENT_NAME, spec())

    await expect(createHttpTool(AGENT_NAME, spec({ description: 'a different description' }))).rejects.toThrow(HttpToolExistsError)
    const source = readFileSync(join(TOOLS_DIR, 'lookup_order_status.ts'), 'utf8')
    expect(source).toContain("Look up an order\\'s status")
  })

  it('throws HttpToolNameError for a non-snake_case name, before writing anything', async () => {
    await expect(createHttpTool(AGENT_NAME, spec({ name: 'LookupOrderStatus' }))).rejects.toThrow(HttpToolNameError)
    expect(existsSync(TOOLS_DIR)).toBe(false)
  })

  it('throws HttpToolNameError when a {field} in the URL is not one of the declared fields, before writing anything', async () => {
    await expect(createHttpTool(AGENT_NAME, spec({ url: 'https://api.example.com/orders/{missing}' }))).rejects.toThrow(HttpToolNameError)
    expect(existsSync(TOOLS_DIR)).toBe(false)
  })

  it('generates a tool whose execute() calls fetch with an encoded URL, headers, and JSON body', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: 'shipped' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    process.env.TEST_API_KEY = 'secret-123'

    const { tool } = await createHttpTool(
      AGENT_NAME,
      spec({
        name: 'update_order_status',
        method: 'POST',
        url: 'https://api.example.com/orders/{orderId}/status',
        fields: [
          { name: 'orderId', type: 'string', required: true },
          { name: 'status', type: 'string', required: true },
        ],
        headers: [{ key: 'Authorization', value: 'Bearer {{TEST_API_KEY}}' }],
        sendFieldsAsJsonBody: true,
        responseJsonPath: 'status',
      }),
    )

    const result = await tool.execute({ orderId: 'a b', status: 'shipped' })
    delete process.env.TEST_API_KEY

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.example.com/orders/a%20b/status')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer secret-123')
    expect(JSON.parse(init?.body as string)).toEqual({ orderId: 'a b', status: 'shipped' })
    expect(result).toBe(JSON.stringify('shipped'))
  })

  it('generated tool throws when the missing env var is unset at call time', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    delete process.env.TEST_UNSET_KEY

    const { tool } = await createHttpTool(
      AGENT_NAME,
      spec({ name: 'needs_env_var', headers: [{ key: 'Authorization', value: 'Bearer {{TEST_UNSET_KEY}}' }] }),
    )

    await expect(tool.execute({ orderId: '1' })).rejects.toThrow('TEST_UNSET_KEY is not set')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
