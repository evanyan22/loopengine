import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgent, type Message, type ModelCall, type ModelResponse } from '#run-agent.js'
import type { AgentConfig } from '#agent-config.js'

// agentsRootDir (run-agent.ts) is resolved next to run-agent.ts itself,
// not process.cwd() — but in this test run they're the same directory,
// same assumption the existing 'defaults tools to .../tools/index' test
// already relies on for agents/customer-service. These fixtures live
// under a dedicated agent name so they can't collide with real agents.
const PARENT_DIR = join(process.cwd(), 'agents', 'subagent-fixture-parent')

function baseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'subagent-fixture-parent',
    systemPrompt: 'You delegate to subagents.',
    rules: [],
    defaultDecision: 'allow',
    skillsDirs: [],
    ...overrides,
  }
}

function textResponse(text: string): ModelResponse {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
}

function toolUseResponse(...calls: Array<{ id: string; name: string; input: Record<string, unknown> }>): ModelResponse {
  return { stop_reason: 'tool_use', content: calls.map((c) => ({ type: 'tool_use', ...c })) }
}

function firstToolResult(messages: Message[]): { content?: string } | undefined {
  return messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b) => b.type === 'tool_result')
}

function writeChildFixture(dir: string, name: string, replyText: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'index.ts'),
    `export const config = {
  name: '${name}',
  systemPrompt: 'x',
  toolDescription: 'Delegate to ${name}.',
  rules: [],
  defaultDecision: 'allow',
  skillsDirs: [],
}
export function createModelCall() {
  return async () => (${JSON.stringify(textResponse(replyText))})
}
`,
  )
}

const extraDirsToClean: string[] = []

