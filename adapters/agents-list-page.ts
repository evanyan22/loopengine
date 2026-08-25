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
</style>
</head>
<body>
<nav class="topnav">
  <a href="/agents" class="active">Agents</a>
  <a href="/config">Config</a>
  <a href="/playground">Playground</a>
</nav>
<main>
  <h1>Registered agents</h1>
  <p class="intro">Every AgentConfig discovered under agents/ — open one in the playground to chat with it, or in the config viewer to see its tools, permissions, and hooks.</p>
  <ul id="agentUl"></ul>
  <p id="empty" style="display:none">No agents registered.</p>
</main>
<script>
(function () {
  var agentUl = document.getElementById('agentUl');
  var empty = document.getElementById('empty');

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  fetch('/agents')
    .then(function (r) { return r.json(); })
    .then(function (data) {
      var agents = data.agents || [];
      if (!agents.length) {
        empty.style.display = 'block';
        return;
      }
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
})();
</script>
</body>
</html>
`
