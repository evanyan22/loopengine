// The system ask_user tool (see this folder's own index.ts, and
// run-agent.ts's tools merge) — lets a model pause mid-turn and ask the
// human operator a genuinely ambiguous question instead of guessing, the
// same reasoning WebApprover exists for permission 'ask' decisions
// (web-approver.ts), just generalized from a fixed allow/deny to an open
// answer. No companion skill the way read_file has
// system-skills/composio-large-outputs — that skill exists to bridge an
// *indirect* trigger (another tool's storedInFile result implying
// read_file should be called); this tool's own description is a
// complete, self-contained instruction with no such indirection to
// bridge.
//
// A fresh tool per runAgent() call, not a static export like read_file —
// it needs somewhere to register a pending question so a later
// answerQuestion() call can find and resolve it, and its onPending hook
// needs to close over that call's own onEvent — see createAskUserTool's
// own doc comment, and web-approver.ts's createTrackedApprover for the
// same reasoning applied to approvals.
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import type { ToolDefinition } from '../agent-config.js'

export interface PendingQuestion {
  id: string
  question: string
  /** Suggested answers, if the model gave any — never the only allowed
   * answer, a human can still type free text either way (see
   * answerQuestion, which takes any string). */
  options?: string[]
  /** Which agent raised this — always known (config.name), so listing can
   * always at least be scoped per-agent even without a session id. */
  agent: string
  /** Which conversation raised this, if the caller has one (see
   * RunAgentOptions.sessionId's own doc comment for when it doesn't) —
   * lets listQuestions scope down to exactly one conversation instead of
   * every question raised by this agent, or this whole process. */
  sessionId?: string
  requestedAt: string
}

interface PendingEntry {
  entry: PendingQuestion
  resolve: (answer: string) => void
  timer: ReturnType<typeof setTimeout>
}

// One shared, global registry — unlike WebApprover's pending approvals
// (split across a shared instance and a fresh one per streamed turn, so
// each turn's onPending can target its own SSE connection), a question
// only ever needs *one* place to live: onPending here is just an optional
// extra notification layered on top, not a routing key, so every
// question — from any call, streamed or not — is always answerable via
// answerQuestion()/listQuestions() below regardless of how it was raised.
const questionsById = new Map<string, PendingEntry>()

const DEFAULT_TIMEOUT_MS = 5 * 60_000

/** Blocking terminal prompt — the same fallback actauth's own
 * ConsoleApprover uses for a permission ask with nowhere else to go
 * (see createAskUserTool below for when this applies). */
async function promptOnConsole(question: string, options?: string[]): Promise<string> {
  console.log(`\n[ask_user] ${question}`)
  if (options?.length) console.log(`  options: ${options.join(', ')}`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question('> ')).trim()
  } finally {
    rl.close()
  }
}

/** Builds the ask_user ToolDefinition for one runAgent() call.
 *
 * context identifies *whose* question this is (see PendingQuestion's own
 * doc comment) — without it, listQuestions() would have no way to scope
 * down to one agent/conversation, and every caller would see every
 * pending question this whole process has ever raised.
 *
 * onPending, when given, is how a live caller (adapters/http.ts's
 * streaming route passes `(q) => log('question:pending', q)`, which
 * onEvent forwards straight onto that turn's SSE connection — see
 * playground.ts's own inline card for it) finds out immediately instead
 * of having to poll listQuestions(). It's a notification only, not a
 * routing key: the question is registered in the same shared
 * questionsById either way, so answerQuestion() works regardless of
 * whether anything was listening for onPending in the first place.
 *
 * Omitted entirely (a plain CLI run, or any caller with no live channel
 * of its own) falls back to a blocking terminal prompt instead of a
 * pending entry nothing could ever answer — same reasoning
 * ConsoleApprover exists for permission asks with nowhere else to go.
 *
 * Named `system_ask_user`, not the bare `ask_user` an agent author would
 * naturally reach for on their own — see system-tools/read_file.ts's own
 * doc comment on the same `system_` prefix for the full reasoning
 * (unlikely to collide by accident, and run-agent.ts's own
 * systemToolInstances gate bypass treats a same-named override as a
 * deliberate opt-out when one does happen). It matters even more here
 * than for read_file: this tool *is* a human's only way to answer the
 * agent in the first place, so it can never be gated at all without a
 * real deadlock, not just a redundant check — a name any other tool
 * could plausibly reach for by accident would risk silently losing that
 * guarantee, not just risk a surprising override. */
export function createAskUserTool(context: { agent: string; sessionId?: string }, onPending?: (question: PendingQuestion) => void): ToolDefinition {
  return {
    name: 'system_ask_user',
    description:
      "Ask the human operator a clarifying question before proceeding, when the request is genuinely ambiguous and guessing risks doing the wrong thing. Don't use this for things you can reasonably infer or look up yourself — only for real ambiguity a human actually needs to resolve. Optionally suggest a fixed set of answers; the human can still respond with free text regardless. Blocks until answered (or timed out).",
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask, in plain language.' },
        options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers to offer alongside free text.' },
      },
      required: ['question'],
    },
    execute: async (input) => {
      const question = String(input.question)
      const options = Array.isArray(input.options) ? input.options.map(String) : undefined

      if (!onPending) return promptOnConsole(question, options)

      const id = randomUUID()
      const entry: PendingQuestion = { id, question, options, agent: context.agent, sessionId: context.sessionId, requestedAt: new Date().toISOString() }
      return new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          questionsById.delete(id)
          resolve('(no answer — timed out)')
        }, DEFAULT_TIMEOUT_MS)
        questionsById.set(id, { entry, resolve, timer })
        onPending(entry)
      })
    },
  }
}

/** Oldest first, same ordering reasoning web-approver.ts's listApprovals
 * uses — whichever question has been waiting longest surfaces first.
 * Unfiltered (both omitted) returns every question pending anywhere in
 * this process — real uses (an operator's own admin view, say) should
 * filter, since that's every conversation's questions mixed together. */
export function listQuestions(filter?: { agent?: string; sessionId?: string }): PendingQuestion[] {
  return [...questionsById.values()]
    .map((p) => p.entry)
    .filter((q) => (!filter?.agent || q.agent === filter.agent) && (!filter?.sessionId || q.sessionId === filter.sessionId))
    .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
}

/** Peek at a pending question's own entry (its agent/sessionId, in
 * particular) without answering it — adapters/http.ts needs this *before*
 * calling answerQuestion() below, to know which turn's early-return race
 * (see its own sessionTurns) to resume once this one's answered. */
export function findQuestion(id: string): PendingQuestion | undefined {
  return questionsById.get(id)?.entry
}

/** Returns false for an unknown/already-answered/timed-out id, so the
 * caller can report that distinctly (a 404) instead of silently
 * no-opping — same convention web-approver.ts's decideApproval uses. */
export function answerQuestion(id: string, answer: string): boolean {
  const pending = questionsById.get(id)
  if (!pending) return false
  clearTimeout(pending.timer)
  questionsById.delete(id)
  pending.resolve(answer)
  return true
}
