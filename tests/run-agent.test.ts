import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgent, resumeAgent, type Message, type ModelCall, type ModelResponse, type ModelContentBlock } from '#core/run-agent.js'
import type { AgentConfig, ToolDefinition, PendingQuestion } from '#core/agent-config.js'
import type { LoopEvent } from '#core/loop-events.js'
import { answerQuestion } from '#core/system-tools/index.js'

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
    expect(results).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '"echo:hi"', is_error: false, reason: "matched rule 'default/production/test-agent'" },
    ])

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

  it('derives isSafeTool from each tool\'s own `safe` flag when AgentConfig.isSafeTool is not set', async () => {
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
      safe: true,
    }

    const config = baseConfig({
      tools: [echo],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'echo', decision: 'allow' }],
      // No isSafeTool — falls back to echo's own `safe: true`.
    })

    const result = await runAgent(config, modelCall, 'say hi twice')

    const results = toolResults(result.history)
    expect(results).toHaveLength(2)
    expect(results.find((r) => r.tool_use_id === 't1')?.content).toBe('"echo:first"')
    expect(results.find((r) => r.tool_use_id === 't2')?.content).toBe('"echo:second"')
  })

  it('AgentConfig.isSafeTool takes precedence over a tool\'s own `safe` flag when both are set', async () => {
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
      safe: true,
    }

    const isSafeTool = vi.fn(() => false)
    const config = baseConfig({
      tools: [echo],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'echo', decision: 'allow' }],
      isSafeTool,
    })

    await runAgent(config, modelCall, 'say hi')

    // Called with the actual call, not skipped in favor of echo.safe — proof
    // the explicit classifier is what ToolLane actually runs, not a
    // wrapper that consults the tool's own flag first.
    expect(isSafeTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'echo' }))
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
    })

    const result = await runAgent(config, modelCall, 'say hi', [], { channel: 'http', approver: { requestApproval } })

    expect(requestApproval).toHaveBeenCalledTimes(1)
    expect(toolResults(result.history)).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: '"echoed"',
        is_error: false,
        reason: "matched rule 'default/production/test-agent' — human approved",
      },
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

  it('stops the loop after a denial instead of feeding it back to the model for another turn', async () => {
    const modelCall: ModelCall = vi.fn(async () => toolUseResponse({ id: 't1', name: 'dangerous', input: {} }))
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

    // Only the one call that requested the tool — never a second one
    // asking the model what to do about the denial.
    expect(modelCall).toHaveBeenCalledTimes(1)
    expect(result.stopReason).toBe('denied')
    expect(result.text).toContain('dangerous')
    // The synthetic stop notice is itself part of history, same as
    // max_turns' own synthetic notice already is — a later continued
    // conversation should see it, not just the raw tool_result.
    const lastMessage = result.history[result.history.length - 1]
    expect(lastMessage).toEqual({ role: 'assistant', content: expect.stringContaining('dangerous') })
  })

  it('skips an approved call from the same turn too when a sibling call is denied — a denial cancels the whole batch', async () => {
    const modelCall: ModelCall = vi.fn(async () =>
      toolUseResponse({ id: 't1', name: 'safe', input: {} }, { id: 't2', name: 'dangerous', input: {} }),
    )
    const safe: ToolDefinition = {
      name: 'safe',
      description: 'Fine to run',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'ran fine'),
    }
    const dangerous: ToolDefinition = {
      name: 'dangerous',
      description: 'Should never run',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'should not run'),
    }
    const config = baseConfig({
      tools: [safe, dangerous],
      rules: [
        { scopePattern: 'default/production/test-agent', tool: 'safe', decision: 'allow' },
        { scopePattern: 'default/production/test-agent', tool: 'dangerous', decision: 'deny' },
      ],
    })

    const result = await runAgent(config, modelCall, 'do both')

    // Neither ran — 'safe' was approved on its own merits, but a sibling
    // call in the same batch was denied, and that cancels the batch.
    expect(safe.execute).not.toHaveBeenCalled()
    expect(dangerous.execute).not.toHaveBeenCalled()
    expect(modelCall).toHaveBeenCalledTimes(1)
    expect(result.stopReason).toBe('denied')
    const results = toolResults(result.history)
    expect(results).toHaveLength(2)
    // "skipped", not "denied" — safe's own rule never actually rejected it.
    expect(results.find((r) => r.tool_use_id === 't1')).toMatchObject({ is_error: true })
    expect(results.find((r) => r.tool_use_id === 't1')?.content).toMatch(/^skipped:/)
    expect(results.find((r) => r.tool_use_id === 't2')).toMatchObject({ is_error: true })
    expect(results.find((r) => r.tool_use_id === 't2')?.content).toMatch(/^denied:/)
  })

  it('invokes a skill and injects its body as a tool_result, without going through actauth or toollane', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse({ id: 't1', name: 'Skill', input: { skill: 'summarize-files' } })
      return textResponse('done')
    })

    const events: LoopEvent[] = []
    const config = baseConfig({ skillsDirs: ['agents/file-agent/skills'] })

    const result = await runAgent(config, modelCall, 'summarize', [], {
      onEvent: (event) => events.push(event),
    })

    const results = toolResults(result.history)
    expect(results).toHaveLength(1)
    expect(results[0].tool_use_id).toBe('t1')
    expect(results[0].content).toContain('Summarize files')

    expect(events.some((e) => e.type === 'skill:loaded')).toBe(true)
    expect(events.some((e) => e.type === 'actauth:decision')).toBe(false)
    expect(events.some((e) => e.type === 'toollane:result')).toBe(false)

    // The model can only ever spontaneously call a tool it was actually
    // told about — this is the fix for the gap where Skill was handled on
    // the output side but never declared as a callable tool at all.
    const toolsSentToModel = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(toolsSentToModel).toContainEqual(
      expect.objectContaining({ name: 'Skill', input_schema: expect.objectContaining({ required: ['skill'] }) }),
    )
  })

  it('still declares a Skill tool with no agent skillsDirs, because the system skill is always present', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('no skills here'))

    // baseConfig's name ('test-agent') has no agents/test-agent/skills
    // folder in this repo — the default resolves to a path that doesn't
    // exist, which SkillGarden treats as "no skills," not an error. But
    // system-skills/composio-large-outputs is unconditionally merged in
    // (see run-agent.ts's systemSkillsDir), so the Skill tool is declared
    // regardless.
    await runAgent(baseConfig(), modelCall, 'hi')

    const toolsSentToModel = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(toolsSentToModel.some((t: { name: string }) => t.name === 'Skill')).toBe(true)
  })

  it('defaults skillsDirs to agents/<name>/skills when omitted entirely', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('no skills invoked'))

    // No skillsDirs override — 'customer-service' matches this repo's
    // real agents/customer-service/skills/ folder, so the default alone
    // should be enough to discover and declare its skill. Not
    // 'file-agent': that agent's own agents/file-agent/gateway-tools.yml
    // (see gateway-tools.ts) would make this test depend on a real
    // composio CLI/network call it has nothing to do with — runAgent
    // resolves gateway tools by folder-name convention alone, with no
    // way to opt a synthetic test config out of it.
    await runAgent(baseConfig({ name: 'customer-service' }), modelCall, 'hi')

    const toolsSentToModel = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(toolsSentToModel).toContainEqual(expect.objectContaining({ name: 'Skill' }))
  })

  it('defaults rules to agents/<name>/actauth.yml when omitted entirely', async () => {
    const modelCall: ModelCall = vi.fn(async () => toolUseResponse({ id: 't1', name: 'lookup_order', input: {} }))
    const events: LoopEvent[] = []

    const lookupOrder: ToolDefinition = {
      name: 'lookup_order',
      description: 'Look up an order',
      input_schema: { type: 'object', properties: {} },
      execute: async () => ({ status: 'delivered' }),
    }

    // No rules override — 'customer-service' matches this repo's real
    // agents/customer-service/actauth.yml, which allows lookup_order
    // unconditionally ('lookup-order-always-allowed').
    await runAgent(baseConfig({ name: 'customer-service', rules: undefined, tools: [lookupOrder] }), modelCall, 'hi', [], {
      onEvent: (event) => events.push(event),
    })

    expect(events).toContainEqual({
      type: 'actauth:decision',
      tool: 'lookup_order',
      decision: 'allow',
      reason: "matched rule 'lookup-order-always-allowed'",
    })
  })

  it('falls back to an empty ruleset (not a crash) when the default actauth.yml path does not exist', async () => {
    const modelCall: ModelCall = vi.fn(async () => toolUseResponse({ id: 't1', name: 'echo', input: {} }))

    const echo: ToolDefinition = {
      name: 'echo',
      description: 'Echoes input',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'echoed'),
    }

    // 'test-agent' has no agents/test-agent/actauth.yml in this repo —
    // resolves to an empty ruleset, not a thrown ENOENT. defaultDecision
    // is cleared too (not just relying on baseConfig's own 'deny'), to
    // prove the fallback's own hardcoded 'deny' default is what's
    // actually denying this, not an unrelated override.
    const result = await runAgent(baseConfig({ rules: undefined, defaultDecision: undefined, tools: [echo] }), modelCall, 'hi')

    expect(echo.execute).not.toHaveBeenCalled()
    const results = toolResults(result.history)
    expect(results[0]).toMatchObject({ tool_use_id: 't1', is_error: true })
  })

  it('still throws on an explicitly given rules path that does not exist, unlike the implicit default', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('unreachable'))

    const config = baseConfig({ rules: 'agents/does-not-exist/actauth.yml' })

    await expect(runAgent(config, modelCall, 'hi')).rejects.toThrow(/ENOENT/)
  })

  it('appends the agent name to a 2-segment YAML scope automatically', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loopengine-actauth-yaml-'))
    try {
      writeFileSync(
        join(dir, 'actauth.yml'),
        'default_decision: deny\nrules:\n  - name: echo-allowed\n    scope: "*/*"\n    tool: echo\n    decision: allow\n',
      )

      const modelCall: ModelCall = vi.fn(async () => toolUseResponse({ id: 't1', name: 'echo', input: {} }))
      const echo: ToolDefinition = {
        name: 'echo',
        description: 'Echoes input',
        input_schema: { type: 'object', properties: {} },
        execute: async () => 'echoed',
      }
      const events: LoopEvent[] = []

      await runAgent(baseConfig({ rules: join(dir, 'actauth.yml'), tools: [echo] }), modelCall, 'hi', [], {
        onEvent: (event) => events.push(event),
      })

      expect(events).toContainEqual({
        type: 'actauth:decision',
        tool: 'echo',
        decision: 'allow',
        reason: "matched rule 'echo-allowed'",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not double-append when a YAML scope already ends with the agent name (old 3-segment habit)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loopengine-actauth-yaml-'))
    try {
      writeFileSync(
        join(dir, 'actauth.yml'),
        'default_decision: deny\nrules:\n  - name: echo-allowed\n    scope: "*/*/test-agent"\n    tool: echo\n    decision: allow\n',
      )

      const modelCall: ModelCall = vi.fn(async () => toolUseResponse({ id: 't1', name: 'echo', input: {} }))
      const echo: ToolDefinition = {
        name: 'echo',
        description: 'Echoes input',
        input_schema: { type: 'object', properties: {} },
        execute: async () => 'echoed',
      }
      const events: LoopEvent[] = []

      await runAgent(baseConfig({ rules: join(dir, 'actauth.yml'), tools: [echo] }), modelCall, 'hi', [], {
        onEvent: (event) => events.push(event),
      })

      expect(events).toContainEqual({
        type: 'actauth:decision',
        tool: 'echo',
        decision: 'allow',
        reason: "matched rule 'echo-allowed'",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('defaults tools to agents/<name>/tools/index when omitted entirely', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('no tool called'))

    // No tools override — 'customer-service' matches this repo's real
    // agents/customer-service/tools/index.ts, which exports 4 tools.
    // skillsDirs: [] isolates this from customer-service's own real
    // skills folder, though the always-on system skill still adds a
    // Skill tool regardless (see run-agent.ts's systemSkillsDir) — same
    // "not opt-out-able" as the system system_read_file tool below.
    // Checked with arrayContaining, not a fixed full list:
    // customer-service's own gateway-tools.yml (see gateway-tools.ts) may
    // or may not exist/have entries depending on what's been registered
    // against this live repo checkout — not something this test should
    // assert the contents of.
    await runAgent(baseConfig({ name: 'customer-service', rules: [], skillsDirs: [] }), modelCall, 'hi')

    const toolsSentToModel = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(toolsSentToModel.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining(['get_shipment_details', 'issue_refund', 'lookup_order', 'send_email', 'system_read_file', 'Skill']),
    )
  })

  it('defaults to just the system tools (not a crash) when the agent has no tools/index folder at all', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('no tools here'))

    // 'test-agent' has no agents/test-agent/tools/ in this repo. Skill is
    // still declared because the system skill is always present.
    await runAgent(baseConfig({ tools: undefined }), modelCall, 'hi')

    const toolsSentToModel = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(toolsSentToModel.map((t: { name: string }) => t.name)).toEqual(['system_read_file', 'system_ask_user', 'Skill'])
  })

  it('an explicit empty tools array opts out of the agent default, but not of the system tools', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('no tool called'))

    await runAgent(baseConfig({ name: 'customer-service', tools: [], rules: [], skillsDirs: [] }), modelCall, 'hi')

    // arrayContaining, not a fixed full list — see the previous test's
    // own comment for why customer-service's gateway tools aren't
    // asserted on here.
    const toolsSentToModel = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(toolsSentToModel.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['system_read_file', 'Skill']))
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

    const config = baseConfig({ skillsDirs: ['agents/file-agent/skills'] })
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

    const events: LoopEvent[] = []
    const config = baseConfig({
      skillsDirs: ['agents/file-agent/skills'],
      tools: [echo],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'echo', decision: 'allow' }],
    })

    const result = await runAgent(config, modelCall, 'summarize and say hi', [], {
      onEvent: (event) => events.push(event),
    })

    const results = toolResults(result.history)
    expect(results.find((r) => r.tool_use_id === 't1')?.content).toContain('Summarize files')
    expect(results.find((r) => r.tool_use_id === 't2')?.content).toBe('"echoed"')
    expect(events.some((e) => e.type === 'actauth:decision')).toBe(true)
    expect(events.some((e) => e.type === 'toollane:result')).toBe(true)
  })

  it('recovers via compaction when the model call reports the prompt is too long', async () => {
    let call = 0
    const modelCall: ModelCall = vi.fn(async (messages) => {
      call++
      if (call === 1) {
        throw { status: 400, message: 'prompt is too long: exceeds maximum context length' }
      }
      return textResponse(`ok with ${messages.length} messages`)
    })

    const events: LoopEvent[] = []
    const config = baseConfig({ contextBudgetTokens: 8000 })

    const result = await runAgent(config, modelCall, 'hi', [], {
      onEvent: (event) => events.push(event),
    })

    expect(modelCall).toHaveBeenCalledTimes(2)
    expect(events.some((e) => e.type === 'prompt:compaction')).toBe(true)
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
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: '"echoed"', is_error: false, reason: "matched rule 'default/production/test-agent'" },
        ],
      },
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
    // silently dropped (compaction.ts's drain stage deletes outright, no
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
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: '"ok"', is_error: false, reason: "matched rule 'default/production/test-agent'" },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'echo', input: { round: 2 } }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't2', content: '"ok"', is_error: false, reason: "matched rule 'default/production/test-agent'" },
        ],
      },
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

  it('leaves stopReason unset on a normal finish', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('done'))
    const result = await runAgent(baseConfig(), modelCall, 'hi')
    expect(result.stopReason).toBeUndefined()
  })
})

