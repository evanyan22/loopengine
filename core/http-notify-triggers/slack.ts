// The *sending* half of a Slack-backed DurableApprover/DurableQuestionHandler,
// real, maintained core/ code so AgentConfig.httpNotifier
// (core/http-notifier.ts) can construct one directly for `channel:
// 'slack'`, the same way it already constructs actauth's own
// WebhookApprover for `channel: 'webhook'`. Not "DurableSlackNotifier":
// unlike the Web/Webhook pair, there's no live "SlackNotifier" this name
// could collide with (Slack's own *live* approver, actauth's
// `SlackChatApprover`, has an entirely different name already) — durable is
// just what a Slack-backed notifier defaults to being, so the name
// doesn't need to say so.
//
// The *receiving* side — verifying a Slack Interactivity payload really
// came from Slack, then dispatching approve/deny/answer back into
// loopengine's own resolve/answer routes — deliberately stays out of
// core and out of this class: that's an HTTP endpoint only the host can
// deploy (it needs a route, a public URL, Slack app configuration), the
// same "sending built for you, receiving you deploy" split every other
// durable channel in this repo has. See
// examples/notifier-handler/slack.ts's own `SlackNotifierHandler` for
// that half.
//
// One class for both concerns, not two: nothing about what a Slack
// integration needs to send is approval-specific or question-specific,
// it's Slack-specific (the bot token, the channel, the chat.postMessage
// call shape).
import { randomUUID } from 'node:crypto'
import type { DurableApprover, Scope } from 'actauth'
import type { DurableQuestionHandler } from '../agent-config.js'

export class SlackNotifier implements DurableApprover, DurableQuestionHandler {
  private readonly botToken: string
  private readonly channelId: string

  constructor(options: { botToken: string; channelId: string }) {
    this.botToken = options.botToken
    this.channelId = options.channelId
  }

  requestDurableApproval(tool: string, args: Record<string, unknown>, scope: Scope, reason: string): { pendingId: string } {
    const pendingId = randomUUID()
    this.postMessage(`Approval requested: ${tool} on ${scope.tenant}/${scope.environment}/${scope.agent}`, [
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
    ])
    return { pendingId }
  }

  notifyPendingQuestion(question: string, options: string[] | undefined, agent: string, sessionId: string | undefined): { pendingId: string } {
    const pendingId = randomUUID()
    const optionButtons = (options ?? []).map((option) => ({
      type: 'button',
      text: { type: 'plain_text', text: option },
      value: JSON.stringify({ pendingId, answer: option }),
      action_id: 'answer_option',
    }))
    this.postMessage(`Question from ${agent}: ${question}`, [
      { type: 'section', text: { type: 'mrkdwn', text: `*Question from ${agent}${sessionId ? ` (session ${sessionId})` : ''}:*\n${question}` } },
      { type: 'actions', elements: [...optionButtons, { type: 'button', text: { type: 'plain_text', text: 'Other…' }, action_id: 'open_answer_modal', value: pendingId }] },
    ])
    return { pendingId }
  }

  /** Public, not private: core/http-notifier.ts's own onRunStart/onRunFinish
   * lifecycle sender for `channel: 'slack'` calls this directly with no
   * `blocks` — a plain announcement, since there's nothing to resolve and
   * so nothing to attach buttons to. */
  postMessage(text: string, blocks?: unknown[]): void {
    // Not awaited — both requestDurableApproval/notifyPendingQuestion
    // above return immediately, by contract (see DurableApprover's own
    // doc comment); a delivery failure here has no synchronous way to
    // surface to either caller, so it's logged instead of thrown.
    fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.botToken}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: this.channelId, text, ...(blocks ? { blocks } : {}) }),
    })
      .then((res) => res.json() as Promise<{ ok: boolean; error?: string }>)
      .then((body) => {
        if (!body.ok) console.error('[loopengine] SlackNotifier: chat.postMessage failed:', body.error)
      })
      .catch((err) => {
        console.error('[loopengine] SlackNotifier: chat.postMessage failed:', err)
      })
  }
}
