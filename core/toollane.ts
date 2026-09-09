// Formerly the standalone `toollane` package — folded in here for the
// same reason mcpplug.ts was: no consumer besides loopengine itself ever
// actually materialized, so the separate-package/portable-to-any-host
// framing was aspirational rather than realized. A concurrency-safety-
// aware scheduler for a batch of already-approved tool calls: consecutive
// safety-declared calls run together in a parallel lane, anything else
// gets its own solo lane, order preserved, one failure isolated to its
// own slot rather than rejecting the whole batch.

/** A tool call is just a callable with identity — this module doesn't
 * know or care what a "tool" is beyond that. */
export interface ToolCall {
  id: string
  name: string
  execute: () => Promise<unknown>
}

/** Host-provided: does this specific call belong in a parallel lane?
 * Mirrors Claude Code's own isReadOnly()/isConcurrencySafe() per-tool
 * declarations. */
export type SafetyClassifier = (call: ToolCall) => boolean

export interface Lane {
  mode: 'parallel' | 'solo'
  calls: ToolCall[]
}

export interface LaneResult {
  id: string
  name: string
  status: 'fulfilled' | 'rejected'
  value?: unknown
  error?: unknown
}

/** Groups a batch of tool calls into lanes: consecutive safety-declared
 * calls merge into one parallel lane; anything else gets its own solo
 * lane. Batch order is preserved across lanes — this never reorders
 * calls, only decides what runs together. */
export function buildLanes(calls: ToolCall[], isSafe: SafetyClassifier): Lane[] {
  const lanes: Lane[] = []

  for (const call of calls) {
    const safe = isSafe(call)
    const lastLane = lanes.at(-1)

    if (safe && lastLane?.mode === 'parallel') {
      lastLane.calls.push(call)
      continue
    }

    lanes.push({ mode: safe ? 'parallel' : 'solo', calls: [call] })
  }

  return lanes
}

async function runCall(call: ToolCall): Promise<LaneResult> {
  try {
    const value = await call.execute()
    return { id: call.id, name: call.name, status: 'fulfilled', value }
  } catch (error) {
    return { id: call.id, name: call.name, status: 'rejected', error }
  }
}

/** Runs lanes in order; calls within a parallel lane run concurrently.
 * Every call resolves to a LaneResult regardless of success or failure —
 * one call throwing never rejects the batch, it just carries the error
 * in its own slot. */
export async function* runLanes(lanes: Lane[]): AsyncGenerator<LaneResult> {
  for (const lane of lanes) {
    if (lane.mode === 'solo') {
      const call = lane.calls[0]
      if (call) yield await runCall(call)
      continue
    }

    const results = await Promise.all(lane.calls.map(runCall))
    for (const result of results) {
      yield result
    }
  }
}

export interface ToolLaneOptions {
  isSafe: SafetyClassifier
}

/** Ties classification, scheduling, and execution together: given a
 * batch of approved tool calls, decide a safe execution plan and run
 * it, streaming each call's result as it completes. */
export class ToolLane {
  private readonly isSafe: SafetyClassifier

  constructor(options: ToolLaneOptions) {
    this.isSafe = options.isSafe
  }

  /** Read-only — returns the lane plan without executing anything. */
  plan(calls: ToolCall[]): Lane[] {
    return buildLanes(calls, this.isSafe)
  }

  /** Builds the plan and executes it. */
  async *run(calls: ToolCall[]): AsyncGenerator<LaneResult> {
    yield* runLanes(this.plan(calls))
  }
}
