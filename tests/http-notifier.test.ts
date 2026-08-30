import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveHttpNotifier } from '#core/http-notifier.js'
import { isDurableApprover } from 'actauth'
import { isDurableQuestionHandler } from '#core/system-tools/index.js'
import { InMemoryPendingApprovalsRepository } from '#core/http-notify-triggers/database.js'
import type { AgentConfig } from '#core/agent-config.js'

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { name: 'test-agent', systemPrompt: 'test', rules: [], defaultDecision: 'deny', ...overrides }
}

describe('resolveHttpNotifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns nothing at all when AgentConfig.httpNotifier is unset', () => {
    expect(resolveHttpNotifier(baseConfig())).toEqual({})
  })

  it('only populates the fields listed in events', () => {
    const config = baseConfig({
      httpNotifier: { channel: 'webhook', config: { webhookUrl: 'https://example.com/hook', webhookSecret: 'shh' }, events: ['approval'] },
    })
    const resolved = resolveHttpNotifier(config)
    expect(resolved.approver).toBeDefined()
    expect(isDurableApprover(resolved.approver!)).toBe(true)
    expect(resolved.questionHandler).toBeUndefined()
    expect(resolved.onRunStart).toBeUndefined()
    expect(resolved.onRunFinish).toBeUndefined()
  })

  it('populates all four when all four events are listed', () => {
    const config = baseConfig({
      httpNotifier: {
        channel: 'webhook',
        config: { webhookUrl: 'https://example.com/hook', webhookSecret: 'shh' },
        events: ['approval', 'question', 'agentStart', 'agentFinish'],
      },
    })
    const resolved = resolveHttpNotifier(config)
    expect(isDurableApprover(resolved.approver!)).toBe(true)
    expect(isDurableQuestionHandler(resolved.questionHandler!)).toBe(true)
    expect(resolved.onRunStart).toBeInstanceOf(Function)
    expect(resolved.onRunFinish).toBeInstanceOf(Function)
  })

  it('memoizes per AgentConfig object, so the same instances are reused across calls', () => {
    const config = baseConfig({
      httpNotifier: { channel: 'webhook', config: { webhookUrl: 'https://example.com/hook', webhookSecret: 'shh' }, events: ['approval'] },
    })
    expect(resolveHttpNotifier(config)).toBe(resolveHttpNotifier(config))
  })

  it('signs onRunFinish deliveries with X-Lifecycle-Signature over the raw JSON body', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const config = baseConfig({
      httpNotifier: { channel: 'webhook', config: { webhookUrl: 'https://example.com/hook', webhookSecret: 'shh' }, events: ['agentFinish'] },
    })

    resolveHttpNotifier(config).onRunFinish!({ agent: 'test-agent', tenant: 'default', text: 'done', sessionId: 's1' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.com/hook')
    const headers = init?.headers as Record<string, string>
    expect(headers['X-Lifecycle-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
    const body = JSON.parse(init?.body as string)
    expect(body).toMatchObject({ event: 'run_finish', agent: 'test-agent', text: 'done', sessionId: 's1' })
  })

  it('builds a SlackNotifier for channel: "slack", sharing one instance across approver/questionHandler', () => {
    const config = baseConfig({
      httpNotifier: {
        channel: 'slack',
        config: { botToken: 'xoxb-test', channelId: 'C123' },
        events: ['approval', 'question'],
      },
    })
    const resolved = resolveHttpNotifier(config)
    expect(isDurableApprover(resolved.approver!)).toBe(true)
    expect(isDurableQuestionHandler(resolved.questionHandler!)).toBe(true)
    // Same underlying object, not two separate SlackNotifier
    // instances — see resolveHttpNotifier's own comment on why one is
    // enough (Slack itself doesn't distinguish the two concerns).
    expect(resolved.approver).toBe(resolved.questionHandler)
  })

  it('posts a plain chat.postMessage announcement for Slack onRunStart/onRunFinish, with no interactive buttons', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const config = baseConfig({
      httpNotifier: {
        channel: 'slack',
        config: { botToken: 'xoxb-test', channelId: 'C123' },
        events: ['agentStart', 'agentFinish'],
      },
    })

    resolveHttpNotifier(config).onRunStart!({ agent: 'test-agent', tenant: 'default', trigger: 'message' })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://slack.com/api/chat.postMessage')
    const headers = init?.headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer xoxb-test')
    const body = JSON.parse(init?.body as string)
    expect(body.channel).toBe('C123')
    expect(body.text).toContain('test-agent')
    expect(body.blocks).toBeUndefined()
  })

  it('builds a LarkNotifier for channel: "lark", sharing one instance across approver/questionHandler', () => {
    const config = baseConfig({
      httpNotifier: {
        channel: 'lark',
        config: { appId: 'app', appSecret: 'secret', chatId: 'oc_123' },
        events: ['approval', 'question'],
      },
    })
    const resolved = resolveHttpNotifier(config)
    expect(isDurableApprover(resolved.approver!)).toBe(true)
    expect(isDurableQuestionHandler(resolved.questionHandler!)).toBe(true)
    expect(resolved.approver).toBe(resolved.questionHandler)
  })

  it('builds a EmailNotifier for channel: "email", sharing one instance across approver/questionHandler', () => {
    const config = baseConfig({
      httpNotifier: {
        channel: 'email',
        config: {
          to: 'oncall@example.com',
          sendEmail: async () => {},
          resolveBaseUrl: 'https://app.example.com/approvals',
          answerBaseUrl: 'https://app.example.com/questions',
          signingSecret: 'shh',
        },
        events: ['approval', 'question'],
      },
    })
    const resolved = resolveHttpNotifier(config)
    expect(isDurableApprover(resolved.approver!)).toBe(true)
    expect(isDurableQuestionHandler(resolved.questionHandler!)).toBe(true)
    expect(resolved.approver).toBe(resolved.questionHandler)
  })

  it('builds a DatabaseApprover for channel: "database", with no questionHandler/lifecycle hooks at all', () => {
    const config = baseConfig({
      httpNotifier: {
        channel: 'database',
        config: { repository: new InMemoryPendingApprovalsRepository() },
        events: ['approval'],
      },
    })
    const resolved = resolveHttpNotifier(config)
    expect(isDurableApprover(resolved.approver!)).toBe(true)
    expect(resolved.questionHandler).toBeUndefined()
    expect(resolved.onRunStart).toBeUndefined()
    expect(resolved.onRunFinish).toBeUndefined()
  })

  it('builds a RedisQueueApprover for channel: "redis", with no questionHandler/lifecycle hooks at all', () => {
    const fakeRedis = { rpush: async () => 1 }
    const config = baseConfig({
      httpNotifier: {
        channel: 'redis',
        config: { redis: fakeRedis as never },
        events: ['approval'],
      },
    })
    const resolved = resolveHttpNotifier(config)
    expect(isDurableApprover(resolved.approver!)).toBe(true)
    expect(resolved.questionHandler).toBeUndefined()
    expect(resolved.onRunStart).toBeUndefined()
    expect(resolved.onRunFinish).toBeUndefined()
  })

  it('leaves approver undefined for "database"/"redis" when events omits "approval" — the only event either channel does anything with', () => {
    const config = baseConfig({
      httpNotifier: { channel: 'database', config: { repository: new InMemoryPendingApprovalsRepository() }, events: [] },
    })
    expect(resolveHttpNotifier(config).approver).toBeUndefined()
  })
})
