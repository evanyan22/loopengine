// Same file-summarizing agent as the original main.ts, rewritten as an
// AgentConfig driven through the generic runAgent loop.
//
// Everything about this one agent lives under this folder: tools/ (one
// file per hand-written tool), skills/, and actauth.yml alongside it —
// see agents/customer-service/index.ts's own comment for the full reasoning.
// The Composio-sourced GitHub tool used to be fetched here directly, at
// module-eval time, via mcpplug's connectComposioSource — it's now
// registered instead, in ./gateway-tools.yml (see gateway-tools.ts),
// picked up automatically by run-agent.ts's loadGatewayToolsFromDir on
// every request, the same mechanism the /agents/gateway-tools admin page
// writes to for any other agent. Nothing here needs to know mcpplug
// exists anymore, or block module load on a CLI subprocess call.
import type { AgentConfig } from '#core/agent-config.js'
import type { ModelCall } from '#core/run-agent.js'

// No approver config at all — every channel gets the library's own live
// default (ConsoleApprover, blocking on stdin) for write_file's 'ask'
// decision below. This used to be a demoApprover here, auto-approving on
// every channel purely so a non-interactive run wouldn't hang on stdin —
// removed along with AgentConfig.approvers itself (see
// agents/customer-service/index.ts's own comment on why): it re-derived
// nothing a real approver couldn't already do, so keeping it as a second,
// separate config surface stopped paying for itself. Running this agent
// non-interactively against a rule that resolves to 'ask' (write_file
// does) now genuinely blocks on stdin — pass your own `RunAgentOptions.approver`
// from whatever script invokes it if that's not what you want.
export const config: AgentConfig = {
  name: 'file-agent',
  systemPrompt: 'You summarize text files into other text files.',
  model: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  // No tools here — it defaults to importing agents/file-agent/tools/index.js
  // (see AgentConfig.tools's own doc comment), the same file this used to
  // import and assign directly as handWrittenTools. Composio's GitHub
  // tool doesn't need a place here either now — see ./gateway-tools.yml.
  // No rules here — it defaults to agents/file-agent/actauth.yml (see
  // AgentConfig.rules's own doc comment), the same path this used to set
  // explicitly.
}
