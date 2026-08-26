#!/usr/bin/env node
// The `loopengine` bin. add-agent/add-subagent generate the
// agents/<name>/index.ts boilerplate the folder convention expects (see
// agent-config.ts's own doc comments, or the README's "Define your first
// agent"), so using that convention doesn't mean memorizing its shape
// and hand-writing it every time. run/serve/dev are shorter muscle-
// memory commands for what a scaffolded project's own adapters/cli.ts
// and adapters/http.ts already do — see runTsx's own doc comment for why
// these stay thin wrappers around those files rather than a built-in
// runner/server this package hides inside itself.
import { realpathSync } from 'node:fs'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
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
 * loadSubagentAsTools wraps this config with agentAsTool, which throws
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
 * loadSubagentAsTools auto-discovers, so this subagent becomes one of
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

/** Runs `tsx <args>` in the current project (process.cwd()) — via `npx`,
 * not a bundled copy, so it resolves *that project's own*
 * node_modules/.bin/tsx (the version create-loopengine's own template
 * package.json pins), the same binary "npm run dev"/"npm run cli"
 * already invoke there. Inherits stdio so a REPL-like session, streamed
 * SSE-style logs, or Ctrl+C all behave exactly like running the tsx
 * command by hand — this is that command, just shorter to type. Resolves
 * with the child's own exit code (1 if the process couldn't even start)
 * rather than throwing, so `loopengine run <agent>`'s own exit code
 * mirrors adapters/cli.ts's, not this wrapper's. */
function runTsx(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', ...args], { cwd: process.cwd(), stdio: 'inherit' })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

/** run/serve/dev all delegate to a file the *project* owns (created by
 * create-loopengine's own scaffold — see its template/adapters/), not
 * one loopengine bundles — so a project that deleted or never had that
 * file needs a clear, actionable error here, not tsx's own generic
 * "cannot find module" a few layers down. */
async function requireAdapterFile(relPath: string): Promise<boolean> {
  if (await pathExists(path.join(process.cwd(), relPath))) return true
  console.error(`${relPath} not found in this project.`)
  console.error('Run "npx create-loopengine@latest" to scaffold one, or add your own at that path.')
  process.exitCode = 1
  return false
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

  // One-shot: sends one message, prints the reply, exits — exactly
  // adapters/cli.ts's own contract (see its own header comment), not a
  // REPL. `rest` after `<agent>` is forwarded through as-is (--session,
  // the message, and any future flag that file grows), so this wrapper
  // never needs to change in step with adapters/cli.ts's own arg parsing
  // — except --input, which is this wrapper's own convenience flag, not
  // adapters/cli.ts's: that file only understands --agent/--session plus
  // one trailing positional message (see its own parseArgs, which joins
  // every non-flag arg back into one string), so --input's value is
  // translated into that positional form before forwarding, rather than
  // taught to adapters/cli.ts itself. Exists for callers building the
  // arg list programmatically, where getting a trailing positional's
  // exact position right (after --session, after --agent, ...) is easy
  // to get wrong; an explicit flag has no position to get wrong.
  if (command === 'run') {
    const [agent, ...forward] = rest
    if (!agent) {
      console.error('Usage: loopengine run <agent> [--session <id>] "<message>"')
      console.error('       loopengine run <agent> [--session <id>] --input "<message>"')
      process.exitCode = 1
      return
    }
    if (!(await requireAdapterFile('adapters/cli.ts'))) return

    let finalArgs = forward
    const inputIndex = forward.indexOf('--input')
    if (inputIndex !== -1) {
      const message = forward[inputIndex + 1]
      if (message === undefined) {
        console.error('--input requires a value.')
        process.exitCode = 1
        return
      }
      finalArgs = [...forward.slice(0, inputIndex), ...forward.slice(inputIndex + 2), message]
    }

    process.exitCode = await runTsx(['--env-file-if-exists=.env', 'adapters/cli.ts', '--agent', agent, ...finalArgs])
    return
  }

  // Serves every registered agent at once (adapters/http.ts has no
  // notion of "just one agent") — same command the create-loopengine
  // template's own "npm run dev" script already runs, see runTsx's own
  // doc comment.
  if (command === 'serve') {
    if (!(await requireAdapterFile('adapters/http.ts'))) return
    process.exitCode = await runTsx(['--env-file-if-exists=.env', 'adapters/http.ts', ...rest])
    return
  }

  // Same server as `serve`, via `tsx watch` instead of plain `tsx` — tsx
  // itself doesn't hot-reload by default (see playground.ts's own dev
  // instructions in the README, which use plain tsx), so without this,
  // editing an agent's tools/rules/skills mid-session would need a
  // manual restart to take effect. gateway-tools.yml/actauth.yml already
  // read fresh off disk every call regardless (no restart needed for
  // those even under plain `serve`) — this is for the TS source itself:
  // a new tool file, an edited AgentConfig, ...
  if (command === 'dev') {
    if (!(await requireAdapterFile('adapters/http.ts'))) return
    process.exitCode = await runTsx(['watch', '--env-file-if-exists=.env', 'adapters/http.ts', ...rest])
    return
  }

  console.error('Usage: loopengine add-agent <name>')
  console.error('       loopengine add-subagent <parent> <name>')
  console.error('       loopengine run <agent> [--session <id>] "<message>"')
  console.error('       loopengine serve')
  console.error('       loopengine dev')
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
