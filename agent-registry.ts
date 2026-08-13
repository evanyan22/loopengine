// Every channel adapter resolves "which agent" through this — the thing
// that makes agents pluggable. Defining a new agent means adding one line
// here; no adapter changes needed.
import type { AgentConfig } from './agent-config.js'
import type { ModelCall } from './run-agent.js'
import { config as fileAgentConfig, createModelCall as createFileAgentModelCall } from './agents/file-agent.js'
import { config as customerServiceConfig, createModelCall as createCustomerServiceModelCall } from './agents/customer-service-agent.js'
import { config as ragAgentConfig, createModelCall as createRagAgentModelCall } from './agents/rag-agent.js'

export interface RegistryEntry {
  config: AgentConfig
  /** Factory, not a shared instance — see agents/file-agent.ts for why call boundaries matter. */
  createModelCall: () => ModelCall
}

const entries: Record<string, RegistryEntry> = {
  'file-agent': { config: fileAgentConfig, createModelCall: createFileAgentModelCall },
  'customer-service': { config: customerServiceConfig, createModelCall: createCustomerServiceModelCall },
  'rag-agent': { config: ragAgentConfig, createModelCall: createRagAgentModelCall },
}

export function listAgents(): string[] {
  return Object.keys(entries)
}

/** undefined for an unknown agent name. */
export function getEntry(name: string): RegistryEntry | undefined {
  return entries[name]
}
