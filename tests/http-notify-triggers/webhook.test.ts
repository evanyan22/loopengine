import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebhookNotifier, postLifecycleWebhook } from '#core/http-notify-triggers/webhook.js'

function verify(rawBody: string, signatureHeader: string, signingSecret: string): boolean {
  const expected = `sha256=${createHmac('sha256', signingSecret).update(rawBody).digest('hex')}`
  return expected === signatureHeader
}

describe('WebhookNotifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requestDurableApproval posts a signed X-Actauth-Signature payload and returns a pendingId immediately', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const webhook = new WebhookNotifier({ webhookUrl: 'https://example.com/hook', signingSecret: 'shh' })

    const { pendingId } = webhook.requestDurableApproval(
      'issue_refund',
      { amount: 50 },
      { tenant: 'acme', environment: 'production', agent: 'support' },
      'ask rule',
    )

    expect(typeof pendingId).toBe('string')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.com/hook')
    const body = init?.body as string
    const headers = init?.headers as Record<string, string>
    expect(verify(body, headers['X-Actauth-Signature'], 'shh')).toBe(true)
    expect(JSON.parse(body)).toMatchObject({ pendingId, tool: 'issue_refund', args: { amount: 50 }, reason: 'ask rule' })
  })

  it('notifyPendingQuestion posts a signed X-Askuser-Signature payload and returns a pendingId immediately', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const webhook = new WebhookNotifier({ webhookUrl: 'https://example.com/hook', signingSecret: 'shh' })

    const { pendingId } = webhook.notifyPendingQuestion('Which warehouse?', ['east', 'west'], 'support', 'session-1')

    expect(typeof pendingId).toBe('string')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [, init] = fetchMock.mock.calls[0]
    const body = init?.body as string
    const headers = init?.headers as Record<string, string>
    expect(verify(body, headers['X-Askuser-Signature'], 'shh')).toBe(true)
    expect(JSON.parse(body)).toMatchObject({ pendingId, question: 'Which warehouse?', options: ['east', 'west'], agent: 'support', sessionId: 'session-1' })
  })

  it('logs, rather than throws, when webhook delivery rejects', async () => {
    const fetchMock = vi.fn(async () => Promise.reject(new Error('network down')))
    vi.stubGlobal('fetch', fetchMock)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const webhook = new WebhookNotifier({ webhookUrl: 'https://example.com/hook', signingSecret: 'shh' })

    const { pendingId } = webhook.requestDurableApproval('t', {}, { tenant: 'acme', environment: 'production', agent: 'a' }, 'r')

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(`webhook delivery failed for pendingId '${pendingId}'`), expect.any(Error)))
  })
})

describe('postLifecycleWebhook', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('signs the payload with X-Lifecycle-Signature over the raw JSON body', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    postLifecycleWebhook('https://example.com/hook', 'shh', 'run_finish', { agent: 'test-agent', text: 'done' })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.com/hook')
    const body = init?.body as string
    const headers = init?.headers as Record<string, string>
    expect(verify(body, headers['X-Lifecycle-Signature'], 'shh')).toBe(true)
    expect(JSON.parse(body)).toMatchObject({ event: 'run_finish', agent: 'test-agent', text: 'done' })
  })
})
