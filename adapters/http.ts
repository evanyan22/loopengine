// Channel adapter #2: HTTP API. Deliberately built on node:http, not a
// framework — the point is that runAgent doesn't care what's calling it,
// so the adapter has no special integration surface to show off.
//
//   npx tsx adapters/http.ts
//
//   # single JSON response, once the whole loop finishes — customer-service
//   # defines its own sessionIdFor (see agents/customer-service/index.ts),
//   # so its request bodies key sessions off customerEmail; other agents
//   # take a plain sessionId field instead, or omit it entirely for a
//   # fresh one-off session (see defaultSessionIdFor below) — either way
//   # the response body echoes back whichever sessionId was actually used
//   curl -X POST localhost:8787/agents/customer-service/messages \
//     -H 'content-type: application/json' \
//     -d '{"customerEmail":"a@example.com","message":"order A-1001 arrived broken"}'
//
//   # same request, but as it happens: one SSE event per loop step
//   curl -N -X POST localhost:8787/agents/customer-service/messages/stream \
//     -H 'content-type: application/json' \
//     -d '{"customerEmail":"a@example.com","message":"order A-1001 arrived broken"}'
//
// Owns: routing by agent name, request/response shape, and (via
// SessionStore.withSession) making sure two concurrent requests for the
// *same* session don't race on read-modify-write of that session's
// history. What counts as "the same session" is deliberately not this
// file's call — see AgentConfig.sessionIdFor and defaultSessionIdFor below.
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { getEntry, listAgents, projectDir, registerAgent, updateAgent, type RegistryEntry } from '../core/agent-registry.js'
import { loadAgentModule, synthesizeCreateModelCall } from '#core/discover-agents.js'
import { editAgentFile, AgentEditNotSupportedError, AgentFileNotFoundError, type AgentEditResult } from '#web/agent-file-admin.js'
import { createSessionStore } from '../core/session-store.js'
import { createCheckpointStore, type TurnCheckpoint } from '#core/durable-approvals.js'
import { runAgent, resumeAgent, loadRules, loadDefaultTools, loadSubagentAsTools, systemTools, systemSkillsDir } from '#core/run-agent.js'
import type { AgentConfig, ToolDefinition } from '#core/agent-config.js'
import type { ModelContentBlock, RunAgentResult } from '#core/run-agent.js'
import { SkillGarden } from 'skillgarden'
import { playgroundHtml } from '../web/playground.js'
import { agentsConfigPageHtml } from '../web/agents-config-page.js'
import { agentsListPageHtml } from '../web/agents-list-page.js'
import { globalConfigPageHtml } from '../web/global-config-page.js'
import {
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
  type GatewayToolEntry,
  type GatewayToolDecision,
} from '#core/gateway-tools.js'
import { readSkill, writeSkill, deleteSkill, SkillInvalidIdError, SkillNotFoundError } from '#web/skills-admin.js'
import {
  readActauthConfig,
  addActauthRule,
  updateActauthRule,
  removeActauthRule,
  setDefaultDecision,
  ActauthRuleExistsError,
  ActauthRuleNotFoundError,
} from '#web/actauth-admin.js'
import { describeModelProviders, describeGateways } from '#web/global-config.js'
import { scaffoldAgent, AgentNameError, AgentExistsError, AgentModelError, type AgentTemplateOptions } from '#bin/cli.js'
import { createTrackedApprover, listApprovals, decideApproval, findApproval } from '#web/web-approver.js'
import { listQuestions, answerQuestion, findQuestion, createAskUserTool, type PendingQuestion } from '#core/system-tools/index.js'
import { WebhookNotifier } from '#core/http-notify-triggers/webhook.js'
import type { Decision, PendingApproval } from 'actauth'
import type { LoopEvent } from '#core/loop-events.js'

const sessions = createSessionStore()
const checkpoints = createCheckpointStore()

// The plain (non-streaming) POST /messages route's own built-in default
// for the 'http' channel — durable when configured, since that route
// already has no live connection of its own to hold open (see
// handleMessages' own header comment). One shared instance, not
// per-request: unlike WebchatApprover, nothing about WebhookNotifier
// needs to be scoped to a specific turn/connection — and, same "it's
// channel-specific, not concern-specific" reasoning
// core/http-notify-triggers/webhook.ts's own doc comment gives, one
// instance covers both the approval and question default, not two
// separately-configured ones (an earlier version of this file supported
// a separate LOOPENGINE_DEFAULT_QUESTION_WEBHOOK_URL/_SECRET pair for the
// question side specifically — dropped once WebhookNotifier's own
// one-target-for-both shape made that a real, not just cosmetic,
// simplification; a deployment that genuinely needs different targets
// per concern can still set AgentConfig.httpNotifier per agent instead,
// which wins outright over this default anyway). Deployment-wide env
// vars, same pattern REDIS_URL/LOOPENGINE_ADMIN_AUTH already use —
// there's no sensible webhook target to invent without one configured,
// so this is undefined (handleMessages falls back to today's live
// WebchatApprover instead, not all the way to ConsoleApprover) rather
// than guessed.
const defaultHttpWebhookUrl = process.env.LOOPENGINE_DEFAULT_WEBHOOK_URL
const defaultHttpWebhookSecret = process.env.LOOPENGINE_DEFAULT_WEBHOOK_SECRET
const defaultHttpWebhookNotifier =
  defaultHttpWebhookUrl && defaultHttpWebhookSecret
    ? new WebhookNotifier({ webhookUrl: defaultHttpWebhookUrl, signingSecret: defaultHttpWebhookSecret })
    : undefined

// Used when an AgentConfig doesn't define its own sessionIdFor — a plain
// client-supplied key, same shape adapters/cli.ts's --session flag
// already uses. Deriving a session key from something richer (a
// customer's email, a Slack channel, a support ticket ID, ...) is
// business logic specific to what that agent is for, so it belongs on
// the AgentConfig, not hardcoded here for every agent this adapter might
// ever route to.
function defaultSessionIdFor(body: Record<string, unknown>): string | undefined {
  const sessionId = body.sessionId
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined
}

// An agent-defined sessionIdFor always wins outright when present — for
// customer-service that's a real, stable identity (a customerEmail hash),
// and it returning undefined (no customerEmail in the body) is a genuine
// validation failure, not "start me an anonymous session." Only the
// *default*, agent-agnostic fallback auto-generates one: a missing
// sessionId there just means "no ongoing conversation to resume," the
// same thing omitting --session now means for adapters/cli.ts, not an
// error — see the response body for how the caller learns what id got
// used.
function sessionIdFor(config: AgentConfig, body: Record<string, unknown>): string | undefined {
  if (config.sessionIdFor) return config.sessionIdFor(body)
  return defaultSessionIdFor(body) ?? randomUUID()
}

// Resolves AgentConfig.tenantFor against this request's headers/body —
// run-agent.ts itself never sees a request, so this per-request
// resolution has to happen here, before that point (see
// AgentConfig.tenantFor's own doc comment). Returning undefined is a real
// auth failure, not "use 'default'" — if "no header at all" should mean
// 'default' rather than a rejection, the resolver itself must return
// 'default' explicitly. No tenantFor at all is not a failure, though —
// it just means this agent doesn't need per-request tenants, so every
// request is the 'default' tenant.
function resolveTenant(
  config: AgentConfig,
  headers: IncomingMessage['headers'],
  body: Record<string, unknown>,
): { ok: true; value: string } | { ok: false } {
  if (!config.tenantFor) return { ok: true, value: 'default' }
  const result = config.tenantFor(headers, body)
  return result === undefined ? { ok: false } : { ok: true, value: result }
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}

interface ParsedRequest {
  entry: RegistryEntry
  message: string
  /** Whatever the caller sent (or, for the default fallback, what got
   * generated) — echo this back in the response so a client that omitted
   * sessionId can capture it and resume the same conversation next time. */
  rawSessionId: string
  /** The actual SessionStore key — tenant-, environment-, and agent-namespaced, never what goes in a response. */
  storageSessionId: string
  /** This request's resolved tenant — pass straight through as
   * RunAgentOptions.tenant on every runAgent call in this file. */
  tenant: string
}

type ParseResult = { ok: true; value: ParsedRequest } | { ok: false; status: number; error: string }

// Shared by both routes: resolve the agent, validate the body, compute
// the session key. Neither route commits to a response shape until this
// has succeeded — the streaming route in particular must not send SSE
// headers until it knows the request is actually going to run.
async function parseRequest(req: IncomingMessage, agentName: string): Promise<ParseResult> {
  const entry = getEntry(agentName)
  if (!entry) return { ok: false, status: 404, error: `unknown agent '${agentName}'` }

  const body = await readJsonBody(req)
  const message = String(body.message ?? '')
  const rawSessionId = sessionIdFor(entry.config, body)
  if (!message) return { ok: false, status: 400, error: 'message is required' }
  // Only reachable when the agent defines its own sessionIdFor and it
  // returned undefined — the default fallback (sessionIdFor above) always
  // produces something, generating one rather than leaving this undefined.
  if (!rawSessionId) return { ok: false, status: 400, error: 'could not derive a session id from the request body' }

  const tenantResolution = resolveTenant(entry.config, req.headers, body)
  if (!tenantResolution.ok) return { ok: false, status: 401, error: 'could not verify tenant for this request' }
  const tenant = tenantResolution.value

  // SessionStore itself is agent-agnostic — it has no idea which agent is
  // calling withSession, so two different agents given the same sessionId
  // (e.g. a client that reuses one ID across agents, or two agents whose
  // sessionIdFor happens to produce the same value) would otherwise read
  // and write the exact same underlying log, splicing one agent's history
  // into another's. Namespacing by agent name here is what actually
  // prevents that — confirmed live: before this, calling file-agent then
  // rag-agent with the same sessionId fed rag-agent file-agent's entire
  // prior conversation as context.
  //
  // Also namespaced by tenant and environment, for the same reason: two
  // different tenants (or environments) whose sessionIdFor happens to
  // produce the same raw id would otherwise collide on the exact same
  // underlying log, splicing one tenant's/environment's conversation into
  // another's. environment is a deployment-wide setting (LOOPENGINE_ENV),
  // not resolved per-request the way tenant is — same reasoning
  // run-agent.ts's own Scope construction uses.
  const environment = process.env.LOOPENGINE_ENV ?? 'production'
  return {
    ok: true,
    value: { entry, message, rawSessionId, tenant, storageSessionId: `${tenant}:${environment}:${agentName}:${rawSessionId}` },
  }
}

