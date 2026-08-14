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

`agents/customer-service/tools/` is the pattern for splitting tool
implementations out once there are enough of them to matter — one file
per tool, an `index.ts` aggregating them into the array `AgentConfig.tools`
expects. `agents/customer-service/skills/` sits alongside it the same
way, and so does `agents/customer-service/actauth.yml` — everything
specific to one agent lives under that agent's own folder, not scattered
across separate top-level trees connected only by a matching directory
name (which nothing enforces staying in sync — rename the agent folder
and forget to rename a sibling tree, and things break silently). A
permission story with per-tenant/environment scoping and `when`
conditions reads better as the `actauth.yml` data it actually is than as
a TypeScript array literal, which is why it's split out unlike scope
resolution and the `AgentConfig` assembly — those stay in the agent's own
`index.ts` since they're tied to request-handling code (`tenantFor`,
`sessionIdFor`) that has no data-file equivalent. `agents/file-agent/`
follows the same shape — the one exception is its Composio-sourced GitHub
tool, which isn't in `tools/` at all: it's fetched dynamically at runtime
(see "External tool gateways" below), not static code with a file of its
own to live in.

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
`AgentConfig.sessionIdFor` (see "Sessions and multi-tenancy" below). Other
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
(`tenantFor` — see "Sessions and multi-tenancy" below), resolving tenant
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

## Sessions and multi-tenancy

`session-store.ts` exposes one method, `withSession(sessionId, fn)`, that
resumes history, runs `fn` **exclusively** for that session, and appends
whatever new messages `fn` produced — this is what stops two concurrent
requests for the same conversation from racing on read-modify-write.

