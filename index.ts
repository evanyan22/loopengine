// The public API — everything a consumer building on loopengine needs to
// define and run their own agent. `agents/*.ts`, `agent-registry.ts`,
// `adapters/*.ts`, and the Dockerfile are this repo's own reference app
// built on top of this surface, not part of it — see the README section
// "Using loopengine as a library" for the boundary and why.
export { runAgent } from './run-agent.js'
export type {
  Message,
  ModelCall,
  ModelContentBlock,
  ModelResponse,
  RunAgentOptions,
  RunAgentResult,
} from './run-agent.js'

export type { AgentConfig, ToolSchema, ToolDefinition } from './agent-config.js'

export { loadAgent } from './load-agent.js'
export type { LoadedAgent } from './load-agent.js'

export { connectMcpTools } from './mcp-tools.js'
export type { McpConnection } from './mcp-tools.js'

export { FileSessionStore, RedisSessionStore, createSessionStore } from './session-store.js'
export type { SessionStore, SessionResult, RedisSessionStoreOptions } from './session-store.js'

export { VectorIndex, embed, cosineSimilarity } from './vector-index.js'
export type { Document, ScoredDocument } from './vector-index.js'

export { createAnthropicModelCall } from './anthropic-model-call.js'
export type { AnthropicModelCallOptions } from './anthropic-model-call.js'
