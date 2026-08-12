// Same file-summarizing agent as the original main.ts, rewritten as an
// AgentConfig driven through the generic runAgent loop.
import { readFileSync, writeFileSync } from 'node:fs'
import type { AgentConfig } from '../agent-config.js'
import { runAgent, type ModelCall } from '../run-agent.js'

export const config: AgentConfig = {
  name: 'file-agent',
  systemPrompt: 'You summarize text files into other text files.',
  tools: [
    {
      name: 'read_file',
      description: 'Read a text file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      execute: async (input) => readFileSync(input.path as string, 'utf8'),
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
      execute: async (input) => {
        writeFileSync(input.path as string, input.content as string)
        return `wrote ${(input.content as string).length} bytes to ${input.path}`
      },
    },
  ],
  rules: [
    { scopePattern: 'default/production/file-agent', tool: 'read_file', decision: 'allow' },
    { scopePattern: 'default/production/file-agent', tool: 'list_dir', decision: 'allow' },
    { scopePattern: 'default/production/file-agent', tool: 'write_file', decision: 'ask' },
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
  skillsDirs: ['skills'],
  isSafeTool: (call) => call.name === 'read_file' || call.name === 'list_dir',
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
