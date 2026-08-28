// Backs the global /config page's Models and Gateways sections (see
// web/agents-config-page.ts's left sidebar) — the account-wide,
// not-scoped-to-one-agent counterpart to that page's existing per-agent
// Overview/Skills/Tools/ActAuth tabs. "Global" here means: which model
// providers this deployment can actually call (an API-key-in-env-vars
// question, same everywhere regardless of which agent is running) and
// which gateway providers (Composio today) this machine's CLI session
// is authenticated against — neither is a property of any one
// AgentConfig.
import { listAgents, getEntry } from '../core/agent-registry.js'
import { getComposioAuthStatus } from '../core/gateway-tools.js'

export interface ModelProviderInfo {
  provider: 'anthropic' | 'openai' | 'deepseek'
  envVar: string
  configured: boolean
}

export interface AgentModelUsage {
  agent: string
  provider: string
  model: string
}

export interface ModelsView {
  providers: ModelProviderInfo[]
  agents: AgentModelUsage[]
}

// One entry per provider agent-config.ts's own AgentModelConfig union
// actually supports (see its own doc comment) — kept here, not derived
// from that type, since there's no runtime list to introspect a TS
// union from; adding a fourth provider means one more line here and one
// more arm in that union, not a rewrite.
const KNOWN_PROVIDERS: Array<{ provider: ModelProviderInfo['provider']; envVar: string }> = [
  { provider: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { provider: 'openai', envVar: 'OPENAI_API_KEY' },
  { provider: 'deepseek', envVar: 'DEEPSEEK_API_KEY' },
]

/** Every registered agent's resolved model, alongside whether each
 * supported provider actually has credentials available in this
 * process's environment — an operator's first question when a request
 * fails isn't "what does this one agent request?" (Overview's own Model
 * section already answers that) but "is this deployment even set up to
 * call that provider at all?". Read-only: providers/env vars are wired
 * into the actual model-call modules (model-calls/*.ts), not something
 * this page can add support for by itself. An agent with a custom
 * `createModelCall` (no `config.model`) is skipped — there's no
 * provider/model pair to report for it, the same "custom" case
 * describeAgent's own model field already carves out. */
export function describeModelProviders(): ModelsView {
  const providers = KNOWN_PROVIDERS.map(({ provider, envVar }) => ({
    provider,
    envVar,
    configured: Boolean(process.env[envVar]),
  }))

  const agents: AgentModelUsage[] = []
  for (const name of listAgents()) {
    const config = getEntry(name)?.config
    if (config?.model) {
      agents.push({ agent: name, provider: config.model.provider, model: config.model.model ?? '(provider default)' })
    }
  }

  return { providers, agents }
}

export interface GatewayProviderInfo {
  provider: string
  supported: boolean
  connected: boolean
  email?: string
  org?: string
}

export interface GatewaysView {
  gateways: GatewayProviderInfo[]
}

/** The provider-level counterpart to gateway-tools.ts's own registry
 * (which is scoped to one agent's chosen tools within an already-
 * connected provider) — this is "is Composio itself usable from this
 * machine at all", not "what has agent X registered". Nango/Arcade/
 * Scalekit are listed as not-yet-supported placeholders, matching
 * gateway-tools.ts's own header comment about them slotting in later as
 * thin mcpplug ToolSource adapters once this mechanism is proven —
 * shown so the Gateways panel isn't silently missing them, not because
 * there's anything to check for them yet. */
export async function describeGateways(cliCommand = 'composio'): Promise<GatewaysView> {
  const composio = await getComposioAuthStatus(cliCommand)
  return {
    gateways: [
      { provider: 'composio', supported: true, connected: composio.connected, email: composio.email, org: composio.org },
      { provider: 'scalekit', supported: false, connected: false },
      { provider: 'nango', supported: false, connected: false },
      { provider: 'arcade', supported: false, connected: false },
    ],
  }
}
