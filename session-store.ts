// Where conversation history lives between calls to runAgent, and how
// concurrent requests for the *same* session are kept from racing on
// read-modify-write. Adapters never call load/save directly — they go
// through withSession, so locking isn't something each adapter has to
// remember to do correctly.
//
// Storage itself is SessionKnit: a durable, append-only, parent-linked log
// per session, rather than a flat blob rewritten whole on every turn. That
// buys two things runAgent's history array can't give itself:
//   - non-blocking, debounced writes instead of a full read-modify-write
//     of the entire session on every turn
//   - interruption detection — if the process dies between requesting
//     tools and recording their results (run-agent.ts pushes an
//     "[requested: ...]" message before any tool runs, then one
//     "[... result]" message per completed tool), the next resume() sees
//     an unresolved request and injects a note into context saying so,
//     instead of silently resending an incomplete turn as if it were
//     clean.
// SessionKnit's own topology repair is for branches *within* one resumed
// chain (parallel tool calls, crash recovery) — it isn't a substitute for
// turn-level exclusivity, so this module still serializes concurrent
// withSession calls for the same sessionId itself (KeyedMutex / a Redis
// lock), same as before.
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Redis } from 'ioredis'
import { SessionKnit, FileStorage, type Storage, type SessionEntry } from 'sessionknit'
import type { Message } from './run-agent.js'

export interface SessionResult<T> {
  /** Exactly what this turn added — durably appended as-is, in order.
   * This has to come from the caller explicitly (runAgent's own
   * RunAgentResult.newMessages) rather than being inferred by diffing a
   * returned `history` against what withSession loaded: that only works
   * if history only ever grows, which isn't true once ContextClip
   * recovery can shrink/rewrite it mid-turn — see RunAgentResult's own
   * doc comment for the full reasoning. */
  newMessages: Message[]
  result: T
}

export interface SessionStore {
  /** Loads history for sessionId, runs fn exclusively — no other
   * withSession call for the same sessionId runs concurrently, in this
   * process or (for RedisSessionStore) any other — durably appends
   * fn's result.newMessages in order, and resolves with fn's result. */
  withSession<T>(sessionId: string, fn: (history: Message[]) => Promise<SessionResult<T>>): Promise<T>
  close(): Promise<void>
}

/** Serializes async work per key within this process. Good enough for
 * FileSessionStore (single process); RedisSessionStore needs a real
 * distributed lock instead since multiple server instances share it. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prevTail = this.tails.get(key) ?? Promise.resolve()
    const result = prevTail.then(fn, fn)
    const settled = result.catch(() => {})
    this.tails.set(key, settled)

    // Self-cleaning: once nothing is queued behind this key anymore,
    // drop it instead of leaking one Map entry per distinct key forever.
    // Every anonymous, auto-generated session id (see adapters/http.ts,
    // adapters/cli.ts) creates a brand-new key that would otherwise
    // never be visited again — an unbounded, permanent leak in a
    // long-running process. Identity-checked against the Map's *current*
    // value for this key, not just "did settled resolve" — a call queued
    // behind this one already replaced the entry with its own tail by
    // the time this fires, and deleting then would orphan that chain
    // instead of leaving it for its own turn to clean up.
    settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key)
    })

    return result
  }

  /** Test-only: how many keys currently have an in-flight or
   * about-to-be-cleaned-up chain — should return to 0 once all queued
   * work across all keys has settled. */
  size(): number {
    return this.tails.size
  }
}

// run-agent.ts pushes the model's full response — tool_use blocks
// included — as one assistant message before any tool executes, then one
// user message bundling every tool_result once they've all settled
// (adapters/http.ts, adapters/cli.ts never see this — it lives entirely
// inside the messages array runAgent returns). If the process dies in
// that window, the assistant message with its unanswered tool_use
// block(s) is the last thing on disk.
function hasUnresolvedToolCall(message: Message): boolean {
  return (
    message.role === 'assistant' &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === 'tool_use')
  )
}

