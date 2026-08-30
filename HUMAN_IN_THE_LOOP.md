# Human in the loop: approvals and questions, live or durable

A tool-calling agent regularly needs a human for one of two reasons: a
gated tool call needs permission (`actauth`'s own `ask` decision), or the
model itself is genuinely unsure and calls `system_ask_user` instead of
guessing. Both go through the exact same live-vs-durable split. This doc
is both halves of that story: the practical "what do I actually need to
build" setup guide, and the design reference underneath it — how
durability, notification, and resumption actually work, so an
`ApprovalPayload`/`TurnCheckpoint`/`WebhookNotifier` mentioned in a code
comment somewhere has one place to look it up. For the wire-level SSE
event protocol, see [`PROTOCOL.md`](PROTOCOL.md).

**Status: implemented and verified** — real webhook deliveries with a
checked HMAC signature, a resolved approval resuming the turn through the
normal durable session-append path, a chained second pending call inside
a *resumed* turn, a rejected-then-retried edited-args approval, and a
two-step durable-question chain, all exercised live end to end, not just
unit-tested.

## The one decision that determines everything else

**Is a human going to be live, watching, for the entire duration —
including however long they take to decide?**

- **Yes** (someone's actively chatting with the agent right now) → use
  the `http_stream` channel. A human is the approval/question mechanism
  already, implicitly; you just need a UI that shows them the pending
  card and lets them respond.
- **No** (a webhook/cron-triggered run, a support ticket that came in at
  3am, anything unattended) → use durable approvers/question handlers on
  the `http` channel. Nobody's watching, so the turn has to survive the
  process exiting — real infrastructure, not just a config flag.

You can mix both per agent: `cli`/`http_stream` always get the library's
own live defaults automatically, with nothing to configure, and `http`
gets its own durable config via `AgentConfig.httpNotifier` (see below).
`agents/customer-service/index.ts` does exactly this: live on
`cli`/`http_stream`, durable on `http` when its own webhook env vars are
set.

## Path 1: `http_stream` — live chat

### What's already done for you (the server side)

Nothing to configure. `adapters/http.ts`'s `handleMessagesStream`
unconditionally builds a fresh `WebchatApprover` per turn and wires
`onQuestionPending` — a pending approval/question streams as an SSE
event (`approval:pending`/`question:pending`) on the exact same
connection the client already has open, no `AgentConfig` fields, no env
vars, nothing to set up server-side. Nothing can override this for
`http_stream` either — `AgentConfig.httpNotifier` only ever matches
`channel === 'http'`, so it's structurally unreachable here.

### What you still need to build (the client side)

Something has to consume the SSE stream, recognize those two event
types, render a card, and call the resolve routes when a human acts.
That's real UI work — not zero-cost, just server-cost-zero. What
loopengine gives you toward it, so it's not from scratch:

- **`core/client.ts`** — framework-agnostic `streamMessage`,
  `approveCall`, `denyCall`, `answerQuestion`: SSE parsing and the REST
  calls, already correct, reused by everything below.
- **`examples/chatbox/react/useLoopChat.ts`** (and the Vue equivalent) —
  a reference hook tracking `pending: PendingApprovalEvent |
  PendingQuestionEvent | null` as component state, built on `client.ts`.
  Handles state, not rendering — you still write the actual buttons/input,
  but you're not reimplementing "how do I know something's pending" from
  raw SSE frames.
- **`web/playground.ts`** — a complete, working reference UI
  (`appendApprovalCard`/`appendQuestionCard` render real buttons and a
  text input, wired to the real REST calls). Usable directly for local
  dev (`npx loopengine dev` → `http://localhost:8787/playground`), or as
  a template for your own.

### The actual request/response shape

```bash
npx tsx --env-file-if-exists=.env adapters/http.ts
curl -N -X POST localhost:8787/agents/customer-service/messages/stream \
  -H 'content-type: application/json' \
  -d '{"customerEmail":"a@example.com","message":"order A-1001 arrived broken"}'
```

Watch for an `event: approval:pending` or `event: question:pending`
frame; when one arrives, render it and, once the human responds:

```bash
curl -X POST localhost:8787/approvals/<id>/approve   # or /deny
curl -X POST localhost:8787/questions/<id>/answer -d '{"answer":"..."}'
```

The original SSE connection just continues once resolved — there's no
separate "how does the requester find out" problem, since they never left.

## Path 2: `http` — durable

Real infrastructure, several genuinely separate pieces. None of this is
optional plumbing you can skip — durability's whole point (surviving a
process restart, a webhook that fires at 3am with nobody watching) needs
every piece below.

### 1. Pick and configure a notifier

Either a deployment-wide default (env vars, `adapters/http.ts`) — one
target covers both approvals and questions, via one shared
`WebhookNotifier` instance (`core/http-notify-triggers/webhook.ts`):

```bash
LOOPENGINE_DEFAULT_WEBHOOK_URL=https://...
LOOPENGINE_DEFAULT_WEBHOOK_SECRET=...
```

Or a per-agent one, which always wins over the deployment-wide default
(`agents/<name>/index.ts`):

```ts
export const config: AgentConfig = {
  // ...
  httpNotifier: {
    channel: 'webhook', // or 'slack' | 'lark' | 'email' | 'database' | 'redis' — see below
    config: { webhookUrl: process.env.MY_WEBHOOK_URL!, webhookSecret: process.env.MY_WEBHOOK_SECRET! },
    events: ['approval', 'question'],
  },
}
```

`AgentConfig.httpNotifier` replaces what used to be up to four separate
fields (a channel-keyed `approvers.http` override, `questionHandlers.http`,
`onRunStart`, `onRunFinish`) with the single shape almost every real
deployment actually wants: one target, receiving whichever of
approvals/questions/lifecycle events it asks for via `events`. Only
`http` ever consults it — `cli`/`http_stream` keep the library's own live
defaults (`ConsoleApprover`, `CliQuestionHandler`, `WebchatApprover`)
automatically, with nothing to configure. When it's set for `http`, it
still wins outright over whatever the adapter itself would otherwise
default to (`adapters/http.ts`'s plain `/messages` route always passes
*some* `options.approver` of its own) — the agent's own explicit choice
for that channel beats the deployment-wide default.

All six channels have their own file under `core/http-notify-triggers/`,
one class per channel covering both approvals and questions:

| `channel` | Class | Notes |
|---|---|---|
| `'webhook'` | `WebhookNotifier` | Signed HMAC-SHA256 POST — `X-Actauth-Signature` for an approval, `X-Askuser-Signature` for a question. |
| `'slack'` | `SlackNotifier` | `chat.postMessage` with interactive buttons. |
| `'lark'` | `LarkNotifier` | Lark/Feishu's own card API (lower confidence on exact card-schema field names — see that file's own header comment). |
| `'email'` | `EmailNotifier` | A `sendEmail` callback plus a signed, expiring magic-link token per link. |
| `'database'` | `DatabaseApprover` | Writes a row for a separate worker/dashboard to poll. Approval-only — see below. |
| `'redis'` | `RedisQueueApprover` | Pushes a queue entry. Approval-only. |

