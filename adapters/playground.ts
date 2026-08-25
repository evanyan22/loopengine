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
  .msg-thinking .msg-body { display: inline-flex; gap: 4px; padding: 11px 10px; }
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
  var messageInput = document.getElementById('messageInput');
  var sendButton = document.getElementById('sendButton');
  var newConversationButton = document.getElementById('newConversationButton');
  var extraHeadersInput = document.getElementById('extraHeadersInput');
  var extraBodyInput = document.getElementById('extraBodyInput');

  var currentAgents = [];
  var sessionId = null;
  var isSending = false;
  var thinkingEl = null;

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

  function appendTimelineEntry(eventName, data) {
    clearEmptyHint(timelinePane);
    var div = document.createElement('div');
    div.className = 'event ' + eventCategory(eventName);
    var label = document.createElement('div');
    label.className = 'event-label';
    label.textContent = eventName;
    var pre = document.createElement('pre');
    pre.className = 'event-data';
    pre.textContent = JSON.stringify(data, null, 2);
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
    removeThinking();
    sessionLabel.textContent = 'session: (new)';
    sessionLabel.classList.remove('copyable');
    sessionLabel.title = '';
    var name = agentSelect.value;
    setEmptyHint(chatPane, name ? 'No messages yet \\u2014 say hi to ' + name + '.' : 'No messages yet \\u2014 pick an agent above to get started.');
    setEmptyHint(timelinePane, 'Loop events (tool calls, permission checks, budget checks) will appear here as the agent runs.');
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
    } else if (eventName === 'done') {
      removeThinking();
      appendChatMessage('assistant', data.text);
    } else if (eventName === 'error') {
      removeThinking();
      appendChatMessage('error', data.error);
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
