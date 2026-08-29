// A DurableQuestionHandler backed by Lark/Feishu — same relationship to
// ./slack-durable-question-handler.ts that ../approver/lark-durable-approver.ts
// has to ../approver/slack-durable-approver.ts: same shape, same
// sending/receiving split, only the platform-specific mechanics differ.
// Read lark-durable-approver.ts first — this file reuses its
// getTenantAccessToken/verifyLarkToken pattern (duplicated, not
// imported, same "stays copy-pasteable on its own" reasoning every other
// example in these two folders already follows) and only calls out what's
// different about an open-ended question.
//
// The free-text answer is the one genuinely tricky part, and worth being
// honest about: Slack's own answer (a modal, opened via views.open, a
// completely separate API call keyed off a one-time trigger_id) has no
// direct Lark equivalent used here. Two real options exist for Lark:
//   1. A "form" card (an `input` element inside an `action`/`form`
//      container, submitted as one callback with all field values
//      together) — what this file uses. Lower confidence: Lark's card
//      schema has changed across versions, so verify the exact
//      `tag`/field names below against https://open.feishu.cn/document
//      for your app's configured card version before relying on this.
//   2. Ask the human to reply in-thread and capture it via the
//      `im.message.receive_v1` event, matching the reply's `parent_id`
//      against the original message's own `message_id`. More certain to
//      work API-wise, but needs your own durable message_id -> pendingId
//      mapping (an in-memory Map is NOT enough if sending and receiving
//      ever run in different processes) — deliberately not the approach
//      used here, to avoid smuggling that extra storage requirement into
//      what's meant to be a minimal reference example.
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { DurableQuestionHandler } from '#core/agent-config.js'

// Fixed ids for the form card's own input field — used both when
// *building* the card (below) and when *reading* the human's answer back
// out of the callback payload (further down); must match exactly.
const ANSWER_FIELD_TAG = 'answer_input'

let cachedToken: { token: string; expiresAt: number } | undefined

async function getTenantAccessToken(appId: string, appSecret: string): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.token
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  const body = (await res.json()) as { code: number; msg: string; tenant_access_token: string; expire: number }
  if (body.code !== 0) throw new Error(`getTenantAccessToken failed: ${body.msg}`)
  cachedToken = { token: body.tenant_access_token, expiresAt: Date.now() + body.expire * 1000 }
  return cachedToken.token
}

// --- Sending side ---

export class DurableLarkQuestionHandler implements DurableQuestionHandler {
  private readonly appId: string
  private readonly appSecret: string
  private readonly chatId: string

  constructor(options: { appId: string; appSecret: string; chatId: string }) {
    this.appId = options.appId
    this.appSecret = options.appSecret
    this.chatId = options.chatId
  }

  notifyPendingQuestion(question: string, options: string[] | undefined, agent: string, sessionId: string | undefined): { pendingId: string } {
    const pendingId = randomUUID()
    const optionButtons = (options ?? []).map((option) => ({
      tag: 'button',
      text: { tag: 'plain_text', content: option },
      value: { pendingId, answer: option },
    }))

    void (async () => {
      try {
        const token = await getTenantAccessToken(this.appId, this.appSecret)
        const card = {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `Question from ${agent}` } },
          elements: [
            { tag: 'div', text: { tag: 'lark_md', content: question + (sessionId ? `\n_(session ${sessionId})_` : '') } },
            ...(optionButtons.length ? [{ tag: 'action', actions: optionButtons }] : []),
            {
              tag: 'form',
              name: 'answer_form',
              elements: [
                { tag: 'input', name: ANSWER_FIELD_TAG, placeholder: { tag: 'plain_text', content: 'Or type your own answer…' } },
                {
                  tag: 'action',
                  actions: [{ tag: 'button', text: { tag: 'plain_text', content: 'Send' }, type: 'primary', action_type: 'form_submit', value: { pendingId } }],
                },
              ],
            },
          ],
        }
        const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ receive_id: this.chatId, msg_type: 'interactive', content: JSON.stringify(card) }),
        })
        const body = (await res.json()) as { code: number; msg: string }
        if (body.code !== 0) console.error(`[loopengine] DurableLarkQuestionHandler: send message failed for pendingId '${pendingId}':`, body.msg)
      } catch (err) {
        console.error(`[loopengine] DurableLarkQuestionHandler: send message failed for pendingId '${pendingId}':`, err)
      }
    })()
    return { pendingId }
  }
}

