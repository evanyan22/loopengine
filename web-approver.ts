// adapters/http.ts's wiring around actauth's WebApprover (see its own
// approvers.ts) — one process can have several WebApprover instances
// live at once (see createTrackedApprover's own doc comment for why),
// so POST /approvals/:id/approve|deny needs to know which instance
// actually owns a given pending id before it can call decide() on it.
// That routing table is what this file owns; the approver class itself
// stays in actauth, generic and framework-agnostic.
import { WebApprover, type PendingApproval } from 'actauth'

const approversById = new Map<string, WebApprover>()

// Which session each *instance* is serving — not each pending approval,
// because a single WebApprover instance only ever needs to serve one
// session's worth of calls: both adapters/http.ts routes now create a
// fresh tracked approver per call (see createTrackedApprover's own doc
// comment), so this is always known, not best-effort. A WeakMap, not a
// Map, so an old instance (nothing else references it once its own
// approvals are gone) doesn't get held alive forever just for this
// bookkeeping.
const sessionByApprover = new WeakMap<WebApprover, string>()

/** Every WebApprover a request might end up using should be created
 * through this, not `new WebApprover()` directly — the id it hands out
 * on each new pending approval is otherwise unreachable from
 * decideApproval()/listApprovals() below. Both adapters/http.ts routes
 * call this once per turn, with that turn's own sessionId: the streaming
 * route wires onPending to an SSE event on that exact response so the
 * approval popup appears inline in the conversation that's actually
 * blocked on it; the plain route wires it to resolve the early-return
 * race handleMessages uses instead of blocking indefinitely (see its own
 * doc comment) — same reason, no HTTP request should hang on a human
 * with nothing telling the caller that's what's happening. */
export function createTrackedApprover(sessionId: string, onPending?: (approval: PendingApproval) => void): WebApprover {
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
  sessionByApprover.set(approver, sessionId)
  return approver
}

/** Every currently-pending approval, from any tracked instance. Unfiltered
 * (both omitted) returns every approval pending anywhere in this process,
 * across every agent, tenant, and session — real uses (an operator's own
 * admin view, say) should filter; both agent and session scoping are
 * exact (agent from actauth's own Scope, already on every PendingApproval;
 * session from sessionByApprover, always known — see its own doc
 * comment). */
export function listApprovals(filter?: { agent?: string; sessionId?: string }): PendingApproval[] {
  const results: PendingApproval[] = []
  for (const approver of new Set(approversById.values())) {
    const sessionId = sessionByApprover.get(approver)
    for (const approval of approver.list()) {
      if (filter?.agent && approval.scope.agent !== filter.agent) continue
      if (filter?.sessionId && sessionId !== filter.sessionId) continue
      results.push(approval)
    }
  }
  return results
}

/** Routes to whichever WebApprover instance actually owns `id` — the
 * caller doesn't need to know which turn/session created it. */
export function decideApproval(id: string, approved: boolean): boolean {
  const approver = approversById.get(id)
  if (!approver) return false
  return approver.decide(id, approved)
}