afterEach(() => {
  rmSync(PARENT_DIR, { recursive: true, force: true })
  for (const dir of extraDirsToClean.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('subagent auto-loading (agents/<name>/subagents/*)', () => {
  // Each test below uses its own, never-reused child agent name — Node's
  // ESM `import()` cache is keyed by resolved file URL and never expires
  // within a process, so re-importing the *same* path after overwriting
  // its contents (a later test reusing e.g. 'billing-agent') would
  // silently return an earlier test's stale module instead of the new
  // file on disk.
  it('merges a subagents/ folder in as tools, even with an explicit (empty) tools array', async () => {
    writeChildFixture(join(PARENT_DIR, 'subagents', 'billing-agent-merge'), 'billing-agent-merge', 'billing handled')

    const modelCall: ModelCall = vi.fn(async () => textResponse('done'))
    await runAgent(baseConfig({ tools: [] }), modelCall, 'hi')

    // Plus the always-on system tool/skill (system_read_file, Skill) —
    // see run-agent.ts's systemTools/systemSkillsDir.
    const toolsSentToModel = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(toolsSentToModel.map((t: { name: string }) => t.name)).toEqual(['system_read_file', 'system_ask_user', 'billing-agent-merge', 'Skill'])
  })

  it('does not add any agent-specific tools when the agent has no subagents/ folder at all', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('no tools here'))
    await runAgent(baseConfig({ name: 'subagent-fixture-parent-with-no-folder' }), modelCall, 'hi')

    const toolsSentToModel = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0][2]
    expect(toolsSentToModel.map((t: { name: string }) => t.name)).toEqual(['system_read_file', 'system_ask_user', 'Skill'])
  })

  it('calling the subagent tool runs the wrapped agent to completion and feeds its final text back as the tool result', async () => {
    writeChildFixture(join(PARENT_DIR, 'subagents', 'billing-agent-call'), 'billing-agent-call', 'billing handled it')

    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse({ id: 't1', name: 'billing-agent-call', input: { request: 'what do I owe' } })
      return textResponse('forwarded to billing')
    })

    const result = await runAgent(baseConfig(), modelCall, 'what do I owe')

    const secondCallMessages = (modelCall as ReturnType<typeof vi.fn>).mock.calls[1][0] as Message[]
    expect(firstToolResult(secondCallMessages)?.content).toBe('"billing handled it"')
    expect(result.text).toBe('forwarded to billing')
  })

  it('supports nesting — a subagent with its own subagents/ folder resolves via the same mechanism, one level down', async () => {
    const billingDir = join(PARENT_DIR, 'subagents', 'billing-agent-nest')
    const disputesDir = join(billingDir, 'subagents', 'disputes-agent-nest')
    writeChildFixture(disputesDir, 'disputes-agent-nest', 'dispute filed')

    // billing-agent-nest's own model calls its disputes-agent-nest
    // subagent tool on turn 1, then finalizes on turn 2 — proving the
    // nested runAgent() call (inside agentAsTool's execute) picked
    // disputes-agent-nest up as one of *its* tools, with no extra wiring
    // beyond the folder itself.
    mkdirSync(billingDir, { recursive: true })
    writeFileSync(
      join(billingDir, 'index.ts'),
      `export const config = {
  name: 'billing-agent-nest',
  systemPrompt: 'x',
  toolDescription: 'Delegate to billing.',
  rules: [],
  defaultDecision: 'allow',
  skillsDirs: [],
}
export function createModelCall() {
  let call = 0
  return async () => {
    call++
    if (call === 1) {
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'g1', name: 'disputes-agent-nest', input: { request: 'file it' } }] }
    }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'billing resolved via disputes-agent' }] }
  }
}
`,
    )

    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse({ id: 't1', name: 'billing-agent-nest', input: { request: 'dispute a charge' } })
      return textResponse('done')
    })

    const result = await runAgent(baseConfig(), modelCall, 'dispute a charge')

    const secondCallMessages = (modelCall as ReturnType<typeof vi.fn>).mock.calls[1][0] as Message[]
    expect(firstToolResult(secondCallMessages)?.content).toBe('"billing resolved via disputes-agent"')
    expect(result.text).toBe('done')
  })

  it('resolves an omitted tools/rules on a subagent against its own nested folder, not agents/<name>/', async () => {
    const dir = join(PARENT_DIR, 'subagents', 'billing-agent-owndefaults')
    mkdirSync(join(dir, 'tools'), { recursive: true })
    writeFileSync(
      join(dir, 'tools', 'index.ts'),
      `export const tools = [{
  name: 'lookup_invoice',
  description: 'Look up an invoice',
  input_schema: { type: 'object', properties: {} },
  execute: async () => 'INV-1002: $49 Pro plan renewal',
}]
`,
    )
    writeFileSync(
      join(dir, 'actauth.yml'),
      `default_decision: deny
rules:
  - name: lookup-invoice-allowed
    scope: "*/*"
    tool: lookup_invoice
    decision: allow
`,
    )
    // tools and rules both omitted — must come from ./tools/index.ts and
    // ./actauth.yml right here, not agents/billing-agent-owndefaults/...
    writeFileSync(
      join(dir, 'index.ts'),
      `export const config = {
  name: 'billing-agent-owndefaults',
  systemPrompt: 'x',
  toolDescription: 'Delegate billing questions.',
  skillsDirs: [],
}
export function createModelCall() {
  let call = 0
  return async () => {
    call++
    if (call === 1) return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'b1', name: 'lookup_invoice', input: {} }] }
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'billing-agent-owndefaults answered' }] }
  }
}
`,
    )

    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse({ id: 't1', name: 'billing-agent-owndefaults', input: { request: 'what is INV-1002' } })
      return textResponse('done')
    })

    await runAgent(baseConfig(), modelCall, 'what is INV-1002')

    const secondCallMessages = (modelCall as ReturnType<typeof vi.fn>).mock.calls[1][0] as Message[]
    expect(firstToolResult(secondCallMessages)?.content).toBe('"billing-agent-owndefaults answered"')
  })

  it('does not leak an unrelated top-level agent\'s tools/rules into a same-named subagent', async () => {
    // A real top-level-style agents/<name>/ folder — same bare name as
    // the nested subagent below, standing in for an unrelated agent that
    // happens to share a name. Its tool and permissive actauth.yml must
    // never be reachable from the subagent.
    const flatDir = join(process.cwd(), 'agents', 'collision-name-agent')
    extraDirsToClean.push(flatDir)
    mkdirSync(join(flatDir, 'tools'), { recursive: true })
    writeFileSync(
      join(flatDir, 'tools', 'index.ts'),
      `export const tools = [{
  name: 'flat_secret_tool',
  description: 'Should never be reachable from the subagent below',
  input_schema: { type: 'object', properties: {} },
  execute: async () => 'LEAKED',
}]
`,
    )
    writeFileSync(join(flatDir, 'actauth.yml'), 'default_decision: allow\n')

    // The subagent: same bare name, own nested folder, no tools/rules of
    // its own at all — so both must resolve to "nothing here" (empty
    // tools, deny-everything), never to the flat folder above.
    const nestedDir = join(PARENT_DIR, 'subagents', 'collision-name-agent')
    mkdirSync(nestedDir, { recursive: true })
    writeFileSync(
      join(nestedDir, 'index.ts'),
      `export const config = {
  name: 'collision-name-agent',
  systemPrompt: 'x',
  toolDescription: 'x',
  skillsDirs: [],
}
export function createModelCall() {
  return async (messages, system, tools) => ({
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'tools seen: ' + tools.map((t) => t.name).sort().join(',') }],
  })
}
`,
    )

    let call = 0
    const modelCall: ModelCall = vi.fn(async () => {
      call++
      if (call === 1) return toolUseResponse({ id: 't1', name: 'collision-name-agent', input: { request: 'hi' } })
      return textResponse('done')
    })

    await runAgent(baseConfig(), modelCall, 'hi')

    const secondCallMessages = (modelCall as ReturnType<typeof vi.fn>).mock.calls[1][0] as Message[]
    // Just the always-on system tool/skill, not "flat_secret_tool" —
    // proves the subagent's tools default resolved against its own
    // nested (empty) folder, not the flat same-named top-level one.
    expect(firstToolResult(secondCallMessages)?.content).toBe('"tools seen: Skill,system_ask_user,system_read_file"')
  })
})
