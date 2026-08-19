# LoopEngine

[![CI](https://github.com/evanyan22/loopengine/actions/workflows/ci.yml/badge.svg)](https://github.com/evanyan22/loopengine/actions/workflows/ci.yml)

LoopEngine is a runtime for building AI agents: a persona, a set of tools,
and permission rules, run through a transparent ReAct loop. No chain DSL,
no hidden control flow — `run-agent.ts` is a single function you can read
top to bottom. Run agents over a CLI, an HTTP API, or both.

## Quick start

```bash
npx create-loopengine@latest my-agents
cd my-agents
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY
npm run dev             # HTTP server on :8787
```

This scaffolds a standalone project — its own repo, with `loopengine` as
a dependency, a starter agent, and CLI + HTTP adapters already wired up.
That's the intended way to use LoopEngine: an independent project you own
and build agents in, not a library you import into an existing app.

### Define your first agent

An agent is just an `AgentConfig`: `name`, `systemPrompt`, `tools`, `rules`,
and a `model`. Drop it in a folder under `agents/` — `agents/<name>/index.ts`
— and it's picked up automatically, no registry to edit, no import to add.

Most fields don't even need to be written out — they default to a
conventional path under the agent's own folder:

| Field | Defaults to |
| --- | --- |
| `rules` | `agents/<name>/actauth.yml` (missing → deny everything) |
| `tools` | `agents/<name>/tools/index.ts`'s exported `tools` (missing → no tools) |
| `skillsDirs` | `agents/<name>/skills` (missing → no skills) |

`rules` is how you gate what a tool can do without approval — see
"Tool permission and multi-tenancy" below.

The simplest possible agent, `agents/weather-agent/index.ts` — `tools`,
`rules`, and `skillsDirs` all omitted, so they default to
`agents/weather-agent/tools/`, `actauth.yml`, and `skills/`:

```ts
import type { AgentConfig } from '../../agent-config.js'

export const config: AgentConfig = {
  name: 'weather-agent',
  systemPrompt: 'You answer questions about the weather.',
  model: { provider: 'anthropic', model: 'claude-sonnet-5' }, // reads ANTHROPIC_API_KEY
}
```

See `agents/customer-service/` and `agents/file-agent/` for complete,
working examples.

## Core concepts

### 1. The Loop

`run-agent.ts` is the whole engine — a single, readable ReAct loop with no
hidden control flow: call the model, act on what it asks for, repeat.

1. Call the model with the conversation so far.
2. If it responds with tool calls, each one is checked against
   `AgentConfig.rules` — allowed calls run, denied calls are refused,
   "ask" calls wait on `AgentConfig.approver` (see "Tool permission and
   multi-tenancy" below).
3. Approved calls execute and their results feed back into the
   conversation.
4. Repeat from step 1 — until the model stops requesting tools
   (`end_turn`) or `AgentConfig.maxTurns` (default 25) is hit, which ends
   the turn with `RunAgentResult.stopReason: 'max_turns'`, a real result
   rather than a thrown error.

`runAgent` itself does no I/O — callers own conversation history and the
model call — which is what lets the same loop serve a one-shot CLI call,
a long-lived HTTP chat session, and a fully simulated test, unchanged.

### 2. Agents — convention over configuration

Beyond the `AgentConfig` shape and folder convention shown in "Define
your first agent" above, the discovery mechanism is what makes this
convention-over-configuration: `discoverAgents` scans `agents/` at
startup, keyed by each module's own `AgentConfig.name` — not the
filename or folder name — and builds the name → config lookup every
adapter uses. Nothing to register by hand; a module that exports neither
`config` nor a way to build a model call fails loudly at startup instead
of silently not showing up.

### 3. Skills and tools: agent-specific vs. global

Both skills and tools follow the same rule: **default to agent-specific,
promote to global only once something is genuinely shared.**

- **Agent-specific** (the default) — lives under that agent's own folder,
  seen only by that agent:
  ```
  agents/<name>/skills/<skill>/SKILL.md
  agents/<name>/tools/<tool>.ts
  ```
- **Global** — lives at the repo root, seen by every agent that opts in:
  ```
  skills/<skill>/SKILL.md      # pointed at by any agent whose skillsDirs includes it
  tools/<tool>.ts              # imported explicitly into any agent's tools array
  ```

Skills are discovered via `AgentConfig.skillsDirs` (an array of
directories, `SKILL.md`-based: a short description stays in context, the
full body loads only when the model invokes it). Tools have no
auto-discovery — an agent's `tools` array just imports whichever tool
files it wants, agent-specific or global.

Both root directories (`tools/`, `skills/`) are empty today — every skill
and tool in this repo is agent-specific. Move something there only when a
second agent actually needs the exact same one, not because it feels
reusable in theory.

**Opting an agent into a global skill or tool** is explicit either way —
nothing scans the root for you:

```ts
// Global skill: add the root path alongside the agent's own
skillsDirs: ['agents/my-agent/skills', 'skills']

// Global tool: tools has no auto-discovery, so import it and merge it
// into the agent's own array by hand
import { sharedTool } from '../../tools/shared-tool.js'
import { tools as ownTools } from './tools/index.js'

tools: [...ownTools, sharedTool]
```

Tools don't have to be hand-written either. For SaaS actions (GitHub,
Slack, etc.) where you'd rather not own the vendor's OAuth flow yourself,
[`mcpplug`](https://www.npmjs.com/package/mcpplug) connects through
[Composio](https://composio.dev), which already holds the OAuth
relationship with 1000+ apps, and returns tools in the same
`ToolDefinition` shape — so they drop into `tools` right alongside your
own:

```ts
import { connectComposioSource } from 'mcpplug'

const composioTools = await connectComposioSource('composio', {
  slugs: ['GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER'],
}).then((source) => source.loadTools())

const config: AgentConfig = {
  name: 'my-agent',
  tools: [...handWrittenTools, ...composioTools],
  rules: [{ scopePattern: 'default/production/my-agent', tool: 'composio_GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', decision: 'allow' }],
  defaultDecision: 'ask',
}
```

Either kind of tool goes through the same permission gating, parallel
scheduling, and context-budget tracking. See `agents/file-agent/index.ts`
for a working example.

### 4. Tool permission and multi-tenancy

Every tool call is gated by [`actauth`](https://www.npmjs.com/package/actauth):
each rule in `AgentConfig.rules` maps a `scope` (tenant/environment) + tool
name to `allow` / `ask` / `deny`. Anything not covered falls through to
`defaultDecision`. An `ask` decision routes to `AgentConfig.approver`
(defaults to blocking on stdin — swap in a real one, e.g. Slack-backed,
for production).

A real agent's rules live in `agents/<name>/actauth.yml`:

```yaml
default_decision: deny

rules:
  - name: weather-lookup-always-allowed
    scope: "*/*"
    tool: get_weather
    decision: allow
```

`scope` is `tenant/environment` — `"*/*"` here means "every tenant, every
environment." Rules are matched most-specific-scope-first, so an agent
that needs different behavior per tenant just adds a more specific rule
(e.g. `acme-corp/production`) alongside the wildcard fallback.

That `scope` is what makes rules multi-tenant: the same agent can behave
differently for different customers. `environment` is a deployment-wide
setting (`LOOPENGINE_ENV`, default `production`). `tenant` is resolved per
request via `AgentConfig.tenantFor?: (headers, body) => string |
undefined` — from headers only, never the request body, since it feeds
permission decisions directly. No `tenantFor` means every request is the
`'default'` tenant.

### 5. Sessions

A session is one ongoing conversation. Message history persists between
requests automatically — send a message, get a reply, come back later with
the same `sessionId` and continue where you left off. Two storage backends,
picked automatically: a local file store, or Redis if `REDIS_URL` is set
(needed for multiple server instances).

An agent can define `AgentConfig.sessionIdFor(body)` to control what
counts as "one conversation" for its own domain (e.g. `customer-service`
hashes `customerEmail`, so a request with no email is rejected rather than
starting an anonymous session). Without it, the caller just supplies a
`sessionId`, or gets one generated for them.

## Running an agent

**CLI:**

```bash
npx tsx adapters/cli.ts --agent customer-service --session s1 "order A-1001 arrived broken"
```

**HTTP:**

```bash
npx tsx adapters/http.ts
curl -X POST localhost:8787/agents/customer-service/messages \
  -H 'content-type: application/json' \
  -d '{"customerEmail":"a@example.com","message":"order A-1001 arrived broken"}'
```

Add `/stream` to the URL for a Server-Sent Events response — one event per
loop step (tool call, permission decision, budget check) instead of a
single reply at the end.

## Wiring a real model

Declare `AgentConfig.model` and the runtime builds a real `ModelCall` for
you, using the matching API key from the environment:

| `provider` | env var | `model` required? |
| --- | --- | --- |
| `'anthropic'` | `ANTHROPIC_API_KEY` | no — defaults to `claude-sonnet-5` |
| `'openai'` | `OPENAI_API_KEY` | yes |
| `'deepseek'` | `DEEPSEEK_API_KEY` | yes |

For anything else (a custom SDK client, a canned/simulated model for
testing), export your own `createModelCall(): ModelCall` instead.

## Built on

| Package | Responsibility |
|---|---|
| [`actauth`](https://www.npmjs.com/package/actauth) | Permission gating (allow/ask/deny) with human-approval hooks |
| [`contextclip`](https://www.npmjs.com/package/contextclip) | Context-window budget tracking |
| [`reflowkit`](https://www.npmjs.com/package/reflowkit) | Retries prompt-too-long / truncated-output failures |
| [`sessionknit`](https://www.npmjs.com/package/sessionknit) | Durable session log with crash-interruption detection |
| [`skillgarden`](https://www.npmjs.com/package/skillgarden) | `SKILL.md` discovery and lazy loading |
| [`toollane`](https://www.npmjs.com/package/toollane) | Parallel/solo tool-call scheduling |
| [`mcpplug`](https://www.npmjs.com/package/mcpplug) | Gateway tool sourcing (e.g. Composio) |

Installing `loopengine` pulls all of these in as regular dependencies —
install one directly only if you want to use it standalone.

## Deployment

```bash
docker compose up --build
```

Builds the HTTP adapter into a container and starts it alongside Redis.
For production, push the image to any container platform with `REDIS_URL`
and your model/tool API keys set as environment variables.
