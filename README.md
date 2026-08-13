# LoopEngine

A minimal framework for defining and running tool-using AI agents. Write an
agent as a plain config object — persona, tools, permission rules — and run
it through one generic ReAct loop over the CLI, an HTTP API, or both. No
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

## Using loopengine as a library

This repo is two things in one: a small library (the loop itself) and a
reference app built on top of it (demo agents, a CLI, an HTTP server). Only
the library half ships to npm:

```bash
npm install loopengine actauth contextclip reflowkit toollane skillgarden
```

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
`embed`/`cosineSimilarity` (for RAG — see below), and `createAnthropicModelCall`
(a real, ready-to-use `ModelCall`). See `index.ts` for the exact list.

**Not** part of the package: `agents/*.ts` (this repo's own demo agents),
`agent-registry.ts` (this repo's own name → config lookup table — build your
own, same one-line-per-agent shape), `adapters/cli.ts`/`adapters/http.ts`
(one specific CLI/HTTP wiring choice, not imposed on every consumer), and
the `Dockerfile`. Everything below this point describes that reference app —
read it as a worked example of what to build with the library, not as
library API itself.

## Quick start

```bash
npm install
npx tsx agents/file-agent.ts             # run the file-summarizer demo agent
npx tsx agents/customer-service-agent.ts # run the customer-service demo agent
npx tsx agents/rag-agent.ts              # run the retrieval-augmented demo agent
```

All demo agents use a **simulated** model call (no `ANTHROPIC_API_KEY` is
wired up) — see "Wiring a real model" below.

## Defining your own agent

An agent is an `AgentConfig` (`agent-config.ts`): a name, a system prompt, a
list of tools, and ActAuth permission rules.

```ts
import type { AgentConfig } from './agent-config.js'

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
```

`agents/file-agent.ts` and `agents/customer-service-agent.ts` are two complete, working
examples — same `runAgent` loop, entirely different personas and tools.

To make a new agent runnable through the adapters, add one line to
`agent-registry.ts` mapping its name to its `config` and a `createModelCall`
factory.

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
// every turn; see agents/file-agent.ts for the working example this is
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
`agents/file-agent.ts` is a complete, working example, verified end-to-end
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
  -d '{"sessionId":"s1","message":"Summarize a.txt and b.txt into summary.txt."}'
```

`customer-service` is the exception here too — a request with no
`customerEmail` is a genuine validation error (`400`), not "start me an
anonymous session," since `customerEmail` is a real, meaningful identity
for that agent, not an arbitrary key.

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
`customer-service-agent.ts` defines its own, hashing `customerEmail` so raw
addresses never end up in storage keys — different customers can never
read or write each other's history, and concurrent messages from the same
customer are serialized rather than dropped. A missing `customerEmail` is a
real validation failure for that agent (`400`), not something to paper over.

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
namespace the *actual* key by agent name before it ever reaches
`SessionStore`: `` `${agentName}:${sessionIdFor(...)}` `` in
`adapters/http.ts`, `` `${agent}:${session}` `` in `adapters/cli.ts`.
Without that, two different agents given the same session identifier (a
client reusing one `sessionId`/`--session` value across agents, most
likely) would read and write the exact same underlying log — one agent's
tool calls and results spliced straight into another's conversation as if
it had always been there.

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

Every example agent (`agents/file-agent.ts`, `agents/customer-service-agent.ts`,
`agents/rag-agent.ts`) still uses a canned, turn-counting `ModelCall` so the
whole loop is runnable and testable with no API key. To go live, swap it
for `createAnthropicModelCall` (`anthropic-model-call.ts`), the one real
`ModelCall` implementation this repo ships:

```ts
import { createAnthropicModelCall } from './anthropic-model-call.js'

const modelCall = createAnthropicModelCall({ model: 'claude-sonnet-5' }) // reads ANTHROPIC_API_KEY from the env

const result = await runAgent(config, modelCall, 'order A-1001 arrived broken', [])
```

Nothing else in `run-agent.ts`, the adapters, or any `AgentConfig` needs to
change — `ModelCall` is the only seam a real API call needs.

loopengine's own `Message` type carries real block-native history: `content`
is either a plain string or a `ModelContentBlock[]` — the same shape
`ModelResponse.content` already used — so a model's `tool_use` requests and
this loop's `tool_result` replies round-trip with real per-call identity
(`tool_use_id`) rather than being flattened into prose. That's what makes
parallel tool calls unambiguous (a result links back to the exact call that
requested it, not just "a call to this tool name") and lets a denied or
failed call carry `is_error: true`, which Claude is specifically trained to
react to. `anthropic-model-call.ts` translates directly to and from
Anthropic's native `TextBlockParam`/`ToolUseBlockParam`/`ToolResultBlockParam`
types — no flattening step in between. This was verified against the real
SDK (with a stubbed `fetch`, not a live call) — request shape, tool schemas,
and response mapping all round-trip correctly end to end.

One real gap worth knowing: `ContextClip`'s overflow recovery (drain, then
summarize) only ever shrinks the message array for the *one* retried model
call inside `Reflow` — the `messages` array `runAgent` keeps building on and
eventually returns as `history` is never itself replaced with the recovered,
smaller version. In a long-running session that keeps crossing the hard
threshold, recovery papers over each individual oversized call without ever
durably compacting what gets stored or resent next turn.

## Skills

Agents can discover and invoke `SKILL.md` files (see `skills/`), the same
convention production coding agents use: a short frontmatter index (`name`,
`description`) stays in context at all times, and the full body is loaded
only when the model actually invokes that skill — through a real `Skill`
tool schema (`{skill: string, args?: string}`) declared to the model
whenever `skillsDirs` is set, not just handled after the fact. Set
`skillsDirs` on an `AgentConfig` to enable it; omit it for agents that
don't need skills (`agents/customer-service-agent.ts` doesn't).

Point `skillsDirs` at a subdirectory scoped to that agent
(`skills/file-agent/`, not the shared `skills/` root) — `SkillGarden`'s
discovery recursively walks whatever root it's given with no per-agent
filtering, so two agents both pointed at `skills/` would each see every
skill under it, not just their own.

## Project layout

```
index.ts                    Public API surface — what actually ships to npm
agent-config.ts            AgentConfig type — the thing you fill in to define an agent
run-agent.ts                The generic ReAct loop every agent and adapter runs through
vector-index.ts             Dependency-free embeddings + cosine-similarity search, for RAG
agent-registry.ts          Maps agent name -> {config, createModelCall}
session-store.ts           SessionStore: FileSessionStore, RedisSessionStore, createSessionStore()
anthropic-model-call.ts    createAnthropicModelCall — the one real ModelCall this repo ships
agents/file-agent.ts               Example agent: summarizes text files
agents/customer-service-agent.ts  Example agent: order/shipment lookup, refund, email
agents/rag-agent.ts                Example agent: retrieves from an in-memory vector index
adapters/cli.ts             Channel adapter: command line
adapters/http.ts            Channel adapter: HTTP API
skills/                     SKILL.md files discoverable by agents, scoped per agent subdirectory
examples/file-agent/        Sample input files + generated output for the file-agent demo
Dockerfile, docker-compose.yml   Container build + local Redis for testing
```