// Backs GET /agents/:name/config (the JSON API behind the /agents/config
// page below). Reuses loadRules/loadDefaultTools rather than re-deriving
// AgentConfig's defaults independently — so this always shows exactly what
// runAgent() would actually resolve and enforce, not a second guess at it
// that could drift out of sync. Never includes AgentModelConfig.apiKey or
// any function value (approver, isSafeTool, sessionIdFor, tenantFor) —
// those either aren't JSON-serializable or would leak a secret; each is
// reported as 'custom' vs its default instead.
//
// Includes subagents (loadSubagentAsTools) and gateway-registered tools
// (loadGatewayToolsFromDir) alongside config.tools/loadDefaultTools —
// omitting either would make this page lie about what runAgent()
// actually resolves, exactly the drift its own reasoning above is meant
// to prevent.
function describeTool(t: { name: string; description: string; safe?: boolean; input_schema: Record<string, unknown> }) {
  return { name: t.name, description: t.description, safe: t.safe === true, input_schema: t.input_schema }
}

async function describeAgent(entry: RegistryEntry): Promise<Record<string, unknown>> {
  const { config } = entry
  // Kept separate (not just concatenated into one `tools` array — though
  // that's still returned too, below, for Overview's own at-a-glance
  // count) so the "Tools" tab can show where each one actually comes
  // from: hand-written (agents/<name>/tools/), delegated to a subagent
  // (agentAsTool), or registered through a gateway (gateway-tools.ts) —
  // three different things an operator would reason about differently,
  // flattened together they'd just look like an undifferentiated list.
  const localTools = config.tools ?? (await loadDefaultTools(config))
  const agentAsTools = await loadSubagentAsTools(config)
  const gatewayTools = await loadGatewayToolsFromDir(agentDir(config.name))
  const tools = [...localTools, ...agentAsTools, ...gatewayTools]
  const rules = loadRules(config)
  const rulesSource = Array.isArray(config.rules)
    ? 'inline'
    : config.rules !== undefined
      ? `file: ${config.rules}`
      : `default: agents/${config.name}/actauth.yml`

  // Same resolution run-agent.ts's own runAgent() does for its Skill
  // tool's index — reused rather than re-derived, so a "Skills" tab shows
  // exactly what the next real request would actually see available, not
  // a second guess (same reasoning this function's own header comment
  // already gives for tools/permissions).
  // Kept separate from systemSkillsDir (mirrors localTools/systemTools
  // above) — system-skills/composio-large-outputs is real infrastructure
  // every agent gets (see run-agent.ts), not something an operator
  // configured for *this* agent, so the config page's own Skills tab
  // deliberately doesn't mix it into skills/skillsDirs below.
  const skillsDirs = config.skillsDirs ?? [`agents/${config.name}/skills`]
  const skillGarden = new SkillGarden({ dirs: skillsDirs, indexBudgetTokens: config.skillIndexBudgetTokens ?? 200 })
  const skillIndex = skillGarden.buildIndex().included
  const systemSkillGarden = new SkillGarden({ dirs: [systemSkillsDir], indexBudgetTokens: config.skillIndexBudgetTokens ?? 200 })
  const systemSkillIndex = systemSkillGarden.buildIndex().included

  return {
    name: config.name,
    systemPrompt: config.systemPrompt,
    model: config.model
      ? { provider: config.model.provider, model: config.model.model, maxTokens: config.model.maxTokens }
      : 'custom (module exports its own createModelCall)',
    maxTurns: config.maxTurns ?? 25,
    contextBudgetTokens: config.contextBudgetTokens ?? 8000,
    skillIndexBudgetTokens: config.skillIndexBudgetTokens ?? 200,
    skillsDirs: skillsDirs,
    skills: skillIndex.map((s) => ({ name: s.name, description: s.description })),
    systemSkills: systemSkillIndex.map((s) => ({ name: s.name, description: s.description })),
    tools: tools.map(describeTool),
    // createAskUserTool() with no onPending, purely to describe its
    // schema here — never executed, so the console-prompt fallback its
    // own doc comment mentions never applies to this call.
    systemTools: [...systemTools, createAskUserTool({ agent: config.name })].map(describeTool),
    localTools: localTools.map(describeTool),
    agentAsTools: agentAsTools.map(describeTool),
    gatewayTools: gatewayTools.map(describeTool),
    permissions: {
      source: rulesSource,
      defaultDecision: rules.defaultDecision,
      rules: rules.rules,
    },
    isSafeTool: config.isSafeTool ? 'custom' : "default (each tool's own `safe` flag)",
    sessionIdFor: config.sessionIdFor ? 'custom' : 'default (client-supplied `sessionId` field)',
    tenantFor: config.tenantFor ? 'custom' : "none (every request is the 'default' tenant)",
  }
}

// Backs POST /agents/:name/gateway-tools — validates the body into a
// GatewayToolEntry and hands it to gateway-tools.ts's addGatewayTool. Only
// 'composio' is accepted today (gateway-tools.ts's own GatewayToolEntry
// union is exactly that narrow); a second provider means one more arm
// here, not a rewrite.
function parseGatewayToolEntry(body: Record<string, unknown>): { ok: true; value: GatewayToolEntry } | { ok: false; error: string } {
  if (body.provider !== 'composio') return { ok: false, error: `unsupported provider '${String(body.provider)}' — only 'composio' today` }
  if (typeof body.name !== 'string' || !body.name) return { ok: false, error: 'name is required' }
  if (!Array.isArray(body.slugs) || body.slugs.length === 0 || !body.slugs.every((s) => typeof s === 'string' && s)) {
    return { ok: false, error: 'slugs must be a non-empty array of strings' }
  }
  const entry: GatewayToolEntry = { provider: 'composio', name: body.name, slugs: body.slugs as string[] }
  if (typeof body.cliCommand === 'string' && body.cliCommand) entry.cliCommand = body.cliCommand
  return { ok: true, value: entry }
}

function isDecision(value: unknown): value is Decision {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

// Only the gateway-tools add route accepts 'auto' — actauth rules
// themselves (handleActauthRulePost/Put, handleActauthDefaultDecisionPut)
// still require a real Decision, since 'auto' only makes sense as "figure
// out a decision per tool for this batch," not as a value a single rule
// or default_decision could itself hold.
function isGatewayToolDecision(value: unknown): value is GatewayToolDecision {
  return isDecision(value) || value === 'auto'
}

async function handleToolSourcesGet(res: ServerResponse, agentName: string, force: boolean): Promise<void> {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  const sources = await describeGatewayTools(agentName, { force })
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sources }))
}

async function handleToolSourcesPost(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  const body = await readJsonBody(req)
  const parsed = parseGatewayToolEntry(body)
  if (!parsed.ok) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: parsed.error }))
    return
  }
  const decision = isGatewayToolDecision(body.decision) ? body.decision : undefined
  try {
    addGatewayTool(agentName, parsed.value, decision)
  } catch (err) {
    const status = err instanceof GatewayToolExistsError ? 409 : 500
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    return
  }
  const sources = await describeGatewayTools(agentName)
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sources }))
}

function handleToolSourcesDelete(res: ServerResponse, agentName: string, sourceName: string): void {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  try {
    removeGatewayTool(agentName, sourceName)
  } catch (err) {
    const status = err instanceof GatewayToolNotFoundError ? 404 : 500
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
}

// Backs the per-tool remove icon in the Tools tab's Gateway Tools list
// (as opposed to handleToolSourcesDelete above, which drops a whole
// source). Returns the freshly-resolved sources, same as
// handleToolSourcesPost — so the frontend can apply the result directly
// instead of making a second, redundant GET for the same data.
async function handleGatewayToolSlugDelete(res: ServerResponse, agentName: string, sourceName: string, slug: string): Promise<void> {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  try {
    removeGatewayToolSlug(agentName, sourceName, slug)
  } catch (err) {
    const status = err instanceof GatewayToolNotFoundError ? 404 : 500
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    return
  }
  const sources = await describeGatewayTools(agentName)
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sources }))
}

// Backs GET /composio/connections and GET /composio/tools — not scoped
// under /agents/:name/ like the routes above, deliberately: which apps
// are connected and what they offer isn't a property of any one agent,
// it's whatever Composio account is authenticated on this machine (via
// `composio link <toolkit>`), the same one every agent's gateway tools
// already draw from. These two back the add-a-source picker in
// web/agents-config-page.ts's Gateway Tools section — see
// listComposioConnections/listComposioTools's own doc comments for why
// this doesn't need any extra setup beyond that.
async function handleComposioConnections(res: ServerResponse): Promise<void> {
  try {
    const connections = await listComposioConnections()
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ connections }))
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  }
}

async function handleComposioTools(res: ServerResponse, toolkit: string | undefined): Promise<void> {
  if (!toolkit) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'toolkit query parameter is required' }))
    return
  }
  try {
    const tools = await listComposioTools(toolkit)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ tools }))
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  }
}

// Backs the Gateways panel's own Disconnect control — see
// disconnectComposioAccount's own doc comment for why there's no
// Connect counterpart (composio login has no non-interactive path that
// actually matches a credential an operator has on hand). Returns the
// freshly-resolved gateways list on success, same "apply the response
// directly instead of a second GET" pattern the gateway-tools routes
// already use.
async function handleComposioDisconnect(res: ServerResponse): Promise<void> {
  try {
    await disconnectComposioAccount()
  } catch (err) {
    res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await describeGateways()))
}

