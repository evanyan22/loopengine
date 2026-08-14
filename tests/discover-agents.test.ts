import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverAgents } from '../discover-agents.js'

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loopengine-discover-agents-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writeAgentFile(dir: string, filename: string, agentName: string): void {
  writeFileSync(
    join(dir, filename),
    `export const config = { name: '${agentName}', systemPrompt: 'test', rules: [] }\n` +
      `export function createModelCall() { return async () => ({ stop_reason: 'end_turn', content: [] }) }\n`,
  )
}

describe('discoverAgents', () => {
  it('discovers agent modules keyed by AgentConfig.name, not filename', async () => {
    const dir = tmpDir()
    writeAgentFile(dir, 'weirdly-named-file.ts', 'my-real-agent-name')

    const entries = await discoverAgents(dir)

    expect([...entries.keys()]).toEqual(['my-real-agent-name'])
    expect(entries.get('my-real-agent-name')?.config.name).toBe('my-real-agent-name')
    expect(typeof entries.get('my-real-agent-name')?.createModelCall).toBe('function')
  })

  it('discovers multiple agents from separate files', async () => {
    const dir = tmpDir()
    writeAgentFile(dir, 'a.ts', 'agent-a')
    writeAgentFile(dir, 'b.ts', 'agent-b')

    const entries = await discoverAgents(dir)

    expect(new Set(entries.keys())).toEqual(new Set(['agent-a', 'agent-b']))
  })

  it('ignores a subdirectory with no index.ts/index.js — ordinary supporting code, not an agent', async () => {
    const dir = tmpDir()
    writeAgentFile(dir, 'real-agent.ts', 'real-agent')
    mkdirSync(join(dir, 'shared'))
    writeFileSync(join(dir, 'shared', 'helper.ts'), 'export const notAnAgent = true\n')

    const entries = await discoverAgents(dir)

    expect([...entries.keys()]).toEqual(['real-agent'])
  })

  it('discovers a subdirectory with an index.ts as one agent module, same as a flat file', async () => {
    const dir = tmpDir()
    writeAgentFile(dir, 'flat-agent.ts', 'flat-agent')
    mkdirSync(join(dir, 'folder-agent'))
    writeAgentFile(dir, 'folder-agent/index.ts', 'folder-agent')
    // A sibling file next to index.ts (e.g. a tools.ts split out of a
    // large agent) must never be independently discovered as its own
    // agent — only the top-level entries of `dir` are ever candidates,
    // and folder-agent/ is exactly one such candidate, not two.
    writeFileSync(join(dir, 'folder-agent', 'tools.ts'), 'export const tools = []\n')

    const entries = await discoverAgents(dir)

    expect(new Set(entries.keys())).toEqual(new Set(['flat-agent', 'folder-agent']))
    expect(entries.get('folder-agent')?.config.name).toBe('folder-agent')
  })

  it('throws on a file missing config or createModelCall', async () => {
    const dir = tmpDir()
    writeFileSync(join(dir, 'broken.ts'), `export const config = { name: 'broken', systemPrompt: 'x', rules: [] }\n`)

    await expect(discoverAgents(dir)).rejects.toThrow(/does not export both/)
  })

  it('throws on two files declaring the same AgentConfig.name', async () => {
    const dir = tmpDir()
    writeAgentFile(dir, 'a.ts', 'duplicate-name')
    writeAgentFile(dir, 'b.ts', 'duplicate-name')

    await expect(discoverAgents(dir)).rejects.toThrow(/Duplicate agent name 'duplicate-name'/)
  })
})
