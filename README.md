# LoopEngine

[![CI](https://github.com/evanyan22/loopengine/actions/workflows/ci.yml/badge.svg)](https://github.com/evanyan22/loopengine/actions/workflows/ci.yml)

LoopEngine is a runtime for defining and running multiple AI agents through a
transparent ReAct loop. Write an agent as a plain config object — persona,
tools, permission rules — and run it over the CLI, an HTTP API, or both. No
chain DSL, no hidden control flow: `run-agent.ts` is a single readable
function you can step through top to bottom.

It's built on six small, independently-published packages that each solve
one piece of the agent-loop problem:

| Package | Responsibility |
|---|---|
| [`actauth`](https://www.npmjs.com/package/actauth) | Rule-based permission gating (allow/ask/deny) with human-approval hooks |
| [`contextclip`](https://www.npmjs.com/package/contextclip) | Context-window budget tracking with staged recovery |
| [`reflowkit`](https://www.npmjs.com/package/reflowkit) | Retries prompt-too-long / truncated-output failures |
| [`sessionknit`](https://www.npmjs.com/package/sessionknit) | Durable, DAG-shaped session log with crash-interruption detection |
| [`skillgarden`](https://www.npmjs.com/package/skillgarden) | `SKILL.md`-based skill discovery and lazy loading |
| [`toollane`](https://www.npmjs.com/package/toollane) | Schedules approved tool calls into parallel/solo execution lanes |

`run-agent.ts` wires the first five together — `sessionknit` sits one layer
out, in `session-store.ts`, since it persists what `run-agent.ts` produces
rather than participating in the loop itself. Everything else in this repo
— agent definitions, channel adapters — is built on top of those.

A seventh package, [`mcpplug`](https://www.npmjs.com/package/mcpplug), sits
one layer further out still: it's not part of the loop either, just a
`ToolSource` an agent's own config can draw from — `loadTools()` returns
`ToolDefinition[]`, the exact shape `AgentConfig.tools` already expects, so
its output merges straight in with no adapter code. See "External tool
gateways" below.

## Creating a new project

The fastest way to get a running agent server, in your own repo, is
[`create-loopengine`](https://www.npmjs.com/package/create-loopengine):

```bash
npx create-loopengine@latest my-agents
cd my-agents
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY
npm run dev             # HTTP server on :8787
```

That scaffolds a real, standalone project — its own `package.json`
depending on `loopengine` (not a clone of this repo), an HTTP + CLI
adapter, and one starter agent — rather than a bare library import. `npm
install loopengine` alone (below) only gets you the library; the server,
adapters, and a runnable example are deliberately not part of that
package, which is the gap `create-loopengine` fills. See
[`create-loopengine`'s own README](https://github.com/evanyan22/create-loopengine)
for what the generated project looks like.

## Using loopengine as a library

This repo is two things in one: a small library (the loop itself) and a
reference app built on top of it (demo agents, a CLI, an HTTP server). Only
the library half ships to npm:

```bash
npm install loopengine
```

`actauth`, `contextclip`, `reflowkit`, `toollane`, `skillgarden`, and the
rest are regular dependencies of `loopengine` itself — installing it alone
already pulls them into `node_modules`, fully resolvable for both imports
and TypeScript types. Install one of them directly only if you want to use
it standalone, outside `runAgent` (e.g. just `toollane`'s parallel/solo
scheduling in your own loop).

```ts
import { runAgent, type AgentConfig, type ToolDefinition } from 'loopengine'

const getWeather: ToolDefinition = {
  name: 'get_weather',
  description: 'Look up the weather for a city',
  input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
  execute: async (input) => `Sunny in ${input.city}`,
}

const config: AgentConfig = {
  name: 'weather-agent',
  systemPrompt: 'You answer questions about the weather.',
  tools: [getWeather],
  rules: [{ scopePattern: 'default/production/weather-agent', tool: 'get_weather', decision: 'allow' }],
  defaultDecision: 'ask',
}

// bring your own ModelCall, or use the one below
const result = await runAgent(config, myModelCall, "What's the weather in Boston?", [])
console.log(result.text)
```

The full exported surface: `runAgent`, `AgentConfig`/`ToolSchema`/`ToolDefinition`,
`FileSessionStore`/`RedisSessionStore`/`createSessionStore`, `VectorIndex`/
`embed`/`cosineSimilarity` (for RAG — see below), `discoverAgents` (scans a
directory for `config`/`createModelCall` modules — a flat `.ts`/`.js` file,
or a subdirectory with an `index.ts`/`index.js`, the same "a directory can
be a module" convention Node's own `require()` already uses, for an agent
whose own implementation outgrows one file, like `agents/customer-service/`
— and builds a name → entry map, keyed by `AgentConfig.name` — see
`agent-registry.ts` for the ~15-line wrapper this repo's own adapters use),
and `createAnthropicModelCall`/
`createOpenAIModelCall`/`createDeepSeekModelCall` (real, ready-to-use
`ModelCall`s). See `index.ts` for the exact list.

**Not** part of the package: `agents/*.ts` (this repo's own demo agents),
`agent-registry.ts` (this repo's own name → config lookup table, built on
`discoverAgents` — build your own the same way), `adapters/cli.ts`/
`adapters/http.ts` (one specific CLI/HTTP wiring choice, not imposed on
every consumer), and the `Dockerfile`. Everything below this point
describes that reference app — read it as a worked example of what to
build with the library, not as library API itself.

## Quick start

```bash
npm install
npx tsx agents/file-agent/index.ts        # run the file-summarizer demo agent
npx tsx agents/customer-service/index.ts  # run the customer-service demo agent (needs DEEPSEEK_API_KEY)
npx tsx agents/rag-agent.ts               # run the retrieval-augmented demo agent
```

`file-agent` and `rag-agent` still use a **simulated**, turn-counting model
call (no API key needed) — see "Wiring a real model" below.
`customer-service` is wired to a real `createDeepSeekModelCall` and needs
`DEEPSEEK_API_KEY` set in the environment.

## Defining your own agent

An agent is an `AgentConfig` (`agent-config.ts`): a name, a system prompt, a
list of tools, and ActAuth permission rules — inline, or as a path to an
`actauth.yml` file (see `agents/customer-service/actauth.yml`) in the same
shape as `examples/actauth.yml` in the actauth package itself.

There are two ways to add one under `agents/`, and `agent-registry.ts`
(built on `discoverAgents`) finds either automatically at startup — by
`AgentConfig.name`, not the filename or folder name. Nothing to edit, no
import to add, no adapter change, either way:

1. **A flat file**, `agents/<name>.ts` — the default; start here.
   `agents/rag-agent.ts` is a complete, working example.
2. **A folder**, `agents/<name>/index.ts` — for an agent whose
   implementation outgrows one file. `discoverAgents` finds a
   subdirectory's `index.ts`/`index.js` the same way it finds a flat
   file, the same "a directory can be a module" convention Node's own
   `require()` resolution already uses. `agents/customer-service/` and
   `agents/file-agent/` are complete, working examples — see below for
   what else moves under the folder once you switch.

Either way, the module must export **both** `config` and `createModelCall`
— `discoverAgents` throws at startup on a module in `agents/` that exports
only one (a real, load-bearing check: a module you forgot to finish wiring
up, or an unrelated `.ts` file that doesn't belong in `agents/` at all,
should fail loudly here rather than silently not showing up):

```ts
import type { AgentConfig } from './agent-config.js'
import type { ModelCall } from './run-agent.js'
import { createAnthropicModelCall } from './model-calls/anthropic-model-call.js'

export const config: AgentConfig = {
  name: 'my-agent',
  systemPrompt: 'You are ...',
  tools: [
    {
      name: 'do_thing',
      description: 'What the model sees when deciding to call this',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      execute: async (input) => {
        // real implementation — DB call, HTTP request, whatever
        return { ok: true }
      },
    },
  ],
  rules: [
    { scopePattern: 'default/production/my-agent', tool: 'do_thing', decision: 'allow' },
  ],
  defaultDecision: 'ask', // anything not covered by a rule requires approval
}

// A factory, not a shared instance — see "Wiring a real model" below for
// why (a stateful/simulated ModelCall needs a fresh instance per
// session; a real one like this can just return the same one every time).
export function createModelCall(): ModelCall {
  return createAnthropicModelCall({ model: 'claude-sonnet-5' }) // reads ANTHROPIC_API_KEY from the env
}
```

`agents/file-agent/index.ts` and `agents/customer-service/index.ts` are two complete, working
examples — same `runAgent` loop, entirely different personas and tools.
`agents/customer-service/` shows the folder form fully filled in:

```
agents/customer-service/
  index.ts                          AgentConfig assembly + scope resolution (tenantFor, sessionIdFor)
  actauth.yml                       ActAuth rules — which tool needs which scope/decision
  tools/
    index.ts                        Aggregates the tools below into AgentConfig.tools
    lookup_order.ts                 One file per tool
    get_shipment_details.ts
    issue_refund.ts
    send_email.ts
    orders-store.ts                 Shared in-memory store the tools above read/write
  skills/
    firecrawl/SKILL.md              One <skill-name>/SKILL.md per skill (see "Skills" below)
```

Everything specific to this one agent lives under its own folder instead of
scattered across separate top-level trees keyed only by a matching
directory name. `agents/file-agent/` follows the same shape, minus
`orders-store.ts` — its one difference is a Composio-sourced GitHub tool
that isn't in `tools/` at all, since it's fetched dynamically at runtime
rather than being static code (see "External tool gateways" below).

## Retrieval (RAG)

RAG is just another tool — the model decides when to call it, `run-agent.ts`
doesn't know or care that "executing" this particular tool means a vector
search instead of a plain HTTP call:

```ts
const searchDocs: ToolDefinition = {
  name: 'search_docs',
  description: 'Search the knowledge base for relevant passages',
  input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  execute: async (input) => {
    const hits = index.search(input.query as string, 3) // top-3 chunks
    return hits.map((h) => h.text).join('\n\n')
  },
}
```

`agents/rag-agent.ts` is a complete example, backed by `vector-index.ts` — a
small, dependency-free in-memory vector index (feature-hashing embeddings,
cosine-similarity search) good enough to prove the retrieval mechanics
end-to-end without wiring up a real embedding API. Swap `embed()` for a real
embedding model, or swap `VectorIndex` for a real vector DB client, and the
`search_docs` tool works unchanged — same "host provides the real
implementation, the package proves the pipeline" pattern as ContextClip's
`Summarizer` or ActAuth's `Approver`. The retrieved text comes back as an
ordinary tool result, subject to the same ActAuth gating, ToolLane
scheduling, and ContextClip budget tracking as any other tool call.

## External tool gateways

A hand-written tool needs an `execute` function you write yourself; an
external SaaS action (list GitHub repos, send a Slack message) needs
someone to own that vendor's auth. Connecting straight to a vendor's own
MCP server means owning its OAuth flow (authorization code, PKCE, token
storage/refresh) yourself, repeated per vendor. Routing through a gateway
like [Composio](https://composio.dev) avoids that — it already holds the
OAuth relationship with 1000+ apps — and [`mcpplug`](https://www.npmjs.com/package/mcpplug)
wraps that gateway behind the same `ToolDefinition` shape as everything
else:

```ts
import { connectComposioSource } from 'mcpplug'

// Resolved once, at module-eval time — not per runAgent() call. A gateway
// connection is exactly the kind of setup cost runAgent() shouldn't pay on
// every turn; see agents/file-agent/index.ts for the working example this is
// drawn from.
const composioTools = await connectComposioSource('composio', {
  slugs: ['GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER'],
}).then((source) => source.loadTools())

const config: AgentConfig = {
  name: 'my-agent',
  systemPrompt: 'You are ...',
  tools: [...handWrittenTools, ...composioTools],
  rules: [
    // mcpplug namespaces each tool `${sourceName}_${slug}` — falls
    // through to defaultDecision unless a rule names it explicitly.
    { scopePattern: 'default/production/my-agent', tool: 'composio_GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', decision: 'allow' },
  ],
  defaultDecision: 'ask',
}
```

Same ActAuth gating, ToolLane scheduling, and ContextClip budget tracking
as any other tool call — `runAgent` has no idea one `execute` shells out
through Composio instead of touching the filesystem or a vector index.
`agents/file-agent/index.ts` is a complete, working example, verified end-to-end
against a real linked GitHub account. `slugs` is explicit, not
auto-discovered — an agent should only see the Composio actions its own
config actually lists; find them with the `composio` CLI's
`composio tools list <toolkit>` or `composio search "<use case>"`.

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

`customerEmail` is specific to `customer-service` — it defines its own
`AgentConfig.sessionIdFor` (see "Sessions" below). Other
agents take a plain `sessionId` field instead — and it's optional: omit it
for a fresh, one-off session (a generated id, echoed back in the response
as `sessionId` so you can pass it in explicitly to continue that same
conversation on a later request):

```bash
curl -X POST localhost:8787/agents/file-agent/messages \
  -H 'content-type: application/json' \
  -d '{"message":"Summarize a.txt and b.txt into summary.txt."}'
```

`customer-service` is the exception here too — a request with no
`customerEmail` is a genuine validation error (`400`), not "start me an
anonymous session," since `customerEmail` is a real, meaningful identity
for that agent, not an arbitrary key.

`customer-service` also sets `AgentConfig.scope.tenant` to a function
(`tenantFor` — see "Multi-tenancy" below), resolving tenant
from an `x-api-key` header. The request above with no header behaves
exactly as before — `issue_refund` still asks for approval. Add a
trusted key and it doesn't:

```bash
curl -X POST localhost:8787/agents/customer-service/messages \
  -H 'content-type: application/json' -H 'x-api-key: acme-trusted-key' \
  -d '{"customerEmail":"a@example.com","message":"order A-1001 arrived broken"}'
```

**HTTP, streamed:** same request, `/stream` suffix, one Server-Sent Event per
loop step instead of a single response after the whole thing finishes —
a `session` event first (announcing whatever `sessionId` got used, generated
or not), then `contextclip:check`, `actauth:decision`, `toollane:result`,
..., a final `done` with the answer:

```bash
curl -N -X POST localhost:8787/agents/customer-service/messages/stream \
  -H 'content-type: application/json' \
  -d '{"customerEmail":"a@example.com","message":"order A-1001 arrived broken"}'
```

Both adapters are thin: they own request parsing and session persistence,
and call the same `runAgent(config, modelCall, message, history)` underneath.
`runAgent` itself does no I/O — callers own conversation history, which is
what lets it serve a one-shot CLI call and a long-lived chat session with no
code difference. The streaming route isn't a separate code path through
`runAgent` either — it forwards the same `onEvent` hook the non-streaming
route just discards, over SSE instead of into a log. What this streams is
loop *steps* (tool calls, permission decisions, budget checks), not model
output tokens — no `ModelCall` implementation here (fake or
`createAnthropicModelCall`) streams partial text from the model itself, so
there's nothing at the token level to forward yet.

## Sessions

A session is one ongoing conversation — its message history persists
between requests via a `SessionStore`, so a caller can send one message,
get a reply, and come back later and continue where it left off.

**Storage.** `SessionStore` exposes one method, `withSession(sessionId,
fn)`: it loads that session's history, runs `fn` **exclusively** for that
session (so two concurrent requests for the same conversation can't race
on read-modify-write), and appends whatever new messages `fn` produced.
History is an append-only [`sessionknit`](https://www.npmjs.com/package/sessionknit)
log rather than a flat file rewritten every turn, which buys two things:

- **Non-blocking, debounced writes** — a turn only appends, it never
  rewrites what's already durable.
- **Interruption detection** — a turn's assistant response (including any
  tool calls) is saved *before* those tools run, then the results are
  saved once they've all settled. If the process dies in between, the
  next resume sees an unanswered tool call, flags the session as
  resumed-after-interruption, and tells the model so in context — instead
  of silently replaying a half-finished turn as if it were clean.

Two implementations, same interface — `createSessionStore()` picks
between them based on `REDIS_URL` (set it and you get Redis, otherwise
the file store):

- `FileSessionStore` — one JSONL log per session under `.sessions/`,
  locked in-process. Fine for local dev and the CLI.
- `RedisSessionStore` — same log shape in a Redis list, with a real
  distributed lock (safe across multiple server instances) that renews
  itself for as long as a turn runs, instead of a flat TTL a long turn
  could outlast.

**Session keys.** Two questions decide which log a message lands in:
*which conversation* is this, and *which agent's* conversation is it?

- *Which conversation* — `AgentConfig.sessionIdFor(body)`. This is
  business logic ("what counts as one conversation" depends on what the
  agent is for), so it lives on the agent, not the adapter.
  `agents/customer-service/index.ts` hashes `customerEmail` from the
  request body into a session id, so different customers can never read
  or write each other's history, and a request with no `customerEmail` is
  rejected (`400`) rather than silently starting an anonymous session. An
  agent that doesn't define `sessionIdFor` falls back to a plain
  client-supplied `sessionId` field — or, if that's missing too, a
  generated one, returned in the response so the caller can pass it back
  in to continue that exact conversation later.
- *Which agent* — `SessionStore` itself doesn't know or care which agent
  is calling it, so both adapters prefix the id with the agent's name
  before it ever reaches `SessionStore`. Without that, two different
  agents handed the same raw session id (a client reusing one `sessionId`
  value across agents) would read and write the exact same log.

`adapters/http.ts` also folds the caller's tenant and environment into
that key (see "Multi-tenancy" below) — without that, two different
tenants whose `sessionIdFor` happens to produce the same raw id would
collide on the same log too. Verified live: the same raw `sessionId` sent
under two different tenants lands in two separate session files, not one.

## Multi-tenancy

`AgentConfig.scope` (`{ tenant, environment }`) is what feeds ActAuth's
permission rules — a support agent might allow more for a trusted
tenant, or relax approval requirements outside production. Each field is
either:

- a **plain string**, fixed for the whole deployment (environment
  usually is), or
- a **function** `(headers, body) => string | undefined`, resolved fresh
  per request (tenant often needs to be, since who's calling varies
  request to request).

Function-valued fields only ever see `headers`, never just `body` — scope
feeds permission decisions directly, so it has to come from something
verified (an `Authorization`/API-key header checked against your own
mapping), never a client-asserted body field anyone could fake to claim
another tenant's permissions. Only `adapters/http.ts` actually calls these
functions, via `resolveScope`. Two rules govern the result:

- Returning `undefined` is a real auth failure (`401`) — not "fall back
  to a default." If no header at all should mean some specific tenant
  rather than a rejection, the resolver must return that value itself.
- Omitting a field (or `scope` entirely) changes nothing: `run-agent.ts`'s
  own hardcoded `default`/`production` applies, same as before `scope`
  existed.

`run-agent.ts` never sees a request, so it can't call a function-valued
field either — the standalone/CLI paths that pass `config` to `runAgent`
directly (skipping `adapters/http.ts`'s resolution) just treat an
unresolved function as unset and fall back to the same default. Verified
live end to end: a header-derived tenant resolves to different ActAuth
rules per tenant (a specific tenant's rule overrides a wildcard
fallback), an unverifiable request is rejected outright, and the
standalone path correctly falls back to `default` rather than leaking a
function reference into the scope.

## Deployment

```bash
docker compose up --build
```

builds the HTTP adapter into a container (`Dockerfile`, multi-stage:
`npm ci` + `tsc`, then a slim runtime image) and starts it alongside a Redis
container (`docker-compose.yml`). For a real deployment, push the same
image to any container platform (Cloud Run, Fargate, Fly.io) with `REDIS_URL`
and any tool-specific secrets set as environment variables.

## Wiring a real model

`agents/file-agent/index.ts` and `agents/rag-agent.ts` still use a canned,
turn-counting `ModelCall` so the whole loop runs with no API key.
`agents/customer-service/index.ts` is already wired to a real one — a
working example of the swap, not just a snippet. To go live on the
others, swap `createModelCall` for one of the real `ModelCall`s this repo
ships — same shape, one call:

```ts
import { createAnthropicModelCall } from './model-calls/anthropic-model-call.js'
// createOpenAIModelCall / createDeepSeekModelCall work the same way

const modelCall = createAnthropicModelCall({ model: 'claude-sonnet-5' }) // reads ANTHROPIC_API_KEY
const result = await runAgent(config, modelCall, 'order A-1001 arrived broken', [])
```

| factory | env var read | example model |
| --- | --- | --- |
| `createAnthropicModelCall` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| `createOpenAIModelCall` | `OPENAI_API_KEY` | `gpt-4.1` |
| `createDeepSeekModelCall` | `DEEPSEEK_API_KEY` | `deepseek-chat` |

`model` is always required — no hardcoded default, since a flagship
model name changes too often to bake one in safely. Nothing else in
`run-agent.ts`, the adapters, or any `AgentConfig` needs to change —
`ModelCall` is the only seam a real API call needs.

`agents/customer-service/index.ts`'s `createModelCall` builds its
`createDeepSeekModelCall` instance lazily, on first call, and memoizes it,
rather than at module load — `discoverAgents()` imports every agent at
startup, so building it eagerly would crash the whole server without
`DEEPSEEK_API_KEY`, even just to run `file-agent`.

All three factories translate loopengine's `Message`/`ModelResponse` to
and from their provider's real request/response shape (verified against
the real SDKs with a stubbed `fetch`, tool calls included).
`model-calls/deepseek-model-call.ts` reuses `openai-model-call.ts`'s
translation directly rather than reimplementing it, since DeepSeek's
Chat Completions API is wire-compatible with OpenAI's.

## Skills

Agents can discover and invoke `SKILL.md` files, the same convention
production coding agents use: a short frontmatter index (`name`,
`description`) stays in context at all times, and the full body is loaded
only when the model actually invokes that skill — through a real `Skill`
tool schema (`{skill: string, args?: string}`) declared to the model
whenever `skillsDirs` is set, not just handled after the fact. Set
`skillsDirs` (an array of directory paths) on an `AgentConfig` to enable
it; omit it for agents that don't need skills (`agents/rag-agent.ts`
doesn't). `SkillGarden` discovery recursively walks every directory it's
given with **no per-agent filtering** — whatever `SKILL.md` files live
under a `skillsDirs` path, the agent sees all of them, which is the whole
reason the two kinds below live in different places.

**Agent-specific** — a skill only one agent needs, under that agent's own
folder, pointed at by only that agent's `skillsDirs`:

```
agents/customer-service/skills/
  firecrawl/SKILL.md      Only customer-service's skillsDirs points here
```

**Global** — a skill genuinely meant to be shared, at the repo-root
`skills/` (see `skills/README.md`), pointed at by every agent's
`skillsDirs` that wants it:

```
skills/
  README.md                Explains the convention; no shared skill exists yet
  (some-shared-skill)/SKILL.md   Would be seen by every agent pointed here
```

Nothing lives in the global root today — every skill this repo ships is
agent-specific. Don't point an agent at the global root *and* its own
folder unless you mean for it to see both; and don't move a skill to the
global root just because it feels reusable in theory — wait until a
second agent actually needs the exact same one.

To install one of SkillGarden's bundled skills (e.g. `firecrawl`) into an
agent-specific folder, pass `--agent` and no `--dir` — it defaults to
`agents/<agent>/skills/<skill>/SKILL.md`, matching how every skill in this
repo is actually laid out:

```bash
npx skillgarden add firecrawl --agent file-agent
# -> Added file-agent:firecrawl -> agents/file-agent/skills/firecrawl/SKILL.md
```

## Project layout

```
index.ts                    Public API surface — what actually ships to npm
agent-config.ts            AgentConfig type — the thing you fill in to define an agent
run-agent.ts                The generic ReAct loop every agent and adapter runs through
vector-index.ts             Dependency-free embeddings + cosine-similarity search, for RAG
discover-agents.ts          discoverAgents — scans a directory, builds {name -> {config, createModelCall}}
agent-registry.ts          This repo's ~15-line wrapper: discoverAgents('agents/') + listAgents()/getEntry()
session-store.ts           SessionStore: FileSessionStore, RedisSessionStore, createSessionStore()
model-calls/anthropic-model-call.ts   createAnthropicModelCall — a real ModelCall this repo ships
model-calls/openai-model-call.ts       createOpenAIModelCall — same seam, OpenAI's Chat Completions API
model-calls/deepseek-model-call.ts     createDeepSeekModelCall — same seam, reuses openai-model-call.ts's translation
agents/file-agent/index.ts               Example agent: summarizes text files
agents/file-agent/tools/                 Its hand-written tools, one file per tool
agents/file-agent/skills/                Its SKILL.md files
agents/file-agent/actauth.yml            Its ActAuth rules
agents/customer-service/index.ts         Example agent: order/shipment lookup, refund, email
agents/customer-service/tools/           Its tools, one file per tool
agents/customer-service/skills/          Its SKILL.md files
agents/customer-service/actauth.yml      Its ActAuth rules
agents/rag-agent.ts                      Example agent: retrieves from an in-memory vector index
adapters/cli.ts             Channel adapter: command line
adapters/http.ts            Channel adapter: HTTP API
tools/README.md             Root tools/ — for a tool genuinely shared across agents; empty today
skills/README.md            Root skills/ — same, for a shared SKILL.md; empty today
examples/file-agent/        Sample input files + generated output for the file-agent demo
Dockerfile, docker-compose.yml   Container build + local Redis for testing
```

Every agent's own tools/skills live under `agents/<name>/` — the root
`tools/`/`skills/` directories are reserved for something genuinely meant
to be shared across every agent that opts in, which doesn't exist in this
repo yet (see each directory's own `README.md`).
