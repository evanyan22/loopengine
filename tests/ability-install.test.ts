import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installAbility,
  removeAbility,
  AbilityAlreadyInstalledError,
  AbilityCollisionError,
  AbilityManifestError,
  AbilityNotInstalledError,
  AbilityVersionError,
  type AbilityEnvDecl,
} from '../bin/ability-manager.js'

// Same real-fixture-agent-dir-under-the-repo's-own-agents/ approach as
// tests/http-tool-admin.test.ts — installAbility resolves paths through
// agentDir the same way createHttpTool does, so a mocked fs wouldn't
// exercise the real thing. A single constant name is fine here (unlike
// an earlier version of this file) — installAbility is pure filesystem
// operations now, no live agent-registry interaction to leak state
// across tests (see ability-manager.ts's own installAbility doc comment
// for why it doesn't attempt that: a CLI process can't splice into a
// separate, already-running server anyway).
const AGENT_NAME = 'ability-install-fixture-agent'
const AGENT_DIR = join(process.cwd(), 'agents', AGENT_NAME)

afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
})

function toCamelCase(snakeCase: string): string {
  return snakeCase.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

interface FixtureAbilityOptions {
  name?: string
  version?: string
  loopengineVersion?: string
  toolName?: string
  executeReturn?: string
  skillId?: string
  ruleName?: string
  ruleDecision?: string
  env?: AbilityEnvDecl[]
}

/** Builds a real, self-contained loopengine ability directory (never
 * published anywhere — fetchAbilityDir is always overridden to return
 * this directly, so installAbility/upgradeAbility never touch the real
 * npm registry in this file). Mirrors the shape ABILITIES.md specifies:
 * loopengine.ability.json + tools/ + skills/ + actauth/. */
function buildFixtureAbility(options: FixtureAbilityOptions = {}): string {
  const {
    name = 'fixture-ability',
    version = '1.0.0',
    loopengineVersion = '*',
    toolName = 'fixture_tool',
    executeReturn = "'fixture-result'",
    skillId = 'fixture-skill',
    ruleName = 'fixture-tool-allowed',
    ruleDecision = 'allow',
    env = [{ name: 'FIXTURE_TOKEN', description: 'A fixture token', secret: true }],
  } = options

  const dir = mkdtempSync(join(tmpdir(), 'loopengine-fixture-ability-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'skills', skillId), { recursive: true })
  mkdirSync(join(dir, 'actauth'), { recursive: true })

  writeFileSync(
    join(dir, 'tools', `${toolName}.ts`),
    `import type { ToolDefinition } from '#core/agent-config.js'\n\nexport const ${toCamelCase(toolName)}: ToolDefinition = {\n  name: '${toolName}',\n  description: 'A fixture tool',\n  input_schema: { type: 'object', properties: {} },\n  execute: async () => ${executeReturn},\n}\n`,
  )
  writeFileSync(join(dir, 'skills', skillId, 'SKILL.md'), `---\nname: ${skillId}\ndescription: "A fixture skill"\n---\n\nFixture skill body.\n`)
  writeFileSync(join(dir, 'actauth', 'rules.yml'), `- name: ${ruleName}\n  scope: "*/*"\n  tool: ${toolName}\n  decision: ${ruleDecision}\n`)
  // name/version live in package.json, not loopengine.ability.json — see
  // AbilityManifest's own doc comment (bin/ability-manager.ts).
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, private: true }, null, 2))
  writeFileSync(
    join(dir, 'loopengine.ability.json'),
    JSON.stringify({ loopengineVersion, tools: [`tools/${toolName}.ts`], skills: [`skills/${skillId}`], actauth: 'actauth/rules.yml', env }, null, 2),
  )

  return dir
}

