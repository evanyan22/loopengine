#!/usr/bin/env node
// The `loopengine` bin — distinct from adapters/cli.ts, which runs an
// agent, not scaffolds one. Generates the agents/<name>/index.ts
// boilerplate the folder convention expects (see agent-config.ts's own
// doc comments, or the README's "Define your first agent"), so using
// that convention doesn't mean memorizing its shape and hand-writing it
// every time.
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export class AgentNameError extends Error {}
export class AgentExistsError extends Error {}

export function agentIndexTemplate(name: string): string {
  return `import type { AgentConfig } from 'loopengine'

export const config: AgentConfig = {
  name: '${name}',
  systemPrompt: 'You are ...',
  model: { provider: 'anthropic', model: 'claude-sonnet-5' }, // reads ANTHROPIC_API_KEY
}
`
}

/** Writes agents/<name>/index.ts under baseDir and returns its path.
 * Only that one file — tools, rules, and skillsDirs are left to their
 * smart defaults (see AgentConfig's own doc comments), the same as the
 * README's own "simplest possible agent" example. */
export async function scaffoldAgent(baseDir: string, name: string): Promise<string> {
  if (!NAME_PATTERN.test(name)) {
    throw new AgentNameError(`Agent name must be lowercase, alphanumeric, hyphen-separated (e.g. "weather-agent") — got "${name}"`)
  }

  const dir = path.join(baseDir, 'agents', name)
  const indexPath = path.join(dir, 'index.ts')

  if (await pathExists(indexPath)) {
    throw new AgentExistsError(`agents/${name}/index.ts already exists — pick a different name or edit it directly.`)
  }

  await mkdir(dir, { recursive: true })
  await writeFile(indexPath, agentIndexTemplate(name))
  return indexPath
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  const [, , command, name] = process.argv

  if (command !== 'add-agent' || !name) {
    console.error('Usage: loopengine add-agent <name>')
    process.exitCode = 1
    return
  }

  try {
    await scaffoldAgent(process.cwd(), name)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
    return
  }

  console.log(`Created agents/${name}/index.ts`)
  console.log()
  console.log('tools, rules, and skillsDirs are all omitted — they default to:')
  console.log(`  agents/${name}/tools/index.ts   (no tools until you add one)`)
  console.log(`  agents/${name}/actauth.yml      (denies every tool until you add one)`)
  console.log(`  agents/${name}/skills/          (no skills until you add one)`)
  console.log()
  console.log(`Run it: npx tsx adapters/cli.ts --agent ${name} "hello"`)
}

// Only run when executed directly — not when scaffoldAgent is imported
// for testing.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
}
