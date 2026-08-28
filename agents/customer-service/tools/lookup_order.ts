import type { ToolDefinition } from '#core/agent-config.js'
import { orders } from './orders-store.js'

export const lookupOrder: ToolDefinition = {
  name: 'lookup_order',
  description: "Look up an order's total and status",
  input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
  execute: async (input) => orders[input.orderId as string] ?? { error: 'not found' },
  // Read-only, no side effects — safe to run in ToolLane's parallel lane
  // alongside get_shipment_details. See agents/customer-service/index.ts:
  // no isSafeTool set there, so this flag is what actually governs it.
  safe: true,
}
