# LoopEngine

[![CI](https://github.com/loopengine-co/loopengine/actions/workflows/ci.yml/badge.svg)](https://github.com/loopengine-co/loopengine/actions/workflows/ci.yml)

LoopEngine is a runtime for building AI agents: a persona, a set of tools,
and permission rules, run through a transparent ReAct loop. No chain DSL,
no hidden control flow — `core/run-agent.ts` is a single function you can read
top to bottom. Run agents over a CLI, an HTTP API, or both.

## Why LoopEngine

- **Up and running in one command.** `npx create-loopengine@latest` scaffolds
  a real, standalone project — its own repo, a starter agent, CLI and HTTP
  adapters already wired up. `npm install && npm run dev` and you have a
  running agent server, not a half-finished template to wire up yourself.
- **A real Admin UI, not just logs.** Open `/agents/config` in a browser to
  see and edit a live agent: its resolved config, permission rules, skills,
  tool connections, and secrets — no redeploy to change a rule or add a
  skill. See [Admin UI](#admin-ui) below.
- **Human-in-the-loop, wired for real notification channels.** A risky tool
  call or a genuinely ambiguous question routes to a human — live in a chat
  session, or durably via Slack, Lark, email, a generic webhook, or a
  polling queue, resumable minutes or days later. See
  [Human in the loop](#human-in-the-loop) below.
- **Sessions persist automatically.** Send a message, get a reply, come
  back later with the same session id and continue — no database to wire
  up yourself, and it survives a crash mid-turn cleanly.
- **An ability system for reusable capabilities.** Install a bundle of
  tools, a skill, and the permission rules that gate them with one command
  — real, reviewable files in your own repo, not an opaque dependency. See
  [Ability system](#ability-system) below.
- **Does real work, safely.** Tools can hit a database, send emails, call
  GitHub/Slack, anything with an `execute` function. Permission rules gate
  what happens without a human: safe reads auto-run, risky actions get
  approval or are denied outright.
- **Multi-tenant and composable out of the box.** The same deployed agent
  serves different customers with different permission levels, no forking
  required — and one agent's folder drops under another's `subagents/` to
  become a tool the parent can delegate to, own tools/rules/loop intact.

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
own folder convention (drop another agent's folder there and it becomes
one of this agent's tools automatically), always merged into `tools` on
top of whatever the table above resolves to.

`rules` is how you gate what a tool can do without approval — each rule
maps a `scope` (tenant/environment) + tool name to `allow`/`ask`/`deny`,
with an `ask` decision routing to a human — see
[Human in the loop](#human-in-the-loop) below.

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

## Admin UI

Run the HTTP adapter and open `http://localhost:8787/agents/config` — a
live, editable view of every registered agent, no code changes or
redeploy needed for most of it:

| Tab | What you can do |
| --- | --- |
| **Overview** | System prompt, model, every tool (with its JSON schema and parallel-safety), and a read-only view of the rules that would actually apply. |
| **Skills** | Create, edit, and delete `SKILL.md` files for this agent directly in the browser — write the body, preview the rendered markdown, save. |
| **Tools** | Local hand-written tools, gateway-sourced tools (e.g. [Composio](https://composio.dev)), and subagents-as-tools, in one place. Connect a new external gateway source or add/remove a tool without touching a file. |
| **ActAuth** | Add, edit, and delete permission rules — scope, tool, condition, decision — and change `default_decision`, live. |
| **Environment** | Every env var an ability (see [Ability system](#ability-system)) declared it needs, across everything installed for this agent — which ones are set, which are missing, and a form to set one. A value is never echoed back once set. |

Every tab is backed by a real API (`GET /agents/:name/config`, `.../actauth`,
`.../env`, ...) that reuses the exact same resolution `runAgent()` itself
uses — so what you see here can't drift out of sync with what a real
request actually gets, and never returns a model API key.

## Human in the loop

A risky tool call (`actauth`'s `ask` decision) or a genuinely ambiguous
question the model itself raises both need a human — and LoopEngine
handles both the same way, live or durable:

- **Live** — someone's actively watching right now (a terminal, an open
  chat session). The turn just waits; `cli`/`http_stream` get this
  automatically, with nothing to configure.
- **Durable** — nobody's watching (a webhook-triggered run, a ticket that
  came in overnight). The turn ends immediately with a resumable pending
  state, and a real notification goes out on whichever channel you've
  configured — resolvable minutes or days later without holding any
  process open in between.

Six channels ship as real, working notifiers — configure one and the
"send a notification" side is done for you:

| Channel | What it does |
| --- | --- |
| `webhook` | Signed HMAC-SHA256 POST to any URL you own |
| `slack` | An interactive message via `chat.postMessage`, with Approve/Deny buttons |
| `lark` | A Lark/Feishu interactive card |
| `email` | A signed, expiring magic-link per decision |
| `database` | Writes a row for your own worker/dashboard to poll |
| `redis` | Pushes a queue entry for your own worker to consume |

```ts
export const config: AgentConfig = {
  // ...
  httpNotifier: {
    channel: 'slack',
    config: { botToken: process.env.SLACK_BOT_TOKEN!, channelId: process.env.SLACK_CHANNEL_ID! },
    events: ['approval', 'question'],
  },
}
```

Reference implementations for the receiving side (verifying a Slack
click, a webhook HMAC signature, a magic-link token) ship under
`examples/notifier-handler/` for the four channels that need one. See
[`HUMAN_IN_THE_LOOP.md`](HUMAN_IN_THE_LOOP.md) for the full setup guide —
live and durable, worked examples, and how resumption actually works
under the hood.

## Ability system

Giving an agent a new capability is usually three separate, hand-authored
things: a tool file, a `SKILL.md` teaching the model when to use it, and
an `actauth` rule allowing it to actually run. A **loopengine ability**
bundles all three into one installable unit:

```bash
npx loopengine add-ability <spec> --agent customer-service
```

`<spec>` is anything `npm pack` understands — a public or private npm
package, a scoped package on a private registry, or a plain git repo. The
tool files, skill directory, and actauth rules all land as real files in
the agent's own tree, copied in rather than imported as a `node_modules`
dependency — reviewable, diffable, and editable the same as anything you
would have hand-written, not an opaque black box.

```bash
npx loopengine upgrade-ability <abilityName> --agent customer-service
npx loopengine remove-ability <abilityName> --agent customer-service
```

Upgrading does a real three-way merge per file — a hand-edit since install
survives, a genuine conflict leaves `<<<<<<<` markers to resolve by hand
instead of silently overwriting either side. Removing refuses a file
that's been modified since install unless you pass `--force`. An ability
can also declare the env vars its tools need, which then show up in the
Admin UI's [Environment tab](#admin-ui) automatically once installed. See
[`ABILITIES.md`](ABILITIES.md) for the full design — format, publishing,
and how the merge/upgrade mechanics work in detail.

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

**Agent config page:** this is the [Admin UI](#admin-ui) described above
— open `http://localhost:8787/agents/config` (optionally `?agent=<name>`).

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
| `core/sessionknit.ts` | Durable session log with crash-interruption detection (vendored in-repo, not an external dependency) |
| `core/skillgarden/` | `SKILL.md` discovery and lazy loading (vendored in-repo, not an external dependency) |
| `core/toollane.ts` | Parallel/solo tool-call scheduling (vendored in-repo, not an external dependency) |
| `core/mcpplug.ts` | Gateway tool sourcing (e.g. Composio) (vendored in-repo, not an external dependency) |

Installing `loopengine` pulls in `actauth` as a regular dependency —
install it directly only if you want to use it standalone. Everything
else in this table ships inside `loopengine` itself.

## Deployment

```bash
docker compose up --build
```

Builds the HTTP adapter into a container and starts it alongside Redis.
For production, push the image to any container platform with `REDIS_URL`
and your model/tool API keys set as environment variables.
