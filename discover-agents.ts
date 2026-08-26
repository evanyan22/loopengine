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
import type { AgentConfig, AgentModelConfig } from '#agent-config.js'
import type { ModelCall } from '#run-agent.js'

export interface AgentModule {
  config: AgentConfig
  /** Factory, not a shared instance — a fresh ModelCall per request/session. */
  createModelCall: () => ModelCall
}

interface RawAgentModule {
  config?: AgentConfig
  createModelCall?: () => ModelCall
}

function isRawAgentModule(mod: unknown): mod is RawAgentModule {
  return typeof mod === 'object' && mod !== null && 'config' in mod
}

/** Builds a lazy, memoized createModelCall from AgentConfig.model, for a
 * module that doesn't export its own — see that field's own doc comment.
 * The provider's SDK module is imported here, eagerly, but that's cheap
 * and safe with no API key at all: importing model-calls/*.ts only
 * defines functions, it never constructs a client at module top level
 * (see e.g. createAnthropicModelCall's own body) — so this can't fail
 * discovery the way eagerly building the actual client would. The real
 * client is only built the first time the returned function is actually
 * called, and reused after that, the same "don't crash the whole server
 * over one agent's missing API key, don't rebuild per call" reasoning
 * agents/customer-service/index.ts's own hand-written createModelCall
 * used before this existed.
 *
 * Exported so a caller updating an *already-registered* agent's model
 * (see agent-file-admin.ts's editAgentFile, applied live via
 * agent-registry.ts's updateAgent) can rebuild just this one closure
 * without re-importing the whole module — Node's ESM loader caches an
 * already-imported module forever, so there's no supported way to
 * re-import a changed agent file's own createModelCall directly; this is
 * the one piece of it that's meaningfully regenerable on its own. */
export async function synthesizeCreateModelCall(model: AgentModelConfig): Promise<() => ModelCall> {
  let cached: ModelCall | undefined
  if (model.provider === 'anthropic') {
    const { createAnthropicModelCall } = await import('./model-calls/anthropic-model-call.js')
    return () => (cached ??= createAnthropicModelCall(model))
  }
  if (model.provider === 'openai') {
    const { createOpenAIModelCall } = await import('./model-calls/openai-model-call.js')
    return () => (cached ??= createOpenAIModelCall(model))
  }
  const { createDeepSeekModelCall } = await import('./model-calls/deepseek-model-call.js')
  return () => (cached ??= createDeepSeekModelCall(model))
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

/** Imports one agent module at `path` and resolves it to an AgentModule —
 * the single-file version of what discoverAgents does over a whole
 * directory, factored out so run-agent.ts's subagent loader (see
 * agent-as-tool.ts / loadSubagentAsTools) can load one `subagents/<name>/
 * index.ts` at a time without duplicating this resolution logic.
 * `label` is only used in error messages — discoverAgents passes
 * `'<file> in <dir>'`, callers loading a single known path can just pass
 * that path. */
export async function loadAgentModule(path: string, label: string): Promise<AgentModule> {
  const mod: unknown = await import(pathToFileURL(path).href)

  if (!isRawAgentModule(mod) || !mod.config) {
    throw new Error(`${label} does not export 'config' — every agent module must.`)
  }

  let createModelCall = mod.createModelCall
  if (typeof createModelCall !== 'function') {
    if (!mod.config.model) {
      throw new Error(`${label} exports 'config' but neither 'createModelCall' nor 'config.model' — every agent module must have one or the other.`)
    }
    createModelCall = await synthesizeCreateModelCall(mod.config.model)
  }

  return { config: mod.config, createModelCall }
}

/** Scans `dir` for agent modules — direct `.ts`/`.js` files, or
 * subdirectories with an `index.ts`/`index.js` (see resolveModulePath) —
 * each expected to export `config`, and either its own `createModelCall`
 * or a `config.model` for one to be synthesized from (see
 * AgentModelConfig's own doc comment). Throws, rather than skipping, on a
 * module that doesn't match that shape or a duplicate AgentConfig.name —
 * both are almost always a bug, not something to silently ignore. */
export async function discoverAgents(dir: string): Promise<Map<string, AgentModule>> {
  const entries = new Map<string, AgentModule>()

  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const resolved = resolveModulePath(dir, dirent)
    if (!resolved) continue

    const agentModule = await loadAgentModule(resolved.path, `${resolved.label} in ${dir}`)

    const name = agentModule.config.name
    if (entries.has(name)) {
      throw new Error(`Duplicate agent name '${name}' — ${resolved.label} in ${dir} isn't the first module to declare AgentConfig.name '${name}'.`)
    }

    entries.set(name, agentModule)
  }

  return entries
}
