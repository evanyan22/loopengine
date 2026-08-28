# The loopengine event protocol

**Status:** v1 · **Schema:** [`protocol/loop-event.schema.json`](protocol/loop-event.schema.json)

One `runAgent()` turn emits an ordered sequence of typed `LoopEvent`
objects. That sequence — not any particular transport — is the actual
contract. The SSE stream, the plain HTTP response, and the CLI's `--json`
mode are three different ways of delivering the exact same objects; a
client written against one of them can switch to another without
changing how it interprets a single event.

This document specifies that sequence: every event's shape, when it
fires, what's guaranteed about ordering, and how each transport carries
it. If you're building a UI or integration against loopengine in any
language — not just TypeScript — this is what to implement against
instead of reverse-engineering `core/loop-events.ts`.

## Stability

This is v1. Within v1:

- **Additive is safe to rely on being additive.** A new event `type` may
  be introduced; a new optional field may be added to an existing event.
  A consumer that ignores unrecognized `type` values and unrecognized
  fields will never break.
- **These are breaking changes**, and won't happen inside v1: renaming or
  removing an event `type`; renaming, removing, or changing the meaning
  of an existing field; turning an optional field required; changing an
  established transport's framing (SSE's `event: <type>\ndata: <json>`,
  the plain response's `events` array, or `--json`'s one-object-per-line
  NDJSON).
- A breaking change ships as v2, documented as a new section here, not a
  silent edit to this one.

## Lifecycle

Every event has a `type` field, which doubles as the discriminant and,
on the SSE transport, the literal frame name. Two families:

- **Engine events** — emitted by `runAgent()` itself, identically
  regardless of which transport is carrying them.
- **Adapter events** — synthesized by the HTTP/CLI adapter around a turn
  (`session`, `approval:pending`, `question:pending`, `done`, `error`).
  `runAgent()` itself has no notion of sessions or HTTP-level failures;
  these exist because a real caller needs them.

A turn always starts with `session` (streamed) and always ends with
exactly one `done`. The only real branch is the ActAuth Gate's decision
on each requested tool call:

```
session → budget:check → assistant:text? → actauth:decision
                                                       │
                              ┌────────────────────────┴───────────────────────┐
                              │ allow                                          │ deny
                              ▼                                                ▼
                   [approval:pending first,             tool:result (statusText: "Denied.")
                    if the rule said "ask"]              — no execution, no tool:started.
                              │                           Any sibling call already approved
                              ▼                           in the same batch gets loop:skipped
                        tool:started                      + its own tool:result ("Skipped.")
                              ▼                                                │
                       toollane:result                                        │
                              ▼                                                │
                     tool:result (Approved./Error.)                           │
                              │                                                │
                              └─────────────────┬──────────────────────────────┘
                                                 ▼
                          loops back to budget:check for the
                          next tool call, or the model's next turn,
                          until exactly one of:
                          loop:done / loop:max_turns / loop:denied
                                                 ▼
                                               done
```

`approval:pending`/`question:pending` are the only events without a
fixed position in that diagram — they can arrive at any point a tool call
is being evaluated. At most one is ever pending at a time (the Gate
evaluates one call before starting the next), so a consumer never needs
to track more than one open decision per turn.

## Event catalog

### Engine — emitted by `runAgent()`

| `type` | Fires | Fields |
|---|---|---|
| `budget:check` | Once per model call, before it | `action: 'ok'\|'nudge'\|'over_hard_limit'`, `usedTokens`, `budgetTokens`, `ratio`, `nudge?` |
| `prompt:compaction` | A prompt was rejected as too large | `from`, `to` (message-array lengths, not tokens) |
| `assistant:text` | The model's "I'll do X" preamble alongside a tool call | `text` |
| `actauth:decision` | Once per requested tool call | `tool`, `decision: 'allow'\|'ask'\|'deny'`, `reason` |
| `tool:started` | The instant a call is decided, before it runs | `id`, `tool`, `args`, `detailText` |
| `tool:result` | A call resolves — allowed, denied, or skipped | `id`, `tool`, `args?`, `detailText?`, `statusText` |
| `toollane:result` | ToolLane's own raw outcome, alongside `tool:result` | `name`, `summary` |
| `skill:loaded` | A `Skill` block resolved to a real skill body | `skill` |
| `loop:skipped` | A sibling call never ran because another was denied | `name`, `deniedTools` |
| `loop:max_turns` | Hit `config.maxTurns` with no final answer | `maxTurns` |
| `loop:denied` | A human denied a call — the turn stops | `deniedTools` |
| `loop:done` | A genuine finish — no more tool calls | `text` |

### Adapter — synthesized around a turn

