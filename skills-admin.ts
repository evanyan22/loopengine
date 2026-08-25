// Lets an operator add, edit, or remove a skill from the Skills tab in
// /agents/config, instead of hand-writing agents/<name>/skills/<id>/
// SKILL.md directly. Deliberately scoped to *flat* skills only — a
// nested skill (e.g. agents/<name>/skills/deploy/web/SKILL.md, which
// SkillGarden's own discoverSkillFiles namespaces as 'deploy:web') isn't
// addressable through this admin surface; its id would need to carry a
// '/' through a single URL path segment, which either means encoding
// tricks or a second routing scheme, for a nesting feature nothing in
// this repo's own example agents actually uses. Read-only display of a
// nested skill (via describeAgent's own skills list) still works fine —
// only adding/editing/removing one through this UI is out of scope.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseSkillFile } from 'skillgarden'
import { agentDir } from './gateway-tools.js'

export class SkillInvalidIdError extends Error {}
export class SkillNotFoundError extends Error {}

// Same character set agent/subagent names are already validated against
// elsewhere in this repo (cli.ts's NAME_PATTERN) — a skill id becomes a
// directory name on disk, so this is what keeps it from ever containing
// '/', '..', or anything else that could resolve outside its own
// skills/ folder.
const SKILL_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

function requireValidSkillId(skillId: string): void {
  if (!SKILL_ID_PATTERN.test(skillId)) {
    throw new SkillInvalidIdError(
      `Invalid skill id '${skillId}' — must be lowercase, alphanumeric, hyphen-separated (e.g. "summarize-files"); nested skills aren't editable through this admin UI.`,
    )
  }
}

function skillsDir(agentName: string): string {
  return join(agentDir(agentName), 'skills')
}

function skillFilePath(agentName: string, skillId: string): string {
  requireValidSkillId(skillId)
  return join(skillsDir(agentName), skillId, 'SKILL.md')
}

export interface SkillContent {
  id: string
  description: string
  body: string
}

export function readSkill(agentName: string, skillId: string): SkillContent {
  const path = skillFilePath(agentName, skillId)
  if (!existsSync(path)) {
    throw new SkillNotFoundError(`No skill '${skillId}' for '${agentName}'.`)
  }
  const { frontmatter, body } = parseSkillFile(readFileSync(path, 'utf8'), skillId)
  return { id: skillId, description: frontmatter.description ?? '', body }
}

/** Creates the skill if `skillId` doesn't exist yet, or overwrites it in
 * place if it does — same "this is the new content, not a diff to
 * merge" semantics as a PUT. Frontmatter is regenerated from `skillId`
 * (as `name`) and `description`; any *other* frontmatter keys a skill
 * might have (e.g. `paths` — see SkillFrontmatter's own doc comment) are
 * intentionally not preserved here, since this admin UI has no field for
 * them. A skill that needs those is still editable by hand — this just
 * isn't the tool for it. */
export function writeSkill(agentName: string, skillId: string, content: { description: string; body: string }): void {
  const path = skillFilePath(agentName, skillId)
  const description = content.description.replace(/\n/g, ' ').trim()
  const frontmatter = `---\nname: ${skillId}\ndescription: ${JSON.stringify(description)}\n---\n\n`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, frontmatter + content.body.trim() + '\n')
}

export function deleteSkill(agentName: string, skillId: string): void {
  const path = skillFilePath(agentName, skillId)
  if (!existsSync(path)) {
    throw new SkillNotFoundError(`No skill '${skillId}' for '${agentName}'.`)
  }
  rmSync(dirname(path), { recursive: true, force: true })
}
