import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import {
  addGatewayTool,
  describeGatewayTools,
  listComposioConnections,
  listComposioTools,
  loadGatewayToolsFromDir,
  readGatewayTools,
  removeGatewayTool,
  removeGatewayToolSlug,
  GatewayToolExistsError,
  GatewayToolNotFoundError,
  type ComposioGatewayToolEntry,
} from '../gateway-tools.js'

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-composio-cli.mjs')

// gateway-tools.ts resolves agents/<name>/... against its own file
// location, same as run-agent.ts's agentsRootDir — so these fixtures live
// under a real, dedicated agent name inside the repo's actual agents/
// dir, cleaned up after each test, same approach tests/subagent-tools.test.ts
// already uses for the same reason.
const AGENT_NAME = 'gateway-tools-fixture-agent'
const AGENT_DIR = join(process.cwd(), 'agents', AGENT_NAME)

afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
})

function entry(overrides: Partial<ComposioGatewayToolEntry> = {}): ComposioGatewayToolEntry {
  return { provider: 'composio', name: 'gh', slugs: ['GITHUB_LIST_REPOS'], cliCommand: FAKE_CLI, ...overrides }
}

describe('readGatewayTools / addGatewayTool / removeGatewayTool', () => {
  it('returns [] when gateway-tools.yml does not exist', () => {
    expect(readGatewayTools(AGENT_NAME)).toEqual([])
  })

  it('addGatewayTool writes an entry that readGatewayTools then returns', () => {
    addGatewayTool(AGENT_NAME, entry())
    expect(readGatewayTools(AGENT_NAME)).toEqual([entry()])
  })

  it('merges slugs into an existing same-name source instead of rejecting', () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['A'] }))
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['B'] }))

    expect(readGatewayTools(AGENT_NAME)).toEqual([entry({ name: 'gh', slugs: ['A', 'B'] })])
  })

  it('re-adding an already-present slug does not duplicate it', () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['A', 'B'] }))
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['B', 'C'] }))

    expect(readGatewayTools(AGENT_NAME)).toEqual([entry({ name: 'gh', slugs: ['A', 'B', 'C'] })])
  })

  it('still rejects reusing a name already registered under a different provider', () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh' }))
    const conflicting = { ...entry({ name: 'gh' }), provider: 'nango' } as unknown as ComposioGatewayToolEntry

    expect(() => addGatewayTool(AGENT_NAME, conflicting)).toThrow(GatewayToolExistsError)
  })

  it('seeds actauth rules only for the newly submitted slugs, not the whole merged list', () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['A'] }), 'allow')
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['B'] }), 'ask')

    const raw = parseYaml(readFileSync(join(AGENT_DIR, 'actauth.yml'), 'utf8'))
    const rules = raw.rules.map((r: { tool: string; decision: string }) => [r.tool, r.decision])
    expect(rules).toEqual([
      ['gh_A', 'allow'],
      ['gh_B', 'ask'],
    ])
  })

  it('removeGatewayTool removes exactly the named entry', () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh' }))
    addGatewayTool(AGENT_NAME, entry({ name: 'slack' }))

    removeGatewayTool(AGENT_NAME, 'gh')

    expect(readGatewayTools(AGENT_NAME).map((s) => s.name)).toEqual(['slack'])
  })

  it('throws removing a source that was never registered', () => {
    expect(() => removeGatewayTool(AGENT_NAME, 'nope')).toThrow(GatewayToolNotFoundError)
  })

  it('removeGatewayToolSlug drops just that slug, keeping the rest of the source', () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['A', 'B', 'C'] }))

    removeGatewayToolSlug(AGENT_NAME, 'gh', 'B')

    expect(readGatewayTools(AGENT_NAME)).toEqual([entry({ name: 'gh', slugs: ['A', 'C'] })])
  })

  it('removeGatewayToolSlug deletes the whole source once its last slug is gone', () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['A'] }))

    removeGatewayToolSlug(AGENT_NAME, 'gh', 'A')

    expect(readGatewayTools(AGENT_NAME)).toEqual([])
  })

  it('removeGatewayToolSlug throws for an unknown source or an unregistered slug', () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['A'] }))

    expect(() => removeGatewayToolSlug(AGENT_NAME, 'nope', 'A')).toThrow(GatewayToolNotFoundError)
    expect(() => removeGatewayToolSlug(AGENT_NAME, 'gh', 'NOT_REGISTERED')).toThrow(GatewayToolNotFoundError)
  })

  it('removeGatewayToolSlug also removes the auto-seeded rule for just that slug', () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['A', 'B'] }), 'allow')

    removeGatewayToolSlug(AGENT_NAME, 'gh', 'A')

    const raw = parseYaml(readFileSync(join(AGENT_DIR, 'actauth.yml'), 'utf8'))
    expect(raw.rules.map((r: { tool: string }) => r.tool)).toEqual(['gh_B'])
  })

  it('removeGatewayTool removes every auto-seeded rule for that source', () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['A', 'B'] }), 'allow')
    addGatewayTool(AGENT_NAME, entry({ name: 'slack', slugs: ['C'] }), 'allow')

    removeGatewayTool(AGENT_NAME, 'gh')

    const raw = parseYaml(readFileSync(join(AGENT_DIR, 'actauth.yml'), 'utf8'))
    expect(raw.rules.map((r: { tool: string }) => r.tool)).toEqual(['slack_C'])
  })

  it('never removes a hand-authored rule for the same tool, only the auto-seeded one', () => {
    mkdirSync(AGENT_DIR, { recursive: true })
    writeFileSync(
      join(AGENT_DIR, 'actauth.yml'),
      'default_decision: deny\nrules:\n  - name: hand-written-rule\n    scope: "*/*"\n    tool: gh_A\n    decision: allow\n',
    )
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['A'] }))

    removeGatewayToolSlug(AGENT_NAME, 'gh', 'A')

    const raw = parseYaml(readFileSync(join(AGENT_DIR, 'actauth.yml'), 'utf8'))
    expect(raw.rules.map((r: { name: string }) => r.name)).toEqual(['hand-written-rule'])
  })

  it('removing a tool that was added without a decision (no rule ever seeded) does not error', () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['A'] }))

    expect(() => removeGatewayToolSlug(AGENT_NAME, 'gh', 'A')).not.toThrow()
  })

  it('addGatewayTool with a decision seeds one exact-match actauth rule per tool the source will produce', () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['A', 'B'] }), 'allow')

    const raw = parseYaml(readFileSync(join(AGENT_DIR, 'actauth.yml'), 'utf8'))
    expect(raw.default_decision).toBe('deny')
    const tools = raw.rules.map((r: { tool: string }) => r.tool).sort()
    expect(tools).toEqual(['gh_A', 'gh_B'])
    expect(raw.rules.every((r: { decision: string }) => r.decision === 'allow')).toBe(true)
  })

  it('addGatewayTool without a decision does not touch actauth.yml at all', () => {
    addGatewayTool(AGENT_NAME, entry())
    expect(() => readFileSync(join(AGENT_DIR, 'actauth.yml'), 'utf8')).toThrow()
  })

  it('appends to an existing actauth.yml rather than clobbering it', () => {
    mkdirSync(AGENT_DIR, { recursive: true })
    writeFileSync(join(AGENT_DIR, 'actauth.yml'), 'default_decision: deny\nrules:\n  - name: existing\n    scope: "*/*"\n    tool: some_tool\n    decision: allow\n')

    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['A'] }), 'ask')

    const raw = parseYaml(readFileSync(join(AGENT_DIR, 'actauth.yml'), 'utf8'))
    expect(raw.rules.map((r: { tool: string }) => r.tool).sort()).toEqual(['gh_A', 'some_tool'])
  })
})