describe('runAgent maxTurns', () => {
  it('stops a model stuck re-requesting the same tool forever, instead of looping without bound', async () => {
    // Always asks for the same tool call again — nothing about this
    // modelCall ever produces a final answer on its own.
    const modelCall: ModelCall = vi.fn(async () => toolUseResponse({ id: 't1', name: 'echo', input: { n: 1 } }))
    const echo: ToolDefinition = {
      name: 'echo',
      description: 'Echoes input',
      input_schema: { type: 'object', properties: {} },
      execute: async (input) => input,
    }
    const config = baseConfig({
      tools: [echo],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'echo', decision: 'allow' }],
      maxTurns: 3,
    })

    const result = await runAgent(config, modelCall, 'go')

    expect(modelCall).toHaveBeenCalledTimes(3)
    expect(result.stopReason).toBe('max_turns')
    expect(result.text).toContain('3 turns')
  })

  it('does not cut off a real answer that finishes within the cap', async () => {
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
      execute: async () => 'ok',
    }
    const config = baseConfig({
      tools: [echo],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'echo', decision: 'allow' }],
      maxTurns: 3,
    })

    const result = await runAgent(config, modelCall, 'go')

    expect(result.stopReason).toBeUndefined()
    expect(result.text).toBe('done')
  })
})

