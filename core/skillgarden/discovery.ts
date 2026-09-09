import { type Dirent, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

export interface DiscoveredSkillFile {
  /** Namespaced name — nested dirs join with ':', e.g. "deploy:web". */
  namespacedName: string
  filePath: string
}

/** Walks a root directory for nested `SKILL.md` files. A directory containing
 * SKILL.md is treated as one skill and not walked further — supporting
 * files live alongside it, not nested skills. Nesting depth becomes the
 * namespace: `deploy/web/SKILL.md` under root `skills/` becomes
 * `deploy:web`, matching Claude Code's own namespacing convention. */
export function discoverSkillFiles(rootDir: string): DiscoveredSkillFile[] {
  const results: DiscoveredSkillFile[] = []

  function walk(dir: string): void {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      const skillFile = join(full, 'SKILL.md')

      let hasSkillFile = false
      try {
        hasSkillFile = statSync(skillFile).isFile()
      } catch {
        hasSkillFile = false
      }

      if (hasSkillFile) {
        const namespacedName = relative(rootDir, full).split(sep).join(':')
        results.push({ namespacedName, filePath: skillFile })
        continue
      }

      walk(full)
    }
  }

  walk(rootDir)
  return results
}
