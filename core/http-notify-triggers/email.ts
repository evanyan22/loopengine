// The *sending* half of an email-backed DurableApprover/DurableQuestionHandler,
// real, maintained core/ code so AgentConfig.httpNotifier
// (core/http-notifier.ts) can construct one directly for `channel:
// 'email'`. Takes a `sendEmail` function (AgentConfig.SendEmail) rather
// than hardcoding one provider — real email needs an SMTP client or
// provider SDK, a dependency this package deliberately doesn't carry; a
// minimal Resend-backed one is in
// examples/notifier-handler/email.ts's own createExampleResendSendEmail,
// illustrative only.
//
// The *receiving* side — turning a clicked link (or submitted form) back
// into a `POST /pending-approvals/:id/resolve`/`POST /pending-questions/:id/answer`
// call — deliberately stays out of core: that's an HTTP endpoint only the
// host can deploy. See examples/notifier-handler/email.ts's own
// `handleEmailApprovalClick`/`handleEmailQuestionAnswerPage`/
// `handleEmailQuestionAnswerSubmit` for that half — those import
// `verifyMagicLink` from *this* file rather than reimplementing it, since
// unlike Slack/Lark (where the platform itself signs the callback), email
// has no such mechanism: this file's own `signMagicLink` and the
// receiving side's verification have to agree on one exact algorithm, not
// two copies that could drift.
//
// The one thing that makes email a genuinely different integration than
// Slack/Lark, not just "a different send API": a clicked email link is a
// plain browser GET request — there's no interactivity payload, no
// signature header a chat platform would attach, nothing stopping a
// copied or forwarded link from being replayed. `pendingId` alone isn't
// enough for a link that might sit in an inbox for days — this is exactly
// the "signed, expiring token per link, with real revocation... still
// unbuilt" gap HUMAN_IN_THE_LOOP.md's own open questions list — so this
// file builds one: a small HMAC-signed, expiring token embedded in the
// link itself, verified before ever touching loopengine's own
// resolve/answer routes.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import type { DurableApprover, Scope } from 'actauth'
import type { DurableQuestionHandler, SendEmail } from '../agent-config.js'

export interface EmailLinkPayload {
  pendingId: string
  /** Present for an approval link (`'approve' | 'deny'`) or a
   * suggested-option question link (the option text itself, resolves on
   * click, no form needed); absent for a question's "type your own
   * answer" link (the receiving side renders a form instead). */
  decision?: 'approve' | 'deny'
  answer?: string
  exp: number // epoch ms
}

function signMagicLink(payload: Omit<EmailLinkPayload, 'exp'>, expiresInMs: number, signingSecret: string): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + expiresInMs })).toString('base64url')
  const signature = createHmac('sha256', signingSecret).update(body).digest('base64url')
  return `${body}.${signature}`
}

/** Returns the decoded payload, or null for a missing/tampered/expired
 * token — graceful, distinguishable failure, not a thrown exception for
 * the merely-expired case. Exported for the receiving-side example (see
 * this file's own header comment for why it imports this instead of
 * reimplementing it). */
export function verifyMagicLink(token: string, signingSecret: string): EmailLinkPayload | null {
  const [body, signature] = token.split('.')
  if (!body || !signature) return null
  const expected = createHmac('sha256', signingSecret).update(body).digest('base64url')
  const expectedBuf = Buffer.from(expected)
  const actualBuf = Buffer.from(signature)
  if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) return null
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as EmailLinkPayload
  if (Date.now() > payload.exp) return null
  return payload
}

