import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentExistsError, AgentNameError, scaffoldAgent } from '../cli.js'

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
