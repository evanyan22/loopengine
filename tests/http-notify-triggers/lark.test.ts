import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LarkNotifier as LarkNotifierType } from '#core/http-notify-triggers/lark.js'

function mockFetchSequence(responses: unknown[]) {
  let call = 0
  return vi.fn(async () => new Response(JSON.stringify(responses[call++]), { status: 200 }))
}

describe('LarkNotifier', () => {
  let LarkNotifier: typeof LarkNotifierType
  let LARK_ANSWER_FIELD_TAG: string

  // getTenantAccessToken caches its token in module-level state (by
  // design — see lark.ts's own doc comment) — resetting modules and
  // re-importing fresh between tests is what keeps each test's own fetch
  // call count meaningful, rather than later tests silently hitting an
  // earlier test's cached token.
  beforeEach(async () => {
    vi.resetModules()
    ;({ LarkNotifier, LARK_ANSWER_FIELD_TAG } = await import('#core/http-notify-triggers/lark.js'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requestDurableApproval fetches a tenant token then posts an interactive card with Approve/Deny buttons', async () => {
    const fetchMock = mockFetchSequence([{ code: 0, msg: 'ok', tenant_access_token: 'tok', expire: 7200 }, { code: 0, msg: 'ok' }])
    vi.stubGlobal('fetch', fetchMock)
    const lark = new LarkNotifier({ appId: 'app', appSecret: 'secret', chatId: 'oc_123' })

    const { pendingId } = lark.requestDurableApproval('issue_refund', { amount: 50 }, { tenant: 'acme', environment: 'production', agent: 'support' }, 'ask rule')

    expect(typeof pendingId).toBe('string')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id')
    const body = JSON.parse(init?.body as string)
    expect(body.receive_id).toBe('oc_123')
    const card = JSON.parse(body.content)
    const actions = card.elements.find((e: { tag: string }) => e.tag === 'action')
    expect(actions.actions.map((a: { value: { decision: string } }) => a.value.decision)).toEqual(['approve', 'deny'])
  })

  it('notifyPendingQuestion posts option buttons plus a free-text form using LARK_ANSWER_FIELD_TAG', async () => {
    const fetchMock = mockFetchSequence([{ code: 0, msg: 'ok', tenant_access_token: 'tok', expire: 7200 }, { code: 0, msg: 'ok' }])
    vi.stubGlobal('fetch', fetchMock)
    const lark = new LarkNotifier({ appId: 'app', appSecret: 'secret', chatId: 'oc_123' })

    const { pendingId } = lark.notifyPendingQuestion('Which warehouse?', ['east', 'west'], 'support', 'session-1')

    expect(typeof pendingId).toBe('string')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [, init] = fetchMock.mock.calls[1]
    const body = JSON.parse(init?.body as string)
    const card = JSON.parse(body.content)
    const formElement = card.elements.find((e: { tag: string }) => e.tag === 'form')
    const inputField = formElement.elements.find((e: { tag: string }) => e.tag === 'input')
    expect(inputField.name).toBe(LARK_ANSWER_FIELD_TAG)
  })

  it('postMessage sends a plain text card with no action buttons, for a lifecycle announcement', async () => {
    const fetchMock = mockFetchSequence([{ code: 0, msg: 'ok', tenant_access_token: 'tok', expire: 7200 }, { code: 0, msg: 'ok' }])
    vi.stubGlobal('fetch', fetchMock)
    const lark = new LarkNotifier({ appId: 'app', appSecret: 'secret', chatId: 'oc_123' })

    lark.postMessage('agent started')

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [, init] = fetchMock.mock.calls[1]
    const body = JSON.parse(init?.body as string)
    const card = JSON.parse(body.content)
    expect(card.elements).toEqual([{ tag: 'div', text: { tag: 'lark_md', content: 'agent started' } }])
  })
})
