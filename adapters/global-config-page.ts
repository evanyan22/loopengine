// A local dev page: a single self-contained HTML page (no build step, no
// framework, no CDN) served by adapters/http.ts at GET /config — the
// account-wide counterpart to adapters/agents-config-page.ts's per-agent
// Overview/Skills/Tools/ActAuth tabs (served separately at
// /agents/config, deliberately left untouched by this page). A left
// sidebar picks between Models (which providers this deployment can
// call, and which agents use which) and Gateways (whether the composio
// CLI is authenticated on this machine) — see global-config.ts for where
// that data actually comes from. "Agents" is a plain link out to
// /agents/config, not a third client-rendered section here: that page
// already owns the full per-agent picture, duplicating or embedding it
// would just be two places for the same UI to drift apart.
//
// Embedded as a TS string (not a separate .html file), same reasoning as
// adapters/playground.ts: tsc's ordinary compile emits it straight into
// dist/adapters/ alongside http.js, no asset-copy step needed. Plain
// string concatenation, not a nested template literal, for the same
// backtick/${}-escaping reason playground.ts's own header comment
// explains — see also the memory note on this file's double-escaping
// hazard (template-literal escapes run twice: once when this constant
// is built, once when a browser parses the served <script> as JS).
import { devUiCss } from './dev-ui-styles.js'

