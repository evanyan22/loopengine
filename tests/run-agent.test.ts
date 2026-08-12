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
    const config = baseConfig({ skillsDirs: ['skills/file-agent'] })

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

    // The model can only ever spontaneously call a tool it was actually
    // told about — this is the fix for the gap where Skill was handled on
    // the output side but never declared as a callable tool at all.
    const toolsSentToModel = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(toolsSentToModel).toContainEqual(
      expect.objectContaining({ name: 'Skill', input_schema: expect.objectContaining({ required: ['skill'] }) }),
    )
  })

  it('does not declare a Skill tool when the agent has no skillsDirs', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('no skills here'))

    await runAgent(baseConfig(), modelCall, 'hi')

    const toolsSentToModel = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(toolsSentToModel.some((t: { name: string }) => t.name === 'Skill')).toBe(false)
  })

  it('passes args through to the invoked skill for $ARGUMENTS/$1/$2 substitution', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) {
        return toolUseResponse({ id: 't1', name: 'Skill', input: { skill: 'summarize-files', args: 'foo.txt' } })
      }
      return textResponse('done')
    })

    const config = baseConfig({ skillsDirs: ['skills/file-agent'] })
    const result = await runAgent(config, modelCall, 'summarize foo.txt', [])

    // summarize-files' SKILL.md has no $ARGUMENTS placeholder, so passing
    // args through shouldn't change its body — this just confirms the
    // call succeeds with an args value present, not that substitution
    // itself does anything for this particular skill.
    const results = toolResults(result.history)
    expect(results[0].content).toContain('Summarize files')
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
      skillsDirs: ['skills/file-agent'],
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

  it('persists recovery in the returned history, not just the one retried call', async () => {
    // A long prior history — well past the tail-preservation window (4) —
    // so recovery has real drain/summarize work to do.
    const priorHistory: Message[] = []
    for (let i = 0; i < 10; i++) {
      priorHistory.push({ role: 'user', content: `turn ${i} question` })
      priorHistory.push({ role: 'assistant', content: [{ type: 'text', text: `turn ${i} answer` }] })
    }

    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) throw { status: 400, message: 'prompt is too long: exceeds maximum context length' }
      return textResponse('ok')
    })

    const config = baseConfig({ contextBudgetTokens: 100 }) // tiny — forces recovery

    const result = await runAgent(config, modelCall, 'new question', priorHistory)

    // 10 prior turns (20 messages) + 1 new user message + 1 final assistant
    // reply = 22 without recovery. If recovery only affected the one
    // retried call (the bug this test guards against), result.history
    // would still be 22 long here.
    expect(result.history.length).toBeLessThan(22)
  })

  it('newMessages is exactly this turn\'s content, decoupled from how history was reshaped', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse({ id: 't1', name: 'echo', input: { msg: 'hi' } })
      return textResponse('done')
    })

    const echo: ToolDefinition = {
      name: 'echo',
      description: '',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'echoed',
    }
    const config = baseConfig({
      tools: [echo],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'echo', decision: 'allow' }],
    })

    const priorHistory: Message[] = [
      { role: 'user', content: 'old question' },
      { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] },
    ]

    const result = await runAgent(config, modelCall, 'new question', priorHistory)

    // newMessages should be exactly: new user message, assistant
    // tool_use, user tool_result, final assistant text — none of
    // priorHistory, since none of that is new this turn.
    expect(result.newMessages).toEqual([
      { role: 'user', content: 'new question' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { msg: 'hi' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '"echoed"', is_error: false }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ])
    // history is still priorHistory + newMessages, in order.
    expect(result.history).toEqual([...priorHistory, ...result.newMessages])
  })

  it('recovery never touches this turn\'s own content, even when a single turn produces more messages than the tail-preservation window, and still compacts real prior history', async () => {
    // Real prior history to compact — recovery is a no-op ('unchanged')
    // when there's nothing but this-turn content to consider, which
    // would defeat the point of this test.
    const priorHistory: Message[] = []
    for (let i = 0; i < 10; i++) {
      priorHistory.push({ role: 'user', content: `old turn ${i} question` })
      priorHistory.push({ role: 'assistant', content: [{ type: 'text', text: `old turn ${i} answer` }] })
    }

    // Two rounds of tool calls (4 messages: assistant tool_use, user
    // tool_result, twice) plus the initial user message = 5 messages
    // already pushed by the time the THIRD modelCall attempt throws —
    // past tailMessages (4), so a naive "reuse the synthetic head"
    // reconciliation would risk this turn's own earliest message getting
    // silently dropped (ContextClip's drain stage deletes outright, no
    // synthetic replacement) instead of protected outright.
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse({ id: 't1', name: 'echo', input: { round: 1 } })
      if (call === 2) return toolUseResponse({ id: 't2', name: 'echo', input: { round: 2 } })
      if (call === 3) throw { status: 400, message: 'prompt is too long: exceeds maximum context length' }
      return textResponse('all done')
    })

    const echo: ToolDefinition = {
      name: 'echo',
      description: '',
      input_schema: { type: 'object', properties: {} },
      execute: async () => 'ok',
    }
    const config = baseConfig({
      tools: [echo],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'echo', decision: 'allow' }],
      contextBudgetTokens: 100, // tiny — forces real compaction of priorHistory
    })

    const result = await runAgent(config, modelCall, 'start multi-round', priorHistory)

    // Every one of this turn's own messages survives, structurally
    // intact (not flattened into a synthetic summary) — the property the
    // whole prior/new split exists to guarantee.
    expect(result.newMessages).toEqual([
      { role: 'user', content: 'start multi-round' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: { round: 1 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '"ok"', is_error: false }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'echo', input: { round: 2 } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: '"ok"', is_error: false }] },
      { role: 'assistant', content: [{ type: 'text', text: 'all done' }] },
    ])
    // The real prior history (20 messages) genuinely got compacted, not
    // just left alone because there was nothing new to protect it from.
    expect(result.history.length).toBeLessThan(20 + result.newMessages.length)
    expect(result.text).toBe('all done')
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
