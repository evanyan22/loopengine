// The *sending* half of a Lark/Feishu-backed DurableApprover/DurableQuestionHandler,
// real, maintained core/ code so AgentConfig.httpNotifier
// (core/http-notifier.ts) can construct one directly for `channel:
// 'lark'`, the same way it already does for `channel: 'slack'`
// (./slack.ts's own SlackNotifier — read that file first, this one
// mirrors its reasoning for why approval/question/lifecycle concerns
// merge into one class rather than staying split).
//
// The *receiving* side — verifying a Lark card-callback payload really
// came from your app, then dispatching approve/deny/answer back into
// loopengine's own resolve/answer routes — deliberately stays out of
// core: that's an HTTP endpoint only the host can deploy. See
// examples/notifier-handler/lark.ts's own `handleLarkInteraction` for
// that half.
//
// Confidence note, stated plainly rather than glossed over: Lark's Open
// Platform API has had more than one card-callback convention over time
// (a plain `verification_token` string check is the longest-standing,
// most widely documented one — see the receiving-side example for where
// that check actually happens). Verify which your app is configured for
// at https://open.feishu.cn/document before relying on this in
// production; the request shapes below (tenant_access_token, the
// im/v1/messages call, the button value round-trip) are stable regardless
// of which verification method you end up using on the receiving side.
//
// The free-text answer (for a question) is the one genuinely tricky
// part, worth being honest about: Slack's own answer (a modal, opened via
// a separate API call keyed off a one-time trigger_id) has no direct Lark
// equivalent used here. This uses a "form" card (an `input` element
// inside an `action`/`form` container, submitted as one callback with all
// field values together) — lower confidence than the rest of this file:
// Lark's card schema has changed across versions, so verify the exact
// `tag`/field names below against https://open.feishu.cn/document for
// your app's configured card version before relying on this. The other
// real option — replying in-thread, captured via the
// `im.message.receive_v1` event — needs your own durable
// message_id -> pendingId mapping (an in-memory Map is NOT enough if
// sending and receiving ever run in different processes), deliberately
// not the approach used here.
import { randomUUID } from 'node:crypto'
import type { DurableApprover, Scope } from 'actauth'
import type { DurableQuestionHandler } from '../agent-config.js'

/** Fixed id for the question form card's own input field — used both
 * when *building* the card (notifyPendingQuestion below) and when
 * *reading* the human's answer back out of the callback payload (the
 * receiving-side example); must match exactly. */
export const LARK_ANSWER_FIELD_TAG = 'answer_input'

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

export class LarkNotifier implements DurableApprover, DurableQuestionHandler {
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
        await this.sendCard(token, card, pendingId)
      } catch (err) {
        console.error(`[loopengine] LarkNotifier: send message failed for pendingId '${pendingId}':`, err)
      }
    })()
    return { pendingId }
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
                { tag: 'input', name: LARK_ANSWER_FIELD_TAG, placeholder: { tag: 'plain_text', content: 'Or type your own answer…' } },
                {
                  tag: 'action',
                  actions: [{ tag: 'button', text: { tag: 'plain_text', content: 'Send' }, type: 'primary', action_type: 'form_submit', value: { pendingId } }],
                },
              ],
            },
          ],
        }
        await this.sendCard(token, card, pendingId)
      } catch (err) {
        console.error(`[loopengine] LarkNotifier: send message failed for pendingId '${pendingId}':`, err)
      }
    })()
    return { pendingId }
  }

  /** Public, not private: core/http-notifier.ts's own onRunStart/onRunFinish
   * lifecycle sender for `channel: 'lark'` calls this directly — a plain
   * text announcement, no buttons, since there's nothing to resolve. */
  postMessage(text: string): void {
    void (async () => {
      try {
        const token = await getTenantAccessToken(this.appId, this.appSecret)
        const card = {
          config: { wide_screen_mode: true },
          elements: [{ tag: 'div', text: { tag: 'lark_md', content: text } }],
        }
        await this.sendCard(token, card, 'lifecycle')
      } catch (err) {
        console.error('[loopengine] LarkNotifier: send message failed for lifecycle announcement:', err)
      }
    })()
  }

  private async sendCard(token: string, card: unknown, pendingId: string): Promise<void> {
    const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ receive_id: this.chatId, msg_type: 'interactive', content: JSON.stringify(card) }),
    })
    const body = (await res.json()) as { code: number; msg: string }
    if (body.code !== 0) console.error(`[loopengine] LarkNotifier: send message failed for pendingId '${pendingId}':`, body.msg)
  }
}
