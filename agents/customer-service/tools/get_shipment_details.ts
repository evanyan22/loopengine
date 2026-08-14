import type { ToolDefinition } from '../../../agent-config.js'

// `.example` is IANA-reserved for documentation (RFC 2606) — guaranteed
// never to resolve to a real service. Point this at your real
// shipping-carrier API's base URL; execute() below doesn't otherwise change.
const SHIPMENT_API_URL = 'https://api.shipping-carrier.example/v1'

export const getShipmentDetails: ToolDefinition = {
  name: 'get_shipment_details',
  description: "Look up an order's carrier, tracking number, and delivery status",
  input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
  // A real fetch() call, same shape a real shipping-carrier API
  // integration would have — see run-agent.ts:144 for the one place
  // this actually gets invoked. SHIPMENT_API_URL is a placeholder, so
  // this rejects when actually run; ToolLane isolates that failure to
  // this one call (see toollane:result in the demo's onEvent log)
  // rather than it taking down the rest of the turn.
  execute: async (input) => {
    const res = await fetch(`${SHIPMENT_API_URL}/shipments/${encodeURIComponent(input.orderId as string)}`, {
      headers: { Authorization: `Bearer ${process.env.SHIPPING_API_KEY}` },
    })
    if (!res.ok) return { error: `shipment lookup failed: ${res.status}` }
    return res.json()
  },
  // Read-only, no side effects — safe to run in ToolLane's parallel lane
  // alongside lookup_order. See lookup_order.ts's own comment.
  safe: true,
}
