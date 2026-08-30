// The Lark/Feishu channel's *receiving* side — verifying a card-callback
// payload and dispatching it back into loopengine's own resolve/answer
// routes. The *sending* side needs no example anymore:
// `AgentConfig.httpNotifier`'s `channel: 'lark'` already builds it for
// you (`core/http-notifier.ts` constructs
// `core/http-notify-triggers/lark.ts`'s `LarkNotifier` — one
// instance implementing both `DurableApprover` and `DurableQuestionHandler`,
// posting an interactive card via Lark's own `im/v1/messages` call), from
// one `{appId, appSecret, chatId}`. Import `LarkNotifier` directly
// instead, only if you need it as a `RunAgentOptions.approver`/
// `questionHandler` value rather than through `AgentConfig`.
//
// Confidence note, stated plainly rather than glossed over: Lark's Open
// Platform API has had more than one card-callback convention over time
// (a plain `verification_token` string check is the longest-standing,
// most widely documented one, which is what this uses — some apps are
// instead configured for an `Encrypt Key`-based HMAC signature, a
// different check entirely). Verify which your app is configured for at
// https://open.feishu.cn/document before relying on this in production.
//
// What this file is for, and the one thing that genuinely IS still yours
// to deploy: the route configured as your Lark app's own card callback /
// event URL — an HTTP endpoint only the host can deploy, same "sending
// built for you, receiving you deploy" split every other channel here
// has. `handleLarkInteraction` below is the *only* route you need,
// regardless of whether the batch being resolved came from an approval
// or a question notification — dispatched by whether the button's own
// `value` carries a `decision` (an approval) or not (a question). The
// free-text answer (for a question, not an approval) is the one
// genuinely tricky part, and worth being honest about: Slack's own answer
// (a modal, opened via views.open, a completely separate API call keyed
// off a one-time trigger_id) has no direct Lark equivalent used here.
// This handles a "form" card submission instead (an `input` element
// inside an `action`/`form` container, submitted as one callback with
// all field values together) — lower confidence, since Lark's card
// schema has changed across versions; verify the exact `tag`/field names
// LarkNotifier builds against https://open.feishu.cn/document for
// your app's configured card version before relying on this.
import { timingSafeEqual } from 'node:crypto'
import { LARK_ANSWER_FIELD_TAG } from '#core/http-notify-triggers/lark.js'

/** Constant-time string compare against your app's own Verification
 * Token (Lark's "Event Subscription" / "Card Callback" config page) —
 * simpler than an HMAC since the token itself rides in the payload, not
 * a separate signature header; see this file's own header comment for
 * when that's the wrong check for your app's configuration. */
function verifyLarkToken(token: string | undefined, verificationToken: string): boolean {
  if (!token) return false
  const expected = Buffer.from(verificationToken)
  const actual = Buffer.from(token)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

async function callLoopengine(
  path: string,
  body: Record<string, unknown>,
  options: { loopengineBaseUrl: string; loopengineAdminAuth?: string },
): Promise<{ alreadyResolved?: boolean; resolved?: boolean; text?: string; error?: string }> {
  const authHeader: Record<string, string> = options.loopengineAdminAuth
    ? { authorization: `Basic ${Buffer.from(options.loopengineAdminAuth).toString('base64')}` }
    : {}
  const res = await fetch(`${options.loopengineBaseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader },
    body: JSON.stringify(body),
  })
  const resBody = (await res.json()) as { alreadyResolved?: boolean; resolved?: boolean; text?: string; error?: string }
  if (!res.ok) throw new Error(`handleLarkInteraction: ${path} failed: ${resBody.error ?? res.status}`)
  return resBody
}

/** Call this from the route configured as your Lark app's own card
 * callback / event URL. Handles both the one-time `url_verification`
 * handshake Lark performs when you first save that URL (must echo
 * `challenge` back, verbatim) and real button-click/form-submit
 * payloads — returns the JSON body your route should respond with
 * either way; never writes to `res` itself, so the same function works
 * regardless of which HTTP framework wires it up. */
export async function handleLarkInteraction(
  body: {
    type?: 'url_verification'
    challenge?: string
    token?: string
    action?: { value?: { pendingId: string; decision?: 'approve' | 'deny'; answer?: string } }
    form_value?: Record<string, string>
  },
  options: { verificationToken: string; loopengineBaseUrl: string; loopengineAdminAuth?: string },
): Promise<Record<string, unknown>> {
  if (body.type === 'url_verification') return { challenge: body.challenge }

  if (!verifyLarkToken(body.token, options.verificationToken)) {
    throw new Error('handleLarkInteraction: invalid Lark verification token')
  }

  const value = body.action?.value
  if (!value) return {}

  if (value.decision) {
    const resolveBody = await callLoopengine(`/pending-approvals/${encodeURIComponent(value.pendingId)}/resolve`, { decision: value.decision }, options)
    // Lark cards can be updated in place by returning a `toast`/new card
    // from the callback itself (unlike Slack's separate response_url
    // call) — kept minimal here; a real integration would return an
    // updated card disabling the buttons instead of leaving them
    // clickable.
    return {
      toast: {
        type: 'success',
        content: resolveBody.alreadyResolved ? 'Already resolved elsewhere.' : value.decision === 'approve' ? 'Approved.' : 'Denied.',
      },
    }
  }

  // Question: an option button already carries the answer in its own
  // value; a form submit's typed text is a sibling field keyed by the
  // input's own `name` (LARK_ANSWER_FIELD_TAG, imported from
  // LarkNotifier's own module so the two never drift apart) — see
  // this file's own header comment for why the form's exact field names
  // still need checking against your card version.
  const answer = value.answer ?? body.form_value?.[LARK_ANSWER_FIELD_TAG] ?? ''
  await callLoopengine(`/pending-questions/${encodeURIComponent(value.pendingId)}/answer`, { answer }, options)
  return { toast: { type: 'success', content: 'Answer received.' } }
}

// --- Wiring, illustrative only ---
//
// AgentConfig.httpNotifier builds the sending side — nothing to write:
//
// httpNotifier: {
//   channel: 'lark',
//   config: { appId: process.env.LARK_APP_ID!, appSecret: process.env.LARK_APP_SECRET!, chatId: process.env.LARK_CHAT_ID! },
//   events: ['approval', 'question'],
// }
//
// import { createServer } from 'node:http'
//
// createServer((req, res) => {
//   let raw = ''
//   req.on('data', (chunk) => (raw += chunk))
//   req.on('end', async () => {
//     try {
//       const responseBody = await handleLarkInteraction(JSON.parse(raw), {
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
