// Formerly the standalone `skillgarden` package — folded into loopengine
// core since it had no consumer besides loopengine itself.
// `SKILL.md` discovery/loading/budgeting: a lightweight name+description
// index loads at startup capped to a token budget, and the full body
// loads lazily only when a skill is actually invoked.
export * from './types.js'
export * from './frontmatter.js'
export * from './discovery.js'
export * from './budget.js'
export * from './substitute.js'
export * from './activation.js'
export { SkillGarden } from './loader.js'
export type { SkillGardenOptions } from './loader.js'
