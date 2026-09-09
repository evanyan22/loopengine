/** Deliberately loose — real skill authors' frontmatter always has fields
 * we haven't modeled yet, so the parser must not reject unknown keys. */
export interface SkillFrontmatter {
  name: string
  description: string
  paths?: string[]
  [key: string]: unknown
}

export interface SkillIndexEntry {
  /** Namespaced name — nested dirs join with ':', e.g. "deploy:web". */
  name: string
  description: string
  filePath: string
  estimatedTokens: number
}

export interface LoadedSkill {
  name: string
  description: string
  /** Markdown body with the frontmatter block stripped. */
  body: string
  frontmatter: SkillFrontmatter
  filePath: string
}
