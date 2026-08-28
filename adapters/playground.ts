// A local dev playground: a single self-contained HTML page (no build
// step, no framework, no CDN) served by adapters/http.ts at GET
// /playground. It's a browser client on top of the *existing*
// /agents/:name/messages/stream route — nothing here talks to runAgent,
// SessionStore, or ActAuth directly; it only renders the same SSE events
// that route already emits, live, instead of leaving `curl -N` as the
// only way to see the loop actually think.
//
// Embedded as a TS string (not a separate .html file) so tsc's ordinary
// compile emits it straight into dist/adapters/ alongside http.js — no
// asset-copy step needed in the build or the Dockerfile.
//
// The inline <script> below is deliberately written without backticks or
// ${} — it lives inside this outer TS template literal, so a nested
// template literal would need every backtick/${ escaped relative to the
// outer one. Plain string concatenation sidesteps that class of bug
// entirely rather than relying on getting every escape right.
import { devUiCss } from './dev-ui-styles.js'

export const playgroundHtml: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LoopEngine Playground</title>
<style>${devUiCss}
  body {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  header {
    padding: 10px 16px;
    border-bottom: 1px solid light-dark(#ddd, #333);
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  #agentCaption {
    font-size: 12px;
    color: light-dark(#666, #999);
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  #configLink { font-size: 12px; white-space: nowrap; text-decoration: none; }
  #sessionLabel {
    margin-left: auto;
    font-size: 12px;
    font-family: ui-monospace, monospace;
    color: light-dark(#666, #999);
  }
  #sessionLabel.copyable { cursor: pointer; }
  #sessionLabel.copyable:hover { text-decoration: underline; }
  main {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  .pane {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    border-right: 1px solid light-dark(#ddd, #333);
  }
  .pane:last-child { border-right: none; }
  .sessions-pane { flex: 0 0 200px; }
  .sessions-pane .pane-body { padding: 6px; gap: 2px; }
  .session-item {
    display: flex;
    align-items: center;
    gap: 4px;
    border-radius: 6px;
    padding: 6px 8px;
    cursor: pointer;
  }
  .session-item:hover { background: light-dark(#f0f0f1, #26262b); }
  .session-item.active { background: light-dark(#dbeafe, #1e3a5f); }
  .session-item .preview {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .session-item .session-time { font-size: 10px; color: light-dark(#999, #777); flex-shrink: 0; }
  .session-item .session-remove {
    flex-shrink: 0;
    border: none;
    background: none;
    padding: 0 2px;
    font-size: 13px;
    line-height: 1;
    color: light-dark(#999, #777);
    display: none;
  }
  .session-item:hover .session-remove { display: block; }
  .session-item .session-remove:hover { color: light-dark(#991b1b, #f87171); }
  .pane h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: light-dark(#666, #999);
    margin: 0;
    padding: 8px 12px;
    border-bottom: 1px solid light-dark(#eee, #2a2a2e);
  }
  .pane-body {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .msg { max-width: 90%; }
  .msg-label {
    font-size: 10px;
    text-transform: uppercase;
    color: light-dark(#999, #777);
    margin-bottom: 2px;
  }
  .msg-body {
    padding: 8px 10px;
    border-radius: 8px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .msg-user { align-self: flex-end; }
  .msg-user .msg-body { background: light-dark(#dbeafe, #1e3a5f); }
  .msg-assistant .msg-body { background: light-dark(#fff, #2a2a2e); border: 1px solid light-dark(#ddd, #3a3a3e); }
  .msg-error .msg-body { background: light-dark(#fee2e2, #4a1f1f); color: light-dark(#991b1b, #f87171); }
  .msg-stopped .msg-body { font-style: italic; color: light-dark(#666, #999); background: light-dark(#f3f3f4, #26262b); }
  .msg-thinking .msg-body { display: inline-flex; gap: 4px; padding: 11px 10px; }
  .msg-approval .msg-body {
    background: light-dark(#fefce8, #422006);
    border: 1px solid light-dark(#eab308, #a16207);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .approval-tool { font-family: ui-monospace, monospace; font-weight: 600; }
  .approval-scope { font-size: 11px; color: light-dark(#666, #999); }
  .approval-reason { font-size: 12px; }
  .approval-args {
    font-size: 11px;
    margin: 0;
    background: light-dark(#fff, #26262b);
    border-radius: 6px;
    padding: 6px 8px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .approval-actions { display: flex; gap: 8px; }
  .approval-actions button { font-size: 12px; padding: 5px 12px; }
  .approval-actions .approve { background: light-dark(#dcfce7, #14532d); }
  .approval-actions .deny { background: light-dark(#fee2e2, #450a0a); }
  .approval-status { font-size: 12px; font-style: italic; color: light-dark(#666, #999); }
  .msg-question .msg-body {
    background: light-dark(#eff6ff, #1e293b);
    border: 1px solid light-dark(#3b82f6, #60a5fa);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .question-text { font-size: 13px; }
  .question-options { display: flex; flex-wrap: wrap; gap: 6px; }
  .question-options button { font-size: 12px; padding: 5px 12px; }
  .question-answer-row { display: flex; gap: 6px; }
  .question-answer-row input { flex: 1; font-size: 12px; }
  .question-answer-row button { font-size: 12px; padding: 5px 12px; }
  .question-status { font-size: 12px; font-style: italic; color: light-dark(#666, #999); }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: light-dark(#999, #777);
    animation: dot-blink 1.4s infinite both;
  }
  .dot:nth-child(2) { animation-delay: 0.2s; }
  .dot:nth-child(3) { animation-delay: 0.4s; }
  @keyframes dot-blink { 0%, 80%, 100% { opacity: 0.2; } 40% { opacity: 1; } }
  .empty-hint { padding: 10px 2px; }
  .event {
    border-left: 3px solid light-dark(#ccc, #444);
    padding: 4px 8px;
    font-size: 12px;
  }
  .event-label { font-weight: 600; font-family: ui-monospace, monospace; }
  .event-data {
    margin: 2px 0 0;
    font-family: ui-monospace, monospace;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    color: light-dark(#444, #aaa);
  }
  .event-actauth { border-left-color: #f59e0b; }
  .event-toollane { border-left-color: #3b82f6; }
  .event-contextclip { border-left-color: #8b5cf6; }
  .event-reflow { border-left-color: #ef4444; }
  .event-skillgarden { border-left-color: #10b981; }
  .event-loop { border-left-color: #6b7280; }
  .event-approval { border-left-color: #eab308; }
  .event-question { border-left-color: #3b82f6; }
  .composer {
    border-top: 1px solid light-dark(#ddd, #333);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .send-row { display: flex; gap: 8px; }
  #messageInput { flex: 1; resize: vertical; height: 90px; }
  #messageInput:disabled, #sendButton:disabled { cursor: not-allowed; }
  details summary { cursor: pointer; font-size: 12px; color: light-dark(#666, #999); }
  .advanced-hint { margin: 6px 0 0; font-size: 11px; }
  .advanced-fields { display: flex; gap: 8px; margin-top: 6px; }
  .advanced-fields > div { flex: 1; display: flex; flex-direction: column; gap: 4px; }
  .advanced-fields label { font-size: 11px; color: light-dark(#666, #999); }
  .advanced-fields textarea { height: 50px; font-family: ui-monospace, monospace; font-size: 11px; resize: vertical; }
  @media (max-width: 720px) {
    main { flex-direction: column; }
    .pane { border-right: none; border-bottom: 1px solid light-dark(#ddd, #333); min-height: 160px; }
    .pane:last-child { border-bottom: none; }
    .sessions-pane { flex-basis: auto; }
  }
</style>
</head>
<body>
<nav class="topnav">
  <a href="/agents">Agents</a>
  <a href="/agents/config">Config</a>
  <a href="/playground" class="active">Playground</a>
</nav>
<header>
  <h1>LoopEngine Playground</h1>
  <select id="agentSelect"></select>
  <span id="agentCaption"></span>
  <button id="newConversationButton" type="button">New conversation</button>
  <a id="configLink" href="/agents/config">Agent config &rarr;</a>
  <span id="sessionLabel">session: (new)</span>
</header>
<main>
  <section class="pane sessions-pane">
    <h2>Sessions</h2>
    <div class="pane-body" id="sessionsPane"></div>
  </section>
  <section class="pane">
    <h2>Chat</h2>
    <div class="pane-body" id="chatPane"></div>
    <div class="composer">
      <details>
        <summary>Advanced</summary>
        <p class="advanced-hint muted">For agents whose sessionIdFor/tenantFor need something beyond a plain sessionId — e.g. customer-service reads customerEmail from the body.</p>
        <div class="advanced-fields">
          <div>
            <label for="extraHeadersInput">Extra headers (one "key: value" per line)</label>
            <textarea id="extraHeadersInput" placeholder="x-api-key: acme-trusted-key"></textarea>
          </div>
          <div>
            <label for="extraBodyInput">Extra body fields (JSON)</label>
            <textarea id="extraBodyInput" placeholder='{"customerEmail": "a@example.com"}'></textarea>
          </div>
        </div>
      </details>
      <div class="send-row">
        <textarea id="messageInput" placeholder="Message&hellip; (Enter to send, Shift+Enter for a new line)"></textarea>
        <button id="sendButton" type="button">Send</button>
      </div>
    </div>
  </section>
  <section class="pane">
    <h2>Loop events</h2>
    <div class="pane-body" id="timelinePane"></div>
  </section>
</main>
<script>
(function () {
  var agentSelect = document.getElementById('agentSelect');
  var agentCaption = document.getElementById('agentCaption');
  var configLink = document.getElementById('configLink');
  var sessionLabel = document.getElementById('sessionLabel');
  var chatPane = document.getElementById('chatPane');
  var timelinePane = document.getElementById('timelinePane');
  var sessionsPane = document.getElementById('sessionsPane');
  var messageInput = document.getElementById('messageInput');
  var sendButton = document.getElementById('sendButton');
  var newConversationButton = document.getElementById('newConversationButton');
  var extraHeadersInput = document.getElementById('extraHeadersInput');
  var extraBodyInput = document.getElementById('extraBodyInput');

  var currentAgents = [];
  var sessionId = null;
  var isSending = false;
  var thinkingEl = null;
  // Set right before a message is sent, consumed by handleFrame's own
  // 'session' branch once the server echoes back which sessionId this
  // turn actually used (brand new or resumed) — that's the only point
  // this code knows for certain "this session id is real and this is
  // what the user just said to it," the two things rememberSession needs.
  var lastSentMessage = null;

  // Keyed by tool_use id — a 'tool:started' card (see appendToolCallCard
  // below) parks its status <div> here so the later 'tool:result' event
  // for the exact same call (run-agent.ts emits both with the same id)
  // can update it in place instead of appending a second, redundant card.
  // Cleared on every conversation switch (resetConversation/resumeSession)
  // since a card from a previous session/turn is never a valid update
  // target for one that happens to reuse an id namespace.
  var toolCallCardsById = {};

  // A page refresh only ever loses *this tab's* JS state — the actual
  // conversation is durably stored server-side (see session-store.ts).
  // What's missing after a refresh is just "which session ids did I
  // start," so a browser-local list of {agent, sessionId, preview,
  // updatedAt} is enough to rebuild a resumable list; GET
  // /agents/:name/sessions/:id (resumeSession below) rehydrates the full
  // conversation from the real store once one's picked.
  var SESSIONS_STORAGE_KEY = 'loopengine-playground-sessions';
  var MAX_SAVED_SESSIONS = 50;

  function clearEmptyHint(pane) {
    var hint = pane.querySelector('.empty-hint');
    if (hint) hint.remove();
  }

  function setEmptyHint(pane, text) {
    pane.innerHTML = '';
    var p = document.createElement('p');
    p.className = 'empty-hint muted';
    p.textContent = text;
    pane.appendChild(p);
  }

  function appendChatMessage(role, text) {
    clearEmptyHint(chatPane);
    var div = document.createElement('div');
    div.className = 'msg msg-' + role;
    var label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = role;
    var body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = text;
    div.appendChild(label);
    div.appendChild(body);
    chatPane.appendChild(div);
    chatPane.scrollTop = chatPane.scrollHeight;
    return div;
  }

  // Only ever called for a resumeContext'd card (see decide()/answer()
  // below, both gated on it the same way) — a live SSE-pushed card has no
  // resumeContext and never calls this, since its own connection already
  // independently shows whatever comes next via handleFrame. Renders
  // exactly what that same live connection would have shown for this
  // response: another pending card, or the final text — the decide/
  // answer response itself already says which (see adapters/http.ts's own
  // raceAndRespond), so there's nothing left to poll or replay history
  // for. Replaced pollForCompletion, which used to re-fetch and replay
  // session history to find out the same thing.
  function applyDecisionResult(respBody, resumeContext) {
    if (respBody.pending) {
      if (respBody.type === 'question') appendQuestionCard(respBody, resumeContext);
      else appendApprovalCard(respBody, resumeContext);
      return;
    }
    var doneEl = appendChatMessage('assistant', respBody.text);
    if (respBody.stopReason) doneEl.classList.add('msg-stopped');
  }

  // A 'ask' decision arrived mid-turn (see run-agent.ts's gate.evaluate)
  // and the server's default approver is now a tracked WebApprover (see
  // web-approver.ts's createTrackedApprover) instead of a blocking
  // terminal prompt — it parked this one and pushed it straight onto this
  // exact SSE connection via onPending, so it can be decided right here
  // instead of on a page
  // nobody's watching. The rest of the turn (toollane:result, done, ...)
  // keeps streaming into this same response once decide() resolves it.
  function appendApprovalCard(data, resumeContext) {
    clearEmptyHint(chatPane);
    var div = document.createElement('div');
    div.className = 'msg msg-assistant msg-approval';
    var label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = 'approval needed';
    var body = document.createElement('div');
    body.className = 'msg-body';

    var tool = document.createElement('div');
    tool.className = 'approval-tool';
    tool.textContent = data.tool;

    var scope = document.createElement('div');
    scope.className = 'approval-scope';
    scope.textContent = data.scope.tenant + '/' + data.scope.environment + '/' + data.scope.agent;

    var reason = document.createElement('div');
    reason.className = 'approval-reason';
    reason.textContent = data.reason;

    var pre = document.createElement('pre');
    pre.className = 'approval-args';
    pre.textContent = JSON.stringify(data.args, null, 2);

    var actions = document.createElement('div');
    actions.className = 'approval-actions';
    var approveBtn = document.createElement('button');
    approveBtn.type = 'button';
    approveBtn.className = 'approve';
    approveBtn.textContent = 'Approve';
    var denyBtn = document.createElement('button');
    denyBtn.type = 'button';
    denyBtn.className = 'deny';
    denyBtn.textContent = 'Deny';
    actions.appendChild(approveBtn);
    actions.appendChild(denyBtn);

    body.appendChild(tool);
    body.appendChild(scope);
    body.appendChild(reason);
    body.appendChild(pre);
    body.appendChild(actions);
    div.appendChild(label);
    div.appendChild(body);
    chatPane.appendChild(div);
    chatPane.scrollTop = chatPane.scrollHeight;

    function decide(approved) {
      approveBtn.disabled = true;
      denyBtn.disabled = true;
      // Live connection only: shown *synchronously*, before fetch() even
      // starts — not inside its .then(). adapters/http.ts's own decide
      // route now races the rest of the turn the same way POST /messages
      // does (see raceAndRespond), so this response and the SSE 'done'/
      // 'approval:pending' event for the very same outcome can land in
      // either order — confirmed live. Calling showThinking() here is
      // guaranteed to happen before either one, since nothing async can
      // run before this synchronous click handler finishes; putting it in
      // the .then() instead meant that whenever the SSE frame won the
      // race and called removeThinking() *first*, this call landed after
      // and left an orphaned thinking indicator nothing would ever clear
      // — the "stuck on pending" bug.
      if (!resumeContext) showThinking();
      fetch('/approvals/' + encodeURIComponent(data.id) + '/' + (approved ? 'approve' : 'deny'), { method: 'POST' })
        .then(function (r) {
          return r.json().then(function (respBody) {
            if (!r.ok) throw new Error(respBody.error || ('HTTP ' + r.status));
            return respBody;
          });
        })
        .then(function (respBody) {
          actions.remove();
          var status = document.createElement('div');
          status.className = 'approval-status';
          status.textContent = approved ? 'Approved.' : 'Denied.';
          body.appendChild(status);
          // Resumed: no live connection to show what's next on its own,
          // so use the response directly (see applyDecisionResult).
          // Live: nothing further to do here — the SSE stream (which may
          // well have already fired by now) is what shows whatever comes
          // next; this response was only ever needed to confirm the
          // decision was recorded.
          if (resumeContext) applyDecisionResult(respBody, resumeContext);
        })
        .catch(function (err) {
          approveBtn.disabled = false;
          denyBtn.disabled = false;
          if (!resumeContext) removeThinking();
          alert('Could not record decision: ' + err.message);
        });
    }

    approveBtn.addEventListener('click', function () { decide(true); });
    denyBtn.addEventListener('click', function () { decide(false); });
  }

  // The model called the system ask_user tool (see
  // system-tools/ask_user.ts) — same "parked and pushed onto this exact
  // SSE connection" mechanism appendApprovalCard uses, just answered with
  // an arbitrary string instead of a fixed allow/deny. Suggested options
  // (if the model gave any) render as one-click buttons; free text is
  // always available too, since the tool never restricts the answer to
  // just those.
  function appendQuestionCard(data, resumeContext) {
    clearEmptyHint(chatPane);
    var div = document.createElement('div');
    div.className = 'msg msg-assistant msg-question';
    var label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = 'answer needed';
    var body = document.createElement('div');
    body.className = 'msg-body';

    var text = document.createElement('div');
    text.className = 'question-text';
    text.textContent = data.question;
    body.appendChild(text);

    var optionsRow = null;
    if (data.options && data.options.length) {
      optionsRow = document.createElement('div');
      optionsRow.className = 'question-options';
      for (var i = 0; i < data.options.length; i++) {
        (function (option) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = option;
          btn.addEventListener('click', function () { answer(option); });
          optionsRow.appendChild(btn);
        })(data.options[i]);
      }
      body.appendChild(optionsRow);
    }

    var answerRow = document.createElement('div');
    answerRow.className = 'question-answer-row';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Type an answer\\u2026';
    var sendBtn = document.createElement('button');
    sendBtn.type = 'button';
    sendBtn.textContent = 'Send';
    answerRow.appendChild(input);
    answerRow.appendChild(sendBtn);
    body.appendChild(answerRow);

    div.appendChild(label);
    div.appendChild(body);
    chatPane.appendChild(div);
    chatPane.scrollTop = chatPane.scrollHeight;
    input.focus();

    function answer(value) {
      if (!value) return;
      input.disabled = true;
      sendBtn.disabled = true;
      if (optionsRow) optionsRow.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      // See appendApprovalCard's own decide() for why this fires
      // synchronously, before fetch(), instead of inside its .then() —
      // same race against the SSE stream, same fix.
      if (!resumeContext) showThinking();
      fetch('/questions/' + encodeURIComponent(data.id) + '/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer: value }),
      })
        .then(function (r) {
          return r.json().then(function (respBody) {
            if (!r.ok) throw new Error(respBody.error || ('HTTP ' + r.status));
            return respBody;
          });
        })
        .then(function (respBody) {
          answerRow.remove();
          if (optionsRow) optionsRow.remove();
          var status = document.createElement('div');
          status.className = 'question-status';
          status.textContent = 'Answered: ' + value;
          body.appendChild(status);
          if (resumeContext) applyDecisionResult(respBody, resumeContext);
        })
        .catch(function (err) {
          input.disabled = false;
          sendBtn.disabled = false;
          if (optionsRow) optionsRow.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
          if (!resumeContext) removeThinking();
          alert('Could not send answer: ' + err.message);
        });
    }

    sendBtn.addEventListener('click', function () { answer(input.value.trim()); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') answer(input.value.trim());
    });
  }

  // Every tool call reconstructed from stored history (see
  // renderHistoryMessage below) — success, denied, or skipped alike — same
  // look as a live/resumed appendApprovalCard, minus Approve/Deny (already
  // resolved either way) and minus scope (not something a tool_result's
  // plain string content carries, and not worth threading
  // agent/tenant/environment all the way through just to show three words
  // nobody's questioning by this point). Without this, a refresh
  // collapsed a denied call down to one bare "Denied: <tool> (<reason>)"
  // line and a successful one down to nothing at all — confirmed live
  // that refreshing after approving firecrawl_FIRECRAWL_SCRAPE left no
  // way to see what URL had even been requested, or what it returned.
  //
  // Same yellow .msg-approval styling regardless of outcome (approved,
  // denied, skipped, or error) — statusText is the only thing that
  // changes; deliberately not recolored per outcome afterward.
  //
  // Labeled the same as the live card this same event would have shown
  // ("approval needed"/appendApprovalCard, "answer needed"/
  // appendQuestionCard) — not a distinct "tool call" label — so live and
  // refreshed views of the exact same event read the same way instead of
  // looking like two different kinds of thing.
  function appendToolCallCard(toolName, args, detailText, statusText, id) {
    clearEmptyHint(chatPane);
    var div = document.createElement('div');
    div.className = 'msg msg-assistant msg-approval';
    var label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = toolName === 'system_ask_user' ? 'answer needed' : 'approval needed';
    var body = document.createElement('div');
    body.className = 'msg-body';

    var tool = document.createElement('div');
    tool.className = 'approval-tool';
    tool.textContent = toolName;
    body.appendChild(tool);

    if (detailText) {
      var reason = document.createElement('div');
      reason.className = 'approval-reason';
      reason.textContent = detailText;
      body.appendChild(reason);
    }

    if (args !== undefined) {
      var pre = document.createElement('pre');
      pre.className = 'approval-args';
      pre.textContent = JSON.stringify(args, null, 2);
      body.appendChild(pre);
    }

    var status = document.createElement('div');
    status.className = 'approval-status';
    status.textContent = statusText;
    body.appendChild(status);

    div.appendChild(label);
    div.appendChild(body);
    chatPane.appendChild(div);
    chatPane.scrollTop = chatPane.scrollHeight;
    // Only a 'tool:started' card (the one phase with a real "later update"
    // coming) registers itself here — see updateToolCallCard below.
    if (id) toolCallCardsById[id] = status;
    return div;
  }

  // Turns a 'tool:started' card's "Running…" placeholder into its real
  // outcome in place, rather than appending a second card right under it
  // — same call, same id, just the second half of the same event pushed
  // by run-agent.ts once execution actually finishes. Returns whether an
  // in-place update happened; the caller falls back to a fresh
  // appendToolCallCard when it didn't (a denied/skipped call, which never
  // gets a 'tool:started' card in the first place, or an interactively-
  // asked call this handleFrame chose not to render one for at all —
  // see wasAskedInteractively below).
  function updateToolCallCard(id, statusText) {
    var status = id && toolCallCardsById[id];
    if (!status) return false;
    delete toolCallCardsById[id];
    status.textContent = statusText;
    return true;
  }

  // run-agent.ts is a pure engine now: 'tool:started'/'tool:result' fire
  // unconditionally for every call, whether or not a human was actually
  // asked live via an approval card (see appendApprovalCard). Deciding
  // whether that duplicates something already on screen is a rendering
  // call, made here instead. actauth's own Gate only ever appends this
  // exact suffix to a decision's reason when the rule it matched said
  // 'ask' in the first place (see actauth's own gate.ts) - the one
  // reliable way to tell "a human was actually asked, live" apart from a
  // straight allow/deny rule that never asked anyone anything. Without
  // this check, every interactively-approved or -denied call shows up
  // twice: once as the approval card itself, once more as a redundant
  // second "approval needed" card right under it.
  function wasAskedInteractively(detailText) {
    return !!detailText && (detailText.indexOf(' \\u2014 human approved') !== -1 || detailText.indexOf(' \\u2014 human denied') !== -1);
  }

  function showThinking() {
    var div = appendChatMessage('assistant', '');
    div.classList.add('msg-thinking');
    div.querySelector('.msg-body').innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
    thinkingEl = div;
  }

  function removeThinking() {
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  function eventCategory(eventName) {
    var idx = eventName.indexOf(':');
    return idx === -1 ? '' : 'event-' + eventName.slice(0, idx);
  }

  function loadSavedSessions() {
    try {
      var raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      return [];
    }
  }

  function saveSavedSessions(list) {
    try {
      localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(list));
    } catch (err) {
      // best-effort — private browsing / a full quota just means this
      // session won't be in the list after a refresh, not a hard failure.
    }
  }

  // Most-recently-used first, one entry per {agent, sessionId} (a resumed
  // session that gets a new message moves back to the top instead of
  // duplicating), capped so this can't grow without bound over a long
  // browser lifetime.
  function rememberSession(agent, id, preview) {
    var list = loadSavedSessions().filter(function (s) { return !(s.agent === agent && s.sessionId === id); });
    list.unshift({ agent: agent, sessionId: id, preview: preview, updatedAt: Date.now() });
    if (list.length > MAX_SAVED_SESSIONS) list = list.slice(0, MAX_SAVED_SESSIONS);
    saveSavedSessions(list);
    renderSessionsPane();
  }

  function forgetSession(agent, id) {
    saveSavedSessions(loadSavedSessions().filter(function (s) { return !(s.agent === agent && s.sessionId === id); }));
    renderSessionsPane();
  }

  // Same "browser-local, best-effort" fallback rememberSession's own
  // preview field already is (see its doc comment) — just for the
  // in-flight turn's *assistant* text instead of the user's own message.
  // Written every time a live 'assistant:text' event arrives (see
  // handleFrame below) and cleared the moment the turn actually finishes
  // ('done'/'error'), so a resume finds it set only while genuinely
  // waiting on a still-pending approval/question — exactly the window
  // resumeSession's own history fetch can't see into yet (see its own
  // doc comment on why the *user's* message needs the same treatment).
  function updateSessionField(agent, id, field, value) {
    var list = loadSavedSessions();
    for (var i = 0; i < list.length; i++) {
      if (list[i].agent === agent && list[i].sessionId === id) {
        list[i][field] = value;
        saveSavedSessions(list);
        return;
      }
    }
  }

  function formatRelativeTime(ms) {
    var minutes = Math.round((Date.now() - ms) / 60000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return minutes + 'm';
    var hours = Math.round(minutes / 60);
    if (hours < 24) return hours + 'h';
    return Math.round(hours / 24) + 'd';
  }

  function renderSessionsPane() {
    var agent = agentSelect.value;
    var list = loadSavedSessions().filter(function (s) { return s.agent === agent; });
    sessionsPane.textContent = '';
    if (!list.length) {
      setEmptyHint(sessionsPane, 'No saved sessions yet.');
      return;
    }
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      var div = document.createElement('div');
      div.className = 'session-item' + (item.sessionId === sessionId ? ' active' : '');
      var preview = document.createElement('span');
      preview.className = 'preview';
      preview.textContent = item.preview || '(empty)';
      var time = document.createElement('span');
      time.className = 'session-time';
      time.textContent = formatRelativeTime(item.updatedAt);
      var removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'session-remove';
      removeBtn.textContent = '\\u00d7';
      removeBtn.title = 'Remove from this list';
      div.appendChild(preview);
      div.appendChild(time);
      div.appendChild(removeBtn);
      (function (item) {
        div.addEventListener('click', function () { resumeSession(item); });
        removeBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          forgetSession(item.agent, item.sessionId);
        });
      })(item);
      sessionsPane.appendChild(div);
    }
  }

  // Every tool_use/tool_result pair reconstructs as a tool call card (see
  // appendToolCallCard above) — approved and successful, denied, or
  // skipped alike, not just the denied/skipped subset this used to be
  // limited to. A refresh used to leave a successful call with zero trace
  // it ever happened (that used to be "what the Loop events pane is
  // for," but that pane only ever covers the *live* run that produced it,
  // never a resumed one) — confirmed live that resuming a session after
  // approving a tool call left no way to see what it was even called
  // with, or what it returned. toolCallsById correlates a tool_result
  // back to which tool it's for (by tool_use_id) across the two separate
  // messages that always bundle them — threaded in from resumeSession's
  // own render loop below, one map per session render.
  function renderHistoryMessage(msg, toolCallsById) {
    if (Array.isArray(msg.content)) {
      for (var i = 0; i < msg.content.length; i++) {
        var block = msg.content[i];
        if (block.type === 'tool_use') {
          toolCallsById[block.id] = { name: block.name, input: block.input };
        } else if (block.type === 'tool_result' && typeof block.content === 'string') {
          var call = toolCallsById[block.tool_use_id];
          var toolName = call ? call.name : 'a tool call';
          var toolArgs = call ? call.input : undefined;
          // Plain prefix checks, not a regex — this whole file is one
          // outer TS template literal (see its own top-of-file doc
          // comment), so an unrecognized backslash escape gets silently
          // dropped when TS compiles it, and a two-character regex class
          // meant to match any character including newlines quietly
          // turned into a class that only matches two literal letters in
          // the actually served script — confirmed by extracting and
          // inspecting the real served script, not just re-typing the
          // intended pattern in a standalone test file (which doesn't go
          // through this file's own compile step, so never would have
          // caught this). That silently broke every denied/skipped
          // reconstruction earlier this session, the whole time.
          var deniedPrefix = 'denied: ';
          var skippedPrefix = 'skipped: ';
          if (!block.is_error) {
            // block.reason (see run-agent.ts's own ModelContentBlock.reason)
            // is the actauth decision's own "matched rule '...'" text —
            // the tool's actual return value is deliberately not shown
            // here (that's the Loop events pane's job for the live run
            // that produced it); this card is about *why it was allowed*,
            // not what it returned.
            appendToolCallCard(toolName, toolArgs, block.reason, 'Approved.');
          } else if (block.content.indexOf(deniedPrefix) === 0) {
            appendToolCallCard(toolName, toolArgs, block.content.slice(deniedPrefix.length), 'Denied.');
          } else if (block.content.indexOf(skippedPrefix) === 0) {
            appendToolCallCard(toolName, toolArgs, block.content.slice(skippedPrefix.length), 'Skipped.');
          } else {
            appendToolCallCard(toolName, toolArgs, block.content, 'Error.');
          }
        }
      }
    }

    if (typeof msg.content === 'string') {
      appendChatMessage(msg.role, msg.content);
      return;
    }
    if (!Array.isArray(msg.content)) return;
    var text = msg.content
      .filter(function (b) { return b.type === 'text'; })
      .map(function (b) { return b.text; })
      .join('\\n');
    if (text) appendChatMessage(msg.role, text);
  }

  function resumeSession(item) {
    if (isSending || item.sessionId === sessionId) return;
    agentSelect.value = item.agent;
    updateCaption();
    sessionId = item.sessionId;
    sessionLabel.textContent = 'session: ' + sessionId;
    sessionLabel.title = 'Click to copy session id';
    sessionLabel.classList.add('copyable');
    chatPane.textContent = '';
    toolCallCardsById = {};
    setEmptyHint(timelinePane, 'Loop events (tool calls, permission checks, budget checks) will appear here as the agent runs.');
    renderSessionsPane();

    fetch('/agents/' + encodeURIComponent(item.agent) + '/sessions/' + encodeURIComponent(item.sessionId))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var history = data.history || [];
        var lastRenderedUserText = null;
        var toolCallsById = {};
        for (var i = 0; i < history.length; i++) {
          renderHistoryMessage(history[i], toolCallsById);
          if (history[i].role === 'user' && typeof history[i].content === 'string') lastRenderedUserText = history[i].content;
        }
        if (!history.length) setEmptyHint(chatPane, 'This session has no messages yet.');
        // The turn that's currently pending (see checkForPendingItems
        // below), if there is one, hasn't been persisted at all yet —
        // withSession only appends a whole turn once it fully completes,
        // human-wait included (see session-store.ts's own withSession) —
        // so the very message that triggered it wouldn't show up above,
        // making the pending card look like it came out of nowhere. The
        // sidebar already has it locally regardless (rememberSession
        // saves it the moment it's sent), so fall back to that instead.
        if (item.preview && item.preview !== lastRenderedUserText) {
          clearEmptyHint(chatPane);
          appendChatMessage('user', item.preview);

          // Same reasoning, one message later: the turn's own assistant
          // text (its "I'll do X" alongside the tool_use an approval/
          // question card is about) hasn't persisted yet either, for the
          // exact same reason the user's own message above hasn't — only
          // reachable inside this branch since it can only be genuinely
          // pending when the user message itself is too (withSession
          // persists a whole turn atomically, never half of one).
          // pendingAssistantText is written live by handleFrame's own
          // 'assistant:text' branch and cleared the moment the turn
          // actually finishes, so a stale leftover here can't happen —
          // it's only ever set while this exact window is still open.
          // Without this, resuming while an approval/question is pending
          // showed only the bare card, with the reasoning it was
          // responding to nowhere on the page until the card was decided.
          if (item.pendingAssistantText) appendChatMessage('assistant', item.pendingAssistantText);
        }
        checkForPendingItems(item.agent, item.sessionId);
      })
      .catch(function (err) {
        setEmptyHint(chatPane, 'Could not load this session: ' + err.message);
      });
  }

  function checkForPendingItems(agent, sessionId) {
    var resumeContext = { agent: agent, sessionId: sessionId };
    fetch('/agents/' + encodeURIComponent(agent) + '/sessions/' + encodeURIComponent(sessionId) + '/questions')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var questions = data.questions || [];
        for (var i = 0; i < questions.length; i++) appendQuestionCard(questions[i], resumeContext);
      })
      .catch(function () {});
    fetch('/agents/' + encodeURIComponent(agent) + '/sessions/' + encodeURIComponent(sessionId) + '/approvals')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var approvals = data.approvals || [];
        for (var i = 0; i < approvals.length; i++) appendApprovalCard(approvals[i], resumeContext);
      })
      .catch(function () {});
  }

  function appendTimelineEntry(eventName, data) {
    clearEmptyHint(timelinePane);
    var div = document.createElement('div');
    div.className = 'event ' + eventCategory(eventName);
    var label = document.createElement('div');
    label.className = 'event-label';
    label.textContent = eventName;
    var pre = document.createElement('pre');
    pre.className = 'event-data';
    // Every LoopEvent's own 'type' field already duplicates eventName
    // (the SSE event name above it) - stripped here so the JSON blob
    // shows only what's specific to this event, not the label twice.
    var displayData = data;
    if (data && typeof data === 'object' && 'type' in data) {
      displayData = Object.assign({}, data);
      delete displayData.type;
    }
    pre.textContent = JSON.stringify(displayData, null, 2);
    div.appendChild(label);
    div.appendChild(pre);
    timelinePane.appendChild(div);
    timelinePane.scrollTop = timelinePane.scrollHeight;
  }

  function parseExtraHeaders(text) {
    var result = {};
    var lines = text.split('\\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      var idx = line.indexOf(':');
      if (idx === -1) continue;
      var key = line.slice(0, idx).trim();
      var value = line.slice(idx + 1).trim();
      if (key) result[key] = value;
    }
    return result;
  }

  function parseExtraBody(text) {
    var trimmed = text.trim();
    if (!trimmed) return {};
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      appendChatMessage('error', 'Extra body fields must be valid JSON: ' + err.message);
      return null;
    }
  }

  function updateCaption() {
    var name = agentSelect.value;
    if (!currentAgents.length) {
      agentCaption.textContent = 'No agents registered — add one under agents/.';
      configLink.style.display = 'none';
      return;
    }
    configLink.style.display = '';
    var agent = null;
    for (var i = 0; i < currentAgents.length; i++) {
      if (currentAgents[i].name === name) { agent = currentAgents[i]; break; }
    }
    agentCaption.textContent = agent ? agent.systemPrompt : '';
    configLink.href = '/agents/config' + (name ? '?agent=' + encodeURIComponent(name) : '');
  }

  function updateSendButtonState() {
    sendButton.disabled = isSending || !messageInput.value.trim() || !agentSelect.value;
  }

  function setSending(sending) {
    isSending = sending;
    var hasAgents = currentAgents.length > 0;
    messageInput.disabled = sending || !hasAgents;
    agentSelect.disabled = sending || !hasAgents;
    newConversationButton.disabled = sending;
    sendButton.textContent = sending ? 'Sending\\u2026' : 'Send';
    updateSendButtonState();
  }

  function resetConversation() {
    sessionId = null;
    toolCallCardsById = {};
    removeThinking();
    sessionLabel.textContent = 'session: (new)';
    sessionLabel.classList.remove('copyable');
    sessionLabel.title = '';
    var name = agentSelect.value;
    setEmptyHint(chatPane, name ? 'No messages yet \\u2014 say hi to ' + name + '.' : 'No messages yet \\u2014 pick an agent above to get started.');
    setEmptyHint(timelinePane, 'Loop events (tool calls, permission checks, budget checks) will appear here as the agent runs.');
    renderSessionsPane();
  }

  function loadAgents() {
    fetch('/agents')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        currentAgents = data.agents || [];
        agentSelect.textContent = '';
        for (var i = 0; i < currentAgents.length; i++) {
          var opt = document.createElement('option');
          opt.value = currentAgents[i].name;
          opt.textContent = currentAgents[i].name;
          agentSelect.appendChild(opt);
        }
        // Deep-linked from the agents list or config page (?agent=name) —
        // preselect it if it's a real, currently-registered agent.
        var requested = new URLSearchParams(location.search).get('agent');
        if (requested && currentAgents.some(function (a) { return a.name === requested; })) {
          agentSelect.value = requested;
        }
        var hasAgents = currentAgents.length > 0;
        agentSelect.disabled = !hasAgents;
        messageInput.disabled = !hasAgents;
        messageInput.placeholder = hasAgents
          ? 'Message\\u2026 (Enter to send, Shift+Enter for a new line)'
          : 'No agents registered';
        updateCaption();
        resetConversation();
        updateSendButtonState();
        if (hasAgents) messageInput.focus();
      })
      .catch(function (err) {
        agentCaption.textContent = 'Could not load agents: ' + err.message;
        resetConversation();
      });
  }

  function handleFrame(frame) {
    var lines = frame.split('\\n');
    var eventName = 'message';
    var dataLine = '';
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('event: ') === 0) eventName = lines[i].slice(7);
      else if (lines[i].indexOf('data: ') === 0) dataLine = lines[i].slice(6);
    }
    var data;
    try {
      data = JSON.parse(dataLine);
    } catch (err) {
      data = dataLine;
    }
    if (eventName === 'session') {
      sessionId = data.sessionId;
      sessionLabel.textContent = 'session: ' + sessionId;
      sessionLabel.title = 'Click to copy session id';
      sessionLabel.classList.add('copyable');
      if (lastSentMessage) {
        rememberSession(agentSelect.value, sessionId, lastSentMessage);
        lastSentMessage = null;
      }
    } else if (eventName === 'done') {
      removeThinking();
      var doneEl = appendChatMessage('assistant', data.text);
      // stopReason (see run-agent.ts's own RunAgentResult) marks this as
      // a synthetic notice, not something the model actually said — a
      // denied tool call stopping the loop right there, same as
      // max_turns already could. Visually distinct so it doesn't read
      // like a normal finished answer.
      if (data.stopReason) doneEl.classList.add('msg-stopped');
      if (sessionId) updateSessionField(agentSelect.value, sessionId, 'pendingAssistantText', null);
    } else if (eventName === 'error') {
      removeThinking();
      appendChatMessage('error', data.error);
      if (sessionId) updateSessionField(agentSelect.value, sessionId, 'pendingAssistantText', null);
    } else if (eventName === 'assistant:text') {
      removeThinking();
      appendChatMessage('assistant', data.text);
      showThinking();
      if (sessionId) updateSessionField(agentSelect.value, sessionId, 'pendingAssistantText', data.text);
    } else if (eventName === 'tool:started') {
      // Fired the instant any call is decided, auto-allowed or
      // interactively asked alike (see run-agent.ts's own 'tool:started'
      // log call - it emits this unconditionally now, no notion of
      // "already shown elsewhere"). An interactively-asked call already
      // has its own approval card showing this decision (see
      // appendApprovalCard/wasAskedInteractively above) - no redundant
      // 'Running…' card needed for it, unlike an auto-allowed call which
      // had nothing shown until now.
      removeThinking();
      if (!wasAskedInteractively(data.detailText)) {
        appendToolCallCard(data.tool, data.args, data.detailText, 'Running\\u2026', data.id);
      }
      showThinking();
      appendTimelineEntry(eventName, data);
    } else if (eventName === 'tool:result') {
      // A tool call's own resolution (see run-agent.ts's own 'tool:result'
      // log call, also unconditional now) - auto-allowed, approved,
      // denied, or skipped alike. An interactively-approved call that
      // then executed successfully already has its own approval card
      // saying "Approved." - redundant to show again. A rejected
      // execution is new information that card never had (it only ever
      // showed the *decision*, not what running the call actually did),
      // so it still gets shown regardless.
      removeThinking();
      if (!wasAskedInteractively(data.detailText) || data.statusText === 'Error.') {
        // A call that got its own 'tool:started' card above updates it in
        // place (updateToolCallCard); one that didn't (denied/skipped, or
        // the rejected-after-interactive-approval case just above) gets a
        // fresh card instead - same fallback renderHistoryMessage's replay
        // of stored history already relies on for a resumed session, which
        // never sees 'tool:started' at all.
        if (!updateToolCallCard(data.id, data.statusText)) {
          appendToolCallCard(data.tool, data.args, data.detailText, data.statusText, data.id);
        }
      }
      showThinking();
      appendTimelineEntry(eventName, data);
    } else if (eventName === 'approval:pending') {
      removeThinking();
      appendApprovalCard(data);
      appendTimelineEntry(eventName, data);
    } else if (eventName === 'question:pending') {
      removeThinking();
      appendQuestionCard(data);
      appendTimelineEntry(eventName, data);
    } else {
      appendTimelineEntry(eventName, data);
    }
  }

  function sendMessage() {
    if (isSending) return;
    var agent = agentSelect.value;
    var message = messageInput.value.trim();
    if (!agent || !message) return;

    var extraHeaders = parseExtraHeaders(extraHeadersInput.value);
    var extraBody = parseExtraBody(extraBodyInput.value);
    if (extraBody === null) return;

    var body = { message: message };
    if (sessionId) body.sessionId = sessionId;
    for (var key in extraBody) body[key] = extraBody[key];

    var headers = { 'content-type': 'application/json' };
    for (var hk in extraHeaders) headers[hk] = extraHeaders[hk];

    appendChatMessage('user', message);
    lastSentMessage = message;
    messageInput.value = '';
    setSending(true);
    showThinking();

    function finish() {
      removeThinking();
      setSending(false);
      messageInput.focus();
    }

    fetch('/agents/' + encodeURIComponent(agent) + '/messages/stream', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body),
    })
      .then(function (response) {
        var contentType = response.headers.get('content-type') || '';
        if (contentType.indexOf('text/event-stream') === -1) {
          return response.json()
            .catch(function () { return { error: 'HTTP ' + response.status }; })
            .then(function (data) {
              appendChatMessage('error', data.error || ('HTTP ' + response.status));
              finish();
            });
        }

        var reader = response.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';

        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) {
              buffer += decoder.decode();
              finish();
              return;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            var idx;
            while ((idx = buffer.indexOf('\\n\\n')) !== -1) {
              var frame = buffer.slice(0, idx);
              buffer = buffer.slice(idx + 2);
              handleFrame(frame);
            }
            return pump();
          });
        }

        return pump();
      })
      .catch(function (err) {
        appendChatMessage('error', 'Network error: ' + err.message);
        finish();
      });
  }

  agentSelect.addEventListener('change', function () {
    updateCaption();
    resetConversation();
    updateSendButtonState();
  });
  messageInput.addEventListener('input', updateSendButtonState);
  newConversationButton.addEventListener('click', resetConversation);
  sendButton.addEventListener('click', sendMessage);
  messageInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  sessionLabel.addEventListener('click', function () {
    if (!sessionId || !navigator.clipboard) return;
    navigator.clipboard.writeText(sessionId).then(function () {
      var original = 'session: ' + sessionId;
      sessionLabel.textContent = 'copied!';
      setTimeout(function () { sessionLabel.textContent = original; }, 1000);
    });
  });

  loadAgents();
})();
</script>
</body>
</html>
`
