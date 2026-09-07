import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { registerAgent } from '../core/agent-registry.js'
import { installPackage, upgradePackage } from '../bin/package-manager.js'

// Same per-test-unique-agent-name reasoning as tests/package-install.test.ts
// — core/agent-registry.ts's registry is a process-wide singleton with no
// unregister.
let currentAgentDir: string | null = null

afterEach(() => {
  if (currentAgentDir) rmSync(currentAgentDir, { recursive: true, force: true })
  currentAgentDir = null
})

function registerFixtureAgent(): { name: string; dir: string } {
  const name = `package-upgrade-fixture-agent-${Math.random().toString(36).slice(2, 10)}`
  const dir = join(process.cwd(), 'agents', name)
  currentAgentDir = dir
  registerAgent({
    config: { name, systemPrompt: 'a fixture agent for package-manager tests', model: { provider: 'anthropic', model: 'claude-sonnet-5' }, tools: [] },
    createModelCall: () => {
      throw new Error('not called in this test')
    },
  })
  return { name, dir }
}

/** Same shape tests/package-install.test.ts's own buildFixturePackage
 * produces, except the tool/skill body content and actauth decision are
 * directly parameterized — upgrade tests need two *different* versions
 * of the same package (v1 and v2) to build a real base/theirs pair for
 * the three-way merge, unlike install's tests which only ever need one. */
function buildFixturePackageVersion(version: string, toolBody: string, skillBody: string, ruleDecision: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'loopengine-fixture-pkg-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'skills', 'fixture-skill'), { recursive: true })
  mkdirSync(join(dir, 'actauth'), { recursive: true })

  writeFileSync(
    join(dir, 'tools', 'fixture_tool.ts'),
    `import type { ToolDefinition } from '#core/agent-config.js'\n\nexport const fixtureTool: ToolDefinition = {\n  name: 'fixture_tool',\n  description: 'A fixture tool',\n  input_schema: { type: 'object', properties: {} },\n  execute: async () => '${toolBody}',\n}\n`,
  )
  writeFileSync(join(dir, 'skills', 'fixture-skill', 'SKILL.md'), `---\nname: fixture-skill\ndescription: "A fixture skill"\n---\n\n${skillBody}\n`)
  writeFileSync(join(dir, 'actauth', 'rules.yml'), `- name: fixture-tool-allowed\n  scope: "*/*"\n  tool: fixture_tool\n  decision: ${ruleDecision}\n`)
  writeFileSync(
    join(dir, 'loopengine.package.json'),
    JSON.stringify(
      { name: 'fixture-package', version, loopengineVersion: '*', tools: ['tools/fixture_tool.ts'], skills: ['skills/fixture-skill'], actauth: 'actauth/rules.yml', env: [] },
      null,
      2,
    ),
  )

  return dir
}

/** Both versions come from *this* function's own two calls (never a
 * real registry) — installPackage/upgradePackage's `fetchPackageDir`
 * override receives the exact spec string it would in production
 * (`fixture-package` for "latest", `fixture-package@1.0.0` for the
 * recorded old version) so a test can assert the right one gets
 * requested at each step, same as production's real
 * `<spec>@<oldVersion>` vs. `<spec>` distinction in upgradePackage. */
function makeFetch(v1Dir: string, v2Dir: string): (spec: string) => string {
  return (spec: string) => (spec.endsWith('@1.0.0') ? v1Dir : v2Dir)
}

