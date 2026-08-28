import { describe, expect, it } from 'vitest'
import { KeyedMutex } from '../core/session-store.js'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('KeyedMutex', () => {
  it('serializes calls for the same key', async () => {
    const mutex = new KeyedMutex()
    const order: string[] = []

    const first = mutex.run('k1', async () => {
      order.push('first:start')
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push('first:end')
      return 'a'
    })
    const second = mutex.run('k1', async () => {
      order.push('second:start')
      return 'b'
    })

    expect(await Promise.all([first, second])).toEqual(['a', 'b'])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('does not serialize calls for different keys', async () => {
    const mutex = new KeyedMutex()
    const order: string[] = []
    const gate = deferred<void>()

    const first = mutex.run('k1', async () => {
      order.push('k1:start')
      await gate.promise // held open until we say so
      order.push('k1:end')
    })
    const second = mutex.run('k2', async () => {
      order.push('k2:start')
    })

    await second // k2 must not be blocked behind k1's still-open gate
    expect(order).toEqual(['k1:start', 'k2:start'])

    gate.resolve()
    await first
  })

  it('removes a key from its internal map once nothing is queued behind it (no permanent leak)', async () => {
    const mutex = new KeyedMutex()

    await mutex.run('k1', async () => 'a')
    // run()'s cleanup is attached via .then() on the settled promise, so
    // it fires on a later microtask than the awaited result itself —
    // give it a tick to run.
    await Promise.resolve()

    expect(mutex.size()).toBe(0)
  })

  it('does not leak even with several calls chained on the same key', async () => {
    const mutex = new KeyedMutex()

    await Promise.all([
      mutex.run('k1', async () => 'a'),
      mutex.run('k1', async () => 'b'),
      mutex.run('k1', async () => 'c'),
    ])
    await Promise.resolve()
    await Promise.resolve() // one extra tick — later-queued calls' cleanup resolves one microtask later each

    expect(mutex.size()).toBe(0)
  })

  it('keeps a key\'s entry around while work is still queued behind it, not just while the first call runs', async () => {
    const mutex = new KeyedMutex()
    const gate = deferred<void>()

    const first = mutex.run('k1', async () => {
      await gate.promise
      return 'a'
    })
    const second = mutex.run('k1', async () => 'b') // queued behind first

    // first hasn't resolved yet, so nothing has settled — expected.
    expect(mutex.size()).toBe(1)

    gate.resolve()
    await Promise.all([first, second])
    await Promise.resolve()

    expect(mutex.size()).toBe(0)
  })

  it('creates a fresh entry for a key reused after it was previously cleaned up', async () => {
    const mutex = new KeyedMutex()

    await mutex.run('k1', async () => 'a')
    await Promise.resolve()
    expect(mutex.size()).toBe(0)

    const result = await mutex.run('k1', async () => 'b')
    expect(result).toBe('b')
  })
})
