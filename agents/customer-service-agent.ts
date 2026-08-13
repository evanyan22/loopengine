// A second, unrelated agent — different persona, different tools, no
// skills at all — proving runAgent doesn't know or care what kind of
// agent it's driving. Only this file and its AgentConfig change.
import { createHash } from 'node:crypto'
import type { AgentConfig } from '../agent-config.js'
import { runAgent, type ModelCall } from '../run-agent.js'

const orders: Record<string, { total: number; status: string }> = {
  'A-1001': { total: 42.5, status: 'delivered' },
}

// This agent's own session-key derivation — a customer's identity (their
// email) is what "one conversation" means here, so that mapping lives on
// this AgentConfig rather than being hardcoded in adapters/http.ts for
// every agent it might ever route to (file-agent, rag-agent, ... have no
// concept of "customer" at all). Hashed so raw emails never end up in
// Redis keys / filenames; conversationId lets one customer have more than
// one thread (defaults to a single ongoing conversation per customer).
function sessionIdFor(body: Record<string, unknown>): string | undefined {
  const customerEmail = typeof body.customerEmail === 'string' ? body.customerEmail.trim() : ''
  if (!customerEmail) return undefined
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId : 'default'
  const hash = createHash('sha256').update(customerEmail.toLowerCase()).digest('hex').slice(0, 24)
  return `customer-${hash}-${conversationId}`
}

// `.example` is IANA-reserved for documentation (RFC 2606) — guaranteed
// never to resolve to a real service. Point this at your real
// shipping-carrier API's base URL; get_shipment_details.execute() below
// doesn't otherwise change.
const SHIPMENT_API_URL = 'https://api.shipping-carrier.example/v1'

// Deployment-time constant, deliberately not read from anything in an
// incoming request — a client asserting "treat me as staging" would be a
// straightforward way to get production's stricter rules bypassed. Set
// this per deployment (e.g. in the staging environment's own env vars),
// never derived from caller-supplied data. Matches run-agent.ts's own
// default ('production') when unset, so not setting this changes nothing.
const ENVIRONMENT = process.env.LOOPENGINE_ENV ?? 'production'

export const config: AgentConfig = {
  name: 'customer-service',
  systemPrompt: 'You are a support agent for Acme. Be concise and empathetic. Never promise a refund before issue_refund succeeds.',
  // Only overrides environment — tenant stays run-agent.ts's own default
  // ('default'), since nothing here (yet) differentiates by tenant.
  scope: { environment: ENVIRONMENT },
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
    // These three don't depend on environment — same decision whether
    // staging or production — so the environment segment is wildcarded
    // rather than duplicated per environment.
    { scopePattern: 'default/*/customer-service', tool: 'lookup_order', decision: 'allow' },
    { scopePattern: 'default/*/customer-service', tool: 'get_shipment_details', decision: 'allow' },
    { scopePattern: 'default/*/customer-service', tool: 'send_email', decision: 'allow' },
    // issue_refund is the one tool where environment matters: staging
    // never moves real money, so it's safe to skip the human-in-the-loop
    // step there and let QA iterate without approving every test run;
    // production always needs one, since a real refund happens. Same
    // rules array, same agent code, different behavior per deployment —
    // driven entirely by ENVIRONMENT above, no code fork.
    { scopePattern: 'default/staging/customer-service', tool: 'issue_refund', decision: 'allow' },
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
  sessionIdFor,
  // Scoped to this agent's own subdirectory, not the shared skills/ root —
  // see file-agent.ts's skillsDirs comment for why (discovery has no
  // per-agent filtering).
  skillsDirs: ['skills/customer-service'],
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
          text: 'Done — refunded order A-1001 and emailed the customer.',
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
