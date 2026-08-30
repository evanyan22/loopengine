// The generic-webhook channel's *receiving* side — verifying a signed
// payload and telling apart which of the three kinds (approval, question,
// lifecycle) it actually is. The *sending* side needs no example at all
// anymore: `AgentConfig.httpNotifier`'s `channel: 'webhook'` already
// builds it for you (`core/http-notifier.ts` constructs
// `core/http-notify-triggers/webhook.ts`'s `WebhookNotifier` — one
// instance covering both approvals and questions — plus the lifecycle
// sender). Import `WebhookNotifier`/`postLifecycleWebhook` from
// `#core/http-notify-triggers/webhook.js` directly instead, only if you
// need one as a `RunAgentOptions.approver`/`questionHandler` value (or
// the lifecycle sender itself) rather than through `AgentConfig`.
//
// What this file is for, and the one thing that genuinely IS still yours
// to deploy: an HTTP endpoint receiving whatever `httpNotifier` (or
// `WebhookNotifier`, used directly) posts — that route is always
// something the host owns, never loopengine itself (see
// `DurableApprover`'s own doc comment on why "what happens next" stays
// outside the package). `verifyWebhookNotifier` below looks at *which*
// signature header actually showed up — a real request only ever carries one, since an
// approval/question/lifecycle notification are never the same POST —
// verifies against the matching algorithm (HMAC-SHA256 over the raw JSON
// body, `sha256=<hex>`, identical for all three kinds — only the header
// name differs), and returns a discriminated union your route can switch
// on, instead of three independent verify-and-parse functions your route
// would otherwise have to try in some order.
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Scope } from 'actauth'

export interface WebhookApprovalPayload {
  kind: 'approval'
  pendingId: string
  tool: string
  args: Record<string, unknown>
  scope: Scope
  reason: string
  requestedAt: string
}

export interface WebhookQuestionPayload {
  kind: 'question'
  pendingId: string
  question: string
  options?: string[]
  agent: string
  sessionId?: string
  requestedAt: string
}

/** Matches what core/http-notifier.ts's own postLifecycleWebhook actually
 * sends — `trigger` only on `run_start`, `text`/`stopReason` only on
 * `run_finish`, both optional here since this type covers either. No
 * `pendingId` at all: unlike an approval/question, a lifecycle event was
 * never waiting on anyone to resolve it — there's nothing to call
 * `/pending-approvals/`/`/pending-questions/` back with. */
export interface WebhookLifecyclePayload {
  kind: 'lifecycle'
  event: 'run_start' | 'run_finish'
  sessionId?: string
  trigger?: 'message' | 'resolution'
  text?: string
  stopReason?: 'max_turns' | 'denied'
  occurredAt: string
}

