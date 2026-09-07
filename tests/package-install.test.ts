import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getEntry, registerAgent } from '../core/agent-registry.js'
import {
  installPackage,
  removePackage,
  PackageAlreadyInstalledError,
  PackageCollisionError,
  PackageManifestError,
  PackageNotInstalledError,
  PackageVersionError,
  type PackageEnvDecl,
} from '../bin/package-manager.js'

// Same real-fixture-agent-dir-under-the-repo's-own-agents/ approach as
// tests/http-tool-admin.test.ts — installPackage resolves paths through
// agentDir the same way createHttpTool does, so a mocked fs wouldn't
// exercise the real thing.
//
// A *unique* name per test (not one shared constant), unlike most other
// admin-module test files: core/agent-registry.ts's own registry is a
// process-wide singleton with no unregister (see its own doc comment —
// same "no restart needed" design that makes an install take effect
// live also means nothing ever un-registers an agent). Reusing one name
// across `it()` blocks in this file would leak config.tools mutations
// from one test's install into the next test's assertions.
let currentAgentDir: string | null = null

afterEach(() => {
  if (currentAgentDir) rmSync(currentAgentDir, { recursive: true, force: true })
  currentAgentDir = null
})

/** Registers a fresh fixture agent (tools: [], not omitted, so
 * installPackage's own `entry.config.tools ?? loadDefaultTools(...)`
 * takes the cheap already-cached branch, never dynamically importing a
 * tools/index.ts this fixture agent doesn't have on disk) and returns
 * its name + real on-disk dir. */
function registerFixtureAgent(): { name: string; dir: string } {
  const name = `package-install-fixture-agent-${Math.random().toString(36).slice(2, 10)}`
  const dir = join(process.cwd(), 'agents', name)
  currentAgentDir = dir
  registerAgent({
    config: {
      name,
      systemPrompt: 'a fixture agent for package-manager tests',
      model: { provider: 'anthropic', model: 'claude-sonnet-5' },
      tools: [],
    },
    createModelCall: () => {
      throw new Error('not called in this test')
    },
  })
  return { name, dir }
}