describe('runAgent system tools/skills', () => {
  it('makes the system_read_file tool available even when the agent defines no tools of its own', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('done'))

    await runAgent(baseConfig(), modelCall, 'hi')

    const toolsPassed = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(toolsPassed.map((t: { name: string }) => t.name)).toContain('system_read_file')
  })

  it("lets the agent's own same-named tool override the system default", async () => {
    const modelCall: ModelCall = vi.fn(async () => {
      return toolUseResponse({ id: 't1', name: 'system_read_file', input: { path: '/anything' } })
    })
    const customReadFile: ToolDefinition = {
      name: 'system_read_file',
      description: 'custom override',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      execute: async () => 'custom result',
    }
    const config = baseConfig({
      tools: [customReadFile],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'system_read_file', decision: 'allow' }],
      maxTurns: 1,
    })

    const result = await runAgent(config, modelCall, 'read something outside temp')

    const results = toolResults(result.history)
    expect(results).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '"custom result"', is_error: false, reason: "matched rule 'default/production/test-agent'" },
    ])
  })

  it('includes the system composio-large-outputs skill even when the agent explicitly opts out of its own skills dir', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('done'))
    const config = baseConfig({ skillsDirs: [] })

    await runAgent(config, modelCall, 'hi')

    const systemPrompt = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0][1]
    expect(systemPrompt).toContain('composio-large-outputs')
  })
})