function buildContinuation(): Message {
  return {
    role: 'user',
    content:
      '[session resumed after an interruption — the assistant had requested tool calls but the process stopped before any results were recorded; treat those tools as not having run]',
  }
}

/** Wraps a SessionKnit log behind the flat load/run/append contract
 * runAgent's callers use. Shared by both the file- and Redis-backed
 * stores below — only the Storage and the lock differ. */
class SessionKnitStore implements SessionStore {
  private readonly knit: SessionKnit<Message>

  constructor(
    storage: Storage<Message>,
    private readonly lock: <T>(sessionId: string, fn: () => Promise<T>) => Promise<T>,
    private readonly onClose: () => Promise<void> = async () => {},
  ) {
    this.knit = new SessionKnit<Message>(storage, { hasUnresolvedToolCall, buildContinuation })
  }

  async withSession<T>(sessionId: string, fn: (history: Message[]) => Promise<SessionResult<T>>): Promise<T> {
    return this.lock(sessionId, async () => {
      const { messages, leafId } = await this.knit.resume(sessionId)
      const { newMessages, result } = await fn(messages)

      let parentId = leafId
      for (const message of newMessages) {
        const id = randomUUID()
        await this.knit.append(sessionId, { id, parentId, message })
        parentId = id
      }
      await this.knit.flush(sessionId)

      return result
    })
  }

  async close(): Promise<void> {
    await this.onClose()
  }
}

const fileMutex = new KeyedMutex()

/** One JSONL entry log per session under `dir`. Fine for a single local
 * process (CLI, dev server); not safe across multiple processes/instances
 * — those need RedisSessionStore. */
export class FileSessionStore extends SessionKnitStore {
  constructor(dir: string) {
    super(new FileStorage<Message>(dir), (sessionId, fn) => fileMutex.run(path.resolve(dir, sessionId), fn))
  }
}

/** SessionKnit Storage backed by a Redis list — one RPUSH per appended
 * entry. Redis is already durable per write, so unlike FileStorage there's
 * nothing to debounce: flush() is a no-op. */
class RedisEntryStorage implements Storage<Message> {
  constructor(private readonly redis: Redis) {}

  private keyFor(sessionId: string): string {
    return `session-log:${sessionId}`
  }

  async append(sessionId: string, entry: SessionEntry<Message>): Promise<void> {
    await this.redis.rpush(this.keyFor(sessionId), JSON.stringify(entry))
  }

  async flush(): Promise<void> {}

  async readAll(sessionId: string): Promise<SessionEntry<Message>[]> {
    const raw = await this.redis.lrange(this.keyFor(sessionId), 0, -1)
    return raw.map((line) => JSON.parse(line) as SessionEntry<Message>)
  }
}

export interface RedisSessionStoreOptions {
  lockTtlMs?: number
  lockRetryDelayMs?: number
  lockMaxWaitMs?: number
  /** Inject a pre-built client instead of connecting from redisUrl — e.g. to pass a fake in tests. */
  client?: Redis
}

