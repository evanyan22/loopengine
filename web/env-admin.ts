// Backs the Admin UI's "Environment" section — every env var an ability
// (see ABILITIES.md, bin/ability-manager.ts) declared as required,
// across every ability installed for an agent, with set/not-set status
// only. A value marked `secret` is never echoed back once set — same
// never-echo-a-secret rule web/http-tool-admin.ts's own `{{ENV_VAR}}`
// header handling already establishes for a tool's own secrets.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir } from '../core/gateway-tools.js'
import type { InstalledAbilityRecord } from '../bin/ability-manager.js'

export class EnvVarNameError extends Error {}

// Same shape web/http-tool-admin.ts's own ENV_VAR_PATTERN already
// validates a {{ENV_VAR}} header reference against.
const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/

export interface DeclaredEnvVar {
  name: string
  description?: string
  secret: boolean
  /** Every ability that declares this name, in install order — usually
   * one, but see listDeclaredEnvVars's own doc comment for why this is
   * an array, not a single name. */
  abilityNames: string[]
  set: boolean
}

function provenancePath(agentName: string): string {
  return join(agentDir(agentName), '.loopengine-abilities.json')
}

/** Every env var any ability installed for `agentName` declared it
 * needs, merged by name. There's one .env per *project*, not per agent
 * or per ability, so this can't actually resolve a genuine cross-ability
 * name collision (two abilities declaring, say, "API_KEY" for two
 * unrelated services still both read whichever single value ends up
 * set — there is no per-ability slot to give them) — unlike a tool or
 * skill name collision (see ability-manager.ts's namespacedToolName/
 * namespacedSkillId), an env var name is a literal `process.env.X`
 * reference baked into the ability's own code, not a label loopengine's
 * own generated glue controls, so there's nothing here to safely rename.
 * What this *can* do, and used to not: surface every ability that
 * declares a given name (`abilityNames`, plural) instead of silently
 * keeping only the first one seen and hiding the rest — turns a
 * collision from invisible into something a human looking at the
 * Environment tab can actually notice and judge (a real conflict
 * needing one ability's own env var renamed, or a coincidence that's
 * actually fine because both intentionally share one real credential).
 * `secret` is true if *any* declaring ability marked it secret — the
 * safer default, since treating a real secret as non-secret because a
 * different ability's own declaration happened to be checked first
 * would be the one direction genuinely worth avoiding. `set` is read
 * live off `process.env`, not cached, so it reflects whatever the last
 * `setEnvVar` call — or a plain restart picking up `.env` — actually
 * did. */
export function listDeclaredEnvVars(agentName: string): DeclaredEnvVar[] {
  const path = provenancePath(agentName)
  if (!existsSync(path)) return []

  const provenance = JSON.parse(readFileSync(path, 'utf8')) as Record<string, InstalledAbilityRecord>
  const byName = new Map<string, DeclaredEnvVar>()
  for (const [abilityName, record] of Object.entries(provenance)) {
    for (const decl of record.env) {
      const existing = byName.get(decl.name)
      if (existing) {
        existing.abilityNames.push(abilityName)
        existing.secret = existing.secret || decl.secret === true
        continue
      }
      byName.set(decl.name, {
        name: decl.name,
        description: decl.description,
        secret: decl.secret === true,
        abilityNames: [abilityName],
        set: process.env[decl.name] !== undefined,
      })
    }
  }
  return [...byName.values()]
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
 * so a newly-installed ability's tools work without a restart. Callers
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
