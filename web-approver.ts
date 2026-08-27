// adapters/http.ts's wiring around actauth's WebApprover (see its own
// approvers.ts) — one process can have several WebApprover instances
// live at once (see createTrackedApprover's own doc comment for why),
// so POST /approvals/:id/approve|deny needs to know which instance
// actually owns a given pending id before it can call decide() on it.
// That routing table is what this file owns; the approver class itself
// stays in actauth, generic and framework-agnostic.
import { WebApprover, type PendingApproval } from 'actauth'

const approversById = new Map<string, WebApprover>()

/** Every WebApprover a request might end up using should be created
 * through this, not `new WebApprover()` directly — the id it hands out
 * on each new pending approval is otherwise unreachable from
 * decideApproval()/listApprovals() below. adapters/http.ts's streaming
 * handler calls this once per chat turn (with onPending wired to an SSE
 * event on that exact response) so the approval popup appears inline in
 * the conversation that's actually blocked on it, instead of requiring a
 * separate page a human has to remember to go check. */
export function createTrackedApprover(onPending?: (approval: PendingApproval) => void): WebApprover {
  let approver: WebApprover
  approver = new WebApprover({
    onPending: (approval) => {
      approversById.set(approval.id, approver)
      onPending?.(approval)
    },
    onSettled: (id) => {
      approversById.delete(id)
    },
  })
  return approver
}

/** Shared across every request that has no live channel to push a
 * pending approval through (the plain, non-streaming POST
 * /agents/:name/messages) — still trackable/decidable via
 * listApprovals()/decideApproval() below, just without the inline popup
 * a streamed chat turn gets. */
export const webApprover = createTrackedApprover()

/** Every currently-pending approval, from any tracked instance — the
 * shared one above plus any per-request ones a streamed chat turn is
 * still waiting on. */
export function listApprovals(): PendingApproval[] {
  return [...new Set(approversById.values())].flatMap((approver) => approver.list())
}

/** Routes to whichever WebApprover instance actually owns `id`,
 * regardless of whether it's the shared instance or a one-off from a
 * streamed request — the caller doesn't need to know which. */
export function decideApproval(id: string, approved: boolean): boolean {
  const approver = approversById.get(id)
  if (!approver) return false
  return approver.decide(id, approved)
}
