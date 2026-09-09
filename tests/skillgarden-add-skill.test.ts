import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addSkill } from '#core/skillgarden/add-skill.js'

// Nested one level under a category, matching the real registry's own
// shape (core/skill-registry/<category>/<skill>/SKILL.md) — see
// core/skill-registry/web/firecrawl for the real thing this mirrors.
function makeRegistry(): string {
  const registryDir = mkdtempSync(join(tmpdir(), 'skillgarden-registry-'))
  const skillDir = join(registryDir, 'web', 'firecrawl')
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: firecrawl\ndescription: x\n---\nbody')
  return registryDir
}

function addSkillToRegistry(registryDir: string, category: string, skill: string): void {
  const skillDir = join(registryDir, category, skill)
  mkdirSync(skillDir, { recursive: true })
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${skill}\ndescription: x\n---\nbody`)
}

describe('addSkill', () => {
  it('copies a registry skill into <dir>/<agent>/<skill>/ and namespaces it', () => {
    const registryDir = makeRegistry()
    const skillsDir = mkdtempSync(join(tmpdir(), 'skillgarden-skills-'))

    const result = addSkill({ skill: 'firecrawl', agent: 'file-agent', skillsDir, registryDir })

    expect(result.namespacedName).toBe('file-agent:firecrawl')
    expect(result.destination).toBe(join(skillsDir, 'file-agent', 'firecrawl'))
    expect(existsSync(join(result.destination, 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(result.destination, 'SKILL.md'), 'utf8')).toContain('firecrawl')
  })

  it('throws with a helpful hint for an unknown skill', () => {
    const registryDir = makeRegistry()
    const skillsDir = mkdtempSync(join(tmpdir(), 'skillgarden-skills-'))

    expect(() => addSkill({ skill: 'nope', agent: 'file-agent', skillsDir, registryDir })).toThrow(/Unknown skill "nope"\..*firecrawl/s)
  })

  it('refuses to overwrite an existing destination without --force', () => {
    const registryDir = makeRegistry()
    const skillsDir = mkdtempSync(join(tmpdir(), 'skillgarden-skills-'))

    addSkill({ skill: 'firecrawl', agent: 'file-agent', skillsDir, registryDir })

    expect(() => addSkill({ skill: 'firecrawl', agent: 'file-agent', skillsDir, registryDir })).toThrow(/already exists/)
  })

  it('overwrites the destination when force is set', () => {
    const registryDir = makeRegistry()
    const skillsDir = mkdtempSync(join(tmpdir(), 'skillgarden-skills-'))

    addSkill({ skill: 'firecrawl', agent: 'file-agent', skillsDir, registryDir })
    const result = addSkill({ skill: 'firecrawl', agent: 'file-agent', skillsDir, registryDir, force: true })

    expect(existsSync(join(result.destination, 'SKILL.md'))).toBe(true)
  })

  it('with --agent but no --dir, defaults to agents/<agent>/skills/<skill> with no extra agent segment', () => {
    const registryDir = makeRegistry()
    const cwd = mkdtempSync(join(tmpdir(), 'skillgarden-cwd-'))
    const originalCwd = process.cwd()
    process.chdir(cwd)
    try {
      const result = addSkill({ skill: 'firecrawl', agent: 'file-agent', registryDir })

      expect(result.namespacedName).toBe('file-agent:firecrawl')
      expect(result.destination).toBe(join('agents', 'file-agent', 'skills', 'firecrawl'))
      expect(existsSync(join(cwd, 'agents', 'file-agent', 'skills', 'firecrawl', 'SKILL.md'))).toBe(true)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('with neither --agent nor --dir, defaults to the flat skills/<skill> root', () => {
    const registryDir = makeRegistry()
    const cwd = mkdtempSync(join(tmpdir(), 'skillgarden-cwd-'))
    const originalCwd = process.cwd()
    process.chdir(cwd)
    try {
      const result = addSkill({ skill: 'firecrawl', registryDir })

      expect(result.namespacedName).toBe('firecrawl')
      expect(result.destination).toBe(join('skills', 'firecrawl'))
      expect(existsSync(join(cwd, 'skills', 'firecrawl', 'SKILL.md'))).toBe(true)
    } finally {
      process.chdir(originalCwd)
    }
  })

  it('resolves a bare skill name by searching every category, unqualified in the result', () => {
    const registryDir = makeRegistry()
    const skillsDir = mkdtempSync(join(tmpdir(), 'skillgarden-skills-'))

    const result = addSkill({ skill: 'firecrawl', agent: 'file-agent', skillsDir, registryDir })

    expect(result.namespacedName).toBe('file-agent:firecrawl')
    expect(result.destination).toBe(join(skillsDir, 'file-agent', 'firecrawl'))
  })

  it('accepts an explicit category/skill and installs it unqualified', () => {
    const registryDir = makeRegistry()
    const skillsDir = mkdtempSync(join(tmpdir(), 'skillgarden-skills-'))

    const result = addSkill({ skill: 'web/firecrawl', agent: 'file-agent', skillsDir, registryDir })

    expect(result.namespacedName).toBe('file-agent:firecrawl')
    expect(result.destination).toBe(join(skillsDir, 'file-agent', 'firecrawl'))
    expect(existsSync(join(result.destination, 'SKILL.md'))).toBe(true)
  })

  it('throws for an explicit category/skill that does not exist', () => {
    const registryDir = makeRegistry()
    const skillsDir = mkdtempSync(join(tmpdir(), 'skillgarden-skills-'))

    expect(() => addSkill({ skill: 'git/firecrawl', agent: 'file-agent', skillsDir, registryDir })).toThrow(/Unknown skill "git\/firecrawl"/)
  })

  it('throws with a disambiguation hint when a bare name matches more than one category', () => {
    const registryDir = makeRegistry()
    addSkillToRegistry(registryDir, 'git', 'firecrawl')
    const skillsDir = mkdtempSync(join(tmpdir(), 'skillgarden-skills-'))

    // Directory read order across categories isn't guaranteed, so this
    // only asserts both options are present, not which comes first.
    let message = ''
    try {
      addSkill({ skill: 'firecrawl', agent: 'file-agent', skillsDir, registryDir })
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('exists in more than one category')
    expect(message).toContain('web/firecrawl')
    expect(message).toContain('git/firecrawl')
  })
})
