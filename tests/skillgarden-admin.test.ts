import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listSkillgardenCatalog, readSkillgardenCatalogEntry, addSkillgardenSkillToAgent } from '../web/skillgarden-admin.js'

// Same fixture-agent-under-the-real-agents-dir approach as
// tests/skills-admin.test.ts — addSkillgardenSkillToAgent (via
// skillgarden's own addSkill) resolves agents/<name>/skills relative to
// process.cwd(), this package's real agents/ folder, not a fixture dir.
// Unlike skills-admin.test.ts, these tests read from the real installed
// node_modules/skillgarden registry, not a fixture — skillgarden-admin.ts
// has no seam for injecting a fake one (see its own doc comment for why:
// the registry path is re-derived from skillgarden's real installed
// location), so assertions below only pin down real, known-bundled
// entries rather than the catalog's exact full contents, which can grow.
const AGENT_NAME = 'skillgarden-admin-fixture-agent'
const AGENT_DIR = join(process.cwd(), 'agents', AGENT_NAME)

afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
})

describe('listSkillgardenCatalog', () => {
  it('includes the real bundled web/firecrawl entry, category and description intact', () => {
    const catalog = listSkillgardenCatalog()
    const firecrawl = catalog.find((e) => e.category === 'web' && e.id === 'firecrawl')
    expect(firecrawl).toBeDefined()
    expect(firecrawl?.description).toContain('Firecrawl')
  })

  it('is sorted by category then id', () => {
    const catalog = listSkillgardenCatalog()
    const sorted = [...catalog].sort((a, b) => (a.category === b.category ? a.id.localeCompare(b.id) : a.category.localeCompare(b.category)))
    expect(catalog).toEqual(sorted)
  })
})

describe('readSkillgardenCatalogEntry', () => {
  it('returns the real full body for a bundled entry', () => {
    const entry = readSkillgardenCatalogEntry('files', 'batch-rename-plan')
    expect(entry.category).toBe('files')
    expect(entry.id).toBe('batch-rename-plan')
    expect(entry.body).toContain('# Batch rename plan')
  })

  it('throws for an unknown category/id', () => {
    expect(() => readSkillgardenCatalogEntry('nope', 'nope')).toThrow()
  })
})

describe('addSkillgardenSkillToAgent', () => {
  it('copies a real bundled entry into agents/<name>/skills/<id>/SKILL.md, unqualified by category', () => {
    const result = addSkillgardenSkillToAgent(AGENT_NAME, 'files', 'batch-rename-plan')

    expect(result.id).toBe('batch-rename-plan')
    // Relative, not absolute — matches skillgarden's own addSkill return
    // shape (its own destination is never resolved against cwd itself,
    // just handed to fs calls that resolve it implicitly).
    expect(result.path).toBe(join('agents', AGENT_NAME, 'skills', 'batch-rename-plan', 'SKILL.md'))
    const skillPath = join(AGENT_DIR, 'skills', 'batch-rename-plan', 'SKILL.md')
    expect(existsSync(skillPath)).toBe(true)
    expect(readFileSync(skillPath, 'utf8')).toContain('name: batch-rename-plan')
  })

  it('throws for an unknown category/id, writing nothing', () => {
    expect(() => addSkillgardenSkillToAgent(AGENT_NAME, 'nope', 'nope')).toThrow(/Unknown skill/)
    expect(existsSync(AGENT_DIR)).toBe(false)
  })

  it('refuses to overwrite an existing skill without force', () => {
    addSkillgardenSkillToAgent(AGENT_NAME, 'files', 'batch-rename-plan')

    expect(() => addSkillgardenSkillToAgent(AGENT_NAME, 'files', 'batch-rename-plan')).toThrow(/already exists/)
  })

  it('overwrites when force is set', () => {
    addSkillgardenSkillToAgent(AGENT_NAME, 'files', 'batch-rename-plan')

    const result = addSkillgardenSkillToAgent(AGENT_NAME, 'files', 'batch-rename-plan', true)

    expect(existsSync(join(result.path))).toBe(true)
  })
})
