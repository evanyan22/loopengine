#!/usr/bin/env node
// The `loopengine` bin — distinct from adapters/cli.ts, which runs an
// agent, not scaffolds one. Generates the agents/<name>/index.ts
// boilerplate the folder convention expects (see agent-config.ts's own
// doc comments, or the README's "Define your first agent"), so using
// that convention doesn't mean memorizing its shape and hand-writing it
// every time.
import { realpathSync } from 'node:fs'
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export class AgentNameError extends Error {}
export class AgentExistsError extends Error {}
export class AgentNotFoundError extends Error {}

export function agentIndexTemplate(name: string): string {
  return `import type { AgentConfig } from 'loopengine'

export const config: AgentConfig = {
  name: '${name}',
  systemPrompt: 'You are ...',
  model: { provider: 'anthropic', model: 'claude-sonnet-5' }, // reads ANTHROPIC_API_KEY
}
`
}

/** Same shape as agentIndexTemplate, plus `toolDescription` — the one
 * field a subagent needs that a top-level agent doesn't. run-agent.ts's
 * loadSubagentTools wraps this config with agentAsTool, which throws
 * without a real toolDescription: it's what the parent agent's model
 * reads to decide when to delegate here, and systemPrompt (instructions
 * for this agent itself) isn't a substitute. See agent-as-tool.ts. */
export function subagentIndexTemplate(name: string): string {
  return `import type { AgentConfig } from 'loopengine'

export const config: AgentConfig = {
  name: '${name}',
  systemPrompt: 'You are ...',
  toolDescription: 'Call this when ...',
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

/** Resolves `parent` — a single agent name, or a `/`-joined path of
 * names for nesting more than one level deep (e.g.
 * "support-orchestrator/billing-agent" to scaffold a subagent under an
 * *existing subagent*) — to the real directory that agent's index.ts
 * lives in: agents/<seg0>/subagents/<seg1>/subagents/<seg2>/... Every
 * segment gets the same lowercase-hyphen validation a plain agent name
 * does; there's no separate "path" naming rule. */
function resolveParentDir(baseDir: string, parent: string): string {
  const segments = parent.split('/')
  for (const segment of segments) {
    if (!NAME_PATTERN.test(segment)) {
      throw new AgentNameError(
        `Parent must be a lowercase, alphanumeric, hyphen-separated agent name, or several joined by '/' for nesting (e.g. "support-orchestrator/billing-agent") — got "${parent}"`,
      )
    }
  }
  return segments.slice(1).reduce((dir, segment) => path.join(dir, 'subagents', segment), path.join(baseDir, 'agents', segments[0]))
}

/** Writes <parentDir>/subagents/<name>/index.ts under baseDir and
 * returns its path, where <parentDir> is `parent` resolved by
 * resolveParentDir — the folder convention run-agent.ts's
 * loadSubagentTools auto-discovers, so this subagent becomes one of
 * `parent`'s tools with no further edits: no import, no
 * AgentConfig.tools entry, nothing to register by hand. Requires
 * `parent` to already exist (its own index.ts) — a subagent without a
 * parent to nest under is just a regular top-level agent, which
 * scaffoldAgent already covers. Nesting more than one level is just
 * `parent` itself being a path — see resolveParentDir. */
export async function scaffoldSubagent(baseDir: string, parent: string, name: string): Promise<string> {
  const parentDir = resolveParentDir(baseDir, parent)
  if (!NAME_PATTERN.test(name)) {
    throw new AgentNameError(`Subagent name must be lowercase, alphanumeric, hyphen-separated (e.g. "billing-agent") — got "${name}"`)
  }

  const parentIndexPath = path.join(parentDir, 'index.ts')
  if (!(await pathExists(parentIndexPath))) {
    throw new AgentNotFoundError(`'${parent}' doesn't exist yet (expected ${parentIndexPath}) — create it first.`)
  }

  const dir = path.join(parentDir, 'subagents', name)
  const indexPath = path.join(dir, 'index.ts')

  if (await pathExists(indexPath)) {
    throw new AgentExistsError(`A subagent named '${name}' already exists under '${parent}' (${indexPath}) — pick a different name or edit it directly.`)
  }

  await mkdir(dir, { recursive: true })
  await writeFile(indexPath, subagentIndexTemplate(name))
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
  const [, , command, ...rest] = process.argv

  if (command === 'add-agent') {
    const [name] = rest
    if (!name) {
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
    return
  }

  if (command === 'add-subagent') {
    const [parent, name] = rest
    if (!parent || !name) {
      console.error('Usage: loopengine add-subagent <parent> <name>')
      console.error('       <parent> can be a single agent name, or several joined by \'/\' to nest deeper (e.g. "support-orchestrator/billing-agent")')
      process.exitCode = 1
      return
    }

    let indexPath: string
    try {
      indexPath = await scaffoldSubagent(process.cwd(), parent, name)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exitCode = 1
      return
    }

    console.log(`Created ${path.relative(process.cwd(), indexPath)}`)
    console.log()
    console.log(`Auto-registered as a tool on '${parent}' — no import, no tools array edit needed.`)
    console.log(`Fill in toolDescription: it's what '${parent}'s model reads to decide when to call '${name}'.`)
    console.log()
    console.log(`Run the top-level agent: npx tsx adapters/cli.ts --agent ${parent.split('/')[0]} "hello"`)
    return
  }

  console.error('Usage: loopengine add-agent <name>')
  console.error('       loopengine add-subagent <parent> <name>')
  process.exitCode = 1
}

// A package-manager shim (npx, node_modules/.bin) invokes this file
// through a symlink, not its real path — process.argv[1] is the
// symlink's path, while Node resolves import.meta.url to the real path
// when loading an ES module. Comparing the raw argv[1] against the
// resolved module URL fails in exactly that case and main() silently
// never runs — realpath argv[1] first so both sides are resolved. (Same
// bug, same fix, as create-loopengine's own cli.ts — see its git history
// for the live symlink repro, and skillgarden's CLI before that.)
function isMain(): boolean {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}
if (isMain()) main()