// Backs the agents list page's "Create new agent" button — reuses
// bin/cli.ts's own scaffoldAgent rather than re-implementing the
// agents/<name>/index.ts template here, so a web-created agent is
// byte-for-byte the same stub `loopengine add-agent` would generate.
// scaffoldAgent runs against core/agent-registry.ts's own projectDir(), not
// process.cwd() — they're usually the same directory, but only
// projectDir() is guaranteed to match where this registry's own
// discoverAgents call actually resolved agents/ against (see its own
// doc comment), which is what matters here.
//
// Unlike core/agent-registry.ts's own discoverAgents (a one-shot directory
// scan at process startup — see that module's header comment), this
// loads and registers the new agent into *this* running process
// immediately: loadAgentModule imports just the one new file (the same
// primitive discoverAgents itself uses per-entry), and registerAgent
// adds it to the live registry, in place. No restart needed — this is
// the one legitimate case for it: a module that was never imported
// before has nothing to invalidate or go stale, unlike hot-reloading an
// *existing* agent's already-imported code would (Node's ESM loader
// caches a given module forever; there's no supported way to safely
// re-import a changed one without a real restart). If loading/
// registering the fresh file fails for some reason (a bug in the
// generated template, an extremely unlikely name race), the file is
// still there on disk — reported as `registered: false` rather than
// treated as the whole request failing, since scaffolding did succeed;
// a restart (or `loopengine dev`'s own auto-restart on new
// agents/*/index.ts files — see bin/cli.ts's own comment there) would still
// pick it up the normal way.
// systemPrompt/model are both optional in the request body — see
// AgentTemplateOptions' own doc comment (via agentIndexTemplate) for the
// defaults scaffoldAgent falls back to when either is omitted.
function parseAgentTemplateOptions(body: Record<string, unknown>): { ok: true; value: AgentTemplateOptions } | { ok: false; error: string } {
  const options: AgentTemplateOptions = {}
  if (typeof body.systemPrompt === 'string' && body.systemPrompt.trim()) {
    options.systemPrompt = body.systemPrompt
  }
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== 'object') {
      return { ok: false, error: 'model must be an object' }
    }
    const provider = (body.model as Record<string, unknown>).provider
    if (provider !== 'anthropic' && provider !== 'openai' && provider !== 'deepseek') {
      return { ok: false, error: `unsupported model provider '${String(provider)}'` }
    }
    const modelName = (body.model as Record<string, unknown>).model
    options.model = { provider, model: typeof modelName === 'string' ? modelName : undefined }
  }
  return { ok: true, value: options }
}

async function handleCreateAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req)
  if (typeof body.name !== 'string' || !body.name) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'name is required' }))
    return
  }
  const parsedOptions = parseAgentTemplateOptions(body)
  if (!parsedOptions.ok) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: parsedOptions.error }))
    return
  }

  let indexPath: string
  try {
    indexPath = await scaffoldAgent(projectDir(), body.name, parsedOptions.value)
  } catch (err) {
    const status = err instanceof AgentNameError || err instanceof AgentModelError ? 400 : err instanceof AgentExistsError ? 409 : 500
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    return
  }

  try {
    registerAgent(await loadAgentModule(indexPath, indexPath))
  } catch (err) {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ path: indexPath, registered: false, error: err instanceof Error ? err.message : String(err) }))
    return
  }

  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ path: indexPath, registered: true }))
}

// Backs the Overview tab's System prompt / Model edit forms — either
// field can be sent independently (see parseAgentTemplateOptions), the
// other stays untouched both on disk and live. Persists via
// agent-file-admin.ts's editAgentFile (see its own doc comment for why
// this is a surgical AST edit, not a full file regeneration), then
// applies the exact same resolved values to *this* running process via
// core/agent-registry.ts's updateAgent — a model change also needs a fresh
// createModelCall (see synthesizeCreateModelCall's own doc comment for
// why that's regenerable on its own, unlike the rest of an already-
// imported module). No restart needed, same as every other admin edit
// in this app.
async function handleEditAgent(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  const body = await readJsonBody(req)
  const parsedOptions = parseAgentTemplateOptions(body)
  if (!parsedOptions.ok) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: parsedOptions.error }))
    return
  }
  if (parsedOptions.value.systemPrompt === undefined && parsedOptions.value.model === undefined) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'systemPrompt or model is required' }))
    return
  }

  let result: AgentEditResult
  try {
    result = editAgentFile(agentName, parsedOptions.value)
  } catch (err) {
    const status =
      err instanceof AgentEditNotSupportedError || err instanceof AgentModelError ? 400 : err instanceof AgentFileNotFoundError ? 404 : 500
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    return
  }

  const configPatch: Partial<AgentConfig> = {}
  if (result.systemPrompt !== undefined) configPatch.systemPrompt = result.systemPrompt
  let createModelCall: RegistryEntry['createModelCall'] | undefined
  if (result.model) {
    configPatch.model = result.model
    createModelCall = await synthesizeCreateModelCall(result.model)
  }
  updateAgent(agentName, { config: configPatch, createModelCall })

  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await describeAgent(getEntry(agentName)!)))
}

// Backs the Skills tab's edit form (GET .../skills/:skillId to populate
// it, PUT to save, DELETE to remove) — see skills-admin.ts's own doc
// comment for why this only reaches flat (non-nested) skills.
function handleSkillGet(res: ServerResponse, agentName: string, skillId: string): void {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  try {
    const skill = readSkill(agentName, skillId)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(skill))
  } catch (err) {
    const status = err instanceof SkillNotFoundError ? 404 : err instanceof SkillInvalidIdError ? 400 : 500
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
  }
}

async function handleSkillPut(req: IncomingMessage, res: ServerResponse, agentName: string, skillId: string): Promise<void> {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  const body = await readJsonBody(req)
  if (typeof body.description !== 'string' || !body.description) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'description is required' }))
    return
  }
  if (typeof body.body !== 'string' || !body.body) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'body is required' }))
    return
  }
  try {
    writeSkill(agentName, skillId, { description: body.description, body: body.body })
  } catch (err) {
    const status = err instanceof SkillInvalidIdError ? 400 : 500
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
}

function handleSkillDelete(res: ServerResponse, agentName: string, skillId: string): void {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  try {
    deleteSkill(agentName, skillId)
  } catch (err) {
    const status = err instanceof SkillNotFoundError ? 404 : err instanceof SkillInvalidIdError ? 400 : 500
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
}

// Backs the Actauth tab's rule editor — parses a rule body shared by both
// the add (POST) and update (PUT, minus `name`) routes below.
function parseActauthRuleBody(body: Record<string, unknown>, requireName: boolean): { ok: true; value: { name: string; scope: string; tool: string; decision: Decision } } | { ok: false; error: string } {
  if (requireName && (typeof body.name !== 'string' || !body.name)) return { ok: false, error: 'name is required' }
  if (typeof body.scope !== 'string' || !body.scope) return { ok: false, error: 'scope is required' }
  if (typeof body.tool !== 'string' || !body.tool) return { ok: false, error: 'tool is required' }
  if (!isDecision(body.decision)) return { ok: false, error: "decision must be 'allow', 'ask', or 'deny'" }
  return { ok: true, value: { name: typeof body.name === 'string' ? body.name : '', scope: body.scope, tool: body.tool, decision: body.decision } }
}

function handleActauthGet(res: ServerResponse, agentName: string): void {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(readActauthConfig(agentName)))
}

async function handleActauthRulePost(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  const body = await readJsonBody(req)
  const parsed = parseActauthRuleBody(body, true)
  if (!parsed.ok) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: parsed.error }))
    return
  }
  try {
    addActauthRule(agentName, parsed.value)
  } catch (err) {
    const status = err instanceof ActauthRuleExistsError ? 409 : 500
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(readActauthConfig(agentName)))
}

async function handleActauthRulePut(req: IncomingMessage, res: ServerResponse, agentName: string, ruleName: string): Promise<void> {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  const body = await readJsonBody(req)
  const parsed = parseActauthRuleBody(body, false)
  if (!parsed.ok) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: parsed.error }))
    return
  }
  try {
    updateActauthRule(agentName, ruleName, parsed.value)
  } catch (err) {
    const status = err instanceof ActauthRuleNotFoundError ? 404 : 500
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(readActauthConfig(agentName)))
}

function handleActauthRuleDelete(res: ServerResponse, agentName: string, ruleName: string): void {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  try {
    removeActauthRule(agentName, ruleName)
  } catch (err) {
    const status = err instanceof ActauthRuleNotFoundError ? 404 : 500
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(readActauthConfig(agentName)))
}

async function handleActauthDefaultDecisionPut(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  const body = await readJsonBody(req)
  if (!isDecision(body.decision)) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: "decision must be 'allow', 'ask', or 'deny'" }))
    return
  }
  setDefaultDecision(agentName, body.decision)
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(readActauthConfig(agentName)))
}

// GET /agents content-negotiates on this: a browser navigating there sends
// an Accept header that prefers text/html, so it gets agentsListPageHtml
// below; fetch()'s own default Accept (`*/*`, the same default every
// fetch('/agents') call in playground.ts/agents-config-page.ts/
// agents-list-page.ts itself already relies on) does not include
// text/html, so this can't silently break an existing JSON consumer.
function prefersHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html')
}

