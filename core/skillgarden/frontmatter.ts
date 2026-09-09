import { parse as parseYaml } from 'yaml'
import type { SkillFrontmatter } from './types.js'

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/** Parses a SKILL.md file. Frontmatter is optional and malformed YAML
 * doesn't throw — a bad skill file should never break discovery of every
 * other skill. Missing `name`/`description` fall back to the directory
 * name and the first markdown heading, matching how authors actually
 * write these files in practice. */
export function parseSkillFile(raw: string, fallbackName: string): { frontmatter: SkillFrontmatter; body: string } {
  const match = raw.match(FRONTMATTER_RE)
  let frontmatterRaw = ''
  let body = raw

  if (match) {
    frontmatterRaw = match[1] ?? ''
    body = match[2] ?? ''
  }

  let parsed: Record<string, unknown> = {}
  if (frontmatterRaw.trim()) {
    try {
      parsed = (parseYaml(frontmatterRaw) as Record<string, unknown>) ?? {}
    } catch {
      parsed = {}
    }
  }

  const name = typeof parsed.name === 'string' ? parsed.name : fallbackName
  const description = typeof parsed.description === 'string' ? parsed.description : (extractFirstHeading(body) ?? name)

  return {
    frontmatter: { ...parsed, name, description } as SkillFrontmatter,
    body: body.trim(),
  }
}

function extractFirstHeading(markdown: string): string | undefined {
  const match = markdown.match(/^#\s+(.+)$/m)
  return match?.[1]?.trim()
}