describe('runAgent durable approvals', () => {
  it('runs an already-approved sibling immediately even when another call in the same batch is durably pending, and stops with pending', async () => {
    const modelCall: ModelCall = vi.fn(async () =>
      toolUseResponse({ id: 't1', name: 'safe', input: {} }, { id: 't2', name: 'gated', input: { amount: 900 } }),
    )
    const safe: ToolDefinition = {
      name: 'safe',
      description: 'Fine to run',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'ran fine'),
    }
    const gated: ToolDefinition = {
      name: 'gated',
      description: 'Needs durable approval',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'should not run yet'),
    }
    const requestDurableApproval = vi.fn(() => ({ pendingId: 'pending-1' }))
    const config = baseConfig({
      tools: [safe, gated],
      rules: [
        { scopePattern: 'default/production/test-agent', tool: 'safe', decision: 'allow' },
        { scopePattern: 'default/production/test-agent', tool: 'gated', decision: 'ask' },
      ],
    })

    const result = await runAgent(config, modelCall, 'do both', [], { channel: 'http', approver: { requestDurableApproval } })

    expect(requestDurableApproval).toHaveBeenCalledTimes(1)
    expect(safe.execute).toHaveBeenCalledTimes(1)
    expect(gated.execute).not.toHaveBeenCalled()
    expect(modelCall).toHaveBeenCalledTimes(1) // no second model call — the turn paused, it didn't continue
    expect(result.stopReason).toBe('pending_approval')
    expect(result.pending?.resultsSoFar).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '"ran fine"', is_error: false, reason: "matched rule 'default/production/test-agent'" },
    ])
    expect(result.pending?.outstanding).toEqual([
      { kind: 'approval', toolUseId: 't2', tool: 'gated', args: { amount: 900 }, pendingId: 'pending-1', reason: expect.stringContaining('awaiting durable approval') },
    ])
    // The dangling assistant tool_use message is durable (the same
    // crash-recovery shape session-store.ts's own hasUnresolvedToolCall
    // detects), but no completing tool_result message was ever pushed —
    // resultBlocks was incomplete while gated's own decision was pending.
    const last = result.history[result.history.length - 1]
    expect(last.role).toBe('assistant')
  })

  it('skips a durably-pending sibling with a synthesized result when another call in the same batch is denied, and never returns pending', async () => {
    const modelCall: ModelCall = vi.fn(async () =>
      toolUseResponse({ id: 't1', name: 'gated', input: {} }, { id: 't2', name: 'dangerous', input: {} }),
    )
    const gated: ToolDefinition = {
      name: 'gated',
      description: 'Needs durable approval',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'should not run'),
    }
    const dangerous: ToolDefinition = {
      name: 'dangerous',
      description: 'Should never run',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'should not run either'),
    }
    const requestDurableApproval = vi.fn(() => ({ pendingId: 'pending-2' }))
    const config = baseConfig({
      tools: [gated, dangerous],
      rules: [
        { scopePattern: 'default/production/test-agent', tool: 'gated', decision: 'ask' },
        { scopePattern: 'default/production/test-agent', tool: 'dangerous', decision: 'deny' },
      ],
    })

    const result = await runAgent(config, modelCall, 'do both', [], { channel: 'http', approver: { requestDurableApproval } })

    // The DurableApprover still got called — the batch is evaluated
    // fully, order-independently, before any denial short-circuits it —
    // but the resulting checkpoint (if the caller had created one) is
    // immediately moot: run-agent.ts never emits `pending` at all for a
    // batch that resolves synchronously.
    expect(requestDurableApproval).toHaveBeenCalledTimes(1)
    expect(gated.execute).not.toHaveBeenCalled()
    expect(result.stopReason).toBe('denied')
    expect(result.pending).toBeUndefined()
    const results = toolResults(result.history)
    const gatedResult = results.find((r) => r.tool_use_id === 't1')
    expect(gatedResult?.content).toMatch(/^skipped: /)
    expect(gatedResult?.is_error).toBe(true)
  })
})