function toCamelCase(snakeCase: string): string {
  return snakeCase.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

interface FixturePackageOptions {
  name?: string
  version?: string
  loopengineVersion?: string
  toolName?: string
  executeReturn?: string
  skillId?: string
  ruleName?: string
  ruleDecision?: string
  env?: PackageEnvDecl[]
}

/** Builds a real, self-contained loopengine package directory (never
 * published anywhere — fetchPackageDir is always overridden to return
 * this directly, so installPackage/upgradePackage never touch the real
 * npm registry in this file). Mirrors the shape PACKAGES.md specifies:
 * loopengine.package.json + tools/ + skills/ + actauth/. */
function buildFixturePackage(options: FixturePackageOptions = {}): string {
  const {
    name = 'fixture-package',
    version = '1.0.0',
    loopengineVersion = '*',
    toolName = 'fixture_tool',
    executeReturn = "'fixture-result'",
    skillId = 'fixture-skill',
    ruleName = 'fixture-tool-allowed',
    ruleDecision = 'allow',
    env = [{ name: 'FIXTURE_TOKEN', description: 'A fixture token', secret: true }],
  } = options

  const dir = mkdtempSync(join(tmpdir(), 'loopengine-fixture-pkg-'))
  mkdirSync(join(dir, 'tools'), { recursive: true })
  mkdirSync(join(dir, 'skills', skillId), { recursive: true })
  mkdirSync(join(dir, 'actauth'), { recursive: true })

  writeFileSync(
    join(dir, 'tools', `${toolName}.ts`),
    `import type { ToolDefinition } from '#core/agent-config.js'\n\nexport const ${toCamelCase(toolName)}: ToolDefinition = {\n  name: '${toolName}',\n  description: 'A fixture tool',\n  input_schema: { type: 'object', properties: {} },\n  execute: async () => ${executeReturn},\n}\n`,
  )
  writeFileSync(join(dir, 'skills', skillId, 'SKILL.md'), `---\nname: ${skillId}\ndescription: "A fixture skill"\n---\n\nFixture skill body.\n`)
  writeFileSync(join(dir, 'actauth', 'rules.yml'), `- name: ${ruleName}\n  scope: "*/*"\n  tool: ${toolName}\n  decision: ${ruleDecision}\n`)
  writeFileSync(
    join(dir, 'loopengine.package.json'),
    JSON.stringify({ name, version, loopengineVersion, tools: [`tools/${toolName}.ts`], skills: [`skills/${skillId}`], actauth: 'actauth/rules.yml', env }, null, 2),
  )

  return dir
}

describe('installPackage', () => {
  it('writes tool/skill/actauth files, records provenance, and splices the tool into the live registry', async () => {
    const { name, dir } = registerFixtureAgent()
    const packageDir = buildFixturePackage()

    const result = await installPackage(name, 'fixture-package', { fetchPackageDir: () => packageDir })

    expect(result.installed).toEqual(['tools/fixture_tool.ts', 'skills/fixture-skill/', 'actauth:fixture-tool-allowed'])
    expect(existsSync(join(dir, 'tools', 'fixture_tool.ts'))).toBe(true)
    expect(existsSync(join(dir, 'skills', 'fixture-skill', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(dir, 'actauth.yml'), 'utf8')).toContain('fixture-tool-allowed')

    const provenance = JSON.parse(readFileSync(join(dir, '.loopengine-packages.json'), 'utf8'))
    expect(provenance['fixture-package'].version).toBe('1.0.0')
    expect(provenance['fixture-package'].tools).toEqual(['fixture_tool'])
    expect(provenance['fixture-package'].skills).toEqual(['fixture-skill'])
    expect(provenance['fixture-package'].actauthRules).toEqual(['fixture-tool-allowed'])
    expect(provenance['fixture-package'].env).toEqual([{ name: 'FIXTURE_TOKEN', description: 'A fixture token', secret: true }])
    expect(typeof provenance['fixture-package'].contentHashes['tools/fixture_tool.ts']).toBe('string')

    // Live splice — callable immediately, no restart, same guarantee
    // handleHttpToolPost's own updateAgent call already gives a single
    // admin-created HTTP tool.
    const entry = getEntry(name)
    expect(entry?.config.tools?.map((t) => t.name)).toEqual(['fixture_tool'])
    await expect(entry!.config.tools![0]!.execute({})).resolves.toBe('fixture-result')
  })

  it('installs a package with no tools (skill + actauth only) without touching the live registry', async () => {
    const { name, dir } = registerFixtureAgent()
    const packageDir = buildFixturePackage()
    const manifestPath = join(packageDir, 'loopengine.package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    delete manifest.tools
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const result = await installPackage(name, 'fixture-package', { fetchPackageDir: () => packageDir })

    expect(result.installed).toEqual(['skills/fixture-skill/', 'actauth:fixture-tool-allowed'])
    expect(existsSync(join(dir, 'tools'))).toBe(false)
    expect(getEntry(name)?.config.tools).toEqual([])
  })

  it('refuses (all-or-nothing) when a tool file already exists, without writing the skill or actauth rule', async () => {
    const { name, dir } = registerFixtureAgent()
    mkdirSync(join(dir, 'tools'), { recursive: true })
    writeFileSync(join(dir, 'tools', 'fixture_tool.ts'), 'placeholder')
    const packageDir = buildFixturePackage()

    await expect(installPackage(name, 'fixture-package', { fetchPackageDir: () => packageDir })).rejects.toThrow(PackageCollisionError)
    expect(existsSync(join(dir, 'skills', 'fixture-skill'))).toBe(false)
    expect(existsSync(join(dir, 'actauth.yml'))).toBe(false)
  })

  it('refuses when an actauth rule of the same name already exists', async () => {
    const { name, dir } = registerFixtureAgent()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'actauth.yml'),
      'default_decision: deny\nrules:\n  - name: fixture-tool-allowed\n    scope: "*/*"\n    tool: something_else\n    decision: allow\n',
    )
    const packageDir = buildFixturePackage()

    await expect(installPackage(name, 'fixture-package', { fetchPackageDir: () => packageDir })).rejects.toThrow(PackageCollisionError)
    expect(existsSync(join(dir, 'tools', 'fixture_tool.ts'))).toBe(false)
  })

  it('refuses when the package is already installed for this agent', async () => {
    const { name } = registerFixtureAgent()
    const packageDir = buildFixturePackage()
    await installPackage(name, 'fixture-package', { fetchPackageDir: () => packageDir })

    await expect(installPackage(name, 'fixture-package', { fetchPackageDir: () => packageDir })).rejects.toThrow(PackageAlreadyInstalledError)
  })

  it('refuses when the installing project does not satisfy loopengineVersion', async () => {
    const { name, dir } = registerFixtureAgent()
    const packageDir = buildFixturePackage({ loopengineVersion: '^99.0.0' })

    await expect(
      installPackage(name, 'fixture-package', { fetchPackageDir: () => packageDir, installedLoopengineRange: '^0.1.10' }),
    ).rejects.toThrow(PackageVersionError)
    expect(existsSync(join(dir, 'tools'))).toBe(false)
  })

  it('throws PackageManifestError for a package with no loopengine.package.json', async () => {
    const { name } = registerFixtureAgent()
    const dir = mkdtempSync(join(tmpdir(), 'loopengine-fixture-pkg-'))

    await expect(installPackage(name, 'not-a-package', { fetchPackageDir: () => dir })).rejects.toThrow(PackageManifestError)
  })
})

describe('removePackage', () => {
  it('removes an untouched install entirely, including its actauth rule', async () => {
    const { name, dir } = registerFixtureAgent()
    const packageDir = buildFixturePackage()
    await installPackage(name, 'fixture-package', { fetchPackageDir: () => packageDir })

    const { removed, refused } = removePackage(name, 'fixture-package')

    expect(refused).toEqual([])
    expect(removed).toEqual(['tools/fixture_tool.ts', 'skills/fixture-skill/', 'actauth:fixture-tool-allowed'])
    expect(existsSync(join(dir, 'tools', 'fixture_tool.ts'))).toBe(false)
    expect(existsSync(join(dir, 'skills', 'fixture-skill'))).toBe(false)
    expect(readFileSync(join(dir, 'actauth.yml'), 'utf8')).not.toContain('fixture-tool-allowed')
    expect(JSON.parse(readFileSync(join(dir, '.loopengine-packages.json'), 'utf8'))).toEqual({})
  })

  it('refuses a hand-modified file without --force, but still removes untouched files and the actauth rule', async () => {
    const { name, dir } = registerFixtureAgent()
    const packageDir = buildFixturePackage()
    await installPackage(name, 'fixture-package', { fetchPackageDir: () => packageDir })
    writeFileSync(join(dir, 'tools', 'fixture_tool.ts'), '// hand-edited since install\n')

    const { removed, refused } = removePackage(name, 'fixture-package')

    expect(refused).toEqual(['tools/fixture_tool.ts'])
    expect(removed).toEqual(['skills/fixture-skill/', 'actauth:fixture-tool-allowed'])
    expect(existsSync(join(dir, 'tools', 'fixture_tool.ts'))).toBe(true)

    const provenance = JSON.parse(readFileSync(join(dir, '.loopengine-packages.json'), 'utf8'))
    expect(provenance['fixture-package'].tools).toEqual(['fixture_tool'])
  })

  it('removes a hand-modified file anyway when force is passed', async () => {
    const { name, dir } = registerFixtureAgent()
    const packageDir = buildFixturePackage()
    await installPackage(name, 'fixture-package', { fetchPackageDir: () => packageDir })
    writeFileSync(join(dir, 'tools', 'fixture_tool.ts'), '// hand-edited since install\n')

    const { removed, refused } = removePackage(name, 'fixture-package', true)

    expect(refused).toEqual([])
    expect(removed).toContain('tools/fixture_tool.ts')
    expect(existsSync(join(dir, 'tools', 'fixture_tool.ts'))).toBe(false)
  })

  it('throws PackageNotInstalledError for a package never installed', () => {
    const { name } = registerFixtureAgent()
    expect(() => removePackage(name, 'never-installed')).toThrow(PackageNotInstalledError)
  })
})
