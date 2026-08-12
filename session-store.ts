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
import type { Message } from 'contextclip'

export interface SessionResult<T> {
  history: Message[]
  result: T
}

export interface SessionStore {
  /** Loads history for sessionId, runs fn exclusively — no other
   * withSession call for the same sessionId runs concurrently, in this
   * process or (for RedisSessionStore) any other — appends the new
   * messages fn's result adds, and resolves with fn's result. */
  withSession<T>(sessionId: string, fn: (history: Message[]) => Promise<SessionResult<T>>): Promise<T>
  close(): Promise<void>
}

/** Serializes async work per key within this process. Good enough for
 * FileSessionStore (single process); RedisSessionStore needs a real
 * distributed lock instead since multiple server instances share it. */
class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prevTail = this.tails.get(key) ?? Promise.resolve()
    const result = prevTail.then(fn, fn)
    this.tails.set(
      key,
      result.catch(() => {}),
    )
    return result
  }
}

// run-agent.ts pushes exactly one "[requested: tool_a, tool_b]" assistant
// message before any tool executes, then one "[tool result]" user message
// per completed tool as they finish (adapters/http.ts, adapters/cli.ts
// never see this — it lives entirely inside the messages array runAgent
// returns). If the process dies in that window, the request message is the
// last thing on disk with no result behind it.
function hasUnresolvedToolCall(message: Message): boolean {
  return message.role === 'assistant' && message.content.startsWith('[requested:')
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
      const { history: nextHistory, result } = await fn(messages)

      // Everything fn's history grew by beyond what resume() handed it —
      // this naturally excludes the synthetic continuation message too
      // (it's already counted in messages.length), which is exactly right:
      // it's a resend-only hint, never meant to be durably stored.
      let parentId = leafId
      for (const message of nextHistory.slice(messages.length)) {
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

/** Redis-backed store for multi-instance deployments. Locking is a
 * single-instance-Redis lock (SET NX PX + a compare-and-delete unlock
 * script) — good enough as long as session state lives in one Redis; true
 * multi-node Redlock is overkill until it doesn't. This lock is what keeps
 * two concurrent turns for the same session from interleaving appends
 * across instances — SessionKnit's own topology repair handles branching
 * *within* one resumed chain, not that. */
export class RedisSessionStore extends SessionKnitStore {
  private readonly redis: Redis

  constructor(
    redisUrl: string,
    private readonly lockTtlMs = 30_000,
    private readonly lockRetryDelayMs = 50,
    private readonly lockMaxWaitMs = 15_000,
  ) {
    const redis = new Redis(redisUrl)
    super(
      new RedisEntryStorage(redis),
      (sessionId, fn) => this.withLock(sessionId, fn),
      () => redis.quit().then(() => {}),
    )
    this.redis = redis
  }

  private lockKeyFor(sessionId: string): string {
    return `session-lock:${sessionId}`
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
    try {
      return await fn()
    } finally {
      // Only delete if we still hold it — otherwise we'd release a lock our
      // TTL already expired and a different request has since acquired.
      const script = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`
      await this.redis.eval(script, 1, lockKey, token)
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
