// A second, unrelated agent — different persona, different tools, no
// skills at all — proving runAgent doesn't know or care what kind of
// agent it's driving. Only this file and its AgentConfig change.
import { createServer } from 'node:http'
import type { AgentConfig } from '../agent-config.js'
import { runAgent, type ModelCall } from '../run-agent.js'

const orders: Record<string, { total: number; status: string }> = {
  'A-1001': { total: 42.5, status: 'delivered' },
}

const shipments: Record<string, { carrier: string; trackingNumber: string; status: string }> = {
  'A-1001': { carrier: 'FastShip', trackingNumber: 'FS123456789', status: 'delivered' },
}

// Stands in for a real shipping-carrier API — an actual local HTTP
// server, so get_shipment_details.execute() below is a genuine fetch()
// and response-handling path (status codes, JSON parsing, a real 404),
// not another in-memory lookup like lookup_order. Started lazily on
// first use, not at module load, so importing this file (e.g. via
// agent-registry.ts) never opens a socket for an agent that's never run.
let shipmentApiUrl: Promise<string> | null = null

function ensureShipmentApi(): Promise<string> {
  if (!shipmentApiUrl) {
    shipmentApiUrl = new Promise((resolve) => {
      const server = createServer((req, res) => {
        const orderId = decodeURIComponent(req.url?.split('/').pop() ?? '')
        const shipment = shipments[orderId]
        if (!shipment) {
          res.writeHead(404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'not found' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(shipment))
      })
      server.unref() // don't keep a one-shot CLI invocation alive just for this
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : 0
        resolve(`http://127.0.0.1:${port}`)
      })
    })
  }
  return shipmentApiUrl
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
      name: 'get_shipment_details',
      description: "Look up an order's carrier, tracking number, and delivery status",
      input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
      // A real fetch() call, same shape a real shipping-carrier API
      // integration would have — see run-agent.ts:144 for the one place
      // this actually gets invoked.
      execute: async (input) => {
        const baseUrl = await ensureShipmentApi()
        const res = await fetch(`${baseUrl}/shipments/${encodeURIComponent(input.orderId as string)}`)
        if (!res.ok) return { error: `shipment lookup failed: ${res.status}` }
        return res.json()
      },
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
    { scopePattern: 'default/production/customer-service', tool: 'get_shipment_details', decision: 'allow' },
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
  // Both read-only lookups run together in ToolLane's parallel lane —
  // issue_refund and send_email have side effects, so each still gets
  // its own solo lane.
  isSafeTool: (call) => call.name === 'lookup_order' || call.name === 'get_shipment_details',
}

// SIMULATED model call — see file-agent.ts for why this is a factory
// rather than a single shared closure.
export function createModelCall(): ModelCall {
  let turn = 0
  return async () => {
    turn++
    if (turn === 1) {
      // Both read-only lookups requested in the same turn — ToolLane runs
      // them together in its parallel lane (see isSafeTool above).
      return {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 't1', name: 'lookup_order', input: { orderId: 'A-1001' } },
          { type: 'tool_use', id: 't1b', name: 'get_shipment_details', input: { orderId: 'A-1001' } },
        ],
      }
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
    return {
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: 'Done — confirmed delivery via FastShip tracking FS123456789, refunded order A-1001, and emailed the customer.',
        },
      ],
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAgent(config, createModelCall(), 'Customer says order A-1001 arrived broken and wants a refund.', [], {
    onEvent: (event, detail) => console.log(`[${event}]`, detail),
  }).then((result) => console.log('\n[final]', result.text))
}
