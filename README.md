# loopengine

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

## Quick start

```bash
npm install
npx tsx file-agent.ts             # run the file-summarizer demo agent
npx tsx customer-service-agent.ts # run the customer-service demo agent
```

Both demo agents use a **simulated** model call (no `ANTHROPIC_API_KEY` is
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

`file-agent.ts` and `customer-service-agent.ts` are two complete, working
examples — same `runAgent` loop, entirely different personas and tools.

To make a new agent runnable through the adapters, add one line to
`agent-registry.ts` mapping its name to its `config` and a `createModelCall`
factory.

## Connecting MCP tools

A tool doesn't have to be hand-written — `AgentConfig.mcpServers` connects to
a real MCP server and turns everything it exposes into ordinary tools, with
the same ActAuth gating and ToolLane scheduling as `do_thing` above:

```ts
export const config: AgentConfig = {
  name: 'my-mcp-agent',
  systemPrompt: 'You are ...',
  mcpServers: [
    { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/some/dir'] },
  ],
  rules: [
    { scopePattern: 'default/production/my-mcp-agent', tool: 'read_text_file', decision: 'allow' },
  ],
  defaultDecision: 'ask', // any tool the server exposes that you didn't write a rule for
}
```

`mcp-filesystem-agent.ts` is a complete example — it has zero hand-written
tools; every one comes from the official
`@modelcontextprotocol/server-filesystem`, spawned as a real subprocess.
`load-agent.ts` is what resolves `mcpServers` into real tools: it runs for
every agent (a no-op if `mcpServers` is absent), which is what makes this a
config change rather than a bespoke loader function per server — write rules
for the tool names you expect the server to expose (check its docs, or
connect once and call `listTools()` yourself), the same way you'd write
rules for a hand-written tool. Anything the server exposes that you didn't
write a rule for still safely falls through to `defaultDecision`.

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

**HTTP, streamed:** same request, `/stream` suffix, one Server-Sent Event per
loop step instead of a single response after the whole thing finishes —
`contextclip:check`, `actauth:decision`, `toollane:result`, ..., a final
`done` with the answer:

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
- **Interruption detection.** `run-agent.ts` pushes one
  `[requested: tool_a, tool_b]` message before any tool runs, then one
  `[... result]` message per completed tool as they finish. If the process
  dies in that window, the next `resume()` sees a request with no result
  behind it, flags the session as resumed-after-interruption, and injects a
  note into context saying so — instead of silently resending an
  incomplete turn as if it were clean.

Two implementations, same `SessionStore` interface:

- `FileSessionStore` — one JSONL entry log per session under `.sessions/`,
  locked in-process. Fine for local dev and the CLI.
- `RedisSessionStore` — same log shape (a Redis list of entries, one
  `RPUSH` per append), with a real distributed lock, safe across multiple
  server instances.

`createSessionStore()` picks between them based on `REDIS_URL` — set it and
you get Redis, otherwise it falls back to the file store. Either way,
turn-level exclusivity (no two concurrent turns for the same session
interleaving) is still this module's job, not SessionKnit's — SessionKnit's
own topology repair handles branching *within* one resumed chain (parallel
tool calls, crash recovery), not races between two full concurrent turns.

The HTTP adapter derives the session key from `customerEmail` (hashed, so
raw emails never end up in storage keys), so different customers can never
read or write each other's history, and concurrent messages from the same
customer are serialized rather than dropped.

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

Every example agent (`file-agent.ts`, `customer-service-agent.ts`,
`mcp-filesystem-agent.ts`) still uses a canned, turn-counting `ModelCall` so
the whole loop is runnable and testable with no API key. To go live, swap it
for `createAnthropicModelCall` (`anthropic-model-call.ts`), the one real
`ModelCall` implementation this repo ships:

```ts
import { createAnthropicModelCall } from './anthropic-model-call.js'

const modelCall = createAnthropicModelCall({ model: 'claude-sonnet-5' }) // reads ANTHROPIC_API_KEY from the env

const result = await runAgent(config, modelCall, 'order A-1001 arrived broken', [])
```

Nothing else in `run-agent.ts`, the adapters, or any `AgentConfig` needs to
change — `ModelCall` is the only seam a real API call needs.

One tradeoff worth knowing: loopengine's `Message` type (from `contextclip`)
is deliberately generic — `{role, content: string}` — so conversation
history round-trips to the API as plain user/assistant text turns, not
Anthropic's native `tool_use`/`tool_result` content blocks. Claude reads
`"[lookup_order result] {...}"` as plain text just fine and the conversation
still works correctly, but it's not the structured, block-native history the
API is built around. This was verified against the real SDK (with a stubbed
`fetch`, not a live call) — request shape, tool schemas, and response
mapping all round-trip correctly end to end.

## Skills

Agents can discover and invoke `SKILL.md` files (see `skills/`), the same
convention production coding agents use: a short frontmatter index (`name`,
`description`) stays in context at all times, and the full body is loaded
only when the model actually invokes that skill. Set `skillsDirs` on an
`AgentConfig` to enable it; omit it for agents that don't need skills
(`customer-service-agent.ts` doesn't).

## Project layout

```
agent-config.ts            AgentConfig type — the thing you fill in to define an agent
run-agent.ts                The generic ReAct loop every agent and adapter runs through
load-agent.ts               Resolves AgentConfig.mcpServers into real tools (no-op without it)
mcp-tools.ts                 Wraps one MCP server's tools as ToolDefinition[]
agent-registry.ts          Maps agent name -> {config, createModelCall}, via load-agent.ts
session-store.ts           SessionStore: FileSessionStore, RedisSessionStore, createSessionStore()
anthropic-model-call.ts    createAnthropicModelCall — the one real ModelCall this repo ships
file-agent.ts               Example agent: summarizes text files
customer-service-agent.ts  Example agent: order lookup / refund / email
mcp-filesystem-agent.ts    Example agent: every tool comes from a real MCP server, zero hand-written
adapters/cli.ts             Channel adapter: command line
adapters/http.ts            Channel adapter: HTTP API
skills/                     SKILL.md files discoverable by agents
Dockerfile, docker-compose.yml   Container build + local Redis for testing
```
