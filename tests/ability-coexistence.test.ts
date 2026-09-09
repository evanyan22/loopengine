// End-to-end check that all three collision types (tool name, skill id,
// env var name) actually work correctly *together*, not just in
// isolation — each is exercised separately in tests/ability-install.test.ts/
// tests/ability-upgrade.test.ts/tests/env-admin.test.ts, but nothing else
// installs two abilities that collide on every axis at once and carries
// that install through an upgrade and a remove. The three mechanisms are
// independent code (a tools loop, a skills loop, and env is just read
// straight off the manifest into provenance), so this is really a check
// that they don't interfere with each other when they all fire on the
// same install, not a check of any one mechanism's own logic.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { installAbility, removeAbility, upgradeAbility } from '../bin/ability-manager.js'
import { listDeclaredEnvVars } from '../web/env-admin.js'

const AGENT_NAME = 'ability-coexistence-fixture-agent'
const AGENT_DIR = join(process.cwd(), 'agents', AGENT_NAME)

afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
})

/** Builds a self-contained ability directory declaring one tool, one
 * skill, and one env var, all under names deliberately shared across
 * both abilities this test installs — `toolBody` varies so an upgrade
 * has something real to three-way-merge. */
function buildAbility(name: string, version: string, toolBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'loopengine-fixture-coexist-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'skills', 'shared-skill'), { recursive: true })
  mkdirSync(join(dir, 'actauth'), { recursive: true })

  writeFileSync(
    join(dir, 'tools', 'shared_tool.ts'),
    `import type { ToolDefinition } from '#core/agent-config.js'\n\nexport const sharedTool: ToolDefinition = {\n  name: 'shared_tool',\n  description: 'A shared-name tool',\n  input_schema: { type: 'object', properties: {} },\n  execute: async () => '${toolBody}',\n}\n`,
  )
  writeFileSync(join(dir, 'skills', 'shared-skill', 'SKILL.md'), `---\nname: shared-skill\ndescription: "A shared-name skill"\n---\n\nBody for ${name}.\n`)
  writeFileSync(join(dir, 'actauth', 'rules.yml'), `- name: ${name}-shared-tool-allowed\n  scope: "*/*"\n  tool: shared_tool\n  decision: allow\n`)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, private: true }, null, 2))
  writeFileSync(
    join(dir, 'loopengine.ability.json'),
    JSON.stringify(
      {
        loopengineVersion: '*',
        tools: ['tools/shared_tool.ts'],
        skills: ['skills/shared-skill'],
        actauth: 'actauth/rules.yml',
        env: [{ name: 'SHARED_KEY', description: `from ${name}`, secret: name === 'ability-coexist-b' }],
      },
      null,
      2,
    ),
  )
  return dir
}

