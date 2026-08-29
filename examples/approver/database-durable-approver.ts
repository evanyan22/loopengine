// Reference DurableApprover implementation: writes a row instead of
// firing a webhook — the "writing straight to a database" option flagged
// as unbuilt in DURABLE_APPROVALS.md's own open questions. Copyable, not
// required: same tier as examples/chatbox/react and examples/chatbox/vue.
//
// Deliberately driver-agnostic — no Postgres/MySQL/SQLite client is a
// dependency here, so PendingApprovalsRepository is the seam: implement
// insert() against whatever real database/ORM you already have (a single
// INSERT, a Prisma/Drizzle create call, anything), and
// DatabaseDurableApprover needs nothing else from it.
//
// Whatever eventually reads this table (a cron job, an admin dashboard
// query) still has to end up calling POST
// /pending-approvals/:pendingId/resolve to actually decide it — this
// class, like DurableWebApprover, only owns creating the pending record;
// "what happens next" is the same checkpoint/resolve machinery
// regardless of which DurableApprover produced the pendingId.
import { randomUUID } from 'node:crypto'
import type { DurableApprover, Scope } from 'actauth'

export interface PendingApprovalRow {
  pendingId: string
  tool: string
  args: Record<string, unknown>
  scope: Scope
  reason: string
  requestedAt: string
}

export interface PendingApprovalsRepository {
  insert(row: PendingApprovalRow): Promise<void>
}

export class DatabaseDurableApprover implements DurableApprover {
  constructor(private readonly repository: PendingApprovalsRepository) {}

  requestDurableApproval(
    tool: string,
    args: Record<string, unknown>,
    scope: Scope,
    reason: string,
  ): { pendingId: string } {
    const pendingId = randomUUID()
    const row: PendingApprovalRow = { pendingId, tool, args, scope, reason, requestedAt: new Date().toISOString() }

    // Not awaited — same contract DurableWebApprover follows (see its own
    // doc comment): requestDurableApproval returns immediately, by
    // design, so an insert failure here can only be logged, not thrown —
    // the decision has already, correctly, been recorded as pending
    // regardless of whether this write succeeds.
    this.repository.insert(row).catch((err) => {
      console.error(`[examples/approver] DatabaseDurableApprover: insert failed for pendingId '${pendingId}':`, err)
    })

    return { pendingId }
  }
}

/** Illustrative stand-in for a real database — swap for your own
 * Postgres/MySQL/SQLite/whatever client implementing the same insert()
 * signature. Exists so this file is genuinely runnable/testable without
 * standing up a real database first, the same reason actauth's own
 * ConsoleApprover exists — not something meant for production use. */
export class InMemoryPendingApprovalsRepository implements PendingApprovalsRepository {
  readonly rows: PendingApprovalRow[] = []

  async insert(row: PendingApprovalRow): Promise<void> {
    this.rows.push(row)
  }
}
