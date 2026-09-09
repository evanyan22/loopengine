// Formerly the standalone `sessionknit` package — folded in here for the
// same reason mcpplug.ts and toollane.ts were: no consumer besides
// loopengine itself (core/session-store.ts) ever actually materialized,
// so the separate-package/portable-to-any-host framing was aspirational
// rather than realized. Durable, parent-linked session persistence:
// append never blocks, resume runs topology repair for parallel
// tool-call siblings, and detects a session that ended mid-turn rather
// than cleanly — see session-store.ts's own header comment for why this
// matters for a real agent loop specifically.
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** One node in the session's parent-linked tree. Multiple entries can
 * share the same parentId — that's exactly what a turn with parallel
 * tool calls produces (siblings), not an error case. */
export interface SessionEntry<TMessage> {
  id: string
  parentId: string | null
  message: TMessage
}

export interface ResumeResult<TMessage> {
  messages: TMessage[]
  /** True if the session ended mid-turn (an unresolved tool call with
   * no result) rather than cleanly. */
  resumedAfterInterruption: boolean
  /** id of the last *durably stored* entry in the reconstructed chain —
   * null for a brand-new session. Excludes any synthetic continuation
   * (that message was never appended), so a caller resuming a session and
   * then appending new entries should parent the first one on this, not
   * on the last entry of `messages`. */
  leafId: string | null
}

export interface SessionKnitOptions<TMessage> {
  /** Does this message contain a tool call with no result yet? Used to
   * detect a session that ended mid-turn. No default — a format SessionKnit
   * doesn't recognize is treated as clean rather than guessed at. */
  hasUnresolvedToolCall?: (message: TMessage) => boolean
  /** Given the unresolved message, build a synthetic continuation to
   * append so the reconstructed chain is valid to resend to a model. */
  buildContinuation?: (message: TMessage) => TMessage
}

export interface Storage<TMessage> {
  append(sessionId: string, entry: SessionEntry<TMessage>): Promise<void>
  /** Force any pending writes to be durable. */
  flush(sessionId: string): Promise<void>
  readAll(sessionId: string): Promise<SessionEntry<TMessage>[]>
}

/** Append-only JSONL storage with a debounced, batched write-behind
 * queue — append() never blocks the caller. flush() (called
 * automatically before every resume) forces pending lines to disk. */
