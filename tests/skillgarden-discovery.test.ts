import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverSkillFiles } from '#core/skillgarden/discovery.js'

function makeSkill(root: string, relDir: string): void {
  const dir = join(root, relDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: x\ndescription: x\n---\nbody')
}

describe('discoverSkillFiles', () => {
  it('finds a flat skill with a simple name', () => {
    const root = mkdtempSync(join(tmpdir(), 'skillgarden-'))
    makeSkill(root, 'greet')

    const found = discoverSkillFiles(root)
    expect(found).toHaveLength(1)
    expect(found[0]?.namespacedName).toBe('greet')
  })

  it('namespaces nested skills with colons', () => {
    const root = mkdtempSync(join(tmpdir(), 'skillgarden-'))
    makeSkill(root, 'deploy/web')

    const found = discoverSkillFiles(root)
    expect(found).toHaveLength(1)
    expect(found[0]?.namespacedName).toBe('deploy:web')
  })

  it('does not walk into a skill directory looking for nested skills', () => {
    const root = mkdtempSync(join(tmpdir(), 'skillgarden-'))
    makeSkill(root, 'outer')
    // A stray SKILL.md-shaped dir inside an already-matched skill dir
    // should not be discovered as a second skill.
    makeSkill(root, 'outer/inner')

    const found = discoverSkillFiles(root)
    expect(found.map((f) => f.namespacedName).sort()).toEqual(['outer'])
  })
})