describe('loadGatewayToolsFromDir', () => {
  it('returns [] when there is no gateway-tools.yml', async () => {
    expect(await loadGatewayToolsFromDir(AGENT_DIR)).toEqual([])
  })

  it('resolves a composio source into real ToolDefinitions with a working execute', async () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['GITHUB_LIST_REPOS'] }))

    const tools = await loadGatewayToolsFromDir(AGENT_DIR)

    expect(tools).toHaveLength(1)
    expect(tools[0]?.name).toBe('gh_GITHUB_LIST_REPOS')
    expect(tools[0]?.input_schema).toEqual({ type: 'object', properties: { x: { type: 'string' } } })
    await expect(tools[0]?.execute({ owner: 'evanyan22' })).resolves.toEqual({ echoed: { owner: 'evanyan22' } })
  })

  it('caches by the registry file\'s own mtime — does not re-shell out when the file is unchanged', async () => {
    const logDir = mkdtempSync(join(tmpdir(), 'gateway-tools-log-'))
    const logPath = join(logDir, 'calls.log')
    const originalEnv = process.env.COMPOSIO_FAKE_LOG
    process.env.COMPOSIO_FAKE_LOG = logPath
    try {
      addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['GITHUB_LIST_REPOS'] }))

      await loadGatewayToolsFromDir(AGENT_DIR)
      const callsAfterFirst = readFileSync(logPath, 'utf8').trim().split('\n').length

      await loadGatewayToolsFromDir(AGENT_DIR)
      const callsAfterSecond = readFileSync(logPath, 'utf8').trim().split('\n').length

      expect(callsAfterSecond).toBe(callsAfterFirst)

      // Touching the file (even to the same content) bumps mtime and
      // must invalidate the cache — an operator's edit should never need
      // a restart to take effect, same convention actauth.yml already has.
      addGatewayTool(AGENT_NAME, entry({ name: 'slack', slugs: ['SEND_MESSAGE'] }))
      await loadGatewayToolsFromDir(AGENT_DIR)
      const callsAfterEdit = readFileSync(logPath, 'utf8').trim().split('\n').length
      expect(callsAfterEdit).toBeGreaterThan(callsAfterSecond)
    } finally {
      if (originalEnv === undefined) delete process.env.COMPOSIO_FAKE_LOG
      else process.env.COMPOSIO_FAKE_LOG = originalEnv
      rmSync(logDir, { recursive: true, force: true })
    }
  })
})