describe('installAbility', () => {
  it('writes tool/skill/actauth files and records provenance', async () => {
    const abilityDir = buildFixtureAbility()

    const result = await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => abilityDir })

    expect(result.installed).toEqual(['tools/fixture_tool.ts', 'skills/fixture-skill/', 'actauth:fixture-tool-allowed'])
    expect(existsSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'))).toBe(true)
    expect(existsSync(join(AGENT_DIR, 'skills', 'fixture-skill', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(AGENT_DIR, 'actauth.yml'), 'utf8')).toContain('fixture-tool-allowed')

    // tools/index.ts is patched (addToolToIndex), not the tool actually
    // imported/spliced anywhere — installAbility is pure filesystem
    // operations, see its own doc comment for why (a separate CLI
    // process can't reach into an already-running server's memory).
    const indexSource = readFileSync(join(AGENT_DIR, 'tools', 'index.ts'), 'utf8')
    expect(indexSource).toContain("import { fixtureTool } from './fixture_tool.js'")
    expect(indexSource).toContain('export const tools: ToolDefinition[] = [fixtureTool]')

    const provenance = JSON.parse(readFileSync(join(AGENT_DIR, '.loopengine-abilities.json'), 'utf8'))
    expect(provenance['fixture-ability'].version).toBe('1.0.0')
    expect(provenance['fixture-ability'].tools).toEqual(['fixture_tool'])
    expect(provenance['fixture-ability'].skills).toEqual(['fixture-skill'])
    expect(provenance['fixture-ability'].actauthRules).toEqual(['fixture-tool-allowed'])
    expect(provenance['fixture-ability'].env).toEqual([{ name: 'FIXTURE_TOKEN', description: 'A fixture token', secret: true }])
    expect(typeof provenance['fixture-ability'].contentHashes['tools/fixture_tool.ts']).toBe('string')
  })

  it('namespaces a second ability\'s colliding skill id under its own name instead of refusing the install', async () => {
    const firstDir = buildFixtureAbility()
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => firstDir })

    // Same bare skill id ("fixture-skill") as the first ability, but a
    // distinct tool/rule name — isolates the skill-id collision from the
    // tool-file/actauth-rule collisions, which still refuse outright
    // (only skills get namespaced instead of refused).
    const secondDir = buildFixtureAbility({
      name: 'fixture-ability-two',
      toolName: 'fixture_tool_two',
      ruleName: 'fixture-tool-two-allowed',
    })

    const result = await installAbility(AGENT_NAME, 'fixture-ability-two', { fetchAbilityDir: () => secondDir })

    expect(result.installed).toContain('skills/fixture-ability-two/fixture-skill/')
    expect(existsSync(join(AGENT_DIR, 'skills', 'fixture-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(AGENT_DIR, 'skills', 'fixture-ability-two', 'fixture-skill', 'SKILL.md'))).toBe(true)

    const provenance = JSON.parse(readFileSync(join(AGENT_DIR, '.loopengine-abilities.json'), 'utf8'))
    expect(provenance['fixture-ability'].skills).toEqual(['fixture-skill'])
    expect(provenance['fixture-ability-two'].skills).toEqual(['fixture-ability-two/fixture-skill'])
  })

  it('installs an ability with no tools (skill + actauth only) without creating a tools/ dir', async () => {
    const abilityDir = buildFixtureAbility()
    const manifestPath = join(abilityDir, 'loopengine.ability.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    delete manifest.tools
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const result = await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => abilityDir })

    expect(result.installed).toEqual(['skills/fixture-skill/', 'actauth:fixture-tool-allowed'])
    expect(existsSync(join(AGENT_DIR, 'tools'))).toBe(false)
  })

  it('namespaces its own tool under its own name when the bare tool name is already taken, without touching the existing file', async () => {
    mkdirSync(join(AGENT_DIR, 'tools'), { recursive: true })
    writeFileSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'), 'placeholder')
    const abilityDir = buildFixtureAbility()

    const result = await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => abilityDir })

    expect(result.installed).toContain('tools/fixture_ability__fixture_tool.ts')
    expect(readFileSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'), 'utf8')).toBe('placeholder')
    expect(existsSync(join(AGENT_DIR, 'skills', 'fixture-skill'))).toBe(true)
    expect(existsSync(join(AGENT_DIR, 'actauth.yml'))).toBe(true)
  })

  it('namespaces a second ability\'s colliding tool name so both remain independently callable', async () => {
    // Own, never-reused agent name/dir rather than the shared AGENT_NAME
    // — this test dynamically imports the generated tools/index.ts, and
    // Node's ESM import() cache is keyed by resolved file URL and never
    // expires within a process, so reusing AGENT_DIR here could return a
    // stale module from an earlier or later test that also imports it
    // (see tests/subagent-tools.test.ts's own comment on this exact
    // gotcha — a query-string cache-buster was tried here first and
    // didn't reliably avoid it either, so this test follows that file's
    // own proven fix instead: a name nothing else ever touches).
    const coexistAgentName = 'ability-install-fixture-agent-tool-coexist'
    const coexistAgentDir = join(process.cwd(), 'agents', coexistAgentName)
    try {
      const firstDir = buildFixtureAbility()
      await installAbility(coexistAgentName, 'fixture-ability', { fetchAbilityDir: () => firstDir })

      // Same bare tool name ("fixture_tool") as the first ability, but a
      // distinct skill/rule name — isolates the tool-name collision from
      // the skill/actauth-rule ones (already covered by their own tests).
      const secondDir = buildFixtureAbility({
        name: 'fixture-ability-two',
        skillId: 'fixture-skill-two',
        ruleName: 'fixture-tool-two-allowed',
        executeReturn: "'second-result'",
      })

      const result = await installAbility(coexistAgentName, 'fixture-ability-two', { fetchAbilityDir: () => secondDir })

      expect(result.installed).toContain('tools/fixture_ability_two__fixture_tool.ts')
      expect(existsSync(join(coexistAgentDir, 'tools', 'fixture_tool.ts'))).toBe(true)
      expect(existsSync(join(coexistAgentDir, 'tools', 'fixture_ability_two__fixture_tool.ts'))).toBe(true)

      const provenance = JSON.parse(readFileSync(join(coexistAgentDir, '.loopengine-abilities.json'), 'utf8'))
      expect(provenance['fixture-ability'].tools).toEqual(['fixture_tool'])
      expect(provenance['fixture-ability-two'].tools).toEqual(['fixture_ability_two__fixture_tool'])

      // Dynamically import the real, generated tools/index.ts — proves
      // both tools are genuinely distinct, callable ToolDefinitions (not
      // just that the generated source *looks* right), the same
      // technique web/http-tool-admin.ts's own createHttpTool already
      // uses to hand back a live tool.
      const mod = (await import(pathToFileURL(join(coexistAgentDir, 'tools', 'index.ts')).href)) as {
        tools: { name: string; execute: () => Promise<string> }[]
      }
      const names = mod.tools.map((t) => t.name).sort()
      expect(names).toEqual(['fixture_ability_two__fixture_tool', 'fixture_tool'])
      const second = mod.tools.find((t) => t.name === 'fixture_ability_two__fixture_tool')
      expect(await second?.execute()).toBe('second-result')
      const first = mod.tools.find((t) => t.name === 'fixture_tool')
      expect(await first?.execute()).toBe('fixture-result')
    } finally {
      rmSync(coexistAgentDir, { recursive: true, force: true })
    }
  })

  it('refuses when an actauth rule of the same name already exists', async () => {
    mkdirSync(AGENT_DIR, { recursive: true })
    writeFileSync(
      join(AGENT_DIR, 'actauth.yml'),
      'default_decision: deny\nrules:\n  - name: fixture-tool-allowed\n    scope: "*/*"\n    tool: something_else\n    decision: allow\n',
    )
    const abilityDir = buildFixtureAbility()

    await expect(installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => abilityDir })).rejects.toThrow(AbilityCollisionError)
    expect(existsSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'))).toBe(false)
  })

  it('refuses when the ability is already installed for this agent', async () => {
    const abilityDir = buildFixtureAbility()
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => abilityDir })

    await expect(installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => abilityDir })).rejects.toThrow(AbilityAlreadyInstalledError)
  })

  it('refuses when the installing project does not satisfy loopengineVersion', async () => {
    const abilityDir = buildFixtureAbility({ loopengineVersion: '^99.0.0' })

    await expect(
      installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => abilityDir, installedLoopengineRange: '^0.1.10' }),
    ).rejects.toThrow(AbilityVersionError)
    expect(existsSync(join(AGENT_DIR, 'tools'))).toBe(false)
  })

  it('throws AbilityManifestError for an ability with no loopengine.ability.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loopengine-fixture-ability-'))

    await expect(installAbility(AGENT_NAME, 'not-an-ability', { fetchAbilityDir: () => dir })).rejects.toThrow(AbilityManifestError)
  })

  it('throws AbilityManifestError for a loopengine.ability.json with no package.json sibling', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loopengine-fixture-ability-'))
    writeFileSync(join(dir, 'loopengine.ability.json'), JSON.stringify({ loopengineVersion: '*' }))

    await expect(installAbility(AGENT_NAME, 'not-an-ability', { fetchAbilityDir: () => dir })).rejects.toThrow(AbilityManifestError)
  })

  it('throws AbilityManifestError when the sibling package.json has no name/version', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loopengine-fixture-ability-'))
    writeFileSync(join(dir, 'loopengine.ability.json'), JSON.stringify({ loopengineVersion: '*' }))
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true }))

    await expect(installAbility(AGENT_NAME, 'not-an-ability', { fetchAbilityDir: () => dir })).rejects.toThrow(AbilityManifestError)
  })
})

