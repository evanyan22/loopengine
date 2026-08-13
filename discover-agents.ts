// Scans a directory for agent modules and builds a name -> module map from
// it — the thing that makes "drop a new file in agents/" enough to
// register an agent, no hand-written import-and-add-one-line edit needed
// anywhere else. See agent-registry.ts for the one place this repo's own
// reference app actually calls it.
//
// Keyed by AgentConfig.name, not the filename — that's the same identity
// ActAuth's scope.agent segment already uses (see AgentConfig.name's own
// doc comment), so this doesn't introduce a second naming scheme. Two
// files that happened to declare the same config.name would already
// silently collide in ActAuth's rules today regardless of this helper;
// surfacing that collision loudly here, at discovery time, is a real
// safety property this adds, not just convenience.
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentConfig } from './agent-config.js'
import type { ModelCall } from './run-agent.js'

export interface AgentModule {
  config: AgentConfig
  /** Factory, not a shared instance — a fresh ModelCall per request/session. */
  createModelCall: () => ModelCall
}

function isAgentModule(mod: unknown): mod is AgentModule {
  return (
    typeof mod === 'object' &&
    mod !== null &&
    'config' in mod &&
    'createModelCall' in mod &&
    typeof (mod as { createModelCall: unknown }).createModelCall === 'function'
  )
}

/** Scans `dir`'s direct files only (not subdirectories — put shared,
 * non-agent code in a subdirectory to keep it out of discovery, no
 * separate exclude-list mechanism needed) for `.ts`/`.js` modules, each
 * expected to export `config` and `createModelCall` — the same shape
 * every agents/*.ts file in this repo's own reference app already
 * exports. Throws, rather than skipping, on a file that doesn't match
 * that shape or a duplicate AgentConfig.name — both are almost always a
 * bug in the agent file, not something to silently ignore. */
export async function discoverAgents(dir: string): Promise<Map<string, AgentModule>> {
  const entries = new Map<string, AgentModule>()

  const files = readdirSync(dir, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && /\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts'),
  )

  for (const file of files) {
    const modulePath = resolve(dir, file.name)
    const mod: unknown = await import(pathToFileURL(modulePath).href)

    if (!isAgentModule(mod)) {
      throw new Error(`${file.name} in ${dir} does not export both 'config' and 'createModelCall' — every agent module must.`)
    }

    const name = mod.config.name
    if (entries.has(name)) {
      throw new Error(`Duplicate agent name '${name}' — ${file.name} in ${dir} isn't the first file to declare AgentConfig.name '${name}'.`)
    }

    entries.set(name, mod)
  }

  return entries
}