/** Both the outbound email body here and the receiving side's own
 * confirmation pages interpolate values that ultimately trace back to
 * the model or a human (tool args, a reason, a resumed turn's own reply
 * text) — escaped before ever reaching an HTML template, same as any
 * other untrusted-input-into-HTML boundary. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export class EmailNotifier implements DurableApprover, DurableQuestionHandler {
  private readonly to: string
  private readonly sendEmail: SendEmail
  private readonly resolveBaseUrl: string // e.g. https://yourapp.com/email/approvals — YOUR route, not loopengine's own address
  private readonly answerBaseUrl: string // e.g. https://yourapp.com/email/questions — YOUR route, not loopengine's own address
  private readonly signingSecret: string
  private readonly linkTtlMs: number

  constructor(options: { to: string; sendEmail: SendEmail; resolveBaseUrl: string; answerBaseUrl: string; signingSecret: string; linkTtlMs?: number }) {
    this.to = options.to
    this.sendEmail = options.sendEmail
    this.resolveBaseUrl = options.resolveBaseUrl
    this.answerBaseUrl = options.answerBaseUrl
    this.signingSecret = options.signingSecret
    this.linkTtlMs = options.linkTtlMs ?? 3 * 24 * 60 * 60_000 // 3 days — long enough for someone to actually check email, short enough that a leaked link doesn't stay live forever
  }

  requestDurableApproval(tool: string, args: Record<string, unknown>, scope: Scope, reason: string): { pendingId: string } {
    const pendingId = randomUUID()
    const approveLink = `${this.resolveBaseUrl}?token=${signMagicLink({ pendingId, decision: 'approve' }, this.linkTtlMs, this.signingSecret)}`
    const denyLink = `${this.resolveBaseUrl}?token=${signMagicLink({ pendingId, decision: 'deny' }, this.linkTtlMs, this.signingSecret)}`
    // Not awaited — requestDurableApproval returns immediately, by
    // contract (see DurableApprover's own doc comment). Logged instead of
    // thrown on failure.
    this.sendEmail(
      this.to,
      `Approval requested: ${tool}`,
      `<p><b>Tool:</b> ${escapeHtml(tool)}</p>` +
        `<p><b>Args:</b> ${escapeHtml(JSON.stringify(args))}</p>` +
        `<p><b>Scope:</b> ${escapeHtml(`${scope.tenant}/${scope.environment}/${scope.agent}`)}</p>` +
        `<p><b>Reason:</b> ${escapeHtml(reason)}</p>` +
        `<p><a href="${approveLink}">Approve</a> &nbsp;|&nbsp; <a href="${denyLink}">Deny</a></p>` +
        `<p style="color:#888;font-size:12px">This link expires in ${Math.round(this.linkTtlMs / 3_600_000)} hours.</p>`,
    ).catch((err) => {
      console.error(`[loopengine] EmailNotifier: sendEmail failed for pendingId '${pendingId}':`, err)
    })
    return { pendingId }
  }

  notifyPendingQuestion(question: string, options: string[] | undefined, agent: string, sessionId: string | undefined): { pendingId: string } {
    const pendingId = randomUUID()
    const optionLinks = (options ?? [])
      .map((option) => {
        const token = signMagicLink({ pendingId, answer: option }, this.linkTtlMs, this.signingSecret)
        return `<a href="${this.answerBaseUrl}?token=${token}">${escapeHtml(option)}</a>`
      })
      .join(' &nbsp;|&nbsp; ')
    const freeTextToken = signMagicLink({ pendingId }, this.linkTtlMs, this.signingSecret)
    const freeTextLink = `${this.answerBaseUrl}?token=${freeTextToken}`

    this.sendEmail(
      this.to,
      `Question from ${agent}`,
      `<p>${escapeHtml(question)}</p>` +
        (sessionId ? `<p style="color:#888;font-size:12px">Session: ${escapeHtml(sessionId)}</p>` : '') +
        (optionLinks ? `<p>${optionLinks}</p>` : '') +
        `<p><a href="${freeTextLink}">${optionLinks ? 'Or answer in your own words' : 'Answer'}</a></p>` +
        `<p style="color:#888;font-size:12px">This link expires in ${Math.round(this.linkTtlMs / 3_600_000)} hours.</p>`,
    ).catch((err) => {
      console.error(`[loopengine] EmailNotifier: sendEmail failed for pendingId '${pendingId}':`, err)
    })
    return { pendingId }
  }

  /** Public: core/http-notifier.ts's own onRunStart/onRunFinish lifecycle
   * sender for `channel: 'email'` calls this directly — a plain
   * announcement, no magic link, since there's nothing to resolve. */
  sendAnnouncement(subject: string, text: string): void {
    this.sendEmail(this.to, subject, `<p>${escapeHtml(text)}</p>`).catch((err) => {
      console.error('[loopengine] EmailNotifier: sendEmail failed for lifecycle announcement:', err)
    })
  }
}
