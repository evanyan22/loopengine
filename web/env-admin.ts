// Backs the Admin UI's "Environment" section — every env var a package
// (see PACKAGES.md, bin/package-manager.ts) declared as required,
// across every package installed for an agent, with set/not-set status
// only. A value marked `secret` is never echoed back once set — same
// never-echo-a-secret rule web/http-tool-admin.ts's own `{{ENV_VAR}}`
// header handling already establishes for a tool's own secrets.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir } from '../core/gateway-tools.js'
import type { InstalledPackageRecord } from '../bin/package-manager.js'

export class EnvVarNameError extends Error {}

// Same shape web/http-tool-admin.ts's own ENV_VAR_PATTERN already
// validates a {{ENV_VAR}} header reference against.
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/

export interface DeclaredEnvVar {
  name: string
  description?: string
  secret: boolean
  packageName: string
  set: boolean
}

function provenancePath(agentName: string): string {
  return join(agentDir(agentName), '.loopengine-packages.json')
}

/** Every env var any package installed for `agentName` declared it
 * needs, deduplicated by name — PACKAGES.md's own open question on
 * cross-package name collisions applies here too (one .env per
 * *project*, not per agent, so two unrelated packages declaring the
 * same name can't actually be told apart; the first one seen wins the
 * description shown). `set` is read live off `process.env`, not cached,
 * so it reflects whatever the last `setEnvVar` call — or a plain
 * restart picking up `.env` — actually did. */
export function listDeclaredEnvVars(agentName: string): DeclaredEnvVar[] {
  const path = provenancePath(agentName)
  if (!existsSync(path)) return []

  const provenance = JSON.parse(readFileSync(path, 'utf8')) as Record<string, InstalledPackageRecord>
  const seen = new Set<string>()
  const result: DeclaredEnvVar[] = []
  for (const [packageName, record] of Object.entries(provenance)) {
    for (const decl of record.env) {
      if (seen.has(decl.name)) continue
      seen.add(decl.name)
      result.push({
        name: decl.name,
        description: decl.description,
        secret: decl.secret === true,
        packageName,
        set: process.env[decl.name] !== undefined,
      })
    }
  }
  return result
}

// process.cwd(), matching exactly where bin/cli.ts's own runTsx passes
// --env-file-if-exists=.env (Node's own --env-file resolves relative to
// cwd too) — not core/agent-registry.ts's projectDir(), which resolves
// relative to *that compiled file's own location* and would point at
// node_modules/loopengine/dist/ in a real scaffolded project, not the
// project's own root where .env actually lives.
function envFilePath(): string {
  return join(process.cwd(), '.env')
}

// Node's own --env-file parser (what bin/cli.ts's runTsx already passes
// as --env-file-if-exists=.env) double-quotes a value containing
// whitespace, '#', or a quote character — matched here so a value this
// function writes reads back identically, not reinterpreted as a
// comment or truncated at the first space.
function serializeEnvValue(value: string): string {
  if (!/[\s#"'\\]/.test(value) && value !== '') return value
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Upserts `NAME=VALUE` into the project's `.env` file — preserving
 * every other line (comments, blank lines, unrelated keys) — and
 * applies it to *this* running process immediately via `process.env`,
 * so a newly-installed package's tools work without a restart. Callers
 * (the PUT route in adapters/http.ts) are responsible for refusing to
 * call this at all when `LOOPENGINE_ADMIN_AUTH` isn't set — this
 * function itself has no notion of HTTP auth, it just writes. */
export function setEnvVar(name: string, value: string): void {
  if (!ENV_VAR_NAME_PATTERN.test(name)) {
    throw new EnvVarNameError(`"${name}" isn't a valid env var name (uppercase letters, digits, underscore, not starting with a digit).`)
  }

  const path = envFilePath()
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  const newLine = `${name}=${serializeEnvValue(value)}`

  const existingIndex = lines.findIndex((line) => line.startsWith(`${name}=`))
  if (existingIndex === -1) {
    // Drop a single trailing blank line (from the file's own final
    // newline splitting into an empty last element) before appending,
    // so this doesn't accumulate a growing gap of blank lines across
    // repeated calls.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    lines.push(newLine)
  } else {
    lines[existingIndex] = newLine
  }

  writeFileSync(path, lines.join('\n') + '\n')
  process.env[name] = value
}
