// A DurableApprover backed by a database row instead of a notification —
// the "writing straight to a database" option AgentConfig.httpNotifier's
// `channel: 'database'` constructs. Deliberately not a notification
// channel at all: nothing gets told anything — a human finds this row by
// querying it (a cron job, an admin dashboard) — so there's no
// DurableQuestionHandler sibling or lifecycle sender to merge in the way
// webhook/Slack/Lark/email have (see AgentConfig.ApprovalOnlyHttpNotifierEvent's
// own doc comment).
//
// Deliberately driver-agnostic — no Postgres/MySQL/SQLite client is a
// dependency here, so PendingApprovalsRepository (AgentConfig.ts) is the
// seam: implement insert() against whatever real database/ORM you
// already have (a single INSERT, a Prisma/Drizzle create call, anything),
// and DatabaseApprover needs nothing else from it.
//
// Whatever eventually reads this table (a cron job, an admin dashboard
// query) still has to end up calling POST
// /pending-approvals/:pendingId/resolve to actually decide it — this
// class, like WebhookApprover, only owns creating the pending record;
// "what happens next" is the same checkpoint/resolve machinery
// regardless of which DurableApprover produced the pendingId.
import { randomUUID } from 'node:crypto'
import type { DurableApprover, Scope } from 'actauth'
import type { PendingApprovalRow, PendingApprovalsRepository } from '../agent-config.js'

export class DatabaseApprover implements DurableApprover {
  constructor(private readonly repository: PendingApprovalsRepository) {}

  requestDurableApproval(
    tool: string,
    args: Record<string, unknown>,
    scope: Scope,
    reason: string,
  ): { pendingId: string } {
    const pendingId = randomUUID()
    const row: PendingApprovalRow = { pendingId, tool, args, scope, reason, requestedAt: new Date().toISOString() }

    // Not awaited — same contract WebhookApprover follows (see its own
    // doc comment): requestDurableApproval returns immediately, by
    // design, so an insert failure here can only be logged, not thrown —
    // the decision has already, correctly, been recorded as pending
    // regardless of whether this write succeeds.
    this.repository.insert(row).catch((err) => {
      console.error(`[loopengine] DatabaseApprover: insert failed for pendingId '${pendingId}':`, err)
    })

    return { pendingId }
  }
}

/** Illustrative stand-in for a real database — swap for your own
 * Postgres/MySQL/SQLite/whatever client implementing the same insert()
 * signature. Exists so this file (and AgentConfig.httpNotifier's
 * `channel: 'database'`) is genuinely runnable/testable without standing
 * up a real database first, the same reason actauth's own ConsoleApprover
 * exists — not something meant for production use. */
export class InMemoryPendingApprovalsRepository implements PendingApprovalsRepository {
  readonly rows: PendingApprovalRow[] = []

  async insert(row: PendingApprovalRow): Promise<void> {
    this.rows.push(row)
  }
}
