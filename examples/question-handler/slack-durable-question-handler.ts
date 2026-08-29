// A DurableQuestionHandler backed by Slack — same "no built-in class
// exists, so this file implements the interface itself" reasoning as
// ../approver/slack-durable-approver.ts, and deliberately structured the
// same way (constructor shape, verifySlackSignature, the sending/
// receiving split). Read that file first if you haven't — this one only
// calls out what's actually *different* about a question versus an
// approval.
//
// The real difference: an approval is binary (two buttons cover it
// completely), a question is open-ended. This mirrors DURABLE_APPROVALS.md's
// own "Approve-with-edit" reasoning that a real UI needs more than
// buttons — suggested `options` (if the model gave any) still render as
// one-click buttons, but there's always also an "Other…" button that
// opens a Slack modal with a free-text input, since a human has to be
// able to answer something the model didn't anticipate.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DurableQuestionHandler } from '#core/agent-config.js'

// Fixed ids for the modal's own text input block — used both when
// *building* the modal (below) and when *reading* the human's answer back
// out of Slack's view_submission payload (further down); they have to
// match exactly, so they're named constants, not inlined twice.
const ANSWER_BLOCK_ID = 'answer_block'
const ANSWER_ACTION_ID = 'answer_input'

// --- Sending side ---

export class DurableSlackQuestionHandler implements DurableQuestionHandler {
  private readonly botToken: string
  private readonly channel: string

  constructor(options: { botToken: string; channel: string }) {
    this.botToken = options.botToken
    this.channel = options.channel
  }

