// Vendored from the contextclip npm package (MIT license) and split in
// two — see budget.ts's own header comment for why. This half is the
// actual tail-preserving compaction: two staged, escalating recovery for
// when budget.ts's own BudgetTracker.check() reports over_hard_limit.
import { estimateTokens, type Message } from './budget.js'

export interface Summarizer {
  summarize(messages: Message[]): Promise<Message>
}

/** A real, working default — no model call. Concatenates and truncates
 * rather than genuinely summarizing, so the whole recovery pipeline is
 * testable without wiring up an LLM. Swap in a real Summarizer (an LLM
 * call, host-provided) for actual compression quality — this module
 * doesn't bundle one, same as ActAuth doesn't bundle a Slack client. */
export class TruncatingSummarizer implements Summarizer {
  private readonly maxChars: number

  constructor(maxChars = 500) {
    this.maxChars = maxChars
  }

  async summarize(messages: Message[]): Promise<Message> {
    const combined = messages.map((m) => `[${m.role}] ${m.content}`).join('\n')
    const truncated = combined.length > this.maxChars ? `${combined.slice(0, this.maxChars)}…` : combined
    return { role: 'system', content: `[compacted ${messages.length} earlier message(s)]\n${truncated}` }
  }
}

export type RecoverAction = 'unchanged' | 'drained' | 'summarized'

export interface RecoverResult {
  messages: Message[]
  action: RecoverAction
  usedTokens: number
  budgetTokens: number
}

export interface CompactorOptions {
  budgetTokens: number
  /** Recovery target, as a fraction of budgetTokens — pass the same
   * value as the BudgetTracker's own softThreshold so "how far
   * compaction tries to shrink" agrees with "when a nudge fires"
   * instead of being independently configured. Default 0.7. */
  softThreshold?: number
  /** Most-recent messages never drained or summarized. Default 4. */
  tailMessages?: number
  summarizer?: Summarizer
}

/** Recovers in two stages, never touching the most recent tailMessages:
 * a cheap deterministic drain first, a pluggable Summarizer second. */
export class Compactor {
  private readonly budgetTokens: number
  private readonly softThreshold: number
  private readonly tailMessages: number
  private readonly summarizer: Summarizer

  constructor(options: CompactorOptions) {
    this.budgetTokens = options.budgetTokens
    this.softThreshold = options.softThreshold ?? 0.7
    this.tailMessages = options.tailMessages ?? 4
    this.summarizer = options.summarizer ?? new TruncatingSummarizer()
  }

  private estimateUsage(messages: Message[]): number {
    return messages.reduce((sum, m) => sum + estimateTokens(`${m.role}: ${m.content}`), 0)
  }

  async recover(messages: Message[]): Promise<RecoverResult> {
    const tailStart = Math.max(0, messages.length - this.tailMessages)
    const tail = messages.slice(tailStart)
    const head = messages.slice(0, tailStart)
    const target = this.budgetTokens * this.softThreshold

    if (this.estimateUsage(messages) <= target) {
      return { messages, action: 'unchanged', usedTokens: this.estimateUsage(messages), budgetTokens: this.budgetTokens }
    }

    // Stage 1: drain — cheap, no model call. Capped at half of `head` so
    // there's always something left for stage 2 to compress instead of
    // deleting everything outright.
    const drainCap = Math.ceil(head.length / 2)
    const remainingHead = head.slice(drainCap)
    const drainedCount = head.length - remainingHead.length
    const afterDrain = [...remainingHead, ...tail]

    if (this.estimateUsage(afterDrain) <= target) {
      return {
        messages: afterDrain,
        action: drainedCount > 0 ? 'drained' : 'unchanged',
        usedTokens: this.estimateUsage(afterDrain),
        budgetTokens: this.budgetTokens,
      }
    }

    // Stage 2: still over budget — summarize whatever's left of head.
    // The tail is never touched.
    let finalMessages = afterDrain
    if (remainingHead.length > 0) {
      const summary = await this.summarizer.summarize(remainingHead)
      finalMessages = [summary, ...tail]
    }
    return { messages: finalMessages, action: 'summarized', usedTokens: this.estimateUsage(finalMessages), budgetTokens: this.budgetTokens }
  }
}
