// The system ask_user tool (see this folder's own index.ts, and
// run-agent.ts's tools merge) — lets a model pause mid-turn and ask the
// human operator a genuinely ambiguous question instead of guessing, the
// same reasoning WebchatApprover exists for permission 'ask' decisions
// (web/web-approver.ts), just generalized from a fixed allow/deny to an open
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
// own doc comment, and web/web-approver.ts's createTrackedApprover for the
// same reasoning applied to approvals.
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import type { DurableQuestionHandler, LiveQuestionHandler, PendingQuestion, QuestionHandler, ToolDefinition } from '../agent-config.js'

// Re-exported for this module's own callers (system-tools/index.ts, and
// everything that imports it from there) — PendingQuestion is defined in
// agent-config.ts now, not here, purely to let LiveQuestionHandler/
// DurableQuestionHandler reference it without a circular import (this
// file already imports ToolDefinition from there); nothing about its
// meaning or shape changed.
export type { PendingQuestion } from '../agent-config.js'

interface PendingEntry {
  entry: PendingQuestion
  resolve: (answer: string) => void
  timer: ReturnType<typeof setTimeout>
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000

/** The live-side sibling of the webhook-backed `DurableQuestionHandler`
 * (`core/http-notify-triggers/webhook.ts`'s `WebhookNotifier`) — same
 * relationship actauth's own `WebchatApprover` has to `WebhookApprover`:
 * this one holds the actual `Promise` open and resolves it directly, no
 * webhook, no `pendingId` handed back to a durable resolve route. Named
 * to match `WebchatApprover`'s own shape (a `pending` map, `requestX()`,
 * `list()`, `decide()`) even though the underlying registration/timeout
 * logic already existed here before this class did — this just gives it
 * an instantiable, testable home instead of leaving it as bare
 * module-level state.
 *
 * One real, deliberate difference from `WebchatApprover`: `onPending` is
 * taken per-call (an argument to `requestQuestion`), not baked in at
 * construction. `WebchatApprover` gets a *fresh instance per turn* precisely
 * so each one's constructor-time `onPending` can target that turn's own
 * SSE connection (see web/web-approver.ts's createTrackedApprover) — but
 * a question only ever needs *one* registry, unlike approvals (see the
 * default instance below): `onPending` here is just an optional extra
 * notification layered on top of registration, not a routing key, so
 * every question is answerable via `decide()`/`list()` on this same
 * instance regardless of whether anything was listening for `onPending`
 * when it was raised. A caller that genuinely wants per-turn isolation
 * (its own registry, not sharing the default one) can still construct
 * its own `WebchatQuestionHandler` instance directly. */
export class WebchatQuestionHandler implements LiveQuestionHandler {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly timeoutMs: number

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Registers a pending question and returns a Promise that resolves
   * once `decide()` is called with its id (or the timeout sentinel, if
   * nobody does). `onPending`, when given, fires synchronously with the
   * full entry — see this class's own doc comment for why that's a
   * per-call argument, not a constructor option. */
  requestQuestion(question: string, options: string[] | undefined, agent: string, sessionId: string | undefined, onPending?: (question: PendingQuestion) => void): Promise<string> {
    const id = randomUUID()
    const entry: PendingQuestion = { id, question, options, agent, sessionId, requestedAt: new Date().toISOString() }
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve('(no answer — timed out)')
      }, this.timeoutMs)
      this.pending.set(id, { entry, resolve, timer })
      onPending?.(entry)
    })
  }

  /** Oldest first, same ordering reasoning web/web-approver.ts's
   * listApprovals uses. Unfiltered (both omitted) returns every question
   * pending on this instance — real uses (an operator's own admin view,
   * say) should filter, since that's every conversation's questions
   * mixed together. */
  list(filter?: { agent?: string; sessionId?: string }): PendingQuestion[] {
    return [...this.pending.values()]
      .map((p) => p.entry)
      .filter((q) => (!filter?.agent || q.agent === filter.agent) && (!filter?.sessionId || q.sessionId === filter.sessionId))
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
  }

  /** Peek at a pending question's own entry without answering it — same
   * "look before you decide" reasoning web/web-approver.ts's findApproval
   * exists for. */
  find(id: string): PendingQuestion | undefined {
    return this.pending.get(id)?.entry
  }

  /** Returns false for an unknown/already-answered/timed-out id, so the
   * caller can report that distinctly (a 404) instead of silently
   * no-opping — same convention web/web-approver.ts's decideApproval
   * uses. */
  decide(id: string, answer: string): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(id)
    entry.resolve(answer)
    return true
  }
}

// One shared, global instance — unlike WebchatApprover's pending approvals
// (split across a shared instance and a fresh one per streamed turn),
// createAskUserTool below always registers into this same one regardless
// of which call raised it, so every question is always answerable via
// the module-level listQuestions()/answerQuestion()/findQuestion()
// functions below, whether it came from a streamed turn, the plain
// route's fallback, or anywhere else — see WebchatQuestionHandler's own doc
// comment for the full reasoning.
const defaultQuestionHandler = new WebchatQuestionHandler()