export const globalConfigPageHtml: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LoopEngine Config</title>
<style>${devUiCss}
  body {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .layout { flex: 1; display: flex; min-height: 0; }
  nav.sidebar {
    width: 180px;
    flex-shrink: 0;
    border-right: 1px solid light-dark(#ddd, #333);
    padding: 6px;
  }
  nav.sidebar button, nav.sidebar a {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 13px;
    cursor: pointer;
    text-decoration: none;
    color: inherit;
    box-sizing: border-box;
  }
  nav.sidebar button:hover, nav.sidebar a:hover { background: light-dark(#eee, #26262b); }
  nav.sidebar button.active { background: light-dark(#dbeafe, #1e3a5f); font-weight: 600; }
  main {
    flex: 1;
    overflow-y: auto;
    padding: 20px 28px;
  }
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
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td {
    text-align: left;
    padding: 6px 8px;
    border-bottom: 1px solid light-dark(#eee, #2a2a2e);
    vertical-align: top;
  }
  th { color: light-dark(#666, #999); font-weight: 600; }
  .source {
    border: 1px solid light-dark(#ddd, #3a3a3e);
    border-radius: 8px;
    padding: 12px 14px;
    margin-bottom: 10px;
  }
  .source.unsupported { opacity: 0.6; }
  .source-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .source-head h4 { margin: 0; font-size: 14px; font-family: ui-monospace, monospace; }
  .hint { font-size: 11px; color: light-dark(#666, #999); }
  pre {
    background: light-dark(#fff, #26262b);
    border: 1px solid light-dark(#ddd, #3a3a3e);
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
    margin: 6px 0;
  }
  /* Same palette as agents-config-page.ts's own .delete-btn — kept in
     sync by hand since each admin page owns its own <style> block (no
     shared component CSS beyond devUiCss's base tokens), not because
     this pink-for-destructive convention is meant to drift between them. */
  .delete-btn {
    font-size: 12px;
    color: light-dark(#991b1b, #f87171);
    background: light-dark(#fee2e2, #3a1f1f);
    border-color: light-dark(#f3b4b4, #6b3232);
  }
  .delete-btn:hover { background: light-dark(#fecaca, #4a1f1f); }
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
  <a href="/agents/config">Agents</a>
  <button class="section-btn active" data-section="models">Models</button>
  <button class="section-btn" data-section="gateways">Gateways</button>
</nav>
<main>
  <div class="section-panel" data-section-panel="models">
    <h2>Models</h2>
    <div id="modelsContent"><p class="hint">Loading&hellip;</p></div>
  </div>
  <div class="section-panel" data-section-panel="gateways" style="display:none">
    <h2>Gateways</h2>
    <div id="gatewaysContent"><p class="hint">Loading&hellip;</p></div>
  </div>
</main>
</div>
<script>
(function () {
  var main = document.querySelector('main');
  var sectionButtons = document.querySelectorAll('.section-btn');
  var currentSection = 'models';
  var loadedSections = {};

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function badge(ok, yesLabel, noLabel) {
    return '<span class="badge ' + (ok ? 'badge-custom' : 'badge-default') + '">' + escapeHtml(ok ? yesLabel : noLabel) + '</span>';
  }

  // ---- Models section ----

  function renderModels(data) {
    var providerRows = data.providers.map(function (p) {
      return '<tr><td><code>' + escapeHtml(p.provider) + '</code></td>' +
        '<td><code>' + escapeHtml(p.envVar) + '</code></td>' +
        '<td>' + badge(p.configured, 'configured', 'not set') + '</td></tr>';
    }).join('');

    var agentRows = data.agents.length
      ? data.agents.map(function (a) {
          return '<tr><td><code>' + escapeHtml(a.agent) + '</code></td>' +
            '<td><code>' + escapeHtml(a.provider) + '</code></td>' +
            '<td><code>' + escapeHtml(a.model) + '</code></td></tr>';
        }).join('')
      : '<tr><td colspan="3"><p class="hint">No agents with a resolved model config (a custom createModelCall has nothing to report here).</p></td></tr>';

    return '<section><h3>Providers</h3>' +
        '<table><thead><tr><th>Provider</th><th>Env var</th><th>Status</th></tr></thead><tbody>' + providerRows + '</tbody></table>' +
      '</section>' +
      '<section><h3>Agents</h3>' +
        '<table><thead><tr><th>Agent</th><th>Provider</th><th>Model</th></tr></thead><tbody>' + agentRows + '</tbody></table>' +
      '</section>';
  }

  function loadModels() {
    var content = document.getElementById('modelsContent');
    fetch('/config/models')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        content.innerHTML = renderModels(data);
        loadedSections.models = true;
      })
      .catch(function (err) {
        content.innerHTML = '<p class="error">Could not load models: ' + escapeHtml(err.message) + '</p>';
      });
  }

  // ---- Gateways section ----

  function renderGatewayCard(g) {
    var statusHtml;
    var bodyHtml = '';
    if (!g.supported) {
      statusHtml = '<span class="hint">not yet supported</span>';
    } else if (g.connected) {
      statusHtml = badge(true, 'connected', 'not connected');
      bodyHtml = '<p class="hint">' + escapeHtml(g.email || '') + (g.org ? ' &middot; ' + escapeHtml(g.org) : '') + '</p>' +
        '<button type="button" class="delete-btn disconnect-btn" data-provider="' + escapeHtml(g.provider) + '">Disconnect</button>';
    } else {
      // No Connect button/form here — composio login's only
      // non-interactive path (--user-api-key) doesn't accept the kind of
      // key an operator actually has on hand (Composio hands out a
      // separate x-consumer-api-key credential for MCP clients, which
      // 401s against this flag); composio login itself opens a real
      // browser, which a web request can't drive. These are the same
      // two commands Composio's own docs give for getting started.
      statusHtml = badge(false, 'connected', 'not connected');
      bodyHtml = '<pre><code>curl -fsSL https://composio.dev/install | sh</code></pre>' +
        '<pre><code>composio login</code></pre>' +
        '<p class="hint">Run both on the machine running this server, then reload this page.</p>';
    }
    return '<div class="source' + (g.supported ? '' : ' unsupported') + '">' +
      '<div class="source-head">' +
        '<h4>' + escapeHtml(g.provider) + '</h4>' +
        statusHtml +
      '</div>' +
      bodyHtml +
      '</div>';
  }

  function applyGateways(gateways) {
    var content = document.getElementById('gatewaysContent');
    content.innerHTML = (gateways || []).map(renderGatewayCard).join('');
    wireGatewayCards(content);
    loadedSections.gateways = true;
  }

  // Disconnect is a machine-wide CLI-session action (see
  // disconnectComposioAccount's own doc comment in gateway-tools.ts) —
  // it gets a confirm() for that reason, same as this admin UI's other
  // consequential-but-not-undoable actions (removing a skill, a rule, a
  // gateway tool). No Connect counterpart to wire — see renderGatewayCard's
  // own comment for why that's instructions, not a form.
  function wireGatewayCards(content) {
    var disconnectButtons = content.querySelectorAll('.disconnect-btn');
    for (var j = 0; j < disconnectButtons.length; j++) {
      disconnectButtons[j].addEventListener('click', function (ev) {
        var btn = ev.currentTarget;
        var provider = btn.getAttribute('data-provider');
        if (!confirm('Disconnect ' + provider + '? This logs out the CLI on this machine for every agent’s gateway tools, not just this browser tab.')) return;
        btn.disabled = true;
        fetch('/config/gateways/' + encodeURIComponent(provider) + '/disconnect', { method: 'POST' })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
          .then(function (result) {
            if (!result.ok) throw new Error(result.body.error || 'request failed');
            applyGateways(result.body.gateways || []);
          })
          .catch(function (err) {
            alert('Could not disconnect: ' + err.message);
            btn.disabled = false;
          });
      });
    }
  }

  function loadGateways() {
    var content = document.getElementById('gatewaysContent');
    fetch('/config/gateways')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        applyGateways(data.gateways || []);
      })
      .catch(function (err) {
        content.innerHTML = '<p class="error">Could not load gateways: ' + escapeHtml(err.message) + '</p>';
      });
  }

  // ---- Section switching ----

  function switchSection(section) {
    currentSection = section;
    for (var i = 0; i < sectionButtons.length; i++) {
      sectionButtons[i].classList.toggle('active', sectionButtons[i].dataset.section === section);
    }
    var panels = main.querySelectorAll('.section-panel');
    for (var j = 0; j < panels.length; j++) {
      panels[j].style.display = panels[j].dataset.sectionPanel === section ? 'block' : 'none';
    }
    if (section === 'models' && !loadedSections.models) loadModels();
    if (section === 'gateways' && !loadedSections.gateways) loadGateways();
  }

  for (var i = 0; i < sectionButtons.length; i++) {
    sectionButtons[i].addEventListener('click', function (ev) { switchSection(ev.currentTarget.dataset.section); });
  }

  // Deep-linked from agents-config-page.ts's own Models/Gateways sidebar
  // links (/config?section=gateways, say) — preselect it if it names a
  // real section, same "trust the query param only if it's valid"
  // caution playground.ts's own ?agent= handling already uses.
  var requestedSection = new URLSearchParams(location.search).get('section');
  var initialSection = requestedSection === 'gateways' || requestedSection === 'models' ? requestedSection : currentSection;
  switchSection(initialSection);
})();
</script>
</body>
</html>
`
