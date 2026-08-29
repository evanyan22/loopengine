// Reference usage for DurableWebQuestionHandler — the question-side
// sibling of ../approver/webhook-durable-approver.ts. Lives in its own
// examples/question-handler/ folder, not examples/approver/: DurableWebQuestionHandler
// isn't an actauth Approver at all (system_ask_user never goes through
// actauth's Gate — see DURABLE_APPROVALS.md's "Durable questions"
// section), and unlike webhook-durable-approver.ts's sending side (which
// just wraps actauth's own DurableWebApprover), this one wraps a class
// that lives in loopengine itself. What's actually missing, and what
// this file is for, is the RECEIVING end: verifying the signed payload
// the webhook posts — always something the host owns, never loopengine
// itself.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { DurableWebQuestionHandler } from '#core/system-tools/index.js'

// --- Sending side: loopengine's own class, wired to your agent's webhook ---

export function createExampleWebhookQuestionHandler(): DurableWebQuestionHandler {
  const webhookUrl = process.env.MY_QUESTION_WEBHOOK_URL
  const signingSecret = process.env.MY_QUESTION_WEBHOOK_SECRET
  if (!webhookUrl || !signingSecret) {
    throw new Error('MY_QUESTION_WEBHOOK_URL and MY_QUESTION_WEBHOOK_SECRET must both be set')
  }
  return new DurableWebQuestionHandler({ webhookUrl, signingSecret })
}

// --- Receiving side: verify + parse what DurableWebQuestionHandler posts ---

export interface WebhookQuestionPayload {
  pendingId: string
  question: string
  options?: string[]
  agent: string
  sessionId?: string
  requestedAt: string
}

/** Verifies the X-Loopengine-Signature header against the raw request
 * body — must be the exact, unparsed bytes; signing is over the raw
 * body, same reasoning webhook-durable-approver.ts's own
 * verifyWebhookApproval uses for actauth's signature — and returns the
 * parsed payload, or null if the signature doesn't check out. */
export function verifyWebhookQuestion(
  rawBody: string,
  signatureHeader: string | undefined,
  signingSecret: string,
): WebhookQuestionPayload | null {
  if (!signatureHeader) return null

  const hmac = createHmac('sha256', signingSecret)
  hmac.update(rawBody)
  const expected = Buffer.from(`sha256=${hmac.digest('hex')}`)
  const actual = Buffer.from(signatureHeader)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null

  return JSON.parse(rawBody) as WebhookQuestionPayload
}

// --- Wiring both sides together, illustrative only (plain node:http,
// same no-framework style adapters/http.ts itself uses) ---
//
// import { createServer } from 'node:http'
//
// createServer((req, res) => {
//   let body = ''
//   req.on('data', (chunk) => (body += chunk))
//   req.on('end', () => {
//     const payload = verifyWebhookQuestion(body, req.headers['x-loopengine-signature'] as string | undefined, signingSecret)
//     if (!payload) {
//       res.writeHead(401).end()
//       return
//     }
//     // Render payload.question/options however you like (Slack, email,
//     // an admin queue row) — then, once a human answers:
//     // POST /pending-questions/${payload.pendingId}/answer
//     // { "answer": "..." }
//     res.writeHead(200).end()
//   })
// }).listen(3000)