// --- Receiving side ---

/** Identical to lark-durable-approver.ts's own verifyLarkToken —
 * duplicated for the same "copy-pasteable on its own" reasoning noted
 * throughout this pair of folders. */
function verifyLarkToken(token: string | undefined, verificationToken: string): boolean {
  if (!token) return false
  const expected = Buffer.from(verificationToken)
  const actual = Buffer.from(token)
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
    throw new Error(`DurableLarkQuestionHandler: answer failed: ${body.error ?? res.status}`)
  }
}

/** Call this from the same card-callback/event route
 * lark-durable-approver.ts's own handleLarkApprovalInteraction is wired
 * to — dispatched here by whether the payload carries a plain button
 * `action.value` (an option click) or a `form_value` (the free-text form
 * submitted). Same `url_verification` handshake handling as the approver
 * side; see that file's own doc comment for why. */
export async function handleLarkQuestionInteraction(
  body: {
    type?: 'url_verification'
    challenge?: string
    token?: string
    action?: { value?: { pendingId: string; answer?: string } }
    form_value?: Record<string, string>
  },
  options: { verificationToken: string; loopengineBaseUrl: string; loopengineAdminAuth?: string },
): Promise<Record<string, unknown>> {
  if (body.type === 'url_verification') return { challenge: body.challenge }

  if (!verifyLarkToken(body.token, options.verificationToken)) {
    throw new Error('DurableLarkQuestionHandler: invalid Lark verification token')
  }

  const value = body.action?.value
  if (!value) return {}

  // Option button: the answer already rode along in the button's own
  // value. Form submit: the pendingId came from the submit button's
  // value, the typed text is a sibling field keyed by the input's own
  // `name` (ANSWER_FIELD_TAG) — see this file's own header comment for
  // why the form's exact field names need checking against your card
  // version.
  const answer = value.answer ?? body.form_value?.[ANSWER_FIELD_TAG] ?? ''
  await answerQuestion(value.pendingId, answer, options)

  return { toast: { type: 'success', content: 'Answer received.' } }
}

// --- Wiring both sides together, illustrative only ---
//
// Same request URL, same server, as lark-durable-approver.ts's own
// example — dispatch on whether the parsed body looks like an approval
// action or a question action (e.g. by including a small discriminator
// in the button's own `value`, or routing by chat/message context) is
// your own code's job, same as Slack's own action_id dispatch:
//
// import { createServer } from 'node:http'
//
// const questionHandler = new DurableLarkQuestionHandler({ appId: process.env.LARK_APP_ID!, appSecret: process.env.LARK_APP_SECRET!, chatId: process.env.LARK_CHAT_ID! })
// // ... AgentConfig.questionHandlers = { http: questionHandler }
//
// createServer((req, res) => {
//   let raw = ''
//   req.on('data', (chunk) => (raw += chunk))
//   req.on('end', async () => {
//     try {
//       const responseBody = await handleLarkQuestionInteraction(JSON.parse(raw), {
//         verificationToken: process.env.LARK_VERIFICATION_TOKEN!,
//         loopengineBaseUrl: 'http://localhost:8787',
//         loopengineAdminAuth: process.env.LOOPENGINE_ADMIN_AUTH,
//       })
//       res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(responseBody))
//     } catch (err) {
//       res.writeHead(401).end(String(err))
//     }
//   })
// }).listen(3002)