/** The cli-channel default — blocks on the terminal it's already attached
 * to, same fallback actauth's own `ConsoleApprover` is for a permission
 * ask with nowhere else to go. Unlike `WebchatQuestionHandler`, this needs
 * no `pending` map, no `list()`/`decide()`: nothing outside this one call
 * ever answers it — the terminal that asked is the terminal that
 * answers, synchronously, in the same `rl.question()`. `agent`/
 * `sessionId`/`onPending` are accepted (not just `question`/`options`)
 * purely so this has the same call shape `WebchatQuestionHandler.requestQuestion`
 * does — a caller (createAskUserTool below) doesn't need to know which
 * kind of questionHandler it's holding, it just calls `requestQuestion` either
 * way — but none of the three do anything here: there's no registry to
 * tag with `agent`/`sessionId`, and no separate channel to push
 * `onPending` onto besides the prompt itself. */
export class CliQuestionHandler implements LiveQuestionHandler {
  async requestQuestion(question: string, options: string[] | undefined): Promise<string> {
    console.log(`\n[ask_user] ${question}`)
    if (options?.length) console.log(`  options: ${options.join(', ')}`)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return (await rl.question('> ')).trim()
    } finally {
      rl.close()
    }
  }
}

// The two live-channel defaults — cli gets a blocking prompt, http/
// http_stream share one live registry — both single, shared instances
// for the same reason defaultQuestionHandler above is: neither needs
// per-turn isolation the way WebchatApprover's fresh-instance-per-turn does
// (see WebchatQuestionHandler's own doc comment).
const defaultCliQuestionHandler = new CliQuestionHandler()

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
 * routing key: the question is registered on the same shared
 * WebchatQuestionHandler instance either way, so answerQuestion() works
 * regardless of whether anything was listening for onPending in the
 * first place.
 *
 * Omitted entirely (a plain CLI run, or any caller with no live channel
 * of its own) falls back to CliQuestionHandler's blocking terminal
 * prompt instead of a pending entry nothing could ever answer — same
 * reasoning ConsoleApprover exists for permission asks with nowhere else
 * to go. adapters/cli.ts passing `channel: 'cli'` but no `onQuestionPending`
 * is exactly this case — the cli channel's real default, in other words,
 * even though nothing threads `options.channel` through to this
 * function directly (it doesn't need to: the *presence* of `onPending`
 * already is that signal, one level up in run-agent.ts's own
 * RunAgentOptions.onQuestionPending doc comment).
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

      if (!onPending) return defaultCliQuestionHandler.requestQuestion(question, options)

      return defaultQuestionHandler.requestQuestion(question, options, context.agent, context.sessionId, onPending)
    },
  }
}

/** Thin wrapper over the default WebchatQuestionHandler's own list() — see
 * that class's own doc comment for why one shared instance, not a fresh
 * one per call, is the right default for questions. */
export function listQuestions(filter?: { agent?: string; sessionId?: string }): PendingQuestion[] {
  return defaultQuestionHandler.list(filter)
}

/** Peek at a pending question's own entry (its agent/sessionId, in
 * particular) without answering it — adapters/http.ts needs this *before*
 * calling answerQuestion() below, to know which turn's early-return race
 * (see its own sessionTurns) to resume once this one's answered. */
export function findQuestion(id: string): PendingQuestion | undefined {
  return defaultQuestionHandler.find(id)
}

/** Thin wrapper over the default WebchatQuestionHandler's own decide(). */
export function answerQuestion(id: string, answer: string): boolean {
  return defaultQuestionHandler.decide(id, answer)
}

/** Duck-types on the one method DurableQuestionHandler actually needs —
 * same "no eval, just an explicit structural check" spirit as actauth's
 * own isDurableApprover, which this mirrors: run-agent.ts's loop calls
 * this on the resolved QuestionHandler (see RunAgentOptions.questionHandler's
 * own doc comment) to decide which branch a system_ask_user call takes,
 * the same way Gate uses isDurableApprover to decide which branch a
 * gated tool call takes. */
export function isDurableQuestionHandler(questionHandler: QuestionHandler): questionHandler is DurableQuestionHandler {
  return typeof (questionHandler as DurableQuestionHandler).notifyPendingQuestion === 'function'
}

// The webhook-backed DurableQuestionHandler that used to live here
// (WebhookQuestionHandler) moved to core/http-notify-triggers/webhook.ts's
// WebhookNotifier — merged with the approval-sending side that used to
// be actauth's own WebhookApprover, since sending a signed webhook POST
// was never actually approval-specific or question-specific, just
// under a different header. See that file's own header comment for the
// full reasoning.
