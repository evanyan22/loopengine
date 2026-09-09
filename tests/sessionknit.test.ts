import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FileStorage, MemoryStorage, reconstructChain, SessionKnit } from '#core/sessionknit.js'
import type { SessionEntry } from '#core/sessionknit.js'

function entry(id: string, parentId: string | null, content: string): SessionEntry<string> {
  return { id, parentId, message: content }
}

describe('reconstructChain', () => {
  it('returns an empty result for no entries', () => {
    expect(reconstructChain([])).toEqual({ messages: [], entries: [] })
  })

  it('reconstructs a simple linear chain in order', () => {
    const entries = [entry('a', null, 'A'), entry('b', 'a', 'B'), entry('c', 'b', 'C')]
    const result = reconstructChain(entries)
    expect(result.messages).toEqual(['A', 'B', 'C'])
  })

  it('reattaches a sibling branch a naive walk would drop', () => {
    const entries = [
      entry('a', null, 'A'),
      entry('b', 'a', 'B'),
      entry('tool1', 'b', 'TOOL1'),
      entry('tool2', 'b', 'TOOL2'),
      entry('d', 'tool2', 'D'),
    ]
    const result = reconstructChain(entries, 'd')
    expect(result.messages).toEqual(['A', 'B', 'TOOL1', 'TOOL2', 'D'])
  })

  it('walks from the last entry when no leafId is given', () => {
    const entries = [entry('a', null, 'A'), entry('b', 'a', 'B')]
    const result = reconstructChain(entries)
    expect(result.messages).toEqual(['A', 'B'])
  })

  it('throws for an unknown leafId', () => {
    const entries = [entry('a', null, 'A')]
    expect(() => reconstructChain(entries, 'missing')).toThrow(/Unknown entry/)
  })
})

describe('MemoryStorage', () => {
  it('does not make an appended entry visible until flush', async () => {
    const storage = new MemoryStorage<string>(10000) // long enough not to auto-fire during the test
    await storage.append('s1', { id: 'a', parentId: null, message: 'A' })
    expect(await storage.readAll('s1')).toEqual([])

    await storage.flush('s1')
    expect(await storage.readAll('s1')).toEqual([{ id: 'a', parentId: null, message: 'A' }])
  })

  it('batches multiple appends into one flush', async () => {
    const storage = new MemoryStorage<string>(10000)
    await storage.append('s1', { id: 'a', parentId: null, message: 'A' })
    await storage.append('s1', { id: 'b', parentId: 'a', message: 'B' })
    await storage.flush('s1')
    const all = await storage.readAll('s1')
    expect(all.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('auto-flushes after the debounce window elapses', async () => {
    const storage = new MemoryStorage<string>(5)
    await storage.append('s1', { id: 'a', parentId: null, message: 'A' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(await storage.readAll('s1')).toEqual([{ id: 'a', parentId: null, message: 'A' }])
  })
})

describe('FileStorage', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sessionknit-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('persists entries to a JSONL file after flush', async () => {
    const storage = new FileStorage<string>(dir, 10000)
    await storage.append('s1', { id: 'a', parentId: null, message: 'A' })
    await storage.append('s1', { id: 'b', parentId: 'a', message: 'B' })
    await storage.flush('s1')

    const all = await storage.readAll('s1')
    expect(all).toEqual([
      { id: 'a', parentId: null, message: 'A' },
      { id: 'b', parentId: 'a', message: 'B' },
    ])
  })

  it('returns an empty array for a session that was never written', async () => {
    const storage = new FileStorage<string>(dir, 10000)
    expect(await storage.readAll('never-existed')).toEqual([])
  })
})

interface Message {
  role: string
  content: string
  hasToolCall?: boolean
}

describe('SessionKnit.resume', () => {
  it('reconstructs a clean session with no interruption flagged', async () => {
    const storage = new MemoryStorage<Message>(10)
    const sessionknit = new SessionKnit(storage)

    await sessionknit.append('s1', { id: 'a', parentId: null, message: { role: 'user', content: 'hi' } })
    await sessionknit.append('s1', { id: 'b', parentId: 'a', message: { role: 'assistant', content: 'hello' } })

    const result = await sessionknit.resume('s1')
    expect(result.resumedAfterInterruption).toBe(false)
    expect(result.messages.map((m) => m.content)).toEqual(['hi', 'hello'])
  })

  it('reattaches a dropped parallel-tool-call sibling on resume', async () => {
    const storage = new MemoryStorage<Message>(10)
    const sessionknit = new SessionKnit(storage)

    await sessionknit.append('s1', { id: 'a', parentId: null, message: { role: 'user', content: 'A' } })
    await sessionknit.append('s1', { id: 'b', parentId: 'a', message: { role: 'assistant', content: 'B' } })
    await sessionknit.append('s1', { id: 'tool1', parentId: 'b', message: { role: 'tool', content: 'TOOL1' } })
    await sessionknit.append('s1', { id: 'tool2', parentId: 'b', message: { role: 'tool', content: 'TOOL2' } })
    await sessionknit.append('s1', { id: 'd', parentId: 'tool2', message: { role: 'assistant', content: 'D' } })

    const result = await sessionknit.resume('s1', 'd')
    expect(result.messages.map((m) => m.content)).toEqual(['A', 'B', 'TOOL1', 'TOOL2', 'D'])
  })

  it('flags interruption and appends a synthetic continuation when configured', async () => {
    const storage = new MemoryStorage<Message>(10)
    const sessionknit = new SessionKnit(storage, {
      hasUnresolvedToolCall: (m) => m.hasToolCall === true,
      buildContinuation: (m) => ({ role: 'user', content: `continue: ${m.content}` }),
    })

    await sessionknit.append('s1', { id: 'a', parentId: null, message: { role: 'user', content: 'go' } })
    await sessionknit.append('s1', {
      id: 'b',
      parentId: 'a',
      message: { role: 'assistant', content: 'calling tool', hasToolCall: true },
    })

    const result = await sessionknit.resume('s1')
    expect(result.resumedAfterInterruption).toBe(true)
    expect(result.messages.map((m) => m.content)).toEqual(['go', 'calling tool', 'continue: calling tool'])
  })

  it('flags interruption without appending anything when no buildContinuation is configured', async () => {
    const storage = new MemoryStorage<Message>(10)
    const sessionknit = new SessionKnit(storage, {
      hasUnresolvedToolCall: (m) => m.hasToolCall === true,
    })

    await sessionknit.append('s1', {
      id: 'a',
      parentId: null,
      message: { role: 'assistant', content: 'calling tool', hasToolCall: true },
    })

    const result = await sessionknit.resume('s1')
    expect(result.resumedAfterInterruption).toBe(true)
    expect(result.messages.map((m) => m.content)).toEqual(['calling tool'])
  })

  it('flushes pending writes automatically before reading on resume', async () => {
    const storage = new MemoryStorage<Message>(10000) // would never auto-fire in time
    const sessionknit = new SessionKnit(storage)
    await sessionknit.append('s1', { id: 'a', parentId: null, message: { role: 'user', content: 'hi' } })

    const result = await sessionknit.resume('s1')
    expect(result.messages).toHaveLength(1)
  })
})