describe('runAgent durable questions', () => {
  it('durably pends a system_ask_user call when a DurableQuestionHandler is configured, never touching the live onQuestionPending path', async () => {
    const modelCall: ModelCall = vi.fn(async () =>
      toolUseResponse({ id: 't1', name: 'system_ask_user', input: { question: 'Which warehouse?', options: ['east', 'west'] } }),
    )
    const notifyPendingQuestion = vi.fn(() => ({ pendingId: 'q-pending-1' }))
    const config = baseConfig()
    const onQuestionPending = vi.fn()

    const result = await runAgent(config, modelCall, 'pick a warehouse', [], {
      channel: 'http',
      onQuestionPending,
      questionHandler: { notifyPendingQuestion },
    })

    expect(notifyPendingQuestion).toHaveBeenCalledWith('Which warehouse?', ['east', 'west'], 'test-agent', undefined)
    // The whole point of the durable branch: the tool's own execute()/
    // onPending live path never runs at all — nothing here should ever
    // resolve on its own, since nothing is listening for an in-process
    // answer.
    expect(onQuestionPending).not.toHaveBeenCalled()
    expect(modelCall).toHaveBeenCalledTimes(1)
    expect(result.stopReason).toBe('pending_question')
    expect(result.pending?.resultsSoFar).toEqual([])
    expect(result.pending?.outstanding).toEqual([
      {
        kind: 'question',
        toolUseId: 't1',
        tool: 'system_ask_user',
        args: { question: 'Which warehouse?', options: ['east', 'west'] },
        pendingId: 'q-pending-1',
        reason: 'Which warehouse?',
      },
    ])
    const last = result.history[result.history.length - 1]
    expect(last.role).toBe('assistant')
  })

  it('shares one checkpoint-shaped pending bucket when a batch mixes a gated tool call and a system_ask_user call', async () => {
    const modelCall: ModelCall = vi.fn(async () =>
      toolUseResponse({ id: 't1', name: 'gated', input: { amount: 500 } }, { id: 't2', name: 'system_ask_user', input: { question: 'Approve refund?' } }),
    )
    const gated: ToolDefinition = {
      name: 'gated',
      description: 'Needs durable approval',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'should not run yet'),
    }
    const requestDurableApproval = vi.fn(() => ({ pendingId: 'pending-approval-1' }))
    const notifyPendingQuestion = vi.fn(() => ({ pendingId: 'pending-question-1' }))
    const config = baseConfig({
      tools: [gated],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'gated', decision: 'ask' }],
    })

    const result = await runAgent(config, modelCall, 'do both', [], {
      channel: 'http',
      approver: { requestDurableApproval },
      questionHandler: { notifyPendingQuestion },
    })

    expect(requestDurableApproval).toHaveBeenCalledTimes(1)
    expect(notifyPendingQuestion).toHaveBeenCalledTimes(1)
    expect(gated.execute).not.toHaveBeenCalled()
    // A mixed batch reports 'pending_approval', not 'pending_question' —
    // see RunAgentResult.stopReason's own doc comment for why that's the
    // right call, not an arbitrary tie-break.
    expect(result.stopReason).toBe('pending_approval')
    expect(result.pending?.outstanding).toEqual([
      { kind: 'approval', toolUseId: 't1', tool: 'gated', args: { amount: 500 }, pendingId: 'pending-approval-1', reason: expect.stringContaining('awaiting durable approval') },
      { kind: 'question', toolUseId: 't2', tool: 'system_ask_user', args: { question: 'Approve refund?', options: undefined }, pendingId: 'pending-question-1', reason: 'Approve refund?' },
    ])
  })

  it('does not swallow a deliberately-overridden system_ask_user tool into the durable-question bucket, even with a questionHandler configured', async () => {
    const modelCall: ModelCall = vi
      .fn()
      .mockResolvedValueOnce(toolUseResponse({ id: 't1', name: 'system_ask_user', input: { question: 'Anything?' } }))
      .mockResolvedValueOnce(textResponse('handled'))
    const overrideAskUser: ToolDefinition = {
      name: 'system_ask_user',
      description: 'A deliberate override, not the real system tool',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'handled by override'),
    }
    const notifyPendingQuestion = vi.fn(() => ({ pendingId: 'should-never-be-used' }))
    const config = baseConfig({
      tools: [overrideAskUser],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'system_ask_user', decision: 'allow' }],
    })

    const result = await runAgent(config, modelCall, 'hi', [], { channel: 'http', questionHandler: { notifyPendingQuestion } })

    // Matched by name (toolsByName.get('system_ask_user')) but not by
    // identity against the real askUserTool instance this call built —
    // same "config wins, and the override goes through the agent's own
    // rules like anything else" reasoning systemToolInstances' own check
    // already relies on. A name-only check here would have silently
    // swallowed this into the durable bucket instead.
    expect(notifyPendingQuestion).not.toHaveBeenCalled()
    expect(overrideAskUser.execute).toHaveBeenCalledTimes(1)
    expect(result.stopReason).toBeUndefined()
    expect(result.text).toBe('handled')
  })

  it('falls through to the live WebchatQuestionHandler path end to end when nothing configures a durable questionHandler', async () => {
    const modelCall: ModelCall = vi
      .fn()
      .mockResolvedValueOnce(toolUseResponse({ id: 't1', name: 'system_ask_user', input: { question: 'Which color?' } }))
      .mockResolvedValueOnce(textResponse('picked blue'))
    // No options.questionHandler, no AgentConfig.httpNotifier — this is
    // the ordinary shape of most agents in this repo (see
    // agents/customer-service/index.ts for the one agent that *does*
    // configure httpNotifier's 'question' event).
    const config = baseConfig()
    // Stands in for what an adapter (adapters/http.ts's own onQuestionPending
    // closures) actually does: notice the pending question, then answer it
    // asynchronously via the module-level answerQuestion() — same call a
    // real POST /questions/:id/answer route makes.
    const onQuestionPending = vi.fn((question: PendingQuestion) => {
      answerQuestion(question.id, 'blue')
    })

    const result = await runAgent(config, modelCall, 'pick a color', [], { channel: 'http', onQuestionPending })

    expect(onQuestionPending).toHaveBeenCalledTimes(1)
    expect(modelCall).toHaveBeenCalledTimes(2)
    expect(result.stopReason).toBeUndefined()
    expect(result.text).toBe('picked blue')
    // reason: 'system tool — always allowed' — the live path falls
    // through to the systemToolInstances bypass/toolLane, same as any
    // other system tool call, not a special code path of its own.
    const results = toolResults(result.history)
    expect(results).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: '"blue"', is_error: false, reason: 'system tool — always allowed' },
    ])
  })
})

