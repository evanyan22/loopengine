import { describe, expect, it } from 'vitest'
import { parseSkillFile } from '#core/skillgarden/frontmatter.js'

describe('parseSkillFile', () => {
  it('parses a well-formed frontmatter block', () => {
    const raw = `---
name: greet
description: Greet someone by name.
paths:
  - "apps/**"
---

# Greet

Say hello.`
    const { frontmatter, body } = parseSkillFile(raw, 'fallback')
    expect(frontmatter.name).toBe('greet')
    expect(frontmatter.description).toBe('Greet someone by name.')
    expect(frontmatter.paths).toEqual(['apps/**'])
    expect(body).toBe('# Greet\n\nSay hello.')
  })

  it('falls back to the directory name and first heading when frontmatter is absent', () => {
    const raw = '# My Skill\n\nDo the thing.'
    const { frontmatter } = parseSkillFile(raw, 'my-skill')
    expect(frontmatter.name).toBe('my-skill')
    expect(frontmatter.description).toBe('My Skill')
  })

  it('does not throw on malformed YAML — falls back instead of crashing discovery', () => {
    const raw = '---\nname: [unterminated\n---\nbody text'
    const { frontmatter, body } = parseSkillFile(raw, 'fallback-name')
    expect(frontmatter.name).toBe('fallback-name')
    expect(body).toBe('body text')
  })
})
