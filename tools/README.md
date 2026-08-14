# Global tools

This directory is for a tool genuinely meant to be shared across more than
one agent — nothing here today, because nothing in this repo's own demo
agents currently needs to be. Every existing tool is agent-specific and
lives under that agent's own folder instead:
`agents/customer-service/tools/`, `agents/file-agent/tools/`.

If a real, stateless tool with no agent-specific closures (no in-memory
store like `agents/customer-service/tools/orders-store.ts`, no
agent-specific config) needs to be called by two or more agents, it
belongs here — flat, one file per tool, no per-agent subfolder (unlike
`agents/<name>/tools/`, there's no single agent to namespace by):

```
tools/
  some_shared_tool.ts
```

Each agent that wants it imports it directly, the same way it imports its
own `./tools/index.js` — nothing in `discoverAgents` or `agent-registry.ts`
needs to change either way, since neither one looks inside `tools/` at all.

Don't put an agent-specific tool here just because it feels reusable in
theory. Wait for a second agent that actually needs the exact same tool
before extracting it — see the root README's "Defining your own agent"
section for the fuller reasoning.
