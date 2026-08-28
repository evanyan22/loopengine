// A framework-agnostic browser client for adapters/http.ts's wire protocol
// — the same POST /agents/:name/messages(/stream), /approvals/:id/
// approve|deny, /questions/:id/answer, and /agents/:name/sessions/:id
// routes web/playground.ts's own inline chat script already speaks,
// extracted here as a standalone module with no DOM or UI-framework
// dependency (only fetch/ReadableStream/TextDecoder, available in every
// modern browser and in Node 18+). web/playground.ts is one UI on
// top of this protocol; this module is what makes building a *different*
// one (a React hook, a Vue composable, anything else) a matter of calling
// these functions and feeding the typed LoopEvent objects they produce
// into that framework's own state, rather than re-deriving SSE frame
// parsing and the approval/question REST calls from scratch.
//
// Kept in sync with web/playground.ts's own script by hand, the same
// way that inline script and adapters/http.ts already are — there's no
// build step connecting the two, so a wire-format change to either still
// needs updating both.
import type { LoopEvent } from './loop-events.js'
import type { Message } from './run-agent.js'

export interface RequestOptions {
  /** Resumes an existing conversation — omit for a fresh one; see
   * adapters/http.ts's own sessionIdFor for how the server derives one
   * when omitted. */
  sessionId?: string
  /** Extra headers on top of 'content-type: application/json' — e.g. HTTP
   * Basic Auth (LOOPENGINE_ADMIN_AUTH) or an AgentConfig.tenantFor header. */
  headers?: Record<string, string>
  /** Merged into the request body alongside `message`/`sessionId` — for an
   * AgentConfig with its own sessionIdFor/tenantFor reading extra fields
   * (see adapters/http.ts's own resolveTenant). */
  body?: Record<string, unknown>
  signal?: AbortSignal
}

/** POST /agents/:name/messages's own 200 response — the turn finished,
 * genuinely or via a synthetic stopReason (see loop-events.ts's own
 * DoneEvent). `events` is every LoopEvent this turn produced, start to
 * finish — the same array a streamed turn delivers frame-by-frame. */
export interface SendMessageResult {
  text: string
  sessionId: string
  events: LoopEvent[]
  stopReason?: 'max_turns' | 'denied'
}

interface PendingResultBase {
  pending: true
  id: string
  sessionId: string
  events: LoopEvent[]
  /** GET this to rehydrate the conversation (and re-discover this same
   * pending item) if the caller navigates away before deciding it. */
  statusUrl: string
}

/** POST /agents/:name/messages's own 202 response when the turn needs a
 * human 'ask' decision before it can continue — resolve it with
 * approveCall/denyCall below, both of which return this same
 * MessageResult union, so a caller can treat approve/deny/answer and the
 * original send as one uniform decide-or-finish loop. */
export interface PendingApprovalResult extends PendingResultBase {
  type: 'approval'
  tool: string
  args: Record<string, unknown>
  scope: { tenant: string; environment: string; agent: string }
  reason: string
  approveUrl: string
  denyUrl: string
}

/** Same as PendingApprovalResult, for the system ask_user tool's own
 * open-ended question instead of a fixed allow/deny — resolve with
 * answerQuestion below. */
export interface PendingQuestionResult extends PendingResultBase {
  type: 'question'
  question: string
  options?: string[]
  answerUrl: string
}

export type PendingResult = PendingApprovalResult | PendingQuestionResult
export type MessageResult = SendMessageResult | PendingResult

