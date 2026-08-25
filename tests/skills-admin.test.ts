import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readSkill, writeSkill, deleteSkill, SkillInvalidIdError, SkillNotFoundError } from '../skills-admin.js'

// Same fixture-agent-under-the-real-agents-dir approach as
// tests/gateway-tools.test.ts — skills-admin.ts resolves paths off
// gateway-tools.ts's own agentDir, which is relative to this package's
// real agents/ folder, not process.cwd().
const AGENT_NAME = 'skills-admin-fixture-agent'
const AGENT_DIR = join(process.cwd(), 'agents', AGENT_NAME)

afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
})

describe('readSkill / writeSkill / deleteSkill', () => {
  it('throws SkillNotFoundError when the skill does not exist', () => {
    expect(() => readSkill(AGENT_NAME, 'nope')).toThrow(SkillNotFoundError)
  })

  it('writeSkill creates a SKILL.md that readSkill then returns', () => {
    writeSkill(AGENT_NAME, 'summarize-files', { description: 'Summarize files in a directory', body: '# Summarize files\n\nDo the thing.' })
    expect(readSkill(AGENT_NAME, 'summarize-files')).toEqual({
      id: 'summarize-files',
      description: 'Summarize files in a directory',
      body: '# Summarize files\n\nDo the thing.',
    })
  })

  it('writes real frontmatter + body matching SkillGarden\'s own format', () => {
    writeSkill(AGENT_NAME, 'my-skill', { description: 'a skill', body: 'body text' })
    const raw = readFileSync(join(AGENT_DIR, 'skills', 'my-skill', 'SKILL.md'), 'utf8')
    expect(raw).toBe('---\nname: my-skill\ndescription: "a skill"\n---\n\nbody text\n')
  })

  it('writeSkill overwrites an existing skill in place (PUT semantics)', () => {
    writeSkill(AGENT_NAME, 'my-skill', { description: 'first', body: 'first body' })
    writeSkill(AGENT_NAME, 'my-skill', { description: 'second', body: 'second body' })
    expect(readSkill(AGENT_NAME, 'my-skill')).toEqual({ id: 'my-skill', description: 'second', body: 'second body' })
  })

  it('deleteSkill removes the skill folder', () => {
    writeSkill(AGENT_NAME, 'my-skill', { description: 'a skill', body: 'body' })
    deleteSkill(AGENT_NAME, 'my-skill')
    expect(existsSync(join(AGENT_DIR, 'skills', 'my-skill'))).toBe(false)
    expect(() => readSkill(AGENT_NAME, 'my-skill')).toThrow(SkillNotFoundError)
  })

  it('deleteSkill throws SkillNotFoundError when the skill does not exist', () => {
    expect(() => deleteSkill(AGENT_NAME, 'nope')).toThrow(SkillNotFoundError)
  })

  it('rejects a skill id that is not flat lowercase-hyphenated (nested/invalid ids out of scope)', () => {
    expect(() => writeSkill(AGENT_NAME, 'deploy/web', { description: 'x', body: 'y' })).toThrow(SkillInvalidIdError)
    expect(() => writeSkill(AGENT_NAME, '../escape', { description: 'x', body: 'y' })).toThrow(SkillInvalidIdError)
    expect(() => writeSkill(AGENT_NAME, 'Has_Upper', { description: 'x', body: 'y' })).toThrow(SkillInvalidIdError)
    expect(() => readSkill(AGENT_NAME, 'deploy/web')).toThrow(SkillInvalidIdError)
    expect(() => deleteSkill(AGENT_NAME, 'deploy/web')).toThrow(SkillInvalidIdError)
  })

  it('leaves a preexisting sibling skill untouched when adding another', () => {
    mkdirSync(join(AGENT_DIR, 'skills', 'other'), { recursive: true })
    writeFileSync(join(AGENT_DIR, 'skills', 'other', 'SKILL.md'), '---\nname: other\ndescription: preexisting\n---\n\nbody\n')

    writeSkill(AGENT_NAME, 'new-one', { description: 'new', body: 'new body' })

    expect(readSkill(AGENT_NAME, 'other')).toEqual({ id: 'other', description: 'preexisting', body: 'body' })
  })
})
