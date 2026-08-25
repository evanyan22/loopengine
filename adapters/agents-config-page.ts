// A local dev page: a single self-contained HTML page (no build step, no
// framework, no CDN) served by adapters/http.ts at GET /agents/config. It's
// a browser client on top of the existing GET /agents, GET
// /agents/:name/config, and GET/POST/DELETE /agents/:name/gateway-tools
// routes — nothing here talks to runAgent, SessionStore, or ActAuth
// directly; it only renders/writes through what those routes already
// resolve, so what's shown here is always what a real request would
// actually get (see describeAgent in adapters/http.ts).
//
// Once an agent is picked, its detail pane is a submenu — Overview /
// Actauth / Gateway tools — rather than one long scrolling page. Gateway
// tools used to be its own top-level page (adapters/gateway-tools-page.ts,
// now removed) with its own agent-picker sidebar; folded in here instead
// so there's one place to pick an agent and one place to see everything
// about it, not two parallel agent pickers for two halves of the same
// picture. The Gateway tools tab's own content is fetched lazily, only
// when that tab is actually opened — unlike Overview/Actauth (both free,
// pulled from the same /config fetch already made to open the agent at
// all), resolving gateway tools means actually connecting to each one
// (see gateway-tools.ts's describeGatewayTools), a real cost not worth
// paying for an agent whose gateway tools nobody looked at this visit.
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
  .tabs {
    display: flex;
    gap: 18px;
    margin: 14px 0 20px;
    border-bottom: 1px solid light-dark(#ddd, #333);
  }
  .tabs button {
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 8px 2px;
    font-size: 13px;
    cursor: pointer;
    color: light-dark(#666, #999);
  }
  .tabs button:hover { color: light-dark(#1a1a1e, #e8e8ea); }
  .tabs button.active {
    color: light-dark(#1a1a1e, #e8e8ea);
    border-bottom-color: light-dark(#1d4ed8, #60a5fa);
    font-weight: 600;
  }
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
  .hint { font-size: 11px; color: light-dark(#666, #999); }
  #playgroundLink { font-size: 12px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; font-weight: normal; text-decoration: none; margin-left: 8px; }
  .source {
    border: 1px solid light-dark(#ddd, #3a3a3e);
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 10px;
  }
  .source-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .source-head h4 { margin: 0; font-size: 14px; font-family: ui-monospace, monospace; }
  .status-ok { color: light-dark(#166534, #86efac); }
  .status-error { color: light-dark(#991b1b, #f87171); }
  .tool-list { margin: 8px 0 0; padding-left: 0; font-size: 12px; }
  .tool-list li {
    margin-bottom: 2px;
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .remove-tool-btn {
    flex-shrink: 0;
    width: 18px;
    height: 18px;
    line-height: 1;
    padding: 0;
    border-radius: 50%;
    font-size: 13px;
    color: light-dark(#991b1b, #f87171);
    border-color: light-dark(#f3b4b4, #6b3232);
  }
  .remove-tool-btn:hover { background: light-dark(#fee2e2, #4a1f1f); }
  /* Flex items default to min-width: auto, which means a long,
     unbreakable token (a slug like GITHUB_LIST_REPOSITORIES_FOR_THE_
     AUTHENTICATED_USER has no spaces for the browser to wrap at) simply
     doesn't shrink to fit — it overflows the row, and the row's
     ancestor forms, instead of wrapping. min-width: 0 lets it actually
     shrink to the available space; overflow-wrap lets it break mid-word
     once there's nowhere left to wrap normally. */
  .tool-picker-label { flex: 1; min-width: 0; overflow-wrap: break-word; }
  form.add-source {
    border: 1px solid light-dark(#ddd, #3a3a3e);
    border-radius: 8px;
    padding: 14px;
    display: grid;
    gap: 10px;
    max-width: 480px;
  }
  form.add-source label { font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
  form.add-source input, form.add-source select, form.add-source textarea { width: 100%; }
  form.add-source textarea { font-family: ui-monospace, monospace; min-height: 60px; }
  .tool-picker-list {
    max-height: 240px;
    overflow-y: auto;
    border: 1px solid light-dark(#ddd, #3a3a3e);
    border-radius: 6px;
    padding: 6px 8px;
  }
  /* "form.add-source label { flex-direction: column; }" above is meant
     for the form's own top-level fields (Provider/App/Name/...), each a
     <label> wrapping a heading over its input — but .tool-picker-item is
     also a <label> inside that same form, so that rule matches it too,
     and (higher specificity: form+class+label vs. just one class here)
     wins over flex-direction on this rule alone, stacking the checkbox
     under the text instead of beside it. "label.tool-picker-item" adds
     the element back in to match that specificity and override it. */
  form.add-source label.tool-picker-item {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
    padding: 5px 2px;
    font-size: 12px;
    border-bottom: 1px solid light-dark(#eee, #2a2a2e);
  }
  .tool-picker-item:last-child { border-bottom: none; }
  /* Higher specificity than "form.add-source input { width: 100%; }" —
     without this, that rule wins (one more element in its selector) and
     stretches the checkbox to the full row width, which visually
     overlaps the description text under it instead of sitting beside it. */
  form.add-source input[type="checkbox"] { width: auto; flex-shrink: 0; margin-top: 2px; }
</style>
</head>
<body>
<nav class="topnav">
  <a href="/agents">Agents</a>
  <a href="/agents/config" class="active">Config</a>
  <a href="/playground">Playground</a>
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
  var currentTab = 'overview';
  // Which agent's Gateway tools tab has already been fetched — reset on
  // every agent switch so a stale agent's sources are never shown under
  // a new one, and re-fetched the next time that tab is opened.
  var gatewayLoadedFor = null;
  // The full /agents/:name/config response the currently-open agent was
  // last rendered from — kept around so refreshActauthDependentPanels
  // below can re-fetch and re-render just Overview/Actauth (both read
  // cfg.permissions) after adding or removing a gateway tool, without
  // touching the Tools tab's own already-current state.
  var currentCfg = null;

  function decisionClass(decision) {
    return 'decision-' + decision;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function badge(label) {
    return '<span class="badge ' + (label === 'custom' ? 'badge-custom' : 'badge-default') + '">' + escapeHtml(label) + '</span>';
  }

  // ---- Overview tab ----

  function renderTools(tools) {
    if (!tools.length) return '<p class="muted">No tools.</p>';
    var rows = tools.map(function (t) {
      return '<tr><td><code>' + escapeHtml(t.name) + '</code></td>' +
        '<td>' + escapeHtml(t.description) + '</td>' +
        '<td>' + (t.safe ? 'yes' : 'no') + '</td></tr>';
    }).join('');
    return '<table><thead><tr><th>Name</th><th>Description</th><th>Parallel-safe</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderSkills(skills) {
    if (!skills.length) return '<p class="muted">No skills.</p>';
    var rows = skills.map(function (s) {
      return '<tr><td><code>' + escapeHtml(s.name) + '</code></td>' +
        '<td>' + escapeHtml(s.description) + '</td></tr>';
    }).join('');
    return '<table><thead><tr><th>Name</th><th>Description</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function renderOverviewHtml(cfg) {
    var modelHtml = typeof cfg.model === 'string'
      ? '<p class="muted">' + escapeHtml(cfg.model) + '</p>'
      : '<dl class="kv">' +
        '<dt>Provider</dt><dd>' + escapeHtml(cfg.model.provider) + '</dd>' +
        '<dt>Model</dt><dd>' + escapeHtml(cfg.model.model || '(provider default)') + '</dd>' +
        '<dt>Max tokens</dt><dd>' + escapeHtml(cfg.model.maxTokens != null ? cfg.model.maxTokens : '(default)') + '</dd>' +
        '</dl>';

    return '<section><h3>System prompt</h3><pre>' + escapeHtml(cfg.systemPrompt) + '</pre></section>' +
      '<section><h3>Model</h3>' + modelHtml + '</section>' +
      '<section><h3>Skills (' + cfg.skills.length + ')</h3>' + renderSkills(cfg.skills) + '</section>' +
      '<section><h3>Tools (' + cfg.tools.length + ')</h3>' + renderTools(cfg.tools) + '</section>' +
      '<section><h3>Actauth</h3>' + renderRules(cfg.permissions) + '</section>' +
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
  }

  // ---- Actauth tab ----

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

  function renderActauthHtml(cfg) {
    return '<section>' + renderRules(cfg.permissions) + '</section>';
  }

  // ---- Skills tab ----

  function renderSkillsHtml(cfg) {
    return '<section><h3>Skills dirs</h3><dl class="kv">' +
        '<dt>skillsDirs</dt><dd>' + escapeHtml(cfg.skillsDirs.join(', ') || '(none)') + '</dd>' +
        '<dt>skillIndexBudgetTokens</dt><dd>' + escapeHtml(cfg.skillIndexBudgetTokens) + '</dd>' +
        '</dl></section>' +
      '<section><h3>Discovered skills (' + cfg.skills.length + ')</h3>' + renderSkills(cfg.skills) + '</section>';
  }

  // ---- Tools tab: three sections, one per where a tool actually comes
  // from -- Local tools (agents/name/tools/), Agent as Tools (subagents,
  // via agentAsTool), and Gateway Tools (gateway-tools.ts's registry,
  // this section ported from the old standalone /agents/gateway-tools
  // page). Local tools/Agent as Tools render immediately from cfg --
  // already fetched to open the agent at all, no extra cost. Gateway
  // Tools alone loads lazily, only once this tab is opened (see
  // loadGatewayTab): unlike the other two, resolving it means actually
  // connecting to each registered source (see gateway-tools.ts's
  // describeGatewayTools), a real cost not worth paying up front. ----

  function renderToolsTabHtml(cfg) {
    return '<section><h3>Local tools (' + cfg.localTools.length + ')</h3>' + renderTools(cfg.localTools) + '</section>' +
      '<section><h3>Agent as Tools (' + cfg.agentAsTools.length + ')</h3>' + renderTools(cfg.agentAsTools) + '</section>' +
      '<section id="gatewayToolsSection"><h3>Gateway Tools</h3>' +
        '<div id="gatewayToolsContent"><p class="hint">Loading&hellip;</p></div>' +
      '</section>';
  }

  // Removing a source used to be one "Remove" button per source, at the
  // bottom of the card — dropping every tool it produces at once, with
  // no way to remove just one. Each slug now gets its own remove icon
  // instead, right where it's listed — a source disappears on its own,
  // via removeGatewayToolSlug, once its last slug is gone (see that
  // function's own doc comment).
  function renderGatewaySource(s) {
    var errorHtml = s.status === 'error' ? '<p class="error">' + escapeHtml(s.error) + '</p>' : '';
    var rowsHtml = !s.entry.slugs.length
      ? '<p class="hint">No tools registered.</p>'
      : '<ul class="tool-list">' + s.entry.slugs.map(function (slug, i) {
          var tool = s.status === 'ok' ? s.tools[i] : null;
          var label = tool
            ? '<code>' + escapeHtml(tool.name) + '</code> &mdash; ' + escapeHtml(tool.description)
            : '<code>' + escapeHtml(s.entry.name + '_' + slug) + '</code>';
          return '<li><span class="tool-picker-label">' + label + '</span>' +
            ' <button type="button" class="remove-tool-btn" data-source="' + escapeHtml(s.entry.name) + '" data-slug="' + escapeHtml(slug) + '" title="Remove this tool" aria-label="Remove this tool">&times;</button>' +
            '</li>';
        }).join('') + '</ul>';

    return '<div class="source">' +
      '<div class="source-head">' +
        '<h4>' + escapeHtml(s.entry.name) + ' <span class="hint">(' + escapeHtml(s.entry.provider) + ')</span></h4>' +
        '<span class="' + (s.status === 'ok' ? 'status-ok' : 'status-error') + '">' + escapeHtml(s.status) + '</span>' +
      '</div>' +
      errorHtml +
      rowsHtml +
      '</div>';
  }

  function renderGatewayHtml(sources) {
    var listHtml = sources.length
      ? sources.map(renderGatewaySource).join('')
      : '<p class="hint">No tool sources registered yet.</p>';

    // App + tool picker instead of freeform slug entry — pulled from
    // GET /composio/connections and GET /composio/tools?toolkit=X (see
    // wireGatewayHandlers below), so adding a source means checking boxes
    // for what's already connected and available, not needing to already
    // know a toolkit's exact slug strings by heart.
    return '<section><h3>Registered sources</h3><div id="sourceList">' + listHtml + '</div></section>' +
      '<section><h3>Add a tool source</h3>' +
      '<form class="add-source" id="addForm">' +
        '<label>Provider' +
          '<select name="provider"><option value="composio">Composio</option></select>' +
        '</label>' +
        '<label>App <span class="hint">(already connected via composio link)</span>' +
          '<select name="toolkit" id="toolkitSelect" required><option value="">Loading apps&hellip;</option></select>' +
        '</label>' +
        '<label>Name <span class="hint">(namespaces every tool it produces, e.g. "gh")</span>' +
          '<input name="name" required pattern="[a-z0-9_]+" placeholder="gh">' +
        '</label>' +
        '<label>Tools' +
          '<input type="text" id="toolFilter" placeholder="Filter by name or slug&hellip;">' +
          '<div class="tool-picker-list" id="toolPickerList"><p class="hint">Pick an app above first.</p></div>' +
        '</label>' +
        '<label>Grant permission <span class="hint">(optional — leave blank to leave every new tool at actauth\\'s own default, typically deny)</span>' +
          '<select name="decision"><option value="">(leave unset)</option><option value="allow">allow</option><option value="ask">ask</option><option value="deny">deny</option></select>' +
        '</label>' +
        '<button type="submit" id="addSubmitBtn" disabled>Add</button>' +
        '<div id="addError" class="error"></div>' +
      '</form></section>';
  }

  function gatewayContentEl() {
    return detail.querySelector('#gatewayToolsContent');
  }

  function wireGatewayHandlers(name) {
    var content = gatewayContentEl();
    var removeToolButtons = content.querySelectorAll('.remove-tool-btn');
    for (var i = 0; i < removeToolButtons.length; i++) {
      removeToolButtons[i].addEventListener('click', function (ev) {
        var btn = ev.currentTarget;
        var sourceName = btn.getAttribute('data-source');
        var slug = btn.getAttribute('data-slug');
        btn.disabled = true;
        fetch('/agents/' + encodeURIComponent(name) + '/gateway-tools/' + encodeURIComponent(sourceName) + '/' + encodeURIComponent(slug), { method: 'DELETE' })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
          .then(function (result) {
            if (!result.ok) throw new Error(result.body.error || 'request failed');
            // Same shortcut as the add-form's own success handler — the
            // DELETE response already carries the freshly-resolved
            // sources, so applying it directly skips a second,
            // redundant live-reconnect round trip for the same data.
            applyGatewaySources(name, result.body.sources || []);
            // Removing a tool also drops its auto-seeded actauth rule
            // (see removeGatewayToolSlug) — keep Overview/Actauth in
            // sync with that.
            refreshActauthDependentPanels(name);
          })
          .catch(function (err) {
            alert('Could not remove: ' + err.message);
            btn.disabled = false;
          });
      });
    }

    var form = content.querySelector('#addForm');
    var toolkitSelect = content.querySelector('#toolkitSelect');
    var nameInput = form.querySelector('input[name="name"]');
    var toolFilter = content.querySelector('#toolFilter');
    var toolPickerList = content.querySelector('#toolPickerList');
    var submitBtn = content.querySelector('#addSubmitBtn');
    var currentTools = [];
    // Tracks whichever toolkit slug the Name field was last auto-filled
    // with, so switching apps updates an untouched Name along with it —
    // but the moment a person types their own value in, it stops
    // clobbering that on the next app switch.
    var nameAutoFilledAs = '';

    function renderToolPicker(tools, filterText) {
      var q = (filterText || '').toLowerCase();
      var filtered = !q
        ? tools
        : tools.filter(function (t) {
            return t.slug.toLowerCase().indexOf(q) !== -1 || t.name.toLowerCase().indexOf(q) !== -1 || t.description.toLowerCase().indexOf(q) !== -1;
          });
      if (!filtered.length) {
        toolPickerList.innerHTML = '<p class="hint">No matching tools.</p>';
        return;
      }
      toolPickerList.innerHTML = filtered.map(function (t) {
        return '<label class="tool-picker-item">' +
          '<span class="tool-picker-label"><strong>' + escapeHtml(t.name) + '</strong> <span class="hint">' + escapeHtml(t.slug) + '</span>' +
          '<br><span class="hint">' + escapeHtml(t.description) + '</span></span>' +
          '<input type="checkbox" name="slugs" value="' + escapeHtml(t.slug) + '">' +
          '</label>';
      }).join('');
    }

    function loadToolsForToolkit(toolkit) {
      toolPickerList.innerHTML = '<p class="hint">Loading tools&hellip;</p>';
      submitBtn.disabled = true;
      fetch('/composio/tools?toolkit=' + encodeURIComponent(toolkit))
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (result) {
          if (!result.ok) throw new Error(result.body.error || 'request failed');
          currentTools = result.body.tools || [];
          renderToolPicker(currentTools, toolFilter.value);
          submitBtn.disabled = false;
        })
        .catch(function (err) {
          toolPickerList.innerHTML = '<p class="error">Could not load tools: ' + escapeHtml(err.message) + '</p>';
        });
    }

    fetch('/composio/connections')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var active = (data.connections || []).filter(function (c) { return c.status === 'ACTIVE'; });
        var toolkits = [];
        for (var i = 0; i < active.length; i++) {
          if (toolkits.indexOf(active[i].toolkit) === -1) toolkits.push(active[i].toolkit);
        }
        if (!toolkits.length) {
          toolkitSelect.innerHTML = '<option value="">No connected apps</option>';
          toolPickerList.innerHTML = '<p class="hint">Run "composio link &lt;toolkit&gt;" on the machine running this server, then reopen this tab.</p>';
          return;
        }
        toolkitSelect.innerHTML = '<option value="">Choose an app&hellip;</option>' +
          toolkits.map(function (t) { return '<option value="' + escapeHtml(t) + '">' + escapeHtml(t) + '</option>'; }).join('');
      })
      .catch(function (err) {
        toolkitSelect.innerHTML = '<option value="">Could not load apps</option>';
        toolPickerList.innerHTML = '<p class="error">Could not load connected apps: ' + escapeHtml(err.message) + '</p>';
      });

    toolkitSelect.addEventListener('change', function () {
      var toolkit = toolkitSelect.value;
      if (!toolkit) {
        toolPickerList.innerHTML = '<p class="hint">Pick an app above first.</p>';
        submitBtn.disabled = true;
        return;
      }
      if (!nameInput.value || nameInput.value === nameAutoFilledAs) {
        nameInput.value = toolkit;
        nameAutoFilledAs = toolkit;
      }
      loadToolsForToolkit(toolkit);
    });

    toolFilter.addEventListener('input', function () {
      renderToolPicker(currentTools, toolFilter.value);
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var addError = content.querySelector('#addError');
      addError.textContent = '';
      var checked = form.querySelectorAll('input[name="slugs"]:checked');
      var slugs = Array.prototype.map.call(checked, function (cb) { return cb.value; });
      if (!slugs.length) {
        addError.textContent = 'Pick at least one tool.';
        return;
      }
      var data = new FormData(form);
      var body = { provider: data.get('provider'), name: data.get('name'), slugs: slugs };
      var decision = data.get('decision');
      if (decision) body.decision = decision;

      // Immediate feedback the instant Add is clicked — without this,
      // the button just sits there through the whole POST (which itself
      // does a live connect to every registered source, not a quick
      // write — see gateway-tools.ts's describeGatewayTools), so nothing
      // visibly happens until it's already done.
      submitBtn.disabled = true;
      submitBtn.textContent = 'Adding…';

      fetch('/agents/' + encodeURIComponent(name) + '/gateway-tools', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (result) {
          if (!result.ok) throw new Error(result.body.error || 'request failed');
          // The POST response already carries the freshly-resolved
          // sources (handleToolSourcesPost returns exactly what
          // describeGatewayTools would) — applying it directly instead
          // of calling loadGatewayTab skips a second, fully-redundant
          // live-reconnect round trip for the exact same data.
          applyGatewaySources(name, result.body.sources || []);
          // A decision (if given) just seeded a new actauth rule — keep
          // Overview/Actauth in sync with that instead of showing it
          // only after the agent is re-selected.
          refreshActauthDependentPanels(name);
        })
        .catch(function (err) {
          addError.textContent = err.message;
          submitBtn.disabled = false;
          submitBtn.textContent = 'Add';
        });
    });
  }

  function applyGatewaySources(name, sources) {
    var content = gatewayContentEl();
    if (!content) return;
    content.innerHTML = renderGatewayHtml(sources);
    wireGatewayHandlers(name);
    gatewayLoadedFor = name;
  }

  function loadGatewayTab(name) {
    var content = gatewayContentEl();
    if (!content) return;
    content.innerHTML = '<p class="hint">Loading&hellip;</p>';
    fetch('/agents/' + encodeURIComponent(name) + '/gateway-tools')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (currentName !== name) return;
        applyGatewaySources(name, data.sources || []);
      })
      .catch(function (err) {
        if (currentName !== name) return;
        content.innerHTML = '<p class="error">Could not load gateway tools: ' + escapeHtml(err.message) + '</p>';
      });
  }

  // ---- Tab switching + agent selection ----

  function switchTab(tab) {
    currentTab = tab;
    var buttons = detail.querySelectorAll('.tabs button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle('active', buttons[i].dataset.tab === tab);
    }
    var panels = detail.querySelectorAll('.tab-panel');
    for (var i = 0; i < panels.length; i++) {
      panels[i].style.display = panels[i].dataset.tabPanel === tab ? 'block' : 'none';
    }
    if (tab === 'tools' && gatewayLoadedFor !== currentName) {
      loadGatewayTab(currentName);
    }
  }

  // Adding or removing a gateway tool changes actauth.yml (a decision
  // seeds/drops a rule for it — see gateway-tools.ts's addGatewayTool/
  // removeGatewayToolSlug) but Overview's own Actauth section and the
  // dedicated Actauth tab were both rendered once, from whatever cfg
  // /agents/:name/config returned when the agent was first opened —
  // without this, a rule added or removed from the Tools tab wouldn't
  // show up there until the agent was re-selected or the page reloaded.
  function refreshActauthDependentPanels(name) {
    fetch('/agents/' + encodeURIComponent(name) + '/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (currentName !== name) return;
        currentCfg = cfg;
        var overviewPanel = detail.querySelector('[data-tab-panel="overview"]');
        var actauthPanel = detail.querySelector('[data-tab-panel="actauth"]');
        if (overviewPanel) overviewPanel.innerHTML = renderOverviewHtml(cfg);
        if (actauthPanel) actauthPanel.innerHTML = renderActauthHtml(cfg);
      })
      .catch(function () {
        // Best-effort — the Tools tab itself already reflects the
        // change either way, this is only about keeping the other two
        // panels in sync with it.
      });
  }

  function renderDetail(cfg) {
    currentCfg = cfg;
    detail.innerHTML =
      '<h2>' + escapeHtml(cfg.name) +
      ' <a id="playgroundLink" href="/playground?agent=' + encodeURIComponent(cfg.name) + '">Open in playground &rarr;</a></h2>' +
      '<div class="tabs">' +
        '<button class="tab" data-tab="overview">Overview</button>' +
        '<button class="tab" data-tab="skills">Skills</button>' +
        '<button class="tab" data-tab="tools">Tools</button>' +
        '<button class="tab" data-tab="actauth">Actauth</button>' +
      '</div>' +
      '<div class="tab-panel" data-tab-panel="overview">' + renderOverviewHtml(cfg) + '</div>' +
      '<div class="tab-panel" data-tab-panel="skills">' + renderSkillsHtml(cfg) + '</div>' +
      '<div class="tab-panel" data-tab-panel="tools">' + renderToolsTabHtml(cfg) + '</div>' +
      '<div class="tab-panel" data-tab-panel="actauth">' + renderActauthHtml(cfg) + '</div>';

    var buttons = detail.querySelectorAll('.tabs button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (ev) { switchTab(ev.currentTarget.dataset.tab); });
    }

    empty.style.display = 'none';
    detail.style.display = 'block';
    switchTab(currentTab);
  }

  function selectAgent(name) {
    currentName = name;
    gatewayLoadedFor = null;
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