// The event's own `type` field is both the SSE event name and the
// serialized payload — see loop-events.ts's own header comment for why a
// wire frame is never "name + unrelated detail" the way it used to be.
function writeSseEvent(res: ServerResponse, event: LoopEvent): void {
  res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

// Backs GET /agents/:name/sessions/:id — the playground's "resume a past
// conversation" sidebar rehydrating the chat pane after a page refresh
// lost its in-memory sessionId. rawSessionId is exactly what a `session`
// SSE event (see handleMessagesStream) echoed back earlier, so
// reconstructing the same storageSessionId parseRequest computes from it
// (tenant/environment/agentName-namespaced — see its own doc comment for
// why) finds the same underlying log. Tenant resolution has no request
// body to work with here (a GET has none) — fine for the common case
// (no custom tenantFor, or one that only reads headers), but an agent
// whose tenantFor depends on the message body can't be resolved this way.
async function handleSessionGet(req: IncomingMessage, res: ServerResponse, agentName: string, rawSessionId: string): Promise<void> {
  const entry = getEntry(agentName)
  if (!entry) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  const tenantResolution = resolveTenant(entry.config, req.headers, {})
  if (!tenantResolution.ok) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'could not verify tenant for this request' }))
    return
  }
  const environment = process.env.LOOPENGINE_ENV ?? 'production'
  const storageSessionId = `${tenantResolution.value}:${environment}:${agentName}:${rawSessionId}`
  const history = await sessions.getHistory(storageSessionId)
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ sessionId: rawSessionId, history }))
}

type PendingSignal = { type: 'question'; entry: PendingQuestion } | { type: 'approval'; entry: PendingApproval }
type FinishedTurn = { text: string; stopReason?: 'max_turns' | 'denied' | 'pending_approval' | 'pending_question' }

// One entry per turn currently in flight for the plain (non-streaming)
// /messages route, keyed by "<agentName>:<rawSessionId>" — the same
// (agent, sessionId) granularity every other pending-item lookup in this
// file already uses (see listApprovals/listQuestions's own filters),
// not a stricter per-tenant key: a custom rawSessionId reused across two
// tenants for the same agent was already ambiguous before this existed.
// This is what makes POST /approvals/:id/approve|deny and
// POST /questions/:id/answer able to report "what's next" (another
// pending item, or the final result) instead of just "ok" — see
// raceAndRespond below for the shared logic, and its own doc comment for
// why a fresh Promise per race isn't enough on its own once a *second*
// pending item can arrive after the first is already decided.
interface SessionTurnState {
  turnPromise: Promise<FinishedTurn> | null
  // At most one of these is ever non-null at a time: a signal that
  // arrived before anyone asked for it (bufferedSignal), or a resolver
  // waiting for one that hasn't arrived yet (waiter) — never both, since
  // pushSignal always drains whichever waiter is currently registered
  // the instant a signal shows up, and nextSignal always drains the
  // buffer the instant something asks. Only one item can genuinely be
  // pending at a time per session regardless (run-agent.ts's own gate
  // loop evaluates — and so can only ever be blocked on — one tool call
  // at a time), so a single slot is enough; no queue needed.
  bufferedSignal: PendingSignal | null
  waiter: ((signal: PendingSignal) => void) | null
  // Every LoopEvent this turn has produced so far, in order — populated
  // identically whether this state backs a streamed or a plain turn (see
  // both handleMessages/handleMessagesStream below). The streaming route
  // already delivers each one live over SSE and has no direct use for the
  // array itself, but keeps it anyway: a decide/answer call that arrives
  // after that turn's own SSE connection is long gone (see this
  // interface's own header comment) still resumes via raceAndRespond,
  // whose final response should report the same full transcript a plain
  // turn's response would, not an empty one. The plain (non-streaming)
  // /messages route is what actually reads this on the way out — see
  // pendingResponseBody/raceAndRespond below — since it has no live
  // channel to have delivered any of this already.
  events: LoopEvent[]
}

const sessionTurns = new Map<string, SessionTurnState>()

function turnKey(agentName: string, rawSessionId: string): string {
  return `${agentName}:${rawSessionId}`
}

function pushSignal(state: SessionTurnState, signal: PendingSignal): void {
  if (state.waiter) {
    const waiter = state.waiter
    state.waiter = null
    waiter(signal)
  } else {
    state.bufferedSignal = signal
  }
}

function nextSignal(state: SessionTurnState): Promise<PendingSignal> {
  if (state.bufferedSignal) {
    const signal = state.bufferedSignal
    state.bufferedSignal = null
    return Promise.resolve(signal)
  }
  return new Promise((resolve) => {
    state.waiter = resolve
  })
}

function pendingResponseBody(rawSessionId: string, signal: PendingSignal, events: LoopEvent[]): Record<string, unknown> {
  const { type, entry } = signal
  return type === 'question'
    ? {
        pending: true,
        type,
        id: entry.id,
        sessionId: rawSessionId,
        question: entry.question,
        options: entry.options,
        answerUrl: `/questions/${entry.id}/answer`,
        events,
      }
    : {
        pending: true,
        type,
        id: entry.id,
        sessionId: rawSessionId,
        tool: entry.tool,
        args: entry.args,
        // Already on PendingApproval itself (actauth's own Scope) — the
        // playground's appendApprovalCard reads data.scope.tenant/
        // environment/agent directly, live or resumed alike, so this was
        // missing here even before raceAndRespond was reused for the
        // decide/answer routes too; just never exercised until a resumed
        // card's own decision started rendering the next one straight
        // from this body instead of a fresh /approvals fetch (which does
        // include it).
        scope: entry.scope,
        reason: entry.reason,
        approveUrl: `/approvals/${entry.id}/approve`,
        denyUrl: `/approvals/${entry.id}/deny`,
        events,
      }
}

// The one place that actually answers "what should the HTTP response be
// right now" for this whole pending-item family — POST /messages calls it
// once the turn starts; POST .../approve|deny|answer call it again after
// resolving their own one decision, to report whatever comes next instead
// of a bare {ok: true} that leaves the caller polling. Every one of these
// routes ends up returning exactly one of the same two shapes: 202
// {pending: true, ...} if the turn immediately needs another decision, or
// 200 {text, sessionId, stopReason?} if it's actually done — a caller can
// treat the whole family as one uniform "decide-or-finish" loop regardless
// of which endpoint the response came from.
async function raceAndRespond(res: ServerResponse, agentName: string, rawSessionId: string, state: SessionTurnState): Promise<void> {
  const winner = await Promise.race([
    state.turnPromise!.then((turnResult) => ({ kind: 'done' as const, turnResult })),
    nextSignal(state).then((signal) => ({ kind: 'pending' as const, signal })),
  ])

  if (winner.kind === 'pending') {
    res.writeHead(202, { 'content-type': 'application/json' }).end(
      JSON.stringify({ ...pendingResponseBody(rawSessionId, winner.signal, state.events), statusUrl: `/agents/${agentName}/sessions/${rawSessionId}` }),
    )
    return
  }

  // events: the full typed lifecycle of this turn, start to finish — see
  // SessionTurnState.events's own doc comment. Both the plain and
  // streaming routes populate it identically; this is what makes a plain
  // POST /messages response a real, complete projection of the same
  // lifecycle the streaming route delivers frame-by-frame, not just a
  // final-text summary of it.
  const responseBody: Record<string, unknown> = { text: winner.turnResult.text, sessionId: rawSessionId, events: state.events }
  if (winner.turnResult.stopReason) responseBody.stopReason = winner.turnResult.stopReason
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(responseBody))
}

async function handleMessages(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
  const parsed = await parseRequest(req, agentName)
  if (!parsed.ok) {
    res.writeHead(parsed.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: parsed.error }))
    return
  }
  const { entry, message, rawSessionId, storageSessionId, tenant } = parsed.value

  // This route has no live channel of its own — no SSE connection to push
  // a pending question/approval onto the way the streaming route does.
  // For a tool-call approval, that's exactly why its channel default is
  // durable (see defaultHttpWebhookNotifier above): the turn just returns
  // stopReason 'pending_approval' and this responds with that directly,
  // no live wait at all. question:pending gets the same durable default
  // now too (see defaultHttpWebhookNotifier's own use below and
  // HUMAN_IN_THE_LOOP.md's "Durable questions" section) — but either kind
  // can still fall through to the live path (unconfigured webhook, or an
  // agent that explicitly opts into a live approver for this channel), so
  // the race-the-whole-turn-against-the-first-pending-signal machinery
  // below stays fully in place for both regardless: race the whole turn
  // against the *first* moment anything in it needs a human — and every
  // *subsequent* moment too (see raceAndRespond, called again from
  // POST .../approve|deny|answer below), not just the first — respond
  // early with everything the caller needs to decide it themselves, no
  // separate discovery/polling call required.
  const key = turnKey(agentName, rawSessionId)
  const state: SessionTurnState = { turnPromise: null, bufferedSignal: null, waiter: null, events: [{ type: 'session', sessionId: rawSessionId }] }
  sessionTurns.set(key, state)

  // Durable when LOOPENGINE_DEFAULT_WEBHOOK_URL/_SECRET are configured
  // (see this module's own defaultHttpWebhookNotifier) — otherwise falls
  // back to today's live WebchatApprover, tracked so a decide() call routes
  // back to this exact instance (see createTrackedApprover's own doc
  // comment). Either way, this agent's own config.httpNotifier (if it
  // covers 'approval') still wins outright over this — see
  // RunAgentOptions.approver's own doc comment.
  const approver =
    defaultHttpWebhookNotifier ??
    createTrackedApprover(rawSessionId, (approval) => {
      state.events.push({ type: 'approval:pending', ...approval })
      pushSignal(state, { type: 'approval', entry: approval })
    })

  // Fresh modelCall per request — see core/agent-registry.ts. Not awaited
  // directly below — see raceAndRespond's own Promise.race for why.
  const turnPromise = sessions.withSession(storageSessionId, async (history) => {
    const result = await runAgent(entry.config, entry.createModelCall(), message, history, {
      tenant,
      sessionId: rawSessionId,
      channel: 'http',
      approver,
      // Durable when LOOPENGINE_DEFAULT_WEBHOOK_URL/_SECRET are
      // configured — see this module's own defaultHttpWebhookNotifier,
      // the same shared instance `approver` above already uses (one
      // instance, both concerns — see WebhookNotifier's own doc
      // comment). When unset, onQuestionPending below still applies
      // unchanged, same fallback-of-the-fallback relationship `approver`
      // above already has.
      questionHandler: defaultHttpWebhookNotifier,
      onEvent: (event) => state.events.push(event),
      onQuestionPending: (question) => {
        state.events.push({ type: 'question:pending', ...question })
        pushSignal(state, { type: 'question', entry: question })
      },
    })
    if (result.pending) {
      await createCheckpointFromPending(agentName, tenant, rawSessionId, result.pending)
    }
    // No SSE connection to write this to (see this route's own header
    // comment) — pushed straight onto state.events instead, same event
    // shape the streaming route's own 'done' SSE frame uses, so the final
    // `events` array this route's response body carries (see
    // raceAndRespond) always ends the same way regardless of which route
    // produced it.
    state.events.push({ type: 'done', text: result.text, ...(result.stopReason ? { stopReason: result.stopReason } : {}) })
    return { newMessages: result.newMessages, result: { text: result.text, stopReason: result.stopReason } }
  })
  state.turnPromise = turnPromise

  // The turn itself keeps running to completion regardless of how (or
  // whether) this specific request ever responds — sessions.withSession
  // still owns appending its result to the session log once it actually
  // resolves, same durability guarantee as any other call. Nothing else
  // is guaranteed to be awaiting turnPromise by the time it settles (a
  // caller might stop polling, or this response might win the race
  // below), so a failure needs its own catch here or it's a silent
  // unhandled rejection. Cleanup only removes *this* state if it's still
  // the current one for `key` — an unrelated new POST /messages reusing
  // the same (agent, sessionId) pair before this one's cleanup runs would
  // otherwise have its own fresh state clobbered here.
  turnPromise
    .catch((err) => {
      console.error(`[messages] background turn for '${agentName}' (session ${rawSessionId}) failed:`, err)
    })
    .finally(() => {
      if (sessionTurns.get(key) === state) sessionTurns.delete(key)
    })

  await raceAndRespond(res, agentName, rawSessionId, state)
}