  notifyPendingQuestion(question: string, options: string[] | undefined, agent: string, sessionId: string | undefined): { pendingId: string } {
    const pendingId = randomUUID()
    const optionButtons = (options ?? []).map((option) => ({
      type: 'button',
      text: { type: 'plain_text', text: option },
      // Both pendingId and the chosen answer have to survive the round
      // trip through Slack's own opaque `value` string — there's nowhere
      // else on a block_actions button to carry a second field.
      value: JSON.stringify({ pendingId, answer: option }),
      action_id: 'answer_option',
    }))

    fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        channel: this.channel,
        text: `Question from ${agent}: ${question}`,
        blocks: [
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*Question from ${agent}${sessionId ? ` (session ${sessionId})` : ''}:*\n${question}` },
          },
          {
            type: 'actions',
            elements: [
              ...optionButtons,
              { type: 'button', text: { type: 'plain_text', text: 'Other…' }, action_id: 'open_answer_modal', value: pendingId },
            ],
          },
        ],
      }),
    })
      .then((res) => res.json() as Promise<{ ok: boolean; error?: string }>)
      .then((body) => {
        if (!body.ok) console.error(`[loopengine] DurableSlackQuestionHandler: chat.postMessage failed for pendingId '${pendingId}':`, body.error)
      })
      .catch((err) => {
        console.error(`[loopengine] DurableSlackQuestionHandler: chat.postMessage failed for pendingId '${pendingId}':`, err)
      })
    return { pendingId }
  }
}

// --- Receiving side ---

/** Identical to slack-durable-approver.ts's own verifySlackSignature —
 * duplicated rather than imported so this file stays copy-pasteable on
 * its own, same reasoning webhook-durable-approver.ts/
 * webhook-durable-question-handler.ts already keep independent from each
 * other. */
function verifySlackSignature(rawBody: string, timestamp: string | undefined, signature: string | undefined, signingSecret: string): boolean {
  if (!timestamp || !signature) return false
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(age) || age > 60 * 5) return false
  const hmac = createHmac('sha256', signingSecret)
  hmac.update(`v0:${timestamp}:${rawBody}`)
  const expected = Buffer.from(`v0=${hmac.digest('hex')}`)
  const actual = Buffer.from(signature)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

async function answerQuestion(pendingId: string, answer: string, options: { loopengineBaseUrl: string; loopengineAdminAuth?: string }): Promise<void> {
  const authHeader: Record<string, string> = options.loopengineAdminAuth
    ? { authorization: `Basic ${Buffer.from(options.loopengineAdminAuth).toString('base64')}` }
    : {}
  const res = await fetch(`${options.loopengineBaseUrl}/pending-questions/${encodeURIComponent(pendingId)}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader },
    body: JSON.stringify({ answer }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(`DurableSlackQuestionHandler: answer failed: ${body.error ?? res.status}`)
  }
}

/** Call this from the same "Interactivity Request URL" route
 * slack-durable-approver.ts's own handleSlackApprovalInteraction is
 * wired to — Slack delivers every kind of interaction (button clicks,
 * modal submissions) to that one URL, dispatched here by `payload.type`.
 * `botToken` is needed here (unlike the approver's own receiving side)
 * specifically to open the modal — a `views.open` call, not just a
 * response to the click that triggered it. */
export async function handleSlackQuestionInteraction(
  rawBody: string,
  headers: { timestamp: string | undefined; signature: string | undefined },
  options: { botToken: string; signingSecret: string; loopengineBaseUrl: string; loopengineAdminAuth?: string },
): Promise<void> {
  if (!verifySlackSignature(rawBody, headers.timestamp, headers.signature, options.signingSecret)) {
    throw new Error('DurableSlackQuestionHandler: invalid Slack request signature')
  }

  const payloadRaw = new URLSearchParams(rawBody).get('payload')
  if (!payloadRaw) return
  const payload = JSON.parse(payloadRaw) as {
    type: 'block_actions' | 'view_submission'
    trigger_id?: string
    actions?: { action_id: string; value: string }[]
    view?: { private_metadata: string; state: { values: Record<string, Record<string, { value?: string }>> } }
  }

  if (payload.type === 'block_actions') {
    const action = payload.actions?.[0]
    if (!action) return

    if (action.action_id === 'answer_option') {
      const { pendingId, answer } = JSON.parse(action.value) as { pendingId: string; answer: string }
      await answerQuestion(pendingId, answer, options)
      return
    }

    if (action.action_id === 'open_answer_modal') {
      // Slack requires views.open to fire within the same short window
      // as the original interaction, using its one-time trigger_id — the
      // pendingId rides along as the modal's own private_metadata so the
      // *next* callback (view_submission, below) can recover it; nothing
      // else ties the two callbacks together.
      await fetch('https://slack.com/api/views.open', {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.botToken}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          trigger_id: payload.trigger_id,
          view: {
            type: 'modal',
            callback_id: 'answer_modal',
            private_metadata: action.value, // the pendingId, verbatim
            title: { type: 'plain_text', text: 'Your answer' },
            submit: { type: 'plain_text', text: 'Send' },
            blocks: [
              {
                type: 'input',
                block_id: ANSWER_BLOCK_ID,
                label: { type: 'plain_text', text: 'Answer' },
                element: { type: 'plain_text_input', action_id: ANSWER_ACTION_ID, multiline: true },
              },
            ],
          },
        }),
      })
      return
    }
    return
  }

  if (payload.type === 'view_submission' && payload.view) {
    const pendingId = payload.view.private_metadata
    const answer = payload.view.state.values[ANSWER_BLOCK_ID]?.[ANSWER_ACTION_ID]?.value ?? ''
    await answerQuestion(pendingId, answer, options)
  }
}

// --- Wiring both sides together, illustrative only ---
//
// Same request URL, same server, as slack-durable-approver.ts's own
// example — Slack doesn't distinguish "approval interactivity" from
// "question interactivity" at the transport level, only your own code
// (dispatching on action_id/callback_id) does:
//
// import { createServer } from 'node:http'
//
// const questionHandler = new DurableSlackQuestionHandler({ botToken: process.env.SLACK_BOT_TOKEN!, channel: process.env.SLACK_CHANNEL_ID! })
// // ... AgentConfig.questionHandlers = { http: questionHandler }
//
// createServer((req, res) => {
//   let body = ''
//   req.on('data', (chunk) => (body += chunk))
//   req.on('end', async () => {
//     try {
//       await handleSlackQuestionInteraction(
//         body,
//         { timestamp: req.headers['x-slack-request-timestamp'] as string, signature: req.headers['x-slack-signature'] as string },
//         {
//           botToken: process.env.SLACK_BOT_TOKEN!,
//           signingSecret: process.env.SLACK_SIGNING_SECRET!,
//           loopengineBaseUrl: 'http://localhost:8787',
//           loopengineAdminAuth: process.env.LOOPENGINE_ADMIN_AUTH,
//         },
//       )
//       res.writeHead(200).end()
//     } catch (err) {
//       res.writeHead(401).end(String(err))
//     }
//   })
// }).listen(3001)
