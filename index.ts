// The public API — everything a consumer building on loopengine needs to
// define and run their own agent. `agents/*.ts`, `core/agent-registry.ts`,
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

export { discoverAgents, loadAgentModule, synthesizeCreateModelCall } from './core/discover-agents.js'
export type { AgentModule } from './core/discover-agents.js'

export { agentAsTool } from './core/agent-as-tool.js'

// Everything below backs the Admin UI (agents-config/list/global-config
// pages, playground) that this repo's own adapters/http.ts wires up —
// re-exported here, same "one entry point, no deep subpath imports"
// convention as everything above, so a project scaffolded by
// create-loopengine can build the same admin surface on top of its own
// copy of adapters/http.ts (which, like agent-registry.ts, is meant to be
// owned/edited, not imported — see this file's own header comment).

export { resumeAgent, loadRules, loadDefaultTools, loadSubagentAsTools, systemTools, systemSkillsDir } from './core/run-agent.js'

export { createCheckpointStore } from './core/durable-approvals.js'
export type { TurnCheckpoint, CheckpointStore, OutstandingItem } from './core/durable-approvals.js'

export {
  addGatewayTool,
  agentDir,
  disconnectComposioAccount,
  describeGatewayTools,
  listComposioConnections,
  listComposioTools,
  loadGatewayToolsFromDir,
  removeGatewayTool,
  removeGatewayToolSlug,
  GatewayToolExistsError,
  GatewayToolNotFoundError,
} from './core/gateway-tools.js'
export type { GatewayToolEntry, GatewayToolDecision } from './core/gateway-tools.js'

export { WebhookNotifier } from './core/http-notify-triggers/webhook.js'

// answerQuestion above (core/client.ts) is the HTTP client-side helper —
// this is the server-side function that actually resolves a pending
// question in-process, aliased to avoid colliding with that name.
export { listQuestions, answerQuestion as resolvePendingQuestion, findQuestion, createAskUserTool } from './core/system-tools/index.js'
export type { PendingQuestion } from './core/system-tools/index.js'

export { editAgentFile, AgentEditNotSupportedError, AgentFileNotFoundError } from './web/agent-file-admin.js'
export type { AgentEditableFields, AgentEditResult } from './web/agent-file-admin.js'

export { agentsConfigPageHtml } from './web/agents-config-page.js'
export { agentsListPageHtml } from './web/agents-list-page.js'
export { globalConfigPageHtml } from './web/global-config-page.js'
export { playgroundHtml } from './web/playground.js'

export { readSkill, writeSkill, deleteSkill, SkillInvalidIdError, SkillNotFoundError } from './web/skills-admin.js'
export type { SkillContent } from './web/skills-admin.js'

export {
  readActauthConfig,
  addActauthRule,
  updateActauthRule,
  removeActauthRule,
  setDefaultDecision,
  ActauthRuleExistsError,
  ActauthRuleNotFoundError,
} from './web/actauth-admin.js'
export type { ActauthRuleInput, ActauthConfigView } from './web/actauth-admin.js'

export { describeModelProviders, describeGateways } from './web/global-config.js'
export type { ModelProviderInfo, AgentModelUsage, ModelsView, GatewayProviderInfo, GatewaysView } from './web/global-config.js'

export { createTrackedApprover, listApprovals, decideApproval, findApproval } from './web/web-approver.js'

export { scaffoldAgent, scaffoldSubagent, AgentNameError, AgentExistsError, AgentNotFoundError, AgentModelError } from './bin/cli.js'
export type { AgentTemplateOptions } from './bin/cli.js'
