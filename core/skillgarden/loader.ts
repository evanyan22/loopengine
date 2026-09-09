import { readFileSync } from 'node:fs'
import { matchesActivationPaths } from './activation.js'
import { buildBudgetedIndex, estimateTokens, type BudgetedIndex } from './budget.js'
import { discoverSkillFiles } from './discovery.js'
import { parseSkillFile } from './frontmatter.js'
import { substituteArguments } from './substitute.js'
import type { LoadedSkill, SkillFrontmatter, SkillIndexEntry } from './types.js'

export interface SkillGardenOptions {
  /** Roots to scan for nested `SKILL.md` files. */
  dirs: string[]
  /** Token budget for the always-loaded name+description index. Real
   * agent context windows are large (~100k-200k tokens); Claude Code
   * itself caps this index around 1% of the window, so ~2000 is a
   * reasonable default rather than an arbitrary round number. */
  indexBudgetTokens?: number
}

interface IndexedSkill {
  filePath: string
  frontmatter: SkillFrontmatter
}

/** Phase 1: scan + parse frontmatter only, budget-capped — this is what
 * stays loaded in context at all times. Phase 2 (`load`/`invoke`) reads
 * the full body lazily, only for a skill actually being invoked. */
export class SkillGarden {
  private readonly dirs: string[]
  private readonly indexBudgetTokens: number
  private indexed: Map<string, IndexedSkill> = new Map()

  constructor(options: SkillGardenOptions) {
    this.dirs = options.dirs
    this.indexBudgetTokens = options.indexBudgetTokens ?? 2000
  }

  buildIndex(): BudgetedIndex {
    this.indexed.clear()
    const entries: SkillIndexEntry[] = []

    for (const dir of this.dirs) {
      for (const { namespacedName, filePath } of discoverSkillFiles(dir)) {
        const raw = readFileSync(filePath, 'utf8')
        const { frontmatter } = parseSkillFile(raw, namespacedName)
        this.indexed.set(namespacedName, { filePath, frontmatter })
        entries.push({
          name: namespacedName,
          description: String(frontmatter.description),
          filePath,
          estimatedTokens: estimateTokens(`${namespacedName}: ${frontmatter.description}`),
        })
      }
    }

    return buildBudgetedIndex(entries, { maxTokens: this.indexBudgetTokens })
  }

  /** Full body, read only now — call after buildIndex() has discovered
   * the skill. */
  load(name: string): LoadedSkill {
    const indexed = this.indexed.get(name)
    if (!indexed) {
      throw new Error(`Unknown skill '${name}' — call buildIndex() first, or it wasn't discovered`)
    }
    const raw = readFileSync(indexed.filePath, 'utf8')
    const { frontmatter, body } = parseSkillFile(raw, name)
    return {
      name,
      description: String(frontmatter.description),
      body,
      frontmatter,
      filePath: indexed.filePath,
    }
  }

  /** Load + substitute placeholders, ready to inject into a running
   * conversation. */
  invoke(name: string, args?: string): string {
    const skill = this.load(name)
    return substituteArguments(skill.body, args)
  }

  /** Filters index entries down to skills eligible given files touched
   * so far in the session. Skills with no `paths` restriction are always
   * eligible. */
  eligibleFor(entries: SkillIndexEntry[], touchedPaths: string[]): SkillIndexEntry[] {
    return entries.filter((entry) => {
      const paths = this.indexed.get(entry.name)?.frontmatter.paths
      if (!paths || paths.length === 0) return true
      return touchedPaths.some((touched) => matchesActivationPaths(paths, touched))
    })
  }
}
