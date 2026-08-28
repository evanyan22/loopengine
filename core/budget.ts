// Vendored from the contextclip npm package (MIT license) and split in
// two: this file is read-only budget tracking only. See compaction.ts
// for what happens once a conversation is actually over budget — a
// distinct capability that doesn't belong under "budget" just because
// the same upstream package used to bundle both.
export interface Message {
  role: string
  content: string
}

export type CheckAction = 'ok' | 'nudge' | 'over_hard_limit'

export interface CheckResult {
  action: CheckAction
  usedTokens: number
  budgetTokens: number
  ratio: number
  /** Present only when action is 'nudge' — the host decides whether and
   * how to inject it. */
  nudge?: Message
}

/** ~4 chars/token — a common rough heuristic, good enough for a budget
 * gate rather than exact accounting. Same heuristic used across the
 * sibling ActAuth/SkillGarden projects for consistency. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const NUDGE_MESSAGE: Message = {
  role: 'system',
  content: 'The conversation is approaching its context budget. Wrap up the current step concisely.',
}

export interface BudgetTrackerOptions {
  budgetTokens: number
  /** Fraction of budget that triggers a nudge. Default 0.7. Also the
   * recovery target compaction.ts's own Compactor uses — the two are
   * constructed with the same threshold so a caller's "start wrapping
   * up" and "how far compaction tries to shrink" agree, not two
   * independently-configured numbers that could drift apart. */
  softThreshold?: number
  /** Fraction of budget that requires recovery. Default 0.92. */
  hardThreshold?: number
}

/** Tracks budget usage over a generic message array — read-only, never
 * mutates or recovers. See compaction.ts's Compactor for what a caller
 * does once this reports over_hard_limit. */
export class BudgetTracker {
  readonly budgetTokens: number
  readonly softThreshold: number
  private readonly hardThreshold: number

  constructor(options: BudgetTrackerOptions) {
    this.budgetTokens = options.budgetTokens
    this.softThreshold = options.softThreshold ?? 0.7
    this.hardThreshold = options.hardThreshold ?? 0.92
  }

  estimateUsage(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + estimateTokens(`${m.role}: ${m.content}`), 0)
  }

  /** Returns a nudge message for the host to inject if usage has crossed
   * the soft threshold but not yet the hard one. */
  check(messages: Message[]): CheckResult {
    const usedTokens = this.estimateUsage(messages)
    const ratio = usedTokens / this.budgetTokens
    if (ratio >= this.hardThreshold) {
      return { action: 'over_hard_limit', usedTokens, budgetTokens: this.budgetTokens, ratio }
    }
    if (ratio >= this.softThreshold) {
      return { action: 'nudge', usedTokens, budgetTokens: this.budgetTokens, ratio, nudge: NUDGE_MESSAGE }
    }
    return { action: 'ok', usedTokens, budgetTokens: this.budgetTokens, ratio }
  }
}