async function handleMessagesStream(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
  const parsed = await parseRequest(req, agentName)
  if (!parsed.ok) {
    // Headers not sent yet — still a plain JSON error response, not SSE.
    res.writeHead(parsed.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: parsed.error }))
    return
  }
  const { entry, message, rawSessionId, storageSessionId, tenant } = parsed.value

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  // First event, always — same reason handleMessages echoes sessionId in
  // its JSON body: a caller that omitted sessionId needs some way to
  // learn what got generated in order to resume this conversation later.
  writeSseEvent(res, { type: 'session', sessionId: rawSessionId })

  // Same shared per-(agent, sessionId) tracking the plain /messages route
  // uses (see sessionTurns' own doc comment) — registered here too so a
  // decide/answer call made *after* this SSE connection is gone (a
  // resumed session, with no live connection left to push onto) can still
  // learn what's next from its own response instead of falling back to
  // plain {ok: true} and leaving the playground to poll (see
  // playground.ts's own pollForCompletion, now dead code once this
  // shipped — nothing about a *live* connection needs this for itself,
  // writeSseEvent already pushes everything as it happens; this is purely
  // for whoever might decide something after the tab that started it is
  // long gone).
  const key = turnKey(agentName, rawSessionId)
  const state: SessionTurnState = { turnPromise: null, bufferedSignal: null, waiter: null, events: [{ type: 'session', sessionId: rawSessionId }] }
  sessionTurns.set(key, state)

  // A fresh WebchatApprover per streamed turn, not the shared one the plain
  // /messages route passes — its onPending writes straight onto *this*
  // SSE connection, so the approve/deny popup shows up inline in the
  // conversation that's actually blocked on it, not on some separate page
  // an operator has to remember to check. Passed unconditionally, and
  // nothing can override it for this channel — AgentConfig.httpNotifier
  // only ever matches 'http', never 'http_stream' (see its own doc
  // comment), so this is always what actually decides an 'ask' here.
  const streamApprover = createTrackedApprover(rawSessionId, (approval) => {
    const event: LoopEvent = { type: 'approval:pending', ...approval }
    writeSseEvent(res, event)
    state.events.push(event)
    pushSignal(state, { type: 'approval', entry: approval })
  })

  const turnPromise = sessions.withSession(storageSessionId, async (history) => {
    // onEvent already fires at every loop step (budget:check,
    // actauth:decision, toollane:result, ...) — streaming is just
    // forwarding those, not a separate code path through runAgent.
    // onQuestionPending is separate (see its own doc comment for why):
    // pushes straight onto this same SSE connection, same as
    // streamApprover's own onPending does for approvals.
    const result = await runAgent(entry.config, entry.createModelCall(), message, history, {
      tenant,
      sessionId: rawSessionId,
      channel: 'http_stream',
      approver: streamApprover,
      onEvent: (event) => {
        writeSseEvent(res, event)
        state.events.push(event)
      },
      onQuestionPending: (question) => {
        const event: LoopEvent = { type: 'question:pending', ...question }
        writeSseEvent(res, event)
        state.events.push(event)
        pushSignal(state, { type: 'question', entry: question })
      },
    })
    if (result.pending) {
      await createCheckpointFromPending(agentName, tenant, rawSessionId, result.pending)
    }
    const doneEvent: LoopEvent = { type: 'done', text: result.text, ...(result.stopReason ? { stopReason: result.stopReason } : {}) }
    writeSseEvent(res, doneEvent)
    state.events.push(doneEvent)
    return { newMessages: result.newMessages, result: { text: result.text, stopReason: result.stopReason } }
  })
  state.turnPromise = turnPromise

  try {
    await turnPromise
  } catch (err) {
    // Headers are already sent by this point, so an error becomes an SSE
    // event, not an HTTP status code.
    const errorEvent: LoopEvent = { type: 'error', error: String(err) }
    writeSseEvent(res, errorEvent)
    state.events.push(errorEvent)
  } finally {
    if (sessionTurns.get(key) === state) sessionTurns.delete(key)
    res.end()
  }
}

// Gates every route this server has — the whole admin surface (approve/
// deny tool calls, read conversation history, edit permission rules,
// register gateway tools) is otherwise open to anyone who can reach the
// port (see server.listen below: it binds every interface, not just
// localhost). HTTP Basic Auth specifically, not a bearer token, because
// it's the one scheme a plain browser navigation (GET /playground, no JS
// involved yet) can satisfy on its own — the browser's native login
// prompt handles it, then resends the same credentials automatically on
// every later request to this origin, admin UI's own fetch() calls
// included. curl covers the same ground with `-u user:pass`.
//
// Off entirely (today's behavior, unchanged) when LOOPENGINE_ADMIN_AUTH
// isn't set — this file is meant to run locally with zero setup by
// default. A real deployment opts in by setting it; either way, a
// startup warning makes "I forgot to set this" loud instead of silent.
const adminAuth = process.env.LOOPENGINE_ADMIN_AUTH
if (!adminAuth) {
  console.warn(
    '[loopengine] LOOPENGINE_ADMIN_AUTH is not set — every route on this server (including tool-call approvals, conversation history, and permission rules) is open to anyone who can reach it. Set LOOPENGINE_ADMIN_AUTH="user:pass" to require HTTP Basic Auth.',
  )
}

// Compares the whole "user:pass" string as one shared secret, not
// username and password separately — simpler, and just as sound for a
// single shared credential with no per-user distinction to make.
// timingSafeEqual requires equal-length buffers, so length is checked
// first; a length mismatch isn't sensitive information worth spending a
// constant-time comparison to protect.
function isAuthorized(req: IncomingMessage): boolean {
  if (!adminAuth) return true
  const header = req.headers.authorization
  if (!header || !header.startsWith('Basic ')) return false
  const provided = Buffer.from(header.slice('Basic '.length), 'base64')
  const expected = Buffer.from(adminAuth)
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

// Same tool-resolution shape describeAgent above already uses
// (localTools/agentAsTools/gatewayTools) — reused here rather than
// re-derived, so a resolved approval always executes the exact tool
// implementation the paused turn itself would have called, not a second
// guess at it. Deliberately doesn't include systemTools/askUserTool: a
// DurableApprover's own pendingId only ever names a real, gated business
// tool call (see run-agent.ts's own pendingCalls — system tools bypass
// the gate entirely and can never end up 'pending').
async function resolveAgentTool(config: AgentConfig, toolName: string): Promise<ToolDefinition | undefined> {
  const localTools = config.tools ?? (await loadDefaultTools(config))
  const agentAsTools = await loadSubagentAsTools(config)
  const gatewayTools = await loadGatewayToolsFromDir(agentDir(config.name))
  return [...localTools, ...agentAsTools, ...gatewayTools].find((t) => t.name === toolName)
}

/** Deliberately not full JSON Schema validation — this project has no
 * ajv dependency, and one field-presence check is enough to stop an
 * approver's edited args from being obviously wrong (missing a field the
 * tool genuinely needs) without adding one just for this. See
 * HUMAN_IN_THE_LOOP.md's own "Approve-with-edit" section. */
function validateEditedArgs(args: unknown, schema: Record<string, unknown>): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return 'must be an object'
  const required = Array.isArray(schema.required) ? schema.required : []
  for (const field of required) {
    if (typeof field === 'string' && !(field in args)) return `missing required field '${field}'`
  }
  return undefined
}

