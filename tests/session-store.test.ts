import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { FileStorage } from 'sessionknit'
import type { Message } from '#run-agent.js'
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
      return { newMessages: [{ role: 'user', content: 'hi' }], result: null }
    })

    expect(seen).toEqual([[]])
    await store.close()
  })

  it('persists appended messages so the next withSession call resumes them', async () => {
    const dir = tmpDir()
    const store = new FileSessionStore(dir)

    await store.withSession('s1', async () => ({
      newMessages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ],
      result: null,
    }))

    const seen: Message[][] = []
    await store.withSession('s1', async (history) => {
      seen.push(history)
      return { newMessages: [], result: null }
    })

    expect(seen[0]).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
    ])
    await store.close()
  })

  it('keeps different sessionIds independent', async () => {
    const store = new FileSessionStore(tmpDir())

    await store.withSession('s1', async () => ({
      newMessages: [{ role: 'user', content: 'in session 1' }],
      result: null,
    }))

    const seen: Message[][] = []
    await store.withSession('s2', async (history) => {
      seen.push(history)
      return { newMessages: [], result: null }
    })

    expect(seen[0]).toEqual([])
    await store.close()
  })

  it('serializes concurrent withSession calls for the same sessionId', async () => {
    const store = new FileSessionStore(tmpDir())
    const order: string[] = []

    const first = store.withSession('s1', async () => {
      order.push('first:start')
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push('first:end')
      return { newMessages: [{ role: 'user', content: 'a' }], result: null }
    })
    const second = store.withSession('s1', async () => {
      order.push('second:start')
      return { newMessages: [{ role: 'user', content: 'b' }], result: null }
    })

    await Promise.all([first, second])

    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
    await store.close()
  })

  it('detects an interruption left by a prior process and injects a continuation', async () => {
    const dir = tmpDir()

    // Simulate a process that pushed an assistant message with a
    // tool_use block and died before any tool_result was recorded —
    // write directly to the underlying storage, bypassing withSession
    // entirely.
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
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'risky_tool', input: {} }],
      },
    })
    await rawStorage.flush('s1')

    const store = new FileSessionStore(dir)
    const seen: Message[][] = []
    await store.withSession('s1', async (history) => {
      seen.push(history)
      return { newMessages: [], result: null }
    })

    const resumed = seen[0]
    expect(resumed[0]).toEqual({ role: 'user', content: 'do the risky thing' })
    expect(resumed[1]).toEqual({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'risky_tool', input: {} }],
    })
    expect(resumed[2].role).toBe('user')
    expect(resumed[2].content).toMatch(/resumed after an interruption/)
    await store.close()
  })

  it('does not inject a continuation when the session ended cleanly', async () => {
    const dir = tmpDir()
    const store = new FileSessionStore(dir)

    await store.withSession('s1', async () => ({
      newMessages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] },
      ],
      result: null,
    }))

    const seen: Message[][] = []
    await store.withSession('s1', async (history) => {
      seen.push(history)
      return { newMessages: [], result: null }
    })

    const flagged = seen[0].some(
      (m) => typeof m.content === 'string' && m.content.includes('resumed after an interruption'),
    )
    expect(flagged).toBe(false)
    await store.close()
  })

  it('durably persists a compacted turn instead of losing it (regression: recovery used to make history shorter than what was loaded, silently dropping the whole turn)', async () => {
    const dir = tmpDir()
    const store = new FileSessionStore(dir)

    // Seed 5 messages of prior "durable" history directly.
    const rawStorage = new FileStorage<Message>(dir)
    let parentId: string | null = null
    for (let i = 0; i < 5; i++) {
      const id = randomUUID()
      await rawStorage.append('s1', { id, parentId, message: { role: 'user', content: `turn ${i}` } })
      parentId = id
    }
    await rawStorage.flush('s1')

    // Simulate what a compacting runAgent call now returns: newMessages
    // is short and self-contained, completely decoupled from however
    // large `history` was.
    await store.withSession('s1', async (history) => {
      expect(history).toHaveLength(5)
      return { newMessages: [{ role: 'assistant', content: 'compacted reply' }], result: null }
    })

    const seen: Message[][] = []
    await store.withSession('s1', async (history) => {
      seen.push(history)
      return { newMessages: [], result: null }
    })

    expect(seen[0]).toHaveLength(6)
    expect(seen[0][5]).toEqual({ role: 'assistant', content: 'compacted reply' })
    await store.close()
  })
})
