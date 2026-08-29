import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileCheckpointStore, type CreateCheckpointInput } from '../core/durable-approvals.js'

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loopengine-checkpoint-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeInput(overrides: Partial<CreateCheckpointInput> = {}): CreateCheckpointInput {
  return {
    sessionId: 's1',
    agent: 'customer-service',
    tenant: 'default',
    resultsSoFar: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
    outstanding: { p1: { toolUseId: 't2', tool: 'issue_refund', args: { amount: 900 }, reason: 'matched rule' } },
    ...overrides,
  }
}

describe('FileCheckpointStore', () => {
  it('creates a checkpoint reachable by each of its pendingIds', async () => {
    const store = new FileCheckpointStore(tmpDir())
    const created = await store.create(makeInput())

    const seen = await store.withCheckpoint('p1', async (checkpoint) => ({ checkpoint, result: checkpoint }))
    expect(seen).toEqual(created)
  })

  it('passes undefined to fn for an unknown pendingId', async () => {
    const store = new FileCheckpointStore(tmpDir())
    const seen = await store.withCheckpoint('nonexistent', async (checkpoint) => ({ checkpoint, result: checkpoint }))
    expect(seen).toBeUndefined()
  })

  it('persists whatever checkpoint fn returns', async () => {
    const store = new FileCheckpointStore(tmpDir())
    await store.create(makeInput())

    await store.withCheckpoint('p1', async (checkpoint) => {
      const updated = { ...checkpoint!, resultsSoFar: [...checkpoint!.resultsSoFar, { type: 'tool_result', tool_use_id: 't2', content: 'refunded' }], outstanding: {} }
      return { checkpoint: updated, result: undefined }
    })

    const reread = await store.withCheckpoint('p1', async (checkpoint) => ({ checkpoint, result: checkpoint }))
    expect(reread?.resultsSoFar).toHaveLength(2)
    expect(reread?.outstanding).toEqual({})
  })

  it('removes a checkpoint (and every pendingId pointing at it) once fn marks it closed', async () => {
    const store = new FileCheckpointStore(tmpDir())
    await store.create(makeInput({ outstanding: { p1: { toolUseId: 't2', tool: 'a', args: {}, reason: 'r' }, p2: { toolUseId: 't3', tool: 'b', args: {}, reason: 'r' } } }))

    await store.withCheckpoint('p1', async (checkpoint) => ({ checkpoint: { ...checkpoint!, closed: true }, result: undefined }))

    expect(await store.withCheckpoint('p1', async (c) => ({ checkpoint: c, result: c }))).toBeUndefined()
    expect(await store.withCheckpoint('p2', async (c) => ({ checkpoint: c, result: c }))).toBeUndefined()
  })

  it('treats a pendingId whose checkpoint is already closed as unknown (graceful no-op case)', async () => {
    const store = new FileCheckpointStore(tmpDir())
    await store.create(makeInput({ outstanding: { p1: { toolUseId: 't2', tool: 'a', args: {}, reason: 'r' }, p2: { toolUseId: 't3', tool: 'b', args: {}, reason: 'r' } } }))

    // p1 resolves first and closes the checkpoint (simulating a denial).
    await store.withCheckpoint('p1', async (checkpoint) => ({ checkpoint: { ...checkpoint!, closed: true }, result: undefined }))

    // p2's own resolution arrives afterward, pointing at the same now-gone checkpoint.
    let calledWith: unknown = 'not called'
    await store.withCheckpoint('p2', async (checkpoint) => {
      calledWith = checkpoint
      return { checkpoint, result: undefined }
    })
    expect(calledWith).toBeUndefined()
  })

  it('serializes concurrent withCheckpoint calls for the same checkpoint', async () => {
    const store = new FileCheckpointStore(tmpDir())
    await store.create(makeInput({ outstanding: { p1: { toolUseId: 't2', tool: 'a', args: {}, reason: 'r' }, p2: { toolUseId: 't3', tool: 'b', args: {}, reason: 'r' } } }))
    const order: string[] = []

    const first = store.withCheckpoint('p1', async (checkpoint) => {
      order.push('first:start')
      await new Promise((resolve) => setTimeout(resolve, 30))
      order.push('first:end')
      const { p1: _p1, ...rest } = checkpoint!.outstanding
      return { checkpoint: { ...checkpoint!, outstanding: rest }, result: undefined }
    })
    const second = store.withCheckpoint('p2', async (checkpoint) => {
      order.push('second:start')
      const { p2: _p2, ...rest } = checkpoint!.outstanding
      return { checkpoint: { ...checkpoint!, closed: Object.keys(rest).length === 0, outstanding: rest }, result: undefined }
    })

    await Promise.all([first, second])
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })
})
