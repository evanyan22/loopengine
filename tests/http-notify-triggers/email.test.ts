import { describe, expect, it, vi } from 'vitest'
import { EmailNotifier, verifyMagicLink } from '#core/http-notify-triggers/email.js'

function baseOptions() {
  return { to: 'oncall@example.com', resolveBaseUrl: 'https://app.example.com/approvals', answerBaseUrl: 'https://app.example.com/questions', signingSecret: 'shh' }
}

describe('EmailNotifier', () => {
  it('requestDurableApproval emails an Approve/Deny link pair, each verifiable via verifyMagicLink', async () => {
    const sendEmail = vi.fn(async () => {})
    const notifier = new EmailNotifier({ ...baseOptions(), sendEmail })

    const { pendingId } = notifier.requestDurableApproval('issue_refund', { amount: 50 }, { tenant: 'acme', environment: 'production', agent: 'support' }, 'ask rule')

    expect(typeof pendingId).toBe('string')
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1))
    const [to, subject, html] = sendEmail.mock.calls[0] as [string, string, string]
    expect(to).toBe('oncall@example.com')
    expect(subject).toContain('issue_refund')
    const approveToken = new URL(html.match(/href="([^"]+)">Approve/)![1]).searchParams.get('token')!
    const denyToken = new URL(html.match(/href="([^"]+)">Deny/)![1]).searchParams.get('token')!
    expect(verifyMagicLink(approveToken, 'shh')).toMatchObject({ pendingId, decision: 'approve' })
    expect(verifyMagicLink(denyToken, 'shh')).toMatchObject({ pendingId, decision: 'deny' })
  })

  it('notifyPendingQuestion emails one link per suggested option plus a free-text link', async () => {
    const sendEmail = vi.fn(async () => {})
    const notifier = new EmailNotifier({ ...baseOptions(), sendEmail })

    const { pendingId } = notifier.notifyPendingQuestion('Which warehouse?', ['east', 'west'], 'support', 'session-1')

    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1))
    const [, , html] = sendEmail.mock.calls[0] as [string, string, string]
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1])
    expect(hrefs).toHaveLength(3) // east, west, free-text
    const tokens = hrefs.map((href) => new URL(href).searchParams.get('token')!)
    expect(verifyMagicLink(tokens[0], 'shh')).toMatchObject({ pendingId, answer: 'east' })
    expect(verifyMagicLink(tokens[1], 'shh')).toMatchObject({ pendingId, answer: 'west' })
    const freeTextPayload = verifyMagicLink(tokens[2], 'shh')
    expect(freeTextPayload?.pendingId).toBe(pendingId)
    expect(freeTextPayload?.answer).toBeUndefined()
  })

  it('sendAnnouncement sends a plain email with no magic link, for a lifecycle event', async () => {
    const sendEmail = vi.fn(async () => {})
    const notifier = new EmailNotifier({ ...baseOptions(), sendEmail })

    notifier.sendAnnouncement('agent started', 'test-agent started')

    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledWith('oncall@example.com', 'agent started', '<p>test-agent started</p>'))
  })

  it('verifyMagicLink rejects a tampered token', async () => {
    const sendEmail = vi.fn(async () => {})
    const notifier = new EmailNotifier({ ...baseOptions(), sendEmail })
    notifier.requestDurableApproval('t', {}, { tenant: 'acme', environment: 'production', agent: 'a' }, 'r')
    await vi.waitFor(() => expect(sendEmail).toHaveBeenCalledTimes(1))
    const html = sendEmail.mock.calls[0][2] as string
    const token = new URL(html.match(/href="([^"]+)">Approve/)![1]).searchParams.get('token')!

    const tampered = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a')
    expect(verifyMagicLink(tampered, 'shh')).toBeNull()
  })

  it('verifyMagicLink rejects an expired token', async () => {
    vi.useFakeTimers()
    const sendEmail = vi.fn(async () => {})
    const notifier = new EmailNotifier({ ...baseOptions(), sendEmail, linkTtlMs: 1000 })
    notifier.requestDurableApproval('issue_refund', {}, { tenant: 'acme', environment: 'production', agent: 'support' }, 'ask rule')
    // sendEmail is called fire-and-forget, synchronously reachable here
    // since nothing in EmailNotifier's own send path awaits a
    // timer — no real async gap for fake timers to need advancing past
    // yet.
    expect(sendEmail).toHaveBeenCalledTimes(1)
    const html = sendEmail.mock.calls[0][2] as string
    const token = new URL(html.match(/href="([^"]+)">Approve/)![1]).searchParams.get('token')!

    vi.advanceTimersByTime(1001)
    expect(verifyMagicLink(token, 'shh')).toBeNull()
    vi.useRealTimers()
  })
})