// Called from both handleMessages and handleMessagesStream right after a
// runAgent() call returns a non-empty `pending` — turns it into the
// durable TurnCheckpoint a later resolve call looks up by pendingId.
// Handles both kinds uniformly (a mixed batch lands both an 'approval'
// and a 'question' item in the same checkpoint's outstanding — see
// PendingItem's own doc comment for why that has to be true). One real
// ordering caveat, not solved here: a DurableApprover's/
// DurableQuestionHandler's own notification (e.g. a webhook) fires from
// inside runAgent() itself, before it returns — an improbably fast
// responder could in principle hit /pending-approvals/ or
// /pending-questions/ before this has run and get an 'alreadyResolved'
// false negative. Not worth restructuring around for a race that needs a
// human to click a link in under the time it takes this call to return.
async function createCheckpointFromPending(
  agent: string,
  tenant: string,
  sessionId: string,
  pending: NonNullable<RunAgentResult['pending']>,
): Promise<void> {
  const outstanding: TurnCheckpoint['outstanding'] = {}
  for (const item of pending.outstanding) {
    outstanding[item.pendingId] = { kind: item.kind, toolUseId: item.toolUseId, tool: item.tool, args: item.args, reason: item.reason }
  }
  await checkpoints.create({ sessionId, agent, tenant, resultsSoFar: pending.resultsSoFar, outstanding })
}

/** Resolves one outstanding item on a durable checkpoint (see
 * HUMAN_IN_THE_LOOP.md) — approve (optionally with editedArgs) or deny —
 * and, once nothing's left outstanding, resumes the turn via
 * resumeAgent() (see respondAfterResolution below, shared with
 * handlePendingQuestionAnswer's own tail). Has no live sessionTurns entry
 * to fall back on the way /approvals/:id/approve|deny does: the whole
 * point of durable is that the process (or even the request) that
 * started this turn may be long gone by the time this fires, so the
 * response here is authoritative on its own, not a fallback for some
 * other channel. */
async function handlePendingApprovalResolve(req: IncomingMessage, res: ServerResponse, pendingId: string): Promise<void> {
  const body = await readJsonBody(req)
  const decision = body.decision === 'approve' || body.decision === 'deny' ? body.decision : undefined
  if (!decision) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: "decision must be 'approve' or 'deny'" }))
    return
  }
  const editedArgs = body.editedArgs as Record<string, unknown> | undefined

  type ResolveOutcome =
    | { kind: 'unknown' }
    | { kind: 'wrong-kind' }
    | { kind: 'validation-error'; error: string }
    | { kind: 'resolved'; checkpoint: TurnCheckpoint }

  const outcome = await checkpoints.withCheckpoint(pendingId, async (checkpoint): Promise<{ checkpoint: TurnCheckpoint | undefined; result: ResolveOutcome }> => {
    if (!checkpoint) return { checkpoint: undefined, result: { kind: 'unknown' } }
    const item = checkpoint.outstanding[pendingId]
    // undefined kind means 'approval' — see OutstandingItem.kind's own
    // doc comment for why this stays optional/back-compat rather than
    // required.
    if (item.kind === 'question') return { checkpoint, result: { kind: 'wrong-kind' } }

    let resultBlock: ModelContentBlock
    if (decision === 'deny') {
      resultBlock = { type: 'tool_result', tool_use_id: item.toolUseId, content: `denied: ${item.reason}`, is_error: true }
    } else {
      const entry = getEntry(checkpoint.agent)
      const tool = entry && (await resolveAgentTool(entry.config, item.tool))
      if (!entry) {
        resultBlock = { type: 'tool_result', tool_use_id: item.toolUseId, content: `error: agent '${checkpoint.agent}' no longer registered`, is_error: true }
      } else if (!tool) {
        resultBlock = { type: 'tool_result', tool_use_id: item.toolUseId, content: `error: tool '${item.tool}' no longer exists`, is_error: true }
      } else {
        const validationError = editedArgs ? validateEditedArgs(editedArgs, tool.input_schema) : undefined
        if (validationError) {
          // Leave the checkpoint completely untouched — persisting the
          // *same* object back is a harmless no-op write, not a real
          // update. This pendingId stays open so the approver can retry
          // with corrected args, instead of a typo burning the one
          // chance to resolve this call.
          return { checkpoint, result: { kind: 'validation-error', error: validationError } }
        }
        try {
          const output = await tool.execute(editedArgs ?? item.args)
          resultBlock = { type: 'tool_result', tool_use_id: item.toolUseId, content: JSON.stringify(output), is_error: false }
        } catch (err) {
          resultBlock = { type: 'tool_result', tool_use_id: item.toolUseId, content: `ERROR: ${err}`, is_error: true }
        }
      }
    }

    const { [pendingId]: _resolvedItem, ...remainingOutstanding } = checkpoint.outstanding
    const resultsSoFar = [...checkpoint.resultsSoFar, resultBlock]
    let outstanding = remainingOutstanding
    // A denial closes the *whole* checkpoint immediately, same as
    // run-agent.ts's own synchronous denial path — any other still-
    // outstanding item in this batch gets a synthesized skip, it never
    // gets left dangling for someone to resolve later.
    if (decision === 'deny') {
      for (const otherItem of Object.values(remainingOutstanding)) {
        resultsSoFar.push({
          type: 'tool_result',
          tool_use_id: otherItem.toolUseId,
          content: `skipped: a sibling tool call in this turn (${item.tool}) was denied`,
          is_error: true,
        })
      }
      outstanding = {}
    }

    const updated: TurnCheckpoint = { ...checkpoint, resultsSoFar, outstanding, closed: Object.keys(outstanding).length === 0 }
    return { checkpoint: updated, result: { kind: 'resolved', checkpoint: updated } }
  })

  if (outcome.kind === 'unknown') {
    // Unknown pendingId, or its checkpoint was already closed — a
    // sibling denial got there first, or this exact pendingId was
    // already resolved. Graceful no-op, not an error (see
    // HUMAN_IN_THE_LOOP.md's own worked example for why this has to be).
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ alreadyResolved: true }))
    return
  }

  if (outcome.kind === 'wrong-kind') {
    res.writeHead(400, { 'content-type': 'application/json' }).end(
      JSON.stringify({ error: `pendingId '${pendingId}' is a pending question, not a pending approval — use POST /pending-questions/${pendingId}/answer` }),
    )
    return
  }

  if (outcome.kind === 'validation-error') {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `editedArgs invalid — ${outcome.error}` }))
    return
  }

  await respondAfterResolution(res, outcome.checkpoint)
}

/** Resolves one outstanding durable question (see HUMAN_IN_THE_LOOP.md's
 * "Durable questions" section) — the question-side sibling of
 * handlePendingApprovalResolve above. Simpler than an approval's own
 * resolution: the human's free-text answer becomes the completing
 * tool_result content directly, no tool.execute() involved (a question
 * has nothing to run), and no deny/editedArgs concept — a question is
 * either answered or it isn't. Shares the same "outstanding empty →
 * resume, else report remaining count" tail via respondAfterResolution. */
async function handlePendingQuestionAnswer(req: IncomingMessage, res: ServerResponse, pendingId: string): Promise<void> {
  const body = await readJsonBody(req)
  if (typeof body.answer !== 'string') {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: "'answer' must be a string" }))
    return
  }
  const answer = body.answer

  type ResolveOutcome = { kind: 'unknown' } | { kind: 'wrong-kind' } | { kind: 'resolved'; checkpoint: TurnCheckpoint }

  const outcome = await checkpoints.withCheckpoint(pendingId, async (checkpoint): Promise<{ checkpoint: TurnCheckpoint | undefined; result: ResolveOutcome }> => {
    if (!checkpoint) return { checkpoint: undefined, result: { kind: 'unknown' } }
    const item = checkpoint.outstanding[pendingId]
    // undefined/'approval' kind hitting the question route is the mirror
    // mismatch of handlePendingApprovalResolve's own guard above.
    if (item.kind !== 'question') return { checkpoint, result: { kind: 'wrong-kind' } }

    const resultBlock: ModelContentBlock = { type: 'tool_result', tool_use_id: item.toolUseId, content: answer, is_error: false }
    const { [pendingId]: _resolvedItem, ...remainingOutstanding } = checkpoint.outstanding
    const resultsSoFar = [...checkpoint.resultsSoFar, resultBlock]
    const updated: TurnCheckpoint = { ...checkpoint, resultsSoFar, outstanding: remainingOutstanding, closed: Object.keys(remainingOutstanding).length === 0 }
    return { checkpoint: updated, result: { kind: 'resolved', checkpoint: updated } }
  })

  if (outcome.kind === 'unknown') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ alreadyResolved: true }))
    return
  }

  if (outcome.kind === 'wrong-kind') {
    res.writeHead(400, { 'content-type': 'application/json' }).end(
      JSON.stringify({ error: `pendingId '${pendingId}' is a pending approval, not a pending question — use POST /pending-approvals/${pendingId}/resolve` }),
    )
    return
  }

  await respondAfterResolution(res, outcome.checkpoint)
}

/** Shared tail for both durable resolve routes above, once a single
 * outstanding item has just been resolved: report how many items are
 * still outstanding, or — once none are — resume the turn for real via
 * resumeAgent(), through the same durable sessions.withSession append
 * path any other turn goes through. */
