// Vue composable built on client.ts — same shape as
// ui-examples/react/useLoopChat.ts, Vue idioms instead of React's: refs
// instead of useState, onUnmounted instead of a useEffect cleanup, plain
// closures instead of useCallback memoization (Vue's reactivity doesn't
// need it — a composable's functions aren't re-created on every render
// the way a component function's are).
//
// Illustrative only: this file lives outside tsconfig.json's own
// `include` globs (ui-examples/** isn't listed) so it isn't type-checked as
// part of this package's build, since 'vue' isn't a dependency here. In a
// real consumer app, everything below imports from the bare 'loopengine'
// package specifier — this package has no "exports" map, so index.ts is
// the one entry point every consumer (this composable included) imports
// through, same as run-agent/agent-config/etc. already do.
import { ref, onUnmounted, type Ref } from 'vue'
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
  messages: Ref<ChatMessage[]>
  /** Every LoopEvent this session has seen, raw — for a tool-call
   * timeline/debug pane, same idea as web/playground.ts's own one. */
  events: Ref<LoopEvent[]>
  /** The one thing (an 'ask' tool call or a system_ask_user question) the
   * agent is currently blocked on, if any — only one is ever pending at a
   * time (see run-agent.ts's own sequential gate loop). */
  pending: Ref<PendingItem | null>
  sessionId: Ref<string | null>
  isStreaming: Ref<boolean>
  error: Ref<string | null>
  send: (message: string) => void
  approve: () => void
  deny: () => void
  answer: (value: string) => void
}

export function useLoopChat(options: UseLoopChatOptions): UseLoopChat {
  const { baseUrl, agent, headers } = options
  const messages = ref([]) as Ref<ChatMessage[]>
  const events = ref([]) as Ref<LoopEvent[]>
  const pending = ref(null) as Ref<PendingItem | null>
  const sessionId = ref<string | null>(null)
  const isStreaming = ref(false)
  const error = ref<string | null>(null)
  let controller: AbortController | null = null

  onUnmounted(() => controller?.abort())

  function send(message: string) {
    if (isStreaming.value || !message.trim()) return
    messages.value.push({ role: 'user', text: message })
    error.value = null
    isStreaming.value = true

    controller = new AbortController()
    const thisController = controller

    ;(async () => {
      try {
        for await (const event of streamMessage(baseUrl, agent, message, {
          sessionId: sessionId.value ?? undefined,
          headers,
          signal: thisController.signal,
        })) {
          events.value.push(event)

          if (event.type === 'session') {
            sessionId.value = event.sessionId
          } else if (event.type === 'approval:pending' || event.type === 'question:pending') {
            pending.value = event
          } else {
            // Any other event means whatever was pending just got
            // decided — run-agent.ts only ever blocks on one 'ask' at a
            // time, so the next event in this same stream always means
            // that decision is behind us now.
            pending.value = null
          }

          if (event.type === 'done') {
            messages.value.push({ role: 'assistant', text: event.text })
            isStreaming.value = false
          } else if (event.type === 'error') {
            messages.value.push({ role: 'error', text: event.error })
            error.value = event.error
            isStreaming.value = false
          }
        }
      } catch (err) {
        if (thisController.signal.aborted) return
        const text = err instanceof Error ? err.message : String(err)
        error.value = text
        messages.value.push({ role: 'error', text })
        isStreaming.value = false
      }
    })()
  }

  // approve/deny/answer resolve over the plain REST routes — the events
  // they unblock keep arriving on the *same* already-open stream `send`
  // started, not on a new connection, so there's nothing else to wire up
  // here beyond telling the server the decision and clearing `pending`
  // optimistically (same as web/playground.ts's own decide()
  // disabling its buttons immediately rather than waiting for a live
  // event to confirm what the user just clicked).
  function approve() {
    if (!pending.value || pending.value.type !== 'approval:pending') return
    const id = pending.value.id
    pending.value = null
    approveCall(baseUrl, id, { headers }).catch((err) => {
      error.value = err instanceof Error ? err.message : String(err)
    })
  }

  function deny() {
    if (!pending.value || pending.value.type !== 'approval:pending') return
    const id = pending.value.id
    pending.value = null
    denyCall(baseUrl, id, { headers }).catch((err) => {
      error.value = err instanceof Error ? err.message : String(err)
    })
  }

  function answer(value: string) {
    if (!pending.value || pending.value.type !== 'question:pending' || !value.trim()) return
    const id = pending.value.id
    pending.value = null
    answerQuestion(baseUrl, id, value, { headers }).catch((err) => {
      error.value = err instanceof Error ? err.message : String(err)
    })
  }

  return { messages, events, pending, sessionId, isStreaming, error, send, approve, deny, answer }
}
