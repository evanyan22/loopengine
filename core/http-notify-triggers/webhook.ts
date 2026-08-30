// The generic-webhook channel's sending side, one class for both
// concerns — same "it's channel-specific, not concern-specific" shape
// slack.ts/lark.ts/email.ts already have, not the "two already-shipped
// classes from two separate packages" split this file used to be (see
// git history): approval-sending used to be actauth's own
// `WebhookApprover`, question-sending loopengine's own
// `WebhookQuestionHandler` (`core/system-tools/ask_user.ts`) — genuinely
// separate classes, since `actauth`'s `Gate` has no concept of
// `system_ask_user` questions at all (see HUMAN_IN_THE_LOOP.md's
// "Durable questions" section). Nothing about *sending* a signed webhook
// POST is actauth-specific, though, once you stop assuming the approval
// half has to live in actauth's own package — both halves are the exact
// same HMAC-SHA256-over-the-raw-body scheme, just under different
// headers, so merging them removes real duplication (one class, one
// constructor, one place either concern's own webhook target/secret is
// held) rather than just looking simpler on paper.
//
// `actauth`'s own `WebhookApprover` still exists and is unaffected —
// this is loopengine's own implementation of the same `DurableApprover`
// interface, not a fork of actauth's class; a standalone actauth
// consumer (no loopengine involved) still has and should use actauth's
// own. loopengine no longer imports it anywhere, since everywhere it
// used to (this file, and adapters/http.ts's own deployment-wide
// default) now constructs one `WebhookNotifier` instead.
//
// The signed payloads below are wire-compatible with what actauth's
// `WebhookApprover`/loopengine's former `WebhookQuestionHandler` already
// sent — same fields, same `X-Actauth-Signature`/`X-Askuser-Signature`
// headers — so an existing receiving-side deployment (this repo's own
// `examples/notifier-handler/webhook.ts`, or a host's own) needs no
// changes; only where the bytes come from moved.
//
// `postLifecycleWebhook` below is the third, genuinely new piece:
// `onRunStart`/`onRunFinish` have no shipped class on either side, for
// any channel (see this repo's own history — agents/customer-service/index.ts
// used to hand-write this exact function before `AgentConfig.httpNotifier`
// existed). Same signing scheme, under its own `X-Lifecycle-Signature`
// header so a receiver can tell a lifecycle event apart from a
// pending-approval/pending-question one hitting the same URL (see
// examples/notifier-handler/webhook.ts's own `verifyWebhookNotifier` for
// the receiving side of all three).
import { createHmac, randomUUID } from 'node:crypto'
import type { DurableApprover, Scope } from 'actauth'
import type { DurableQuestionHandler } from '../agent-config.js'

export class WebhookNotifier implements DurableApprover, DurableQuestionHandler {
  private readonly webhookUrl: string
  private readonly signingSecret: string

  constructor(options: { webhookUrl: string; signingSecret: string }) {
    this.webhookUrl = options.webhookUrl
    this.signingSecret = options.signingSecret
  }

  requestDurableApproval(tool: string, args: Record<string, unknown>, scope: Scope, reason: string): { pendingId: string } {
    const pendingId = randomUUID()
    const requestedAt = new Date().toISOString()
    const body = JSON.stringify({ pendingId, tool, args, scope, reason, requestedAt })
    this.post(body, 'X-Actauth-Signature', pendingId)
    return { pendingId }
  }

  notifyPendingQuestion(question: string, options: string[] | undefined, agent: string, sessionId: string | undefined): { pendingId: string } {
    const pendingId = randomUUID()
    const requestedAt = new Date().toISOString()
    const body = JSON.stringify({ pendingId, question, options, agent, sessionId, requestedAt })
    this.post(body, 'X-Askuser-Signature', pendingId)
    return { pendingId }
  }

  /** Shared by both methods above — the one place either used to
   * independently build the same signed fetch() call. Not awaited by its
   * own callers, same fire-and-forget contract each had on its own: both
   * requestDurableApproval/notifyPendingQuestion return immediately, by
   * contract (see DurableApprover/DurableQuestionHandler's own doc
   * comments), so a delivery failure here has no synchronous way to
   * surface to the caller — logged instead of thrown, since throwing
   * would blow up a decision that has already, correctly, been recorded
   * as pending. */
  private post(body: string, signatureHeader: string, pendingId: string): void {
    const signature = `sha256=${createHmac('sha256', this.signingSecret).update(body).digest('hex')}`
    fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [signatureHeader]: signature },
      body,
    }).catch((err) => {
      console.error(`[loopengine] WebhookNotifier: webhook delivery failed for pendingId '${pendingId}':`, err)
    })
  }
}

export function postLifecycleWebhook(
  webhookUrl: string,
  webhookSecret: string,
  event: 'run_start' | 'run_finish',
  context: Record<string, unknown>,
): void {
  const payload = JSON.stringify({ event, ...context, occurredAt: new Date().toISOString() })
  const signature = `sha256=${createHmac('sha256', webhookSecret).update(payload).digest('hex')}`
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Lifecycle-Signature': signature },
    body: payload,
  }).catch((err) => {
    console.error(`[loopengine] httpNotifier ${event} webhook delivery failed:`, err)
  })
}
