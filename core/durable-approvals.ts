// Durable storage for a turn paused on one or more DurableApprover
// decisions — see DURABLE_APPROVALS.md for the full design. Mirrors
// session-store.ts's own shape deliberately: a small "load, run
// exclusively, persist" contract (withCheckpoint, here, plays the same
// role withSession does there), a file-backed store for local dev and a
// Redis-backed one for multi-instance deployments, and a
// REDIS_URL-gated factory. This module does no tool execution and knows
// nothing about ActAuth or the model loop — it only stores and locks;
// run-agent.ts/adapters/http.ts own deciding what a resolution actually
// does (see DURABLE_APPROVALS.md's own "request + raw resolve only"
// division of labor).
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Redis } from 'ioredis'
import type { ModelContentBlock } from './run-agent.js'
import { KeyedMutex } from './session-store.js'

export interface OutstandingItem {
  toolUseId: string
  tool: string
  args: Record<string, unknown>
  reason: string
}

export interface TurnCheckpoint {
  id: string
  sessionId: string
  agent: string
  tenant: string
  /** tool_result blocks already computed — either safely auto-allowed
   * calls from the same batch that ran immediately (see run-agent.ts's
   * bucket-then-execute), or outstanding items resolved since this
   * checkpoint was created. Complete and ready to push as the turn's
   * completing message the instant `outstanding` is empty. */
  resultsSoFar: ModelContentBlock[]
  /** Keyed by pendingId, not toolUseId — a pendingId is what an incoming
   * resolution actually names (a webhook callback, a magic-link visit),
   * and is what DurableApprover.requestDurableApproval handed out. */
  outstanding: Record<string, OutstandingItem>
  closed: boolean
}

export interface CreateCheckpointInput {
  sessionId: string
  agent: string
  tenant: string
  resultsSoFar: ModelContentBlock[]
  outstanding: Record<string, OutstandingItem>
}

export interface CheckpointStore {
  create(input: CreateCheckpointInput): Promise<TurnCheckpoint>
  /** Loads the checkpoint `pendingId` belongs to, runs `fn` exclusively
   * for that checkpoint (serializes concurrent resolutions of different
   * outstanding items in the same checkpoint — see DURABLE_APPROVALS.md's
   * own "denial closes the checkpoint immediately" race), and persists
   * whatever checkpoint `fn` returns (or deletes it, once closed —
   * nothing revisits a closed checkpoint again).
   *
   * `fn` receives `undefined` for an unknown pendingId, or one whose
   * checkpoint is already closed — the graceful no-op case (a sibling
   * denial, or an earlier resolve of the very same pendingId, got there
   * first). `fn` itself decides what "closed" means (every outstanding
   * item resolved, or a denial that closes early and skips the rest) —
   * this store only persists the result, it never decides it. */
  withCheckpoint<T>(
    pendingId: string,
    fn: (checkpoint: TurnCheckpoint | undefined) => Promise<{ checkpoint: TurnCheckpoint | undefined; result: T }>,
  ): Promise<T>
  close(): Promise<void>
}

const fileMutex = new KeyedMutex()

/** One JSON file per checkpoint under `<dir>/checkpoints/`, plus one
 * small pendingId -> checkpointId pointer file per outstanding item under
 * `<dir>/pending-index/`. Fine for a single local process; not safe
 * across multiple processes/instances — those need RedisCheckpointStore. */
export class FileCheckpointStore implements CheckpointStore {
  private readonly checkpointsDir: string
  private readonly indexDir: string

  constructor(dir: string) {
    this.checkpointsDir = path.join(dir, 'checkpoints')
    this.indexDir = path.join(dir, 'pending-index')
    mkdirSync(this.checkpointsDir, { recursive: true })
    mkdirSync(this.indexDir, { recursive: true })
  }

  private checkpointPath(id: string): string {
    return path.join(this.checkpointsDir, `${id}.json`)
  }

  private indexPath(pendingId: string): string {
    return path.join(this.indexDir, pendingId)
  }

  async create(input: CreateCheckpointInput): Promise<TurnCheckpoint> {
    const checkpoint: TurnCheckpoint = { id: randomUUID(), closed: false, ...input }
    writeFileSync(this.checkpointPath(checkpoint.id), JSON.stringify(checkpoint))
    for (const pendingId of Object.keys(checkpoint.outstanding)) {
      writeFileSync(this.indexPath(pendingId), checkpoint.id)
    }
    return checkpoint
  }

