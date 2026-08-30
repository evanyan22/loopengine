import { describe, expect, it, vi } from 'vitest'
import { RedisQueueApprover, consumePendingApprovals } from '#core/http-notify-triggers/redis.js'

/** Just enough of ioredis's surface for RedisQueueApprover/
 * consumePendingApprovals: RPUSH to enqueue, BLPOP to drain — same
 * "fake, not a mock library, cast `as never`" pattern
 * tests/session-store-redis.test.ts's own FakeRedis already uses. */
class FakeRedis {
  private readonly queue: string[] = []

  async rpush(_key: string, value: string): Promise<number> {
    this.queue.push(value)
    return this.queue.length
  }

  async blpop(_key: string, _timeoutSeconds: number): Promise<[string, string] | null> {
    const value = this.queue.shift()
    return value === undefined ? null : ['durable-approvals:queue', value]
  }
}

describe('RedisQueueApprover', () => {
  it('pushes a queued entry and returns a pendingId immediately, drainable via consumePendingApprovals', async () => {
    const fake = new FakeRedis()
    const approver = new RedisQueueApprover({ redis: fake as never })

    const { pendingId } = approver.requestDurableApproval(
      'issue_refund',
      { amount: 50 },
      { tenant: 'acme', environment: 'production', agent: 'support' },
      'ask rule',
    )

    expect(typeof pendingId).toBe('string')
    // Not racy: FakeRedis.rpush/blpop above have no `await` in their own
    // bodies, so the push already landed synchronously before
    // requestDurableApproval returned — no need to wait for it.
    const iterator = consumePendingApprovals(fake as never)
    const { value, done } = await iterator.next()
    expect(done).toBe(false)
    expect(value).toMatchObject({ pendingId, tool: 'issue_refund', args: { amount: 50 } })
  })

  it('logs, rather than throws, when the rpush call rejects', async () => {
    const failingRedis = { rpush: async () => Promise.reject(new Error('redis down')) }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const approver = new RedisQueueApprover({ redis: failingRedis as never })

    const { pendingId } = approver.requestDurableApproval('issue_refund', {}, { tenant: 'acme', environment: 'production', agent: 'support' }, 'ask rule')

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(`rpush failed for pendingId '${pendingId}'`), expect.any(Error)))
  })
})
