// Reference DurableApprover implementation: pushes to a Redis list
// instead of firing a webhook — the "pushing to a queue" option flagged
// as unbuilt in DURABLE_APPROVALS.md's own open questions. Copyable, not
// required: same tier as examples/chatbox/react and examples/chatbox/vue — proves
// the shape works, isn't wired into any shipped agent. Uses `ioredis`,
// already a real dependency here (core/session-store.ts's own
// RedisSessionStore), so no new dependency to add.
//
// Whatever drains the queue (consumePendingApprovals below, or your own
// worker) still has to end up calling POST
// /pending-approvals/:pendingId/resolve to actually decide it — this
// class, like DurableWebApprover, only owns creating the pending record
// and one notification side effect; "what happens next" is the same
// checkpoint/resolve machinery regardless of which DurableApprover
// produced the pendingId.
import { randomUUID } from 'node:crypto'
import type { Redis } from 'ioredis'
import type { DurableApprover, Scope } from 'actauth'

export interface QueuedApproval {
  pendingId: string
  tool: string
  args: Record<string, unknown>
  scope: Scope
  reason: string
  requestedAt: string
}

export interface RedisQueueDurableApproverOptions {
  redis: Redis
  /** Default 'durable-approvals:queue' — override if you're running more
   * than one of these against the same Redis instance and want separate
   * queues (e.g. one per agent, or per severity). */
  queueKey?: string
}

export class RedisQueueDurableApprover implements DurableApprover {
  private readonly redis: Redis
  private readonly queueKey: string

  constructor(options: RedisQueueDurableApproverOptions) {
    this.redis = options.redis
    this.queueKey = options.queueKey ?? 'durable-approvals:queue'
  }

  requestDurableApproval(
    tool: string,
    args: Record<string, unknown>,
    scope: Scope,
    reason: string,
  ): { pendingId: string } {
    const pendingId = randomUUID()
    const entry: QueuedApproval = { pendingId, tool, args, scope, reason, requestedAt: new Date().toISOString() }

    // Not awaited — same contract DurableWebApprover follows (see its own
    // doc comment): requestDurableApproval returns immediately, by
    // design, so a delivery failure here can only be logged, not thrown
    // — the decision has already, correctly, been recorded as pending
    // regardless of whether this push succeeds.
    this.redis.rpush(this.queueKey, JSON.stringify(entry)).catch((err) => {
      console.error(`[examples/approver] RedisQueueDurableApprover: rpush failed for pendingId '${pendingId}':`, err)
    })

    return { pendingId }
  }
}

/** Worker-side companion — drains the queue this approver pushes onto,
 * one entry at a time, blocking (BLPOP) rather than polling. Illustrative
 * only: a real worker would take each QueuedApproval here and do
 * something with it (post to Slack, send an email, write a row somewhere
 * an admin UI reads from) before the human eventually hits
 * POST /pending-approvals/:pendingId/resolve — this function only gets
 * you the queued entries themselves, not a notification channel. */
export async function* consumePendingApprovals(
  redis: Redis,
  queueKey = 'durable-approvals:queue',
): AsyncGenerator<QueuedApproval> {
  for (;;) {
    // 0 = block forever. BLPOP's own reply is [key, value] | null (null
    // only on a client-side timeout, which never happens here).
    const result = await redis.blpop(queueKey, 0)
    if (!result) continue
    yield JSON.parse(result[1]) as QueuedApproval
  }
}
