// A minimal chat component built on useLoopChat.ts — the piece that
// answers "okay, but what does an approval/question card actually look
// like in React." Renders pending as one of two card shapes depending on
// its own `type` discriminant, same narrowing the hook's own approve/
// deny/answer already rely on.
//
// Illustrative only — see useLoopChat.ts's own header comment for why
// this lives outside tsconfig.json's `include` globs.
import { useState } from 'react'
import { useLoopChat } from './useLoopChat.js'

export function ChatView({ baseUrl, agent }: { baseUrl: string; agent: string }) {
  const { messages, pending, isStreaming, error, send, approve, deny, answer } = useLoopChat({ baseUrl, agent })
  const [draft, setDraft] = useState('')

  function submit() {
    if (!draft.trim()) return
    send(draft)
    setDraft('')
  }

  return (
    <div className="chat">
      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            {m.text}
          </div>
        ))}

        {pending?.type === 'approval:pending' && (
          <ApprovalCard
            tool={pending.tool}
            args={pending.args}
            reason={pending.reason}
            onApprove={approve}
            onDeny={deny}
          />
        )}

        {pending?.type === 'question:pending' && (
          <QuestionCard question={pending.question} options={pending.options} onAnswer={answer} />
        )}

        {isStreaming && !pending && <div className="msg msg-thinking">…</div>}
        {error && <div className="msg msg-error">{error}</div>}
      </div>

      <div className="chat-input">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          disabled={isStreaming}
          placeholder="Message…"
        />
        <button onClick={submit} disabled={isStreaming || !draft.trim()}>
          Send
        </button>
      </div>
    </div>
  )
}

function ApprovalCard({
  tool,
  args,
  reason,
  onApprove,
  onDeny,
}: {
  tool: string
  args: Record<string, unknown>
  reason: string
  onApprove: () => void
  onDeny: () => void
}) {
  return (
    <div className="card card-approval">
      <div className="card-label">approval needed</div>
      <div className="card-tool">{tool}</div>
      <div className="card-reason">{reason}</div>
      <pre className="card-args">{JSON.stringify(args, null, 2)}</pre>
      <div className="card-actions">
        <button className="approve" onClick={onApprove}>
          Approve
        </button>
        <button className="deny" onClick={onDeny}>
          Deny
        </button>
      </div>
    </div>
  )
}

function QuestionCard({
  question,
  options,
  onAnswer,
}: {
  question: string
  options?: string[]
  onAnswer: (value: string) => void
}) {
  const [value, setValue] = useState('')

  return (
    <div className="card card-question">
      <div className="card-label">answer needed</div>
      <div className="card-question-text">{question}</div>
      {options && options.length > 0 && (
        <div className="card-options">
          {options.map((option) => (
            <button key={option} onClick={() => onAnswer(option)}>
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="card-answer-row">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onAnswer(value)}
          placeholder="Type an answer…"
        />
        <button onClick={() => onAnswer(value)}>Send</button>
      </div>
    </div>
  )
}
