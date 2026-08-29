// Reference usage for the one DurableApprover that actually ships in
// actauth: DurableWebApprover. Unlike database-durable-approver.ts /
// redis-durable-approver.ts (which implement DurableApprover themselves,
// since no built-in class exists for those channels), this file doesn't
// reimplement anything on the sending side — DurableWebApprover already
// does that. What's actually missing, and what this file is for, is the
// RECEIVING end: verifying the signed payload the webhook posts. That
// route is always something the host owns, never actauth (see
// DurableApprover's own doc comment on why "what happens next" stays
// outside the package) — nothing in this repo demonstrated it until now.
import { createHmac, timingSafeEqual } from 'node:crypto'
import { DurableWebApprover } from 'actauth'
import type { Scope } from 'actauth'

// --- Sending side: actauth's own class, wired to your agent's webhook ---

export function createExampleWebhookApprover(): DurableWebApprover {
  const webhookUrl = process.env.MY_APPROVAL_WEBHOOK_URL
  const signingSecret = process.env.MY_APPROVAL_WEBHOOK_SECRET
  if (!webhookUrl || !signingSecret) {
    throw new Error('MY_APPROVAL_WEBHOOK_URL and MY_APPROVAL_WEBHOOK_SECRET must both be set')
  }
  return new DurableWebApprover({ webhookUrl, signingSecret })
}

// --- Receiving side: verify + parse what DurableWebApprover posts ---

export interface WebhookApprovalPayload {
  pendingId: string
  tool: string
  args: Record<string, unknown>
  scope: Scope
  reason: string
  requestedAt: string
}

/** Verifies the X-Actauth-Signature header against the raw request
 * body — must be the exact, unparsed bytes; signing is over the raw
 * body, the same reason actauth's own SlackApprover.verifySignature
 * works this way for its inbound signature check — and returns the
 * parsed payload, or null if the signature doesn't check out (wrong
 * secret, tampered body, missing header). Constant-time comparison,
 * same reasoning as every other signature check in this codebase: a
 * length mismatch alone isn't sensitive enough to need one, so it's
 * checked first and short-circuits before the timing-safe compare. */
export function verifyWebhookApproval(
  rawBody: string,
  signatureHeader: string | undefined,
  signingSecret: string,
): WebhookApprovalPayload | null {
  if (!signatureHeader) return null

  const hmac = createHmac('sha256', signingSecret)
  hmac.update(rawBody)
  const expected = Buffer.from(`sha256=${hmac.digest('hex')}`)
  const actual = Buffer.from(signatureHeader)
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null

  return JSON.parse(rawBody) as WebhookApprovalPayload
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
//     const payload = verifyWebhookApproval(body, req.headers['x-actauth-signature'] as string | undefined, signingSecret)
//     if (!payload) {
//       res.writeHead(401).end()
//       return
//     }
//     // Render payload.tool/args/reason however you like (Slack, email,
//     // an admin queue row) — then, once a human decides:
//     // POST /pending-approvals/${payload.pendingId}/resolve
//     // { "decision": "approve" | "deny", "editedArgs"?: {...} }
//     res.writeHead(200).end()
//   })
// }).listen(3000)
