import { describe, expect, it } from 'vitest'
import { agentAsTool } from '../agent-as-tool.js'
import type { AgentConfig } from '../agent-config.js'
import type { ModelCall } from '../run-agent.js'

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'billing-agent',
    systemPrompt: 'You handle billing questions.',
    toolDescription: 'Call this for any billing-related question.',
    rules: [],
    defaultDecision: 'deny',
    ...overrides,
  }
}

describe('agentAsTool', () => {
  it('throws when AgentConfig.toolDescription is missing', () => {
    const config = baseConfig({ toolDescription: undefined })
    expect(() => agentAsTool(config, () => (async () => ({ stop_reason: 'end_turn', content: [] })) as ModelCall)).toThrow(
      /requires AgentConfig.toolDescription/,
    )
  })

  it('exposes the agent name and toolDescription as the ToolDefinition name/description', () => {
    const config = baseConfig()
    const tool = agentAsTool(config, () => (async () => ({ stop_reason: 'end_turn', content: [] })) as ModelCall)

    expect(tool.name).toBe('billing-agent')
    expect(tool.description).toBe('Call this for any billing-related question.')
    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: { request: { type: 'string', description: 'What to ask this agent to do.' } },
      required: ['request'],
    })
  })

  it('does not default to safe: true — the wrapped agent may itself call unsafe tools', () => {
    const config = baseConfig()
    const tool = agentAsTool(config, () => (async () => ({ stop_reason: 'end_turn', content: [] })) as ModelCall)

    expect(tool.safe).toBeUndefined()
  })

  it('runs the wrapped agent to completion and returns its final text as the tool result', async () => {
    const config = baseConfig()
    const modelCall: ModelCall = async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Your balance is $0.' }] })

    const tool = agentAsTool(config, () => modelCall)
    const result = await tool.execute({ request: 'what do I owe?' })

    expect(result).toBe('Your balance is $0.')
  })

  it('calls createModelCall fresh for each execute — a factory, not a shared instance', async () => {
    const config = baseConfig()
    let calls = 0
    const createModelCall = () => {
      calls++
      return (async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] })) as ModelCall
    }

    const tool = agentAsTool(config, createModelCall)
    await tool.execute({ request: 'a' })
    await tool.execute({ request: 'b' })

    expect(calls).toBe(2)
  })
})
