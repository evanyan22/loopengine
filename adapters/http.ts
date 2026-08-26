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
import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { getEntry, listAgents, projectDir, registerAgent, type RegistryEntry } from '../agent-registry.js'
import { loadAgentModule } from '#discover-agents.js'
import { createSessionStore } from '../session-store.js'
import { runAgent, loadRules, loadDefaultTools, loadSubagentAsTools } from '#run-agent.js'
import type { AgentConfig } from '#agent-config.js'
import { SkillGarden } from 'skillgarden'
import { playgroundHtml } from './playground.js'
import { agentsConfigPageHtml } from './agents-config-page.js'
import { agentsListPageHtml } from './agents-list-page.js'
import { globalConfigPageHtml } from './global-config-page.js'
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
} from '#gateway-tools.js'
import { readSkill, writeSkill, deleteSkill, SkillInvalidIdError, SkillNotFoundError } from '#skills-admin.js'
import {
  readActauthConfig,
  addActauthRule,
  updateActauthRule,
  removeActauthRule,
  setDefaultDecision,
  ActauthRuleExistsError,
  ActauthRuleNotFoundError,
} from '#actauth-admin.js'
import { describeModelProviders, describeGateways } from '#global-config.js'
import { scaffoldAgent, AgentNameError, AgentExistsError, AgentModelError, type AgentTemplateOptions } from '#cli.js'
import type { Decision } from 'actauth'

const sessions = createSessionStore()

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
  const skillsDirs = config.skillsDirs ?? [`agents/${config.name}/skills`]
  const skillGarden = skillsDirs.length ? new SkillGarden({ dirs: skillsDirs, indexBudgetTokens: config.skillIndexBudgetTokens ?? 200 }) : null
  const skillIndex = skillGarden?.buildIndex().included ?? []

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
    tools: tools.map(describeTool),
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
    approver: config.approver ? 'custom' : 'default (ConsoleApprover)',
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

async function handleToolSourcesGet(res: ServerResponse, agentName: string): Promise<void> {
  if (!getEntry(agentName)) {
    res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `unknown agent '${agentName}'` }))
    return
  }
  const sources = await describeGatewayTools(agentName)
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
// adapters/agents-config-page.ts's Gateway Tools section — see
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
// cli.ts's own scaffoldAgent rather than re-implementing the
// agents/<name>/index.ts template here, so a web-created agent is
// byte-for-byte the same stub `loopengine add-agent` would generate.
// scaffoldAgent runs against agent-registry.ts's own projectDir(), not
// process.cwd() — they're usually the same directory, but only
// projectDir() is guaranteed to match where this registry's own
// discoverAgents call actually resolved agents/ against (see its own
// doc comment), which is what matters here.
//
// Unlike agent-registry.ts's own discoverAgents (a one-shot directory
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
// agents/*/index.ts files — see cli.ts's own comment there) would still
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

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function handleMessages(req: IncomingMessage, res: ServerResponse, agentName: string): Promise<void> {
  const parsed = await parseRequest(req, agentName)
  if (!parsed.ok) {
    res.writeHead(parsed.status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: parsed.error }))
    return
  }
  const { entry, message, rawSessionId, storageSessionId, tenant } = parsed.value

  const text = await sessions.withSession(storageSessionId, async (history) => {
    // Fresh modelCall per request — see agent-registry.ts.
    const result = await runAgent(entry.config, entry.createModelCall(), message, history, { tenant })
    return { newMessages: result.newMessages, result: result.text }
  })

  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text, sessionId: rawSessionId }))
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
  writeSseEvent(res, 'session', { sessionId: rawSessionId })

  try {
    await sessions.withSession(storageSessionId, async (history) => {
      // onEvent already fires at every loop step (contextclip:check,
      // actauth:decision, toollane:result, ...) — streaming is just
      // forwarding those, not a separate code path through runAgent.
      const result = await runAgent(entry.config, entry.createModelCall(), message, history, {
        tenant,
        onEvent: (event, detail) => writeSseEvent(res, event, detail),
      })
      writeSseEvent(res, 'done', { text: result.text })
      return { newMessages: result.newMessages, result: result.text }
    })
  } catch (err) {
    // Headers are already sent by this point, so an error becomes an SSE
    // event, not an HTTP status code.
    writeSseEvent(res, 'error', { error: String(err) })
  } finally {
    res.end()
  }
}

const server = createServer(async (req, res) => {
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

    // Dev playground: a browser client on top of the two routes above,
    // rendering the same SSE events /messages/stream already emits — see
    // adapters/playground.ts. GET, not POST, and an exact path match
    // (neither has a :name segment), so no risk of colliding with the
    // regexes above (already partitioned by method).
    if (req.method === 'GET' && pathname === '/playground') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(playgroundHtml)
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

    // Browser page: the account-wide counterpart to the per-agent
    // Overview/Skills/Tools/ActAuth tabs below — a left sidebar of
    // Models/Gateways (plus a plain link out to the per-agent Agents
    // page), neither of which is a property of any one agent (see
    // global-config.ts's own header comment for why those live in a
    // separate module and page from adapters/agents-config-page.ts).
    if (req.method === 'GET' && pathname === '/config') {
      res.writeHead(200, { 'content-type': 'text/html' }).end(globalConfigPageHtml)
      return
    }
    if (req.method === 'GET' && pathname === '/config/models') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(describeModelProviders()))
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
    // below — see adapters/agents-config-page.ts. A fixed two-segment
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
    // adapters/agents-config-page.ts), not its own page. These JSON
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
      await handleToolSourcesGet(res, decodeURIComponent(gatewayToolsMatch[1]))
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
