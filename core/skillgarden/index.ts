// Formerly the standalone `skillgarden` package — folded in here since
// the standalone CLI (`npx skillgarden add`) was its only real
// independent use, and `loopengine add-skill` (bin/cli.ts) now covers
// that directly by calling addSkill() below in-process, the same way
// web/skillgarden-admin.ts's own Admin UI route already did before this
// move. `SKILL.md` discovery/loading/budgeting: a lightweight
// name+description index loads at startup capped to a token budget, and
// the full body loads lazily only when a skill is actually invoked.
export * from './types.js'
export * from './frontmatter.js'
export * from './discovery.js'
export * from './budget.js'
export * from './substitute.js'
export * from './activation.js'
export { SkillGarden } from './loader.js'
export type { SkillGardenOptions } from './loader.js'
export { addSkill } from './add-skill.js'
export type { AddSkillOptions, AddSkillResult } from './add-skill.js'
