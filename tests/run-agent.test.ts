import { describe, expect, it, vi } from 'vitest'
import { runAgent, type Message, type ModelCall, type ModelResponse } from '../run-agent.js'
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

function toolUseResponse(...calls: Array<{ id: string; name: string; input: Record<string, unknown> }>): ModelResponse {
  return { stop_reason: 'tool_use', content: calls.map((c) => ({ type: 'tool_use', ...c })) }
}

/** Every tool_result block across a message's history, regardless of
 * which user-role message bundled it. */
function toolResults(history: Message[]) {
  return history
    .filter((m) => Array.isArray(m.content))
    .flatMap((m) => m.content as Exclude<Message['content'], string>)
    .filter((block) => block.type === 'tool_result')
}

describe('runAgent', () => {
  it('returns the model text unchanged when no tools are called', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('hello there'))

    const result = await runAgent(baseConfig(), modelCall, 'hi')

    expect(result.text).toBe('hello there')
    expect(result.history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello there' }] },
    ])
    expect(modelCall).toHaveBeenCalledTimes(1)
  })

  it('executes an approved tool and feeds its result back linked by tool_use_id', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse({ id: 't1', name: 'echo', input: { msg: 'hi' } })
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

    const assistantTurn = result.history.find((m) => m.role === 'assistant' && Array.isArray(m.content))
    expect(assistantTurn?.content).toEqual([{ type: 'tool_use', id: 't1', name: 'echo', input: { msg: 'hi' } }])

    const results = toolResults(result.history)
    expect(results).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: '"echo:hi"', is_error: false }])

    // second modelCall invocation should have seen the tool result in its messages
    const secondCallMessages = (modelCall as ReturnType<typeof vi.fn>).mock.calls[1][0] as Message[]
    expect(toolResults(secondCallMessages)).toEqual(results)
  })

  it('links two parallel calls to the same tool name back to their own results by id, not name', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) {
        return toolUseResponse(
          { id: 't1', name: 'echo', input: { msg: 'first' } },
          { id: 't2', name: 'echo', input: { msg: 'second' } },
        )
      }
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
      isSafeTool: () => true,
    })

    const result = await runAgent(config, modelCall, 'say hi twice')

    const results = toolResults(result.history)
    expect(results).toHaveLength(2)
    expect(results.find((r) => r.tool_use_id === 't1')?.content).toBe('"echo:first"')
    expect(results.find((r) => r.tool_use_id === 't2')?.content).toBe('"echo:second"')
  })

  it('routes a tool call through the configured Approver when the rule says ask', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse({ id: 't1', name: 'echo', input: {} })
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
    expect(toolResults(result.history)).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '"echoed"', is_error: false },
    ])
  })

  it('feeds a denied tool call back as an is_error tool_result, distinct from a successful one', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse({ id: 't1', name: 'dangerous', input: {} })
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
    const results = toolResults(result.history)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ tool_use_id: 't1', is_error: true })
    expect(results[0].content).toMatch(/^denied: /)
  })

  it('invokes a skill and injects its body as a tool_result, without going through actauth or toollane', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse({ id: 't1', name: 'Skill', input: { skill: 'summarize-files' } })
      return textResponse('done')
    })

    const events: Array<{ event: string; detail: unknown }> = []
    const config = baseConfig({ skillsDirs: ['skills'] })

    const result = await runAgent(config, modelCall, 'summarize', [], {
      onEvent: (event, detail) => events.push({ event, detail }),
    })

    const results = toolResults(result.history)
    expect(results).toHaveLength(1)
    expect(results[0].tool_use_id).toBe('t1')
    expect(results[0].content).toContain('Summarize files')

    expect(events.some((e) => e.event === 'skillgarden:invoke')).toBe(true)
    expect(events.some((e) => e.event === 'actauth:decision')).toBe(false)
    expect(events.some((e) => e.event === 'toollane:result')).toBe(false)
  })

  it('still gates and runs a sibling tool requested alongside a Skill call in the same turn', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) {
        return toolUseResponse(
          { id: 't1', name: 'Skill', input: { skill: 'summarize-files' } },
          { id: 't2', name: 'echo', input: { msg: 'hi' } },
        )
      }
      return textResponse('done')
    })

    const echo: ToolDefinition = {
      name: 'echo',
      description: 'Echoes input',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'echoed',
    }

    const events: Array<{ event: string; detail: unknown }> = []
    const config = baseConfig({
      skillsDirs: ['skills'],
      tools: [echo],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'echo', decision: 'allow' }],
    })

    const result = await runAgent(config, modelCall, 'summarize and say hi', [], {
      onEvent: (event, detail) => events.push({ event, detail }),
    })

    const results = toolResults(result.history)
    expect(results.find((r) => r.tool_use_id === 't1')?.content).toContain('Summarize files')
    expect(results.find((r) => r.tool_use_id === 't2')?.content).toBe('"echoed"')
    expect(events.some((e) => e.event === 'actauth:decision')).toBe(true)
    expect(events.some((e) => e.event === 'toollane:result')).toBe(true)
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
    const priorHistory: Message[] = [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] },
    ]

    const result = await runAgent(baseConfig(), modelCall, 'second question', priorHistory)

    expect(result.history[0]).toEqual(priorHistory[0])
    expect(result.history[1]).toEqual(priorHistory[1])
    expect(result.history[2]).toEqual({ role: 'user', content: 'second question' })
    expect(result.history[3]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'follow-up answer' }] })
  })
})
