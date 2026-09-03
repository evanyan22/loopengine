# LoopEngine

[![CI](https://github.com/evanyan22/loopengine/actions/workflows/ci.yml/badge.svg)](https://github.com/evanyan22/loopengine/actions/workflows/ci.yml)

LoopEngine is a runtime for building AI agents: a persona, a set of tools,
and permission rules, run through a transparent ReAct loop. No chain DSL,
no hidden control flow — `core/run-agent.ts` is a single function you can read
top to bottom. Run agents over a CLI, an HTTP API, or both.

Once you define an agent, the loop turns it into something you can put in
front of real users or real systems:

- **Callable over CLI or HTTP** — a script you run locally, or a real
  service other apps can hit.
- **Does real work, safely** — tools can hit a database, send emails, call
  GitHub/Slack, anything with an `execute` function. Permission rules gate
  what happens without a human: safe reads auto-run, risky actions (a
  refund, a send) get approval or are denied outright, so you can wire up
  powerful tools without trusting the model blindly.
- **Remembers** — conversations persist across requests, so a caller can
  send one message, get a reply, and continue later.
- **Multi-tenant out of the box** — the same deployed agent can serve
  different customers/orgs with different permission levels, with no
  forking required.
- **Composable into bigger agents** — drop one agent's folder under
  another's `subagents/` and it becomes a tool the parent can delegate
  to, own tools/rules/loop intact. No chain DSL for orchestration either:
  the parent's model just decides when to call it, like any other tool.

So the payoff: you write one `AgentConfig`, and get a deployable,
persistent, permission-safe service — not just a prompt-and-response demo.

## Quick start

```bash
npx create-loopengine@latest my-agents
cd my-agents
npm install
cp .env.example .env   # fill in ANTHROPIC_API_KEY
npm run dev             # HTTP server on :8787 — same as `npx loopengine dev`
```

This scaffolds a standalone project — its own repo, with `loopengine` as
a dependency, a starter agent, and CLI + HTTP adapters already wired up.
That's the intended way to use LoopEngine: an independent project you own
and build agents in, not a library you import into an existing app.

### Define your first agent

```bash
npx loopengine add-agent weather-agent
# -> Created agents/weather-agent/index.ts
```

That's the fastest way to start: it generates `agents/<name>/index.ts`
with a working `AgentConfig` stub, so you don't have to memorize the
folder shape by hand. Or write it yourself — an agent is just an
`AgentConfig`: `name`, `systemPrompt`, `tools`, `rules`, and a `model`.
Drop it in a folder under `agents/` — `agents/<name>/index.ts` — and it's
picked up automatically, no registry to edit, no import to add.

Most fields don't even need to be written out — they default to a
conventional path under the agent's own folder:

| Field | Defaults to |
| --- | --- |
| `rules` | `agents/<name>/actauth.yml` (missing → deny everything) |
| `tools` | `agents/<name>/tools/index.ts`'s exported `tools` (missing → no tools) |
| `skillsDirs` | `agents/<name>/skills` (missing → no skills) |

There's no `subagents` field to omit — `agents/<name>/subagents/*` is its
own folder convention, always merged into `tools` on top of whatever the
table above resolves to. See "Subagents" below.

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

`core/run-agent.ts` is the whole engine — a single, readable ReAct loop with no
hidden control flow: call the model, act on what it asks for, repeat.

1. Call the model with the conversation so far.
2. If it responds with tool calls, each one is checked against
   `AgentConfig.rules` — allowed calls run, denied calls are refused,
   "ask" calls go to whatever approver applies for the call's own channel
   (see "Tool permission and multi-tenancy" below) — a live approver is
   awaited right there; a durable one returns instantly and the call is
   resolved later instead.
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

### 4. Subagents — an agent as another agent's tool

Drop a folder under `agents/<name>/subagents/<child>/` and `child` becomes
one of `name`'s tools automatically — no import, no `AgentConfig.tools`
edit, nothing to register by hand:

```
agents/support-orchestrator/
  index.ts                        # the orchestrator's own AgentConfig
  subagents/
    billing-agent/index.ts        # a full AgentConfig, same shape as a top-level agent
    refunds-agent/index.ts
```

Scaffold one directly:

```bash
npx loopengine add-subagent support-orchestrator billing-agent
# -> Created agents/support-orchestrator/subagents/billing-agent/index.ts
```

A subagent is a normal `AgentConfig` plus one required field —
`toolDescription`, the text the *parent's* model reads to decide when to
delegate to it (its own `systemPrompt` is instructions for itself, not a
pitch to a caller deciding whether to invoke it):

```ts
export const config: AgentConfig = {
  name: 'billing-agent',
  systemPrompt: 'You answer billing questions.',
  toolDescription: 'Call this for any billing-related question.',
  model: { provider: 'anthropic', model: 'claude-sonnet-5' },
}
```

Calling that tool runs the subagent's whole ReAct loop — its own tools,
rules, permissions — to completion, and only its final text comes back;
the parent never sees the subagent's turns or tool calls. Orchestration
needs no separate concept on top of this: an "orchestrator" is just an
agent whose tools happen to be other agents, and the model decides which
to call, in what order, the same as any other tool — no chain DSL.

Subagents nest — a subagent's own `subagents/` folder works the same way,
one level down, addressed by joining names with `/`:

```bash
npx loopengine add-subagent support-orchestrator/billing-agent disputes-agent
```

A few things worth knowing before reaching for this:

- **The call blocks.** Every tool call in the loop is awaited before the
  next model turn, so a slow subagent blocks its parent's turn — and if
  the parent is itself a subagent of another agent, that blocks too.
  There's no background/async or streaming pattern here.
- **Permissions don't inherit.** Each agent's own `actauth.yml` governs
  only its own tools; delegating to a subagent neither grants nor
  inherits permissions in either direction.
- **`maxTurns` compounds.** A request that reaches a grandchild subagent
  spends turns at every level (default 25 each) — a "simple" answer can
  cost far more than any one agent's own turn budget suggests.

### 5. Gateway tool sources — connecting external tools from a web page

Beyond hand-written tools and subagents, an agent can pull tools from an
external gateway — [Composio](https://composio.dev) today, with
[`mcpplug`](https://www.npmjs.com/package/mcpplug)'s `ToolSource`
interface designed so more providers (Nango, Arcade, Scalekit, ...) slot
in later as thin adapters, same shape. Unlike hand-written tools, these
are meant to be managed by an operator at runtime, not committed to code:
run the HTTP adapter, open `/agents/config`, pick an agent, and switch to
its "Gateway tools" tab — alongside "Overview" and "Actauth" — to see its
connected sources and add or remove one.

```bash
npx tsx --env-file-if-exists=.env adapters/http.ts
# open http://localhost:8787/agents/config
```

Adding a source (via the page, or `POST /agents/:name/gateway-tools` with
`{ provider: 'composio', name: 'gh', slugs: [...] }`) writes
`agents/<name>/gateway-tools.yml` — read fresh off disk on every request,
same "no restart to see an edit" behavior `actauth.yml` already has.
Composio's own OAuth is out of band: run `composio link <toolkit>` once
on the machine running the server, then use the page purely to pick which
already-authorized slugs to expose to which agent.

A newly-added tool is **denied by default**, same "opt-in, not silently
allowed" rule every tool in this repo follows — pass a `decision` when
adding a source (or use the page's permission dropdown) to seed an
`actauth.yml` rule for it instead, or add the rule by hand afterward.

### 6. Tool permission and multi-tenancy

Every tool call is gated by [`actauth`](https://www.npmjs.com/package/actauth):
each rule in `AgentConfig.rules` maps a `scope` (tenant/environment) + tool
name to `allow` / `ask` / `deny`. Anything not covered falls through to
`defaultDecision`. An `ask` decision routes to whichever approver applies
for the call's own channel: `cli`/`http_stream` always get the library's
own live default (`ConsoleApprover`, blocking on stdin, for `cli`; a live
approval popup for `http_stream`) — nothing to configure there — and
`http` gets a durable one whenever `AgentConfig.httpNotifier` is
configured for it (see below), falling back to the same kind of live
default otherwise.

`ask` approvers come in two shapes. A **live** one (`WebchatApprover`,
`SlackChatApprover`, `ConsoleApprover`) is awaited directly — the turn stays
suspended until a human decides, which only makes sense when someone's
actually there right now (a terminal, an open chat connection). A
**durable** one (`WebhookApprover`) fires a signed webhook and returns
instantly instead — the turn ends with `stopReason: 'pending_approval'`,
durably resumable minutes or days later via
`POST /pending-approvals/:pendingId/resolve`, without holding any
process open in between. See `HUMAN_IN_THE_LOOP.md` for the full design.

The system `ask_user` tool (a model asking a human a genuinely ambiguous
clarifying question mid-turn) gets the same live/durable split, via
`RunAgentOptions.questionHandler` (or `AgentConfig.httpNotifier`'s own
`'question'` event, for the `http` channel specifically): live by default
(blocks on the channel it's raised on), or durable — a
`DurableQuestionHandler` (e.g. `core/http-notify-triggers/webhook.ts`'s
`WebhookNotifier`) instead ends the turn with `stopReason:
'pending_question'`, resumable via
`POST /pending-questions/:pendingId/answer`. See `HUMAN_IN_THE_LOOP.md`'s
own "Durable questions" section.

For the practical "what do I actually need to build" version of all of
this — live chat setup, durable setup, and reference implementations for
Slack/Lark/email/generic-webhook notification channels — see
[`HUMAN_IN_THE_LOOP.md`](HUMAN_IN_THE_LOOP.md).

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

### 7. Sessions

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

`adapters/cli.ts` and `adapters/http.ts` are files your own scaffolded
project owns (see "Quick start" above), not something hidden inside the
`loopengine` package — run them directly with `tsx`, or through shorter
`loopengine` commands that just call the same files for you:

```bash
npx loopengine run customer-service --session s1 "order A-1001 arrived broken"
npx loopengine run customer-service --session s1 --input "order A-1001 arrived broken"
npx loopengine serve   # HTTP server on :8787
npx loopengine dev     # same server, restarts on file changes (tsx watch)
```

`--session <id>` is just an arbitrary string you pick — `s1` above isn't
special, it's only a label. Omit it entirely for a fresh, one-off
conversation each call; reuse the same value on a later call to continue
that exact conversation (the id is printed to stderr if you omit it, so
you can capture it for next time). `--input "<message>"` is an
alternative to the trailing positional message, for scripts that build
the argument list programmatically and would rather not depend on the
message always being the last argument.

`run`/`serve`/`dev` are thin wrappers, not a separate implementation —
each shells out to your project's own `adapters/cli.ts` or
`adapters/http.ts` via `npx tsx` (so it's always *your* copy that runs,
edits included, resolved from your project's own `node_modules`), and
fails with a clear message pointing at `create-loopengine` if that file
doesn't exist yet. `.env` is loaded automatically for all three,
equivalent to passing `--env-file-if-exists=.env` to `tsx` yourself.

The same thing, spelled out without the wrapper:

**CLI:**

```bash
npx tsx adapters/cli.ts --agent customer-service --session s1 "order A-1001 arrived broken"
```

**HTTP:**

```bash
npx tsx --env-file-if-exists=.env adapters/http.ts
curl -X POST localhost:8787/agents/customer-service/messages \
  -H 'content-type: application/json' \
  -d '{"customerEmail":"a@example.com","message":"order A-1001 arrived broken"}'
```

Add `/stream` to the URL for a Server-Sent Events response — one event per
loop step (tool call, permission decision, budget check) instead of a
single reply at the end.

Three small browser pages, all cross-linked, share one look
(`adapters/dev-ui-styles.ts`), and never need a build step — each is a
self-contained HTML string served straight out of `adapters/http.ts`:

**Agents list:** open `http://localhost:8787/agents` in a browser (the
same route returns plain `{agents: [...]}` JSON to a non-browser client —
content-negotiated on the `Accept` header, so nothing that already calls
it as an API needs to change) to see every registered agent with links
into the playground and config page below.

**Dev playground:** open `http://localhost:8787/playground` (optionally
`?agent=<name>` to preselect one) — pick an agent, chat with it, and watch
that same loop-step event stream render live instead of reading raw SSE
frames. Same `/messages/stream` route underneath.

**Building your own client:** the playground is one UI on top of a typed
event protocol, not the only way to consume a turn — see
[`PROTOCOL.md`](PROTOCOL.md) for the full `LoopEvent` catalog, the SSE/
plain-HTTP/CLI transport bindings, and a JSON Schema
(`protocol/loop-event.schema.json`) any language can validate against.
`core/client.ts` and the `examples/chatbox/react`/`examples/chatbox/vue`
hooks are reference implementations of it.

**Agent config page:** open `http://localhost:8787/agents/config`
(optionally `?agent=<name>`) to browse every registered agent's resolved
config — system prompt, model, tools (with their JSON schemas and
parallel-safety), the actual ActAuth rules that would be enforced (source,
default decision, per-rule scope/tool/decision/`when`), and whether
`sessionIdFor`/`tenantFor`/`isSafeTool` are custom or defaulted, and
whether the `http` channel's approver is custom (`httpNotifier` covers
`'approval'`) or the library's own default. Backed
by `GET /agents/:name/config`, which reuses the same
rule/tool resolution `runAgent()` itself uses, so it can't drift out of
sync with what a real request actually gets. Never returns
`AgentModelConfig.apiKey`.

## Wiring a real model

Declare `AgentConfig.model` and the runtime builds a real `ModelCall` for
you, using the matching API key from the environment:

| `provider` | env var | `model` required? |
| --- | --- | --- |
| `'anthropic'` | `ANTHROPIC_API_KEY` | no — defaults to `claude-sonnet-5` |
| `'openai'` | `OPENAI_API_KEY` | yes |
| `'deepseek'` | `DEEPSEEK_API_KEY` | yes |
| `'kimi'` | `MOONSHOT_API_KEY` | yes |
| `'glm'` | `GLM_API_KEY` | yes |
| `'gemini'` | `GEMINI_API_KEY` | yes |

`'kimi'`'s env var is `MOONSHOT_API_KEY`, not `KIMI_API_KEY` — deliberate,
matching Moonshot AI's own docs (the API/company behind Kimi) rather than
this package's own provider name. `openai`/`deepseek`/`kimi`/`glm`/
`gemini` all reuse the same OpenAI-Chat-Completions-compatible request
translation, just pointed at each provider's own base URL — see
`core/model-calls/*.ts` for the provider-specific details (base URLs,
`max_completion_tokens` vs `max_tokens`, and Gemini's own "still in beta"
caveat on Google's compatibility layer).

For anything else (a custom SDK client, a canned/simulated model for
testing), export your own `createModelCall(): ModelCall` instead.

## Built on

| Package | Responsibility |
|---|---|
| [`actauth`](https://www.npmjs.com/package/actauth) | Permission gating (allow/ask/deny/pending) with live and durable human-approval hooks |
| `core/budget.ts` / `core/compaction.ts` | Context-window budget tracking and tail-preserving compaction (vendored in-repo, not an external dependency) |
| `core/recovery.ts` | Retries prompt-too-long / truncated-output failures (vendored in-repo, not an external dependency) |
| `core/durable-approvals.ts` | `TurnCheckpoint`/`CheckpointStore` (file/Redis) backing durable, resumable `ask` decisions — see `HUMAN_IN_THE_LOOP.md` |
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
