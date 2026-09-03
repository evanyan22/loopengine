import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { editAgentFile, AgentEditNotSupportedError, AgentFileNotFoundError } from '../web/agent-file-admin.js'
import { AgentModelError } from '../bin/cli.js'

// Same fixture-agent-under-the-real-agents-dir approach as
// tests/skills-admin.test.ts — agent-file-admin.ts resolves paths off
// gateway-tools.ts's own agentDir, relative to this package's real
// agents/ folder, not process.cwd().
const AGENT_NAME = 'agent-file-admin-fixture-agent'
const AGENT_DIR = join(process.cwd(), 'agents', AGENT_NAME)
const INDEX_PATH = join(AGENT_DIR, 'index.ts')

function writeFixture(body: string): void {
  mkdirSync(AGENT_DIR, { recursive: true })
  writeFileSync(INDEX_PATH, body)
}

const TEMPLATE = `import type { AgentConfig } from 'loopengine'

export const config: AgentConfig = {
  name: '${AGENT_NAME}',
  systemPrompt: 'You are ...',
  model: { provider: 'anthropic', model: 'claude-sonnet-5' }, // reads ANTHROPIC_API_KEY
}
`

afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
})

describe('editAgentFile', () => {
  it('throws AgentFileNotFoundError when the agent has no index.ts', () => {
    expect(() => editAgentFile(AGENT_NAME, { systemPrompt: 'x' })).toThrow(AgentFileNotFoundError)
  })

  it('rewrites just systemPrompt, leaving model and everything else untouched', () => {
    writeFixture(TEMPLATE)

    const result = editAgentFile(AGENT_NAME, { systemPrompt: 'You are a helpful pirate.' })

    expect(result).toEqual({ systemPrompt: 'You are a helpful pirate.' })
    const contents = readFileSync(INDEX_PATH, 'utf8')
    expect(contents).toContain("systemPrompt: 'You are a helpful pirate.'")
    expect(contents).toContain("model: { provider: 'anthropic', model: 'claude-sonnet-5' }, // reads ANTHROPIC_API_KEY")
    expect(contents).toContain("import type { AgentConfig } from 'loopengine'")
  })

  it('escapes a systemPrompt containing a quote or backslash into valid TS', () => {
    writeFixture(TEMPLATE)

    editAgentFile(AGENT_NAME, { systemPrompt: "It's a \\test with \"quotes\" too" })

    expect(readFileSync(INDEX_PATH, 'utf8')).toContain(String.raw`systemPrompt: 'It\'s a \\test with "quotes" too'`)
  })

  it('rewrites model and fixes the matching "reads <ENV_VAR>" comment', () => {
    writeFixture(TEMPLATE)

    const result = editAgentFile(AGENT_NAME, { model: { provider: 'openai', model: 'gpt-4o' } })

    expect(result).toEqual({ model: { provider: 'openai', model: 'gpt-4o' } })
    const contents = readFileSync(INDEX_PATH, 'utf8')
    expect(contents).toContain("model: { provider: 'openai', model: 'gpt-4o' }, // reads OPENAI_API_KEY")
    expect(contents).toContain("systemPrompt: 'You are ...'")
  })

  it('leaves a hand-written (non-matching) trailing comment alone', () => {
    writeFixture(TEMPLATE.replace('// reads ANTHROPIC_API_KEY', '// custom note, do not touch'))

    editAgentFile(AGENT_NAME, { model: { provider: 'deepseek', model: 'deepseek-chat' } })

    const contents = readFileSync(INDEX_PATH, 'utf8')
    expect(contents).toContain("model: { provider: 'deepseek', model: 'deepseek-chat' }, // custom note, do not touch")
  })

  it('anthropic with no model name defaults to claude-sonnet-5', () => {
    writeFixture(TEMPLATE)

    const result = editAgentFile(AGENT_NAME, { model: { provider: 'anthropic' } })

    expect(result).toEqual({ model: { provider: 'anthropic', model: 'claude-sonnet-5' } })
  })

  it('rejects openai/deepseek with no model name, leaving the file untouched', () => {
    writeFixture(TEMPLATE)

    expect(() => editAgentFile(AGENT_NAME, { model: { provider: 'deepseek' } })).toThrow(AgentModelError)
    expect(readFileSync(INDEX_PATH, 'utf8')).toBe(TEMPLATE)
  })

  it('rejects a systemPrompt that is not a plain string literal', () => {
    writeFixture(TEMPLATE.replace("systemPrompt: 'You are ...'", 'systemPrompt: `You are ${dynamic}`'))

    expect(() => editAgentFile(AGENT_NAME, { systemPrompt: 'new prompt' })).toThrow(AgentEditNotSupportedError)
  })

  it('rejects a model that is not a plain inline object (e.g. a custom createModelCall setup)', () => {
    writeFixture(`import type { AgentConfig } from 'loopengine'

export const config: AgentConfig = {
  name: '${AGENT_NAME}',
  systemPrompt: 'You are ...',
}
export function createModelCall() {}
`)

    expect(() => editAgentFile(AGENT_NAME, { model: { provider: 'anthropic' } })).toThrow(AgentEditNotSupportedError)
  })

  it('rejects a file with no exported config object literal', () => {
    writeFixture(`export const somethingElse = {}\n`)

    expect(() => editAgentFile(AGENT_NAME, { systemPrompt: 'x' })).toThrow(AgentEditNotSupportedError)
  })

  it('applies both systemPrompt and model together in one call', () => {
    writeFixture(TEMPLATE)

    const result = editAgentFile(AGENT_NAME, { systemPrompt: 'New prompt.', model: { provider: 'openai', model: 'gpt-4o' } })

    expect(result).toEqual({ systemPrompt: 'New prompt.', model: { provider: 'openai', model: 'gpt-4o' } })
    const contents = readFileSync(INDEX_PATH, 'utf8')
    expect(contents).toContain("systemPrompt: 'New prompt.'")
    expect(contents).toContain("model: { provider: 'openai', model: 'gpt-4o' }, // reads OPENAI_API_KEY")
  })

  it('inserts maxTurns/contextBudgetTokens/skillIndexBudgetTokens as new properties when none of them are set yet', () => {
    writeFixture(TEMPLATE)

    const result = editAgentFile(AGENT_NAME, { maxTurns: 10, contextBudgetTokens: 12000, skillIndexBudgetTokens: 400 })

    expect(result).toEqual({ maxTurns: 10, contextBudgetTokens: 12000, skillIndexBudgetTokens: 400 })
    const contents = readFileSync(INDEX_PATH, 'utf8')
    expect(contents).toContain('maxTurns: 10,')
    expect(contents).toContain('contextBudgetTokens: 12000,')
    expect(contents).toContain('skillIndexBudgetTokens: 400,')
    // still a single well-formed config object, not two closing braces or
    // a stray property outside it
    expect(contents.match(/export const config: AgentConfig = \{/g)?.length).toBe(1)
    // and it's still valid enough for a second edit to find the property
    // it just inserted, proving this isn't just string-matching luck
    const second = editAgentFile(AGENT_NAME, { maxTurns: 11 })
    expect(second).toEqual({ maxTurns: 11 })
    expect(readFileSync(INDEX_PATH, 'utf8')).toContain('maxTurns: 11,')
  })

  it('rewrites an existing maxTurns in place instead of inserting a duplicate', () => {
    writeFixture(TEMPLATE.replace('model: { provider:', 'maxTurns: 5,\n  model: { provider:'))

    const result = editAgentFile(AGENT_NAME, { maxTurns: 30 })

    expect(result).toEqual({ maxTurns: 30 })
    const contents = readFileSync(INDEX_PATH, 'utf8')
    expect(contents).toContain('maxTurns: 30,')
    expect(contents.match(/maxTurns/g)?.length).toBe(1)
  })

  it('rejects a non-integer or non-positive value, leaving the file untouched', () => {
    writeFixture(TEMPLATE)

    expect(() => editAgentFile(AGENT_NAME, { maxTurns: 0 })).toThrow(AgentEditNotSupportedError)
    expect(() => editAgentFile(AGENT_NAME, { contextBudgetTokens: 1.5 })).toThrow(AgentEditNotSupportedError)
    expect(readFileSync(INDEX_PATH, 'utf8')).toBe(TEMPLATE)
  })

  it('rejects an existing skillIndexBudgetTokens that is not a plain number literal', () => {
    writeFixture(TEMPLATE.replace('model: { provider:', 'skillIndexBudgetTokens: computeBudget(),\n  model: { provider:'))

    expect(() => editAgentFile(AGENT_NAME, { skillIndexBudgetTokens: 300 })).toThrow(AgentEditNotSupportedError)
  })
})
