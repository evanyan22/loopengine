// The Slack channel's *receiving* side — verifying a Slack Interactivity
// callback and dispatching it back into loopengine's own resolve/answer
// routes. The *sending* side needs no example anymore: `AgentConfig.httpNotifier`'s
// `channel: 'slack'` already builds it for you (`core/http-notifier.ts`
// constructs `core/http-notify-triggers/slack.ts`'s `SlackNotifier` — one
// instance implementing both `DurableApprover` and `DurableQuestionHandler`,
// posting an interactive Approve/Deny or option-buttons-plus-"Other…"
// message via `chat.postMessage`), from one `{botToken, channelId}`.
// Import `SlackNotifier` directly instead, only if you need it as
// a `RunAgentOptions.approver`/`questionHandler` value rather than
// through `AgentConfig`.
//
// What this file is for, and the one thing that genuinely IS still yours
// to deploy: the route wired up as your Slack app's own "Interactivity
// Request URL" — an HTTP endpoint only the host can deploy, same
// "sending built for you, receiving you deploy" split every other
// channel here has. `handleInteraction` below is the *only* route you
// need, regardless of whether the batch being resolved came from an
// approval or a question notification — Slack itself never distinguishes
// the two at the transport level (both arrive as a `block_actions` or
// `view_submission` payload at the exact same URL), so neither does this.
import { createHmac, timingSafeEqual } from 'node:crypto'

// Fixed ids for the question-answer modal's own text input block — used
// both when *building* the modal (SlackNotifier's own
// notifyPendingQuestion) and when *reading* the human's answer back out
// of Slack's view_submission payload (below); they have to match exactly.
const ANSWER_BLOCK_ID = 'answer_block'
const ANSWER_ACTION_ID = 'answer_input'

export class SlackNotifierHandler {
  private readonly botToken: string
  private readonly signingSecret: string

  /** `botToken` is only needed here for `open_answer_modal` below
   * (`views.open` needs the same bot credential `SlackNotifier`'s
   * own sending side already has) — pass the same one. */
  constructor(options: { botToken: string; signingSecret: string }) {
    this.botToken = options.botToken
    this.signingSecret = options.signingSecret
  }

  /** Call this from the route wired up as your Slack app's own
   * "Interactivity Request URL". `rawBody` is the exact, unparsed request
   * body (signature verification is over the raw bytes). `loopengineAdminAuth`
   * is the same `user:pass` string set as `LOOPENGINE_ADMIN_AUTH` on the
   * loopengine server itself, since both `/pending-approvals/:id/resolve`
   * and `/pending-questions/:id/answer` sit behind that same Basic Auth
   * as every other route there. */
  async handleInteraction(
    rawBody: string,
    headers: { timestamp: string | undefined; signature: string | undefined },
    options: { loopengineBaseUrl: string; loopengineAdminAuth?: string },
  ): Promise<void> {
    if (!this.verifySignature(rawBody, headers.timestamp, headers.signature)) {
      throw new Error('SlackNotifierHandler: invalid Slack request signature')
    }

    const payloadRaw = new URLSearchParams(rawBody).get('payload')
    if (!payloadRaw) return
    const payload = JSON.parse(payloadRaw) as {
      type: 'block_actions' | 'view_submission'
      trigger_id?: string
      response_url?: string
      actions?: { action_id: string; value: string }[]
      view?: { private_metadata: string; state: { values: Record<string, Record<string, { value?: string }>> } }
    }

    if (payload.type === 'view_submission' && payload.view) {
      const pendingId = payload.view.private_metadata
      const answer = payload.view.state.values[ANSWER_BLOCK_ID]?.[ANSWER_ACTION_ID]?.value ?? ''
      await this.callLoopengine(`/pending-questions/${encodeURIComponent(pendingId)}/answer`, { answer }, options)
      return
    }

    if (payload.type !== 'block_actions') return
    const action = payload.actions?.[0]
    if (!action) return

    // One dispatcher for both concerns, keyed by action_id — approval and
    // question interactions were never really a different *mechanism* on
    // Slack's side, only a different shape of answer (see
    // core/http-notify-triggers/slack.ts's own doc comment on the sending side for the
    // full version of this reasoning).
    switch (action.action_id) {
      case 'approve':
      case 'deny': {
        const decision = action.action_id
        const body = await this.callLoopengine(`/pending-approvals/${encodeURIComponent(action.value)}/resolve`, { decision }, options)
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
        return
      }
      case 'answer_option': {
        const { pendingId, answer } = JSON.parse(action.value) as { pendingId: string; answer: string }
        await this.callLoopengine(`/pending-questions/${encodeURIComponent(pendingId)}/answer`, { answer }, options)
        return
      }
      case 'open_answer_modal': {
        await fetch('https://slack.com/api/views.open', {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.botToken}`, 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({
            trigger_id: payload.trigger_id,
            view: {
              type: 'modal',
              callback_id: 'answer_modal',
              private_metadata: action.value,
              title: { type: 'plain_text', text: 'Your answer' },
              submit: { type: 'plain_text', text: 'Send' },
              blocks: [
                {
                  type: 'input',
                  block_id: ANSWER_BLOCK_ID,
                  label: { type: 'plain_text', text: 'Answer' },
                  element: { type: 'plain_text_input', action_id: ANSWER_ACTION_ID, multiline: true },
                },
              ],
            },
          }),
        })
        return
      }
    }
  }

  /** https://api.slack.com/authentication/verifying-requests-from-slack */
  private verifySignature(rawBody: string, timestamp: string | undefined, signature: string | undefined): boolean {
    if (!timestamp || !signature) return false
    const age = Math.abs(Date.now() / 1000 - Number(timestamp))
    if (!Number.isFinite(age) || age > 60 * 5) return false
    const hmac = createHmac('sha256', this.signingSecret)
    hmac.update(`v0:${timestamp}:${rawBody}`)
    const expected = Buffer.from(`v0=${hmac.digest('hex')}`)
    const actual = Buffer.from(signature)
    return expected.length === actual.length && timingSafeEqual(expected, actual)
  }

  /** Shared by every branch of handleInteraction above that ultimately
   * decides or answers something. */
  private async callLoopengine(
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
    if (!res.ok) throw new Error(`SlackNotifierHandler: ${path} failed: ${resBody.error ?? res.status}`)
    return resBody
  }
}

// --- Wiring, illustrative only ---
//
// AgentConfig.httpNotifier builds the sending side — nothing to write:
//
// httpNotifier: {
//   channel: 'slack',
//   config: { botToken: process.env.SLACK_BOT_TOKEN!, channelId: process.env.SLACK_CHANNEL_ID! },
//   events: ['approval', 'question'],
// }
//
// import { createServer } from 'node:http'
//
// const handler = new SlackNotifierHandler({
//   botToken: process.env.SLACK_BOT_TOKEN!,
//   signingSecret: process.env.SLACK_SIGNING_SECRET!,
// })
//
// createServer((req, res) => {
//   let body = ''
//   req.on('data', (chunk) => (body += chunk))
//   req.on('end', async () => {
//     try {
//       await handler.handleInteraction(
//         body,
//         { timestamp: req.headers['x-slack-request-timestamp'] as string, signature: req.headers['x-slack-signature'] as string },
//         { loopengineBaseUrl: 'http://localhost:8787', loopengineAdminAuth: process.env.LOOPENGINE_ADMIN_AUTH },
//       )
//       res.writeHead(200).end()
//     } catch (err) {
//       res.writeHead(401).end(String(err))
//     }
//   })
// }).listen(3001) // one route, since Slack was always sending everything here regardless
