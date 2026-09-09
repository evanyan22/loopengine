import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installAbility, upgradeAbility } from '../bin/ability-manager.js'

// Same real-fixture-agent-dir-under-the-repo's-own-agents/ approach as
// tests/ability-install.test.ts — a plain constant is fine, no registry
// interaction here at all (installAbility/upgradeAbility are pure
// filesystem operations, see ability-manager.ts's own doc comments).
const AGENT_NAME = 'ability-upgrade-fixture-agent'
const AGENT_DIR = join(process.cwd(), 'agents', AGENT_NAME)

afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
})

/** Same shape tests/ability-install.test.ts's own buildFixtureAbility
 * produces, except the tool/skill body content and actauth decision are
 * directly parameterized — upgrade tests need two *different* versions
 * of the same ability (v1 and v2) to build a real base/theirs pair for
 * the three-way merge, unlike install's tests which only ever need one. */
function buildFixtureAbilityVersion(version: string, toolBody: string, skillBody: string, ruleDecision: string): string {
  const abilityDir = mkdtempSync(join(tmpdir(), 'loopengine-fixture-ability-'))
  mkdirSync(join(abilityDir, 'tools'), { recursive: true })
  mkdirSync(join(abilityDir, 'skills', 'fixture-skill'), { recursive: true })
  mkdirSync(join(abilityDir, 'actauth'), { recursive: true })

  writeFileSync(
    join(abilityDir, 'tools', 'fixture_tool.ts'),
    `import type { ToolDefinition } from '#core/agent-config.js'\n\nexport const fixtureTool: ToolDefinition = {\n  name: 'fixture_tool',\n  description: 'A fixture tool',\n  input_schema: { type: 'object', properties: {} },\n  execute: async () => '${toolBody}',\n}\n`,
  )
  writeFileSync(join(abilityDir, 'skills', 'fixture-skill', 'SKILL.md'), `---\nname: fixture-skill\ndescription: "A fixture skill"\n---\n\n${skillBody}\n`)
  writeFileSync(join(abilityDir, 'actauth', 'rules.yml'), `- name: fixture-tool-allowed\n  scope: "*/*"\n  tool: fixture_tool\n  decision: ${ruleDecision}\n`)
  // name/version live in package.json, not loopengine.ability.json — see
  // AbilityManifest's own doc comment (bin/ability-manager.ts).
  writeFileSync(join(abilityDir, 'package.json'), JSON.stringify({ name: 'fixture-ability', version, private: true }, null, 2))
  writeFileSync(
    join(abilityDir, 'loopengine.ability.json'),
    JSON.stringify(
      { loopengineVersion: '*', tools: ['tools/fixture_tool.ts'], skills: ['skills/fixture-skill'], actauth: 'actauth/rules.yml', env: [] },
      null,
      2,
    ),
  )

  return abilityDir
}

/** Both versions come from *this* function's own two calls (never a
 * real registry) — installAbility/upgradeAbility's `fetchAbilityDir`
 * override receives the exact spec string it would in production
 * (`fixture-ability` for "latest", `fixture-ability@1.0.0` for the
 * recorded old version) so a test can assert the right one gets
 * requested at each step, same as production's real
 * `<spec>@<oldVersion>` vs. `<spec>` distinction in upgradeAbility. */
function makeFetch(v1Dir: string, v2Dir: string): (spec: string) => string {
  return (spec: string) => (spec.endsWith('@1.0.0') ? v1Dir : v2Dir)
}

