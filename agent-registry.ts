// Every channel adapter resolves "which agent" through this — the thing
// that makes agents pluggable. Defining a new agent means adding a file to
// agents/ that exports `config` and `createModelCall` — nothing here or in
// any adapter needs to change; discoverAgents (loopengine's own, not
// reimplemented here) scans that directory and keys each entry by
// AgentConfig.name at import time, below.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverAgents, type AgentModule } from './discover-agents.js'
import type { AgentConfig } from '#agent-config.js'
import type { ModelCall } from '#run-agent.js'

export type RegistryEntry = AgentModule

const projectRoot = dirname(fileURLToPath(import.meta.url))
const agentsDir = join(projectRoot, 'agents')

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

/** Where this registry's own discoverAgents call resolved agents/
 * against — exported so a caller creating a *new* agent module (see
 * adapters/http.ts's handleCreateAgent, which passes this straight
 * through as scaffoldAgent's own `baseDir`) writes it to the exact same
 * place this registry would find it on a future restart, rather than
 * re-deriving a base dir independently (e.g. from process.cwd(), which
 * isn't guaranteed to match if the process is launched from elsewhere)
 * and risking the two drifting apart. */
export function projectDir(): string {
  return projectRoot
}

/** Adds one already-loaded agent module to the live registry in place —
 * how a newly created agent (see adapters/http.ts's handleCreateAgent,
 * which calls this right after scaffoldAgent + loadAgentModule) becomes
 * runnable in *this* process immediately, with no restart — unlike
 * discoverAgents' own directory scan, which only ever runs once, at this
 * module's own import time (see the top-level await above). Throws on a
 * name collision with an already-registered agent, same as
 * discoverAgents itself does for a collision found during its initial
 * scan — a duplicate AgentConfig.name is a bug either way, not something
 * to silently overwrite. */
export function registerAgent(agentModule: RegistryEntry): void {
  const name = agentModule.config.name
  if (entries.has(name)) {
    throw new Error(`Duplicate agent name '${name}' — an agent with this name is already registered.`)
  }
  entries.set(name, agentModule)
}

/** Applies a partial update to an already-registered agent — how an edit
 * made through the admin UI (see adapters/http.ts's handleEditAgent,
 * which calls this after agent-file-admin.ts's editAgentFile writes the
 * change to agents/<name>/index.ts) takes effect in *this* running
 * process immediately, the same "no restart needed" principle
 * gateway-tools.yml/actauth.yml/SKILL.md edits already have. Mutates the
 * same AgentConfig object every existing getEntry() caller already holds
 * a reference to — via Object.assign, not a full replacement — so
 * nothing needs to re-fetch it to see the change, and any field left out
 * of `patch.config` (tools, rules, skillsDirs, ...) stays exactly as it
 * was. `patch.createModelCall`, if given, replaces the cached one
 * wholesale — see discover-agents.ts's own synthesizeCreateModelCall,
 * the thing that actually builds a fresh one from a changed model.
 * Throws if `name` isn't already registered — this updates an existing
 * entry, it's not a back door around registerAgent's own creation path. */
export function updateAgent(name: string, patch: { config?: Partial<AgentConfig>; createModelCall?: () => ModelCall }): void {
  const entry = entries.get(name)
  if (!entry) {
    throw new Error(`No registered agent named '${name}' to update.`)
  }
  if (patch.config) Object.assign(entry.config, patch.config)
  if (patch.createModelCall) entry.createModelCall = patch.createModelCall
}