`resolveHttpNotifier` (`core/http-notifier.ts`) constructs whichever one
`channel` names — no example code required for the sending side, for any
of them. `'database'`/`'redis'` aren't a notification channel at all —
nothing gets told anything, a human or worker just polls the row/queue
directly — so `'approval'` is the only event either ever does anything
with (`AgentConfig.ApprovalOnlyHttpNotifierEvent` enforces this at the
type level).

### 2. Pick a notification channel and stand up its receiving side

The notifier's job is just "fire a notification, return a `pendingId`
immediately" — surfacing it to an actual human, and verifying whatever
comes back really is that human, is a *separate* server you own (except
for `database`/`redis`, which have no receiving side at all). Reference
implementations exist for the four that need one, one file per channel
under `examples/notifier-handler/`:

| Channel | Sending (built for you) | Receiving (you deploy) |
|---|---|---|
| Generic webhook | `httpNotifier`'s `channel: 'webhook'` | `examples/notifier-handler/webhook.ts`'s `verifyWebhookNotifier` |
| Slack | `httpNotifier`'s `channel: 'slack'` | `examples/notifier-handler/slack.ts`'s `SlackNotifierHandler` |
| Lark/Feishu | `httpNotifier`'s `channel: 'lark'` | `examples/notifier-handler/lark.ts`'s `handleLarkInteraction` |
| Email (magic link) | `httpNotifier`'s `channel: 'email'` | `examples/notifier-handler/email.ts` — imports `verifyMagicLink` from `core/http-notify-triggers/email.ts` rather than reimplementing it, since sending and verifying have to share one exact algorithm |

