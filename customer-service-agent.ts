// A second, unrelated agent — different persona, different tools, no
// skills at all — proving runAgent doesn't know or care what kind of
// agent it's driving. Only this file and its AgentConfig change.
import type { AgentConfig } from './agent-config.js'
import { runAgent, type ModelCall } from './run-agent.js'

const orders: Record<string, { total: number; status: string }> = {
  'A-1001': { total: 42.5, status: 'delivered' },
}

export const config: AgentConfig = {
  name: 'customer-service',
  systemPrompt: 'You are a support agent for Acme. Be concise and empathetic. Never promise a refund before issue_refund succeeds.',
  tools: [
    {
      name: 'lookup_order',
      description: "Look up an order's total and status",
      input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      execute: async (input) => orders[input.orderId as string] ?? { error: 'not found' },
    },
    {
      name: 'issue_refund',
      description: 'Refund an order in full',
      input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      execute: async (input) => {
        const order = orders[input.orderId as string]
        if (!order) return { error: 'not found' }
        order.status = 'refunded'
        return { refunded: order.total }
      },
    },
    {
      name: 'send_email',
      description: 'Email the customer',
      input_schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
      execute: async (input) => `sent: ${input.body}`,
    },
  ],
  rules: [
    { scopePattern: 'default/production/customer-service', tool: 'lookup_order', decision: 'allow' },
    { scopePattern: 'default/production/customer-service', tool: 'send_email', decision: 'allow' },
    // Refunds always need a human in the loop — unlike file-agent's writes, this one moves money.
    { scopePattern: 'default/production/customer-service', tool: 'issue_refund', decision: 'ask' },
  ],
  defaultDecision: 'deny',
  approver: {
    async requestApproval(tool, args, _scope, reason) {
      console.log(`  [actauth] approval requested for ${tool}(${JSON.stringify(args)}) — ${reason}`)
      console.log('  [actauth] auto-approved for this demo (swap in SlackApprover to page a human for real refunds)')
      return true
    },
  },
  isSafeTool: (call) => call.name === 'lookup_order',
}

// SIMULATED model call — see file-agent.ts for why this is a factory
// rather than a single shared closure.
export function createModelCall(): ModelCall {
  let turn = 0
  return async () => {
    turn++
    if (turn === 1) {
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'lookup_order', input: { orderId: 'A-1001' } }] }
    }
    if (turn === 2) {
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'issue_refund', input: { orderId: 'A-1001' } }] }
    }
    if (turn === 3) {
      return {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't3', name: 'send_email', input: { body: 'Your order A-1001 has been refunded ($42.50).' } }],
      }
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done — refunded order A-1001 and emailed the customer.' }] }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAgent(config, createModelCall(), 'Customer says order A-1001 arrived broken and wants a refund.', [], {
    onEvent: (event, detail) => console.log(`[${event}]`, detail),
  }).then((result) => console.log('\n[final]', result.text))
}
