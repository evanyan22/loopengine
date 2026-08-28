// Shared look for every browser page adapters/http.ts serves — playground
// (playground.ts), the per-agent config viewer (agents-config-page.ts),
// and the agents index (agents-list-page.ts). Pulled out once these grew to
// three pages that all want the same fonts/colors/form controls: without
// this, harmonizing them meant hand-syncing the same CSS block in three
// separate template-literal strings every time one changed. Kept to the
// tokens actually shared across all three (base colors, form controls,
// badges, the cross-page nav strip) — each page still owns its own
// page-specific rules (chat bubbles, timeline events, permission tables, ...)
// in its own <style> block.
export const devUiCss: string = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: light-dark(#f7f7f8, #1a1a1e);
    color: light-dark(#1a1a1e, #e8e8ea);
  }
  a { color: light-dark(#1d4ed8, #60a5fa); }
  select, input, textarea, button {
    font: inherit;
    color: inherit;
    background: light-dark(#fff, #26262b);
    border: 1px solid light-dark(#ccc, #444);
    border-radius: 6px;
    padding: 6px 8px;
  }
  button {
    cursor: pointer;
    background: light-dark(#e8e8ea, #333338);
  }
  button:disabled { opacity: 0.5; cursor: default; }
  code {
    font-family: ui-monospace, monospace;
    background: light-dark(#eee, #2a2a2e);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 11px;
  }
  .badge {
    display: inline-block;
    font-size: 11px;
    font-family: ui-monospace, monospace;
    padding: 2px 8px;
    border-radius: 10px;
    background: light-dark(#eee, #2a2a2e);
  }
  .badge-custom { background: light-dark(#dcfce7, #14532d); color: light-dark(#166534, #86efac); }
  .badge-default { background: light-dark(#eee, #2a2a2e); color: light-dark(#666, #999); }
  .muted { color: light-dark(#666, #999); font-size: 12px; }
  .topnav {
    display: flex;
    gap: 14px;
    padding: 8px 16px;
    font-size: 12px;
    border-bottom: 1px solid light-dark(#ddd, #333);
    background: light-dark(#fff, #202024);
  }
  .topnav a { text-decoration: none; }
  .topnav a:hover { text-decoration: underline; }
  .topnav a.active { color: light-dark(#1a1a1e, #e8e8ea); font-weight: 600; }
`