async function respondAfterResolution(res: ServerResponse, finalCheckpoint: TurnCheckpoint): Promise<void> {
  if (Object.keys(finalCheckpoint.outstanding).length > 0) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({ resolved: true, outstanding: Object.keys(finalCheckpoint.outstanding).length }),
    )
    return
  }

  const entry = getEntry(finalCheckpoint.agent)
  if (!entry) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `agent '${finalCheckpoint.agent}' no longer registered` }))
    return
  }
  const environment = process.env.LOOPENGINE_ENV ?? 'production'
  const storageSessionId = `${finalCheckpoint.tenant}:${environment}:${finalCheckpoint.agent}:${finalCheckpoint.sessionId}`

  const responseBody = await sessions.withSession(storageSessionId, async (history) => {
    // Same channel/approver/questionHandler fallback the original
    // (now-resolved) call used — a chained second pending item should
    // behave identically to the first, not fall through further just
    // because it's mid-resume. No live connection to wire an onPending
    // push onto here (unlike handleMessages' own WebchatApprover) — the
    // approver is still tracked, so GET /agents/:name/approvals and
    // POST /approvals/:id/approve|deny can find and resolve it, and its
    // own 5-minute timeout still applies rather than this hanging
    // forever. A resumed turn's own new system_ask_user call, likewise,
    // is durable when defaultHttpWebhookNotifier is configured — and
    // when it isn't, onQuestionPending still has to be *something*
    // (not omitted): createAskUserTool's own live/console-fallback branch
    // keys off onQuestionPending's mere presence, not usefulness, and
    // omitting it here (as an earlier version of this code did) meant a
    // resumed turn's fresh question blocked the *server process's own
    // stdin* — unrecoverable via any HTTP endpoint, not just live-but-
    // unwatched. A no-op is enough to route it into the shared
    // WebchatQuestionHandler registry instead — same "still tracked, still
    // answerable via the REST endpoints, still times out on its own"
    // safety net createTrackedApprover(sessionId) (no onPending) already
    // gives a resumed approval just above.
    const result = await resumeAgent(entry.config, entry.createModelCall(), history, finalCheckpoint.resultsSoFar, {
      tenant: finalCheckpoint.tenant,
      sessionId: finalCheckpoint.sessionId,
      channel: 'http',
      approver: defaultHttpWebhookNotifier ?? createTrackedApprover(finalCheckpoint.sessionId),
      questionHandler: defaultHttpWebhookNotifier,
      onQuestionPending: () => {},
    })
    // The resumed turn can itself hit another durably-pending call/
    // question — same wiring as the fresh-turn call sites above, or its
    // own new pendingId(s) would have nowhere indexed to be resolved
    // against.
    if (result.pending) {
      await createCheckpointFromPending(finalCheckpoint.agent, finalCheckpoint.tenant, finalCheckpoint.sessionId, result.pending)
    }
    return { newMessages: result.newMessages, result: { text: result.text, stopReason: result.stopReason } }
  })

  res.writeHead(200, { 'content-type': 'application/json' }).end(
    JSON.stringify({ text: responseBody.text, sessionId: finalCheckpoint.sessionId, ...(responseBody.stopReason ? { stopReason: responseBody.stopReason } : {}) }),
  )
}