function verifyHmacSignature(rawBody: string, signatureHeader: string | undefined, signingSecret: string): boolean {
  if (!signatureHeader) return false
  const hmac = createHmac('sha256', signingSecret)
  hmac.update(rawBody)
  const expected = Buffer.from(`sha256=${hmac.digest('hex')}`)
  const actual = Buffer.from(signatureHeader)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** Verifies + parses whichever of the three payload shapes actually
 * arrived. `headers.actauthSignature`/`askuserSignature`/`lifecycleSignature`
 * are `req.headers['x-actauth-signature']`/`['x-askuser-signature']`/
 * `['x-lifecycle-signature']` respectively — a real request only ever
 * carries one, never more than one, since `WebhookNotifier`'s own two
 * methods (and its sibling lifecycle sender) each only ever attach
 * their own header, never more than one at a time. Returns null for a
 * missing/wrong signature on whichever
 * header IS present, or for a request carrying none of the three.
 *
 * Each branch also checks the *parsed shape*, not just the signature —
 * worth being explicit about why: HMAC alone proves "signed with this
 * secret," never "signed specifically as *this* kind." All three kinds
 * can share one `signingSecret` by design (that's the whole point of one
 * endpoint receiving all three), so a payload of one kind arriving under
 * a different kind's header — a wiring bug, or a replayed request —
 * would otherwise pass signature verification and get parsed (and
 * typed!) as the wrong kind with no runtime check to catch it. Checking
 * the fields each kind actually has (and the others don't) closes that,
 * cheaply, using the shape difference that's already there rather than
 * needing a new field on the signed body itself. */
export function verifyWebhookNotifier(
  rawBody: string,
  headers: { actauthSignature: string | undefined; askuserSignature: string | undefined; lifecycleSignature: string | undefined },
  signingSecret: string,
): WebhookApprovalPayload | WebhookQuestionPayload | WebhookLifecyclePayload | null {
  if (headers.actauthSignature) {
    if (!verifyHmacSignature(rawBody, headers.actauthSignature, signingSecret)) return null
    const body = JSON.parse(rawBody) as Partial<WebhookApprovalPayload>
    if (typeof body.pendingId !== 'string' || typeof body.tool !== 'string' || typeof body.reason !== 'string') return null
    return { kind: 'approval', ...body } as WebhookApprovalPayload
  }
  if (headers.askuserSignature) {
    if (!verifyHmacSignature(rawBody, headers.askuserSignature, signingSecret)) return null
    const body = JSON.parse(rawBody) as Partial<WebhookQuestionPayload>
    if (typeof body.pendingId !== 'string' || typeof body.question !== 'string') return null
    return { kind: 'question', ...body } as WebhookQuestionPayload
  }
  if (headers.lifecycleSignature) {
    if (!verifyHmacSignature(rawBody, headers.lifecycleSignature, signingSecret)) return null
    const body = JSON.parse(rawBody) as Partial<WebhookLifecyclePayload>
    if (body.event !== 'run_start' && body.event !== 'run_finish') return null
    if (typeof body.occurredAt !== 'string') return null
    return { kind: 'lifecycle', ...body } as WebhookLifecyclePayload
  }
  return null
}

// --- Wiring, illustrative only (plain node:http, same no-framework style
// adapters/http.ts itself uses) ---
//
// AgentConfig.httpNotifier builds the sending side — nothing to write:
//
// httpNotifier: {
//   channel: 'webhook',
//   config: { webhookUrl: process.env.MY_WEBHOOK_URL!, webhookSecret: process.env.MY_WEBHOOK_SECRET! },
//   events: ['approval', 'question', 'run_start', 'run_finish'],
// }
//
// import { createServer } from 'node:http'
//
// createServer((req, res) => {
//   let body = ''
//   req.on('data', (chunk) => (body += chunk))
//   req.on('end', () => {
//     const payload = verifyWebhookNotifier(
//       body,
//       {
//         actauthSignature: req.headers['x-actauth-signature'] as string | undefined,
//         askuserSignature: req.headers['x-askuser-signature'] as string | undefined,
//         lifecycleSignature: req.headers['x-lifecycle-signature'] as string | undefined,
//       },
//       process.env.MY_WEBHOOK_SECRET!,
//     )
//     if (!payload) {
//       res.writeHead(401).end()
//       return
//     }
//     if (payload.kind === 'approval') {
//       // Render payload.tool/args/reason however you like — then, once a
//       // human decides: POST /pending-approvals/${payload.pendingId}/resolve
//       // { "decision": "approve" | "deny", "editedArgs"?: {...} }
//     } else if (payload.kind === 'question') {
//       // Render payload.question/options however you like — then, once a
//       // human answers: POST /pending-questions/${payload.pendingId}/answer
//       // { "answer": "..." }
//     } else {
//       // payload.kind === 'lifecycle' — nothing to resolve, no pendingId
//       // at all; just an event to log/forward (an admin dashboard row, a
//       // Slack post) — payload.event distinguishes run_start from
//       // run_finish, and payload.text/stopReason are only present on the
//       // latter.
//     }
//     res.writeHead(200).end()
//   })
// }).listen(3000)
