// A local dev page: a single self-contained HTML page (no build step, no
// framework, no CDN) served by adapters/http.ts at GET /agents/config. It's
// a browser client on top of the existing GET /agents and new GET
// /agents/:name/config routes — nothing here talks to runAgent,
// SessionStore, or ActAuth directly; it only renders what those routes
// already resolve, so what's shown here is always what a real request
// would actually get (see describeAgent in adapters/http.ts).
//
// Embedded as a TS string (not a separate .html file), same reasoning as
// adapters/playground.ts: tsc's ordinary compile emits it straight into
// dist/adapters/ alongside http.js, no asset-copy step needed. Plain string
// concatenation, not a nested template literal, for the same
// backtick/${}-escaping reason playground.ts's own header comment explains.
import { devUiCss } from './dev-ui-styles.js'

export const agentsConfigPageHtml: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LoopEngine Agents</title>
<style>${devUiCss}
  body {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .layout { flex: 1; display: flex; min-height: 0; }
  nav.sidebar {
    width: 220px;
    flex-shrink: 0;
    border-right: 1px solid light-dark(#ddd, #333);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  nav.sidebar h1 {
    font-size: 14px;
    margin: 0;
    padding: 12px 14px;
    border-bottom: 1px solid light-dark(#ddd, #333);
  }
  #agentList { list-style: none; margin: 0; padding: 6px; flex: 1; }
  #agentList li {
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-family: ui-monospace, monospace;
  }
  #agentList li:hover { background: light-dark(#eee, #26262b); }
  #agentList li.active { background: light-dark(#dbeafe, #1e3a5f); font-weight: 600; }
  main {
    flex: 1;
    overflow-y: auto;
    padding: 20px 28px;
  }
  #empty { color: light-dark(#666, #999); font-size: 13px; }
  h2 { font-size: 20px; margin: 0 0 4px; font-family: ui-monospace, monospace; }
  section { margin-bottom: 22px; }
  section h3 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: light-dark(#666, #999);
    margin: 0 0 8px;
    border-bottom: 1px solid light-dark(#eee, #2a2a2e);
    padding-bottom: 4px;
  }
  pre {
    background: light-dark(#fff, #26262b);
    border: 1px solid light-dark(#ddd, #3a3a3e);
    border-radius: 6px;
    padding: 10px 12px;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 0;
  }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid light-dark(#eee, #2a2a2e);
    vertical-align: top;
  }
  th { color: light-dark(#666, #999); font-weight: 600; }
  .decision-allow { color: light-dark(#166534, #86efac); }
  .decision-ask { color: light-dark(#92400e, #fcd34d); }
  .decision-deny { color: light-dark(#991b1b, #f87171); }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; font-size: 13px; }
  .kv dt { color: light-dark(#666, #999); }
  .kv dd { margin: 0; font-family: ui-monospace, monospace; }
  .error { color: light-dark(#991b1b, #f87171); font-size: 13px; }
  #playgroundLink { font-size: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-weight: normal; text-decoration: none; margin-left: 8px; }
</style>
</head>
<body>
<nav class="topnav">
  <a href="/agents">Agents</a>
  <a href="/playground">Playground</a>
  <a href="/agents/config" class="active">Config</a>
</nav>
<div class="layout">
<nav class="sidebar">
  <h1>Agents</h1>
  <ul id="agentList"></ul>
</nav>
<main>
  <div id="empty">Pick an agent to see its config.</div>
  <div id="detail" style="display:none"></div>
</main>
</div>
<script>
(function () {
  var agentList = document.getElementById('agentList');
  var empty = document.getElementById('empty');
  var detail = document.getElementById('detail');
  var currentName = null;

  function decisionClass(decision) {
    return 'decision-' + decision;
  }

  function renderTools(tools) {
    if (!tools.length) return '<p class="muted">No tools.</p>';
    var rows = tools.map(function (t) {
      return '<tr><td><code>' + escapeHtml(t.name) + '</code></td>' +
        '<td>' + escapeHtml(t.description) + '</td>' +
        '<td>' + (t.safe ? 'yes' : 'no') + '</td></tr>';
    }).join('');
    return '<table><thead><tr><th>Name</th><th>Description</th><th>Parallel-safe</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderRules(permissions) {
    var header = '<dl class="kv">' +
      '<dt>Source</dt><dd>' + escapeHtml(permissions.source) + '</dd>' +
      '<dt>Default decision</dt><dd class="' + decisionClass(permissions.defaultDecision) + '">' + escapeHtml(permissions.defaultDecision) + '</dd>' +
      '</dl>';
    if (!permissions.rules.length) return header + '<p class="muted">No explicit rules — every tool call falls through to the default decision above.</p>';
    var rows = permissions.rules.map(function (r) {
      return '<tr>' +
        '<td><code>' + escapeHtml(r.scopePattern) + '</code></td>' +
        '<td><code>' + escapeHtml(r.tool) + '</code></td>' +
        '<td class="' + decisionClass(r.decision) + '">' + escapeHtml(r.decision) + '</td>' +
        '<td>' + (r.when ? '<pre>' + escapeHtml(JSON.stringify(r.when, null, 2)) + '</pre>' : '') + '</td>' +
        '</tr>';
    }).join('');
    return header + '<table style="margin-top:10px"><thead><tr><th>Scope</th><th>Tool</th><th>Decision</th><th>When</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function badge(label) {
    return '<span class="badge ' + (label === 'custom' ? 'badge-custom' : 'badge-default') + '">' + escapeHtml(label) + '</span>';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function renderDetail(cfg) {
    var modelHtml = typeof cfg.model === 'string'
      ? '<p class="muted">' + escapeHtml(cfg.model) + '</p>'
      : '<dl class="kv">' +
        '<dt>Provider</dt><dd>' + escapeHtml(cfg.model.provider) + '</dd>' +
        '<dt>Model</dt><dd>' + escapeHtml(cfg.model.model || '(provider default)') + '</dd>' +
        '<dt>Max tokens</dt><dd>' + escapeHtml(cfg.model.maxTokens != null ? cfg.model.maxTokens : '(default)') + '</dd>' +
        '</dl>';

    detail.innerHTML =
      '<h2>' + escapeHtml(cfg.name) +
      ' <a id="playgroundLink" href="/playground?agent=' + encodeURIComponent(cfg.name) + '">Open in playground &rarr;</a></h2>' +
      '<section><h3>System prompt</h3><pre>' + escapeHtml(cfg.systemPrompt) + '</pre></section>' +
      '<section><h3>Model</h3>' + modelHtml + '</section>' +
      '<section><h3>Tools (' + cfg.tools.length + ')</h3>' + renderTools(cfg.tools) + '</section>' +
      '<section><h3>Permissions</h3>' + renderRules(cfg.permissions) + '</section>' +
      '<section><h3>Hooks</h3><dl class="kv">' +
        '<dt>sessionIdFor</dt><dd>' + badge(cfg.sessionIdFor.indexOf('custom') === 0 ? 'custom' : 'default') + ' <span class="muted">' + escapeHtml(cfg.sessionIdFor) + '</span></dd>' +
        '<dt>tenantFor</dt><dd>' + badge(cfg.tenantFor.indexOf('custom') === 0 ? 'custom' : 'default') + ' <span class="muted">' + escapeHtml(cfg.tenantFor) + '</span></dd>' +
        '<dt>isSafeTool</dt><dd>' + badge(cfg.isSafeTool === 'custom' ? 'custom' : 'default') + ' <span class="muted">' + escapeHtml(cfg.isSafeTool) + '</span></dd>' +
        '<dt>approver</dt><dd>' + badge(cfg.approver === 'custom' ? 'custom' : 'default') + ' <span class="muted">' + escapeHtml(cfg.approver) + '</span></dd>' +
        '</dl></section>' +
      '<section><h3>Limits &amp; budgets</h3><dl class="kv">' +
        '<dt>maxTurns</dt><dd>' + escapeHtml(cfg.maxTurns) + '</dd>' +
        '<dt>contextBudgetTokens</dt><dd>' + escapeHtml(cfg.contextBudgetTokens) + '</dd>' +
        '<dt>skillIndexBudgetTokens</dt><dd>' + escapeHtml(cfg.skillIndexBudgetTokens) + '</dd>' +
        '<dt>skillsDirs</dt><dd>' + escapeHtml(cfg.skillsDirs.join(', ') || '(none)') + '</dd>' +
        '</dl></section>';

    empty.style.display = 'none';
    detail.style.display = 'block';
  }

  function selectAgent(name) {
    currentName = name;
    var items = agentList.querySelectorAll('li');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].dataset.name === name);
    }
    detail.innerHTML = '<p class="muted">Loading&hellip;</p>';
    empty.style.display = 'none';
    detail.style.display = 'block';
    fetch('/agents/' + encodeURIComponent(name) + '/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (currentName !== name) return;
        renderDetail(cfg);
      })
      .catch(function (err) {
        if (currentName !== name) return;
        detail.innerHTML = '<p class="error">Could not load config: ' + escapeHtml(err.message) + '</p>';
      });
  }

  fetch('/agents')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var agents = data.agents || [];
      agentList.textContent = '';
      for (var i = 0; i < agents.length; i++) {
        (function (name) {
          var li = document.createElement('li');
          li.textContent = name;
          li.dataset.name = name;
          li.addEventListener('click', function () { selectAgent(name); });
          agentList.appendChild(li);
        })(agents[i].name);
      }
      if (agents.length) {
        var requested = new URLSearchParams(location.search).get('agent');
        var initial = agents.some(function (a) { return a.name === requested; }) ? requested : agents[0].name;
        selectAgent(initial);
      }
    })
    .catch(function (err) {
      empty.textContent = 'Could not load agents: ' + err.message;
    });
})();
</script>
</body>
</html>
`
