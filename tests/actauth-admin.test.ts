import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readActauthConfig,
  addActauthRule,
  updateActauthRule,
  removeActauthRule,
  setDefaultDecision,
  ActauthRuleExistsError,
  ActauthRuleNotFoundError,
} from '../actauth-admin.js'

// Same fixture-agent-under-the-real-agents-dir approach as
// tests/gateway-tools.test.ts.
const AGENT_NAME = 'actauth-admin-fixture-agent'
const AGENT_DIR = join(process.cwd(), 'agents', AGENT_NAME)

afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
})

describe('readActauthConfig', () => {
  it('defaults to deny/[] when actauth.yml does not exist', () => {
    expect(readActauthConfig(AGENT_NAME)).toEqual({ defaultDecision: 'deny', rules: [] })
  })
})

describe('addActauthRule / updateActauthRule / removeActauthRule', () => {
  it('addActauthRule appends a rule that readActauthConfig then returns', () => {
    addActauthRule(AGENT_NAME, { name: 'read-allowed', scope: 'default/production', tool: 'read_file', decision: 'allow' })
    expect(readActauthConfig(AGENT_NAME)).toEqual({
      defaultDecision: 'deny',
      rules: [{ name: 'read-allowed', scope: 'default/production', tool: 'read_file', decision: 'allow' }],
    })
  })

  it('rejects a duplicate rule name', () => {
    addActauthRule(AGENT_NAME, { name: 'dup', scope: 'default/production', tool: 'read_file', decision: 'allow' })
    expect(() => addActauthRule(AGENT_NAME, { name: 'dup', scope: '*/*', tool: 'write_file', decision: 'deny' })).toThrow(ActauthRuleExistsError)
  })

  it('updateActauthRule mutates scope/tool/decision of an existing rule by name', () => {
    addActauthRule(AGENT_NAME, { name: 'r1', scope: 'default/production', tool: 'read_file', decision: 'allow' })
    updateActauthRule(AGENT_NAME, 'r1', { scope: '*/*', tool: 'write_file', decision: 'ask' })
    expect(readActauthConfig(AGENT_NAME).rules).toEqual([{ name: 'r1', scope: '*/*', tool: 'write_file', decision: 'ask' }])
  })

  it('updateActauthRule throws ActauthRuleNotFoundError for an unknown name', () => {
    expect(() => updateActauthRule(AGENT_NAME, 'nope', { scope: '*/*', tool: 'x', decision: 'ask' })).toThrow(ActauthRuleNotFoundError)
  })

  it('removeActauthRule drops the rule by name', () => {
    addActauthRule(AGENT_NAME, { name: 'r1', scope: 'default/production', tool: 'read_file', decision: 'allow' })
    addActauthRule(AGENT_NAME, { name: 'r2', scope: 'default/production', tool: 'write_file', decision: 'ask' })
    removeActauthRule(AGENT_NAME, 'r1')
    expect(readActauthConfig(AGENT_NAME).rules).toEqual([{ name: 'r2', scope: 'default/production', tool: 'write_file', decision: 'ask' }])
  })

  it('removeActauthRule throws ActauthRuleNotFoundError for an unknown name', () => {
    expect(() => removeActauthRule(AGENT_NAME, 'nope')).toThrow(ActauthRuleNotFoundError)
  })

  it('setDefaultDecision updates default_decision without touching rules', () => {
    addActauthRule(AGENT_NAME, { name: 'r1', scope: 'default/production', tool: 'read_file', decision: 'allow' })
    setDefaultDecision(AGENT_NAME, 'allow')
    expect(readActauthConfig(AGENT_NAME)).toEqual({
      defaultDecision: 'allow',
      rules: [{ name: 'r1', scope: 'default/production', tool: 'read_file', decision: 'allow' }],
    })
  })

  it('preserves comments and hand-authored rules untouched by an edit elsewhere in the file', () => {
    mkdirSync(AGENT_DIR, { recursive: true })
    writeFileSync(
      join(AGENT_DIR, 'actauth.yml'),
      'default_decision: ask\n\nrules:\n  # hand-written reasoning for this rule\n  - name: hand-written\n    scope: default/production\n    tool: read_file\n    decision: allow\n',
    )

    addActauthRule(AGENT_NAME, { name: 'new-rule', scope: '*/*', tool: 'write_file', decision: 'deny' })

    const raw = readFileSync(join(AGENT_DIR, 'actauth.yml'), 'utf8')
    expect(raw).toContain('# hand-written reasoning for this rule')
    expect(readActauthConfig(AGENT_NAME).rules).toEqual([
      { name: 'hand-written', scope: 'default/production', tool: 'read_file', decision: 'allow' },
      { name: 'new-rule', scope: '*/*', tool: 'write_file', decision: 'deny' },
    ])
  })
})
