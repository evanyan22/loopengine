import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentExistsError, AgentNameError, AgentNotFoundError, scaffoldAgent, scaffoldSubagent } from '../cli.js'

const cliSourcePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts')

const dirs: string[] = []
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loopengine-cli-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('scaffoldAgent', () => {
  it('writes agents/<name>/index.ts with a working AgentConfig template', async () => {
    const dir = tmpDir()

    const indexPath = await scaffoldAgent(dir, 'weather-agent')

    expect(indexPath).toBe(join(dir, 'agents', 'weather-agent', 'index.ts'))
    const contents = readFileSync(indexPath, 'utf8')
    expect(contents).toContain("name: 'weather-agent'")
    expect(contents).toContain("import type { AgentConfig } from 'loopengine'")
  })

  it('rejects a name that already has an agent', async () => {
    const dir = tmpDir()
    await scaffoldAgent(dir, 'weather-agent')

    await expect(scaffoldAgent(dir, 'weather-agent')).rejects.toThrow(AgentExistsError)
  })

  it('rejects a name that is not lowercase-hyphenated', async () => {
    const dir = tmpDir()

    await expect(scaffoldAgent(dir, 'WeatherAgent')).rejects.toThrow(AgentNameError)
    await expect(scaffoldAgent(dir, 'weather_agent')).rejects.toThrow(AgentNameError)
  })
})

describe('scaffoldSubagent', () => {
  it('writes agents/<parent>/subagents/<name>/index.ts with toolDescription in the template', async () => {
    const dir = tmpDir()
    await scaffoldAgent(dir, 'support-orchestrator')

    const indexPath = await scaffoldSubagent(dir, 'support-orchestrator', 'billing-agent')

    expect(indexPath).toBe(join(dir, 'agents', 'support-orchestrator', 'subagents', 'billing-agent', 'index.ts'))
    const contents = readFileSync(indexPath, 'utf8')
    expect(contents).toContain("name: 'billing-agent'")
    expect(contents).toContain('toolDescription:')
    expect(contents).toContain("import type { AgentConfig } from 'loopengine'")
  })

  it('rejects when the parent agent does not exist yet', async () => {
    const dir = tmpDir()

    await expect(scaffoldSubagent(dir, 'no-such-parent', 'billing-agent')).rejects.toThrow(AgentNotFoundError)
  })

  it('rejects a subagent name that already exists under that parent', async () => {
    const dir = tmpDir()
    await scaffoldAgent(dir, 'support-orchestrator')
    await scaffoldSubagent(dir, 'support-orchestrator', 'billing-agent')

    await expect(scaffoldSubagent(dir, 'support-orchestrator', 'billing-agent')).rejects.toThrow(AgentExistsError)
  })

  it('rejects a name that is not lowercase-hyphenated', async () => {
    const dir = tmpDir()
    await scaffoldAgent(dir, 'support-orchestrator')

    await expect(scaffoldSubagent(dir, 'support-orchestrator', 'BillingAgent')).rejects.toThrow(AgentNameError)
  })

  it('supports nesting — scaffolding a subagent under another subagent via a `/`-joined parent path', async () => {
    const dir = tmpDir()
    await scaffoldAgent(dir, 'support-orchestrator')
    await scaffoldSubagent(dir, 'support-orchestrator', 'billing-agent')

    const indexPath = await scaffoldSubagent(dir, 'support-orchestrator/billing-agent', 'disputes-agent')

    expect(indexPath).toBe(
      join(dir, 'agents', 'support-orchestrator', 'subagents', 'billing-agent', 'subagents', 'disputes-agent', 'index.ts'),
    )
  })
})

describe('main() invoked through a symlink', () => {
  // A package-manager shim (npx, node_modules/.bin) invokes the CLI
  // through a symlink, not the real file — process.argv[1] is the
  // symlink's path, while Node resolves import.meta.url to the real path
  // when loading an ES module. Comparing the raw argv[1] against the
  // resolved module URL fails in exactly that case and main() silently
  // never runs (exit 0, no output, nothing scaffolded) — this is exactly
  // how a real `npx loopengine add-agent` invocation resolves once
  // installed as a dependency, unlike every other test in this file,
  // which imports scaffoldAgent/scaffoldSubagent directly and never goes
  // through argv/isMain() at all. Same bug/fix as create-loopengine's own
  // cli.ts and skillgarden's CLI before that.
  it('still runs main() and scaffolds an agent', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'loopengine-bin-'))
    const shimPath = join(binDir, 'loopengine')
    symlinkSync(cliSourcePath, shimPath)

    const parent = tmpDir()

    const output = execFileSync('npx', ['tsx', shimPath, 'add-agent', 'weather-agent'], {
      encoding: 'utf8',
      cwd: parent,
    })

    expect(output).toContain('Created agents/weather-agent/index.ts')
    expect(readFileSync(join(parent, 'agents', 'weather-agent', 'index.ts'), 'utf8')).toContain("name: 'weather-agent'")
  })
})
