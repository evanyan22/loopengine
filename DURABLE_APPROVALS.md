# Durable approvals

**Status: implemented and verified**, across two repos:
`actauth` (`Decision: 'pending'`, `DurableApprover`, `DurableWebApprover`,
`Gate.evaluate()`'s branch — `src/models.ts`, `src/approvers.ts`,
`src/gate.ts`) and loopengine (`core/durable-approvals.ts`,
`core/run-agent.ts`'s pending bucket + `resumeAgent()`,
`core/loop-events.ts`'s `loop:pending_approval`, and
`adapters/http.ts`'s `POST /pending-approvals/:pendingId/resolve`).
Verified live end to end — a real webhook firing with a checked HMAC
signature, a resolved approval resuming the turn through the normal
durable session-append path, a chained second pending call inside a
*resumed* turn, and a rejected-then-retried edited-args approval — not
just unit-tested. The design reasoning below is unchanged from how this
was built; the code sketches have been updated to match what's actually
shipped, and the "End to end" section reflects the real, verified
workflow rather than the original speculative one.

Since first shipping, `actauth`'s `Approver` interface (the live one)
was renamed to `LiveApprover`, with `Approver` becoming the union type
name (`LiveApprover | DurableApprover`) — `actauth` `0.0.9`. And the
single-value `config.approver`/`options.approver` precedence described
below was replaced with a channel-keyed map (`ApproverChannel: 'cli' |
'http' | 'http_stream'`) — see
[Where it's configured](#notification-who-finds-out-and-how) below —
fixing a real bug the single value had: an agent author's override for
one channel silently applied to every channel at once.

## The problem

`WebApprover` and `SlackApprover` (both from `actauth`) hold pending
approvals in an in-memory `Map`, with a default 5-minute timeout that
**fails closed** (auto-denies) if nobody responds. `run-agent.ts`'s loop
calls `await gate.evaluate(...)`, which awaits the approver directly — so
the entire turn is a live, suspended JavaScript call, inside one process,
for as long as the human takes.

That's the right model for genuinely live chat, where the specific
decision-maker is present on the same connection right now. It's the
wrong model for anything triggered by a business process — a support
ticket, a PR, a lead created in a CRM — where the realistic delay before
a human looks at it is minutes to days, not seconds, and the deciding
human usually isn't the one who triggered the run. A 5-minute fail-closed
timeout in that setting means the *normal* case silently auto-denies
before anyone sees it, and the suspended turn can't survive a deploy or
restart regardless of the timeout.

## The core insight

`RunAgentResult.stopReason: 'denied'` already proves the loop can end a
turn early with an unresolved `tool_use` sitting durably in session
history — `sessions.withSession` durably appends whatever `newMessages`
comes back, dangling tool call included, the same way a mid-turn crash
would produce. `sessionknit`'s own `hasUnresolvedToolCall` detection
(wired in `core/session-store.ts`) already exists to recognize exactly
that shape on resume.

So durable pause/resume isn't new infrastructure — it's **the
crash-recovery shape, entered on purpose instead of by accident**, with a
more precise continuation than the existing generic one. (Today's
`buildContinuation()` just tells the model *"treat those tools as not
having run"* — a blanket amnesty note, not something matched to a
specific `tool_use_id`. That's correct for genuine crash recovery; wrong
here, where the tool now has a real, decided outcome to report instead.)

## Execution model: bucket, then execute — never evaluate-and-immediately-act

The naive version of this (an approver that *throws* to signal "pending")
is broken: `run-agent.ts` evaluates tool_use blocks in a **sequential**
`for` loop, in whatever order the model emitted them. A thrown exception
unwinds that loop immediately — so if a gated call happens to come first
in the block order, every later block (including plain auto-allowed
ones) never even gets evaluated. That makes execution order-dependent on
something nobody should have to reason about: the order a model happened
to emit tool_use blocks in.

The fix: durable pending decisions can't be squeezed through `Approver`'s
existing `requestApproval(): Promise<boolean>` contract at all. Awaiting
a promise that only resolves when a human clicks something two days
later means the process sits blocked for two days — exactly what
durability exists to avoid — and a same-shaped promise that resolves
*fast* with a placeholder boolean is just that bug hiding inside a lie
instead of a thrown exception. The honest fix is a second, explicitly
different interface, not a reused one:

```ts
interface DurableApprover {
  requestDurableApproval(
    tool: string, args: Record<string, unknown>, scope: Scope, reason: string,
  ): { pendingId: string }   // fast — creates the pending record and returns; never awaited for the actual decision
}
```

The branching on which shape the configured approver is happens inside
`Gate.evaluate()` itself, not here — see
[Notification: who finds out, and how](#notification-who-finds-out-and-how)
below for exactly how. All `run-agent.ts` ever sees back is
`result.decision`, now with a fourth possible value (`'pending'`,
carrying a `pendingId`) alongside the existing `allow`/`ask`/`deny` — a
plain `Approver`'s `allow`/`deny` gets handled exactly as it does today,
and `pending` is the new case that goes straight into the `pending`
bucket below instead of being resolved inline. Either way the sequential
loop reaches every block regardless of where the gated one sits — no
exceptions, no hanging, and no approver-shape branching added to
`run-agent.ts` itself.

Once every block in the batch has been evaluated this way, bucket them:

```ts
const toRunNow: LaneCall[] = []         // decision: allow, no durable wait
const deniedNow: ModelContentBlock[] = [] // decision: deny, synthesize now
const pending: { toolUseId: string; tool: string; args: ...; pendingId: string }[] = []
```

`toRunNow` executes via `toolLane.run(...)` immediately, exactly as
today — a gated sibling elsewhere in the batch is irrelevant to whether
an independent, already-approved call is safe to run right now.

## Worked example

Model requests four tool calls in one turn: `lookup_order` (t1,
auto-allowed), `send_email` (t2, auto-allowed), `issue_refund` (t3, needs
approval), and a fourth gated tool (t4, also needs approval).

Evaluation (order-independent, per above): t1 and t2 land in `toRunNow`
and execute immediately, producing real results. t3 and t4 both land in
`pending`, each getting its own pending record — but **both point at the
same checkpoint**, because the eventual `tool_result` message has to
answer all four `tool_use` blocks from this one batch at once; it can't
be split across two messages.

The real shape, `core/durable-approvals.ts`:

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
  outstanding: Record<string, { toolUseId: string; tool: string; args: Record<string, unknown>; reason: string }>
  closed: boolean
}
```

At the moment the turn pauses:
- `resultsSoFar` = `[t1's real result, t2's real result]` — t1/t2 already
  have both a decision *and* a result, so they were never "outstanding"
  in the first place.
- `outstanding` = `{t3's pendingId: {...}, t4's pendingId: {...}}` — the
  calls genuinely still waiting on a human, keyed by whatever id each
  one's `DurableApprover` call handed out.

**Both approved (either order):** whichever resolves first appends its
real result and removes itself from `outstanding`; the turn stays paused
until the *second* one resolves too. Once `outstanding` is empty, the
complete four-result message is assembled and pushed durably, and the
loop continues — a fresh model call, now with the full picture.

**One denied while the other is still unresolved:** denial closes the
checkpoint **immediately**, regardless of what else is outstanding. If
t4 is denied while t3 hasn't been touched yet, t3 has to get a
synthesized `skipped` result right then (same as today's existing
"a denial cancels the whole batch, siblings that hadn't run yet get
marked skipped" behavior) — it can't be left dangling. The message gets
pushed with t1/t2's real results + t4's denial + t3's skip, and the loop
stops with `stopReason: 'denied'`, same as a synchronous denial today.

This leaves t3's own pending record pointing at an already-closed
checkpoint. If its approve/deny link gets clicked later — plausible,
since whoever owns that decision may not know a sibling was already
denied — the resolve path must treat "my checkpoint is already closed"
as a **graceful no-op**, not an error and not a second attempt to
execute or push anything. Every resolution has to check checkpoint state
first, not just its own pending-record validity.

## Content-conditional gating

The same tool can need different treatment depending on what it's being
asked to do — `send_email` auto-sends a tracking-info reply but should
pause for a refund reply. This needs no new architecture: `actauth`'s
`Gate.evaluate(tool, args, scope)` already resolves against a `RuleSet`
whose rules can carry a `when: Condition` — `{field, op, value}`,
dot-path-resolved into `args`, through a fixed op table (`eq`, `ne`,
`gt`, `gte`, `lt`, `lte`, `in`, `contains` — no `eval`, deliberately).

The one thing worth being careful about is *what* the condition checks.
Matching against free-text prose (`{ field: body, op: contains, value:
"refund" }`) is a heuristic, not a classification — it misses "money
back," false-positives on unrelated mentions of the word, and so on. The
robust version gives the tool schema an explicit enum field the model
fills in itself (`intent: 'tracking_info' | 'refund' | 'other'`) — the
model already knows why it's writing the email, so let it say so
structurally, and gate on that field with `eq` instead of scanning
prose.

Mechanically this is nothing new — it's the exact same mechanism that
already fills every other tool argument. `agents/customer-service/tools/send_email.ts`
today:

```ts
export const sendEmail: ToolDefinition = {
  name: 'send_email',
  description: 'Email the customer',
  input_schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
  execute: async (input) => `sent: ${input.body}`,
}
```

`input_schema` is a plain JSON schema handed straight to the model
(`run-agent.ts` maps `tools` → `toolSchemas` → into the model call
unchanged). The model doesn't treat `body` specially — it's "this tool
has a required string field named `body`," so it produces one. Adding
`intent` is the identical move, just another property:

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

The `description` is doing the real work here, not the field name — the
model classifies based on what it's told the field means, the same way
it already "knows" to put customer-facing prose in `body` because the
tool's own description says "email the customer." A vague or missing
`description` gets vague or wrong classification.

Enum tool-call arguments are considerably more reliable than free text
— both Anthropic's and OpenAI's tool-calling use constrained/grammar-
guided generation for arguments, not open-ended prose — but "more
reliable" isn't "guaranteed," and loopengine doesn't validate tool args
against `input_schema` before executing (confirmed: no ajv/validate step
in `run-agent.ts` — whatever the provider returns for `args` goes
straight to the tool). A malformed or unrecognized `intent` value
doesn't throw, either — `resolveField` + `eq` just evaluates `false`,
and the rule **silently falls through to the ruleset's `default_decision`**.

That makes the ruleset's *fallback* the thing that actually determines
safety. Write it positive-match-to-allow, default-to-ask — enumerate the
known-safe case and let everything else, including a malformed enum
value, fall through to a human — rather than default-to-allow with a
growing blocklist of risky cases:

```yaml
rules:
  - tool: send_email
    when: { field: intent, op: eq, value: tracking_info }
    decision: allow
default_decision: ask   # anything that isn't an exact, recognized match — including a bad value — asks
```

**This is now the actual, live ruleset**, not just an illustration —
`agents/customer-service/tools/send_email.ts` has the real `intent`
field, and `agents/customer-service/actauth.yml` has
`send-email-tracking-info-allowed` (this exact rule) declared before a
catch-all `send-email-needs-approval` (`ask`, no `when`) — same scope,
so `RuleSet`'s stable same-specificity ordering is what makes the
specific rule get tried first. Verified directly against the real rule
engine: `tracking_info` → `allow`; `refund`, a missing `intent`, and a
malformed `intent` value all → `ask`.

## Approve-with-edit

Not every pending decision is binary. The refund-reply case above is a
good example of why: even once a call is correctly routed to `ask`, the
approver's real intent usually isn't "yes/no" — it's "yes, but let me
fix the wording first." The tool call already carries the model's
drafted `args` (`{ to, subject, body }`); the approver should be able to
edit `body` and *then* approve, not just accept or reject the draft
verbatim.

This doesn't touch the checkpoint/bucket-then-execute shape at all — it
only widens the resolve request body, implemented as
`adapters/http.ts`'s `POST /pending-approvals/:pendingId/resolve`:

```ts
{ decision: 'approve' | 'deny', editedArgs?: Record<string, unknown> }
```

When `editedArgs` is present, `tool.execute(editedArgs ?? item.args)`
runs with those in place of the model's original `args` — everything
downstream (the synthesized `tool_result`, `resultsSoFar`, `outstanding`
bookkeeping) is unaffected, since as far as the loop is concerned this
is still just "t3 got approved and produced a result."

Two things confirmed while verifying this live:

- **Validation, and a real bug the first pass got wrong.** `editedArgs`
  is checked against the tool's own `input_schema` (a small hand-rolled
  required-fields check — no `ajv` dependency in this project — not full
  JSON Schema validation) before it runs, exactly as planned. What
  wasn't planned: the first working version treated a *failed* validation
  as a resolution anyway — it synthesized an error `tool_result`,
  consumed the `pendingId`, and closed the checkpoint, so a typo in
  `editedArgs` permanently burned the one chance to approve that call.
  Caught by actually testing a bad edit end to end, not just a good one.
  Fixed: an invalid `editedArgs` now returns `400` with the checkpoint
  left **completely untouched** (`withCheckpoint`'s callback returns the
  same, unmodified checkpoint plus a `validation-error` result kind) — the
  same `pendingId` is still open and can be retried with corrected args.
  Verified: reject a bad edit → `400`, no consumption → retry the exact
  same `pendingId` with valid `editedArgs` → `200`, runs for real with
  the corrected values, not the model's original draft.
- **What the model sees back.** The `tool_result` reflects what actually
  happened — the edited body that was actually sent, not the model's
  original draft — since it's built from `editedArgs`, never from
  `item.args`, once validation passes.

This also means an approval UI (Slack message, magic-link page, admin
console) needs to render pending `args` as an editable form when the
tool's schema allows it, not just an approve/deny button pair — a UI
concern, not a protocol one, but worth flagging since it's the whole
reason `args` is already exposed on `approval:pending`.

## What's durable, and where

The conversation itself needs no new storage — the assistant's
tool_use-laden message and (once complete) the answering `tool_result`
message both go through the existing session-store append path
unchanged. `TurnCheckpoint` is the one new thing that needs real durable
storage, and it doubles as its own pending-decision index — no separate
table needed, since each `pendingId` in `outstanding` already *is* the
lookup key.

Implemented as `core/durable-approvals.ts`'s `CheckpointStore`,
deliberately mirroring `session-store.ts`'s own shape: a `create()` plus
a locked read-modify-write (`withCheckpoint(pendingId, fn)`, playing the
same role `SessionStore.withSession` does), backed by `FileCheckpointStore`
(one JSON file per checkpoint, one small pointer file per `pendingId`
under `.checkpoints/`) for local dev or `RedisCheckpointStore` (a
`checkpoint:<id>` string + a `checkpoint-pending-index:<pendingId>` →
checkpoint id pointer) for multi-instance deployments, chosen by the same
`REDIS_URL`-gated `createCheckpointStore()` factory pattern
`createSessionStore()` already uses. One real difference from the
session lock: `RedisCheckpointStore`'s lock only ever needs to be held
for a quick read-modify-write, never for however long a human takes (that
wait is never inside the lock at all — see `withCheckpoint`'s own
callback shape below), so it's a short SET NX PX with retry, no renewal
loop.

`withCheckpoint(pendingId, fn)`'s callback receives the checkpoint (or
`undefined` for an unknown/already-closed `pendingId` — the graceful
no-op case) and returns `{checkpoint, result}`; the store persists
`checkpoint` (or deletes it, if `closed: true`) and hands `result` back
to the caller. `adapters/http.ts`'s resolve route uses this directly —
see "End to end" below — and it's also what makes the
[Approve-with-edit](#approve-with-edit) retry fix work: a validation
failure returns the checkpoint *unchanged* (a harmless no-op persist)
with a distinct result kind, so a bad edit never consumes the pendingId.

## Notification: who finds out, and how

Durability and notification are two separate problems — everything
above only solves the first. As things stand today, `WebApprover`
surfaces a pending approval two ways — pushed onto the SSE stream for
whatever HTTP connection requested the turn, and listable via `GET
/agents/:name/approvals` — and both require someone *already watching*.
A cron- or webhook-triggered run has no live connection and nobody
polling, so the approval is invisible by default, and (today) still
fails closed after `WebApproverOptions.timeoutMs`, default 5 minutes,
regardless. A durable `TurnCheckpoint` fixes the failing-closed part,
but does nothing on its own to get a human's attention.

Notification isn't a separate concept bolted on afterward — it's
something a `DurableApprover` implementation *does*, as part of
handling `requestDurableApproval()`, the same way `SlackApprover`
posting to Slack today isn't a step bolted onto `requestApproval()`, it
*is* `requestApproval()`.

**These classes belong in `actauth` itself, as siblings of
`WebApprover`/`SlackApprover`, not in loopengine.** `DurableWebApprover`
(a generic signed webhook POST — **implemented**, `src/approvers.ts`,
`actauth` `0.0.8`) fits the package's existing shape — checked:
`actauth`'s own `package.json` has exactly one dependency (`yaml`), and
this needs nothing beyond `fetch` and `node:crypto`'s `createHmac`.
`DurableSlackApprover` (reusing `SlackApprover`'s existing
`chat.postMessage`-with-buttons mechanics) would fit the same shape but
**hasn't been built into `actauth` itself** — still just a plausible next
one there, not implemented. A host-owned reference implementation
(exactly the same "no built-in class, build it as a `DurableApprover`
yourself" shape `database-durable-approver.ts`/`redis-durable-approver.ts`
already use) does exist now, in `examples/approver/slack-durable-approver.ts`
and its question-side sibling `examples/question-handler/slack-durable-question-handler.ts`
— chat.postMessage with Approve/Deny buttons (or, for a question,
suggested-answer buttons plus a modal for free text), a signed-request
verification function, and a handler for whatever route you wire up as
your Slack app's own Interactivity Request URL, which calls loopengine's
own `POST /pending-approvals/:id/resolve` / `POST /pending-questions/:id/answer`
once the click/submission is verified. A Lark/Feishu pair
(`examples/approver/lark-durable-approver.ts`,
`examples/question-handler/lark-durable-question-handler.ts`) follows the
identical shape, swapped to Lark's own API — its free-text answer uses a
form card rather than a modal (Lark has no modal-from-card-click
equivalent used here), flagged with lower confidence in that file's own
header comment since Lark's card schema has changed across API versions.
`DurableEmailApprover` doesn't fit that shape at all — real email needs
an SMTP client or provider SDK, a genuinely new kind of dependency — so
that one is better left for a host to build on top of
`DurableWebApprover`'s generic webhook (or via something like Composio)
rather than vendored into `actauth` alongside the dependency-free ones.

These classes can't own the *entire* request/resolve round trip the way
`WebApprover` does, though. `WebApprover.requestApproval()` can own
resolution completely because nothing has to survive past one `await` —
`decide()` settles the promise, `Gate.evaluate()` unwraps it, done. A
durable approver's "what happens after a human clicks approve" is
*resume the turn from `TurnCheckpoint`* — needs `sessionknit`, the
session store, and the model call, none of which `actauth` knows about
or should, same reason it stays agnostic of sessions and turns today. So
a `Durable*Approver` only owns the **request** side (create the pending
record, fire the notification) and a **raw resolve** entrypoint (verify
+ record a decision by `pendingId`, mirroring `WebApproverOptions`'
existing `onPending`/`onSettled` seam) — loopengine supplies the
callback that reacts to a resolved decision and actually resumes the
loop.

**Where it's configured — a channel-keyed map, not one blanket value.**
The first working version of this resolved the approver for a call as
`config.approver ?? options.approver ?? new ConsoleApprover()`
(`core/run-agent.ts`'s original single `approver` field on both
`AgentConfig` and `RunAgentOptions`). That had a real failure mode: since
`config.approver` won **outright** over everything, an agent author who
set it to a `DurableWebApprover` for background use silently broke that
same agent's live chat too — there was no way to say "just for this
channel."

Fixed by replacing the single value with a map keyed by
`ApproverChannel` (`'cli' | 'http' | 'http_stream'`, `core/agent-config.ts`)
on both sides of the same two-tier precedence:

```ts
// AgentConfig
approvers?: Partial<Record<ApproverChannel, Approver>>

// RunAgentOptions
channel?: ApproverChannel   // which channel this call is on
approver?: Approver         // this channel's own default, from the adapter

// core/run-agent.ts's resolution
const approver = (options.channel && config.approvers?.[options.channel]) ?? options.approver ?? new ConsoleApprover()
```

Same precedent as before — an agent author's explicit choice still wins
outright over the adapter's own default — just scoped to one channel
instead of clobbering all three. `adapters/cli.ts` passes `channel:
'cli'`; the streaming route passes `channel: 'http_stream'` alongside its
existing fresh-`WebApprover`-per-turn `approver`; the plain (non-
streaming) route passes `channel: 'http'`. A background/cron dispatcher
calling `runAgent()` directly is exactly the same kind of caller, and
passes its own `channel`/`approver` the same way.

One more real decision made alongside this: the plain `http` channel's
own *built-in default* changed from a live `WebApprover` (backing the
existing `raceAndRespond`/202-poll flow) to `DurableWebApprover` — that
route's own code already acknowledged it "has no live channel of its
own." It's genuinely durable-by-default now, but only when
`LOOPENGINE_DEFAULT_WEBHOOK_URL`/`LOOPENGINE_DEFAULT_WEBHOOK_SECRET` are
configured (same deployment-wide-env-var pattern `REDIS_URL`/
`LOOPENGINE_ADMIN_AUTH` already use — there's no sensible webhook target
to invent without one). When they're not set, it falls back to today's
live `WebApprover` rather than all the way to `ConsoleApprover` — the
literal "nothing configured" default would block an HTTP server request
on reading from `stdin`, which is broken, not just imperfect, so the
existing working behavior stays as the fallback-of-the-fallback instead.
`question:pending` (the `ask_user` tool) has no durable equivalent, so
the `raceAndRespond`/`sessionTurns` machinery stays fully in place
regardless — unused by default for approvals once durable is configured,
but still exactly what backs questions, and still what an agent author
gets if they explicitly set `config.approvers.http` to a live approver
themselves.

**Which decision reads which approver — that lives in `Gate.evaluate()`,
not `run-agent.ts`.** `Gate` already stores `this.approver` once, at
construction, and is the sole place a decision gets resolved and
audit-logged. It duck-types its own stored approver via a small exported
`isDurableApprover()` guard (`'requestDurableApproval' in this.approver`
under the hood) and, when the rule resolves to `ask`, dispatches to
whichever method exists — implemented essentially verbatim to this
sketch, in `actauth`'s `src/gate.ts`:

```ts
if (decision === "ask") {
  if ("requestDurableApproval" in this.approver) {
    const { pendingId } = this.approver.requestDurableApproval(tool, args, scope, reason)
    return { decision: "pending", tool, scope, matchedRule, reason, pendingId }
  }
  const approved = await this.approver.requestApproval(tool, args, scope, reason)
  decision = approved ? "allow" : "deny"
}
```

— widening `actauth`'s own `Decision` to `'allow' | 'ask' | 'deny' |
'pending'` and `EvaluationResult` with an optional `pendingId`. Real
changes to the external package, consistent with adding the
`Durable*Approver` classes there too. `run-agent.ts` never inspects the
approver itself; it just reads `result.decision` off what
`Gate.evaluate()` already returns, and the bucket-then-execute logic
from
[Execution model](#execution-model-bucket-then-execute--never-evaluate-and-immediately-act)
above gets its `pending` case for free from that one extra branch.

The notification's link back also has to survive without a live
session, the same magic-link concerns as any other durable pending
action — see the open questions below.

## `RunAgentResult`'s new `stopReason` — as shipped

```ts
export interface RunAgentResult {
  // ...
  stopReason?: 'max_turns' | 'denied' | 'pending_approval'
  pendingApproval?: {
    resultsSoFar: ModelContentBlock[]
    outstanding: { toolUseId: string; tool: string; args: Record<string, unknown>; pendingId: string; reason: string }[]
  }
}
```

`runAgent()` itself does no I/O with this — it's purely returned data;
`core/run-agent.ts`'s caller (an adapter) decides whether/how to turn it
into a durable `TurnCheckpoint`.

## End to end — the real, verified workflow

1. A message comes in (live chat, or a background trigger calling
   `runAgent()` directly with a `DurableApprover` as `options.approver`)
   → the loop evaluates the model's requested tool calls. One hits an
   `ask` rule routed to a `DurableApprover` → `Gate.evaluate()` returns
   `'pending'` with a `pendingId`, instantly, no blocking.
2. Any *other*, already-approved call in the same batch still runs for
   real right then (bucket-then-execute — a pending sibling never blocks
   safe work). The turn stops there: `stopReason: 'pending_approval'`,
   `newMessages` ending at the dangling assistant tool_use message — the
   same crash-recovery shape `session-store.ts`'s own
   `hasUnresolvedToolCall` already detects, entered on purpose.
3. The adapter (`adapters/http.ts`'s `createCheckpointFromPendingApproval`)
   turns `pendingApproval` into a durable `TurnCheckpoint` via
   `checkpoints.create(...)`. The `DurableWebApprover` has already fired
   its signed webhook, from inside step 1 — **the process can exit,
   nothing is held open.**
4. Minutes or days later: `POST /pending-approvals/:pendingId/resolve`
   with `{decision, editedArgs?}` arrives, decoupled from any live
   connection or process. `checkpoints.withCheckpoint(pendingId, fn)`
   loads the checkpoint (or hands `fn` `undefined` for an unknown/
   already-closed `pendingId` — the resolve route reports
   `{alreadyResolved: true}`, a graceful no-op, not an error).
5. `fn` executes the tool for real (validating `editedArgs` against the
   tool's schema first — an invalid edit gets `400` with the checkpoint
   left untouched, so the same `pendingId` can be retried; see
   [Approve-with-edit](#approve-with-edit)) or synthesizes a denial. A
   denial closes the whole checkpoint immediately, synthesizing
   `skipped` for any other still-outstanding item in the same batch —
   same semantics `run-agent.ts`'s own synchronous denial path already
   has.
6. If `outstanding` is still non-empty after this one resolution, the
   route responds `{resolved: true, outstanding: N}` and stops there —
   nothing to resume yet.
7. Once `outstanding` is empty, `sessions.withSession(...)` loads durable
   history and calls `resumeAgent(config, modelCall, history,
   resultsSoFar, options)` — pushes the now-complete `tool_result`
   message and picks the loop back up from "call the model again,"
   exactly like a synchronous `ask` would have continued if it had never
   needed to pause. The checkpoint itself is already gone by this point
   (deleted the moment `outstanding` hit empty, in the same store write).
8. Two ways this can go, both verified live:
   - **Genuine finish.** The resumed turn is durably appended through
     the normal `sessions.withSession` path, and the final answer comes
     back directly in the HTTP response to whoever called `/resolve`.
     Nothing else fires automatically — see the open question below on
     why that's a real, not-yet-solved gap.
   - **Another pending call.** The resumed turn's own tool requests hit
     *another* gated call — `result.pending` gets turned into a
     fresh `TurnCheckpoint` the same way step 3 did for the original one
     (a real bug in the first working version: this was silently
     dropped, leaving the new `pendingId` permanently unresolvable —
     caught by testing a two-step gated chain end to end, not by
     inspection). Verified: resolve step one → turn pauses again on step
     two → resolve step two → turn genuinely finishes.

## Durable questions (ask_user)

**Status: implemented.** The one open question this doc used to leave
unresolved — whether `question:pending` (the `system_ask_user` tool)
needs the identical treatment tool-call approvals got above — is closed:
it does, and it now gets almost exactly the same mechanism, reusing more
of the above than a fresh design would suggest.

`system_ask_user` never goes through `actauth`'s `Gate` at all (see
`core/system-tools/ask_user.ts`'s own header comment on why it can't be
gated — it's the human's only way to answer the agent in the first
place, so gating it would be circular, not just redundant). That means
its durable path can't reuse `actauth`'s `DurableApprover`/
`DurableWebApprover` — those are approval-shaped and live in a package
that has no reason to know `ask_user` exists. Everything durable-question
specific is loopengine's own code instead:

- **`DurableQuestionHandler`** (`core/agent-config.ts`) — the
  question-side sibling of `DurableApprover`, same positional-args shape
  (`notifyPendingQuestion(question, options, agent, sessionId):
  {pendingId}`, mirroring `requestDurableApproval(tool, args, scope,
  reason)`). **`DurableWebQuestionHandler`**
  (`core/system-tools/ask_user.ts`) is the one built-in implementation —
  a signed HMAC webhook POST (header `x-loopengine-signature`), same
  fire-and-forget shape as `DurableWebApprover`. A reference sending/
  receiving-side pair lives in `examples/question-handler/webhook-durable-question-handler.ts`
  (its own folder, not `examples/approver/` — this class isn't an
  actauth `Approver` at all).
- **`WebQuestionHandler`** (`core/system-tools/ask_user.ts`) — the
  *live* sibling, same relationship to `DurableWebQuestionHandler` that
  actauth's own `WebApprover` has to `DurableWebApprover`: holds the
  `Promise` open and resolves it directly via `decide()`, no webhook, no
  `pendingId` handed to a durable resolve route. This isn't new
  behavior — it's what `system_ask_user`'s live path already did before
  any of the above existed, given an instantiable, testable home instead
  of bare module-level state. One deliberate difference from
  `WebApprover`: `onPending` is a per-call argument to
  `requestQuestion()`, not a constructor option, because a question only
  ever needs *one* shared registry (unlike approvals, which get a fresh
  `WebApprover` per streamed turn specifically so each one's `onPending`
  can target that turn's own SSE connection) — the module-level
  `createAskUserTool`/`listQuestions`/`answerQuestion`/`findQuestion`
  functions are thin wrappers over one default `WebQuestionHandler`
  instance; a caller that wants an isolated registry can still construct
  its own.
- **`CliQuestionHandler`** (`core/system-tools/ask_user.ts`) — the
  cli-channel default, same relationship to `ConsoleApprover` that
  `WebQuestionHandler` has to `WebApprover`: a blocking terminal
  `rl.question()`, nothing else. Simpler than `WebQuestionHandler` — no
  `pending` map, no `list()`/`decide()` — since nothing outside the one
  call that raised it ever answers it; the terminal that asked is the
  terminal that answers, synchronously. `createAskUserTool`'s own
  `onPending`-presence check is what actually picks between the two
  (`adapters/cli.ts` passes `channel: 'cli'` but no live push callback at
  all, so it always lands on `CliQuestionHandler`; `adapters/http.ts`'s
  both routes always pass one, so they always land on
  `WebQuestionHandler`) — `options.channel` itself isn't threaded into
  `createAskUserTool` directly, since the presence of a push callback
  already is that signal.
- **Configured the same channel-keyed way, now a real type-level mirror
  of `approver`.** `AgentConfig.questionHandlers?: Partial<Record<ApproverChannel,
  QuestionHandler>>` and `RunAgentOptions.questionHandler?: QuestionHandler`,
  where `QuestionHandler = LiveQuestionHandler | DurableQuestionHandler`
  — the same union shape `Approver = LiveApprover | DurableApprover` is,
  resolved with the same two-tier precedence and the same kind of real
  hard default (`new CliQuestionHandler()`, playing `new
  ConsoleApprover()`'s role), duck-typed the identical way
  (`isDurableQuestionHandler`, mirroring `isDurableApprover`) to decide
  which branch a `system_ask_user` call takes.

  This wasn't the original shape — `questionHandler` first shipped as a
  *dedicated*, always-durable field, deliberately disjoint from the
  pre-existing live path (`RunAgentOptions.onQuestionPending`), to avoid a
  breaking change to that already-tested field. It was refactored to this
  union shape once the live/durable split settled down, for the same
  reason `approver` is one slot rather than two: less API surface, one
  resolution line instead of two independently-defaulted ones.

  **One real gap this refactor deliberately left open**, rather than
  closing halfway: only the *durable* half of the resolved
  `QuestionHandler` is actually wired to anything. The loop only ever
  calls `isDurableQuestionHandler()` on it to decide live-vs-durable; the
  live branch still falls through to `createAskUserTool`'s own,
  completely independent resolution (keyed off `onQuestionPending`'s
  presence, exactly as before this field existed) — a live
  `QuestionHandler` set via `config.questionHandlers`/`options.questionHandler`
  is accepted by the type but has no effect at runtime. Fully closing this
  gap means two further changes, each with a real cost: moving
  `system_ask_user`'s live answer-collection inline into the loop (mirroring
  how a live approval is `await`ed mid-scan in `gate.evaluate()`) would
  change today's batching semantics — right now a pending question is
  deferred until the *whole* tool_use batch is scanned and confirmed
  denial-free, so a human is never asked something that turns out moot;
  approvals don't have that property, since a live 'ask' is already
  awaited mid-scan. And making a custom `LiveQuestionHandler` actually
  reachable needs `createAskUserTool`'s own signature to change (from
  `(context, onPending?)` to accepting the resolved live handler
  directly) — a breaking change to a function `tests/ask-user.test.ts`
  calls directly.
  Left open on purpose rather than shipped half-carefully.
- **One unified pending bucket, not two parallel ones.** A gated tool
  call and a `system_ask_user` call can land in the *same* model
  response — the worked example's own reasoning about why two gated
  calls in one batch must share a single checkpoint applies identically
  here: one dangling assistant `tool_use` message can only ever get one
  completing `tool_result` message. `run-agent.ts`'s loop collects both
  kinds into one `pending: PendingItem[]` (`{kind: 'approval' |
  'question', toolUseId, tool, args, pendingId, reason}`), and
  `RunAgentResult.pending.outstanding` carries both kinds together.
  `stopReason` is `'pending_question'` only when a batch contains *no*
  approval items at all; a mixed batch reports `'pending_approval'`
  (not an arbitrary tie-break — an approval-aware caller already has to
  handle `'pending_approval'`, so this is the one choice that needs no
  new caller-side branching for the common case of a pure-approval
  batch, which stays byte-for-byte unchanged).
- **Same `CheckpointStore`, one new optional field.** No second store —
  `core/durable-approvals.ts`'s `OutstandingItem` gained one field,
  `kind?: 'approval' | 'question'`, left optional (not required)
  specifically so every checkpoint ever written before this existed
  keeps meaning exactly what it always meant (`undefined` ⇒
  `'approval'`). The store itself still does no interpreting of `kind` —
  that's entirely `adapters/http.ts`'s concern, same "this module knows
  nothing about ActAuth or the model loop" boundary as before.
- **Resolution is simpler than an approval's**, not just a copy of it:
  `POST /pending-questions/:pendingId/answer` takes `{answer: string}`
  and uses it as the completing `tool_result` content directly — no
  `tool.execute()` (a question has nothing to run), no `editedArgs`/
  schema validation, no deny/cascade-skip concept (a question is either
  answered or it isn't). It shares the exact "outstanding empty → resume
  via `resumeAgent`, else report the remaining count" tail with `POST
  /pending-approvals/:pendingId/resolve` — one function,
  `respondAfterResolution`, not duplicated logic. Each route rejects the
  other kind's `pendingId` with a `400` naming the correct route, rather
  than silently mishandling it.
- **No new adapter-level "it's pending" event for the durable path** —
  same precedent `approval:pending` already set. `defaultDurableHttpApprover`
  fires no `onPending` callback (no live SSE for the plain `/messages`
  route to push one onto), so a durable approval never emits
  `approval:pending`; only the batch-level `loop:pending_approval`
  fires. Mirrored exactly: `defaultDurableHttpQuestionHandler` fires no
  callback either, and the new `loop:pending_question` event
  (`core/loop-events.ts`) is the only signal — visibility into a durable
  question is the webhook, the response body's `stopReason`, and the
  checkpoint itself, same three as an approval.
- **Where it's wired**, `adapters/http.ts`: `LOOPENGINE_DEFAULT_QUESTION_WEBHOOK_URL`/
  `_SECRET`, falling back to the approval webhook's own env vars when
  unset — so one webhook endpoint can receive both payload shapes by
  default (a receiver tells them apart structurally: a question payload
  has `question`, an approval payload has `tool`/`scope`) — rather than
  forcing two separate endpoints for the common case. Same
  plain-route-only default as `defaultDurableHttpApprover`: the
  streaming route keeps its existing live `onQuestionPending` path
  unconditionally (it already has a live connection), unless an agent
  author opts a specific channel in via `config.questionHandlers`.

## Open questions — not yet decided

- **No automatic notification when a resumed turn genuinely finishes.**
  Surfaced by actually asking "what happens if the loop finishes":
  the only signal that a paused turn is done is the synchronous HTTP
  response to whoever called `/resolve`. If that's a human clicking a
  Slack button, they see it there; the party who originally triggered
  the run (a customer waiting on a refund, say) gets nothing unless a
  host builds it. Durability and the *pending* notification
  (`DurableWebApprover`'s webhook) are solved; a second, distinct
  "here's the outcome" notification on completion is not — same shape
  of gap as [Notification](#notification-who-finds-out-and-how) above,
  just for the other end of the workflow.
- Magic-link/resolve-route security: right now `pendingId` itself is the
  only credential — same trust model `POST /approvals/:id/approve`
  already had, under whatever `LOOPENGINE_ADMIN_AUTH` Basic Auth is
  configured. A signed, expiring token per link, with real revocation
  (what a stale emailed link should do if the decision was already made
  via Slack) is still unbuilt.
- For an agent invoked both live and in the background: exactly how the
  dispatcher-side code discovers which webhook destination to construct
  `options.approver` with per agent. Treated above as ordinary
  application wiring rather than a new protocol concept — no dispatcher
  has actually been built yet to test that assumption against.
- `DurableSlackApprover` as a real `actauth` package class (rather than a
  host-owned example) — see the "Notification" section above for why
  that's `actauth`'s own call, not loopengine's; the reference
  implementation in `examples/approver/slack-durable-approver.ts` (and
  its Lark pair) hasn't been exercised against a real Slack/Lark app end
  to end, only reasoned through against each platform's documented API
  shape.
