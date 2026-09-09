import type { SkillIndexEntry } from './types.js'

/** ~4 chars/token — a common rough heuristic, good enough for budgeting
 * an index of short description lines. Deliberately its own copy, not a
 * shared import from core/budget.ts's own estimateTokens — that one
 * budgets a model's full conversation context; this one budgets a
 * skill-index listing, a different unit at a different layer, even
 * though the heuristic they both land on happens to be identical. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface BuildIndexOptions {
  maxTokens: number
}

export interface BudgetedIndex {
  included: SkillIndexEntry[]
  truncated: SkillIndexEntry[]
}

/** Fills the index in order until the token budget is spent, then drops
 * the rest. Order matters — callers that want priority (e.g. skills
 * matching recently-touched files first) should sort entries before
 * calling this. */
export function buildBudgetedIndex(entries: SkillIndexEntry[], options: BuildIndexOptions): BudgetedIndex {
  const included: SkillIndexEntry[] = []
  const truncated: SkillIndexEntry[] = []
  let used = 0

  for (const entry of entries) {
    if (used + entry.estimatedTokens <= options.maxTokens) {
      included.push(entry)
      used += entry.estimatedTokens
    } else {
      truncated.push(entry)
    }
  }

  return { included, truncated }
}