describe('tool + skill + env name collisions together', () => {
  it('coexist through install, survive an upgrade, and clean up correctly on remove', async () => {
    const aV1 = buildAbility('ability-coexist-a', '1.0.0', 'a-v1-result')
    await installAbility(AGENT_NAME, 'ability-coexist-a', { fetchAbilityDir: () => aV1 })

    const bV1 = buildAbility('ability-coexist-b', '1.0.0', 'b-v1-result')
    const installResult = await installAbility(AGENT_NAME, 'ability-coexist-b', { fetchAbilityDir: () => bV1 })

    // --- Install: both artifacts namespaced, nothing refused ---
    expect(installResult.installed).toContain('tools/ability_coexist_b__shared_tool.ts')
    expect(installResult.installed).toContain('skills/ability-coexist-b/shared-skill/')
    expect(installResult.installed).toContain('actauth:ability-coexist-b-shared-tool-allowed')

    expect(existsSync(join(AGENT_DIR, 'tools', 'shared_tool.ts'))).toBe(true)
    expect(existsSync(join(AGENT_DIR, 'tools', 'ability_coexist_b__shared_tool.ts'))).toBe(true)
    expect(existsSync(join(AGENT_DIR, 'skills', 'shared-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(join(AGENT_DIR, 'skills', 'ability-coexist-b', 'shared-skill', 'SKILL.md'))).toBe(true)

    const provenance = JSON.parse(readFileSync(join(AGENT_DIR, '.loopengine-abilities.json'), 'utf8'))
    expect(provenance['ability-coexist-a'].tools).toEqual(['shared_tool'])
    expect(provenance['ability-coexist-b'].tools).toEqual(['ability_coexist_b__shared_tool'])
    expect(provenance['ability-coexist-a'].skills).toEqual(['shared-skill'])
    expect(provenance['ability-coexist-b'].skills).toEqual(['ability-coexist-b/shared-skill'])

    // --- Env: surfaced as shared, not silently collapsed to one ---
    const envVars = listDeclaredEnvVars(AGENT_NAME)
    const shared = envVars.find((v) => v.name === 'SHARED_KEY')
    expect(shared?.abilityNames).toEqual(['ability-coexist-a', 'ability-coexist-b'])
    expect(shared?.secret).toBe(true) // OR'd — b declared it secret even though a (checked first) didn't

    // --- Both tools genuinely distinct and independently callable ---
    const mod = (await import(pathToFileURL(join(AGENT_DIR, 'tools', 'index.ts')).href)) as {
      tools: { name: string; execute: () => Promise<string> }[]
    }
    const names = mod.tools.map((t) => t.name).sort()
    expect(names).toEqual(['ability_coexist_b__shared_tool', 'shared_tool'])
    expect(await mod.tools.find((t) => t.name === 'shared_tool')?.execute()).toBe('a-v1-result')
    expect(await mod.tools.find((t) => t.name === 'ability_coexist_b__shared_tool')?.execute()).toBe('b-v1-result')

    // --- Upgrade the namespaced one; the bare one is untouched ---
    // upgradeAbility fetches the *old* content (pinned to "@1.0.0", via
    // oldContentSpec) and the *new* content (the bare spec) separately —
    // they have to resolve to different directories here, same as
    // tests/ability-upgrade.test.ts's own makeFetch, or there's nothing
    // to diff and every file reports "unchanged" regardless of what
    // actually changed.
    const bV2 = buildAbility('ability-coexist-b', '2.0.0', 'b-v2-result')
    const { files } = await upgradeAbility(AGENT_NAME, 'ability-coexist-b', {
      fetchAbilityDir: (spec) => (spec.endsWith('@1.0.0') ? bV1 : bV2),
    })
    expect(files.find((f) => f.path === 'tools/ability_coexist_b__shared_tool.ts')?.status).toBe('updated')
    expect(readFileSync(join(AGENT_DIR, 'tools', 'ability_coexist_b__shared_tool.ts'), 'utf8')).toContain('b-v2-result')
    expect(readFileSync(join(AGENT_DIR, 'tools', 'shared_tool.ts'), 'utf8')).toContain('a-v1-result')

    // --- Remove ability B; ability A's bare-named artifacts survive ---
    const { removed, refused } = removeAbility(AGENT_NAME, 'ability-coexist-b')
    expect(refused).toEqual([])
    expect(removed).toContain('tools/ability_coexist_b__shared_tool.ts')
    expect(removed).toContain('skills/ability-coexist-b/shared-skill/')
    expect(existsSync(join(AGENT_DIR, 'tools', 'ability_coexist_b__shared_tool.ts'))).toBe(false)
    expect(existsSync(join(AGENT_DIR, 'skills', 'ability-coexist-b'))).toBe(false)
    expect(existsSync(join(AGENT_DIR, 'tools', 'shared_tool.ts'))).toBe(true)
    expect(existsSync(join(AGENT_DIR, 'skills', 'shared-skill', 'SKILL.md'))).toBe(true)

    const indexSource = readFileSync(join(AGENT_DIR, 'tools', 'index.ts'), 'utf8')
    expect(indexSource).not.toContain('ability_coexist_b')
    expect(indexSource).toContain('export const tools: ToolDefinition[] = [sharedTool]')

    const envAfterRemove = listDeclaredEnvVars(AGENT_NAME)
    const sharedAfterRemove = envAfterRemove.find((v) => v.name === 'SHARED_KEY')
    expect(sharedAfterRemove?.abilityNames).toEqual(['ability-coexist-a'])
  })
})
