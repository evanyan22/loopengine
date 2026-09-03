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
// web/playground.ts: tsc's ordinary compile emits it straight into
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
  /* Outer Agents/Models/Gateways section sidebar — matches
     web/global-config-page.ts's own left nav, so this page (with
     Agents pre-selected) and /config (with Models pre-selected) read as
     two views of the same shell rather than unrelated pages. Models and
     Gateways are real links out to /config?section=..., not client-side
     panels rendered here too — that data/logic already lives in
     global-config-page.ts, duplicating it here would just be two places
     it could drift apart. Named .section-sidebar (not .sidebar) to avoid
     colliding with nav.sidebar right below, which is the agent picker,
     not this new outer one. */
  .page-body { flex: 1; display: flex; min-height: 0; }
  nav.section-sidebar {
    width: 150px;
    flex-shrink: 0;
    border-right: 1px solid light-dark(#ddd, #333);
    padding: 6px;
  }
  nav.section-sidebar a {
    display: block;
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 13px;
    text-decoration: none;
    color: inherit;
  }
  nav.section-sidebar a:hover { background: light-dark(#eee, #26262b); }
  nav.section-sidebar a.active { background: light-dark(#dbeafe, #1e3a5f); font-weight: 600; }
  .layout { flex: 1; display: flex; min-height: 0; }
  nav.sidebar {
    width: 220px;
    flex-shrink: 0;
    border-right: 1px solid light-dark(#ddd, #333);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
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
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .hint-btn {
    font-size: 11px;
    text-transform: none;
    letter-spacing: normal;
    padding: 2px 8px;
  }
  .http-tool-subsection {
    margin-top: 14px;
    padding-top: 14px;
    border-top: 1px dashed light-dark(#eee, #2a2a2e);
  }
  .http-tool-subsection h4 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: light-dark(#666, #999);
    margin: 0 0 8px;
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
  .delete-btn {
    flex-shrink: 0;
    font-size: 12px;
    color: light-dark(#991b1b, #f87171);
    background: light-dark(#fee2e2, #3a1f1f);
    border-color: light-dark(#f3b4b4, #6b3232);
  }
  .delete-btn:hover { background: light-dark(#fecaca, #4a1f1f); }
  /* Explicit rather than relying on inherited font-size: .edit-rule-btn
     sits inside a 12px table, but .edit-skill-btn sits in .source-head
     (no font-size of its own, so it'd otherwise inherit the page's
     larger default) — without this the two Edit buttons render at
     visibly different sizes despite being the same component. */
  .edit-rule-btn, .edit-skill-btn { font-size: 12px; }
  /* Sits inside a section h3, which is uppercase/letter-spaced for its
     own heading text — without resetting both here, the button's own
     label ("Edit") would inherit that and render as "EDIT" with the
     heading's wide letter-spacing, not a normal-looking button. */
  .edit-btn { font-size: 11px; text-transform: none; letter-spacing: normal; margin-left: 6px; }
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
  /* Overrides form.add-source's shared max-width/textarea defaults for
     the skill editor specifically — id selectors beat the class-level
     rules above without needing to touch what every other add-source
     form (gateway tools, actauth rules) looks like. A skill's
     description/body are real prose/markdown, not the short one-liners
     the shared 480px/60px defaults were sized for. */
  #skillForm { max-width: 720px; }
  #skillDescInput { font-family: inherit; min-height: 48px; resize: vertical; }
  #skillBodyInput { min-height: 280px; resize: vertical; }
  /* Same "field label" look form.add-source label gets, reproduced on a
     <div> instead of a <label> — a <label> wrapping the Write/Preview
     toggle buttons would make clicking them also fire the label's own
     default click-forwarding behavior, aimed at whatever form control
     the label wraps first (the textarea), which isn't what a toggle
     button click should do. */
  .body-field { font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
  .body-field-head { display: flex; align-items: center; justify-content: space-between; }
  .md-toggle { display: flex; gap: 4px; }
  .md-toggle-btn { padding: 2px 8px; font-size: 11px; background: transparent; }
  .md-toggle-btn.active { background: light-dark(#e8e8ea, #333338); font-weight: 600; }
  .markdown-body {
    border: 1px solid light-dark(#ccc, #444);
    border-radius: 6px;
    padding: 10px 14px;
    min-height: 280px;
    max-height: 480px;
    overflow-y: auto;
  }
  .markdown-body h1, .markdown-body h2 {
    border-bottom: 1px solid light-dark(#eee, #333338);
    padding-bottom: 4px;
  }
  .markdown-body pre {
    background: light-dark(#f6f8fa, #26262b);
    padding: 10px 12px;
    border-radius: 6px;
    overflow-x: auto;
  }
  .markdown-body code {
    background: light-dark(#eee, #2a2a2e);
    padding: 1px 5px;
    border-radius: 4px;
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  .markdown-body pre code { background: none; padding: 0; }
  .tool-picker-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 4px 0;
  }
  .tool-picker-controls button { font-size: 11px; padding: 3px 8px; }
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
<div class="page-body">
<nav class="section-sidebar">
  <a href="/agents/config" class="active">Agents</a>
  <a href="/config?section=models">Models</a>
  <a href="/config?section=gateways">Gateways</a>
</nav>
<div class="layout">
<nav class="sidebar">
  <ul id="agentList"></ul>
</nav>
<main>
  <div id="empty">Pick an agent to see its config.</div>
  <div id="detail" style="display:none"></div>
</main>
</div>
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
  // Same idea, for the Actauth tab's own separately-fetched GET
  // .../actauth (see renderActauthTabPlaceholder's own doc comment).
  var actauthLoadedFor = null;
  // The full /agents/:name/config response the currently-open agent was
  // last rendered from — kept around so refreshActauthDependentPanels/
  // refreshSkillsDependentPanels below can re-fetch and re-render just
  // the panels that read cfg (Overview, Skills) after a change, without
  // touching the Tools/Actauth tabs' own already-current state.
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

  // A small, deliberately non-CommonMark markdown-to-HTML renderer for
  // the skill Body field's Preview toggle (see wireSkillsHandlers) — this
  // page stays a self-contained string, no build step, no CDN (same
  // reasoning as devUiCss's own header comment), so pulling in a real
  // markdown library isn't an option without breaking that. Covers what
  // an actual SKILL.md body realistically uses (headings, bold/italic,
  // inline code, fenced code blocks, links, lists, rules, paragraphs) —
  // good enough for "does this read the way it will on GitHub", not a
  // spec-complete parser. Escapes first, so no markdown source can inject
  // raw HTML into the preview.
  function renderMarkdownPreview(md) {
    var lines = escapeHtml(md).split('\\n');
    var html = '';
    var inCode = false;
    var codeBuffer = '';
    var listType = null;
    var paragraph = [];

    // This whole page is one outer TS template literal AND its output is
    // itself served as JS source text a browser then parses again — two
    // layers of "escape sequences get processed", not one. The unicode
    // escape used for the backtick patterns below survives both layers fine, since
    // it's a real, recognized escape at both of them. A star/bracket/
    // paren/s/d/dot escape (\*, \[, \s, \d, \.) is *not* a recognized
    // escape at either layer, so each layer that touches it silently
    // drops the backslash and keeps just the character — confirmed by
    // extracting and executing the actually-served page during
    // development, where every regex built the "obvious" way here ended
    // up with its escapes stripped entirely, sometimes still parsing
    // (silently wrong) and sometimes throwing ("nothing to repeat").
    // Building these particular patterns from a runtime backslash
    // character instead sidesteps the whole problem: there is no
    // backslash-followed-by-letter sequence anywhere in this source for
    // either layer to misinterpret.
    var bs = String.fromCharCode(92);
    var inlineCodePattern = new RegExp('\\u0060([^\\u0060]+)\\u0060', 'g');
    var fencePattern = new RegExp('^\\u0060\\u0060\\u0060');
    var boldPattern = new RegExp(bs + '*' + bs + '*([^*]+)' + bs + '*' + bs + '*', 'g');
    var italicPattern = new RegExp(bs + '*([^*]+)' + bs + '*', 'g');
    var linkPattern = new RegExp(bs + '[([^' + bs + ']]+)' + bs + ']' + bs + '(([^)]+)' + bs + ')', 'g');
    var headingPattern = new RegExp('^(#{1,6})' + bs + 's+(.*)$');
    var hrPattern = new RegExp('^(---|' + bs + '*' + bs + '*' + bs + '*)' + bs + 's*$');
    var ulPattern = new RegExp('^[-*]' + bs + 's+(.*)$');
    var olPattern = new RegExp('^' + bs + 'd+' + bs + '.' + bs + 's+(.*)$');
    function inlineFormat(text) {
      return text
        .replace(inlineCodePattern, '<code>$1</code>')
        .replace(boldPattern, '<strong>$1</strong>')
        .replace(italicPattern, '<em>$1</em>')
        .replace(linkPattern, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    }
    function flushParagraph() {
      if (paragraph.length) {
        html += '<p>' + inlineFormat(paragraph.join(' ')) + '</p>';
        paragraph = [];
      }
    }
    function closeList() {
      if (listType) {
        html += '</' + listType + '>';
        listType = null;
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (fencePattern.test(line)) {
        if (!inCode) {
          flushParagraph();
          closeList();
          inCode = true;
          codeBuffer = '';
        } else {
          html += '<pre><code>' + codeBuffer + '</code></pre>';
          inCode = false;
        }
        continue;
      }
      if (inCode) {
        codeBuffer += line + '\\n';
        continue;
      }

      var heading = line.match(headingPattern);
      if (heading) {
        flushParagraph();
        closeList();
        var level = heading[1].length;
        html += '<h' + level + '>' + inlineFormat(heading[2]) + '</h' + level + '>';
        continue;
      }
      if (hrPattern.test(line)) {
        flushParagraph();
        closeList();
        html += '<hr>';
        continue;
      }
      var ul = line.match(ulPattern);
      var ol = line.match(olPattern);
      if (ul || ol) {
        flushParagraph();
        var wantType = ul ? 'ul' : 'ol';
        if (listType !== wantType) {
          closeList();
          html += '<' + wantType + '>';
          listType = wantType;
        }
        html += '<li>' + inlineFormat((ul || ol)[1]) + '</li>';
        continue;
      }
      closeList();

      if (line.trim() === '') {
        flushParagraph();
        continue;
      }
      paragraph.push(line.trim());
    }
    flushParagraph();
    closeList();
    return html || '<p class="hint">Nothing to preview yet.</p>';
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

  // Overview's own tools table, unlike the Tools tab's three separately-
  // headed sections (Local tools / Gateway Tools / Agent as Tools), is
  // one flat list (cfg.tools) — without a Type column there's no way to
  // tell, at a glance, where a given tool actually comes from. Built
  // from cfg.localTools/cfg.gatewayTools/cfg.agentAsTools directly
  // (same three arrays the Tools tab renders) rather than cfg.tools, so
  // each row can be tagged with which one it came from — same order as
  // the Tools tab's own sections, for consistency. Deliberately excludes
  // cfg.systemTools/cfg.systemSkills — infrastructure every agent gets
  // automatically (see run-agent.ts's systemTools/systemSkillsDir), not
  // something an operator configured, so this page hides them rather
  // than clutter the per-agent view with tools/skills that aren't
  // actually specific to this agent.
  function renderToolsWithType(cfg) {
    var rows = [];
    function addRows(tools, type) {
      for (var i = 0; i < tools.length; i++) {
        var t = tools[i];
        rows.push(
          '<tr><td><code>' + escapeHtml(t.name) + '</code></td>' +
            '<td>' + escapeHtml(t.description) + '</td>' +
            '<td>' + escapeHtml(type) + '</td>' +
            '<td>' + (t.safe ? 'yes' : 'no') + '</td></tr>',
        );
      }
    }
    addRows(cfg.localTools, 'Local');
    addRows(cfg.gatewayTools, 'Gateway');
    addRows(cfg.agentAsTools, 'Agent as Tool');
    if (!rows.length) return '<p class="muted">No tools.</p>';
    return '<table><thead><tr><th>Name</th><th>Description</th><th>Type</th><th>Parallel-safe</th></tr></thead><tbody>' + rows.join('') + '</tbody></table>';
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
    var systemPromptSection =
      '<h3>System prompt <button type="button" class="edit-btn" id="editSystemPromptBtn">Edit</button></h3>' +
      '<pre id="systemPromptDisplay">' + escapeHtml(cfg.systemPrompt) + '</pre>' +
      '<form class="add-source" id="systemPromptForm" style="display:none">' +
        '<textarea name="systemPrompt">' + escapeHtml(cfg.systemPrompt) + '</textarea>' +
        '<button type="submit">Save</button>' +
        '<button type="button" id="cancelSystemPromptBtn">Cancel</button>' +
        '<div class="error" id="systemPromptError"></div>' +
      '</form>';

    // Only editable when cfg.model is the resolved {provider, model,
    // maxTokens} object — a custom createModelCall (the string case) has
    // no config.model at all for agent-file-admin.ts's editAgentFile to
    // find and edit; see its own doc comment for why it refuses rather
    // than guessing at that case.
    var modelSection;
    if (typeof cfg.model === 'string') {
      modelSection = '<h3>Model</h3><p class="muted">' + escapeHtml(cfg.model) + '</p>';
    } else {
      modelSection =
        '<h3>Model <button type="button" class="edit-btn" id="editModelBtn">Edit</button></h3>' +
        '<dl class="kv" id="modelDisplay">' +
          '<dt>Provider</dt><dd>' + escapeHtml(cfg.model.provider) + '</dd>' +
          '<dt>Model</dt><dd>' + escapeHtml(cfg.model.model || '(provider default)') + '</dd>' +
          '<dt>Max tokens</dt><dd>' + escapeHtml(cfg.model.maxTokens != null ? cfg.model.maxTokens : '(default)') + '</dd>' +
        '</dl>' +
        '<form class="add-source" id="modelForm" style="display:none">' +
          '<label>Provider' +
            '<select name="provider">' +
              ['anthropic', 'openai', 'deepseek'].map(function (p) {
                return '<option value="' + p + '"' + (p === cfg.model.provider ? ' selected' : '') + '>' + p + '</option>';
              }).join('') +
            '</select>' +
          '</label>' +
          '<label>Model name <span class="hint">(required for openai/deepseek; defaults to claude-sonnet-5 for anthropic)</span>' +
            '<input type="text" name="modelName" value="' + escapeHtml(cfg.model.model || '') + '">' +
          '</label>' +
          '<button type="submit">Save</button>' +
          '<button type="button" id="cancelModelBtn">Cancel</button>' +
          '<div class="error" id="modelError"></div>' +
        '</form>';
    }

    return '<section>' + systemPromptSection + '</section>' +
      '<section>' + modelSection + '</section>' +
      '<section><h3>Skills (' + cfg.skills.length + ')</h3>' + renderSkills(cfg.skills) + '</section>' +
      '<section><h3>Tools (' + cfg.tools.length + ')</h3>' + renderToolsWithType(cfg) + '</section>' +
      '<section><h3>ActAuth</h3>' + renderRules(cfg.permissions) + '</section>' +
      '<section><h3>Hooks</h3><dl class="kv">' +
        '<dt>sessionIdFor</dt><dd>' + badge(cfg.sessionIdFor.indexOf('custom') === 0 ? 'custom' : 'default') + ' <span class="muted">' + escapeHtml(cfg.sessionIdFor) + '</span></dd>' +
        '<dt>tenantFor</dt><dd>' + badge(cfg.tenantFor.indexOf('custom') === 0 ? 'custom' : 'default') + ' <span class="muted">' + escapeHtml(cfg.tenantFor) + '</span></dd>' +
        '<dt>isSafeTool</dt><dd>' + badge(cfg.isSafeTool === 'custom' ? 'custom' : 'default') + ' <span class="muted">' + escapeHtml(cfg.isSafeTool) + '</span></dd>' +
        '</dl></section>' +
      '<section><h3>Limits &amp; budgets</h3><dl class="kv">' +
        '<dt>maxTurns</dt><dd>' + escapeHtml(cfg.maxTurns) + '</dd>' +
        '<dt>contextBudgetTokens</dt><dd>' + escapeHtml(cfg.contextBudgetTokens) + '</dd>' +
        '<dt>skillIndexBudgetTokens</dt><dd>' + escapeHtml(cfg.skillIndexBudgetTokens) + '</dd>' +
        '<dt>skillsDirs</dt><dd>' + escapeHtml(cfg.skillsDirs.join(', ') || '(none)') + '</dd>' +
        '</dl></section>';
  }

  // Wires the System prompt / Model Edit buttons rendered by
  // renderOverviewHtml above — called every time that HTML gets (re)set
  // (renderDetail, refreshOverviewPanel, refreshSkillsDependentPanels),
  // same pattern every other tab's own wireXHandlers already follows.
  // PUT /agents/:name persists via agent-file-admin.ts's editAgentFile
  // (see its own doc comment for why some agents' index.ts files can't
  // be safely edited this way at all — no editModelBtn is rendered for
  // those in the first place) and applies the change live; the response
  // is the freshly-resolved config, so this re-renders the whole
  // Overview panel from it directly instead of a second GET.
  function wireOverviewHandlers(name) {
    var overviewPanel = detail.querySelector('[data-tab-panel="overview"]');
    if (!overviewPanel) return;

    var editSystemPromptBtn = overviewPanel.querySelector('#editSystemPromptBtn');
    if (editSystemPromptBtn) {
      var systemPromptDisplay = overviewPanel.querySelector('#systemPromptDisplay');
      var systemPromptForm = overviewPanel.querySelector('#systemPromptForm');
      var systemPromptError = overviewPanel.querySelector('#systemPromptError');

      editSystemPromptBtn.addEventListener('click', function () {
        systemPromptDisplay.style.display = 'none';
        editSystemPromptBtn.style.display = 'none';
        systemPromptForm.style.display = '';
        systemPromptForm.querySelector('textarea').focus();
      });
      overviewPanel.querySelector('#cancelSystemPromptBtn').addEventListener('click', function () {
        systemPromptForm.style.display = 'none';
        systemPromptDisplay.style.display = '';
        editSystemPromptBtn.style.display = '';
        systemPromptError.textContent = '';
      });
      systemPromptForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        systemPromptError.textContent = '';
        var value = systemPromptForm.querySelector('textarea[name="systemPrompt"]').value;
        var submitBtn = systemPromptForm.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        fetch('/agents/' + encodeURIComponent(name), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ systemPrompt: value }),
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
          .then(function (result) {
            if (!result.ok) throw new Error(result.body.error || 'request failed');
            currentCfg = result.body;
            overviewPanel.innerHTML = renderOverviewHtml(result.body);
            wireOverviewHandlers(name);
          })
          .catch(function (err) {
            systemPromptError.textContent = err.message;
            submitBtn.disabled = false;
          });
      });
    }

    var editModelBtn = overviewPanel.querySelector('#editModelBtn');
    if (editModelBtn) {
      var modelDisplay = overviewPanel.querySelector('#modelDisplay');
      var modelForm = overviewPanel.querySelector('#modelForm');
      var modelError = overviewPanel.querySelector('#modelError');

      editModelBtn.addEventListener('click', function () {
        modelDisplay.style.display = 'none';
        editModelBtn.style.display = 'none';
        modelForm.style.display = '';
      });
      overviewPanel.querySelector('#cancelModelBtn').addEventListener('click', function () {
        modelForm.style.display = 'none';
        modelDisplay.style.display = '';
        editModelBtn.style.display = '';
        modelError.textContent = '';
      });
      modelForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        modelError.textContent = '';
        var data = new FormData(modelForm);
        var submitBtn = modelForm.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        var body = { model: { provider: data.get('provider') } };
        var modelName = data.get('modelName');
        if (modelName && modelName.trim()) body.model.model = modelName;
        fetch('/agents/' + encodeURIComponent(name), {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
          .then(function (result) {
            if (!result.ok) throw new Error(result.body.error || 'request failed');
            currentCfg = result.body;
            overviewPanel.innerHTML = renderOverviewHtml(result.body);
            wireOverviewHandlers(name);
          })
          .catch(function (err) {
            modelError.textContent = err.message;
            submitBtn.disabled = false;
          });
      });
    }
  }

  // ---- Overview's own Actauth section: read-only, from cfg.permissions
  // (already resolved by run-agent.ts's own loadRules — 3-segment
  // scopePattern, "when" conditions included). The dedicated Actauth tab
  // below is a *different* view: editable, and reading/writing the raw
  // 2-segment scope actauth.yml itself has, via a separately-fetched
  // GET /agents/:name/actauth — see renderActauthTabPlaceholder. Keeping
  // these two independent avoids a scope-format mismatch: round-tripping
  // cfg.permissions' own expanded 3-segment scopePattern back through an
  // edit would permanently "expand" a hand-authored 2-segment rule the
  // moment anyone touched it. ----

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

  // ---- Actauth tab: editable — add/edit/delete rules and set
  // default_decision via actauth-admin.ts, working directly against the
  // file's own raw scope strings (see the comment above). Lazily loaded
  // the same way Gateway Tools is (see loadActauthTab/actauthLoadedFor):
  // not because reading it is expensive here (it's a plain file read,
  // unlike describeGatewayTools' live reconnects), just to avoid a
  // redundant fetch on every agent switch for a tab that isn't always
  // opened. ----

  function renderActauthTabPlaceholder() {
    return '<section id="actauthSection"><div id="actauthContent"><p class="hint">Loading&hellip;</p></div></section>';
  }

  function renderActauthRuleRow(r) {
    var actionsHtml = r.name
      ? '<button type="button" class="edit-rule-btn" data-name="' + escapeHtml(r.name) + '">Edit</button> ' +
        '<button type="button" class="delete-btn delete-rule-btn" data-name="' + escapeHtml(r.name) + '" title="Remove this rule" aria-label="Remove this rule">Delete</button>'
      // A rule with no "name" in the YAML has nothing this tab's
      // update/removeActauthRule (both keyed by name) can address — left
      // visible, but not editable here.
      : '<span class="hint">unnamed — edit actauth.yml directly</span>';
    return '<tr>' +
      '<td><code>' + escapeHtml(r.name || '') + '</code></td>' +
      '<td><code>' + escapeHtml(r.scope) + '</code></td>' +
      '<td><code>' + escapeHtml(r.tool) + '</code></td>' +
      '<td class="' + decisionClass(r.decision) + '">' + escapeHtml(r.decision) + '</td>' +
      '<td>' + actionsHtml + '</td>' +
      '</tr>';
  }

  function renderActauthConfigHtml(cfg) {
    var rulesHtml = cfg.rules.length
      ? '<table><thead><tr><th>Name</th><th>Scope</th><th>Tool</th><th>Decision</th><th></th></tr></thead><tbody>' +
        cfg.rules.map(renderActauthRuleRow).join('') + '</tbody></table>'
      : '<p class="hint">No explicit rules — every tool call falls through to the default decision.</p>';

    return '<section><h3>Default decision</h3>' +
        '<form class="add-source" id="defaultDecisionForm" style="max-width:220px">' +
          '<label>Applies when no rule matches' +
            '<select name="defaultDecision" id="defaultDecisionSelect">' +
              '<option value="allow"' + (cfg.defaultDecision === 'allow' ? ' selected' : '') + '>allow</option>' +
              '<option value="ask"' + (cfg.defaultDecision === 'ask' ? ' selected' : '') + '>ask</option>' +
              '<option value="deny"' + (cfg.defaultDecision === 'deny' ? ' selected' : '') + '>deny</option>' +
            '</select>' +
          '</label>' +
          '<button type="submit">Save</button>' +
          '<div id="defaultDecisionError" class="error"></div>' +
        '</form></section>' +
      '<section><h3>Rules (' + cfg.rules.length + ')</h3>' + rulesHtml + '</section>' +
      '<section><h3 id="ruleFormHeading">Add a rule</h3>' +
        '<form class="add-source" id="ruleForm">' +
          '<label>Name' +
            '<input name="name" id="ruleNameInput" required placeholder="my-rule-name">' +
          '</label>' +
          '<label>Scope <span class="hint">(tenant/environment — e.g. "default/production" or "*/*"; the agent segment is appended automatically)</span>' +
            '<input name="scope" id="ruleScopeInput" required placeholder="default/production">' +
          '</label>' +
          '<label>Tool' +
            '<input name="tool" id="ruleToolInput" required placeholder="write_file">' +
          '</label>' +
          '<label>Decision' +
            '<select name="decision" id="ruleDecisionInput">' +
              '<option value="allow">allow</option>' +
              '<option value="ask" selected>ask</option>' +
              '<option value="deny">deny</option>' +
            '</select>' +
          '</label>' +
          '<button type="submit" id="ruleSubmitBtn">Add</button>' +
          '<button type="button" id="ruleCancelBtn" style="display:none">Cancel</button>' +
          '<div id="ruleFormError" class="error"></div>' +
        '</form></section>';
  }

  function actauthContentEl() {
    return detail.querySelector('#actauthContent');
  }

  function wireActauthHandlers(name, cfg) {
    var content = actauthContentEl();
    if (!content) return;
    var editingRuleName = null;

    function ruleByName(ruleName) {
      for (var i = 0; i < cfg.rules.length; i++) {
        if (cfg.rules[i].name === ruleName) return cfg.rules[i];
      }
      return null;
    }

    function resetRuleForm() {
      var form = content.querySelector('#ruleForm');
      form.reset();
      content.querySelector('#ruleNameInput').disabled = false;
      content.querySelector('#ruleFormHeading').textContent = 'Add a rule';
      content.querySelector('#ruleSubmitBtn').textContent = 'Add';
      content.querySelector('#ruleCancelBtn').style.display = 'none';
      content.querySelector('#ruleFormError').textContent = '';
      editingRuleName = null;
    }

    var deleteButtons = content.querySelectorAll('.delete-rule-btn');
    for (var i = 0; i < deleteButtons.length; i++) {
      deleteButtons[i].addEventListener('click', function (ev) {
        var btn = ev.currentTarget;
        var ruleName = btn.getAttribute('data-name');
        if (!confirm('Remove rule "' + ruleName + '"?')) return;
        btn.disabled = true;
        fetch('/agents/' + encodeURIComponent(name) + '/actauth/rules/' + encodeURIComponent(ruleName), { method: 'DELETE' })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
          .then(function (result) {
            if (!result.ok) throw new Error(result.body.error || 'request failed');
            applyActauthConfig(name, result.body);
            refreshOverviewPanel(name);
          })
          .catch(function (err) {
            alert('Could not remove: ' + err.message);
            btn.disabled = false;
          });
      });
    }

    var editButtons = content.querySelectorAll('.edit-rule-btn');
    for (var i = 0; i < editButtons.length; i++) {
      editButtons[i].addEventListener('click', function (ev) {
        var ruleName = ev.currentTarget.getAttribute('data-name');
        var rule = ruleByName(ruleName);
        if (!rule) return;
        content.querySelector('#ruleNameInput').value = rule.name;
        content.querySelector('#ruleNameInput').disabled = true;
        content.querySelector('#ruleScopeInput').value = rule.scope;
        content.querySelector('#ruleToolInput').value = rule.tool;
        content.querySelector('#ruleDecisionInput').value = rule.decision;
        content.querySelector('#ruleFormHeading').textContent = 'Edit rule "' + rule.name + '"';
        content.querySelector('#ruleSubmitBtn').textContent = 'Save';
        content.querySelector('#ruleCancelBtn').style.display = '';
        content.querySelector('#ruleFormError').textContent = '';
        editingRuleName = rule.name;
        content.querySelector('#ruleForm').scrollIntoView({ block: 'nearest' });
      });
    }

    content.querySelector('#ruleCancelBtn').addEventListener('click', resetRuleForm);

    var ruleForm = content.querySelector('#ruleForm');
    ruleForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var errorEl = content.querySelector('#ruleFormError');
      errorEl.textContent = '';
      var data = new FormData(ruleForm);
      var scope = data.get('scope');
      var tool = data.get('tool');
      var decision = data.get('decision');
      var submitBtn = content.querySelector('#ruleSubmitBtn');
      submitBtn.disabled = true;

      var request = editingRuleName
        ? fetch('/agents/' + encodeURIComponent(name) + '/actauth/rules/' + encodeURIComponent(editingRuleName), {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ scope: scope, tool: tool, decision: decision }),
          })
        : fetch('/agents/' + encodeURIComponent(name) + '/actauth/rules', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: data.get('name'), scope: scope, tool: tool, decision: decision }),
          });

      request
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (result) {
          if (!result.ok) throw new Error(result.body.error || 'request failed');
          applyActauthConfig(name, result.body);
          refreshOverviewPanel(name);
        })
        .catch(function (err) {
          errorEl.textContent = err.message;
          submitBtn.disabled = false;
        });
    });

    var defaultForm = content.querySelector('#defaultDecisionForm');
    defaultForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var errorEl = content.querySelector('#defaultDecisionError');
      errorEl.textContent = '';
      var decision = content.querySelector('#defaultDecisionSelect').value;
      fetch('/agents/' + encodeURIComponent(name) + '/actauth/default-decision', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: decision }),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (result) {
          if (!result.ok) throw new Error(result.body.error || 'request failed');
          applyActauthConfig(name, result.body);
          refreshOverviewPanel(name);
        })
        .catch(function (err) {
          errorEl.textContent = err.message;
        });
    });
  }

  function applyActauthConfig(name, cfg) {
    var content = actauthContentEl();
    if (!content) return;
    content.innerHTML = renderActauthConfigHtml(cfg);
    wireActauthHandlers(name, cfg);
    actauthLoadedFor = name;
  }

  function loadActauthTab(name) {
    var content = actauthContentEl();
    if (!content) return;
    content.innerHTML = '<p class="hint">Loading&hellip;</p>';
    fetch('/agents/' + encodeURIComponent(name) + '/actauth')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (currentName !== name) return;
        applyActauthConfig(name, cfg);
      })
      .catch(function (err) {
        if (currentName !== name) return;
        content.innerHTML = '<p class="error">Could not load actauth rules: ' + escapeHtml(err.message) + '</p>';
      });
  }

  // ---- Skills tab: editable — add/edit/delete SKILL.md files via
  // skills-admin.ts, restricted (see that file's own doc comment) to
  // flat, non-nested skill ids. Unlike the Tools tab's Gateway Tools
  // section, this doesn't need its own lazy-loaded endpoint — cfg.skills
  // (SkillGarden's own index: name + description, no body) is already
  // free from the same /config fetch that opened the agent; only Edit
  // needs a further per-skill GET, to pull the body that index doesn't
  // carry. ----

  function renderSkillCard(s) {
    return '<div class="source">' +
      '<div class="source-head">' +
        '<h4>' + escapeHtml(s.name) + '</h4>' +
        '<span>' +
          '<button type="button" class="edit-skill-btn" data-id="' + escapeHtml(s.name) + '">Edit</button> ' +
          '<button type="button" class="delete-btn delete-skill-btn" data-id="' + escapeHtml(s.name) + '" title="Delete this skill" aria-label="Delete this skill">Delete</button>' +
        '</span>' +
      '</div>' +
      '<p class="hint">' + escapeHtml(s.description) + '</p>' +
      '</div>';
  }

  function renderSkillsTabHtml(cfg) {
    var listHtml = cfg.skills.length ? cfg.skills.map(renderSkillCard).join('') : '<p class="hint">No skills yet.</p>';
    return '<section><h3>Skills dirs</h3><dl class="kv">' +
        '<dt>skillsDirs</dt><dd>' + escapeHtml(cfg.skillsDirs.join(', ') || '(none)') + '</dd>' +
        '<dt>skillIndexBudgetTokens</dt><dd>' + escapeHtml(cfg.skillIndexBudgetTokens) + '</dd>' +
        '</dl></section>' +
      '<section><h3>Skills (' + cfg.skills.length + ')</h3><div id="skillList">' + listHtml + '</div></section>' +
      '<section><h3 id="skillFormHeading">Add a skill</h3>' +
        '<form class="add-source" id="skillForm">' +
          '<label>Id <span class="hint">(lowercase, hyphen-separated — becomes the SKILL.md folder name; nested skills aren\\'t editable here)</span>' +
            '<input name="id" id="skillIdInput" required pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="summarize-files">' +
          '</label>' +
          '<label>Description <span class="hint">(what should make the agent reach for this? newlines are collapsed to spaces on save)</span>' +
            '<textarea name="description" id="skillDescInput" required></textarea>' +
          '</label>' +
          '<div class="body-field">' +
            '<div class="body-field-head">' +
              '<span>Body <span class="hint">(markdown)</span></span>' +
              '<span class="md-toggle">' +
                '<button type="button" class="md-toggle-btn active" id="skillBodyWriteBtn">Write</button>' +
                '<button type="button" class="md-toggle-btn" id="skillBodyPreviewBtn">Preview</button>' +
              '</span>' +
            '</div>' +
            '<textarea name="body" id="skillBodyInput" required></textarea>' +
            '<div class="markdown-body" id="skillBodyPreview" style="display:none"></div>' +
          '</div>' +
          '<button type="submit" id="skillSubmitBtn">Add</button>' +
          '<button type="button" id="skillCancelBtn" style="display:none">Cancel</button>' +
          '<div id="skillFormError" class="error"></div>' +
        '</form></section>';
  }

  function skillsPanelEl() {
    return detail.querySelector('[data-tab-panel="skills"]');
  }

  function wireSkillsHandlers(name) {
    var panel = skillsPanelEl();
    if (!panel) return;
    var editingSkillId = null;

    // Write/Preview toggle for the Body field — same idea as GitHub's own
    // issue/PR editor: the textarea and the rendered preview show/hide
    // each other, the textarea's value is the only source of truth (the
    // preview is just a render of it on demand, not a second place edits
    // could get made), so switching back to Write can never lose anything
    // typed before switching to Preview.
    var bodyTextarea = panel.querySelector('#skillBodyInput');
    var bodyPreview = panel.querySelector('#skillBodyPreview');
    var bodyWriteBtn = panel.querySelector('#skillBodyWriteBtn');
    var bodyPreviewBtn = panel.querySelector('#skillBodyPreviewBtn');

    function showBodyWrite() {
      bodyTextarea.style.display = '';
      bodyPreview.style.display = 'none';
      bodyWriteBtn.classList.add('active');
      bodyPreviewBtn.classList.remove('active');
    }
    function showBodyPreview() {
      bodyPreview.innerHTML = renderMarkdownPreview(bodyTextarea.value);
      bodyTextarea.style.display = 'none';
      bodyPreview.style.display = 'block';
      bodyPreviewBtn.classList.add('active');
      bodyWriteBtn.classList.remove('active');
    }
    bodyWriteBtn.addEventListener('click', showBodyWrite);
    bodyPreviewBtn.addEventListener('click', showBodyPreview);

    function resetSkillForm() {
      var form = panel.querySelector('#skillForm');
      form.reset();
      panel.querySelector('#skillIdInput').disabled = false;
      panel.querySelector('#skillFormHeading').textContent = 'Add a skill';
      panel.querySelector('#skillSubmitBtn').textContent = 'Add';
      panel.querySelector('#skillCancelBtn').style.display = 'none';
      panel.querySelector('#skillFormError').textContent = '';
      editingSkillId = null;
      showBodyWrite();
    }

    var deleteButtons = panel.querySelectorAll('.delete-skill-btn');
    for (var i = 0; i < deleteButtons.length; i++) {
      deleteButtons[i].addEventListener('click', function (ev) {
        var btn = ev.currentTarget;
        var id = btn.getAttribute('data-id');
        if (!confirm('Delete skill "' + id + '"? This removes its SKILL.md.')) return;
        btn.disabled = true;
        fetch('/agents/' + encodeURIComponent(name) + '/skills/' + encodeURIComponent(id), { method: 'DELETE' })
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
          .then(function (result) {
            if (!result.ok) throw new Error(result.body.error || 'request failed');
            refreshSkillsDependentPanels(name);
          })
          .catch(function (err) {
            alert('Could not delete: ' + err.message);
            btn.disabled = false;
          });
      });
    }

    var editButtons = panel.querySelectorAll('.edit-skill-btn');
    for (var i = 0; i < editButtons.length; i++) {
      editButtons[i].addEventListener('click', function (ev) {
        var id = ev.currentTarget.getAttribute('data-id');
        var errorEl = panel.querySelector('#skillFormError');
        errorEl.textContent = '';
        fetch('/agents/' + encodeURIComponent(name) + '/skills/' + encodeURIComponent(id))
          .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
          .then(function (result) {
            if (!result.ok) throw new Error(result.body.error || 'request failed');
            panel.querySelector('#skillIdInput').value = result.body.id;
            panel.querySelector('#skillIdInput').disabled = true;
            panel.querySelector('#skillDescInput').value = result.body.description;
            panel.querySelector('#skillBodyInput').value = result.body.body;
            panel.querySelector('#skillFormHeading').textContent = 'Edit skill "' + result.body.id + '"';
            panel.querySelector('#skillSubmitBtn').textContent = 'Save';
            panel.querySelector('#skillCancelBtn').style.display = '';
            editingSkillId = result.body.id;
            showBodyWrite();
            panel.querySelector('#skillForm').scrollIntoView({ block: 'nearest' });
          })
          .catch(function (err) {
            errorEl.textContent = 'Could not load skill: ' + err.message;
          });
      });
    }

    panel.querySelector('#skillCancelBtn').addEventListener('click', resetSkillForm);

    var form = panel.querySelector('#skillForm');
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var errorEl = panel.querySelector('#skillFormError');
      errorEl.textContent = '';
      var data = new FormData(form);
      // writeSkill (both routes go through the same PUT) creates-or-
      // replaces — so "Add" with an id that already exists just
      // overwrites it, same as editing it directly would.
      var id = editingSkillId || data.get('id');
      var submitBtn = panel.querySelector('#skillSubmitBtn');
      submitBtn.disabled = true;
      fetch('/agents/' + encodeURIComponent(name) + '/skills/' + encodeURIComponent(id), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ description: data.get('description'), body: data.get('body') }),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (result) {
          if (!result.ok) throw new Error(result.body.error || 'request failed');
          refreshSkillsDependentPanels(name);
        })
        .catch(function (err) {
          errorEl.textContent = err.message;
          submitBtn.disabled = false;
        });
    });
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
    return '<section><h3>Local tools (' + cfg.localTools.length + ')</h3>' + renderTools(cfg.localTools) +
      '<div class="http-tool-subsection"><h4>Create an HTTP tool</h4>' + renderHttpToolFormHtml() + '</div>' +
      '</section>' +
      '<section id="gatewayToolsSection">' +
        '<h3>Gateway Tools <button type="button" id="gatewayToolsRefreshBtn" class="hint-btn">Refresh</button></h3>' +
        '<div id="gatewayToolsContent"><p class="hint">Loading&hellip;</p></div>' +
      '</section>' +
      '<section><h3>Agent as Tools (' + cfg.agentAsTools.length + ')</h3>' + renderTools(cfg.agentAsTools) + '</section>';
  }

  // ---- Create an HTTP tool: generates a real agents/:name/tools/<tool>.ts
  // file from this form (loopengine's own createHttpTool), never arbitrary
  // code — only one shape, a parameterized HTTP call. See
  // web/http-tool-admin.ts's own header comment for why this is the line
  // this repo draws instead of, say, storing code in a SKILL.md and
  // executing it at request time. ----

  var httpToolFieldRowCount = 0;
  var httpToolHeaderRowCount = 0;

  function renderHttpToolFieldRow(index) {
    return '<div class="http-tool-field-row" data-row="' + index + '">' +
      '<input type="text" class="http-tool-field-name" placeholder="field_name" pattern="[a-zA-Z_][a-zA-Z0-9_]*">' +
      '<select class="http-tool-field-type">' +
        '<option value="string">string</option>' +
        '<option value="number">number</option>' +
        '<option value="boolean">boolean</option>' +
      '</select>' +
      '<input type="text" class="http-tool-field-description" placeholder="description (optional)">' +
      '<label class="http-tool-inline-label"><input type="checkbox" class="http-tool-field-required" checked> required</label>' +
      '<button type="button" class="delete-btn http-tool-remove-row" title="Remove this field" aria-label="Remove this field">Delete</button>' +
      '</div>';
  }

  function renderHttpToolHeaderRow(index) {
    return '<div class="http-tool-header-row" data-row="' + index + '">' +
      '<input type="text" class="http-tool-header-key" placeholder="Header-Name">' +
      '<input type="text" class="http-tool-header-value" placeholder="value, {field}, or {{ENV_VAR}}">' +
      '<button type="button" class="delete-btn http-tool-remove-row" title="Remove this header" aria-label="Remove this header">Delete</button>' +
      '</div>';
  }

  function renderHttpToolFormHtml() {
    httpToolFieldRowCount = 0;
    httpToolHeaderRowCount = 0;
    return '<form class="add-source" id="httpToolForm">' +
      '<label>Name <span class="hint">(snake_case, e.g. lookup_order_status)</span>' +
        '<input type="text" name="name" required pattern="[a-z][a-z0-9_]*" placeholder="lookup_order_status">' +
      '</label>' +
      '<label>Description' +
        '<input type="text" name="description" required placeholder="What this tool does">' +
      '</label>' +
      '<label>Fields' +
        '<div id="httpToolFieldRows"></div>' +
        '<button type="button" id="httpToolAddFieldBtn" class="hint-btn">Add field</button>' +
      '</label>' +
      '<label>Method &amp; URL <span class="hint">(use {field} for a field defined above)</span>' +
        '<div class="http-tool-method-url">' +
          '<select name="method">' +
            '<option value="GET">GET</option>' +
            '<option value="POST">POST</option>' +
            '<option value="PUT">PUT</option>' +
            '<option value="PATCH">PATCH</option>' +
            '<option value="DELETE">DELETE</option>' +
          '</select>' +
          '<input type="text" name="url" required placeholder="https://api.example.com/orders/{orderId}">' +
        '</div>' +
      '</label>' +
      '<label>Headers <span class="hint">(a value may reference {field} or {{ENV_VAR}} &mdash; never paste a real secret here)</span>' +
        '<div id="httpToolHeaderRows"></div>' +
        '<button type="button" id="httpToolAddHeaderBtn" class="hint-btn">Add header</button>' +
      '</label>' +
      '<label class="http-tool-inline-label"><input type="checkbox" name="sendFieldsAsJsonBody"> Send fields as a JSON body (POST/PUT/PATCH only)</label>' +
      '<label>Response JSON path <span class="hint">(optional &mdash; e.g. data.status; leave blank to return the raw response text)</span>' +
        '<input type="text" name="responseJsonPath" placeholder="data.status">' +
      '</label>' +
      '<label>Grant permission <span class="hint">(optional &mdash; leave blank to leave this tool at actauth&#39;s own default, typically deny)</span>' +
        '<select name="decision">' +
          '<option value="">(leave unset)</option>' +
          '<option value="allow">allow</option>' +
          '<option value="ask">ask</option>' +
          '<option value="deny">deny</option>' +
        '</select>' +
      '</label>' +
      '<button type="submit" id="httpToolSubmitBtn">Create tool</button>' +
      '<div id="httpToolError" class="error"></div>' +
      '</form>';
  }

  function wireHttpToolRemoveButton(row) {
    var btn = row.querySelector('.http-tool-remove-row');
    btn.addEventListener('click', function () {
      row.parentNode.removeChild(row);
    });
  }

  function wireHttpToolFormHandlers(name) {
    var form = detail.querySelector('#httpToolForm');
    if (!form) return;

    var fieldRows = detail.querySelector('#httpToolFieldRows');
    var headerRows = detail.querySelector('#httpToolHeaderRows');
    var addFieldBtn = detail.querySelector('#httpToolAddFieldBtn');
    var addHeaderBtn = detail.querySelector('#httpToolAddHeaderBtn');
    var errorEl = detail.querySelector('#httpToolError');
    var submitBtn = detail.querySelector('#httpToolSubmitBtn');

    addFieldBtn.addEventListener('click', function () {
      fieldRows.insertAdjacentHTML('beforeend', renderHttpToolFieldRow(httpToolFieldRowCount++));
      wireHttpToolRemoveButton(fieldRows.lastElementChild);
    });
    addHeaderBtn.addEventListener('click', function () {
      headerRows.insertAdjacentHTML('beforeend', renderHttpToolHeaderRow(httpToolHeaderRowCount++));
      wireHttpToolRemoveButton(headerRows.lastElementChild);
    });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      errorEl.textContent = '';

      var fields = [];
      var fieldRowEls = fieldRows.querySelectorAll('.http-tool-field-row');
      for (var i = 0; i < fieldRowEls.length; i++) {
        var row = fieldRowEls[i];
        var fieldName = row.querySelector('.http-tool-field-name').value.trim();
        if (!fieldName) continue;
        fields.push({
          name: fieldName,
          type: row.querySelector('.http-tool-field-type').value,
          description: row.querySelector('.http-tool-field-description').value.trim() || undefined,
          required: row.querySelector('.http-tool-field-required').checked,
        });
      }

      var headers = [];
      var headerRowEls = headerRows.querySelectorAll('.http-tool-header-row');
      for (var j = 0; j < headerRowEls.length; j++) {
        var hrow = headerRowEls[j];
        var headerKey = hrow.querySelector('.http-tool-header-key').value.trim();
        if (!headerKey) continue;
        headers.push({ key: headerKey, value: hrow.querySelector('.http-tool-header-value').value });
      }

      var formData = new FormData(form);
      var payload = {
        name: formData.get('name'),
        description: formData.get('description'),
        fields: fields,
        method: formData.get('method'),
        url: formData.get('url'),
        headers: headers,
        sendFieldsAsJsonBody: formData.get('sendFieldsAsJsonBody') === 'on',
        responseJsonPath: formData.get('responseJsonPath') ? formData.get('responseJsonPath') : undefined,
        decision: formData.get('decision') ? formData.get('decision') : undefined,
      };

      submitBtn.disabled = true;
      fetch('/agents/' + encodeURIComponent(name) + '/tools/http', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (result) {
          if (!result.ok) throw new Error(result.body.error || 'request failed');
          selectAgent(name);
        })
        .catch(function (err) {
          errorEl.textContent = err.message;
          submitBtn.disabled = false;
        });
    });
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
            ' <button type="button" class="delete-btn" data-source="' + escapeHtml(s.entry.name) + '" data-slug="' + escapeHtml(slug) + '" title="Remove this tool" aria-label="Remove this tool">Delete</button>' +
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
      : '<p class="hint">No gateway tools registered yet.</p>';

    // App + tool picker instead of freeform slug entry — pulled from
    // GET /composio/connections and GET /composio/tools?toolkit=X (see
    // wireGatewayHandlers below), so adding a source means checking boxes
    // for what's already connected and available, not needing to already
    // know a toolkit's exact slug strings by heart.
    return '<section><div id="sourceList">' + listHtml + '</div></section>' +
      '<section><h3>Add a gateway tool</h3>' +
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
          '<div class="tool-picker-controls">' +
            '<button type="button" id="selectAllToolsBtn" disabled>Select all</button>' +
            '<span class="hint" id="selectedCount"></span>' +
          '</div>' +
          '<div class="tool-picker-list" id="toolPickerList"><p class="hint">Pick an app above first.</p></div>' +
        '</label>' +
        '<label>Grant permission <span class="hint">(optional — leave blank to leave every new tool at actauth\\'s own default, typically deny)</span>' +
          '<select name="decision">' +
            '<option value="">(leave unset)</option>' +
            '<option value="auto" selected>auto — allow read-only tools, ask for the rest</option>' +
            '<option value="allow">allow</option>' +
            '<option value="ask">ask</option>' +
            '<option value="deny">deny</option>' +
          '</select>' +
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
    var removeToolButtons = content.querySelectorAll('.delete-btn');
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
    var selectAllBtn = content.querySelector('#selectAllToolsBtn');
    var selectedCountEl = content.querySelector('#selectedCount');
    var submitBtn = content.querySelector('#addSubmitBtn');
    var currentTools = [];
    // Tracks whichever toolkit slug the Name field was last auto-filled
    // with, so switching apps updates an untouched Name along with it —
    // but the moment a person types their own value in, it stops
    // clobbering that on the next app switch.
    var nameAutoFilledAs = '';

    function updateSelectedCount() {
      var boxes = toolPickerList.querySelectorAll('input[name="slugs"]');
      var checked = toolPickerList.querySelectorAll('input[name="slugs"]:checked').length;
      selectedCountEl.textContent = checked ? checked + ' of ' + boxes.length + ' selected' : '';
    }

    function renderToolPicker(tools, filterText) {
      var q = (filterText || '').toLowerCase();
      var filtered = !q
        ? tools
        : tools.filter(function (t) {
            return t.slug.toLowerCase().indexOf(q) !== -1 || t.name.toLowerCase().indexOf(q) !== -1 || t.description.toLowerCase().indexOf(q) !== -1;
          });
      if (!filtered.length) {
        toolPickerList.innerHTML = '<p class="hint">No matching tools.</p>';
        updateSelectedCount();
        return;
      }
      toolPickerList.innerHTML = filtered.map(function (t) {
        return '<label class="tool-picker-item">' +
          '<span class="tool-picker-label"><strong>' + escapeHtml(t.name) + '</strong> <span class="hint">' + escapeHtml(t.slug) + '</span>' +
          '<br><span class="hint">' + escapeHtml(t.description) + '</span></span>' +
          '<input type="checkbox" name="slugs" value="' + escapeHtml(t.slug) + '">' +
          '</label>';
      }).join('');
      var boxes = toolPickerList.querySelectorAll('input[name="slugs"]');
      for (var i = 0; i < boxes.length; i++) {
        boxes[i].addEventListener('change', updateSelectedCount);
      }
      updateSelectedCount();
    }

    // Acts only on the currently-filtered/visible tools, not every tool
    // the toolkit has — filtering to "issue" and hitting Select all is
    // meant to select the issue-related tools shown, not silently pull
    // in everything else the toolkit offers too. Toggles: if everything
    // visible is already checked, this unchecks it instead.
    selectAllBtn.addEventListener('click', function () {
      var boxes = toolPickerList.querySelectorAll('input[name="slugs"]');
      if (!boxes.length) return;
      var allChecked = Array.prototype.every.call(boxes, function (b) { return b.checked; });
      for (var i = 0; i < boxes.length; i++) boxes[i].checked = !allChecked;
      updateSelectedCount();
    });

    function loadToolsForToolkit(toolkit) {
      toolPickerList.innerHTML = '<p class="hint">Loading tools&hellip;</p>';
      submitBtn.disabled = true;
      selectAllBtn.disabled = true;
      fetch('/composio/tools?toolkit=' + encodeURIComponent(toolkit))
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); })
        .then(function (result) {
          if (!result.ok) throw new Error(result.body.error || 'request failed');
          currentTools = result.body.tools || [];
          renderToolPicker(currentTools, toolFilter.value);
          submitBtn.disabled = false;
          selectAllBtn.disabled = false;
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
        selectAllBtn.disabled = true;
        selectedCountEl.textContent = '';
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

  // force: true bypasses describeGatewayTools' own cache (see its own
  // doc comment) — the "Refresh" button's case, for when an operator
  // actually wants a live re-check (e.g. after reconnecting an account),
  // not the default tab-open case, which is happy with whatever a prior
  // load in this same gateway-tools.yml's lifetime already found.
  function loadGatewayTab(name, force) {
    var content = gatewayContentEl();
    if (!content) return;
    content.innerHTML = '<p class="hint">Loading&hellip;</p>';
    fetch('/agents/' + encodeURIComponent(name) + '/gateway-tools' + (force ? '?refresh=1' : ''))
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
    if (tab === 'actauth' && actauthLoadedFor !== currentName) {
      loadActauthTab(currentName);
    }
  }

  // Refreshes just Overview's own summary — used after anything that
  // changes tools/skills/permissions but already has its own tab
  // reflecting the change directly from the response (applyGatewaySources,
  // applyActauthConfig, refreshSkillsDependentPanels's own Skills half),
  // so only Overview is left needing a re-fetch.
  function refreshOverviewPanel(name) {
    fetch('/agents/' + encodeURIComponent(name) + '/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (currentName !== name) return;
        currentCfg = cfg;
        var overviewPanel = detail.querySelector('[data-tab-panel="overview"]');
        if (overviewPanel) {
          overviewPanel.innerHTML = renderOverviewHtml(cfg);
          wireOverviewHandlers(name);
        }
      })
      .catch(function () {
        // Best-effort — the tab that triggered this already reflects the
        // change either way, this is only about keeping Overview in sync.
      });
  }

  // Adding or removing a gateway tool changes actauth.yml (a decision
  // seeds/drops a rule for it — see gateway-tools.ts's addGatewayTool/
  // removeGatewayToolSlug) but Overview's own Actauth section and the
  // dedicated Actauth tab were both rendered once, from whatever cfg
  // /agents/:name/config (and, for the Actauth tab, GET .../actauth)
  // returned when the agent/tab was first opened — without this, a rule
  // added or removed from the Tools tab wouldn't show up there until the
  // agent was re-selected or the page reloaded. Only re-loads the
  // Actauth tab if it's actually been opened already (actauthLoadedFor)
  // — otherwise it'll load fresh, gateway-tool-seeded rules included,
  // the first time it is.
  function refreshActauthDependentPanels(name) {
    refreshOverviewPanel(name);
    if (actauthLoadedFor === name) loadActauthTab(name);
  }

  // Skills tab isn't lazily loaded like Gateway Tools/Actauth (see its
  // own header comment — it's already free from cfg, no live connection
  // needed) — so refreshing it after an add/edit/delete just means
  // re-rendering both it and Overview from a fresh /config fetch.
  function refreshSkillsDependentPanels(name) {
    fetch('/agents/' + encodeURIComponent(name) + '/config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (currentName !== name) return;
        currentCfg = cfg;
        var overviewPanel = detail.querySelector('[data-tab-panel="overview"]');
        var skillsPanel = skillsPanelEl();
        if (overviewPanel) {
          overviewPanel.innerHTML = renderOverviewHtml(cfg);
          wireOverviewHandlers(name);
        }
        if (skillsPanel) {
          skillsPanel.innerHTML = renderSkillsTabHtml(cfg);
          wireSkillsHandlers(name);
        }
      })
      .catch(function () {});
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
        '<button class="tab" data-tab="actauth">ActAuth</button>' +
      '</div>' +
      '<div class="tab-panel" data-tab-panel="overview">' + renderOverviewHtml(cfg) + '</div>' +
      '<div class="tab-panel" data-tab-panel="skills">' + renderSkillsTabHtml(cfg) + '</div>' +
      '<div class="tab-panel" data-tab-panel="tools">' + renderToolsTabHtml(cfg) + '</div>' +
      '<div class="tab-panel" data-tab-panel="actauth">' + renderActauthTabPlaceholder() + '</div>';

    var buttons = detail.querySelectorAll('.tabs button');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (ev) { switchTab(ev.currentTarget.dataset.tab); });
    }

    wireSkillsHandlers(cfg.name);
    wireOverviewHandlers(cfg.name);
    wireHttpToolFormHandlers(cfg.name);
    var gatewayRefreshBtn = detail.querySelector('#gatewayToolsRefreshBtn');
    if (gatewayRefreshBtn) {
      gatewayRefreshBtn.addEventListener('click', function () { loadGatewayTab(cfg.name, true); });
    }

    empty.style.display = 'none';
    detail.style.display = 'block';
    switchTab(currentTab);
  }

  function selectAgent(name) {
    currentName = name;
    gatewayLoadedFor = null;
    actauthLoadedFor = null;
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