const UNLOCK_IF_OWNER_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
const RENEW_IF_OWNER_SCRIPT = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`

/** Redis-backed store for multi-instance deployments. Locking is a
 * single-instance-Redis lock (SET NX PX + a compare-and-delete unlock
 * script) — good enough as long as session state lives in one Redis; true
 * multi-node Redlock is overkill until it doesn't. This lock is what keeps
 * two concurrent turns for the same session from interleaving appends
 * across instances — SessionKnit's own topology repair handles branching
 * *within* one resumed chain, not that. */
export class RedisSessionStore extends SessionKnitStore {
  private readonly redis: Redis
  private readonly lockTtlMs: number
  private readonly lockRetryDelayMs: number
  private readonly lockMaxWaitMs: number

  constructor(redisUrl: string, options: RedisSessionStoreOptions = {}) {
    const redis = options.client ?? new Redis(redisUrl)
    super(
      new RedisEntryStorage(redis),
      (sessionId, fn) => this.withLock(sessionId, fn),
      () => redis.quit().then(() => {}),
    )
    this.redis = redis
    this.lockTtlMs = options.lockTtlMs ?? 30_000
    this.lockRetryDelayMs = options.lockRetryDelayMs ?? 50
    this.lockMaxWaitMs = options.lockMaxWaitMs ?? 15_000
  }

  private lockKeyFor(sessionId: string): string {
    return `session-lock:${sessionId}`
  }

  /** True if we still (or again) hold the lock after this call — false
   * means someone else's SET NX PX has already replaced ours. A thrown
   * error here doesn't mean that on its own; it's treated as "try again
   * next tick" by the caller, since a transient network blip renewing the
   * TTL isn't proof the lock is actually gone. */
  private async renewLock(lockKey: string, token: string): Promise<boolean> {
    const result = await this.redis.eval(RENEW_IF_OWNER_SCRIPT, 1, lockKey, token, this.lockTtlMs)
    return result === 1
  }

  private async withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = this.lockKeyFor(sessionId)
    const token = randomUUID()
    const deadline = Date.now() + this.lockMaxWaitMs
    for (;;) {
      const ok = await this.redis.set(lockKey, token, 'PX', this.lockTtlMs, 'NX')
      if (ok) break
      if (Date.now() > deadline) throw new Error(`timed out waiting for lock on session '${sessionId}'`)
      await new Promise((resolve) => setTimeout(resolve, this.lockRetryDelayMs))
    }

    // Without renewal, a turn that runs longer than lockTtlMs (a real
    // model call plus several tool round-trips easily can) would
    // silently lose the lock mid-flight — a second concurrent request
    // for the same session could then acquire it and run concurrently,
    // interleaving appends into the same durable log. Renewing at a
    // fraction of the TTL (not waiting until right before expiry) leaves
    // real margin for a slow renewal call itself to still land in time.
    // Recursive setTimeout, not setInterval, so a slow renewal can never
    // overlap with the next one — each renewal only schedules the next
    // after the previous has settled.
    let lockLost = false
    let renewTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRenewal = (): void => {
      renewTimer = setTimeout(async () => {
        try {
          if (!(await this.renewLock(lockKey, token))) {
            lockLost = true
            return // confirmed gone — no point scheduling further renewals
          }
        } catch {
          // Renewal call itself failed (network blip, etc.) — not proof
          // the lock is lost, only a confirmed token mismatch is. Try
          // again next tick; the TTL still bounds how long we can be
          // wrong about still holding it.
        }
        scheduleRenewal()
      }, Math.floor(this.lockTtlMs / 3))
    }
    scheduleRenewal()

    try {
      const result = await fn()
      if (lockLost) {
        // fn() already ran to completion — there's no way to undo or
        // cancel work already in flight, only to make the failure loud
        // instead of silently returning as if mutual exclusion held the
        // whole time. Whatever this turn wrote may be interleaved with a
        // concurrent request's writes.
        throw new Error(
          `lock for session '${sessionId}' was lost mid-turn — a concurrent request may have run ` +
            'against the same session; this turn\'s result should not be trusted',
        )
      }
      return result
    } finally {
      clearTimeout(renewTimer)
      // Only delete if we still hold it — otherwise we'd release a lock our
      // TTL already expired and a different request has since acquired.
      await this.redis.eval(UNLOCK_IF_OWNER_SCRIPT, 1, lockKey, token)
    }
  }
}

/** Picks the store from environment so adapters don't hardcode a backend:
 * REDIS_URL set -> RedisSessionStore (required once you run >1 instance),
 * otherwise FileSessionStore under .sessions (fine for local dev). */
export function createSessionStore(): SessionStore {
  const redisUrl = process.env.REDIS_URL
  return redisUrl ? new RedisSessionStore(redisUrl) : new FileSessionStore('.sessions')
}
