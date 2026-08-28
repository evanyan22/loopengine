// The public API — everything a consumer building on loopengine needs to
// define and run their own agent. `agents/*.ts`, `agent-registry.ts`,
// `adapters/*.ts`, and the Dockerfile are this repo's own reference app
// built on top of this surface, not part of it — see the README section
// "Using loopengine as a library" for the boundary and why.
export { runAgent } from '#core/run-agent.js'
export type {
  Message,
  ModelCall,
  ModelContentBlock,
  ModelResponse,
  RunAgentOptions,
  RunAgentResult,
} from '#core/run-agent.js'

export type { AgentConfig, AgentModelConfig, ToolSchema, ToolDefinition } from '#core/agent-config.js'

// The full typed lifecycle a running turn can emit (see loop-events.ts's
// own header comment) — exported directly, not just transitively via
// RunAgentOptions.onEvent above, so a consumer building their own UI
// (client.ts below, or their own thing entirely) can name LoopEvent and
// its variants without reaching into '#run-agent.js' for something that
// isn't really about running an agent, it's about observing one.
export type * from './core/loop-events.js'

// The framework-agnostic browser client for adapters/http.ts's own wire
// protocol (see client.ts's own header comment) — this, not a deep
// subpath import, is how a consumer's React/Vue/etc. chat UI is meant to
// reach it: this package has no "exports" map, so every other module here
// is re-exported through this single entry point too, and client.ts is no
// exception.
export {
  streamMessage,
  streamMessageWithCallbacks,
  sendMessage,
  approveCall,
  denyCall,
  answerQuestion,
  getSessionHistory,
} from './core/client.js'
export type {
  RequestOptions,
  SendMessageResult,
  PendingApprovalResult,
  PendingQuestionResult,
  PendingResult,
  MessageResult,
  StreamMessageCallbacks,
} from './core/client.js'

export { FileSessionStore, RedisSessionStore, createSessionStore } from './core/session-store.js'
export type { SessionStore, SessionResult, RedisSessionStoreOptions } from './core/session-store.js'

export { VectorIndex, embed, cosineSimilarity } from './core/vector-index.js'
export type { Document, ScoredDocument } from './core/vector-index.js'

export { createAnthropicModelCall } from './core/model-calls/anthropic-model-call.js'
export type { AnthropicModelCallOptions } from './core/model-calls/anthropic-model-call.js'

export { createOpenAIModelCall } from './core/model-calls/openai-model-call.js'
export type { OpenAIModelCallOptions } from './core/model-calls/openai-model-call.js'

export { createDeepSeekModelCall } from './core/model-calls/deepseek-model-call.js'
export type { DeepSeekModelCallOptions } from './core/model-calls/deepseek-model-call.js'

export { discoverAgents, loadAgentModule } from './core/discover-agents.js'
export type { AgentModule } from './core/discover-agents.js'

export { agentAsTool } from './core/agent-as-tool.js'
