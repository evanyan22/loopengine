// Sketch of a React hook built on top of client.ts — proves out the claim
// that a different UI (React here, but the same shape works for a Vue
// composable) just calls the framework-agnostic functions in client.ts
// and feeds the typed LoopEvent objects into its own state, instead of
// re-deriving SSE parsing or the approval/question REST calls.
//
// Illustrative only: this file lives outside tsconfig.json's own
// `include` globs (examples/** isn't listed) so it isn't type-checked as
// part of this package's build, since 'react' isn't a dependency here. In
// a real consumer app, everything below imports from the bare 'loopengine'
// package specifier — this package has no "exports" map, so index.ts is
// the one entry point every consumer (this hook included) imports
// through, same as run-agent/agent-config/etc. already do.
import { useCallback, useEffect, useRef, useState } from 'react'
import { streamMessage, approveCall, denyCall, answerQuestion, type LoopEvent } from 'loopengine'

export interface ChatMessage {
  role: 'user' | 'assistant' | 'error'
  text: string
}

export interface UseLoopChatOptions {
  baseUrl: string
  agent: string
  headers?: Record<string, string>
}

// The stream's own approval:pending/question:pending events — not
// client.ts's PendingResult (that's the plain, non-streaming route's JSON
// shape: {pending: true, type: 'approval'|'question', events, statusUrl,
// ...}). A streaming consumer tracks pending state off the live event
// itself, which already carries everything needed (id, tool/question,
// args/options, ...) — no need for the extra bookkeeping fields
// PendingResult carries for a caller with no open connection of its own.
type PendingApprovalEvent = Extract<LoopEvent, { type: 'approval:pending' }>
type PendingQuestionEvent = Extract<LoopEvent, { type: 'question:pending' }>
type PendingItem = PendingApprovalEvent | PendingQuestionEvent

export interface UseLoopChat {
  messages: ChatMessage[]
  /** Every LoopEvent this session has seen, raw — for a tool-call
   * timeline/debug pane, same idea as web/playground.ts's own one. */
  events: LoopEvent[]
  /** The one thing (an 'ask' tool call or a system_ask_user question) the
   * agent is currently blocked on, if any — only one is ever pending at a
   * time (see run-agent.ts's own sequential gate loop). */
  pending: PendingItem | null
  sessionId: string | null
  isStreaming: boolean
  error: string | null
  send: (message: string) => void
  approve: () => void
  deny: () => void
  answer: (value: string) => void
}

export function useLoopChat({ baseUrl, agent, headers }: UseLoopChatOptions): UseLoopChat {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [events, setEvents] = useState<LoopEvent[]>([])
  const [pending, setPending] = useState<PendingItem | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const send = useCallback(
    (message: string) => {
      if (isStreaming || !message.trim()) return
      setMessages((prev) => [...prev, { role: 'user', text: message }])
      setError(null)
      setIsStreaming(true)

      const controller = new AbortController()
      abortRef.current = controller

      ;(async () => {
        try {
          for await (const event of streamMessage(baseUrl, agent, message, {
            sessionId: sessionId ?? undefined,
            headers,
            signal: controller.signal,
          })) {
            setEvents((prev) => [...prev, event])

            if (event.type === 'session') {
              setSessionId(event.sessionId)
            } else if (event.type === 'approval:pending' || event.type === 'question:pending') {
              setPending(event)
            } else {
              // Any other event means whatever was pending just got
              // decided — run-agent.ts only ever blocks on one 'ask' at a
              // time, so the next event in this same stream always means
              // that decision is behind us now.
              setPending(null)
            }

            if (event.type === 'done') {
              setMessages((prev) => [...prev, { role: 'assistant', text: event.text }])
              setIsStreaming(false)
            } else if (event.type === 'error') {
              setMessages((prev) => [...prev, { role: 'error', text: event.error }])
              setError(event.error)
              setIsStreaming(false)
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return
          const text = err instanceof Error ? err.message : String(err)
          setError(text)
          setMessages((prev) => [...prev, { role: 'error', text }])
          setIsStreaming(false)
        }
      })()
    },
    [baseUrl, agent, headers, sessionId, isStreaming],
  )

  // approve/deny/answer resolve over the plain REST routes — the events
  // they unblock keep arriving on the *same* already-open stream `send`
  // started, not on a new connection, so there's nothing else to wire up
  // here beyond telling the server the decision and clearing `pending`
  // optimistically (same as web/playground.ts's own decide()
  // disabling its buttons immediately rather than waiting for a live
  // event to confirm what the user just clicked).
  const approve = useCallback(() => {
    if (!pending || pending.type !== 'approval:pending') return
    const id = pending.id
    setPending(null)
    approveCall(baseUrl, id, { headers }).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [pending, baseUrl, headers])

  const deny = useCallback(() => {
    if (!pending || pending.type !== 'approval:pending') return
    const id = pending.id
    setPending(null)
    denyCall(baseUrl, id, { headers }).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [pending, baseUrl, headers])

  const answer = useCallback(
    (value: string) => {
      if (!pending || pending.type !== 'question:pending' || !value.trim()) return
      const id = pending.id
      setPending(null)
      answerQuestion(baseUrl, id, value, { headers }).catch((err) => setError(err instanceof Error ? err.message : String(err)))
    },
    [pending, baseUrl, headers],
  )

  return { messages, events, pending, sessionId, isStreaming, error, send, approve, deny, answer }
}
