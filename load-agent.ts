// Resolves an AgentConfig's mcpServers (if any) into real tools. This is
// what makes MCP support config-driven instead of one bespoke async
// builder function per server: an agent that declares mcpServers and one
// that doesn't both go through loadAgent() the same way — it's a no-op
// passthrough for the latter. agent-registry.ts calls this for every
// agent, so adding a new MCP-backed agent means writing an AgentConfig,
// not a new .ts file with its own connection-handling logic.
import { connectMcpTools } from './mcp-tools.js'
import type { AgentConfig } from './agent-config.js'

export interface LoadedAgent {
  /** Same config, with tools = hand-written tools + everything discovered from mcpServers. */
  config: AgentConfig
  /** Closes every MCP connection this load opened. No-op if the config had no mcpServers. */
  close: () => Promise<void>
}

export async function loadAgent(config: AgentConfig): Promise<LoadedAgent> {
  if (!config.mcpServers?.length) {
    return { config: { ...config, tools: config.tools ?? [] }, close: async () => {} }
  }

  const connections = await Promise.all(config.mcpServers.map(connectMcpTools))
  const mcpTools = connections.flatMap((c) => c.tools)

  // Last-one-wins on name collisions (hand-written tool vs. MCP tool, or
  // two MCP servers exposing the same name) — same resolution run-agent.ts
  // itself uses when it builds its own tool map. Sending the model a
  // duplicate tool name in its schema list would be a live API error, so
  // this dedupes before it gets that far.
  const byName = new Map([...(config.tools ?? []), ...mcpTools].map((t) => [t.name, t]))

  return {
    config: { ...config, tools: [...byName.values()] },
    close: async () => {
      await Promise.all(connections.map((c) => c.close()))
    },
  }
}
