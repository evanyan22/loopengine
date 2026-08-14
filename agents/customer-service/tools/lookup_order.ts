import type { ToolDefinition } from '../../../agent-config.js'
import { orders } from './orders-store.js'

export const lookupOrder: ToolDefinition = {
  name: 'lookup_order',
  description: "Look up an order's total and status",
  input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
  execute: async (input) => orders[input.orderId as string] ?? { error: 'not found' },
}
