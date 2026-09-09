import { describe, expect, it } from 'vitest'
import { buildBudgetedIndex, estimateTokens } from '#core/skillgarden/budget.js'
import type { SkillIndexEntry } from '#core/skillgarden/types.js'

function entry(name: string, tokens: number): SkillIndexEntry {
  return { name, description: name, filePath: `${name}.md`, estimatedTokens: tokens }
}

describe('buildBudgetedIndex', () => {
  it('includes everything when under budget', () => {
    const entries = [entry('a', 10), entry('b', 10)]
    const { included, truncated } = buildBudgetedIndex(entries, { maxTokens: 100 })
    expect(included).toHaveLength(2)
    expect(truncated).toHaveLength(0)
  })

  it('truncates entries once the budget is spent, preserving order priority', () => {
    const entries = [entry('a', 60), entry('b', 60), entry('c', 60)]
    const { included, truncated } = buildBudgetedIndex(entries, { maxTokens: 100 })
    expect(included.map((e) => e.name)).toEqual(['a'])
    expect(truncated.map((e) => e.name)).toEqual(['b', 'c'])
  })
})

describe('estimateTokens', () => {
  it('is roughly 4 characters per token', () => {
    expect(estimateTokens('a'.repeat(40))).toBe(10)
  })
})