describe('upgradeAbility', () => {
  it('cleanly updates a tool/skill file and an unchanged actauth rule when nothing was hand-edited', async () => {
    const v1 = buildFixtureAbilityVersion('1.0.0', 'v1-result', 'v1 skill body', 'allow')
    const v2 = buildFixtureAbilityVersion('2.0.0', 'v2-result', 'v2 skill body', 'ask')
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => v1 })

    const { files } = await upgradeAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: makeFetch(v1, v2) })

    expect(files).toEqual(
      expect.arrayContaining([
        { path: 'tools/fixture_tool.ts', status: 'updated' },
        { path: 'skills/fixture-skill/SKILL.md', status: 'updated' },
        { path: 'actauth:fixture-tool-allowed', status: 'updated' },
      ]),
    )
    expect(readFileSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'), 'utf8')).toContain('v2-result')
    expect(readFileSync(join(AGENT_DIR, 'skills', 'fixture-skill', 'SKILL.md'), 'utf8')).toContain('v2 skill body')
    expect(readFileSync(join(AGENT_DIR, 'actauth.yml'), 'utf8')).toMatch(/decision:\s*ask/)

    const provenance = JSON.parse(readFileSync(join(AGENT_DIR, '.loopengine-abilities.json'), 'utf8'))
    expect(provenance['fixture-ability'].version).toBe('2.0.0')
  })

  it('reports "unchanged" for a file the new version never touched', async () => {
    const v1 = buildFixtureAbilityVersion('1.0.0', 'same-result', 'same skill body', 'allow')
    // v2 only bumps the version string — tool/skill/rule content is
    // byte-identical to v1.
    const v2 = buildFixtureAbilityVersion('2.0.0', 'same-result', 'same skill body', 'allow')
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => v1 })

    const { files } = await upgradeAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: makeFetch(v1, v2) })

    expect(files).toEqual(
      expect.arrayContaining([
        { path: 'tools/fixture_tool.ts', status: 'unchanged' },
        { path: 'skills/fixture-skill/SKILL.md', status: 'unchanged' },
        { path: 'actauth:fixture-tool-allowed', status: 'unchanged' },
      ]),
    )
  })

  it('three-way-merges a hand-edit that does not overlap the upstream change, keeping both', async () => {
    const v1 = buildFixtureAbilityVersion('1.0.0', 'v1-result', 'v1 skill body', 'allow')
    const v2 = buildFixtureAbilityVersion('2.0.0', 'v2-result', 'v1 skill body', 'allow')
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => v1 })

    // Hand-edit the *skill* (untouched by v2) — a real operator
    // customization that should survive the tool file's own upgrade
    // untouched, on a completely different file.
    const skillPath = join(AGENT_DIR, 'skills', 'fixture-skill', 'SKILL.md')
    writeFileSync(skillPath, readFileSync(skillPath, 'utf8').replace('v1 skill body', 'v1 skill body, hand-annotated'))

    const { files } = await upgradeAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: makeFetch(v1, v2) })

    const toolResult = files.find((f) => f.path === 'tools/fixture_tool.ts')
    const skillResult = files.find((f) => f.path === 'skills/fixture-skill/SKILL.md')
    expect(toolResult?.status).toBe('updated')
    expect(skillResult?.status).toBe('unchanged') // v2 never touched the skill, so the hand-edit is simply left alone
    expect(readFileSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'), 'utf8')).toContain('v2-result')
    expect(readFileSync(skillPath, 'utf8')).toContain('hand-annotated')
  })

  it('produces real <<<<<<< conflict markers, not a silent overwrite, when the same line changed on both sides', async () => {
    const v1 = buildFixtureAbilityVersion('1.0.0', 'v1-result', 'v1 skill body', 'allow')
    const v2 = buildFixtureAbilityVersion('2.0.0', 'v2-result', 'v1 skill body', 'allow')
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => v1 })

    // Hand-edit the exact same line v2 also changes.
    const toolPath = join(AGENT_DIR, 'tools', 'fixture_tool.ts')
    writeFileSync(toolPath, readFileSync(toolPath, 'utf8').replace('v1-result', 'hand-edited-result'))

    const { files } = await upgradeAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: makeFetch(v1, v2) })

    const toolResult = files.find((f) => f.path === 'tools/fixture_tool.ts')
    expect(toolResult?.status).toBe('conflict')
    const merged = readFileSync(toolPath, 'utf8')
    expect(merged).toContain('<<<<<<< mine')
    expect(merged).toContain('hand-edited-result')
    expect(merged).toContain('v2-result')
  })

  it('leaves a hand-edited actauth rule alone and reports it as a conflict rather than overwriting it', async () => {
    const v1 = buildFixtureAbilityVersion('1.0.0', 'v1-result', 'v1 skill body', 'allow')
    const v2 = buildFixtureAbilityVersion('2.0.0', 'v1-result', 'v1 skill body', 'ask')
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => v1 })

    // Operator hand-tightened the rule to "deny" since install — v2's
    // own "ask" should not clobber that.
    const actauthPath = join(AGENT_DIR, 'actauth.yml')
    writeFileSync(actauthPath, readFileSync(actauthPath, 'utf8').replace('decision: allow', 'decision: deny'))

    const { files } = await upgradeAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: makeFetch(v1, v2) })

    const ruleResult = files.find((f) => f.path === 'actauth:fixture-tool-allowed')
    expect(ruleResult?.status).toBe('conflict')
    expect(readFileSync(actauthPath, 'utf8')).toMatch(/decision:\s*deny/)
  })

  it('upgrades a namespaced skill correctly — matching against the manifest\'s bare id, not the installed namespaced one', async () => {
    // Occupies the bare "fixture-skill" id first, so the second
    // ability's own install below is forced to namespace under its own
    // name (see ability-manager.ts's namespacedSkillId).
    const occupant = buildFixtureAbilityVersion('1.0.0', 'occupant-result', 'occupant skill body', 'allow')
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => occupant })

    function buildSecondAbilityVersion(version: string, skillBody: string): string {
      const abilityDir = mkdtempSync(join(tmpdir(), 'loopengine-fixture-ability-two-'))
      mkdirSync(join(abilityDir, 'skills', 'fixture-skill'), { recursive: true })
      writeFileSync(join(abilityDir, 'skills', 'fixture-skill', 'SKILL.md'), `---\nname: fixture-skill\ndescription: "A second fixture skill"\n---\n\n${skillBody}\n`)
      writeFileSync(join(abilityDir, 'package.json'), JSON.stringify({ name: 'fixture-ability-two', version, private: true }, null, 2))
      writeFileSync(
        join(abilityDir, 'loopengine.ability.json'),
        JSON.stringify({ loopengineVersion: '*', skills: ['skills/fixture-skill'], env: [] }, null, 2),
      )
      return abilityDir
    }

    const v1 = buildSecondAbilityVersion('1.0.0', 'v1 skill body')
    const v2 = buildSecondAbilityVersion('2.0.0', 'v2 skill body')
    await installAbility(AGENT_NAME, 'fixture-ability-two', { fetchAbilityDir: () => v1 })
    expect(existsSync(join(AGENT_DIR, 'skills', 'fixture-ability-two', 'fixture-skill', 'SKILL.md'))).toBe(true)

    const { files } = await upgradeAbility(AGENT_NAME, 'fixture-ability-two', { fetchAbilityDir: makeFetch(v1, v2) })

    const skillResult = files.find((f) => f.path === 'skills/fixture-ability-two/fixture-skill/SKILL.md')
    expect(skillResult?.status).toBe('updated')
    expect(readFileSync(join(AGENT_DIR, 'skills', 'fixture-ability-two', 'fixture-skill', 'SKILL.md'), 'utf8')).toContain('v2 skill body')
  })

  it('upgrades a namespaced tool correctly — matching against the manifest\'s bare name, not the installed namespaced one', async () => {
    // Occupies the bare "fixture_tool" name first, so the second
    // ability's own install below is forced to namespace under its own
    // name (see ability-manager.ts's namespacedToolName).
    const occupant = buildFixtureAbilityVersion('1.0.0', 'occupant-result', 'occupant skill body', 'allow')
    await installAbility(AGENT_NAME, 'fixture-ability', { fetchAbilityDir: () => occupant })

    function buildSecondAbilityVersion(version: string, toolBody: string): string {
      const abilityDir = mkdtempSync(join(tmpdir(), 'loopengine-fixture-ability-two-'))
      mkdirSync(join(abilityDir, 'tools'), { recursive: true })
      writeFileSync(
        join(abilityDir, 'tools', 'fixture_tool.ts'),
        `import type { ToolDefinition } from '#core/agent-config.js'\n\nexport const fixtureTool: ToolDefinition = {\n  name: 'fixture_tool',\n  description: 'A second fixture tool',\n  input_schema: { type: 'object', properties: {} },\n  execute: async () => '${toolBody}',\n}\n`,
      )
      writeFileSync(join(abilityDir, 'package.json'), JSON.stringify({ name: 'fixture-ability-two', version, private: true }, null, 2))
      writeFileSync(
        join(abilityDir, 'loopengine.ability.json'),
        JSON.stringify({ loopengineVersion: '*', tools: ['tools/fixture_tool.ts'], env: [] }, null, 2),
      )
      return abilityDir
    }

    const v1 = buildSecondAbilityVersion('1.0.0', 'v1-result')
    const v2 = buildSecondAbilityVersion('2.0.0', 'v2-result')
    await installAbility(AGENT_NAME, 'fixture-ability-two', { fetchAbilityDir: () => v1 })
    expect(existsSync(join(AGENT_DIR, 'tools', 'fixture_ability_two__fixture_tool.ts'))).toBe(true)

    const { files } = await upgradeAbility(AGENT_NAME, 'fixture-ability-two', { fetchAbilityDir: makeFetch(v1, v2) })

    const toolResult = files.find((f) => f.path === 'tools/fixture_ability_two__fixture_tool.ts')
    expect(toolResult?.status).toBe('updated')
    expect(readFileSync(join(AGENT_DIR, 'tools', 'fixture_ability_two__fixture_tool.ts'), 'utf8')).toContain('v2-result')
  })
})
