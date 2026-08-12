import { describe, expect, it, vi } from 'vitest'
import { runAgent, type ModelCall, type ModelResponse } from '../run-agent.js'
import type { AgentConfig, ToolDefinition } from '../agent-config.js'

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'test-agent',
    systemPrompt: 'You are a test agent.',
    rules: [],
    defaultDecision: 'deny',
    ...overrides,
  }
}

function textResponse(text: string): ModelResponse {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
}

function toolUseResponse(id: string, name: string, input: Record<string, unknown>): ModelResponse {
  return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] }
}

describe('runAgent', () => {
  it('returns the model text unchanged when no tools are called', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('hello there'))

    const result = await runAgent(baseConfig(), modelCall, 'hi')

    expect(result.text).toBe('hello there')
    expect(result.history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
    ])
    expect(modelCall).toHaveBeenCalledTimes(1)
  })

  it('executes an approved tool and feeds its result back to the model', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse('t1', 'echo', { msg: 'hi' })
      return textResponse('done')
    })

    const echo: ToolDefinition = {
      name: 'echo',
      description: 'Echoes input',
      input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async (input) => `echo:${input.msg}`,
    }

    const config = baseConfig({
      tools: [echo],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'echo', decision: 'allow' }],
    })

    const result = await runAgent(config, modelCall, 'say hi')

    expect(modelCall).toHaveBeenCalledTimes(2)
    expect(result.text).toBe('done')
    expect(result.history).toContainEqual({ role: 'assistant', content: '[requested: echo]' })
    expect(result.history).toContainEqual({ role: 'user', content: '[echo result] "echo:hi"' })

    // second modelCall invocation should have seen the tool result in its messages
    const secondCallMessages = (modelCall as ReturnType<typeof vi.fn>).mock.calls[1][0]
    expect(secondCallMessages).toContainEqual({ role: 'user', content: '[echo result] "echo:hi"' })
  })

  it('routes a tool call through the configured Approver when the rule says ask', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse('t1', 'echo', { msg: 'hi' })
      return textResponse('done')
    })

    const echo: ToolDefinition = {
      name: 'echo',
      description: 'Echoes input',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'echoed',
    }

    const requestApproval = vi.fn(async () => true)
    const config = baseConfig({
      tools: [echo],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'echo', decision: 'ask' }],
      approver: { requestApproval },
    })

    const result = await runAgent(config, modelCall, 'say hi')

    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(result.history).toContainEqual({ role: 'user', content: '[echo result] "echoed"' })
  })

  it('feeds a denied tool call back as a result, distinct from a successful one', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse('t1', 'dangerous', {})
      return textResponse('done')
    })

    const dangerous: ToolDefinition = {
      name: 'dangerous',
      description: 'Should never run',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'should not run'),
    }

    const config = baseConfig({
      tools: [dangerous],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'dangerous', decision: 'deny' }],
    })

    const result = await runAgent(config, modelCall, 'do the dangerous thing')

    expect(dangerous.execute).not.toHaveBeenCalled()
    expect(result.history).toContainEqual({ role: 'assistant', content: '[requested: dangerous]' })
    const resultMessage = result.history.find((m) => m.content.startsWith('[dangerous result]'))
    expect(resultMessage?.content).toMatch(/^\[dangerous result\] denied: /)
  })

  it('invokes a skill and injects its body without going through actauth or toollane', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse('t1', 'Skill', { skill: 'summarize-files' })
      return textResponse('done')
    })

    const events: Array<{ event: string; detail: unknown }> = []
    const config = baseConfig({ skillsDirs: ['skills'] })

    const result = await runAgent(config, modelCall, 'summarize', [], {
      onEvent: (event, detail) => events.push({ event, detail }),
    })

    expect(result.history).toContainEqual({ role: 'assistant', content: '[called Skill: summarize-files]' })
    const skillBody = result.history.find((m) => m.role === 'user' && m.content.includes('Summarize files'))
    expect(skillBody).toBeDefined()

    expect(events.some((e) => e.event === 'skillgarden:invoke')).toBe(true)
    expect(events.some((e) => e.event === 'actauth:decision')).toBe(false)
    expect(events.some((e) => e.event === 'toollane:result')).toBe(false)
  })

  it('recovers via reflow when the model call reports the prompt is too long', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async (messages) => {
      call++
      if (call === 1) {
        throw { status: 400, message: 'prompt is too long: exceeds maximum context length' }
      }
      return textResponse(`ok with ${messages.length} messages`)
    })

    const events: Array<{ event: string; detail: unknown }> = []
    const config = baseConfig({ contextBudgetTokens: 8000 })

    const result = await runAgent(config, modelCall, 'hi', [], {
      onEvent: (event, detail) => events.push({ event, detail }),
    })

    expect(modelCall).toHaveBeenCalledTimes(2)
    expect(events.some((e) => e.event === 'reflow:recover')).toBe(true)
    expect(result.text).toMatch(/^ok with \d+ messages$/)
  })

  it('continues an existing conversation from the history it is passed', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('follow-up answer'))
    const priorHistory = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
    ]

    const result = await runAgent(baseConfig(), modelCall, 'second question', priorHistory)

    expect(result.history[0]).toEqual(priorHistory[0])
    expect(result.history[1]).toEqual(priorHistory[1])
    expect(result.history[2]).toEqual({ role: 'user', content: 'second question' })
    expect(result.history[3]).toEqual({ role: 'assistant', content: 'follow-up answer' })
  })
})
