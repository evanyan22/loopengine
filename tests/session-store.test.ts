import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { FileStorage } from 'sessionknit'
import type { Message } from 'contextclip'
import { FileSessionStore } from '../session-store.js'

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loopengine-session-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('FileSessionStore', () => {
  it('starts a new session with empty history', async () => {
    const store = new FileSessionStore(tmpDir())
    const seen: Message[][] = []

    await store.withSession('s1', async (history) => {
      seen.push(history)
      return { history: [...history, { role: 'user', content: 'hi' }], result: null }
    })

    expect(seen).toEqual([[]])
    await store.close()
  })

  it('persists appended messages so the next withSession call resumes them', async () => {
    const dir = tmpDir()
    const store = new FileSessionStore(dir)

    await store.withSession('s1', async (history) => ({
      history: [...history, { role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }],
      result: null,
    }))

    const seen: Message[][] = []
    await store.withSession('s1', async (history) => {
      seen.push(history)
      return { history, result: null }
    })

    expect(seen[0]).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
    ])
    await store.close()
  })

  it('keeps different sessionIds independent', async () => {
    const store = new FileSessionStore(tmpDir())

    await store.withSession('s1', async (history) => ({
      history: [...history, { role: 'user', content: 'in session 1' }],
      result: null,
    }))

    const seen: Message[][] = []
    await store.withSession('s2', async (history) => {
      seen.push(history)
      return { history, result: null }
    })

    expect(seen[0]).toEqual([])
    await store.close()
  })

  it('serializes concurrent withSession calls for the same sessionId', async () => {
    const store = new FileSessionStore(tmpDir())
    const order: string[] = []

    const first = store.withSession('s1', async (history) => {
      order.push('first:start')
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push('first:end')
      return { history: [...history, { role: 'user', content: 'a' }], result: null }
    })
    const second = store.withSession('s1', async (history) => {
      order.push('second:start')
      return { history: [...history, { role: 'user', content: 'b' }], result: null }
    })

    await Promise.all([first, second])

    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
    await store.close()
  })

  it('detects an interruption left by a prior process and injects a continuation', async () => {
    const dir = tmpDir()

    // Simulate a process that pushed a "[requested: ...]" message and died
    // before any tool result was recorded — write directly to the
    // underlying storage, bypassing withSession entirely.
    const rawStorage = new FileStorage<Message>(dir)
    const rootId = randomUUID()
    await rawStorage.append('s1', {
      id: rootId,
      parentId: null,
      message: { role: 'user', content: 'do the risky thing' },
    })
    const requestId = randomUUID()
    await rawStorage.append('s1', {
      id: requestId,
      parentId: rootId,
      message: { role: 'assistant', content: '[requested: risky_tool]' },
    })
    await rawStorage.flush('s1')

    const store = new FileSessionStore(dir)
    const seen: Message[][] = []
    await store.withSession('s1', async (history) => {
      seen.push(history)
      return { history, result: null }
    })

    const resumed = seen[0]
    expect(resumed[0]).toEqual({ role: 'user', content: 'do the risky thing' })
    expect(resumed[1]).toEqual({ role: 'assistant', content: '[requested: risky_tool]' })
    expect(resumed[2].role).toBe('user')
    expect(resumed[2].content).toMatch(/resumed after an interruption/)
    await store.close()
  })

  it('does not inject a continuation when the session ended cleanly', async () => {
    const dir = tmpDir()
    const store = new FileSessionStore(dir)

    await store.withSession('s1', async (history) => ({
      history: [
        ...history,
        { role: 'assistant', content: '[requested: echo]' },
        { role: 'user', content: '[echo result] "ok"' },
      ],
      result: null,
    }))

    const seen: Message[][] = []
    await store.withSession('s1', async (history) => {
      seen.push(history)
      return { history, result: null }
    })

    expect(seen[0].some((m) => m.content.includes('resumed after an interruption'))).toBe(false)
    await store.close()
  })
})
