import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
// exercise the real thing. A single constant name is fine here (unlike
// an earlier version of this file) — installPackage is pure filesystem
// operations now, no live agent-registry interaction to leak state
// across tests (see package-manager.ts's own installPackage doc comment
// for why it doesn't attempt that: a CLI process can't splice into a
// separate, already-running server anyway).
const AGENT_NAME = 'package-install-fixture-agent'
const AGENT_DIR = join(process.cwd(), 'agents', AGENT_NAME)

afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
})

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
  it('writes tool/skill/actauth files and records provenance', async () => {
    const packageDir = buildFixturePackage()

    const result = await installPackage(AGENT_NAME, 'fixture-package', { fetchPackageDir: () => packageDir })

    expect(result.installed).toEqual(['tools/fixture_tool.ts', 'skills/fixture-skill/', 'actauth:fixture-tool-allowed'])
    expect(existsSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'))).toBe(true)
    expect(existsSync(join(AGENT_DIR, 'skills', 'fixture-skill', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(AGENT_DIR, 'actauth.yml'), 'utf8')).toContain('fixture-tool-allowed')

    // tools/index.ts is patched (addToolToIndex), not the tool actually
    // imported/spliced anywhere — installPackage is pure filesystem
    // operations, see its own doc comment for why (a separate CLI
    // process can't reach into an already-running server's memory).
    const indexSource = readFileSync(join(AGENT_DIR, 'tools', 'index.ts'), 'utf8')
    expect(indexSource).toContain("import { fixtureTool } from './fixture_tool.js'")
    expect(indexSource).toContain('export const tools: ToolDefinition[] = [fixtureTool]')

    const provenance = JSON.parse(readFileSync(join(AGENT_DIR, '.loopengine-packages.json'), 'utf8'))
    expect(provenance['fixture-package'].version).toBe('1.0.0')
    expect(provenance['fixture-package'].tools).toEqual(['fixture_tool'])
    expect(provenance['fixture-package'].skills).toEqual(['fixture-skill'])
    expect(provenance['fixture-package'].actauthRules).toEqual(['fixture-tool-allowed'])
    expect(provenance['fixture-package'].env).toEqual([{ name: 'FIXTURE_TOKEN', description: 'A fixture token', secret: true }])
    expect(typeof provenance['fixture-package'].contentHashes['tools/fixture_tool.ts']).toBe('string')
  })

  it('installs a package with no tools (skill + actauth only) without creating a tools/ dir', async () => {
    const packageDir = buildFixturePackage()
    const manifestPath = join(packageDir, 'loopengine.package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    delete manifest.tools
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    const result = await installPackage(AGENT_NAME, 'fixture-package', { fetchPackageDir: () => packageDir })

    expect(result.installed).toEqual(['skills/fixture-skill/', 'actauth:fixture-tool-allowed'])
    expect(existsSync(join(AGENT_DIR, 'tools'))).toBe(false)
  })

  it('refuses (all-or-nothing) when a tool file already exists, without writing the skill or actauth rule', async () => {
    mkdirSync(join(AGENT_DIR, 'tools'), { recursive: true })
    writeFileSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'), 'placeholder')
    const packageDir = buildFixturePackage()

    await expect(installPackage(AGENT_NAME, 'fixture-package', { fetchPackageDir: () => packageDir })).rejects.toThrow(PackageCollisionError)
    expect(existsSync(join(AGENT_DIR, 'skills', 'fixture-skill'))).toBe(false)
    expect(existsSync(join(AGENT_DIR, 'actauth.yml'))).toBe(false)
  })

  it('refuses when an actauth rule of the same name already exists', async () => {
    mkdirSync(AGENT_DIR, { recursive: true })
    writeFileSync(
      join(AGENT_DIR, 'actauth.yml'),
      'default_decision: deny\nrules:\n  - name: fixture-tool-allowed\n    scope: "*/*"\n    tool: something_else\n    decision: allow\n',
    )
    const packageDir = buildFixturePackage()

    await expect(installPackage(AGENT_NAME, 'fixture-package', { fetchPackageDir: () => packageDir })).rejects.toThrow(PackageCollisionError)
    expect(existsSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'))).toBe(false)
  })

  it('refuses when the package is already installed for this agent', async () => {
    const packageDir = buildFixturePackage()
    await installPackage(AGENT_NAME, 'fixture-package', { fetchPackageDir: () => packageDir })

    await expect(installPackage(AGENT_NAME, 'fixture-package', { fetchPackageDir: () => packageDir })).rejects.toThrow(PackageAlreadyInstalledError)
  })

  it('refuses when the installing project does not satisfy loopengineVersion', async () => {
    const packageDir = buildFixturePackage({ loopengineVersion: '^99.0.0' })

    await expect(
      installPackage(AGENT_NAME, 'fixture-package', { fetchPackageDir: () => packageDir, installedLoopengineRange: '^0.1.10' }),
    ).rejects.toThrow(PackageVersionError)
    expect(existsSync(join(AGENT_DIR, 'tools'))).toBe(false)
  })

  it('throws PackageManifestError for a package with no loopengine.package.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'loopengine-fixture-pkg-'))

    await expect(installPackage(AGENT_NAME, 'not-a-package', { fetchPackageDir: () => dir })).rejects.toThrow(PackageManifestError)
  })
})

describe('removePackage', () => {
  it('removes an untouched install entirely, including its actauth rule', async () => {
    const packageDir = buildFixturePackage()
    await installPackage(AGENT_NAME, 'fixture-package', { fetchPackageDir: () => packageDir })

    const { removed, refused } = removePackage(AGENT_NAME, 'fixture-package')

    expect(refused).toEqual([])
    expect(removed).toEqual(['tools/fixture_tool.ts', 'skills/fixture-skill/', 'actauth:fixture-tool-allowed'])
    expect(existsSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'))).toBe(false)
    expect(existsSync(join(AGENT_DIR, 'skills', 'fixture-skill'))).toBe(false)
    expect(readFileSync(join(AGENT_DIR, 'actauth.yml'), 'utf8')).not.toContain('fixture-tool-allowed')
    expect(JSON.parse(readFileSync(join(AGENT_DIR, '.loopengine-packages.json'), 'utf8'))).toEqual({})
  })

  it('refuses a hand-modified file without --force, but still removes untouched files and the actauth rule', async () => {
    const packageDir = buildFixturePackage()
    await installPackage(AGENT_NAME, 'fixture-package', { fetchPackageDir: () => packageDir })
    writeFileSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'), '// hand-edited since install\n')

    const { removed, refused } = removePackage(AGENT_NAME, 'fixture-package')

    expect(refused).toEqual(['tools/fixture_tool.ts'])
    expect(removed).toEqual(['skills/fixture-skill/', 'actauth:fixture-tool-allowed'])
    expect(existsSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'))).toBe(true)

    const provenance = JSON.parse(readFileSync(join(AGENT_DIR, '.loopengine-packages.json'), 'utf8'))
    expect(provenance['fixture-package'].tools).toEqual(['fixture_tool'])
  })

  it('removes a hand-modified file anyway when force is passed', async () => {
    const packageDir = buildFixturePackage()
    await installPackage(AGENT_NAME, 'fixture-package', { fetchPackageDir: () => packageDir })
    writeFileSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'), '// hand-edited since install\n')

    const { removed, refused } = removePackage(AGENT_NAME, 'fixture-package', true)

    expect(refused).toEqual([])
    expect(removed).toContain('tools/fixture_tool.ts')
    expect(existsSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'))).toBe(false)
  })

  it('throws PackageNotInstalledError for a package never installed', () => {
    expect(() => removePackage(AGENT_NAME, 'never-installed')).toThrow(PackageNotInstalledError)
  })

  it('removes the tool from tools/index.ts, not just the .ts file', async () => {
    const packageDir = buildFixturePackage()
    await installPackage(AGENT_NAME, 'fixture-package', { fetchPackageDir: () => packageDir })
    expect(readFileSync(join(AGENT_DIR, 'tools', 'index.ts'), 'utf8')).toContain('fixtureTool')

    removePackage(AGENT_NAME, 'fixture-package')

    const indexSource = readFileSync(join(AGENT_DIR, 'tools', 'index.ts'), 'utf8')
    expect(indexSource).not.toContain('fixtureTool')
    expect(indexSource).toContain('export const tools: ToolDefinition[] = []')
  })

  it('reinstalling the same package right after removing it does not duplicate the tool in tools/index.ts', async () => {
    // The exact sequence a real "pick up upstream changes" workflow uses
    // when upgrade-package isn't an option (see upgradePackage's own
    // oldContentSpec doc comment) — confirmed live to have corrupted
    // tools/index.ts with a duplicate `import { fixtureTool }` (a
    // TypeScript "Duplicate identifier" build error) before
    // removeToolFromIndex existed: removePackage used to leave the
    // stale import behind entirely, and addToolToIndex had no
    // idempotence check to catch it on the way back in.
    const packageDir = buildFixturePackage()
    await installPackage(AGENT_NAME, 'fixture-package', { fetchPackageDir: () => packageDir })

    removePackage(AGENT_NAME, 'fixture-package')
    await installPackage(AGENT_NAME, 'fixture-package', { fetchPackageDir: () => packageDir })

    const indexSource = readFileSync(join(AGENT_DIR, 'tools', 'index.ts'), 'utf8')
    expect(indexSource.match(/^import \{ fixtureTool \}/gm)?.length).toBe(1)
    expect(indexSource).toContain('export const tools: ToolDefinition[] = [fixtureTool]')
  })
})
