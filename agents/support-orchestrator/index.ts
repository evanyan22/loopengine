// Demonstrates the subagent feature end to end. This orchestrator's only
// "tool" is agents/support-orchestrator/subagents/billing-agent/ — see
// run-agent.ts's loadSubagentAsTools and the README's "Subagents" section.
// Nothing here imports or registers billing-agent by hand; the folder
// alone is what wires it in.
import type { AgentConfig } from '#agent-config.js'
import type { ModelCall } from '#run-agent.js'

export const config: AgentConfig = {
  name: 'support-orchestrator',
  systemPrompt:
    'You triage customer support requests. For anything about invoices, ' +
    'charges, or payments, delegate to the billing-agent tool instead of ' +
    'answering yourself — it has the actual billing data. Answer ' +
    'everything else directly.',
  // No tools here — its only tool comes from subagents/billing-agent/,
  // merged in automatically (see AgentConfig.tools's own doc comment).
  // No rules here — defaults to agents/support-orchestrator/actauth.yml,
  // which allows calling the billing-agent tool.
}

// SIMULATED — no ANTHROPIC_API_KEY is configured in this environment; see
// agents/file-agent/index.ts's own comment for why this exists and how to
// swap in a real model. Deterministic so `npx tsx adapters/cli.ts --agent
// support-orchestrator "..."` produces the same delegation every run.
export function createModelCall(): ModelCall {
  let turn = 0
  return async () => {
    turn++
    if (turn === 1) {
      return {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'billing-agent',
            input: { request: 'Why was I charged $49 on invoice INV-1002?' },
          },
        ],
      }
    }
    return {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Billing looked into it: INV-1002 ($49) is your Pro plan renewal for this month.' }],
    }
  }
}
