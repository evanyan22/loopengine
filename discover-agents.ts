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
import { existsSync, readdirSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
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

/** Resolves one directory entry to an agent module's path, or undefined if
 * this entry isn't one — a `.ts`/`.js` file directly (the common case), or
 * a subdirectory containing an `index.ts`/`index.js` (the same "a
 * directory can be a module" convention Node's own `require()` resolution
 * already uses — no new mental model to learn). A subdirectory with
 * neither is ordinary supporting code living alongside an agent's own
 * folder (a `tools.ts` split out of a large agent, say), not an agent
 * itself, and is silently skipped rather than treated as an error. */
function resolveModulePath(dir: string, entry: Dirent): { path: string; label: string } | undefined {
  if (entry.isFile() && /\.(ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
    return { path: resolve(dir, entry.name), label: entry.name }
  }
  if (entry.isDirectory()) {
    for (const indexName of ['index.ts', 'index.js']) {
      const indexPath = join(dir, entry.name, indexName)
      if (existsSync(indexPath)) return { path: resolve(indexPath), label: `${entry.name}/${indexName}` }
    }
  }
  return undefined
}

/** Scans `dir` for agent modules — direct `.ts`/`.js` files, or
 * subdirectories with an `index.ts`/`index.js` (see resolveModulePath) —
 * each expected to export `config` and `createModelCall`, the same shape
 * every agent in this repo's own reference app already exports. Throws,
 * rather than skipping, on a module that doesn't match that shape or a
 * duplicate AgentConfig.name — both are almost always a bug, not
 * something to silently ignore. */
export async function discoverAgents(dir: string): Promise<Map<string, AgentModule>> {
  const entries = new Map<string, AgentModule>()

  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const resolved = resolveModulePath(dir, dirent)
    if (!resolved) continue

    const mod: unknown = await import(pathToFileURL(resolved.path).href)

    if (!isAgentModule(mod)) {
      throw new Error(`${resolved.label} in ${dir} does not export both 'config' and 'createModelCall' — every agent module must.`)
    }

    const name = mod.config.name
    if (entries.has(name)) {
      throw new Error(`Duplicate agent name '${name}' — ${resolved.label} in ${dir} isn't the first module to declare AgentConfig.name '${name}'.`)
    }

    entries.set(name, mod)
  }

  return entries
}
