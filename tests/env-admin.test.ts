import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listDeclaredEnvVars, setEnvVar, EnvVarNameError } from '../web/env-admin.js'

// Same fixture-agent-under-the-real-agents-dir approach as
// tests/actauth-admin.test.ts — env-admin.ts has no live-registry
// mutation to worry about (unlike ability-manager.ts's own tests), so a
// single shared constant name is fine here.
const AGENT_NAME = 'env-admin-fixture-agent'
const AGENT_DIR = join(process.cwd(), 'agents', AGENT_NAME)

// setEnvVar's own envFilePath() (web/env-admin.ts) is process.cwd()-
// relative, not injectable — so unlike every other admin module's
// tests, this one really does touch this developer's actual .env, which
// may hold real secrets (LOOPENGINE_ADMIN_AUTH, model API keys, ...).
// Snapshotting its exact byte content once, before any test runs, and
// restoring that same snapshot after *every* test (not chaining
// incremental diffs) is what makes this safe to run at all — never
// logged, never asserted on, just carried through opaquely.
const envPath = join(process.cwd(), '.env')
const pristineEnvContent = existsSync(envPath) ? readFileSync(envPath, 'utf8') : null
const pristineProcessEnvKeys = new Set(Object.keys(process.env))

afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
  if (pristineEnvContent === null) {
    rmSync(envPath, { force: true })
  } else {
    writeFileSync(envPath, pristineEnvContent)
  }
  for (const key of Object.keys(process.env)) {
    if (!pristineProcessEnvKeys.has(key)) delete process.env[key]
  }
})

function writeProvenance(record: unknown): void {
  mkdirSync(AGENT_DIR, { recursive: true })
  writeFileSync(join(AGENT_DIR, '.loopengine-abilities.json'), JSON.stringify(record, null, 2))
}

describe('listDeclaredEnvVars', () => {
  it('returns [] when no ability has been installed for this agent', () => {
    expect(listDeclaredEnvVars(AGENT_NAME)).toEqual([])
  })

  it('lists every declared var across every installed ability, with live set/not-set status', () => {
    delete process.env.LOOPENGINE_TEST_FIXTURE_VAR_A
    process.env.LOOPENGINE_TEST_FIXTURE_VAR_B = 'already-set'
    writeProvenance({
      'ability-a': { version: '1.0.0', tools: [], skills: [], actauthRules: [], contentHashes: {}, env: [{ name: 'LOOPENGINE_TEST_FIXTURE_VAR_A', description: 'from a', secret: true }] },
      'ability-b': { version: '1.0.0', tools: [], skills: [], actauthRules: [], contentHashes: {}, env: [{ name: 'LOOPENGINE_TEST_FIXTURE_VAR_B', description: 'from b', secret: false }] },
    })

    const vars = listDeclaredEnvVars(AGENT_NAME)

    expect(vars).toEqual(
      expect.arrayContaining([
        { name: 'LOOPENGINE_TEST_FIXTURE_VAR_A', description: 'from a', secret: true, abilityNames: ['ability-a'], set: false },
        { name: 'LOOPENGINE_TEST_FIXTURE_VAR_B', description: 'from b', secret: false, abilityNames: ['ability-b'], set: true },
      ]),
    )
  })

  it('merges a name declared by more than one ability into one row, listing every ability instead of hiding all but the first', () => {
    writeProvenance({
      'ability-a': { version: '1.0.0', tools: [], skills: [], actauthRules: [], contentHashes: {}, env: [{ name: 'LOOPENGINE_TEST_FIXTURE_SHARED', description: 'from a' }] },
      'ability-b': { version: '1.0.0', tools: [], skills: [], actauthRules: [], contentHashes: {}, env: [{ name: 'LOOPENGINE_TEST_FIXTURE_SHARED', description: 'from b' }] },
    })

    const vars = listDeclaredEnvVars(AGENT_NAME)
    expect(vars).toHaveLength(1)
    expect(vars[0].abilityNames).toEqual(['ability-a', 'ability-b'])
    expect(vars[0].description).toBe('from a')
  })

  it('treats a name as secret if any declaring ability marks it secret, even if another one checked first does not', () => {
    writeProvenance({
      'ability-a': { version: '1.0.0', tools: [], skills: [], actauthRules: [], contentHashes: {}, env: [{ name: 'LOOPENGINE_TEST_FIXTURE_SHARED', secret: false }] },
      'ability-b': { version: '1.0.0', tools: [], skills: [], actauthRules: [], contentHashes: {}, env: [{ name: 'LOOPENGINE_TEST_FIXTURE_SHARED', secret: true }] },
    })

    const vars = listDeclaredEnvVars(AGENT_NAME)
    expect(vars).toHaveLength(1)
    expect(vars[0].secret).toBe(true)
  })
})

describe('setEnvVar', () => {
  it('appends a new KEY=VALUE line to .env and applies it to process.env immediately', () => {
    setEnvVar('LOOPENGINE_TEST_FIXTURE_NEW', 'hello')

    expect(process.env.LOOPENGINE_TEST_FIXTURE_NEW).toBe('hello')
    expect(readFileSync(envPath, 'utf8')).toContain('LOOPENGINE_TEST_FIXTURE_NEW=hello')
  })

  it('preserves every other line, including comments, when upserting', () => {
    const before = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
    setEnvVar('LOOPENGINE_TEST_FIXTURE_ANOTHER', 'value1')

    const after = readFileSync(envPath, 'utf8')
    for (const line of before.split('\n')) {
      if (line.trim() === '') continue
      expect(after).toContain(line)
    }
  })

  it('replaces an existing key in place rather than duplicating it', () => {
    setEnvVar('LOOPENGINE_TEST_FIXTURE_REPLACE', 'first')
    setEnvVar('LOOPENGINE_TEST_FIXTURE_REPLACE', 'second')

    const content = readFileSync(envPath, 'utf8')
    expect(content.match(/LOOPENGINE_TEST_FIXTURE_REPLACE=/g)).toHaveLength(1)
    expect(content).toContain('LOOPENGINE_TEST_FIXTURE_REPLACE=second')
    expect(process.env.LOOPENGINE_TEST_FIXTURE_REPLACE).toBe('second')
  })

  it('quotes a value containing whitespace, matching how it would need to read back', () => {
    setEnvVar('LOOPENGINE_TEST_FIXTURE_SPACED', 'has a space')

    expect(readFileSync(envPath, 'utf8')).toContain('LOOPENGINE_TEST_FIXTURE_SPACED="has a space"')
  })

  it('throws EnvVarNameError for a name that is not valid uppercase_snake_case', () => {
    expect(() => setEnvVar('not-valid', 'x')).toThrow(EnvVarNameError)
    expect(() => setEnvVar('lowercase', 'x')).toThrow(EnvVarNameError)
    expect(() => setEnvVar('1STARTS_WITH_DIGIT', 'x')).toThrow(EnvVarNameError)
  })
})
