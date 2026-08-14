// Shared in-memory order data — lookup_order.ts reads it, issue_refund.ts
// mutates it. Both need the exact same store so a refund is immediately
// visible to a subsequent lookup within the same process, which is why
// this lives in its own file rather than being duplicated or declared
// inside either tool file.
export const orders: Record<string, { total: number; status: string }> = {
  'A-1001': { total: 42.5, status: 'delivered' },
}
