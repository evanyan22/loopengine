import type { AgentConfig } from 'loopengine'

let callCount = 0

export const config: AgentConfig = {
  name: 'dead-sse-test',
  systemPrompt: 'test agent',
  tools: [
    {
      name: 'asked_step',
      description: 'needs approval',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'asked_step ran',
    },
    {
      name: 'auto_step',
      description: 'auto-allowed',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'auto_step ran',
    },
  ],
  rules: [
    { scopePattern: '*/*/dead-sse-test', tool: 'asked_step', decision: 'ask' },
    { scopePattern: '*/*/dead-sse-test', tool: 'auto_step', decision: 'allow' },
  ],
}

export function createModelCall() {
  return async (messages: any[], _system: string, _tools: any[]) => {
    callCount++
    if (callCount === 1) {
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_asked', name: 'asked_step', input: {} }] }
    }
    if (callCount === 2) {
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'call_auto', name: 'auto_step', input: {} }] }
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'all done after auto step' }] }
  }
}
