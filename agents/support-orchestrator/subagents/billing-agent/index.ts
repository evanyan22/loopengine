// A subagent — same AgentConfig shape as a top-level agent, just nested
// under its parent's subagents/ folder. tools and rules are both
// intentionally omitted here: they resolve against *this* folder
// (./tools/index.ts, ./actauth.yml), not agents/billing-agent/ — see
// run-agent.ts's resolveSubagentConfig for why that distinction needs
// its own logic, and ./actauth.yml / ./tools/index.ts for what actually
// gets picked up.
//
// '#*' imports (package.json's own `imports` field, resolved
// repo-root-relative) instead of '../../../../agent-config.js' — nesting
// under subagents/ makes relative paths climb an extra level per level of
// nesting, so this stays flat regardless of how deep an agent lives.
import type { AgentConfig } from '#agent-config.js'
import type { ModelCall } from '#run-agent.js'

export const config: AgentConfig = {
  name: 'billing-agent',
  systemPrompt: 'You answer billing questions using lookup_invoice. Be concise — one sentence.',
  // Read by support-orchestrator's model to decide when to delegate here
  // (see AgentConfig.toolDescription's own doc comment) — required, or
  // agentAsTool throws at load time.
  toolDescription: 'Call this for any question about an invoice, charge, or payment.',
}

// SIMULATED — see agents/support-orchestrator/index.ts's own comment.
export function createModelCall(): ModelCall {
  let turn = 0
  return async () => {
    turn++
    if (turn === 1) {
      return {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 'b1', name: 'lookup_invoice', input: { invoiceId: 'INV-1002' } }],
      }
    }
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'INV-1002 is a $49 charge for the Pro plan, paid 2026-08-01.' }],
    }
  }
}
