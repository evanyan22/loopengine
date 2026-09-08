// A real Summarizer (compaction.ts's own interface) — an actual model
// call instead of TruncatingSummarizer's concatenate-and-cut default.
// Deliberately its own file, not folded into compaction.ts: that module
// is vendored and stays decoupled from run-agent.ts's own types (see its
// header comment), while this one is exactly the "host-provided" LLM
// call compaction.ts's own doc comment says it doesn't bundle.
import type { Message } from './budget.js'
import type { ModelCall } from './run-agent.js'
import { type Summarizer, TruncatingSummarizer } from './compaction.js'

const DEFAULT_SYSTEM_PROMPT = `You are compacting an in-progress agent conversation to free up context window. You will be given a segment of older messages (the most recent messages are kept verbatim elsewhere and are not shown to you). Write a dense summary that lets the agent continue this task without having seen the original messages.

Structure your summary with these sections, using only the ones that have content:
- Facts established: concrete values stated even once — ids, numbers, names, dates, amounts, decisions — verbatim, not paraphrased. A fact that only appears here and gets paraphrased or dropped is lost for good.
- Actions taken: tool calls made and their outcomes, briefly.
- Open question / next step: what's still unresolved, if anything.

Output only the summary itself — no preamble, no "here is a summary".`

export interface LLMSummarizerOptions {
  modelCall: ModelCall
  /** Replaces the default instructions entirely — not appended to them. */
  systemPrompt?: string
}

/** Calls modelCall with no tools and asks it to compact `messages` per
 * DEFAULT_SYSTEM_PROMPT's own structure (see that constant's own doc
 * comment for why "facts established" is its own named section rather
 * than left to a generic "summarize this" prompt — a fact mentioned once
 * early in a long conversation is exactly what a free-form summary tends
 * to paraphrase away). Falls back to TruncatingSummarizer — rather than
 * throwing, which would surface as a whole turn failing — if the call
 * itself throws (rate limit, network) or comes back with no usable text
 * (a model that only ever returns tool_use has nothing this can use). */
export class LLMSummarizer implements Summarizer {
  private readonly modelCall: ModelCall
  private readonly systemPrompt: string
  private readonly fallback = new TruncatingSummarizer()

  constructor(options: LLMSummarizerOptions) {
    this.modelCall = options.modelCall
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT
  }

  async summarize(messages: Message[]): Promise<Message> {
    const transcript = messages.map((m) => `[${m.role}] ${m.content}`).join('\n')

    let text: string | undefined
    try {
      const response = await this.modelCall([{ role: 'user', content: transcript }], this.systemPrompt, [])
      text = response.content.find((block) => block.type === 'text')?.text?.trim()
    } catch {
      // modelCall threw — fall through to the truncating fallback below,
      // same as text staying undefined.
    }

    if (!text) return this.fallback.summarize(messages)

    return { role: 'system', content: `[compacted ${messages.length} earlier message(s)]\n${text}` }
  }
}