describe('resumeAgent', () => {
  it('pushes the resolution as the completing message and continues the loop with a fresh model call', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('all done now'))
    const config = baseConfig()
    const history: Message[] = [
      { role: 'user', content: 'do the gated thing' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'gated', input: {} }] },
    ]
    const resolution: ModelContentBlock[] = [{ type: 'tool_result', tool_use_id: 't1', content: '"approved and ran"', is_error: false }]

    const result = await resumeAgent(config, modelCall, history, resolution)

    expect(modelCall).toHaveBeenCalledTimes(1)
    // Index 2, not messagesArg.length - 1: `messages` is mutated in place
    // by later pushMessage calls, and vi.fn() captures the array by
    // reference — by the time this assertion runs, the assistant's own
    // reply has already been appended too. Index 2 (history's 2 messages,
    // then the resolution) is the one slot this call's own model request
    // actually saw and that never gets overwritten by a later append.
    const [messagesArg] = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(messagesArg[2]).toEqual({ role: 'user', content: resolution })
    expect(result.text).toBe('all done now')
    expect(result.newMessages).toEqual([
      { role: 'user', content: resolution },
      { role: 'assistant', content: [{ type: 'text', text: 'all done now' }] },
    ])
    expect(result.history).toEqual([...history, ...result.newMessages])
  })

  it('can itself return pending again if the model requests another durably-gated call', async () => {
    const modelCall: ModelCall = vi.fn(async () => toolUseResponse({ id: 't2', name: 'gated-again', input: {} }))
    const gatedAgain: ToolDefinition = {
      name: 'gated-again',
      description: 'Also needs durable approval',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'should not run'),
    }
    const requestDurableApproval = vi.fn(() => ({ pendingId: 'pending-3' }))
    const config = baseConfig({
      tools: [gatedAgain],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'gated-again', decision: 'ask' }],
    })
    const history: Message[] = [
      { role: 'user', content: 'do the gated thing' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'gated', input: {} }] },
    ]
    const resolution: ModelContentBlock[] = [{ type: 'tool_result', tool_use_id: 't1', content: '"approved and ran"', is_error: false }]

    const result = await resumeAgent(config, modelCall, history, resolution, { channel: 'http', approver: { requestDurableApproval } })

    expect(result.stopReason).toBe('pending_approval')
    expect(result.pending?.outstanding).toEqual([
      { kind: 'approval', toolUseId: 't2', tool: 'gated-again', args: {}, pendingId: 'pending-3', reason: expect.stringContaining('awaiting durable approval') },
    ])
  })
})

