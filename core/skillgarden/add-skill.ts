import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Bundled skill packages ship in core/skill-registry/, a sibling of
 * core/skillgarden/ — plain data, not TypeScript source, so it's copied
 * verbatim into dist/ by the build script (see package.json's own build
 * script and system-skills' identical treatment) rather than compiled. */
const DEFAULT_REGISTRY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skill-registry')

export interface AddSkillOptions {
  skill: string
  /** Omit for a flat install with no per-agent namespacing (see skillsDir's own doc comment). */
  agent?: string
  skillsDir?: string
  registryDir?: string
  force?: boolean
}

export interface AddSkillResult {
  namespacedName: string
  destination: string
}

function listCategories(registryDir: string): string[] {
  try {
    return readdirSync(registryDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
  } catch {
    return []
  }
}

/** Every bundled skill, as `<category>/<skill>` — the registry's own
 * on-disk shape (`registry/<category>/<skill>/SKILL.md`), one level of
 * category folders deep. Used only for the "Unknown skill" hint below;
 * resolveSkillSource is what actually looks one up. */
function listAvailableSkills(registryDir: string): string[] {
  const result: string[] = []
  for (const category of listCategories(registryDir)) {
    const categoryDir = join(registryDir, category)
    let skills: string[]
    try {
      skills = readdirSync(categoryDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      continue
    }
    for (const skill of skills) result.push(`${category}/${skill}`)
  }
  return result.sort()
}

function unknownSkillError(registryDir: string, skillArg: string): Error {
  const available = listAvailableSkills(registryDir)
  const hint = available.length > 0 ? ` Available: ${available.join(', ')}.` : ''
  return new Error(`Unknown skill "${skillArg}".${hint}`)
}

/** Resolves a CLI skill argument to a real `registry/<category>/<skill>/`
 * directory. Two forms:
 *  - explicit `category/skill` — looked up directly, the same shape
 *    `listAvailableSkills` above already reports skills in.
 *  - a bare skill name — searched across every category, since most
 *    callers don't care which category a skill they already know the
 *    name of lives under (the flat lookup this CLI had before categories
 *    existed at all). Ambiguous only if the same skill name exists under
 *    more than one category, which none of the bundled skills do today;
 *    the error asks the caller to disambiguate with the explicit form
 *    rather than silently picking one.
 * The `skill` this returns is always the bare name — used for the
 * installed destination folder and the namespacedName below, both of
 * which stay unqualified by category (see addSkill's own doc comment for
 * why: category is a registry-organization concept, not something forced
 * onto a caller's own skills/ folder once copied there). */
function resolveSkillSource(registryDir: string, skillArg: string): { skill: string; sourceDir: string } {
  const slash = skillArg.indexOf('/')
  if (slash !== -1) {
    const category = skillArg.slice(0, slash)
    const skill = skillArg.slice(slash + 1)
    const sourceDir = join(registryDir, category, skill)
    if (!existsSync(join(sourceDir, 'SKILL.md'))) throw unknownSkillError(registryDir, skillArg)
    return { skill, sourceDir }
  }

  const matches = listCategories(registryDir).filter((category) => existsSync(join(registryDir, category, skillArg, 'SKILL.md')))
  if (matches.length === 0) throw unknownSkillError(registryDir, skillArg)
  if (matches.length > 1) {
    const options = matches.map((category) => `${category}/${skillArg}`)
    throw new Error(`"${skillArg}" exists in more than one category: ${options.join(', ')}. Specify which one, e.g. "${options[0]}".`)
  }
  return { skill: skillArg, sourceDir: join(registryDir, matches[0], skillArg) }
}

/** Copies a bundled skill package into `<skillsDir>/<skill>/` — or
 * `<skillsDir>/<agent>/<skill>/` when `--dir` is given explicitly
 * alongside `--agent` (the shared-root pattern: one registry root, many
 * agents' skills namespaced by subfolder, matching the `agent:skill`
 * namespace `discoverSkillFiles` derives from that nesting).
 *
 * With no explicit `skillsDir`, the default already encodes the agent in
 * the path instead: `agents/<agent>/skills`, matching a per-agent
 * `agents/<name>/skills/` folder (loopengine's own convention) — nesting
 * `<agent>/` under that too would produce a redundant
 * `agents/<agent>/skills/<agent>/<skill>`, so it's skipped in that case.
 * With no `--agent` at all, the default is the flat `skills/` root.
 *
 * `options.skill` may be a bare skill name or an explicit `category/skill`
 * (see resolveSkillSource above) — either way, the *installed* copy is
 * always named after the bare skill alone, never category-qualified.
 * Category is how this repo organizes its own bundled registry; once a
 * skill is copied into a caller's own skills/ folder it's theirs to
 * organize however they like, the same "don't force a naming scheme onto
 * what a caller now owns" reasoning behind not renaming SKILL.md files or
 * imposing folder conventions elsewhere in this module. */
export function addSkill(options: AddSkillOptions): AddSkillResult {
  const { agent } = options
  const usingExplicitDir = options.skillsDir !== undefined
  const skillsDir = options.skillsDir ?? (agent ? join('agents', agent, 'skills') : 'skills')
  const registryDir = options.registryDir ?? DEFAULT_REGISTRY_DIR

  const { skill, sourceDir } = resolveSkillSource(registryDir, options.skill)

  const destination = agent && usingExplicitDir ? join(skillsDir, agent, skill) : join(skillsDir, skill)
  if (existsSync(destination)) {
    if (!options.force) {
      throw new Error(`${destination} already exists — pass --force to overwrite.`)
    }
    rmSync(destination, { recursive: true, force: true })
  }

  mkdirSync(dirname(destination), { recursive: true })
  cpSync(sourceDir, destination, { recursive: true })

  return { namespacedName: agent ? `${agent}:${skill}` : skill, destination }
}