async function postJson<T>(url: string, body: unknown, options: RequestOptions = {}): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(body),
    signal: options.signal,
  })
  const parsed = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string }
  if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`)
  return parsed as T
}

function messageBody(message: string, options: RequestOptions): Record<string, unknown> {
  return { message, ...(options.sessionId ? { sessionId: options.sessionId } : {}), ...options.body }
}

/** The non-streaming half of the protocol — one request, one response,
 * either done (SendMessageResult) or needing a decision (PendingResult).
 * Reach for this over streamMessage() when the caller doesn't need live,
 * frame-by-frame updates (a bot integration, a batch job, a callback-
 * style webhook handler) — same underlying turn, same event vocabulary in
 * `events`, just delivered all at once instead of incrementally. */
export function sendMessage(baseUrl: string, agent: string, message: string, options: RequestOptions = {}): Promise<MessageResult> {
  return postJson<MessageResult>(`${baseUrl}/agents/${encodeURIComponent(agent)}/messages`, messageBody(message, options), options)
}

export function approveCall(baseUrl: string, id: string, options: RequestOptions = {}): Promise<MessageResult> {
  return postJson<MessageResult>(`${baseUrl}/approvals/${encodeURIComponent(id)}/approve`, undefined, options)
}

export function denyCall(baseUrl: string, id: string, options: RequestOptions = {}): Promise<MessageResult> {
  return postJson<MessageResult>(`${baseUrl}/approvals/${encodeURIComponent(id)}/deny`, undefined, options)
}

export function answerQuestion(baseUrl: string, id: string, answer: string, options: RequestOptions = {}): Promise<MessageResult> {
  return postJson<MessageResult>(`${baseUrl}/questions/${encodeURIComponent(id)}/answer`, { answer }, options)
}

/** GET /agents/:name/sessions/:id — rehydrates a conversation's stored
 * history, e.g. after a page reload lost whatever in-memory state a React/
 * Vue app was holding (mirrors web/playground.ts's own resumeSession). */
export async function getSessionHistory(
  baseUrl: string,
  agent: string,
  sessionId: string,
  options: Pick<RequestOptions, 'headers' | 'signal'> = {},
): Promise<{ sessionId: string; history: Message[] }> {
  const res = await fetch(`${baseUrl}/agents/${encodeURIComponent(agent)}/sessions/${encodeURIComponent(sessionId)}`, {
    headers: options.headers,
    signal: options.signal,
  })
  const body = (await res.json()) as { sessionId: string; history: Message[]; error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

function parseSseFrame(frame: string): LoopEvent | undefined {
  let dataLine = ''
  for (const line of frame.split('\n')) {
    if (line.startsWith('data: ')) dataLine = line.slice('data: '.length)
  }
  if (!dataLine) return undefined
  try {
    return JSON.parse(dataLine) as LoopEvent
  } catch {
    return undefined
  }
}

/** The streaming half of the protocol — an async generator yielding one
 * LoopEvent per SSE frame as it arrives, always starting with `session`
 * and ending with `done` or `error` (see loop-events.ts's own header
 * comment). `for await` is the natural fit for a React effect or Vue
 * composable driving off this directly:
 *
 *   for await (const event of streamMessage(baseUrl, agent, text, { signal })) {
 *     setEvents((prev) => [...prev, event])
 *     if (event.type === 'done' || event.type === 'error') break
 *   }
 *
 * Pass an AbortController's signal to let the caller cancel mid-stream
 * (a React effect's own cleanup, a Vue component's onUnmounted) — the
 * underlying fetch is aborted and the generator simply stops yielding,
 * same as any other AbortSignal-aware fetch call.
 */
export async function* streamMessage(
  baseUrl: string,
  agent: string,
  message: string,
  options: RequestOptions = {},
): AsyncGenerator<LoopEvent, void, void> {
  const res = await fetch(`${baseUrl}/agents/${encodeURIComponent(agent)}/messages/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...options.headers },
    body: JSON.stringify(messageBody(message, options)),
    signal: options.signal,
  })

  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream')) {
    const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as { error?: string }
    yield { type: 'error', error: body.error ?? `HTTP ${res.status}` }
    return
  }
  if (!res.body) return

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      const event = parseSseFrame(frame)
      if (event) yield event
    }
  }
}

export interface StreamMessageCallbacks {
  onEvent?: (event: LoopEvent) => void
  onDone?: (event: Extract<LoopEvent, { type: 'done' }>) => void
  onError?: (event: Extract<LoopEvent, { type: 'error' }>) => void
}

/** Callback-flavored wrapper over streamMessage() for a caller that would
 * rather pass handlers into a `useEffect`/lifecycle hook than manage a
 * `for await` loop and its own break condition by hand. Resolves once the
 * stream ends (a 'done'/'error' event, or the connection just closing). */
export async function streamMessageWithCallbacks(
  baseUrl: string,
  agent: string,
  message: string,
  options: RequestOptions,
  callbacks: StreamMessageCallbacks,
): Promise<void> {
  for await (const event of streamMessage(baseUrl, agent, message, options)) {
    callbacks.onEvent?.(event)
    if (event.type === 'done') callbacks.onDone?.(event)
    else if (event.type === 'error') callbacks.onError?.(event)
  }
}