describe('upgradePackage', () => {
  it('cleanly updates a tool/skill file and an unchanged actauth rule when nothing was hand-edited', async () => {
    const { name, dir } = registerFixtureAgent()
    const v1 = buildFixturePackageVersion('1.0.0', 'v1-result', 'v1 skill body', 'allow')
    const v2 = buildFixturePackageVersion('2.0.0', 'v2-result', 'v2 skill body', 'ask')
    await installPackage(name, 'fixture-package', { fetchPackageDir: () => v1 })

    const { files } = await upgradePackage(name, 'fixture-package', { fetchPackageDir: makeFetch(v1, v2) })

    expect(files).toEqual(
      expect.arrayContaining([
        { path: 'tools/fixture_tool.ts', status: 'updated' },
        { path: 'skills/fixture-skill/SKILL.md', status: 'updated' },
        { path: 'actauth:fixture-tool-allowed', status: 'updated' },
      ]),
    )
    expect(readFileSync(join(dir, 'tools', 'fixture_tool.ts'), 'utf8')).toContain('v2-result')
    expect(readFileSync(join(dir, 'skills', 'fixture-skill', 'SKILL.md'), 'utf8')).toContain('v2 skill body')
    expect(readFileSync(join(dir, 'actauth.yml'), 'utf8')).toMatch(/decision:\s*ask/)

    const provenance = JSON.parse(readFileSync(join(dir, '.loopengine-packages.json'), 'utf8'))
    expect(provenance['fixture-package'].version).toBe('2.0.0')
  })

  it('reports "unchanged" for a file the new version never touched', async () => {
    const { name } = registerFixtureAgent()
    const v1 = buildFixturePackageVersion('1.0.0', 'same-result', 'same skill body', 'allow')
    // v2 only bumps the version string — tool/skill/rule content is
    // byte-identical to v1.
    const v2 = buildFixturePackageVersion('2.0.0', 'same-result', 'same skill body', 'allow')
    await installPackage(name, 'fixture-package', { fetchPackageDir: () => v1 })

    const { files } = await upgradePackage(name, 'fixture-package', { fetchPackageDir: makeFetch(v1, v2) })

    expect(files).toEqual(
      expect.arrayContaining([
        { path: 'tools/fixture_tool.ts', status: 'unchanged' },
        { path: 'skills/fixture-skill/SKILL.md', status: 'unchanged' },
        { path: 'actauth:fixture-tool-allowed', status: 'unchanged' },
      ]),
    )
  })

  it('three-way-merges a hand-edit that does not overlap the upstream change, keeping both', async () => {
    const { name, dir } = registerFixtureAgent()
    const v1 = buildFixturePackageVersion('1.0.0', 'v1-result', 'v1 skill body', 'allow')
    const v2 = buildFixturePackageVersion('2.0.0', 'v2-result', 'v1 skill body', 'allow')
    await installPackage(name, 'fixture-package', { fetchPackageDir: () => v1 })

    // Hand-edit the *skill* (untouched by v2) — a real operator
    // customization that should survive the tool file's own upgrade
    // untouched, on a completely different file.
    const skillPath = join(dir, 'skills', 'fixture-skill', 'SKILL.md')
    writeFileSync(skillPath, readFileSync(skillPath, 'utf8').replace('v1 skill body', 'v1 skill body, hand-annotated'))

    const { files } = await upgradePackage(name, 'fixture-package', { fetchPackageDir: makeFetch(v1, v2) })

    const toolResult = files.find((f) => f.path === 'tools/fixture_tool.ts')
    const skillResult = files.find((f) => f.path === 'skills/fixture-skill/SKILL.md')
    expect(toolResult?.status).toBe('updated')
    expect(skillResult?.status).toBe('unchanged') // v2 never touched the skill, so the hand-edit is simply left alone
    expect(readFileSync(join(dir, 'tools', 'fixture_tool.ts'), 'utf8')).toContain('v2-result')
    expect(readFileSync(skillPath, 'utf8')).toContain('hand-annotated')
  })

  it('produces real <<<<<<< conflict markers, not a silent overwrite, when the same line changed on both sides', async () => {
    const { name, dir } = registerFixtureAgent()
    const v1 = buildFixturePackageVersion('1.0.0', 'v1-result', 'v1 skill body', 'allow')
    const v2 = buildFixturePackageVersion('2.0.0', 'v2-result', 'v1 skill body', 'allow')
    await installPackage(name, 'fixture-package', { fetchPackageDir: () => v1 })

    // Hand-edit the exact same line v2 also changes.
    const toolPath = join(dir, 'tools', 'fixture_tool.ts')
    writeFileSync(toolPath, readFileSync(toolPath, 'utf8').replace('v1-result', 'hand-edited-result'))

    const { files } = await upgradePackage(name, 'fixture-package', { fetchPackageDir: makeFetch(v1, v2) })

    const toolResult = files.find((f) => f.path === 'tools/fixture_tool.ts')
    expect(toolResult?.status).toBe('conflict')
    const merged = readFileSync(toolPath, 'utf8')
    expect(merged).toContain('<<<<<<< mine')
    expect(merged).toContain('hand-edited-result')
    expect(merged).toContain('v2-result')
  })

  it('leaves a hand-edited actauth rule alone and reports it as a conflict rather than overwriting it', async () => {
    const { name, dir } = registerFixtureAgent()
    const v1 = buildFixturePackageVersion('1.0.0', 'v1-result', 'v1 skill body', 'allow')
    const v2 = buildFixturePackageVersion('2.0.0', 'v1-result', 'v1 skill body', 'ask')
    await installPackage(name, 'fixture-package', { fetchPackageDir: () => v1 })

    // Operator hand-tightened the rule to "deny" since install — v2's
    // own "ask" should not clobber that.
    const actauthPath = join(dir, 'actauth.yml')
    writeFileSync(actauthPath, readFileSync(actauthPath, 'utf8').replace('decision: allow', 'decision: deny'))

    const { files } = await upgradePackage(name, 'fixture-package', { fetchPackageDir: makeFetch(v1, v2) })

    const ruleResult = files.find((f) => f.path === 'actauth:fixture-tool-allowed')
    expect(ruleResult?.status).toBe('conflict')
    expect(readFileSync(actauthPath, 'utf8')).toMatch(/decision:\s*deny/)
  })
})