const server = createServer(async (req, res) => {
  if (!isAuthorized(req)) {
    res
      .writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Basic realm="loopengine"' })
      .end(JSON.stringify({ error: 'authorization required' }))
    return
  }

  // One catch-all around both routes. node:http does not catch rejections
  // from an async request listener itself — an uncaught one here doesn't
  // just fail the request, it crashes the whole process (confirmed: an
  // unhandled rejection anywhere in a route took the entire server down
  // before this existed). handleMessagesStream's own try/catch below
  // still handles errors *after* SSE headers are sent (those need an
  // in-band `error` event, not a fresh status code) — this is the
  // backstop for everything before that point, for both routes.
  try {
    // Query strings (the browser pages below link to each other with
    // ?agent=<name> to deep-link a preselected agent) would otherwise
    // break every exact-match/regex `$`-anchored route below, which only
    // ever expected a bare path — stripped once here rather than in each
    // route individually.
    const pathname = (req.url ?? '/').split('?')[0]

    const streamMatch = req.method === 'POST' && pathname.match(/^\/agents\/([^/]+)\/messages\/stream$/)
    if (streamMatch) {
      await handleMessagesStream(req, res, decodeURIComponent(streamMatch[1]))
      return
    }

    const sessionGetMatch = req.method === 'GET' && pathname.match(/^\/agents\/([^/]+)\/sessions\/([^/]+)$/)
    if (sessionGetMatch) {
      await handleSessionGet(req, res, decodeURIComponent(sessionGetMatch[1]), decodeURIComponent(sessionGetMatch[2]))
      return
    }

    // Dev playground: a browser client on top of the two routes above,
    // rendering the same SSE events /messages/stream already emits — see
    // web/playground.ts. GET, not POST, and an exact path match
    // (neither has a :name segment), so no risk of colliding with the
    // regexes above (already partitioned by method).
    if (req.method === 'GET' && pathname === '/playground') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(playgroundHtml)
      return
    }

    // Pending 'ask' decisions — no browser page of its own: a streamed
    // chat turn (handleMessagesStream above) pushes its own pending
    // approvals straight onto that conversation's SSE connection instead,
    // so this is really just the plain-JSON escape hatch for the
    // non-streaming /messages route, or any other client that wants to
    // decide by hand. Scoped to one agent (exact) and, when given, one
    // session (best-effort — see web/web-approver.ts's sessionByApprover for
    // why that's not always knowable) — never a blanket list across every
    // agent/tenant this process serves, which would leak one
    // conversation's pending approvals to any caller asking about a
    // completely different one.
    const approvalsSessionMatch = req.method === 'GET' && pathname.match(/^\/agents\/([^/]+)\/sessions\/([^/]+)\/approvals$/)
    if (approvalsSessionMatch) {
      const agent = decodeURIComponent(approvalsSessionMatch[1])
      const sessionId = decodeURIComponent(approvalsSessionMatch[2])
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ approvals: listApprovals({ agent, sessionId }) }))
      return
    }
    const approvalsAgentMatch = req.method === 'GET' && pathname.match(/^\/agents\/([^/]+)\/approvals$/)
    if (approvalsAgentMatch) {
      const agent = decodeURIComponent(approvalsAgentMatch[1])
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ approvals: listApprovals({ agent }) }))
      return
    }
    const approvalDecisionMatch = req.method === 'POST' && pathname.match(/^\/approvals\/([^/]+)\/(approve|deny)$/)
    if (approvalDecisionMatch) {
      const id = decodeURIComponent(approvalDecisionMatch[1])
      const approved = approvalDecisionMatch[2] === 'approve'
      // Looked up *before* deciding — decideApproval below removes it (see
      // web/web-approver.ts's own onSettled), so this is the last chance to
      // learn which agent/session it belonged to. No await in between, so
      // nothing else can race in and decide it out from under this lookup.
      const found = findApproval(id)
      if (!found) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `No pending approval '${id}' (already decided, timed out, or never existed).` }))
        return
      }
      decideApproval(id, approved)
      // A session-turn state only exists for a turn started via the plain
      // POST /messages route (see its own doc comment) — one raised via
      // the streaming route, or whose owning turn already finished and
      // cleaned itself up, falls back to the old plain {ok: true}: that
      // caller already has its own way of finding out what happens next
      // (its still-open SSE connection, or the fact the turn's already
      // over). Known, accepted gap: two overlapping POST /messages calls
      // for the very same (agent, sessionId) before the first resolves
      // would leave this decide racing the *second* call's state instead
      // of the first's — sessions.withSession's own per-session lock
      // still serializes their actual execution either way, so nothing
      // is lost or corrupted, just possibly reported against the wrong
      // one of the two. Sending a second message before the first
      // finishes isn't a flow this API is meant to support regardless.
      const state = sessionTurns.get(turnKey(found.approval.scope.agent, found.sessionId))
      if (state) {
        // A streamed turn registers this same state (see
        // handleMessagesStream) but never drains it itself — its own live
        // SSE connection already delivers everything as it happens, so
        // pushSignal's buffer (see its own doc comment) just sits there
        // holding *this exact* now-decided approval, unconsumed, the
        // whole time. Left alone, the race below would immediately "win"
        // on that stale entry instead of actually waiting for whatever
        // comes next — confirmed live: approving step_one echoed step_one
        // straight back as the "next" pending item. Only one thing can
        // ever be genuinely pending at a time per session (run-agent.ts's
        // own gate loop blocks on one decision before evaluating the
        // next), so any buffered signal still sitting here at this exact
        // moment can only be the one just decided — safe to discard
        // unconditionally, not just when it happens to match this id.
        state.bufferedSignal = null
        await raceAndRespond(res, found.approval.scope.agent, found.sessionId, state)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
      return
    }

    // A DurableApprover's own pending decision — see HUMAN_IN_THE_LOOP.md.
    // Unlike /approvals/:id/approve|deny above, this doesn't assume a live
    // sessionTurns entry exists at all (the whole point of durable is that
    // the process that started the turn may be long gone) — resolving one
    // just updates the checkpoint and, once nothing's left outstanding,
    // resumes the turn fresh via resumeAgent + sessions.withSession, the
    // same durable append path any other turn goes through.
    const pendingApprovalResolveMatch = req.method === 'POST' && pathname.match(/^\/pending-approvals\/([^/]+)\/resolve$/)
    if (pendingApprovalResolveMatch) {
      await handlePendingApprovalResolve(req, res, decodeURIComponent(pendingApprovalResolveMatch[1]))
      return
    }

    // A DurableQuestionHandler's own pending question — question-side
    // sibling of /pending-approvals/:id/resolve just above, same
    // reasoning (see HUMAN_IN_THE_LOOP.md's "Durable questions" section):
    // no live sessionTurns entry assumed, resolving one just updates the
    // checkpoint and, once nothing's left outstanding, resumes the turn
    // fresh via resumeAgent + sessions.withSession.
    const pendingQuestionAnswerMatch = req.method === 'POST' && pathname.match(/^\/pending-questions\/([^/]+)\/answer$/)
    if (pendingQuestionAnswerMatch) {
      await handlePendingQuestionAnswer(req, res, decodeURIComponent(pendingQuestionAnswerMatch[1]))
      return
    }

    // Pending ask_user questions (see system-tools/ask_user.ts) — same
    // shape/reasoning as /approvals just above: a streamed chat turn
    // pushes its own 'question:pending' SSE event straight onto that
    // conversation (see playground.ts's inline card for it), so this is
    // the plain-JSON escape hatch for anything else — the non-streaming
    // /messages route, a plain CLI run's fallback console prompt aside,
    // or a client that wants to answer by hand. Scoped to one agent and,
    // when given, one exact session — every question always knows both
    // (see PendingQuestion's own doc comment), so unlike approvals this
    // scoping is never just best-effort.
    const questionsSessionMatch = req.method === 'GET' && pathname.match(/^\/agents\/([^/]+)\/sessions\/([^/]+)\/questions$/)
    if (questionsSessionMatch) {
      const agent = decodeURIComponent(questionsSessionMatch[1])
      const sessionId = decodeURIComponent(questionsSessionMatch[2])
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ questions: listQuestions({ agent, sessionId }) }))
      return
    }
    const questionsAgentMatch = req.method === 'GET' && pathname.match(/^\/agents\/([^/]+)\/questions$/)
    if (questionsAgentMatch) {
      const agent = decodeURIComponent(questionsAgentMatch[1])
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ questions: listQuestions({ agent }) }))
      return
    }
    const questionAnswerMatch = req.method === 'POST' && pathname.match(/^\/questions\/([^/]+)\/answer$/)
    if (questionAnswerMatch) {
      const id = decodeURIComponent(questionAnswerMatch[1])
      const body = await readJsonBody(req)
      const answer = String(body.answer ?? '')
      // Same "look up before deciding" reasoning as the approval route
      // just above.
      const found = findQuestion(id)
      if (!found) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `No pending question '${id}' (already answered, timed out, or never existed).` }))
        return
      }
      answerQuestion(id, answer)
      // See the approval route's own doc comment for why a missing state
      // (or a question with no sessionId at all — see PendingQuestion's
      // own doc comment for when that happens) falls back to plain
      // {ok: true} instead.
      const state = found.sessionId ? sessionTurns.get(turnKey(found.agent, found.sessionId)) : undefined
      if (state && found.sessionId) {
        // See the approval route's own doc comment on this exact line —
        // same staleness hazard, same fix.
        state.bufferedSignal = null
        await raceAndRespond(res, found.agent, found.sessionId, state)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }))
      return
    }

    if (req.method === 'GET' && pathname === '/agents') {
      if (prefersHtml(req)) {
        res.writeHead(200, { 'content-type': 'text/html' }).end(agentsListPageHtml)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({ agents: listAgents().map((name) => ({ name, systemPrompt: getEntry(name)!.config.systemPrompt })) }),
      )
      return
    }
    if (req.method === 'POST' && pathname === '/agents') {
      await handleCreateAgent(req, res)
      return
    }
    const editAgentMatch = req.method === 'PUT' && pathname.match(/^\/agents\/([^/]+)$/)
    if (editAgentMatch) {
      await handleEditAgent(req, res, decodeURIComponent(editAgentMatch[1]))
      return
    }

    // Browser page: the account-wide counterpart to the per-agent
    // Overview/Skills/Tools/ActAuth tabs below — a left sidebar of
    // Models/Gateways (plus a plain link out to the per-agent Agents
    // page), neither of which is a property of any one agent (see
    // global-config.ts's own header comment for why those live in a
    // separate module and page from web/agents-config-page.ts).
    if (req.method === 'GET' && pathname === '/config') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(globalConfigPageHtml)
      return
    }
    if (req.method === 'GET' && pathname === '/config/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(describeModelProviders(listAgents(), (name) => getEntry(name)?.config)))
      return
    }
    if (req.method === 'GET' && pathname === '/config/gateways') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await describeGateways()))
      return
    }
    if (req.method === 'POST' && pathname === '/config/gateways/composio/disconnect') {
      await handleComposioDisconnect(res)
      return
    }

    // Browser page: lists every registered agent and renders its full
    // config (tools, permissions, sessionIdFor, ...) via the JSON route
    // below — see web/agents-config-page.ts. A fixed two-segment
    // path, so it can't collide with the three-segment
    // /agents/:name/config regex right below it.
    if (req.method === 'GET' && pathname === '/agents/config') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(agentsConfigPageHtml)
      return
    }

    const configMatch = req.method === 'GET' && pathname.match(/^\/agents\/([^/]+)\/config$/)
    if (configMatch) {
      const agentName = decodeURIComponent(configMatch[1])
      const entry = getEntry(agentName)
      if (!entry) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(await describeAgent(entry)))
      return
    }

    // Backs the add-a-source picker (see handleComposioConnections's own
    // doc comment for why these aren't under /agents/:name/). Checked
    // before the /agents/... routes below only because they're declared
    // first here — there's no actual path overlap to worry about, these
    // don't start with /agents at all.
    if (req.method === 'GET' && pathname === '/composio/connections') {
      await handleComposioConnections(res)
      return
    }
    if (req.method === 'GET' && pathname === '/composio/tools') {
      const toolkit = new URL(req.url ?? '/', 'http://localhost').searchParams.get('toolkit') ?? undefined
      await handleComposioTools(res, toolkit)
      return
    }

    // No standalone admin page for these — gateway-tools.ts's registry is
    // managed from a "Gateway tools" tab inside /agents/config now (see
    // web/agents-config-page.ts), not its own page. These JSON
    // routes are what that tab's script calls.
    // Three segments after gateway-tools/ (sourceName/slug) — checked
    // before the two-segment (sourceName only) route right below; the
    // trailing `$` anchor on each means they never actually overlap
    // regardless of order, but the more specific one reads better first.
    const gatewayToolSlugDeleteMatch = req.method === 'DELETE' && pathname.match(/^\/agents\/([^/]+)\/gateway-tools\/([^/]+)\/([^/]+)$/)
    if (gatewayToolSlugDeleteMatch) {
      await handleGatewayToolSlugDelete(
        res,
        decodeURIComponent(gatewayToolSlugDeleteMatch[1]),
        decodeURIComponent(gatewayToolSlugDeleteMatch[2]),
        decodeURIComponent(gatewayToolSlugDeleteMatch[3]),
      )
      return
    }

    const gatewayToolsDeleteMatch = req.method === 'DELETE' && pathname.match(/^\/agents\/([^/]+)\/gateway-tools\/([^/]+)$/)
    if (gatewayToolsDeleteMatch) {
      handleToolSourcesDelete(res, decodeURIComponent(gatewayToolsDeleteMatch[1]), decodeURIComponent(gatewayToolsDeleteMatch[2]))
      return
    }

    const gatewayToolsMatch = pathname.match(/^\/agents\/([^/]+)\/gateway-tools$/)
    if (gatewayToolsMatch && req.method === 'GET') {
      // ?refresh=1 is the admin page's own "Refresh" button — bypasses
      // describeGatewayTools' own cache to actually re-check Composio
      // live (see its own doc comment for why a plain page load doesn't).
      const force = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('refresh') === '1'
      await handleToolSourcesGet(res, decodeURIComponent(gatewayToolsMatch[1]), force)
      return
    }
    if (gatewayToolsMatch && req.method === 'POST') {
      await handleToolSourcesPost(req, res, decodeURIComponent(gatewayToolsMatch[1]))
      return
    }

    // Backs the Skills tab's edit form — see skills-admin.ts for why
    // :skillId is restricted to a flat (non-nested) id.
    const skillMatch = pathname.match(/^\/agents\/([^/]+)\/skills\/([^/]+)$/)
    if (skillMatch && req.method === 'GET') {
      handleSkillGet(res, decodeURIComponent(skillMatch[1]), decodeURIComponent(skillMatch[2]))
      return
    }
    if (skillMatch && req.method === 'PUT') {
      await handleSkillPut(req, res, decodeURIComponent(skillMatch[1]), decodeURIComponent(skillMatch[2]))
      return
    }
    if (skillMatch && req.method === 'DELETE') {
      handleSkillDelete(res, decodeURIComponent(skillMatch[1]), decodeURIComponent(skillMatch[2]))
      return
    }

    // Backs the Actauth tab's rule editor and default_decision control.
    // The default-decision route is checked before the :ruleName routes
    // right below since 'default-decision' would otherwise itself match
    // as a rule name.
    const actauthDefaultDecisionMatch = req.method === 'PUT' && pathname.match(/^\/agents\/([^/]+)\/actauth\/default-decision$/)
    if (actauthDefaultDecisionMatch) {
      await handleActauthDefaultDecisionPut(req, res, decodeURIComponent(actauthDefaultDecisionMatch[1]))
      return
    }

    const actauthRuleMatch = pathname.match(/^\/agents\/([^/]+)\/actauth\/rules\/([^/]+)$/)
    if (actauthRuleMatch && req.method === 'PUT') {
      await handleActauthRulePut(req, res, decodeURIComponent(actauthRuleMatch[1]), decodeURIComponent(actauthRuleMatch[2]))
      return
    }
    if (actauthRuleMatch && req.method === 'DELETE') {
      handleActauthRuleDelete(res, decodeURIComponent(actauthRuleMatch[1]), decodeURIComponent(actauthRuleMatch[2]))
      return
    }

    const actauthRulesMatch = pathname.match(/^\/agents\/([^/]+)\/actauth\/rules$/)
    if (actauthRulesMatch && req.method === 'POST') {
      await handleActauthRulePost(req, res, decodeURIComponent(actauthRulesMatch[1]))
      return
    }

    const actauthMatch = req.method === 'GET' && pathname.match(/^\/agents\/([^/]+)\/actauth$/)
    if (actauthMatch) {
      handleActauthGet(res, decodeURIComponent(actauthMatch[1]))
      return
    }

    const match = req.method === 'POST' && pathname.match(/^\/agents\/([^/]+)\/messages$/)
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }))
      return
    }

    await handleMessages(req, res, decodeURIComponent(match[1]))
  } catch (err) {
    if (res.headersSent) {
      res.end()
    } else {
      res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(err) }))
    }
  }
})

const port = Number(process.env.PORT ?? 8787)
server.listen(port, () => console.log(`agent API listening on :${port}`))

async function shutdown() {
  server.close()
  await sessions.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
