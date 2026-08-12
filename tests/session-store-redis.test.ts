import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RedisSessionStore } from '../session-store.js'

/** Just enough of ioredis's surface for RedisSessionStore: SET NX PX for
 * acquiring, EVAL for the two Lua scripts (unlock/renew, both "get, compare
 * to token, act"), RPUSH/LRANGE for RedisEntryStorage, QUIT for close().
 * Distinguishes the two scripts by argument count (4 = unlock/DEL, 5 =
 * renew/PEXPIRE — matches exactly how session-store.ts calls each) rather
 * than string-matching script content, so it isn't coupled to the exact
 * Lua text. */
class FakeRedis {
  private store = new Map<string, string>()
  private expiresAt = new Map<string, number>()
  private lists = new Map<string, string[]>()

  /** A key past its TTL reads as absent — real Redis semantics, and the
   * mechanism that makes the renewal tests actually prove something:
   * without renewal actually extending expiresAt, a long enough fn()
   * would hit this and genuinely lose the lock, the same way it would
   * against real Redis. */
  private get(key: string): string | undefined {
    const expiry = this.expiresAt.get(key)
    if (expiry !== undefined && Date.now() >= expiry) {
      this.store.delete(key)
      this.expiresAt.delete(key)
      return undefined
    }
    return this.store.get(key)
  }

  async set(key: string, value: string, _px: 'PX', ttl: number, _nx: 'NX'): Promise<'OK' | null> {
    if (this.get(key) !== undefined) return null
    this.store.set(key, value)
    this.expiresAt.set(key, Date.now() + ttl)
    return 'OK'
  }

  async eval(_script: string, _numKeys: number, key: string, token: string, ...rest: unknown[]): Promise<number> {
    if (this.get(key) !== token) return 0
    if (rest.length === 0) {
      this.store.delete(key) // unlock
      this.expiresAt.delete(key)
    } else {
      this.expiresAt.set(key, Date.now() + (rest[0] as number)) // renew
    }
    return 1
  }

  /** Test-only: simulate the lock's TTL genuinely expiring and a
   * different process's SET NX PX winning the race, without waiting on
   * real (or even fake) wall-clock TTL expiry. */
  forceSteal(key: string): void {
    this.store.set(key, 'someone-elses-token')
    this.expiresAt.delete(key)
  }

  async rpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? []
    list.push(value)
    this.lists.set(key, list)
    return list.length
  }

  async lrange(key: string): Promise<string[]> {
    return this.lists.get(key) ?? []
  }

  async quit(): Promise<'OK'> {
    return 'OK'
  }
}

describe('RedisSessionStore lock renewal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a second request for the same session waiting the whole time, not just until the original TTL would have expired', async () => {
    const fake = new FakeRedis()
    // 300ms TTL -> renews every 100ms (lockTtlMs / 3).
    const store = new RedisSessionStore('unused://', { client: fake as never, lockTtlMs: 300 })

    let firstFinishedAt = -1
    let secondStartedAt = -1

    const first = store.withSession('s1', async () => {
      // Longer than the original TTL — without renewal this expires at
      // t=300ms and the second call below could slip in well before this
      // resolves at ~t=1000ms.
      await new Promise((resolve) => setTimeout(resolve, 1000))
      firstFinishedAt = Date.now()
      return { newMessages: [], result: 'first' }
    })

    // Let the first call actually acquire the lock before the second
    // starts racing for it.
    await vi.advanceTimersByTimeAsync(10)
    const second = store.withSession('s1', async () => {
      secondStartedAt = Date.now()
      return { newMessages: [], result: 'second' }
    })

    await vi.advanceTimersByTimeAsync(1000)
    await Promise.all([first, second])

    expect(secondStartedAt).toBeGreaterThanOrEqual(firstFinishedAt)
    await store.close()
  })

  it('throws after the turn completes if the lock was confirmably stolen mid-flight', async () => {
    const fake = new FakeRedis()
    const store = new RedisSessionStore('unused://', { client: fake as never, lockTtlMs: 300 })

    const work = store.withSession('s1', async () => {
      // Steal the lock partway through — simulates the TTL genuinely
      // expiring and a second concurrent request winning the next SET NX.
      setTimeout(() => fake.forceSteal('session-lock:s1'), 150)
      await new Promise((resolve) => setTimeout(resolve, 500))
      return { newMessages: [], result: 'ok' }
    })
    // Attach the rejection handler before advancing timers, or the
    // rejection (which fires mid-advance) briefly has no handler attached
    // and vitest reports it as an unhandled rejection even though this
    // test does go on to handle it.
    const expectation = expect(work).rejects.toThrow(/lock for session 's1' was lost mid-turn/)

    await vi.advanceTimersByTimeAsync(500)
    await expectation
  })

  it('does not renew (or error) for a turn shorter than the TTL', async () => {
    const fake = new FakeRedis()
    const store = new RedisSessionStore('unused://', { client: fake as never, lockTtlMs: 300 })

    const result = await store.withSession('s1', async () => {
      return { newMessages: [{ role: 'user', content: 'hi' }], result: 'quick' }
    })

    expect(result).toBe('quick')
    await store.close()
  })
})
