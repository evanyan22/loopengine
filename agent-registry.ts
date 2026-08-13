// Every channel adapter resolves "which agent" through this — the thing
// that makes agents pluggable. Defining a new agent means adding a file to
// agents/ that exports `config` and `createModelCall` — nothing here or in
// any adapter needs to change; discoverAgents (loopengine's own, not
// reimplemented here) scans that directory and keys each entry by
// AgentConfig.name at import time, below.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverAgents, type AgentModule } from './discover-agents.js'

export type RegistryEntry = AgentModule

const agentsDir = join(dirname(fileURLToPath(import.meta.url)), 'agents')

// Top-level await: ESM guarantees an importer's own evaluation (adapters/
// http.ts, adapters/cli.ts) waits for this module's top-level await to
// settle first, so listAgents()/getEntry() below can stay synchronous —
// no adapter needs to know discovery is async under the hood.
const entries = await discoverAgents(agentsDir)

export function listAgents(): string[] {
  return [...entries.keys()]
}

/** undefined for an unknown agent name. */
export function getEntry(name: string): RegistryEntry | undefined {
  return entries.get(name)
}
