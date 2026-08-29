import { describe, expect, it } from 'vitest'
import { RedisCheckpointStore, type CreateCheckpointInput } from '../core/durable-approvals.js'

/** Just enough of ioredis's surface for RedisCheckpointStore: plain
 * GET/SET/DEL, and SET with PX/NX for the lock, plus EVAL for the
 * compare-and-delete unlock script — same "distinguish by shape, not by
 * string-matching Lua" spirit as session-store-redis.test.ts's own
 * FakeRedis. */
class FakeRedis {
  private store = new Map<string, string>()

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }

  async set(key: string, value: string, ...rest: unknown[]): Promise<'OK' | null> {
    if (rest[rest.length - 1] === 'NX' && this.store.has(key)) return null
    this.store.set(key, value)
    return 'OK'
  }

  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0
  }

  async eval(_script: string, _numKeys: number, key: string, token: string): Promise<number> {
    if (this.store.get(key) !== token) return 0
    this.store.delete(key)
    return 1
  }

  async quit(): Promise<'OK'> {
    return 'OK'
  }
}

function makeInput(overrides: Partial<CreateCheckpointInput> = {}): CreateCheckpointInput {
  return {
    sessionId: 's1',
    agent: 'customer-service',
    tenant: 'default',
    resultsSoFar: [],
    outstanding: { p1: { toolUseId: 't2', tool: 'issue_refund', args: { amount: 900 }, reason: 'matched rule' } },
    ...overrides,
  }
}

describe('RedisCheckpointStore', () => {
  it('creates a checkpoint reachable by its pendingId', async () => {
    const store = new RedisCheckpointStore('unused://', new FakeRedis() as never)
    const created = await store.create(makeInput())

    const seen = await store.withCheckpoint('p1', async (checkpoint) => ({ checkpoint, result: checkpoint }))
    expect(seen).toEqual(created)
    await store.close()
  })

  it('passes undefined to fn for an unknown pendingId', async () => {
    const store = new RedisCheckpointStore('unused://', new FakeRedis() as never)
    const seen = await store.withCheckpoint('nonexistent', async (checkpoint) => ({ checkpoint, result: checkpoint }))
    expect(seen).toBeUndefined()
    await store.close()
  })

  it('removes a checkpoint and its pending index entries once fn marks it closed', async () => {
    const fake = new FakeRedis()
    const store = new RedisCheckpointStore('unused://', fake as never)
    await store.create(makeInput({ outstanding: { p1: { toolUseId: 't2', tool: 'a', args: {}, reason: 'r' }, p2: { toolUseId: 't3', tool: 'b', args: {}, reason: 'r' } } }))

    await store.withCheckpoint('p1', async (checkpoint) => ({ checkpoint: { ...checkpoint!, closed: true }, result: undefined }))

    expect(await store.withCheckpoint('p1', async (c) => ({ checkpoint: c, result: c }))).toBeUndefined()
    expect(await store.withCheckpoint('p2', async (c) => ({ checkpoint: c, result: c }))).toBeUndefined()
    await store.close()
  })

  it('serializes concurrent withCheckpoint calls for the same checkpoint', async () => {
    const store = new RedisCheckpointStore('unused://', new FakeRedis() as never)
    await store.create(makeInput({ outstanding: { p1: { toolUseId: 't2', tool: 'a', args: {}, reason: 'r' }, p2: { toolUseId: 't3', tool: 'b', args: {}, reason: 'r' } } }))
    const order: string[] = []

    const first = store.withCheckpoint('p1', async (checkpoint) => {
      order.push('first:start')
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push('first:end')
      return { checkpoint, result: undefined }
    })
    const second = store.withCheckpoint('p2', async (checkpoint) => {
      order.push('second:start')
      return { checkpoint, result: undefined }
    })

    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
    await store.close()
  })
})