export class FileStorage<TMessage> implements Storage<TMessage> {
  private readonly pending = new Map<string, string[]>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly dir: string,
    private readonly debounceMs: number = 100,
  ) {}

  private pathFor(sessionId: string): string {
    // sessionId is caller-controlled and often comes straight from
    // untrusted input (a CLI flag, an HTTP body) — strip path separators so
    // it can't escape `dir` via `../` traversal.
    const safeId = sessionId.replace(/[/\\]/g, '_')
    return join(this.dir, `${safeId}.jsonl`)
  }

  async append(sessionId: string, entry: SessionEntry<TMessage>): Promise<void> {
    const lines = this.pending.get(sessionId) ?? []
    lines.push(JSON.stringify(entry))
    this.pending.set(sessionId, lines)

    if (!this.timers.has(sessionId)) {
      const timer = setTimeout(() => {
        this.timers.delete(sessionId)
        void this.drain(sessionId)
      }, this.debounceMs)
      this.timers.set(sessionId, timer)
    }
  }

  async flush(sessionId: string): Promise<void> {
    const timer = this.timers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(sessionId)
    }
    await this.drain(sessionId)
  }

  private async drain(sessionId: string): Promise<void> {
    const lines = this.pending.get(sessionId)
    if (!lines || lines.length === 0) return
    this.pending.delete(sessionId)

    const path = this.pathFor(sessionId)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${lines.join('\n')}\n`)
  }

  async readAll(sessionId: string): Promise<SessionEntry<TMessage>[]> {
    try {
      const content = await readFile(this.pathFor(sessionId), 'utf8')
      return content
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as SessionEntry<TMessage>)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}

/** Same debounce/flush contract as FileStorage, backed by memory instead
 * of disk — useful for tests, and a second real example proving the
 * Storage interface is genuinely swappable for a host that wants a
 * database or S3 backend instead. */
export class MemoryStorage<TMessage> implements Storage<TMessage> {
  private readonly committed = new Map<string, SessionEntry<TMessage>[]>()
  private readonly pending = new Map<string, SessionEntry<TMessage>[]>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly debounceMs: number = 100) {}

  async append(sessionId: string, entry: SessionEntry<TMessage>): Promise<void> {
    const items = this.pending.get(sessionId) ?? []
    items.push(entry)
    this.pending.set(sessionId, items)

    if (!this.timers.has(sessionId)) {
      const timer = setTimeout(() => {
        this.timers.delete(sessionId)
        this.drain(sessionId)
      }, this.debounceMs)
      this.timers.set(sessionId, timer)
    }
  }

  async flush(sessionId: string): Promise<void> {
    const timer = this.timers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(sessionId)
    }
    this.drain(sessionId)
  }

  private drain(sessionId: string): void {
    const items = this.pending.get(sessionId)
    if (!items || items.length === 0) return
    this.pending.delete(sessionId)
    const existing = this.committed.get(sessionId) ?? []
    this.committed.set(sessionId, [...existing, ...items])
  }

  async readAll(sessionId: string): Promise<SessionEntry<TMessage>[]> {
    return this.committed.get(sessionId) ?? []
  }
}

export interface ReconstructResult<TMessage> {
  messages: TMessage[]
  entries: SessionEntry<TMessage>[]
}

/** Pure reconstruction — no I/O, so it's testable without a storage
 * backend. Walks parentId from the target leaf back to the root, then
 * runs topology repair: at each node on that path, any *other* children
 * (siblings of the node that continues the path) are reattached too —
 * exactly what a turn with parallel tool calls produces, and exactly
 * what a naive single-parent walk would silently drop. */
export function reconstructChain<TMessage>(
  entries: SessionEntry<TMessage>[],
  leafId?: string,
): ReconstructResult<TMessage> {
  if (entries.length === 0) return { messages: [], entries: [] }

  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const childrenOf = new Map<string | null, SessionEntry<TMessage>[]>()
  for (const entry of entries) {
    const list = childrenOf.get(entry.parentId) ?? []
    list.push(entry)
    childrenOf.set(entry.parentId, list)
  }

  const target = leafId !== undefined ? byId.get(leafId) : entries[entries.length - 1]
  if (!target) {
    throw new Error(`Unknown entry '${leafId}'`)
  }

  // Walk parentId back to the root, collecting root-to-leaf order.
  const path: SessionEntry<TMessage>[] = []
  let current: SessionEntry<TMessage> | undefined = target
  while (current) {
    path.unshift(current)
    current = current.parentId !== null ? byId.get(current.parentId) : undefined
  }

  // Topology repair.
  const repaired: SessionEntry<TMessage>[] = []
  for (let i = 0; i < path.length; i++) {
    const node = path[i]!
    repaired.push(node)
    const nextOnPath = path[i + 1]?.id
    const siblings = childrenOf.get(node.id) ?? []
    for (const sibling of siblings) {
      if (sibling.id !== nextOnPath) {
        repaired.push(sibling)
      }
    }
  }

  return { messages: repaired.map((entry) => entry.message), entries: repaired }
}

/** Durable, parent-linked session persistence: append never blocks,
 * resume runs topology repair for parallel tool-call siblings, and
 * detects a session that ended mid-turn rather than cleanly. */
export class SessionKnit<TMessage> {
  constructor(
    private readonly storage: Storage<TMessage>,
    private readonly options: SessionKnitOptions<TMessage> = {},
  ) {}

  async append(sessionId: string, entry: SessionEntry<TMessage>): Promise<void> {
    await this.storage.append(sessionId, entry)
  }

  async flush(sessionId: string): Promise<void> {
    await this.storage.flush(sessionId)
  }

  async resume(sessionId: string, leafId?: string): Promise<ResumeResult<TMessage>> {
    await this.storage.flush(sessionId)
    const entries = await this.storage.readAll(sessionId)
    const { messages, entries: repaired } = reconstructChain(entries, leafId)

    const lastEntry = repaired[repaired.length - 1]
    const interrupted = lastEntry !== undefined && (this.options.hasUnresolvedToolCall?.(lastEntry.message) ?? false)

    let finalMessages = messages
    if (interrupted && this.options.buildContinuation) {
      finalMessages = [...messages, this.options.buildContinuation(lastEntry!.message)]
    }

    return { messages: finalMessages, resumedAfterInterruption: interrupted, leafId: lastEntry?.id ?? null }
  }
}
