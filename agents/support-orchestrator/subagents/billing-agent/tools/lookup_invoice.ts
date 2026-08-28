import type { ToolDefinition } from '#core/agent-config.js'

const invoices: Record<string, { amount: number; description: string; paidOn: string }> = {
  'INV-1002': { amount: 49, description: 'Pro plan renewal', paidOn: '2026-08-01' },
  'INV-1001': { amount: 49, description: 'Pro plan renewal', paidOn: '2026-07-01' },
}

export const lookupInvoice: ToolDefinition = {
  name: 'lookup_invoice',
  description: "Look up an invoice's amount, description, and paid date",
  input_schema: { type: 'object', properties: { invoiceId: { type: 'string' } }, required: ['invoiceId'] },
  execute: async (input) => invoices[input.invoiceId as string] ?? { error: 'not found' },
  // Read-only, no side effects — same reasoning
  // agents/customer-service/tools/lookup_order.ts marks itself safe.
  safe: true,
}
