// Same file-summarizing agent as the original main.ts, rewritten as an
// AgentConfig driven through the generic runAgent loop.
import { readFileSync, writeFileSync } from 'node:fs'
import { connectComposioSource } from 'mcpplug'
import type { AgentConfig } from '../agent-config.js'
import { runAgent, type ModelCall } from '../run-agent.js'

const handWrittenTools = [
  {
    name: 'read_file',
    description: 'Read a text file',
    input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    execute: async (input: Record<string, unknown>) => readFileSync(input.path as string, 'utf8'),
  },
  {
    name: 'list_dir',
    description: 'List files in the working directory',
    input_schema: { type: 'object', properties: {} },
    execute: async () => ['examples/file-agent/a.txt', 'examples/file-agent/b.txt'],
  },
  {
    name: 'write_file',
    description: 'Write a text file',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    execute: async (input: Record<string, unknown>) => {
      writeFileSync(input.path as string, input.content as string)
      return `wrote ${(input.content as string).length} bytes to ${input.path}`
    },
  },
]

// Resolved once, at module-eval time, not per runAgent() call — a
// gateway connection (mcpplug shells out to the composio CLI) is exactly
// the kind of setup cost runAgent's own I/O-per-call tolerance (see
// SkillGarden's re-scan above) doesn't extend to. Same reasoning
// rag-agent.ts builds its VectorIndex once at import time rather than
// per call; this is that pattern's async form. connectComposioSource
// only needs the CLI to answer `--get-schema`, which doesn't require an
// authenticated account — only actually *calling* the tool below does.
const composioTools = await connectComposioSource('composio', {
  slugs: ['GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER'],
}).then((source) => source.loadTools())

export const config: AgentConfig = {
  name: 'file-agent',
  systemPrompt: 'You summarize text files into other text files.',
  tools: [...handWrittenTools, ...composioTools],
  rules: [
    { scopePattern: 'default/production/file-agent', tool: 'read_file', decision: 'allow' },
    { scopePattern: 'default/production/file-agent', tool: 'list_dir', decision: 'allow' },
    { scopePattern: 'default/production/file-agent', tool: 'write_file', decision: 'ask' },
    // Read-only (GitHub's GET /user/repos under the hood) — allowed like
    // read_file/list_dir rather than ask'd like write_file, on the same
    // reasoning: nothing this call does needs a human in the loop.
    {
      scopePattern: 'default/production/file-agent',
      tool: 'composio_GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
      decision: 'allow',
    },
  ],
  defaultDecision: 'ask',
  approver: {
    // ConsoleApprover would block this non-interactive demo on stdin — a
    // tiny auto-approving stand-in that still exercises the real 'ask' path.
    async requestApproval(tool, args, _scope, reason) {
      console.log(`  [actauth] approval requested for ${tool}(${JSON.stringify(args)}) — ${reason}`)
      console.log('  [actauth] auto-approved for this demo (swap in ConsoleApprover or SlackApprover for real use)')
      return true
    },
  },
  // Scoped to this agent's own subdirectory, not the shared skills/ root —
  // SkillGarden's discovery recursively walks whatever root it's given
  // with no per-agent filtering, so pointing at skills/ itself would mean
  // this agent picks up (and exposes to the model as callable) any other
  // agent's skills dropped in there too. Nesting depth becomes the
  // namespace relative to *this* root, so summarize-files still gets the
  // plain name 'summarize-files' below, not 'file-agent:summarize-files'.
  skillsDirs: ['skills/file-agent'],
  isSafeTool: (call) =>
    call.name === 'read_file' ||
    call.name === 'list_dir' ||
    call.name === 'composio_GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER',
}

// SIMULATED — no ANTHROPIC_API_KEY is configured in this environment.
// Swap this for a real anthropic.messages.create(...) call and runAgent
// works unchanged; that's the point of factoring it out as a ModelCall.
// A real model call is a pure function of the messages you pass it, so
// it's safely reusable across sessions/requests — this canned one is
// stateful (counts its own calls), so each session needs its own
// instance. createModelCall() is that instance boundary: the CLI adapter
// makes a fresh one per process, the HTTP adapter makes a fresh one per
// request.
export function createModelCall(): ModelCall {
  let turn = 0
  return async () => {
    turn++
    if (turn === 1) throw { status: 400, message: 'prompt is too long: exceeds maximum context length' }
    if (turn === 2) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'summarize-files' } }] }
    if (turn === 3) {
      return {
        stop_reason: 'tool_use',
        content: [
          { type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'examples/file-agent/a.txt' } },
          { type: 'tool_use', id: 't3', name: 'read_file', input: { path: 'examples/file-agent/b.txt' } },
          { type: 'tool_use', id: 't4', name: 'list_dir', input: {} },
        ],
      }
    }
    if (turn === 4) {
      return {
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 't5',
            name: 'write_file',
            input: { path: 'examples/file-agent/summary.txt', content: 'Revenue grew 12% YoY and support volume dropped 8% after the new onboarding flow.' },
          },
        ],
      }
    }
    if (turn === 5) {
      return {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't6', name: 'composio_GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER', input: { per_page: 5 } }],
      }
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done — wrote a one-paragraph summary to examples/file-agent/summary.txt.' }] }
  }
}

// Only run standalone when invoked directly (`tsx agents/file-agent.ts`),
// not when imported by the agent registry.
if (import.meta.url === `file://${process.argv[1]}`) {
  runAgent(config, createModelCall(), 'Summarize examples/file-agent/a.txt and examples/file-agent/b.txt into examples/file-agent/summary.txt.', [], {
    onEvent: (event, detail) => console.log(`[${event}]`, detail),
  }).then((result) => console.log('\n[final]', result.text))
}
