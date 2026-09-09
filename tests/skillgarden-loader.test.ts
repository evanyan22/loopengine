import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SkillGarden } from '#core/skillgarden/loader.js'

function makeSkill(root: string, relDir: string, content: string): void {
  const dir = join(root, relDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), content)
}

describe('SkillGarden', () => {
  it('indexes name+description only, then loads the full body lazily on invoke', () => {
    const root = mkdtempSync(join(tmpdir(), 'skillgarden-'))
    makeSkill(root, 'greet', '---\nname: greet\ndescription: Greet someone.\n---\nHello, $ARGUMENTS!')

    const garden = new SkillGarden({ dirs: [root] })
    const { included } = garden.buildIndex()

    expect(included).toHaveLength(1)
    expect(included[0]?.description).toBe('Greet someone.')

    expect(garden.invoke('greet', 'world')).toBe('Hello, world!')
  })

  it('throws for a skill that was never indexed', () => {
    const garden = new SkillGarden({ dirs: [] })
    expect(() => garden.load('nope')).toThrow(/Unknown skill/)
  })

  it('filters eligible skills by touched-path activation', () => {
    const root = mkdtempSync(join(tmpdir(), 'skillgarden-'))
    makeSkill(root, 'deploy/web', '---\nname: deploy:web\ndescription: Deploy the web app.\npaths:\n  - "apps/web/**"\n---\nDeploy.')
    makeSkill(root, 'greet', '---\nname: greet\ndescription: Greet someone.\n---\nHi.')

    const garden = new SkillGarden({ dirs: [root] })
    const { included } = garden.buildIndex()

    const onlyGreetTouched = garden.eligibleFor(included, ['README.md'])
    expect(onlyGreetTouched.map((e) => e.name).sort()).toEqual(['greet'])

    const webTouched = garden.eligibleFor(included, ['apps/web/index.tsx'])
    expect(webTouched.map((e) => e.name).sort()).toEqual(['deploy:web', 'greet'])
  })

  it('respects the index token budget', () => {
    const root = mkdtempSync(join(tmpdir(), 'skillgarden-'))
    makeSkill(root, 'a', `---\nname: a\ndescription: ${'x'.repeat(200)}\n---\nbody`)
    makeSkill(root, 'b', `---\nname: b\ndescription: ${'x'.repeat(200)}\n---\nbody`)

    const garden = new SkillGarden({ dirs: [root], indexBudgetTokens: 60 })
    const { included, truncated } = garden.buildIndex()

    expect(included.length + truncated.length).toBe(2)
    expect(truncated.length).toBeGreaterThan(0)
  })
})