describe('describeGatewayTools', () => {
  it('reports status ok with resolved tools for a working source', async () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['GITHUB_LIST_REPOS'] }))

    const [status] = await describeGatewayTools(AGENT_NAME)

    expect(status?.status).toBe('ok')
    expect(status?.tools).toEqual([{ name: 'gh_GITHUB_LIST_REPOS', description: 'github list repos' }])
  })

  it('reports status error for a broken source without failing the whole call', async () => {
    addGatewayTool(AGENT_NAME, entry({ name: 'broken', slugs: ['BROKEN_SLUG'] }))
    addGatewayTool(AGENT_NAME, entry({ name: 'gh', slugs: ['GITHUB_LIST_REPOS'] }))

    const statuses = await describeGatewayTools(AGENT_NAME)

    const broken = statuses.find((s) => s.entry.name === 'broken')
    const gh = statuses.find((s) => s.entry.name === 'gh')
    expect(broken?.status).toBe('error')
    expect(broken?.error).toContain('composio CLI call failed')
    expect(gh?.status).toBe('ok')
  })
})

describe('listComposioConnections / listComposioTools', () => {
  it('flattens the toolkit -> accounts map into one array, with status', async () => {
    const connections = await listComposioConnections(FAKE_CLI)

    expect(connections).toEqual([
      { toolkit: 'github', status: 'ACTIVE', alias: null, wordId: 'github_test' },
      { toolkit: 'slack', status: 'EXPIRED', alias: null, wordId: 'slack_test' },
    ])
  })

  it('lists a connected toolkit\'s available tools', async () => {
    const tools = await listComposioTools('github', FAKE_CLI)

    expect(tools).toEqual([
      { slug: 'GITHUB_LIST_REPOS', name: 'List repos', description: 'List the authenticated user’s repositories.' },
      { slug: 'GITHUB_CREATE_ISSUE', name: 'Create issue', description: 'Create an issue in a repository.' },
    ])
  })

  it('returns [] for a toolkit with no tools, rather than throwing', async () => {
    expect(await listComposioTools('nope', FAKE_CLI)).toEqual([])
  })
})