describe('AgentConfig.onRunStart/onRunFinish', () => {
  it('fires onRunStart once with trigger "message" for a fresh runAgent() call, and onRunFinish once on genuine completion', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('all done'))
    const onRunStart = vi.fn()
    const onRunFinish = vi.fn()
    const config = baseConfig({ onRunStart, onRunFinish })

    const result = await runAgent(config, modelCall, 'hi', [], { tenant: 'acme', sessionId: 'session-1', channel: 'http' })

    expect(onRunStart).toHaveBeenCalledTimes(1)
    expect(onRunStart).toHaveBeenCalledWith({ agent: 'test-agent', tenant: 'acme', sessionId: 'session-1', channel: 'http', trigger: 'message' })
    expect(onRunFinish).toHaveBeenCalledTimes(1)
    expect(onRunFinish).toHaveBeenCalledWith({ agent: 'test-agent', tenant: 'acme', sessionId: 'session-1', channel: 'http', text: 'all done', stopReason: undefined })
    expect(result.text).toBe('all done')
  })

  it('fires onRunStart with trigger "resolution" for resumeAgent()', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('resumed and done'))
    const onRunStart = vi.fn()
    const config = baseConfig({ onRunStart })
    const history: Message[] = [
      { role: 'user', content: 'do the gated thing' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'gated', input: {} }] },
    ]
    const resolution: ModelContentBlock[] = [{ type: 'tool_result', tool_use_id: 't1', content: '"approved and ran"', is_error: false }]

    await resumeAgent(config, modelCall, history, resolution, { sessionId: 'session-2' })

    expect(onRunStart).toHaveBeenCalledWith({ agent: 'test-agent', tenant: 'default', sessionId: 'session-2', channel: undefined, trigger: 'resolution' })
  })

  it('does not fire onRunFinish when the turn is durably pending — only once it genuinely finishes', async () => {
    const modelCall: ModelCall = vi.fn(async () => toolUseResponse({ id: 't1', name: 'gated', input: {} }))
    const gated: ToolDefinition = {
      name: 'gated',
      description: 'Needs durable approval',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'should not run'),
    }
    const requestDurableApproval = vi.fn(() => ({ pendingId: 'pending-onrunfinish' }))
    const onRunFinish = vi.fn()
    const config = baseConfig({
      tools: [gated],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'gated', decision: 'ask' }],
      onRunFinish,
    })

    const result = await runAgent(config, modelCall, 'do the gated thing', [], { channel: 'http', approver: { requestDurableApproval } })

    expect(result.stopReason).toBe('pending_approval')
    expect(onRunFinish).not.toHaveBeenCalled()
  })

  it('fires onRunFinish with the stopReason for a denied turn', async () => {
    const modelCall: ModelCall = vi.fn(async () => toolUseResponse({ id: 't1', name: 'dangerous', input: {} }))
    const dangerous: ToolDefinition = {
      name: 'dangerous',
      description: 'Should never run',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'should not run'),
    }
    const onRunFinish = vi.fn()
    const config = baseConfig({
      tools: [dangerous],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'dangerous', decision: 'deny' }],
      onRunFinish,
    })

    const result = await runAgent(config, modelCall, 'do it')

    expect(result.stopReason).toBe('denied')
    expect(onRunFinish).toHaveBeenCalledTimes(1)
    expect(onRunFinish.mock.calls[0][0]).toMatchObject({ stopReason: 'denied' })
  })

  it('never awaits either hook, and logs rather than throws when one rejects or throws synchronously', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('done anyway'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onRunStart = vi.fn(() => {
      throw new Error('boom (sync)')
    })
    const onRunFinish = vi.fn(async () => {
      throw new Error('boom (async)')
    })
    const config = baseConfig({ onRunStart, onRunFinish })

    const result = await runAgent(config, modelCall, 'hi')
    // The async onRunFinish rejection is caught inside a .catch(), which
    // schedules a microtask — give it a turn to settle before asserting
    // console.error saw it, same reasoning any fire-and-forget rejection
    // handler needs a caller to flush microtasks before checking.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(result.text).toBe('done anyway')
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("onRunStart threw for agent 'test-agent'"), expect.any(Error))
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("onRunFinish threw for agent 'test-agent'"), expect.any(Error))
    consoleError.mockRestore()
  })

  it.each([['cli'], ['http_stream']] as const)('never fires either hook on the %s channel — that channel already delivers start/finish synchronously', async (channel) => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('done'))
    const onRunStart = vi.fn()
    const onRunFinish = vi.fn()
    const config = baseConfig({ onRunStart, onRunFinish })

    await runAgent(config, modelCall, 'hi', [], { channel })

    expect(onRunStart).not.toHaveBeenCalled()
    expect(onRunFinish).not.toHaveBeenCalled()
  })

  it('does fire on the http channel, and on no channel at all (a bespoke script)', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('done'))
    const onRunStart = vi.fn()
    const onRunFinish = vi.fn()
    const config = baseConfig({ onRunStart, onRunFinish })

    await runAgent(config, modelCall, 'hi', [], { channel: 'http' })
    await runAgent(config, modelCall, 'hi') // no channel at all

    expect(onRunStart).toHaveBeenCalledTimes(2)
    expect(onRunFinish).toHaveBeenCalledTimes(2)
  })
})

