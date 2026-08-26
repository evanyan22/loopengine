import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
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

// run/serve/dev delegate to the *project's* own adapters/cli.ts and
// adapters/http.ts (create-loopengine's own scaffold — see cli.ts's own
// header comment) via a real `npx tsx` subprocess, not something
// importable/mockable directly — so these are exercised the same way as
// the symlink test below, running the real cli.ts source against a real
// tmp cwd. `dev` only gets its error-path tested here, not a full happy
// path: it runs via `tsx watch`, which never exits on its own, so an
// execFileSync-based happy-path test would just hang.
describe('main() run/serve/dev', () => {
  function runCli(args: string[], cwd: string): { status: number; output: string } {
    try {
      return { status: 0, output: execFileSync('npx', ['tsx', cliSourcePath, ...args], { encoding: 'utf8', cwd }) }
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string }
      return { status: e.status, output: e.stdout + e.stderr }
    }
  }

  it('run without an agent name prints usage and fails, before ever looking for adapters/cli.ts', () => {
    const { status, output } = runCli(['run'], tmpDir())
    expect(status).toBe(1)
    expect(output).toContain('Usage: loopengine run <agent>')
  })

  it('run fails with a clear error when the project has no adapters/cli.ts', () => {
    const { status, output } = runCli(['run', 'weather-agent', 'hi'], tmpDir())
    expect(status).toBe(1)
    expect(output).toContain('adapters/cli.ts not found in this project.')
    expect(output).toContain('create-loopengine')
  })

  it('run forwards --agent, --session, and the message through to the project’s own adapters/cli.ts', () => {
    const dir = tmpDir()
    mkdirSync(join(dir, 'adapters'), { recursive: true })
    writeFileSync(join(dir, 'adapters', 'cli.ts'), 'console.log("ran:", process.argv.slice(2).join(" "))')

    const { status, output } = runCli(['run', 'weather-agent', '--session', 's1', 'hello there'], dir)

    expect(status).toBe(0)
    expect(output).toContain('ran: --agent weather-agent --session s1 hello there')
  })

  it('run --input "<message>" translates into adapters/cli.ts’s own trailing-positional message convention', () => {
    const dir = tmpDir()
    mkdirSync(join(dir, 'adapters'), { recursive: true })
    writeFileSync(join(dir, 'adapters', 'cli.ts'), 'console.log("ran:", process.argv.slice(2).join(" "))')

    const { status, output } = runCli(['run', 'weather-agent', '--session', 's1', '--input', 'hello there'], dir)

    expect(status).toBe(0)
    expect(output).toContain('ran: --agent weather-agent --session s1 hello there')
  })

  it('run --input fails with a clear error when given no value', () => {
    const dir = tmpDir()
    mkdirSync(join(dir, 'adapters'), { recursive: true })
    writeFileSync(join(dir, 'adapters', 'cli.ts'), 'console.log("should not run")')

    const { status, output } = runCli(['run', 'weather-agent', '--input'], dir)

    expect(status).toBe(1)
    expect(output).toContain('--input requires a value.')
  })

  it('serve fails with a clear error when the project has no adapters/http.ts', () => {
    const { status, output } = runCli(['serve'], tmpDir())
    expect(status).toBe(1)
    expect(output).toContain('adapters/http.ts not found in this project.')
  })

  it('serve runs the project’s own adapters/http.ts', () => {
    const dir = tmpDir()
    mkdirSync(join(dir, 'adapters'), { recursive: true })
    writeFileSync(join(dir, 'adapters', 'http.ts'), 'console.log("serving")')

    const { status, output } = runCli(['serve'], dir)

    expect(status).toBe(0)
    expect(output).toContain('serving')
  })

  it('dev fails with a clear error when the project has no adapters/http.ts', () => {
    const { status, output } = runCli(['dev'], tmpDir())
    expect(status).toBe(1)
    expect(output).toContain('adapters/http.ts not found in this project.')
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