describe('removeAbility', () => {
  it('removes an untouched install entirely, including its actauth rule', async () => {
    const abilityDir = buildFixtureAbility()
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => abilityDir })

    const { removed, refused } = removeAbility(AGENT_NAME, 'fixture-ability')

    expect(refused).toEqual([])
    expect(removed).toEqual(['tools/fixture_tool.ts', 'skills/fixture-skill/', 'actauth:fixture-tool-allowed'])
    expect(existsSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'))).toBe(false)
    expect(existsSync(join(AGENT_DIR, 'skills', 'fixture-skill'))).toBe(false)
    expect(readFileSync(join(AGENT_DIR, 'actauth.yml'), 'utf8')).not.toContain('fixture-tool-allowed')
    expect(JSON.parse(readFileSync(join(AGENT_DIR, '.loopengine-abilities.json'), 'utf8'))).toEqual({})
  })

  it('refuses a hand-modified file without --force, but still removes untouched files and the actauth rule', async () => {
    const abilityDir = buildFixtureAbility()
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => abilityDir })
    writeFileSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'), '// hand-edited since install\n')

    const { removed, refused } = removeAbility(AGENT_NAME, 'fixture-ability')

    expect(refused).toEqual(['tools/fixture_tool.ts'])
    expect(removed).toEqual(['skills/fixture-skill/', 'actauth:fixture-tool-allowed'])
    expect(existsSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'))).toBe(true)

    const provenance = JSON.parse(readFileSync(join(AGENT_DIR, '.loopengine-abilities.json'), 'utf8'))
    expect(provenance['fixture-ability'].tools).toEqual(['fixture_tool'])
  })

  it('removes a hand-modified file anyway when force is passed', async () => {
    const abilityDir = buildFixtureAbility()
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => abilityDir })
    writeFileSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'), '// hand-edited since install\n')

    const { removed, refused } = removeAbility(AGENT_NAME, 'fixture-ability', true)

    expect(refused).toEqual([])
    expect(removed).toContain('tools/fixture_tool.ts')
    expect(existsSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'))).toBe(false)
  })

  it('throws AbilityNotInstalledError for an ability never installed', () => {
    expect(() => removeAbility(AGENT_NAME, 'never-installed')).toThrow(AbilityNotInstalledError)
  })

  it('removes the tool from tools/index.ts, not just the .ts file', async () => {
    const abilityDir = buildFixtureAbility()
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => abilityDir })
    expect(readFileSync(join(AGENT_DIR, 'tools', 'index.ts'), 'utf8')).toContain('fixtureTool')

    removeAbility(AGENT_NAME, 'fixture-ability')

    const indexSource = readFileSync(join(AGENT_DIR, 'tools', 'index.ts'), 'utf8')
    expect(indexSource).not.toContain('fixtureTool')
    expect(indexSource).toContain('export const tools: ToolDefinition[] = []')
  })

  it('reinstalling the same ability right after removing it does not duplicate the tool in tools/index.ts', async () => {
    // The exact sequence a real "pick up upstream changes" workflow uses
    // when upgrade-ability isn't an option (see upgradeAbility's own
    // oldContentSpec doc comment) — confirmed live to have corrupted
    // tools/index.ts with a duplicate `import { fixtureTool }` (a
    // TypeScript "Duplicate identifier" build error) before
    // removeToolFromIndex existed: removeAbility used to leave the
    // stale import behind entirely, and addToolToIndex had no
    // idempotence check to catch it on the way back in.
    const abilityDir = buildFixtureAbility()
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => abilityDir })

    removeAbility(AGENT_NAME, 'fixture-ability')
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => abilityDir })

    const indexSource = readFileSync(join(AGENT_DIR, 'tools', 'index.ts'), 'utf8')
    expect(indexSource.match(/^import \{ fixtureTool \}/gm)?.length).toBe(1)
    expect(indexSource).toContain('export const tools: ToolDefinition[] = [fixtureTool]')
  })

  it('removes a namespaced tool cleanly — import, wrapper const, and array entry — leaving the other ability untouched', async () => {
    // Own agent name/dir — see the earlier "namespaces a second
    // ability's colliding tool name" test's own comment on why the
    // shared AGENT_DIR isn't safe for a test that dynamically imports
    // tools/index.ts.
    const removeAgentName = 'ability-install-fixture-agent-tool-remove'
    const removeAgentDir = join(process.cwd(), 'agents', removeAgentName)
    try {
      const firstDir = buildFixtureAbility()
      await installAbility(removeAgentName, 'fixture-ability', { fetchAbilityDir: () => firstDir })
      const secondDir = buildFixtureAbility({ name: 'fixture-ability-two', skillId: 'fixture-skill-two', ruleName: 'fixture-tool-two-allowed' })
      await installAbility(removeAgentName, 'fixture-ability-two', { fetchAbilityDir: () => secondDir })

      const { removed, refused } = removeAbility(removeAgentName, 'fixture-ability-two')

      expect(refused).toEqual([])
      expect(removed).toContain('tools/fixture_ability_two__fixture_tool.ts')
      expect(existsSync(join(removeAgentDir, 'tools', 'fixture_ability_two__fixture_tool.ts'))).toBe(false)

      const indexSource = readFileSync(join(removeAgentDir, 'tools', 'index.ts'), 'utf8')
      expect(indexSource).not.toContain('fixture_ability_two')
      expect(indexSource).toContain('export const tools: ToolDefinition[] = [fixtureTool]')

      // The first ability's own (bare-named) tool survives untouched and
      // still actually works — dynamically importing the patched
      // tools/index.ts, not just checking its source text.
      const mod = (await import(pathToFileURL(join(removeAgentDir, 'tools', 'index.ts')).href)) as {
        tools: { name: string; execute: () => Promise<string> }[]
      }
      expect(mod.tools.map((t) => t.name)).toEqual(['fixture_tool'])
      expect(await mod.tools[0].execute()).toBe('fixture-result')
    } finally {
      rmSync(removeAgentDir, { recursive: true, force: true })
    }
  })
})
