import { describe, expect, it } from 'vitest'
import { buildLanes, runLanes, ToolLane } from '#core/toollane.js'
import type { Lane, LaneResult, ToolCall } from '#core/toollane.js'

function call(id: string, name: string): ToolCall {
  return { id, name, execute: async () => name }
}

describe('buildLanes', () => {
  it('merges consecutive safe calls into one parallel lane', () => {
    const calls = [call('1', 'a'), call('2', 'b'), call('3', 'c')]
    const lanes = buildLanes(calls, () => true)
    expect(lanes).toHaveLength(1)
    expect(lanes[0]?.mode).toBe('parallel')
    expect(lanes[0]?.calls).toHaveLength(3)
  })

  it('gives every unsafe call its own solo lane', () => {
    const calls = [call('1', 'a'), call('2', 'b')]
    const lanes = buildLanes(calls, () => false)
    expect(lanes).toHaveLength(2)
    expect(lanes.every((l) => l.mode === 'solo')).toBe(true)
  })

  it('preserves batch order across mixed safe/unsafe calls', () => {
    const calls = [call('1', 'safe1'), call('2', 'safe2'), call('3', 'unsafe'), call('4', 'safe3')]
    const isSafe = (c: ToolCall) => c.name !== 'unsafe'
    const lanes = buildLanes(calls, isSafe)
    expect(lanes.map((l) => l.mode)).toEqual(['parallel', 'solo', 'parallel'])
    expect(lanes[0]?.calls.map((c) => c.name)).toEqual(['safe1', 'safe2'])
    expect(lanes[1]?.calls.map((c) => c.name)).toEqual(['unsafe'])
    expect(lanes[2]?.calls.map((c) => c.name)).toEqual(['safe3'])
  })

  it('does not merge two consecutive unsafe calls into one lane', () => {
    const calls = [call('1', 'a'), call('2', 'b')]
    const lanes = buildLanes(calls, () => false)
    expect(lanes).toHaveLength(2)
  })

  it('returns no lanes for an empty batch', () => {
    expect(buildLanes([], () => true)).toEqual([])
  })
})

describe('runLanes', () => {
  async function drain(lanes: Lane[]): Promise<LaneResult[]> {
    const results: LaneResult[] = []
    for await (const result of runLanes(lanes)) {
      results.push(result)
    }
    return results
  }

  it('yields a fulfilled result for a successful call', async () => {
    const lanes: Lane[] = [{ mode: 'solo', calls: [{ id: '1', name: 'a', execute: async () => 'ok' }] }]
    expect(await drain(lanes)).toEqual([{ id: '1', name: 'a', status: 'fulfilled', value: 'ok' }])
  })

  it('isolates a failure to its own result without stopping the batch', async () => {
    const lanes: Lane[] = [
      {
        mode: 'parallel',
        calls: [
          { id: '1', name: 'ok', execute: async () => 'fine' },
          {
            id: '2',
            name: 'bad',
            execute: async () => {
              throw new Error('boom')
            },
          },
        ],
      },
      { mode: 'solo', calls: [{ id: '3', name: 'after', execute: async () => 'still runs' }] },
    ]
    const results = await drain(lanes)

    expect(results).toHaveLength(3)
    expect(results.find((r) => r.id === '2')?.status).toBe('rejected')
    expect(results.find((r) => r.id === '3')?.status).toBe('fulfilled')
  })

  it('runs calls within a parallel lane concurrently, not sequentially', async () => {
    const order: string[] = []
    const lanes: Lane[] = [
      {
        mode: 'parallel',
        calls: [
          {
            id: '1',
            name: 'slow',
            execute: async () => {
              await new Promise((resolve) => setTimeout(resolve, 30))
              order.push('slow')
              return 'slow'
            },
          },
          {
            id: '2',
            name: 'fast',
            execute: async () => {
              order.push('fast')
              return 'fast'
            },
          },
        ],
      },
    ]
    await drain(lanes)
    expect(order).toEqual(['fast', 'slow'])
  })
})

describe('ToolLane', () => {
  it('plan() reflects the same grouping run() executes', () => {
    const calls = [call('1', 'read'), call('2', 'read'), call('3', 'write')]
    const toolLane = new ToolLane({ isSafe: (c) => c.name === 'read' })
    const lanes = toolLane.plan(calls)
    expect(lanes.map((l) => l.mode)).toEqual(['parallel', 'solo'])
  })

  it('run() streams exactly one result per call across the whole batch', async () => {
    const calls = [call('1', 'read'), call('2', 'write'), call('3', 'read')]
    const toolLane = new ToolLane({ isSafe: (c) => c.name === 'read' })

    const ids: string[] = []
    for await (const result of toolLane.run(calls)) {
      ids.push(result.id)
    }
    expect(ids.sort()).toEqual(['1', '2', '3'])
  })
})
