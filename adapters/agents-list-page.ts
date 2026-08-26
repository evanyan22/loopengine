// The HTML face of GET /agents. adapters/http.ts content-negotiates that
// route: a browser navigating there (Accept: text/html, ...) gets this
// page; a client fetching it programmatically (fetch()'s default
// Accept: */*, same as playground.ts and agents-config-page.ts's own
// fetch('/agents') calls) still gets the plain {agents: [...]} JSON body
// that route always returned, unchanged. See adapters/dev-ui-styles.ts for
// why the look is a shared import rather than a third copy of the same CSS.
import { devUiCss } from './dev-ui-styles.js'

export const agentsListPageHtml: string = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LoopEngine Agents</title>
<style>${devUiCss}
  main { max-width: 640px; margin: 0 auto; padding: 24px 20px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.intro { color: light-dark(#666, #999); font-size: 13px; margin: 0 0 20px; }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  li {
    border: 1px solid light-dark(#ddd, #333);
    border-radius: 8px;
    padding: 12px 14px;
    background: light-dark(#fff, #202024);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  li .name { font-family: ui-monospace, monospace; font-size: 14px; font-weight: 600; }
  li .prompt {
    font-size: 12px;
    color: light-dark(#666, #999);
    margin-top: 2px;
    max-width: 380px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  li .links { display: flex; gap: 10px; font-size: 12px; flex-shrink: 0; }
  li .links a {
    text-decoration: none;
    border: 1px solid light-dark(#ccc, #444);
    border-radius: 6px;
    padding: 4px 9px;
  }
  li .links a:hover { background: light-dark(#eee, #2a2a2e); }
  #empty { color: light-dark(#666, #999); font-size: 13px; }
  .page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
  .page-head h1 { margin: 0; }
  .hint { font-size: 12px; color: light-dark(#666, #999); }
  .error { font-size: 12px; color: light-dark(#991b1b, #f87171); }
  #newAgentForm {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 4px 0 20px;
    max-width: 480px;
  }
  #newAgentForm .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  #newAgentForm .row input { flex: 1; min-width: 180px; max-width: 280px; }
  #newAgentForm details { font-size: 12px; }
  #newAgentForm details summary { cursor: pointer; color: light-dark(#666, #999); margin-bottom: 8px; }
  #newAgentForm details label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
    font-size: 12px;
  }
  #newAgentForm details textarea { min-height: 60px; font-family: inherit; }
</style>
</head>
<body>
<nav class="topnav">
  <a href="/agents" class="active">Agents</a>
  <a href="/agents/config">Config</a>
  <a href="/playground">Playground</a>
</nav>
<main>
  <div class="page-head">
    <h1>Registered agents</h1>
    <button type="button" id="newAgentBtn">+ New agent</button>
  </div>
  <p class="intro">Every AgentConfig discovered under agents/ — open one in the playground to chat with it, or in the config viewer to see its tools, permissions, and hooks.</p>
  <form id="newAgentForm" style="display:none">
    <div class="row">
      <input type="text" name="name" placeholder="weather-agent" pattern="[a-z0-9]+(-[a-z0-9]+)*" required>
      <button type="submit">Create</button>
      <button type="button" id="cancelNewAgentBtn">Cancel</button>
    </div>
    <details>
      <summary>Advanced (optional)</summary>
      <label>System prompt
        <textarea name="systemPrompt" placeholder="You are ..."></textarea>
      </label>
      <label>Model provider
        <select name="provider">
          <option value="anthropic">anthropic</option>
          <option value="openai">openai</option>
          <option value="deepseek">deepseek</option>
        </select>
      </label>
      <label>Model name <span class="hint">(required for openai/deepseek; defaults to claude-sonnet-5 for anthropic)</span>
        <input type="text" name="modelName" placeholder="claude-sonnet-5">
      </label>
    </details>
  </form>
  <p class="error" id="newAgentError" style="display:none"></p>
  <p class="hint" id="newAgentResult" style="display:none"></p>
  <ul id="agentUl"></ul>
  <p id="empty" style="display:none">No agents registered.</p>
</main>
<script>
(function () {
  var agentUl = document.getElementById('agentUl');
  var empty = document.getElementById('empty');
  var newAgentBtn = document.getElementById('newAgentBtn');
  var newAgentForm = document.getElementById('newAgentForm');
  var newAgentError = document.getElementById('newAgentError');
  var newAgentResult = document.getElementById('newAgentResult');
  var cancelNewAgentBtn = document.getElementById('cancelNewAgentBtn');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // (Re)loads the list from GET /agents — factored out so a successful
  // create can refresh it directly instead of duplicating this fetch.
  function loadAgents() {
    fetch('/agents')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var agents = data.agents || [];
        agentUl.textContent = '';
        if (!agents.length) {
          empty.style.display = 'block';
          return;
        }
        empty.style.display = 'none';
        for (var i = 0; i < agents.length; i++) {
          var agent = agents[i];
          var li = document.createElement('li');
          var qs = '?agent=' + encodeURIComponent(agent.name);
          li.innerHTML =
            '<div><div class="name">' + escapeHtml(agent.name) + '</div>' +
            '<div class="prompt">' + escapeHtml(agent.systemPrompt) + '</div></div>' +
            '<div class="links">' +
            '<a href="/agents/config' + qs + '">Config</a>' +
            '<a href="/playground' + qs + '">Playground</a>' +
            '</div>';
          agentUl.appendChild(li);
        }
      })
      .catch(function (err) {
        empty.textContent = 'Could not load agents: ' + err.message;
        empty.style.display = 'block';
      });
  }

  // handleCreateAgent (adapters/http.ts) loads and registers the new
  // agent into the *running* server immediately — see its own doc
  // comment for why that's safe (a module that's never been imported
  // before has nothing stale to invalidate, unlike hot-reloading an
  // already-loaded agent's code would). registered: true means it's
  // genuinely live already, so this just re-fetches the list rather than
  // telling the operator to restart anything. registered: false is
  // the rare fallback (the file was scaffolded, but loading it back
  // failed for some reason) — that case still needs a real restart,
  // same as before this existed; loopengine dev picks it up
  // automatically via its own --include 'agents/*/index.ts' (see
  // cli.ts's own comment there).
  newAgentBtn.addEventListener('click', function () {
    newAgentBtn.style.display = 'none';
    newAgentForm.style.display = 'flex';
    newAgentResult.style.display = 'none';
    newAgentForm.querySelector('input[name="name"]').focus();
  });

  cancelNewAgentBtn.addEventListener('click', function () {
    newAgentForm.style.display = 'none';
    newAgentBtn.style.display = '';
    newAgentError.style.display = 'none';
  });

  newAgentForm.addEventListener('submit', function (ev) {
    ev.preventDefault();
    newAgentError.style.display = 'none';
    var data = new FormData(newAgentForm);
    var submitBtn = newAgentForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    // systemPrompt/model are both optional — see
    // adapters/http.ts's parseAgentTemplateOptions for the defaults
    // scaffoldAgent falls back to when either is left out of the body
    // entirely (blank/untouched Advanced fields are treated the same
    // as not sending them at all).
    var body = { name: data.get('name') };
    var systemPrompt = data.get('systemPrompt');
    if (systemPrompt && systemPrompt.trim()) body.systemPrompt = systemPrompt;
    var provider = data.get('provider');
    if (provider) {
      body.model = { provider: provider };
      var modelName = data.get('modelName');
      if (modelName && modelName.trim()) body.model.model = modelName;
    }

    fetch('/agents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
      .then(function (result) {
        if (!result.ok) throw new Error(result.body.error || 'request failed');
        newAgentForm.style.display = 'none';
        newAgentBtn.style.display = '';
        newAgentForm.reset();
        newAgentResult.style.display = 'block';
        if (result.body.registered) {
          newAgentResult.textContent = 'Created ' + result.body.path + ' — it\\'s live now.';
          loadAgents();
        } else {
          newAgentResult.textContent =
            'Created ' + result.body.path + ', but it could not be loaded into this running server' +
            (result.body.error ? ' (' + result.body.error + ')' : '') +
            '. Restart the server to pick it up — loopengine dev does this automatically.';
        }
      })
      .catch(function (err) {
        newAgentError.style.display = 'block';
        newAgentError.textContent = err.message;
      })
      .finally(function () {
        submitBtn.disabled = false;
      });
  });

  loadAgents();
})();
</script>
</body>
</html>
`
