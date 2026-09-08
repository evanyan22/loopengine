import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installPackage, upgradePackage } from '../bin/package-manager.js'

// Real fetchPackageDir (no mock), a real git repo, real `npm pack` — the
// only way to catch this bug: every other package-upgrade test mocks
// fetchPackageDir, so a spec string that's syntactically wrong but still
// "just a string" to the mock would sail through unnoticed. This is
// exactly what caught it live: `npm pack 'git+file://...#v1.0.0@1.0.0'`
// really does fail ("The git reference could not be found... pathspec
// 'v1.0.0@1.0.0'") — upgradePackage used to build exactly that string
// for any git-installed package.
const AGENT_NAME = 'package-upgrade-git-spec-fixture-agent'
const AGENT_DIR = join(process.cwd(), 'agents', AGENT_NAME)

let repoDir: string

afterEach(() => {
  rmSync(AGENT_DIR, { recursive: true, force: true })
  if (repoDir) rmSync(repoDir, { recursive: true, force: true })
})

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repoDir, stdio: 'pipe' })
}

function writePackageVersion(version: string, toolBody: string): void {
  mkdirSync(join(repoDir, 'tools'), { recursive: true })
  writeFileSync(
    join(repoDir, 'tools', 'fixture_tool.ts'),
    `import type { ToolDefinition } from '#core/agent-config.js'\n\nexport const fixtureTool: ToolDefinition = {\n  name: 'fixture_tool',\n  description: 'A fixture tool',\n  input_schema: { type: 'object', properties: {} },\n  execute: async () => '${toolBody}',\n}\n`,
  )
  writeFileSync(
    join(repoDir, 'loopengine.package.json'),
    JSON.stringify({ name: 'fixture-git-package', version, loopengineVersion: '*', tools: ['tools/fixture_tool.ts'] }, null, 2),
  )
  writeFileSync(join(repoDir, 'package.json'), JSON.stringify({ name: 'fixture-git-package', version }, null, 2))
}

describe('upgradePackage against a real git-spec install', () => {
  it('upgrades cleanly instead of failing on a malformed "<ref>@<version>" git spec', async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'loopengine-git-fixture-'))
    git('init', '-q')
    git('config', 'user.email', 'test@test.com')
    git('config', 'user.name', 'test')

    writePackageVersion('1.0.0', 'v1-result')
    git('add', '.')
    git('commit', '-q', '-m', 'v1')
    git('tag', 'v1.0.0')

    const v1Spec = `git+file://${repoDir}#v1.0.0`
    await installPackage(AGENT_NAME, v1Spec, {})

    writePackageVersion('1.1.0', 'v2-result')
    git('add', '.')
    git('commit', '-q', '-m', 'v2')
    git('tag', 'v1.1.0')

    const v2Spec = `git+file://${repoDir}#v1.1.0`
    const { files } = await upgradePackage(AGENT_NAME, 'fixture-git-package', { spec: v2Spec })

    expect(files.find((f) => f.path === 'tools/fixture_tool.ts')?.status).toBe('updated')
    expect(readFileSync(join(AGENT_DIR, 'tools', 'fixture_tool.ts'), 'utf8')).toContain('v2-result')
  }, 30000)
})
