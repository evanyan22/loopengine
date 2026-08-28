// Demonstrates the subagent feature end to end. This orchestrator's only
// "tool" is agents/support-orchestrator/subagents/billing-agent/ — see
// run-agent.ts's loadSubagentAsTools and the README's "Subagents" section.
// Nothing here imports or registers billing-agent by hand; the folder
// alone is what wires it in.
import type { AgentConfig } from '#core/agent-config.js'
import type { ModelCall } from '#core/run-agent.js'

export const config: AgentConfig = {
  name: 'support-orchestrator',
  systemPrompt:
    'You triage customer support requests. For anything about invoices, ' +
    'charges, or payments, delegate to the billing-agent tool instead of ' +
    'answering yourself — it has the actual billing data. Answer ' +
    'everything else directly.',
  model: { provider: 'anthropic', model: 'claude-sonnet-5' },
}