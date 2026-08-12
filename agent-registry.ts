// Every channel adapter resolves "which agent" through this — the thing
// that makes agents pluggable. Defining a new agent (MCP-backed or not)
// means adding one line here; no adapter changes, and no bespoke loader
// function — every entry goes through the same makeLoader(config,
// createModelCall), which calls loadAgent() to resolve any mcpServers.
//
// Entries are lazy and memoized: a loader runs at most once, and its
// result (or in-flight promise) is reused across lookups. That matters
// for MCP-backed agents specifically — connecting spawns a subprocess, and
// without memoization every request would spawn its own. A failed load is
// evicted so the next request retries instead of being stuck with a
// permanently-cached rejection.
import type { AgentConfig } from './agent-config.js'
import type { ModelCall } from './run-agent.js'
import { loadAgent } from './load-agent.js'
import { config as fileAgentConfig, createModelCall as createFileAgentModelCall } from './agents/file-agent.js'
import { config as customerServiceConfig, createModelCall as createCustomerServiceModelCall } from './agents/customer-service-agent.js'
import { config as mcpFilesystemConfig, createModelCall as createMcpFilesystemModelCall } from './agents/mcp-filesystem-agent.js'

export interface RegistryEntry {
  config: AgentConfig
  /** Factory, not a shared instance — see agents/file-agent.ts for why call boundaries matter. */
  createModelCall: () => ModelCall
  /** Releases resources the loader opened (e.g. an MCP subprocess). No-op for configs with no mcpServers. */
  close: () => Promise<void>
}

type Loader = () => Promise<RegistryEntry>

function makeLoader(config: AgentConfig, createModelCall: () => ModelCall): Loader {
  return async () => {
    const { config: loaded, close } = await loadAgent(config)
    return { config: loaded, createModelCall, close }
  }
}

const loaders: Record<string, Loader> = {
  'file-agent': makeLoader(fileAgentConfig, createFileAgentModelCall),
  'customer-service': makeLoader(customerServiceConfig, createCustomerServiceModelCall),
  'mcp-filesystem-agent': makeLoader(mcpFilesystemConfig, createMcpFilesystemModelCall),
}

const resolved = new Map<string, Promise<RegistryEntry>>()

export function listAgents(): string[] {
  return Object.keys(loaders)
}

/** undefined for an unknown agent name; otherwise the (possibly still
 * in-flight, possibly cached) entry. */
export function getEntry(name: string): Promise<RegistryEntry> | undefined {
  const loader = loaders[name]
  if (!loader) return undefined

  let entry = resolved.get(name)
  if (!entry) {
    entry = loader().catch((err) => {
      resolved.delete(name)
      throw err
    })
    resolved.set(name, entry)
  }
  return entry
}

/** Closes every entry that's actually been loaded. Call on process shutdown. */
export async function closeRegistry(): Promise<void> {
  const entries = [...resolved.values()]
  resolved.clear()
  await Promise.all(
    entries.map(async (entryPromise) => {
      const entry = await entryPromise.catch(() => null)
      await entry?.close()
    }),
  )
}
