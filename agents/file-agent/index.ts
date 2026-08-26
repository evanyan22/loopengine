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
import type { AgentConfig } from '#agent-config.js'
import type { ModelCall } from '#run-agent.js'

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
  approver: {
    // ConsoleApprover would block this non-interactive demo on stdin — a
    // tiny auto-approving stand-in that still exercises the real 'ask' path.
    async requestApproval(tool, args, _scope, reason) {
      console.log(`  [actauth] approval requested for ${tool}(${JSON.stringify(args)}) — ${reason}`)
      console.log('  [actauth] auto-approved for this demo (swap in ConsoleApprover or SlackApprover for real use)')
      return true
    },
  },
  // No skillsDirs here — it defaults to agents/file-agent/skills (see
  // AgentConfig.skillsDirs's own doc comment), the same path this used to
  // set explicitly. Scoped to this agent's own folder, not any shared
  // root: SkillGarden's discovery recursively walks whatever root it's
  // given with no per-agent filtering, so pointing at a shared root would
  // mean this agent picks up (and exposes to the model as callable) any
  // other agent's skills dropped in there too. Nesting depth becomes the
  // namespace relative to *this* root, so summarize-files still gets the
  // plain name 'summarize-files' below, not 'file-agent:summarize-files'.
  isSafeTool: (call) =>
    call.name === 'read_file' ||
    call.name === 'list_dir' ||
    call.name === 'github_GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
}