  async withCheckpoint<T>(
    pendingId: string,
    fn: (checkpoint: TurnCheckpoint | undefined) => Promise<{ checkpoint: TurnCheckpoint | undefined; result: T }>,
  ): Promise<T> {
    const indexPath = this.indexPath(pendingId)
    if (!existsSync(indexPath)) return (await fn(undefined)).result

    const checkpointId = readFileSync(indexPath, 'utf8')
    return fileMutex.run(checkpointId, async () => {
      const checkpointPath = this.checkpointPath(checkpointId)
      // A concurrent resolution of a sibling pendingId in the same
      // checkpoint may have already closed (and removed) it while this
      // call was queued behind the mutex above.
      const current: TurnCheckpoint | undefined = existsSync(checkpointPath)
        ? (JSON.parse(readFileSync(checkpointPath, 'utf8')) as TurnCheckpoint)
        : undefined
      const { checkpoint, result } = await fn(current && !current.closed ? current : undefined)

      if (checkpoint) {
        if (checkpoint.closed) {
          rmSync(checkpointPath, { force: true })
          for (const id of [...Object.keys(current?.outstanding ?? {})]) rmSync(this.indexPath(id), { force: true })
        } else {
          writeFileSync(checkpointPath, JSON.stringify(checkpoint))
        }
      }
      return result
    })
  }

  async close(): Promise<void> {}
}

/** Redis-backed store for multi-instance deployments. Unlike
 * RedisSessionStore's lock (held for an entire turn, including however
 * long a live human takes), this one only ever needs to be held for a
 * quick read-modify-write — durable resolution never blocks on a human
 * while holding it — so a short SET NX PX lock with retry, no renewal
 * loop, is enough. */
export class RedisCheckpointStore implements CheckpointStore {
  private readonly redis: Redis
  private readonly lockTtlMs = 5_000
  private readonly lockRetryDelayMs = 50
  private readonly lockMaxWaitMs = 10_000

  constructor(redisUrl: string, client?: Redis) {
    this.redis = client ?? new Redis(redisUrl)
  }

  private checkpointKey(id: string): string {
    return `checkpoint:${id}`
  }

  private indexKey(pendingId: string): string {
    return `checkpoint-pending-index:${pendingId}`
  }

  private lockKey(checkpointId: string): string {
    return `checkpoint-lock:${checkpointId}`
  }

  private async withLock<T>(checkpointId: string, fn: () => Promise<T>): Promise<T> {
    const token = randomUUID()
    const key = this.lockKey(checkpointId)
    const deadline = Date.now() + this.lockMaxWaitMs
    for (;;) {
      const ok = await this.redis.set(key, token, 'PX', this.lockTtlMs, 'NX')
      if (ok) break
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock on checkpoint '${checkpointId}'`)
      await new Promise((resolve) => setTimeout(resolve, this.lockRetryDelayMs))
    }
    try {
      return await fn()
    } finally {
      // Compare-and-delete, same script shape session-store.ts's own
      // UNLOCK_IF_OWNER_SCRIPT uses — don't release a lock a slower
      // caller's TTL expiry already handed to someone else.
      await this.redis.eval(
        `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
        1,
        key,
        token,
      )
    }
  }

  async create(input: CreateCheckpointInput): Promise<TurnCheckpoint> {
    const checkpoint: TurnCheckpoint = { id: randomUUID(), closed: false, ...input }
    await this.redis.set(this.checkpointKey(checkpoint.id), JSON.stringify(checkpoint))
    for (const pendingId of Object.keys(checkpoint.outstanding)) {
      await this.redis.set(this.indexKey(pendingId), checkpoint.id)
    }
    return checkpoint
  }

  async withCheckpoint<T>(
    pendingId: string,
    fn: (checkpoint: TurnCheckpoint | undefined) => Promise<{ checkpoint: TurnCheckpoint | undefined; result: T }>,
  ): Promise<T> {
    const checkpointId = await this.redis.get(this.indexKey(pendingId))
    if (!checkpointId) return (await fn(undefined)).result

    return this.withLock(checkpointId, async () => {
      const raw = await this.redis.get(this.checkpointKey(checkpointId))
      const current: TurnCheckpoint | undefined = raw ? (JSON.parse(raw) as TurnCheckpoint) : undefined
      const { checkpoint, result } = await fn(current && !current.closed ? current : undefined)

      if (checkpoint) {
        if (checkpoint.closed) {
          await this.redis.del(this.checkpointKey(checkpointId))
          for (const id of Object.keys(current?.outstanding ?? {})) await this.redis.del(this.indexKey(id))
        } else {
          await this.redis.set(this.checkpointKey(checkpointId), JSON.stringify(checkpoint))
        }
      }
      return result
    })
  }

  async close(): Promise<void> {
    await this.redis.quit()
  }
}

/** Same REDIS_URL-gated pattern as session-store.ts's own
 * createSessionStore(): set -> RedisCheckpointStore, otherwise
 * FileCheckpointStore under .checkpoints. */
export function createCheckpointStore(): CheckpointStore {
  const redisUrl = process.env.REDIS_URL
  return redisUrl ? new RedisCheckpointStore(redisUrl) : new FileCheckpointStore('.checkpoints')
}