| `type` | Fires | Fields |
|---|---|---|
| `session` | First event of every streamed turn | `sessionId` |
| `approval:pending` | A tool call needs a live human decision | `id`, `tool`, `args`, `scope: {tenant,environment,agent}`, `reason`, `requestedAt` |
| `question:pending` | The `ask_user` tool raised a real question | `id`, `question`, `options?`, `agent`, `sessionId?`, `requestedAt` |
| `done` | The turn is over — wraps `loop:done`/`max_turns`/`denied` | `text`, `stopReason?: 'max_turns'\|'denied'` |
| `error` | Something failed after the response was already committed | `error` |

Full field types, `required` vs optional, and `additionalProperties: false`
enforcement live in [`protocol/loop-event.schema.json`](protocol/loop-event.schema.json)
— the table above is a summary, the schema is the source of truth.

## Transports

### SSE stream — live, frame by frame

```
POST /agents/:name/messages/stream
content-type: application/json

{"message": "order A-1001 arrived broken, can you refund it?"}
```

Each frame is `event: <type>\ndata: <json>\n\n`, `<json>` being the whole
event object (`type` included, redundantly with the frame name — parse
whichever is more convenient):

```
event: tool:started
data: {"type":"tool:started","id":"call_1","tool":"issue_refund","args":{"orderId":"A-1001"},"detailText":"matched rule 'refunds-need-approval'"}

event: approval:pending
data: {"type":"approval:pending","id":"3f9c...","tool":"issue_refund","args":{"orderId":"A-1001"},"scope":{"tenant":"default","environment":"production","agent":"customer-service"},"reason":"matched rule 'refunds-need-approval'","requestedAt":"2026-08-28T01:34:32.193Z"}
```

### Plain HTTP — one request, the full array

```
POST /agents/:name/messages
content-type: application/json

{"message": "..."}
```

Two response shapes, both carrying the identical `events` array a
streamed version of the same turn would have delivered live:

**200 — the turn finished:**

```json
{
  "text": "Refunded $42.00 to your original payment method.",
  "sessionId": "5a83c6b4-...",
  "events": [ /* every LoopEvent this turn produced, in order */ ],
  "stopReason": "max_turns"
}
```

`stopReason` is present only for a synthetic finish (`max_turns`/`denied`).

**202 — the turn needs a decision right now:**

```json
{
  "pending": true,
  "type": "approval",
  "id": "3f9c...",
  "sessionId": "5a83c6b4-...",
  "tool": "issue_refund",
  "args": { "orderId": "A-1001" },
  "scope": { "tenant": "default", "environment": "production", "agent": "customer-service" },
  "reason": "matched rule 'refunds-need-approval'",
  "approveUrl": "/approvals/3f9c.../approve",
  "denyUrl": "/approvals/3f9c.../deny",
  "events": [ /* everything so far */ ],
  "statusUrl": "/agents/customer-service/sessions/5a83c6b4-..."
}
```

(`type: "question"` carries `question`/`options`/`answerUrl` instead.)

### CLI — one JSON object per line

```
loopengine run customer-service --json "order A-1001 arrived broken, can you refund it?"
```

```
{"type":"session","sessionId":"5a83c6b4-..."}
{"type":"budget:check","action":"ok","usedTokens":2,"budgetTokens":8000,"ratio":0.00025}
{"type":"tool:started","id":"call_1","tool":"issue_refund", ...}
{"type":"done","text":"Refunded $42.00..."}
```

Every line is a complete `LoopEvent`, pipeable straight into `jq` or
anything else that reads NDJSON. Without `--json`, stdout stays
human-readable (just the final answer) and events go to stderr instead.

### Resolving a pending item

```
POST /approvals/:id/approve      POST /approvals/:id/deny
POST /questions/:id/answer   {"answer": "..."}
```

All three return the exact same two-shape family as plain
`POST /messages` above (200 done, or 202 the *next* pending item, if the
turn needed another decision) — a caller can treat send → approve/deny/
answer → approve/deny/answer → ... as one uniform loop regardless of
which endpoint produced the response.

## Validating against the schema

```js
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats' // schema uses format: 'date-time'
import schema from './protocol/loop-event.schema.json' with { type: 'json' }

const ajv = new Ajv2020({ strict: true })
addFormats(ajv)
const validate = ajv.compile(schema)
validate(event) // true/false; validate.errors on failure
```

The schema is hand-maintained alongside `core/loop-events.ts`, not
generated from it — a PR that changes one without the other is
incomplete. It's plain JSON Schema (draft 2020-12), so it works from any
language with a validator, not just JavaScript.

## Reference implementations

- **`core/client.ts`** — the framework-agnostic TypeScript client this
  spec was extracted from: SSE parsing, the plain-request helpers,
  approve/deny/answer. Re-exported through the package's own entry point.
- **`ui-examples/react/`**, **`ui-examples/vue/`** — a hook/composable
  and a chat component each, built on `core/client.ts`, rendering
  `approval:pending`/`question:pending` as real UI.

Implementing this protocol in another language means reproducing what
`core/client.ts` does: parse whichever transport you chose into
`LoopEvent` objects per this schema, and drive your own UI or logic off
`type`.
