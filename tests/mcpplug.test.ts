import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectComposioSource } from '#core/mcpplug.js'

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-composio-cli.mjs')

describe('connectComposioSource', () => {
  it('loads tools with a namespaced name and the schema from --get-schema', async () => {
    const source = await connectComposioSource('gh', { slugs: ['GITHUB_LIST_REPOS'], cliCommand: FAKE_CLI })
    const tools = await source.loadTools()

    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('gh_GITHUB_LIST_REPOS')
    expect(tools[0]?.description).toBe('github list repos')
    expect(tools[0]?.input_schema).toEqual({ type: 'object', properties: { x: { type: 'string' } } })
  })

  it('executes a tool and returns its data field', async () => {
    const source = await connectComposioSource('gh', { slugs: ['GITHUB_LIST_REPOS'], cliCommand: FAKE_CLI })
    const [tool] = await source.loadTools()

    const result = await tool!.execute({ owner: 'evanyan22' })
    expect(result).toEqual({ echoed: { owner: 'evanyan22' } })
  })

  it('throws when the tool call reports successful: false', async () => {
    const source = await connectComposioSource('gh', { slugs: ['FAIL_TOOL'], cliCommand: FAKE_CLI })
    const [tool] = await source.loadTools()

    await expect(tool!.execute({})).rejects.toThrow(/FAIL_TOOL failed/)
  })
})
