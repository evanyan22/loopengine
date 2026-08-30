import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlackNotifier } from '#core/http-notify-triggers/slack.js'

describe('SlackNotifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requestDurableApproval posts an interactive Approve/Deny message and returns a pendingId immediately', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const slack = new SlackNotifier({ botToken: 'xoxb-test', channelId: 'C123' })

    const { pendingId } = slack.requestDurableApproval('issue_refund', { amount: 50 }, { tenant: 'acme', environment: 'production', agent: 'support' }, 'ask rule')

    expect(typeof pendingId).toBe('string')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    const body = JSON.parse(init?.body as string)
    expect(body.channel).toBe('C123')
    const actionsBlock = body.blocks.find((b: { type: string }) => b.type === 'actions')
    expect(actionsBlock.elements.map((e: { action_id: string; value: string }) => [e.action_id, e.value])).toEqual([
      ['approve', pendingId],
      ['deny', pendingId],
    ])
  })

  it('notifyPendingQuestion posts option buttons plus an "Other…" fallback and returns a pendingId immediately', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const slack = new SlackNotifier({ botToken: 'xoxb-test', channelId: 'C123' })

    const { pendingId } = slack.notifyPendingQuestion('Which warehouse?', ['east', 'west'], 'support', 'session-1')

    expect(typeof pendingId).toBe('string')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init?.body as string)
    const actionsBlock = body.blocks.find((b: { type: string }) => b.type === 'actions')
    const actionIds = actionsBlock.elements.map((e: { action_id: string }) => e.action_id)
    expect(actionIds).toEqual(['answer_option', 'answer_option', 'open_answer_modal'])
  })

  it('postMessage omits blocks entirely when called with none, for a plain lifecycle announcement', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const slack = new SlackNotifier({ botToken: 'xoxb-test', channelId: 'C123' })

    slack.postMessage('agent started')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const [, init] = fetchMock.mock.calls[0]
    const body = JSON.parse(init?.body as string)
    expect(body).toEqual({ channel: 'C123', text: 'agent started' })
  })

  it('logs, rather than throws, when chat.postMessage reports ok: false', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const slack = new SlackNotifier({ botToken: 'xoxb-test', channelId: 'bad-channel' })

    slack.postMessage('hi')
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('chat.postMessage failed'), 'channel_not_found'))
  })
})
