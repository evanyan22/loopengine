// A DurableApprover backed by Lark/Feishu — same "no built-in class
// exists, implement the interface yourself" reasoning as
// ./slack-durable-approver.ts, and structured the same way on purpose so
// the two read as a matched pair; read that file first for the shared
// reasoning (why sending/receiving are separate concerns, why the
// pendingId round-trips through the button itself rather than an
// in-memory map). This file only calls out what's actually different
// about Lark's own API shape.
//
// Confidence note, stated plainly rather than glossed over: Lark's Open
// Platform API has had more than one card-callback convention over time
// (a plain `verification_token` string check is the longest-standing,
// most widely documented one, which is what this uses — some apps are
// instead configured for an `Encrypt Key`-based HMAC signature, a
// different check entirely). Verify which your app is configured for at
// https://open.feishu.cn/document before relying on this in production;
// the request/response *shapes* below (tenant_access_token, the
// im/v1/messages call, the button value round-trip) are stable regardless
// of which verification method you end up using.
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { DurableApprover, Scope } from 'actauth'

// --- Auth: tenant_access_token, cached and refreshed on expiry ---
// (needed by both this file and lark-durable-question-handler.ts —
// duplicated rather than shared, same "stays copy-pasteable on its own"
// reasoning slack-durable-approver.ts's own verifySlackSignature has.)

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

export class DurableLarkApprover implements DurableApprover {
  private readonly appId: string
  private readonly appSecret: string
  private readonly chatId: string

  constructor(options: { appId: string; appSecret: string; chatId: string }) {
    this.appId = options.appId
    this.appSecret = options.appSecret
    this.chatId = options.chatId
  }

  requestDurableApproval(tool: string, args: Record<string, unknown>, scope: Scope, reason: string): { pendingId: string } {
    const pendingId = randomUUID()
    // Fire-and-forget, same reasoning slack-durable-approver.ts's own
    // requestDurableApproval has — an async token fetch + message send
    // chain, never awaited by the caller.
    void (async () => {
      try {
        const token = await getTenantAccessToken(this.appId, this.appSecret)
        const card = {
          config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: 'Approval requested' } },
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: `**tool:** ${tool}\n**args:** \`${JSON.stringify(args)}\`\n**scope:** ${scope.tenant}/${scope.environment}/${scope.agent}\n**reason:** ${reason}`,
              },
            },
            {
              tag: 'action',
              actions: [
                { tag: 'button', text: { tag: 'plain_text', content: 'Approve' }, type: 'primary', value: { pendingId, decision: 'approve' } },
                { tag: 'button', text: { tag: 'plain_text', content: 'Deny' }, type: 'danger', value: { pendingId, decision: 'deny' } },
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
        if (body.code !== 0) console.error(`[loopengine] DurableLarkApprover: send message failed for pendingId '${pendingId}':`, body.msg)
      } catch (err) {
        console.error(`[loopengine] DurableLarkApprover: send message failed for pendingId '${pendingId}':`, err)
      }
    })()
    return { pendingId }
  }
}

// --- Receiving side ---

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

/** Call this from the route configured as your Lark app's own card
 * callback / event URL. Handles both the one-time `url_verification`
 * handshake Lark performs when you first save that URL (must echo
 * `challenge` back, verbatim) and real button-click payloads —
 * `handleLarkApprovalInteraction` returns the JSON body your route
 * should respond with either way; it never writes to `res` itself, so
 * the same function works regardless of which HTTP framework wires it up. */
export async function handleLarkApprovalInteraction(
  body: { type?: 'url_verification'; challenge?: string; token?: string; action?: { value?: { pendingId: string; decision: 'approve' | 'deny' } } },
  options: { verificationToken: string; loopengineBaseUrl: string; loopengineAdminAuth?: string },
): Promise<Record<string, unknown>> {
  if (body.type === 'url_verification') return { challenge: body.challenge }

  if (!verifyLarkToken(body.token, options.verificationToken)) {
    throw new Error('DurableLarkApprover: invalid Lark verification token')
  }

  const value = body.action?.value
  if (!value) return {}

  const authHeader: Record<string, string> = options.loopengineAdminAuth
    ? { authorization: `Basic ${Buffer.from(options.loopengineAdminAuth).toString('base64')}` }
    : {}
  const res = await fetch(`${options.loopengineBaseUrl}/pending-approvals/${encodeURIComponent(value.pendingId)}/resolve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeader },
    body: JSON.stringify({ decision: value.decision }),
  })
  const resolveBody = (await res.json()) as { alreadyResolved?: boolean; resolved?: boolean; text?: string; error?: string }
  if (!res.ok) throw new Error(`DurableLarkApprover: resolve failed: ${resolveBody.error ?? res.status}`)

  // Lark cards can be updated in place by returning a `toast`/new card
  // from the callback itself (unlike Slack's separate response_url call)
  // — kept minimal here; a real integration would return an updated card
  // disabling the buttons instead of leaving them clickable.
  return {
    toast: {
      type: 'success',
      content: resolveBody.alreadyResolved ? 'Already resolved elsewhere.' : value.decision === 'approve' ? 'Approved.' : 'Denied.',
    },
  }
}

// --- Wiring both sides together, illustrative only ---
//
// import { createServer } from 'node:http'
//
// const approver = new DurableLarkApprover({ appId: process.env.LARK_APP_ID!, appSecret: process.env.LARK_APP_SECRET!, chatId: process.env.LARK_CHAT_ID! })
// // ... AgentConfig.approvers = { http: approver }
//
// createServer((req, res) => {
//   let raw = ''
//   req.on('data', (chunk) => (raw += chunk))
//   req.on('end', async () => {
//     try {
//       const responseBody = await handleLarkApprovalInteraction(JSON.parse(raw), {
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
