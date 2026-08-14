import type { ToolDefinition } from '../../../agent-config.js'
import { orders } from './orders-store.js'

export const issueRefund: ToolDefinition = {
  name: 'issue_refund',
  description: 'Refund an order in full',
  input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
  execute: async (input) => {
    const order = orders[input.orderId as string]
    if (!order) return { error: 'not found' }
    order.status = 'refunded'
    return { refunded: order.total }
  },
}