Every one of these four files is receiving-side-only: an HTTP endpoint
you still have to deploy yourself (an example, not a library export),
regardless of which channel.

### 3. Resolve, once a human decides

```bash
curl -X POST localhost:8787/pending-approvals/<id>/resolve \
  -d '{"decision":"approve"}'   # or "deny", optionally "editedArgs"
curl -X POST localhost:8787/pending-questions/<id>/answer \
  -d '{"answer":"..."}'
```

Both sit behind `LOOPENGINE_ADMIN_AUTH` Basic Auth, same as every other
route on that server. `editedArgs` lets an approver fix the model's
drafted arguments before running the tool, not just accept/reject them
verbatim — see [Approve-with-edit](#approve-with-edit) below.

### 4. Telling the *original* requester it's actually done

The original `POST /messages` caller already got back a `202 {pending:
true}` and is long gone by the time a human answers, possibly days
later — a genuinely different party than whoever just approved/answered
in Slack/email/wherever (a customer waiting on a refund isn't the ops
person deciding whether to issue it). Whether this needs solving at all
depends on your use case: if the caller was just a trigger and the value
is in the side effect (a database row changed, a ticket closed), nobody's
waiting on a reply and there's nothing to build. If a real human is
sitting on the other end of that original request — a support thread, an
SMS conversation — they need to hear back somehow.

`AgentConfig.onRunStart`/`onRunFinish` exist for exactly this — fire-and-
forget hooks on `runAgent()`/`resumeAgent()` themselves (so they fire
for *any* caller, not just `adapters/http.ts`'s own routes):
`onRunStart` for visibility into an unattended run actually beginning
(an admin log line, a Slack "processing your request" post — `trigger`
tells you whether this is a fresh message or a durable resume, so you can
filter to only the case you care about), `onRunFinish` for the moment a
turn reaches a genuine terminal outcome (never for
`pending_approval`/`pending_question` — those are paused, not finished).
Neither ever fires on `cli`/`http_stream` — both channels already deliver
the start/finish signal to whoever's waiting synchronously, as part of
that channel's own normal response, so loopengine skips the redundant
copy for you rather than leaving every implementation to filter it out
itself; a caller with no `channel` set at all (a bespoke script) still
fires either way, since there's no such guarantee to assume for it.
Neither carries contact info itself — that's on you to re-derive from
`sessionId`/`tenant`/`agent` (`customer-service`'s own `sessionIdFor`
already does this kind of lookup for the email case), the same way none
of this doc's own notifiers know who a human *is*, only how to reach
whichever channel you configured. A `send_sms`/`send_email` tool the
agent calls itself as part of finishing the turn is still the simplest
option if you already have one — `onRunFinish` is for when you need it
to happen deterministically, not conditional on the model remembering to
call a tool.

## Quick comparison

| | `http_stream` (live) | `http` (durable) |
|---|---|---|
| Server-side setup | None — auto-wired | Webhook config + a receiving server you deploy |
| Client/notification UI | Build or reuse `client.ts`/the chatbox hooks/the playground | Build or reuse one of the `examples/notifier-handler/` channel files |
| Survives a restart | No — one open connection for the whole turn | Yes — that's the entire point |
| Fits unattended/background triggers | No | Yes |
| "Turn finished" notification back to the original requester | Automatic (same connection) | `AgentConfig.onRunFinish` gives you the hook — reaching the requester is still your own code |

Neither is "better" — they answer different questions about who's
present when the agent needs a human. Use both, per channel, on the same
agent, if you need to serve both situations.

## How durability actually works

Everything above is the "what do I configure" version. This section is
the "why does it work this way" one — for when a code comment points
here, or you're extending the mechanism itself rather than just wiring
it up.

### The problem

`WebchatApprover` and `SlackChatApprover` (both from `actauth`) hold
pending approvals in an in-memory `Map`, with a default 5-minute timeout
that **fails closed** (auto-denies) if nobody responds — `run-agent.ts`'s
loop `await`s the approver directly, so the entire turn is a live,
suspended JavaScript call, inside one process, for as long as the human
takes. That's the right model for genuinely live chat. It's the wrong
model for anything triggered by a business process — a support ticket, a
PR, a lead created in a CRM — where the realistic delay before a human
looks at it is minutes to days, and a 5-minute fail-closed timeout means
the *normal* case silently auto-denies before anyone sees it, on top of
the suspended turn not surviving a deploy or restart regardless.

### Bucket, then execute — never evaluate-and-immediately-act

A naive fix (an approver that *throws* to signal "pending") is broken:
`run-agent.ts` evaluates `tool_use` blocks in a **sequential** `for`
loop, in whatever order the model emitted them. A thrown exception
unwinds that loop immediately, so a gated call early in the batch would
stop every later block — including plain auto-allowed ones — from ever
being evaluated, making execution order-dependent on something nobody
should have to reason about.

The real fix: durable pending decisions can't be squeezed through a
`Promise<boolean>` contract at all — awaiting a promise that only
resolves when a human clicks something two days later means the process
sits blocked for two days, exactly what durability exists to avoid. The
honest fix is a second, explicitly different interface:

```ts
interface DurableApprover {
  requestDurableApproval(
    tool: string, args: Record<string, unknown>, scope: Scope, reason: string,
  ): { pendingId: string }   // fast — creates the pending record and returns; never awaited for the actual decision
}
```

`Gate.evaluate()` (in `actauth`) duck-types its configured approver and
dispatches accordingly — a plain `Approver`'s `allow`/`deny` gets handled
exactly as before, and a new `'pending'` decision (carrying a `pendingId`)
goes straight into a `pending` bucket instead of being resolved inline.
Either way the sequential loop reaches every block regardless of where
the gated one sits — no exceptions, no hanging.

Once every block in a batch has been evaluated this way, three buckets
exist: calls to run now (`allow`), results to synthesize now (`deny`),
and calls still waiting (`pending`) — the first two execute/synthesize
immediately; a pending sibling elsewhere in the batch never blocks
already-decided work.

### Worked example

Model requests four tool calls in one turn: `lookup_order` (t1,
auto-allowed), `send_email` (t2, auto-allowed), `issue_refund` (t3, needs
approval), and a fourth gated tool (t4, also needs approval).

Evaluation (order-independent, per above): t1 and t2 land in the
run-now bucket and execute immediately, producing real results. t3 and
t4 both land in the pending bucket, each getting its own pending record —
but **both point at the same checkpoint**, because the eventual
`tool_result` message has to answer all four `tool_use` blocks from this
one batch at once; it can't be split across two messages. The real
shape, `core/durable-approvals.ts`:

```ts
interface TurnCheckpoint {
  id: string
  sessionId: string
  agent: string
  tenant: string
  resultsSoFar: ModelContentBlock[]
  // Keyed by pendingId, not toolUseId — a resolve call only ever names a
  // pendingId (what DurableApprover.requestDurableApproval handed out),
  // so that's what has to be the lookup key, with everything execution
  // needs (toolUseId, tool, args, reason) as the value.
  outstanding: Record<string, { toolUseId: string; tool: string; args: Record<string, unknown>; reason: string; kind?: 'approval' | 'question' }>
  closed: boolean
}
```

At the moment the turn pauses: `resultsSoFar` = `[t1's real result, t2's
real result]` — they already have both a decision *and* a result, so
they were never "outstanding" in the first place. `outstanding` =
`{t3's pendingId: {...}, t4's pendingId: {...}}` — the calls genuinely
still waiting on a human.

**Both approved (either order):** whichever resolves first appends its
real result and removes itself from `outstanding`; the turn stays paused
until the *second* one resolves too. Once `outstanding` is empty, the
complete four-result message is assembled and pushed durably, and the
loop continues — a fresh model call, now with the full picture.

**One denied while the other is still unresolved:** denial closes the
checkpoint **immediately**, regardless of what else is outstanding. If
t4 is denied while t3 hasn't been touched yet, t3 gets a synthesized
`skipped` result right then (same as a synchronous denial's own "a
denial cancels the whole batch, siblings that hadn't run yet get marked
skipped" behavior) — it can't be left dangling. The message gets pushed
with t1/t2's real results + t4's denial + t3's skip, and the loop stops
with `stopReason: 'denied'`.

This leaves t3's own pending record pointing at an already-closed
checkpoint. If its approve/deny link gets clicked later — plausible,
since whoever owns that decision may not know a sibling was already
denied — the resolve path treats "my checkpoint is already closed" as a
**graceful no-op** (`{alreadyResolved: true}`), never an error and never
a second attempt to execute or push anything.

### What's durable, and where

The conversation itself needs no new storage — the assistant's
tool_use-laden message and (once complete) the answering `tool_result`
message both go through the existing session-store append path
unchanged. `TurnCheckpoint` is the one new thing that needs real durable
storage, and it doubles as its own pending-decision index — no separate
table needed, since each `pendingId` in `outstanding` already *is* the
lookup key.

Implemented as `core/durable-approvals.ts`'s `CheckpointStore`,
deliberately mirroring `session-store.ts`'s own shape: a `create()` plus
a locked read-modify-write (`withCheckpoint(pendingId, fn)`), backed by
`FileCheckpointStore` (one JSON file per checkpoint, one small pointer
file per `pendingId` under `.checkpoints/`) for local dev or
`RedisCheckpointStore` (a `checkpoint:<id>` string + a
`checkpoint-pending-index:<pendingId>` → checkpoint id pointer) for
multi-instance deployments, chosen by the same `REDIS_URL`-gated
`createCheckpointStore()` factory pattern `createSessionStore()` already
uses.

`withCheckpoint(pendingId, fn)`'s callback receives the checkpoint (or
`undefined` for an unknown/already-closed `pendingId` — the graceful
no-op case) and returns `{checkpoint, result}`; the store persists
`checkpoint` (or deletes it, if `closed: true`) and hands `result` back
to the caller. `adapters/http.ts`'s resolve/answer routes use this
directly — see [End to end](#end-to-end) below.

### Notification: request + raw resolve only

Durability and notification are two separate problems — everything
above only solves the first. Notification isn't a separate concept
bolted on afterward — it's something a `DurableApprover` implementation
*does*, as part of handling `requestDurableApproval()`, the same way
`SlackChatApprover` posting to Slack today isn't a step bolted onto
`requestApproval()`, it *is* `requestApproval()`.

These classes can't own the *entire* request/resolve round trip the way
a live approver does, though. A live approver's `requestApproval()` can
own resolution completely because nothing has to survive past one
`await` — `decide()` settles the promise, `Gate.evaluate()` unwraps it,
done. A durable approver's "what happens after a human clicks approve"
is *resume the turn from `TurnCheckpoint`* — needs the session store and
the model call, none of which `actauth` knows about or should, same
reason it stays agnostic of sessions and turns generally. So a durable
sender only owns the **request** side (create the pending record, fire
the notification) and a **raw resolve** entrypoint (verify + record a
decision by `pendingId`) — loopengine supplies the callback that reacts
to a resolved decision and actually resumes the loop. That split is why
`actauth`'s `WebhookApprover`/`WebchatApprover`/`SlackChatApprover` live
in `actauth` itself (general-purpose, no loopengine concepts), while
`system_ask_user`'s durable senders (`core/http-notify-triggers/`) live
in loopengine — `system_ask_user` never goes through `actauth`'s `Gate`
at all (see `core/system-tools/ask_user.ts`'s own header comment on why
gating it would be circular), so `actauth` has no reason to know it
exists.

### Approve-with-edit

Not every pending decision is binary. Even once a call is correctly
routed to `ask`, the approver's real intent usually isn't "yes/no" —
it's "yes, but let me fix the wording first." The tool call already
carries the model's drafted `args`; the approver should be able to edit
them and *then* approve, not just accept or reject the draft verbatim.

This doesn't touch the checkpoint/bucket-then-execute shape at all — it
only widens the resolve request body, `adapters/http.ts`'s `POST
/pending-approvals/:pendingId/resolve`:

```ts
{ decision: 'approve' | 'deny', editedArgs?: Record<string, unknown> }
```

When `editedArgs` is present, `tool.execute(editedArgs ?? item.args)`
runs with those in place of the model's original `args`. `editedArgs` is
checked against the tool's own `input_schema` (a small hand-rolled
required-fields check, not full JSON Schema validation) before it runs —
an invalid edit returns `400` with the checkpoint left **completely
untouched**, so the same `pendingId` can be retried with corrected args
rather than being permanently burned by a typo. The `tool_result` the
model eventually sees reflects what actually happened — the edited
values that were actually sent, never the model's original draft, once
validation passes.

An approval UI (Slack message, magic-link page, admin console) needs to
render pending `args` as an editable form when the tool's schema allows
it, not just an approve/deny button pair — a UI concern, not a protocol
one, but worth flagging since it's the whole reason `args` is already
exposed on `approval:pending`.

### Content-conditional gating

The same tool can need different treatment depending on what it's being
asked to do — `send_email` auto-sends a tracking-info reply but should
pause for a refund reply. This needs no new architecture: `actauth`'s
`Gate.evaluate(tool, args, scope)` already resolves against a `RuleSet`
whose rules can carry a `when: Condition` — `{field, op, value}`,
dot-path-resolved into `args`, through a fixed op table (`eq`, `ne`,
`gt`, `gte`, `lt`, `lte`, `in`, `contains` — no `eval`, deliberately).

Matching against free-text prose (`{field: body, op: contains, value:
"refund"}`) is a heuristic, not a classification. The robust version
gives the tool schema an explicit enum field the model fills in itself —
the model already knows why it's writing the email, so let it say so
structurally, and gate on that field with `eq` instead of scanning
prose:

```ts
input_schema: {
  type: 'object',
  properties: {
    body: { type: 'string' },
    intent: {
      type: 'string',
      enum: ['tracking_info', 'refund', 'other'],
      description: 'Why this email is being sent, so a human reviewer knows whether to check it before it sends.',
    },
  },
  required: ['body', 'intent'],
}
```

The `description` is doing the real work — the model classifies based on
what it's told the field means, the same way it "knows" to put
customer-facing prose in `body` because the tool's own description says
"email the customer." loopengine doesn't validate tool args against
`input_schema` before executing, so a malformed or unrecognized `intent`
value doesn't throw — the rule just silently falls through to the
ruleset's `default_decision`. That makes the fallback the thing that
actually determines safety: write rules positive-match-to-allow,
default-to-ask, so anything that isn't an exact, recognized match —
including a bad value — asks, rather than default-to-allow with a
growing blocklist of risky cases:

```yaml
rules:
  - tool: send_email
    when: { field: intent, op: eq, value: tracking_info }
    decision: allow
default_decision: ask   # anything else — including a bad value — asks
```

`agents/customer-service/tools/send_email.ts` and
`agents/customer-service/actauth.yml` are the real, live version of this
example, not just an illustration.

### Durable questions (ask_user)

`system_ask_user` gets almost exactly the same treatment tool-call
approvals do above, reusing more of it than a fresh design would suggest:

- **`DurableQuestionHandler`** (`core/agent-config.ts`) — the
  question-side sibling of `DurableApprover`, same positional-args shape
  (`notifyPendingQuestion(question, options, agent, sessionId):
  {pendingId}`, mirroring `requestDurableApproval(tool, args, scope,
  reason)`). `core/http-notify-triggers/webhook.ts`'s `WebhookNotifier`
  implements both this and `DurableApprover` in one class — a signed
  HMAC webhook POST (header `X-Askuser-Signature` for a question,
  `X-Actauth-Signature` for an approval), fire-and-forget either way; so
  do its `slack.ts`/`lark.ts`/`email.ts` siblings.
- **`WebchatQuestionHandler`** (`core/system-tools/ask_user.ts`) — the
  *live* sibling: holds the `Promise` open and resolves it directly, no
  webhook, no `pendingId` handed to a durable resolve route. One
  deliberate difference from `WebchatApprover`: `onPending` is a
  per-call argument to `requestQuestion()`, not a constructor option,
  because a question only ever needs *one* shared registry (unlike
  approvals, which get a fresh `WebchatApprover` per streamed turn
  specifically so each one's `onPending` can target that turn's own SSE
  connection).
- **`CliQuestionHandler`** (`core/system-tools/ask_user.ts`) — the
  cli-channel default: a blocking terminal `rl.question()`, nothing
  else. `createAskUserTool`'s own `onPending`-presence check picks
  between the two live handlers (`adapters/cli.ts` passes no live push
  callback, so it always lands on `CliQuestionHandler`; `adapters/http.ts`'s
  both routes always pass one, so they always land on
  `WebchatQuestionHandler`).
- **One unified pending bucket, not two parallel ones.** A gated tool
  call and a `system_ask_user` call can land in the *same* model
  response — the same "one dangling assistant `tool_use` message can
  only ever get one completing `tool_result` message" reasoning from the
  worked example above applies identically here. `run-agent.ts`'s loop
  collects both kinds into one `pending: PendingItem[]` (`{kind:
  'approval' | 'question', toolUseId, tool, args, pendingId, reason}`),
  and `RunAgentResult.pending.outstanding` carries both kinds together.
  `stopReason` is `'pending_question'` only when a batch contains *no*
  approval items at all; a mixed batch reports `'pending_approval'` (an
  approval-aware caller already has to handle that case, so it needs no
  new branching for the common pure-approval batch).
- **Resolution is simpler than an approval's**: `POST
  /pending-questions/:pendingId/answer` takes `{answer: string}` and
  uses it as the completing `tool_result` content directly — no
  `tool.execute()`, no `editedArgs`/schema validation, no deny/cascade-skip
  concept. It shares the exact "outstanding empty → resume via
  `resumeAgent`, else report the remaining count" tail with the approval
  route. Each route rejects the other kind's `pendingId` with a `400`
  naming the correct route.
- **No live-question override wired through `httpNotifier` yet.** Only
  the *durable* half of a resolved `QuestionHandler` is actually wired
  to anything — the live branch always falls through to
  `createAskUserTool`'s own independent resolution (keyed off
  `onQuestionPending`'s presence). Fully closing this gap would mean
  moving `system_ask_user`'s live answer-collection inline into the
  loop, changing today's batching semantics (a pending question is
  currently deferred until the whole batch is scanned and confirmed
  denial-free — approvals don't have that property, since a live `ask`
  is already awaited mid-scan) — deliberately deferred, not shipped
  half-carefully.

### End to end

1. A message comes in (live chat, or a background trigger calling
   `runAgent()` directly with a `DurableApprover` as `options.approver`)
   → the loop evaluates the model's requested tool calls. One hits an
   `ask` rule routed to a `DurableApprover` → `Gate.evaluate()` returns
   `'pending'` with a `pendingId`, instantly, no blocking.
2. Any *other*, already-approved call in the same batch still runs for
   real right then. The turn stops there: `stopReason: 'pending_approval'`
   (or `'pending_question'`), `newMessages` ending at the dangling
   assistant tool_use message — the same crash-recovery shape
   `session-store.ts`'s own `hasUnresolvedToolCall` already detects,
   entered on purpose.
3. The adapter (`adapters/http.ts`'s `createCheckpointFromPending`) turns
   `result.pending` into a durable `TurnCheckpoint` via
   `checkpoints.create(...)`. The notifier has already fired its
   notification from inside step 1 — **the process can exit, nothing is
   held open.**
4. Minutes or days later: `POST /pending-approvals/:pendingId/resolve`
   (or `/pending-questions/:pendingId/answer`) arrives, decoupled from
   any live connection or process. `checkpoints.withCheckpoint(pendingId,
   fn)` loads the checkpoint (or hands `fn` `undefined` for an unknown/
   already-closed `pendingId` — reported as `{alreadyResolved: true}`, a
   graceful no-op).
5. `fn` executes the tool for real (validating `editedArgs` first, if
   given) or synthesizes a denial/records an answer. A denial closes the
   whole checkpoint immediately, synthesizing `skipped` for any other
   still-outstanding item in the same batch.
6. If `outstanding` is still non-empty after this one resolution, the
   route responds `{resolved: true, outstanding: N}` and stops there.
7. Once `outstanding` is empty, `sessions.withSession(...)` loads durable
   history and calls `resumeAgent(config, modelCall, history,
   resultsSoFar, options)` — pushes the now-complete `tool_result`
   message and picks the loop back up from "call the model again." The
   checkpoint itself is already gone by this point.
8. Two ways this can go: a genuine finish (the final answer comes back
   directly in the HTTP response to whoever called resolve/answer —
   `AgentConfig.onRunFinish` is what reaches anyone else), or another
   pending call (`result.pending` gets turned into a fresh
   `TurnCheckpoint` the same way step 3 did for the original one).

## Open questions — not yet decided

- **Magic-link/resolve-route security.** loopengine's own resolve routes
  still treat `pendingId` itself as the only credential, under whatever
  `LOOPENGINE_ADMIN_AUTH` Basic Auth is configured — that part stays
  loopengine's own trust model regardless of notification channel.
  `core/http-notify-triggers/email.ts`'s `EmailNotifier` adds a signed,
  expiring token of its own on top, one layer in front of loopengine's
  routes, specifically because a clicked email link has no signature
  header the way a chat platform's own callback does and might sit in an
  inbox for days. Real revocation (what a stale emailed link should do
  if the decision was already made via Slack) still isn't built anywhere
  — the token's own expiry is a time-bound mitigation, not revocation.
- **Per-agent webhook discovery for a background dispatcher.** For an
  agent invoked both live and in the background, exactly how the
  dispatcher-side code discovers which webhook destination to construct
  `options.approver` with, per agent. Treated as ordinary application
  wiring rather than a new protocol concept — no dispatcher has actually
  been built yet to test that assumption against.
- **A Slack-backed `DurableApprover` as a real `actauth` package class**
  (rather than loopengine's own `core/http-notify-triggers/slack.ts`) —
  see [Notification](#notification-request--raw-resolve-only) above for
  why that split is `actauth`'s own call, not loopengine's. Neither
  `SlackNotifier` nor `LarkNotifier` has been exercised against a real
  Slack/Lark app end to end yet, only reasoned through against each
  platform's documented API shape.