History itself is a [`sessionknit`](https://www.npmjs.com/package/sessionknit)
log, not a flat file rewritten whole on every turn: each message is one
entry in an append-only, parent-linked chain, so a turn only ever appends,
never rewrites what's already durable. That buys two things a flat
rewrite can't:

- **Non-blocking, debounced writes** instead of a full read-modify-write of
  the entire session every turn.
- **Interruption detection.** `run-agent.ts` pushes the assistant's full
  response — tool_use blocks included — as one message before any tool
  runs, then one message bundling every tool_result once they've all
  settled. If the process dies in that window, the next `resume()` sees an
  assistant message with an unanswered tool_use block, flags the session
  as resumed-after-interruption, and injects a note into context saying so
  — instead of silently resending an incomplete turn as if it were clean.

Two implementations, same `SessionStore` interface:

- `FileSessionStore` — one JSONL entry log per session under `.sessions/`,
  locked in-process. Fine for local dev and the CLI.
- `RedisSessionStore` — same log shape (a Redis list of entries, one
  `RPUSH` per append), with a real distributed lock, safe across multiple
  server instances. The lock renews itself (`lockTtlMs / 3` by default)
  for as long as a turn runs, instead of a flat TTL that a long turn (a
  real model call plus several tool round-trips) could outlast — if
  renewal ever confirms the lock was lost anyway (not just a failed
  renewal attempt — a network blip there isn't proof of loss), the turn's
  result is rejected rather than silently returned as if mutual exclusion
  held the whole time.

`createSessionStore()` picks between them based on `REDIS_URL` — set it and
you get Redis, otherwise it falls back to the file store. Either way,
turn-level exclusivity (no two concurrent turns for the same session
interleaving) is still this module's job, not SessionKnit's — SessionKnit's
own topology repair (reattaching sibling branches under a shared
`parentId`) is a defensive read-side repair for crash/corruption recovery,
not something normal operation exercises. `run-agent.ts` bundles a whole
turn's `tool_use`/`tool_result` blocks into one message each, and
`withSession` appends new messages sequentially, so even a turn with
several parallel tool calls only ever produces a linear chain in the
durable log — not races between two full concurrent turns, which is what
the lock above actually prevents.

Session-key derivation is `AgentConfig.sessionIdFor(body)` — deliberately
not the HTTP adapter's call, since what counts as "one conversation" is
business logic specific to what the agent is for, not a transport concern.
`customer-service/index.ts` defines its own, hashing `customerEmail` so raw
addresses never end up in storage keys — different customers can never
read or write each other's history, and concurrent messages from the same
customer are serialized rather than dropped. A missing `customerEmail` is a
real validation failure for that agent (`400`), not something to paper
over. `customerEmail` is still only ever client-asserted, though, not
verified — anyone can send someone else's email and get routed into that
person's existing session. Closing that for real means deriving the
session identity from something verified instead (an auth header, not a
body field), which would need `sessionIdFor` to see headers too — a real,
known gap, deliberately not built yet, since nothing in this repo has a
concrete use for it and the shape it should take isn't obvious without one
(see `AgentConfig.scope` below for the equivalent capability where a real
consumer *does* exist today).

An agent that doesn't define `sessionIdFor` falls back to a plain
client-supplied `sessionId` field (`adapters/http.ts`'s
`defaultSessionIdFor`) — the same shape `adapters/cli.ts`'s `--session`
flag already uses — and if that's missing too, one gets generated rather
than the request being rejected, mirroring what omitting `--session` now
does for the CLI: a fresh, isolated, one-off session rather than an error
or (worse) a shared bucket every untagged caller collides into. The
generated id comes back in the response (`sessionId` in the JSON body, a
`session` SSE event first for the streamed route) so a caller that wants to
continue that exact conversation can pass it in explicitly next time.

`SessionStore` itself is agent-agnostic — nothing in `session-store.ts` or
`sessionknit` knows which agent is calling `withSession`, so both adapters
namespace the *actual* key before it ever reaches `SessionStore`:
`` `${tenant}:${environment}:${agentName}:${sessionIdFor(...)}` `` in
`adapters/http.ts`, `` `${agent}:${session}` `` in `adapters/cli.ts` (no
tenant/environment dimension — `adapters/cli.ts` never resolves scope at
all). Without agent-namespacing, two different agents given the same
session identifier (a client reusing one `sessionId`/`--session` value
across agents, most likely) would read and write the exact same
underlying log — one agent's tool calls and results spliced straight into
another's conversation as if it had always been there.

`AgentConfig.scope` fields (`tenant`/`environment`) are the same idea one
level over — but each field can independently be a plain string *or* a
function resolving it per request from headers/body, with one deliberate
difference from `sessionIdFor`: function values receive headers, not just
the body. Scope feeds directly into permission decisions, so it has to
come from something verified (an `Authorization`/API-key header checked
against your own tenant mapping), never a raw client-asserted body field —
a `sessionIdFor`-style body field is fine for "which conversation," but
trusting it for "which tenant" would let any caller claim to be any
tenant and inherit that tenant's rules. `adapters/http.ts`'s
`resolveScope` calls any function-valued field with `(headers, body)`;
a plain-string field (environment, usually) passes through untouched.
A resolver returning `undefined` is a real auth failure (`401`), not
"fall back to defaults" — the same asymmetry `sessionIdFor` already has
for a missing `customerEmail`; if "no header at all" should mean some
specific default rather than a rejection, the resolver itself has to
return that value explicitly. Omit a field (or `scope` entirely) and
nothing changes: `run-agent.ts`'s own hardcoded `default`/`production`
applies, exactly as before this existed. `run-agent.ts` itself never sees
a request, so it can't resolve a function value either — it treats one as
unset and falls back to its own default, which matters for the
standalone/CLI paths that pass `config` to `runAgent` directly, skipping
`adapters/http.ts`'s resolution entirely (confirmed live:
`customer-service/index.ts`'s own `if (import.meta.url === ...)` block
resolves to the plain `default` tenant, not a leaked function reference).
Verified live end to end otherwise: a header-derived tenant correctly
resolves to different ActAuth rules per tenant (specific overrides a
wildcard fallback, same specificity resolution `scopePattern` always
had), and an unverifiable request is rejected outright rather than
silently proceeding under default rules.

`adapters/http.ts` also folds the resolved tenant and environment into
the `SessionStore` key, read from `config.scope` *after* `resolveScope`
has run (falling back to `'default'`/`'production'`, the same defaults
`run-agent.ts` itself uses, for whichever field wasn't set). Without
this, two different tenants — or two different environments — whose
`sessionIdFor` happens to produce the same raw id would collide on the
exact same underlying log, splicing one's conversation into the other's —
verified live: the same raw `sessionId` sent under two different
verified tenants lands in two genuinely separate session files, not one.

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
turn-counting `ModelCall` so the whole loop is runnable and testable with no
API key. `agents/customer-service/index.ts` is already wired to a real one
(see below) — a working example of the swap, not just a snippet. To go live
on the others, swap their `createModelCall` for one of the real `ModelCall`
implementations this repo ships:

```ts
import { createAnthropicModelCall } from './model-calls/anthropic-model-call.js'

const modelCall = createAnthropicModelCall({ model: 'claude-sonnet-5' }) // reads ANTHROPIC_API_KEY from the env

const result = await runAgent(config, modelCall, 'order A-1001 arrived broken', [])
```

```ts
import { createOpenAIModelCall } from './model-calls/openai-model-call.js'

// model is required (no built-in default) — OpenAI's current flagship
// name changes too often to hardcode safely; reads OPENAI_API_KEY from the env
const modelCall = createOpenAIModelCall({ model: 'gpt-4.1' })

const result = await runAgent(config, modelCall, 'order A-1001 arrived broken', [])
```

```ts
import { createDeepSeekModelCall } from './model-calls/deepseek-model-call.js'

// model is required, same reasoning as OpenAI's; reads DEEPSEEK_API_KEY
// from the env — throws immediately, with a DeepSeek-specific message, if
// neither that nor apiKey is set, rather than the OpenAI SDK's own
// constructor silently accepting OPENAI_API_KEY instead.
const modelCall = createDeepSeekModelCall({ model: 'deepseek-chat' })

const result = await runAgent(config, modelCall, 'order A-1001 arrived broken', [])
```

Nothing else in `run-agent.ts`, the adapters, or any `AgentConfig` needs to
change — `ModelCall` is the only seam a real API call needs.

`agents/customer-service/index.ts`'s own `createModelCall` builds its
`createDeepSeekModelCall` instance lazily, on first call, and memoizes it —
not once at module-eval time the way `agents/file-agent/index.ts`'s
Composio connection is built. `agent-registry.ts`'s `discoverAgents()`
imports every agent module at startup, for every agent, not just this
one; building the DeepSeek client eagerly would mean the whole server
fails to start whenever `DEEPSEEK_API_KEY` isn't set, even just to run
`file-agent`. Memoizing after first use (rather than a fresh instance per
call) is safe here specifically because the returned `ModelCall` is a
pure function of the messages you pass it — reusable across every
session/request, unlike the stateful simulated ones (which count their
own turns and need a fresh instance per session) every other demo agent
still returns from its own `createModelCall`.

loopengine's own `Message` type carries real block-native history: `content`
is either a plain string or a `ModelContentBlock[]` — the same shape
`ModelResponse.content` already used — so a model's `tool_use` requests and
this loop's `tool_result` replies round-trip with real per-call identity
(`tool_use_id`) rather than being flattened into prose. That's what makes
parallel tool calls unambiguous (a result links back to the exact call that
requested it, not just "a call to this tool name") and lets a denied or
failed call carry `is_error: true`, which Claude is specifically trained to
react to. `model-calls/anthropic-model-call.ts` translates directly to and from
Anthropic's native `TextBlockParam`/`ToolUseBlockParam`/`ToolResultBlockParam`
types — no flattening step in between. This was verified against the real
SDK (with a stubbed `fetch`, not a live call) — request shape, tool schemas,
and response mapping all round-trip correctly end to end.

`model-calls/openai-model-call.ts` translates to and from OpenAI's Chat Completions
shape instead, verified the same way (stubbed `fetch`, real SDK, full
`runAgent` round trip including a tool call). The one structural mismatch:
loopengine bundles a whole turn's `tool_result` blocks into a single
user-role message (mirroring Anthropic's shape); OpenAI has no equivalent —
each becomes its own top-level `role: 'tool'` message, so one loopengine
`Message` can expand into several OpenAI messages, never the reverse.

`model-calls/deepseek-model-call.ts` reuses `openai-model-call.ts`'s translation
verbatim (exported, not duplicated) rather than reimplementing it —
DeepSeek's Chat Completions API is wire-compatible with OpenAI's (verified
against DeepSeek's own docs), down to the same `tool_calls` response
shape. The one real difference: DeepSeek documents `max_tokens`, not the
newer `max_completion_tokens` OpenAI's endpoint expects, so only the
request-building call site differs, not the shared message/response
translation functions.

## Skills

Agents can discover and invoke `SKILL.md` files (see
`agents/file-agent/skills/`, `agents/customer-service/skills/`), the same
convention production coding agents use: a short frontmatter index (`name`,
`description`) stays in context at all times, and the full body is loaded
only when the model actually invokes that skill — through a real `Skill`
tool schema (`{skill: string, args?: string}`) declared to the model
whenever `skillsDirs` is set, not just handled after the fact. Set
`skillsDirs` on an `AgentConfig` to enable it; omit it for agents that
don't need skills (`agents/rag-agent.ts` doesn't).

Point `skillsDirs` at a subdirectory scoped to that agent — a top-level
shared `skills/` root, with every agent pointed at it, would mean
`SkillGarden`'s discovery (which recursively walks whatever root it's
given, with no per-agent filtering) hands each agent every other agent's
skills too, not just its own. Nesting under that agent's own
`agents/<name>/skills/` is what keeps that from happening. The top-level
`skills/` root that remains (see `skills/README.md`) is reserved for a
skill genuinely meant to be shared across every agent that opts in, which
doesn't exist in this repo today — nothing here is actually shared, per
every skill/tool this repo ships.

To install one of SkillGarden's bundled skills (e.g. `firecrawl`), its
`add` CLI always writes to `<dir>/<agent>/<skill>/SKILL.md` — `<dir>`
defaults to `skills/`, predating this repo's own move to nesting
everything under `agents/<name>/`. Pointing `--dir` at
`agents/file-agent/skills` doesn't produce the clean flat result you
might expect, because the tool still appends `<agent>/<skill>` on top of
whatever `--dir` you give it:

```bash
npx skillgarden add firecrawl --agent file-agent --dir agents/file-agent/skills
# -> Added file-agent:firecrawl -> agents/file-agent/skills/file-agent/firecrawl/SKILL.md
```

That's a real, redundant extra `file-agent/` segment (verified — this
isn't hypothetical), since the CLI has no way to know this repo already
folded the agent name into `--dir`. Move the result up one level after
running it — `mv agents/file-agent/skills/file-agent/firecrawl agents/file-agent/skills/firecrawl && rmdir agents/file-agent/skills/file-agent` —
to match how every other skill in this repo is actually laid out, or just
create `SKILL.md` by hand at the flat path directly, which is all the
`add` CLI does anyway (copy one bundled file, no other side effects).

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