describe('AgentConfig.httpNotifier', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('makes an "ask" approval durable on the http channel when httpNotifier lists "approval"', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const modelCall: ModelCall = vi.fn(async () => toolUseResponse({ id: 't1', name: 'gated', input: {} }))
    const gated: ToolDefinition = {
      name: 'gated',
      description: 'Needs approval',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'should not run yet'),
    }
    const config = baseConfig({
      tools: [gated],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'gated', decision: 'ask' }],
      httpNotifier: { channel: 'webhook', config: { webhookUrl: 'https://example.com/hook', webhookSecret: 'shh' }, events: ['approval'] },
    })

    const result = await runAgent(config, modelCall, 'do it', [], { channel: 'http' })

    expect(gated.execute).not.toHaveBeenCalled()
    expect(result.stopReason).toBe('pending_approval')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['X-Actauth-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('makes a system_ask_user call durable on the http channel when httpNotifier lists "question"', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const modelCall: ModelCall = vi.fn(async () => toolUseResponse({ id: 't1', name: 'system_ask_user', input: { question: 'Which warehouse?' } }))
    const config = baseConfig({
      httpNotifier: { channel: 'webhook', config: { webhookUrl: 'https://example.com/hook', webhookSecret: 'shh' }, events: ['question'] },
    })

    const result = await runAgent(config, modelCall, 'pick one', [], { channel: 'http' })

    expect(result.stopReason).toBe('pending_question')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const headers = fetchMock.mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['X-Askuser-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('fires onRunStart/onRunFinish via httpNotifier on the http channel when neither is set directly', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const modelCall: ModelCall = vi.fn(async () => textResponse('done'))
    const config = baseConfig({
      httpNotifier: {
        channel: 'webhook',
        config: { webhookUrl: 'https://example.com/hook', webhookSecret: 'shh' },
        events: ['run_start', 'run_finish'],
      },
    })

    await runAgent(config, modelCall, 'hi', [], { channel: 'http' })

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const events = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string).event)
    expect(events.sort()).toEqual(['run_finish', 'run_start'])
    for (const [, init] of fetchMock.mock.calls) {
      const headers = init?.headers as Record<string, string>
      expect(headers['X-Lifecycle-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
    }
  })

  it('never fires onRunStart/onRunFinish via httpNotifier on cli/http_stream — those channels get no config, live default only', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const modelCall: ModelCall = vi.fn(async () => textResponse('done'))
    const config = baseConfig({
      httpNotifier: {
        channel: 'webhook',
        config: { webhookUrl: 'https://example.com/hook', webhookSecret: 'shh' },
        events: ['run_start', 'run_finish'],
      },
    })

    await runAgent(config, modelCall, 'hi', [], { channel: 'cli' })
    await runAgent(config, modelCall, 'hi', [], { channel: 'http_stream' })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  // The exact bug fixed by checking httpNotifier before options.approver
  // (see run-agent.ts's own comment at the approver resolution site):
  // adapters/http.ts's plain /messages route always passes *some*
  // options.approver of its own (a deployment-wide durable default, or a
  // live tracked one) — if that were checked first, an agent's own
  // httpNotifier would never get a chance to apply at all.
  it('wins outright over options.approver on the http channel, and never applies at all on other channels', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    // Re-derived from conversation content each call, not closure state —
    // this modelCall is reused across two separate runAgent() invocations
    // below, and a fixed-count script would misbehave across both.
    const modelCall: ModelCall = vi.fn(async (messages) => {
      const last = messages[messages.length - 1]
      const resolved = Array.isArray(last?.content) && last.content.some((b) => b.type === 'tool_result' && b.tool_use_id === 't1')
      if (resolved) return textResponse('done')
      return toolUseResponse({ id: 't1', name: 'gated', input: {} })
    })
    const gated: ToolDefinition = {
      name: 'gated',
      description: 'Needs approval',
      input_schema: { type: 'object', properties: {} },
      execute: vi.fn(async () => 'ran for real'),
    }
    const liveApprove = vi.fn(async () => true)
    const config = baseConfig({
      tools: [gated],
      rules: [{ scopePattern: 'default/production/test-agent', tool: 'gated', decision: 'ask' }],
      httpNotifier: { channel: 'webhook', config: { webhookUrl: 'https://example.com/hook', webhookSecret: 'shh' }, events: ['approval'] },
    })

    // channel: 'cli' — httpNotifier only ever matches 'http', so this
    // call's own options.approver is the only thing that applies.
    const cliResult = await runAgent(config, modelCall, 'do it', [], { channel: 'cli', approver: { requestApproval: liveApprove } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(liveApprove).toHaveBeenCalledTimes(1)
    expect(gated.execute).toHaveBeenCalledTimes(1)
    expect(cliResult.stopReason).toBeUndefined()

    // channel: 'http' on the exact same config — httpNotifier now
    // applies, and wins outright over whatever options.approver this
    // call also happens to supply.
    const httpResult = await runAgent(config, modelCall, 'do it', [], { channel: 'http', approver: { requestApproval: liveApprove } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(liveApprove).toHaveBeenCalledTimes(1) // still 1 — not called again for the http case
    expect(httpResult.stopReason).toBe('pending_approval')
  })
})
