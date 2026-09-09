// Lets an operator browse skillgarden's own bundled skill registry from
// the Skills tab in /agents/config, and add one straight into an agent's
// agents/<name>/skills/ folder — a shortcut for the same thing
// `npx loopengine add-skill <skill> --agent <name>` already does from a
// terminal, surfaced in the UI instead. This module only ever *reads*
// the registry and delegates the actual copy to core/skillgarden's own
// exported `addSkill` (see below) — it never re-implements that logic.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SkillGarden, addSkill as skillgardenAddSkill } from '../core/skillgarden/index.js'

export interface SkillgardenCatalogEntry {
  category: string
  id: string
  description: string
}

export interface SkillgardenCatalogDetail extends SkillgardenCatalogEntry {
  body: string
}

// core/skillgarden/add-skill.ts resolves its own DEFAULT_REGISTRY_DIR
// the same way (relative to its own compiled location) but doesn't
// export that path — addSkill itself defaults to it internally, which
// is enough for *installing* a skill, but browsing/previewing the
// catalog needs the directory path itself. Re-derived here relative to
// *this* file's own compiled location instead — core/skill-registry is
// vendored in this repo now, not a separate npm dependency, so there's
// no package.json to resolve through anymore.
function registryDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'skill-registry')
}

// A large, fixed budget, not run-agent.ts's own live skillIndexBudgetTokens
// default — this indexes a small, fixed, bundled catalog for browsing,
// not an agent's own live context, so nothing here should ever silently
// truncate the list an operator sees.
const CATALOG_INDEX_BUDGET_TOKENS = 1_000_000

// discoverSkillFiles namespaces registry/<category>/<skill>/SKILL.md as
// "<category>:<skill>" (colon-joined, one level of nesting) — split on
// just the first colon, not skillId itself, in case a future entry ever
// nests deeper than one category level.
function splitNamespacedName(namespacedName: string): { category: string; id: string } {
  const colon = namespacedName.indexOf(':')
  return { category: namespacedName.slice(0, colon), id: namespacedName.slice(colon + 1) }
}

function catalogGarden(): SkillGarden {
  return new SkillGarden({ dirs: [registryDir()], indexBudgetTokens: CATALOG_INDEX_BUDGET_TOKENS })
}

export function listSkillgardenCatalog(): SkillgardenCatalogEntry[] {
  const { included } = catalogGarden().buildIndex()
  return included
    .map((entry) => ({ ...splitNamespacedName(entry.name), description: entry.description }))
    .sort((a, b) => (a.category === b.category ? a.id.localeCompare(b.id) : a.category.localeCompare(b.category)))
}

export function readSkillgardenCatalogEntry(category: string, id: string): SkillgardenCatalogDetail {
  const garden = catalogGarden()
  garden.buildIndex()
  // load() throws a plain Error for an unindexed name — same "not found"
  // shape a bad category/id combination should surface as; the caller
  // (adapters/http.ts) maps any throw here to 404, so there's nothing
  // more specific to catch and re-throw.
  const loaded = garden.load(`${category}:${id}`)
  return { category, id, description: loaded.description, body: loaded.body }
}

/** Copies `registry/<category>/<id>/` into `agents/<agentName>/skills/<id>/`
 * — delegates entirely to skillgarden's own `addSkill`, which already
 * knows this exact `agents/<agent>/skills` destination convention (see
 * its own doc comment) and already refuses (or, with `force`,
 * overwrites) an existing destination. Returns the bare skill id actually
 * installed — never category-qualified, matching `addSkill`'s own
 * "category is a registry-organization concept, not forced onto what a
 * caller now owns" convention. */
export function addSkillgardenSkillToAgent(agentName: string, category: string, id: string, force = false): { id: string; path: string } {
  const result = skillgardenAddSkill({ skill: `${category}/${id}`, agent: agentName, registryDir: registryDir(), force })
  return { id, path: join(result.destination, 'SKILL.md') }
}
