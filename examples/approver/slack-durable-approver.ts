// A DurableApprover backed by Slack — no built-in class for this exists
// (actauth only ships DurableWebApprover, a generic webhook; see that
// package's own SlackApprover for the *live* Slack integration this
// mirrors the shape of), so this file implements DurableApprover itself,
// same pattern database-durable-approver.ts/redis-durable-approver.ts
// already use for their own backends.
//
// Two genuinely separate concerns, both required for a real Slack
// integration, same split DURABLE_APPROVALS.md's own "Notification: who
// finds out, and how" section describes:
//   - SENDING: DurableSlackApprover.requestDurableApproval() posts an
//     interactive Approve/Deny message and returns a pendingId
//     immediately — never awaited, never holds anything open.
//   - RECEIVING: handleSlackApprovalInteraction() is the route you wire
//     up as your Slack app's own "Interactivity Request URL" — Slack
//     POSTs a button click there, not to loopengine directly. This
//     verifies the click really came from Slack, then calls loopengine's
//     own POST /pending-approvals/:pendingId/resolve to actually decide
//     it — loopengine never talks to Slack directly, and Slack never
//     talks to loopengine directly; this file is the bridge between them.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DurableApprover, Scope } from 'actauth'

// --- Sending side ---

export class DurableSlackApprover implements DurableApprover {
  private readonly botToken: string
  private readonly channel: string

  constructor(options: { botToken: string; channel: string }) {
    this.botToken = options.botToken
    this.channel = options.channel
  }

  requestDurableApproval(tool: string, args: Record<string, unknown>, scope: Scope, reason: string): { pendingId: string } {
    // Unlike actauth's own (live) SlackApprover, this pendingId isn't a
    // lookup key into an in-memory map — loopengine's own CheckpointStore
    // already owns that; it's purely the button's own `value`, round-
    // tripped back to us on click so we know which checkpoint to resolve.
    const pendingId = randomUUID()
    // Not awaited — requestDurableApproval returns immediately, by
    // contract (see DurableApprover's own doc comment). A delivery
    // failure here has no synchronous way to surface to the caller;
    // logged instead of thrown, since throwing would blow up a decision
    // that has already, correctly, been recorded as pending.
    fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        channel: this.channel,
        text: `Approval requested: ${tool} on ${scope.tenant}/${scope.environment}/${scope.agent}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Approval requested*\n*tool:* ${tool}\n*args:* \`${JSON.stringify(args)}\`\n*scope:* ${scope.tenant}/${scope.environment}/${scope.agent}\n*reason:* ${reason}`,
            },
          },
          {
            type: 'actions',
            elements: [
              { type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: 'approve', value: pendingId },
              { type: 'button', text: { type: 'plain_text', text: 'Deny' }, style: 'danger', action_id: 'deny', value: pendingId },
            ],
          },
        ],
      }),
    })
      .then((res) => res.json() as Promise<{ ok: boolean; error?: string }>)
      .then((body) => {
        if (!body.ok) console.error(`[loopengine] DurableSlackApprover: chat.postMessage failed for pendingId '${pendingId}':`, body.error)
      })
      .catch((err) => {
        console.error(`[loopengine] DurableSlackApprover: chat.postMessage failed for pendingId '${pendingId}':`, err)
      })
    return { pendingId }
  }
}

// --- Receiving side ---

/** https://api.slack.com/authentication/verifying-requests-from-slack —
 * identical algorithm to actauth's own (live) SlackApprover.verifySignature,
 * duplicated here rather than imported since that method is private to
 * actauth's class, not exported standalone. */
