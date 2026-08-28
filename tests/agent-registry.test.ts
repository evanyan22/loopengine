import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getEntry, listAgents, projectDir, registerAgent } from '../core/agent-registry.js'

describe('projectDir', () => {
  it("resolves to this repo's own root — the same base discoverAgents resolved agents/ against at import time", () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
    expect(projectDir()).toBe(repoRoot)
    expect(existsSync(join(projectDir(), 'agents'))).toBe(true)
  })
})

describe('registerAgent', () => {
  // No disk fixture needed — registerAgent takes an already-loaded
  // AgentModule directly (see core/agent-registry.ts's own doc comment: it's
  // for a caller, like adapters/http.ts's handleCreateAgent, that's
  // already run loadAgentModule itself). Mutates the module's real,
  // shared in-memory registry — same "no unregister, matches the no-
  // restart-needed reasoning" constraint the module itself documents —
  // so this uses a name unique to this test file rather than one that
  // could collide with a real agent or another test's own fixture.
  it('adds a new agent that getEntry/listAgents then see', () => {
    const name = 'agent-registry-test-fixture-agent'
    expect(getEntry(name)).toBeUndefined()

    registerAgent({
      config: { name, systemPrompt: 'a fixture agent for agent-registry.test.ts', model: { provider: 'anthropic', model: 'claude-sonnet-5' } },
      createModelCall: () => {
        throw new Error('not called in this test')
      },
    })

    expect(getEntry(name)?.config.systemPrompt).toBe('a fixture agent for agent-registry.test.ts')
    expect(listAgents()).toContain(name)
  })

  it('throws on a name collision with an already-registered agent, without touching it', () => {
    const before = getEntry('file-agent')

    expect(() =>
      registerAgent({
        config: { name: 'file-agent', systemPrompt: 'collision attempt', model: { provider: 'anthropic', model: 'claude-sonnet-5' } },
        createModelCall: () => {
          throw new Error('not called in this test')
        },
      }),
    ).toThrow(/Duplicate agent name 'file-agent'/)

    expect(getEntry('file-agent')).toBe(before)
  })
})