function verifySlackSignature(rawBody: string, timestamp: string | undefined, signature: string | undefined, signingSecret: string): boolean {
  if (!timestamp || !signature) return false
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (!Number.isFinite(age) || age > 60 * 5) return false // reject stale requests — replay protection
  const hmac = createHmac('sha256', signingSecret)
  hmac.update(`v0:${timestamp}:${rawBody}`)
  const expected = Buffer.from(`v0=${hmac.digest('hex')}`)
  const actual = Buffer.from(signature)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Call this from the route wired up as your Slack app's own
 * "Interactivity Request URL" — never loopengine's own address directly,
 * Slack has no idea loopengine exists. `rawBody` is the exact, unparsed
 * request body (signature verification is over the raw bytes, same
 * reasoning every other signature check in this codebase follows).
 * `loopengineBaseUrl`/`loopengineAdminAuth` are what actually resolve the
 * approval once the click is verified — `loopengineAdminAuth` is the same
 * `user:pass` string set as `LOOPENGINE_ADMIN_AUTH` on the loopengine
 * server itself, since /pending-approvals/:id/resolve sits behind that
 * same Basic Auth as every other route there. */
export async function handleSlackApprovalInteraction(
  rawBody: string,
  headers: { timestamp: string | undefined; signature: string | undefined },
  options: { signingSecret: string; loopengineBaseUrl: string; loopengineAdminAuth?: string },
): Promise<void> {
  if (!verifySlackSignature(rawBody, headers.timestamp, headers.signature, options.signingSecret)) {
    throw new Error('DurableSlackApprover: invalid Slack request signature')
  }

  const payloadRaw = new URLSearchParams(rawBody).get('payload')
  if (!payloadRaw) return
  const payload = JSON.parse(payloadRaw) as { actions?: { action_id: string; value: string }[]; response_url?: string }
  const action = payload.actions?.[0]
  if (!action) return

  const decision = action.action_id === 'approve' ? 'approve' : 'deny'
  const authHeader: Record<string, string> = options.loopengineAdminAuth
    ? { authorization: `Basic ${Buffer.from(options.loopengineAdminAuth).toString('base64')}` }
    : {}
  const res = await fetch(`${options.loopengineBaseUrl}/pending-approvals/${encodeURIComponent(action.value)}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader },
    body: JSON.stringify({ decision }),
  })
  const body = (await res.json()) as { alreadyResolved?: boolean; resolved?: boolean; text?: string; error?: string }
  if (!res.ok) throw new Error(`DurableSlackApprover: resolve failed: ${body.error ?? res.status}`)

  // Slack expects a fast ack for the interaction itself; updating the
  // original message (so the buttons don't just sit there looking
  // clickable forever) is a separate, best-effort follow-up call.
  if (payload.response_url) {
    const summary = body.alreadyResolved
      ? 'Already resolved elsewhere.'
      : body.resolved
        ? `${decision === 'approve' ? ':white_check_mark: Approved' : ':no_entry: Denied'} — turn still has other pending items.`
        : `${decision === 'approve' ? ':white_check_mark: Approved' : ':no_entry: Denied'} — resumed: ${body.text ?? ''}`
    await fetch(payload.response_url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ replace_original: true, text: summary }),
    })
  }
}

// --- Wiring both sides together, illustrative only ---
//
// import { createServer } from 'node:http'
//
// const approver = new DurableSlackApprover({ botToken: process.env.SLACK_BOT_TOKEN!, channel: process.env.SLACK_CHANNEL_ID! })
// // ... AgentConfig.approvers = { http: approver }
//
// createServer((req, res) => {
//   let body = ''
//   req.on('data', (chunk) => (body += chunk))
//   req.on('end', async () => {
//     try {
//       await handleSlackApprovalInteraction(
//         body,
//         { timestamp: req.headers['x-slack-request-timestamp'] as string, signature: req.headers['x-slack-signature'] as string },
//         { signingSecret: process.env.SLACK_SIGNING_SECRET!, loopengineBaseUrl: 'http://localhost:8787', loopengineAdminAuth: process.env.LOOPENGINE_ADMIN_AUTH },
//       )
//       res.writeHead(200).end()
//     } catch (err) {
//       res.writeHead(401).end(String(err))
//     }
//   })
// }).listen(3001) // a different port/route than loopengine's own server — Slack's Request URL points here, not at loopengine
