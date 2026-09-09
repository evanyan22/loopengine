// Backs `loopengine add-package|upgrade-package|remove-package` (see
// bin/cli.ts) — the install/upgrade/remove mechanics PACKAGES.md
// specifies for a "loopengine package": a bundle of tool files, skill
// directories, and actauth rules, installed by *copying* files into an
// agent's own tree (never an npm import) so a package's code is exactly
// as reviewable/hand-editable as anything the Admin UI's HTTP tool
// builder already generates (see web/http-tool-admin.ts's own header
// comment on `generateToolCode` for that same "real code, not an opaque
// import" reasoning).
//
// Deliberately reimplements (rather than imports) the two techniques
// create-loopengine's own `upgrade` command already has —
// `fetchPublishedTemplateDir`'s npm-pack-and-extract, and
// `threeWayMerge`'s `git merge-file --diff3` — since `loopengine` and
// `create-loopengine` are separate published packages and a runtime
// depending on a scaffolding tool (or vice versa) isn't a dependency
// direction worth introducing to share ~30 lines (see PACKAGES.md's
// "Upgrading" section).
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import semver from 'semver'
import { agentDir } from '../core/gateway-tools.js'
import { addToolToIndex, removeToolFromIndex, toCamelCase } from '../web/http-tool-admin.js'
import { addActauthRule, updateActauthRule, removeActauthRule, readActauthConfig, type ActauthRuleInput } from '../web/actauth-admin.js'

export class PackageManifestError extends Error {}
export class PackageVersionError extends Error {}
export class PackageCollisionError extends Error {}
export class PackageNotInstalledError extends Error {}
export class PackageAlreadyInstalledError extends Error {}

// Same character sets tool names / skill ids are already validated
// against elsewhere (web/http-tool-admin.ts's TOOL_NAME_PATTERN,
// web/skills-admin.ts's SKILL_ID_PATTERN) — re-checked here because a
// name derived from an untrusted package's own manifest becomes a path
// segment (agents/<agent>/tools/<name>.ts, .../skills/<id>/): without
// this, a package declaring a skill dir literally named ".." would have
// `basename('..')` hand back `'..'` unchanged (path.basename does not
// strip it), and the later `cpSync` would land one directory up, inside
// the agent's own root instead of its skills/ folder.
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/
const SKILL_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface PackageEnvDecl {
  name: string
  description?: string
  secret?: boolean
}

/** `name`/`version` deliberately aren't declared here — they're read off
 * the package's own sibling `package.json` instead (see readManifest),
 * which already has to exist and already has to carry real, valid values
 * for `npm pack` to treat the directory as a fetchable package at all.
 * loopengine.package.json only ever needs to declare what npm has no
 * vocabulary for. */
export interface PackageManifest {
  name: string
  version: string
  loopengineVersion: string
  tools?: string[]
  skills?: string[]
  actauth?: string
  env?: PackageEnvDecl[]
}

/** One agent's record of one installed package — the merge base a
 * future upgrade needs, what remove needs to know is safe to delete,
 * and (env) what the Admin UI's secrets section reads to know which
 * vars to prompt for. Written to agents/<agent>/.loopengine-packages.json,
 * same role .create-loopengine.json already plays for template files. */
export interface InstalledPackageRecord {
  version: string
  /** The exact spec (bare registry name, "name@version", a git+ssh/
   * git+https URL with a #committish, a file: path, ...) last used to
   * successfully install or upgrade this package — see
   * oldContentSpec's own doc comment for why upgradePackage needs this
   * stored verbatim rather than reconstructed from `packageName`.
   * Optional only because a package installed before this field existed
   * has no recorded value — see oldContentSpec's own fallback. */
  spec?: string
  tools: string[]
  skills: string[]
  actauthRules: string[]
  env: PackageEnvDecl[]
  /** relative path (e.g. "tools/foo.ts") -> sha256 hex, as of the last
   * install/upgrade — remove-package's dirty-check compares against
   * this rather than storing/refetching full content to diff. */
  contentHashes: Record<string, string>
}

type ProvenanceFile = Record<string, InstalledPackageRecord>

function provenancePath(agentName: string): string {
  return join(agentDir(agentName), '.loopengine-packages.json')
}

function readProvenance(agentName: string): ProvenanceFile {
  const path = provenancePath(agentName)
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as ProvenanceFile
}

function writeProvenance(agentName: string, data: ProvenanceFile): void {
  writeFileSync(provenancePath(agentName), JSON.stringify(data, null, 2) + '\n')
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

// ---- Fetch ----

/** `npm pack <spec>` + tar extract — generalized from
 * create-loopengine's own `fetchPublishedTemplateDir` (that function
 * only ever fetches the hardcoded `create-loopengine@<version>`; this
 * accepts anything `npm pack` does: a public/private registry spec, a
 * git URL (`github:org/repo`, `git+ssh://...`), or a local `file:../path`
 * — the last of which is what this module's own tests point at, so no
 * real network call is needed there; see PACKAGES.md's "Publishing a
 * package" section). */
export function fetchPackageDir(spec: string): string {
  const workDir = mkdtempSync(join(tmpdir(), 'loopengine-package-'))
  execFileSync('npm', ['pack', spec, '--pack-destination', workDir], { stdio: 'pipe' })
  const tarball = readdirSync(workDir).find((f) => f.endsWith('.tgz'))
  if (!tarball) {
    throw new Error(`Could not fetch '${spec}' — check the package exists and is reachable (registry auth / git credentials / local path).`)
  }
  // Absolute path, not the bare filename readdirSync returns — same
  // "tar resolves a relative first argument against the calling
  // process's own cwd, not workDir" gotcha fetchPublishedTemplateDir's
  // own comment already documents.
  execFileSync('tar', ['-xzf', join(workDir, tarball), '-C', workDir], { stdio: 'pipe' })
  return join(workDir, 'package')
}

export interface FetchOptions {
  fetchPackageDir?: (spec: string) => string
  /** Test-only override for the installing project's own "loopengine"
   * dependency range — defaults to a real package.json read. Without
   * this, checkLoopengineVersion's refusal path is unreachable from
   * this repo's own test suite: this repo's package.json has no
   * self-dependency to check against (see that function's own doc
   * comment), so every real test run would silently skip the check
   * instead of exercising it. */
  installedLoopengineRange?: string
}

function readManifest(packageDir: string): PackageManifest {
  const manifestPath = join(packageDir, 'loopengine.package.json')
  if (!existsSync(manifestPath)) {
    throw new PackageManifestError(`${packageDir} has no loopengine.package.json — not a valid loopengine package.`)
  }
  const declared = JSON.parse(readFileSync(manifestPath, 'utf8')) as Omit<PackageManifest, 'name' | 'version'>
  if (!declared.loopengineVersion) {
    throw new PackageManifestError('loopengine.package.json must have "loopengineVersion".')
  }

  // name/version come from package.json, not loopengine.package.json —
  // see PackageManifest's own doc comment for why duplicating them here
  // would just be two numbers to keep in sync instead of one.
  const pkgJsonPath = join(packageDir, 'package.json')
  if (!existsSync(pkgJsonPath)) {
    throw new PackageManifestError(`${packageDir} has no package.json — every loopengine package needs one (name/version), even though its own metadata lives in loopengine.package.json.`)
  }
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as { name?: string; version?: string }
  if (!pkgJson.name || !pkgJson.version) {
    throw new PackageManifestError(`${pkgJsonPath} must have "name" and "version".`)
  }

  return { ...declared, name: pkgJson.name, version: pkgJson.version }
}

// The installing project's own dependencies.loopengine is itself a
// range (e.g. "^0.1.10"), not a concrete installed version — checking
// the *floor* of that range against the manifest's required range is
// the conservative choice: if even the lowest version the range could
// resolve to wouldn't satisfy the package, refuse now rather than risk
// the exact silent-failure gap the Parallel-safe checkbox already hit
// (a feature that imports an export an *actually installed* older
// version doesn't have yet, with no error, just quietly not working).
function checkLoopengineVersion(manifest: PackageManifest, installedRangeOverride?: string): void {
  let installedRange = installedRangeOverride
  if (!installedRange) {
    // process.cwd(), not core/agent-registry.ts's own projectDir() —
    // that function resolves relative to *this compiled file's own
    // location*, correct only when agents/ is compiled alongside
    // dist/core/, which doesn't hold for a real scaffolded project
    // (loopengine lives in node_modules/loopengine/dist/, but the
    // project's own package.json is at the project root). Every other
    // cwd-relative path in this CLI (bin/cli.ts's requireAdapterFile,
    // core/gateway-tools.ts's own agentsRootDir, which agentDir() above
    // already relies on throughout this file) already resolves this way
    // — confirmed live: a real `npm pack file:...` install against this
    // repo's own dist/bin/cli.js failed against projectDir() here before
    // this fix, for exactly this reason.
    const ownPkgPath = join(process.cwd(), 'package.json')
    const ownPkg = JSON.parse(readFileSync(ownPkgPath, 'utf8')) as { name?: string; dependencies?: Record<string, string> }
    // A checkout of loopengine's own source (this repo, including its
    // own test suite) has no "loopengine" entry to check against — it
    // can't depend on itself. Same "detected by package.json's own
    // name, not a flag to remember" distinction bin/cli.ts's own
    // configImportSpecifier already makes for exactly this
    // repo-vs-real-consumer-project case.
    if (ownPkg.name === 'loopengine') return
    installedRange = ownPkg.dependencies?.loopengine
    if (!installedRange) {
      throw new PackageVersionError(`This project's package.json has no "loopengine" dependency — can't check compatibility.`)
    }
  }
  // A non-registry dependency specifier (file:, git:, workspace:, ...) —
  // common for local development against an unpublished loopengine
  // build — isn't a semver range at all, so minVersion throws rather
  // than returning null; nothing meaningful to compare against, so skip
  // the check rather than crash the whole command on it (same "nothing
  // to compare, nothing to refuse" reasoning the this-repo-itself skip
  // above already uses).
  let floor: semver.SemVer | null
  try {
    floor = semver.minVersion(installedRange)
  } catch {
    return
  }
  if (!floor || !semver.satisfies(floor, manifest.loopengineVersion)) {
    throw new PackageVersionError(
      `Package '${manifest.name}' needs loopengine ${manifest.loopengineVersion}, but this project depends on loopengine ${installedRange} — bump the dependency first.`,
    )
  }
}

function parseActauthRules(packageDir: string, manifest: PackageManifest): ActauthRuleInput[] {
  if (!manifest.actauth) return []
  const rulesPath = join(packageDir, manifest.actauth)
  if (!existsSync(rulesPath)) {
    throw new PackageManifestError(`Manifest references actauth file '${manifest.actauth}', which doesn't exist in the package.`)
  }
  const parsed: unknown = parseYaml(readFileSync(rulesPath, 'utf8'))
  if (!Array.isArray(parsed)) {
    throw new PackageManifestError(`'${manifest.actauth}' must be a YAML array of {name, scope, tool, decision} rules.`)
  }
  return parsed as ActauthRuleInput[]
}

// ---- Install ----

/** Installs `spec` (anything `npm pack` accepts) for `agentName`:
 * writes each manifest-listed tool file and patches tools/index.ts
 * (reusing addToolToIndex exactly as web/http-tool-admin.ts's own
 * createHttpTool does), copies each skill directory verbatim (a raw
 * cpSync, not skills-admin.ts's writeSkill — that regenerates
 * frontmatter from scratch and can't carry a package's own
 * frontmatter/assets), and appends each actauth rule (addActauthRule).
 *
 * Deliberately does *not* attempt a live in-memory registry splice the
 * way adapters/http.ts's own handleHttpToolPost does for an
 * admin-created tool — that works there because the HTTP request
 * creating the tool runs *inside the same process* as the already-running
 * server, so updateAgent's mutation is visible to every later request in
 * that same process immediately. `add-package` is a separate, one-off
 * CLI process with no connection to whatever server might be running
 * elsewhere — even a successful getEntry/updateAgent call here would
 * only mutate *this* CLI invocation's own throwaway registry, then
 * vanish the moment the process exits, having done nothing to the real
 * running server. (Confirmed live: this used to import
 * core/agent-registry.js, whose own discoverAgents does a top-level
 * directory scan relative to *its own compiled file's location* —
 * inside node_modules/loopengine when this runs there, not the
 * consuming project's real agents/ at all, throwing ENOENT immediately.)
 * Same reason add-agent/add-subagent above don't attempt this either —
 * a new tool becomes active the same way a new agent does: the next
 * request under `serve`, or automatically under `npx loopengine dev`'s
 * file watcher once tools/index.ts's own edit is picked up.
 *
 * All-or-nothing: every collision check below runs, and the whole
 * install is refused, before a single file is written. */
export async function installPackage(agentName: string, spec: string, options: FetchOptions = {}): Promise<{ installed: string[] }> {
  const fetch = options.fetchPackageDir ?? fetchPackageDir
  const packageDir = fetch(spec)
  const manifest = readManifest(packageDir)
  checkLoopengineVersion(manifest, options.installedLoopengineRange)

  const provenance = readProvenance(agentName)
  if (provenance[manifest.name]) {
    throw new PackageAlreadyInstalledError(`Package '${manifest.name}' is already installed for '${agentName}' — use upgrade-package instead.`)
  }

  const toolFiles = manifest.tools ?? []
  const skillDirs = manifest.skills ?? []
  const rules = parseActauthRules(packageDir, manifest)

  const toolsDir = join(agentDir(agentName), 'tools')
  const skillsDirPath = join(agentDir(agentName), 'skills')

  // Collision checks — refuse the whole install before writing anything,
  // same "refuse rather than guess" rule HttpToolExistsError/
  // HttpToolIndexShapeError already enforce for a single admin-created
  // tool, just applied package-wide.
  const toolNames: string[] = []
  for (const toolFile of toolFiles) {
    const toolName = basename(toolFile, '.ts')
    if (!TOOL_NAME_PATTERN.test(toolName)) {
      throw new PackageManifestError(`Tool file '${toolFile}' doesn't name a valid tool (must be lowercase snake_case).`)
    }
    toolNames.push(toolName)
    if (existsSync(join(toolsDir, `${toolName}.ts`))) {
      throw new PackageCollisionError(`agents/${agentName}/tools/${toolName}.ts already exists.`)
    }
  }
  const skillIds: string[] = []
  for (const skillDir of skillDirs) {
    const skillId = basename(skillDir)
    if (!SKILL_ID_PATTERN.test(skillId)) {
      throw new PackageManifestError(`Skill directory '${skillDir}' doesn't name a valid skill id (must be lowercase, hyphen-separated).`)
    }
    skillIds.push(skillId)
    if (existsSync(join(skillsDirPath, skillId))) {
      throw new PackageCollisionError(`agents/${agentName}/skills/${skillId}/ already exists.`)
    }
  }
  const existingRuleNames = new Set(readActauthConfig(agentName).rules.map((r) => r.name))
  for (const rule of rules) {
    if (existingRuleNames.has(rule.name)) {
      throw new PackageCollisionError(`An actauth rule named '${rule.name}' already exists for '${agentName}'.`)
    }
  }

  const contentHashes: Record<string, string> = {}

  // Write tool files and patch tools/index.ts — pure filesystem
  // operations, no dynamic import and no registry interaction (see this
  // function's own doc comment for why: a CLI process can't live-splice
  // into a separate, already-running server).
  if (toolNames.length > 0) {
    mkdirSync(toolsDir, { recursive: true })
    const indexPath = join(toolsDir, 'index.ts')
    for (const toolFile of toolFiles) {
      const toolName = basename(toolFile, '.ts')
      const code = readFileSync(join(packageDir, toolFile), 'utf8')
      const destPath = join(toolsDir, `${toolName}.ts`)
      writeFileSync(destPath, code)
      contentHashes[`tools/${toolName}.ts`] = sha256(code)

      const exportName = toCamelCase(toolName)
      if (existsSync(indexPath)) {
        addToolToIndex(indexPath, toolName, exportName)
      } else {
        writeFileSync(
          indexPath,
          `import type { ToolDefinition } from 'loopengine'\nimport { ${exportName} } from './${toolName}.js'\n\nexport const tools: ToolDefinition[] = [${exportName}]\n`,
        )
      }
    }
  }

  // Copy skill directories verbatim.
  for (const skillDir of skillDirs) {
    const skillId = basename(skillDir)
    const srcPath = join(packageDir, skillDir)
    const destPath = join(skillsDirPath, skillId)
    mkdirSync(skillsDirPath, { recursive: true })
    cpSync(srcPath, destPath, { recursive: true })
    const skillMdPath = join(destPath, 'SKILL.md')
    if (existsSync(skillMdPath)) {
      contentHashes[`skills/${skillId}/SKILL.md`] = sha256(readFileSync(skillMdPath, 'utf8'))
    }
  }

  // Append actauth rules.
  for (const rule of rules) {
    addActauthRule(agentName, rule)
  }

  provenance[manifest.name] = {
    version: manifest.version,
    spec,
    tools: toolNames,
    skills: skillIds,
    actauthRules: rules.map((r) => r.name),
    env: manifest.env ?? [],
    contentHashes,
  }
  writeProvenance(agentName, provenance)

  return { installed: [...toolNames.map((n) => `tools/${n}.ts`), ...skillIds.map((id) => `skills/${id}/`), ...rules.map((r) => `actauth:${r.name}`)] }
}

// ---- Upgrade ----

// git merge-file's own exit code *is* its conflict count (0 = clean),
// not a pass/fail signal — same distinction create-loopengine's own
// threeWayMerge already documents. Operates on a disposable scratch
// copy, never the real project file directly.
function mergeFile(mine: string, base: string, theirs: string): { merged: string; conflicted: boolean } {
  const scratchDir = mkdtempSync(join(tmpdir(), 'loopengine-package-merge-'))
  const minePath = join(scratchDir, 'mine')
  const basePath = join(scratchDir, 'base')
  const theirsPath = join(scratchDir, 'theirs')
  writeFileSync(minePath, mine)
  writeFileSync(basePath, base)
  writeFileSync(theirsPath, theirs)

  let conflicted = false
  try {
    execFileSync('git', ['merge-file', '--diff3', '-L', 'mine', '-L', 'base', '-L', 'latest', minePath, basePath, theirsPath], { stdio: 'pipe' })
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number') {
      conflicted = true
    } else {
      throw new Error(`git merge-file failed — is git installed and on PATH? (${err instanceof Error ? err.message : String(err)})`)
    }
  }
  const merged = readFileSync(minePath, 'utf8')
  rmSync(scratchDir, { recursive: true, force: true })
  return { merged, conflicted }
}

export interface UpgradeFileResult {
  path: string
  status: 'updated' | 'unchanged' | 'conflict'
}

// A git+ssh/git+https/git: URL, a plain https: tarball URL, or a local
// file:/relative/absolute path all already pin to exact, immutable
// content on their own (a #committish, or the file/tarball's own
// content) — appending "@version" to one of these doesn't select an
// older version the way it does for a registry specifier, it corrupts
// the spec. Confirmed live: `npm pack 'git+file://...#v1.0.0@1.0.0'`
// fails outright ("The git reference could not be found... pathspec
// 'v1.0.0@1.0.0'"), it doesn't fall back to resolving just the tag.
const PINNED_SPEC = /^(git\+|git:|https?:|file:|\.\.?\/|\/)/

/** What to fetch to reconstruct the exact content that was installed or
 * last upgraded to, for use as the three-way merge's `base` — as
 * distinct from `spec`, which is what the *new* content resolves to.
 * A plain registry specifier (bare or scoped name, with or without its
 * own "@version") is repinned to `version` — the manifest's own
 * declared version at that install/upgrade, which is what actually got
 * written to disk, regardless of whether the range originally given
 * would still resolve there today. A git/file/URL spec is returned
 * as-is — see PINNED_SPEC's own doc comment for why appending "@version"
 * to one of those breaks instead of pinning. `recordedSpec` is only
 * absent for a package installed before InstalledPackageRecord.spec
 * existed; falling back to `packageName` there reproduces this
 * function's own old (buggy for a git/file install) behavior exactly —
 * no worse than before, and only for a package that hasn't upgraded
 * since. */
function oldContentSpec(recordedSpec: string | undefined, packageName: string, version: string): string {
  const base = recordedSpec ?? packageName
  if (PINNED_SPEC.test(base)) return base
  // Strip any version/tag the spec already carries (a scoped name's own
  // leading '@' isn't this — only a second '@' after the name is) before
  // repinning, so re-upgrading an already-version-pinned install doesn't
  // produce a doubled-up "name@1.0.0@1.0.0".
  const bareName = base.startsWith('@') ? `@${base.slice(1).split('@')[0]}` : base.split('@')[0]
  return `${bareName}@${version}`
}

/** Upgrades an already-installed package to whatever `spec` (defaulting
 * to `packageName`, i.e. "latest") currently resolves to. Tool and skill
 * files get a real three-way merge (mine = current file, possibly
 * hand-edited since install; base = the version recorded at
 * install/last-upgrade, refetched via oldContentSpec; theirs = newly
 * fetched) — identical technique to `create-loopengine upgrade`, just
 * applied to package-managed files instead of template files. actauth
 * rules upgrade per-rule instead: the target actauth.yml holds rules
 * from other packages and hand-written ones too, so there's no coherent
 * "whole file" base/theirs to merge — a rule unchanged since install
 * updates cleanly; a hand-edited one is left alone and reported as a
 * conflict rather than overwritten. */
export async function upgradePackage(agentName: string, packageName: string, options: FetchOptions & { spec?: string } = {}): Promise<{ files: UpgradeFileResult[] }> {
  const fetch = options.fetchPackageDir ?? fetchPackageDir
  const provenance = readProvenance(agentName)
  const record = provenance[packageName]
  if (!record) {
    throw new PackageNotInstalledError(`Package '${packageName}' isn't installed for '${agentName}'.`)
  }
  const spec = options.spec ?? packageName

  const oldDir = fetch(oldContentSpec(record.spec, packageName, record.version))
  const newDir = fetch(spec)
  const oldManifest = readManifest(oldDir)
  const newManifest = readManifest(newDir)
  checkLoopengineVersion(newManifest, options.installedLoopengineRange)

  const results: UpgradeFileResult[] = []
  const newContentHashes: Record<string, string> = { ...record.contentHashes }

  for (const toolName of record.tools) {
    const relPath = `tools/${toolName}.ts`
    const oldFile = (oldManifest.tools ?? []).find((f) => basename(f, '.ts') === toolName)
    const newFile = (newManifest.tools ?? []).find((f) => basename(f, '.ts') === toolName)
    if (!oldFile || !newFile) {
      results.push({ path: relPath, status: 'unchanged' })
      continue
    }
    const base = readFileSync(join(oldDir, oldFile), 'utf8')
    const theirs = readFileSync(join(newDir, newFile), 'utf8')
    if (base === theirs) {
      results.push({ path: relPath, status: 'unchanged' })
      continue
    }
    const minePath = join(agentDir(agentName), relPath)
    const { merged, conflicted } = mergeFile(readFileSync(minePath, 'utf8'), base, theirs)
    writeFileSync(minePath, merged)
    if (!conflicted) newContentHashes[relPath] = sha256(merged)
    results.push({ path: relPath, status: conflicted ? 'conflict' : 'updated' })
  }

  for (const skillId of record.skills) {
    const relPath = `skills/${skillId}/SKILL.md`
    const oldSkillDir = (oldManifest.skills ?? []).find((s) => basename(s) === skillId)
    const newSkillDir = (newManifest.skills ?? []).find((s) => basename(s) === skillId)
    const oldFile = oldSkillDir ? join(oldDir, oldSkillDir, 'SKILL.md') : null
    const newFile = newSkillDir ? join(newDir, newSkillDir, 'SKILL.md') : null
    if (!oldFile || !newFile || !existsSync(oldFile) || !existsSync(newFile)) {
      results.push({ path: relPath, status: 'unchanged' })
      continue
    }
    const base = readFileSync(oldFile, 'utf8')
    const theirs = readFileSync(newFile, 'utf8')
    if (base === theirs) {
      results.push({ path: relPath, status: 'unchanged' })
      continue
    }
    const minePath = join(agentDir(agentName), relPath)
    const { merged, conflicted } = mergeFile(readFileSync(minePath, 'utf8'), base, theirs)
    writeFileSync(minePath, merged)
    if (!conflicted) newContentHashes[relPath] = sha256(merged)
    results.push({ path: relPath, status: conflicted ? 'conflict' : 'updated' })
  }

  const oldRules = parseActauthRules(oldDir, oldManifest)
  const newRules = parseActauthRules(newDir, newManifest)
  const currentRules = new Map(readActauthConfig(agentName).rules.map((r) => [r.name, r]))
  for (const ruleName of record.actauthRules) {
    const oldRule = oldRules.find((r) => r.name === ruleName)
    const newRule = newRules.find((r) => r.name === ruleName)
    const current = currentRules.get(ruleName)
    const path = `actauth:${ruleName}`
    if (!oldRule || !newRule || !current) {
      results.push({ path, status: 'unchanged' })
      continue
    }
    const unchangedSinceInstall = current.scope === oldRule.scope && current.tool === oldRule.tool && current.decision === oldRule.decision
    if (!unchangedSinceInstall) {
      results.push({ path, status: 'conflict' })
      continue
    }
    if (oldRule.scope === newRule.scope && oldRule.tool === newRule.tool && oldRule.decision === newRule.decision) {
      results.push({ path, status: 'unchanged' })
      continue
    }
    updateActauthRule(agentName, ruleName, { scope: newRule.scope, tool: newRule.tool, decision: newRule.decision })
    results.push({ path, status: 'updated' })
  }

  provenance[packageName] = { ...record, version: newManifest.version, spec, contentHashes: newContentHashes, env: newManifest.env ?? record.env }
  writeProvenance(agentName, provenance)

  return { files: results }
}

// ---- Remove ----

function isDirty(path: string, recordedHash: string | undefined): boolean {
  if (!existsSync(path)) return false
  if (!recordedHash) return true
  return sha256(readFileSync(path, 'utf8')) !== recordedHash
}

/** Removes an installed package's tool and skill files, and its actauth
 * rules. A file whose content no longer matches the hash recorded at
 * install/last-upgrade is refused (reported in `refused`, left on disk)
 * unless `force` is passed — a concrete implementation of PACKAGES.md's
 * "refuses if any of them look hand-modified," cheaper than storing full
 * content or refetching the package to diff. Does not patch
 * tools/index.ts to remove the now-dangling import — same "refuse
 * rather than guess a second time" doctrine addToolToIndex's own doc
 * comment already applies; a stale import surfaces as a clear build
 * error, not a silent break. */
export function removePackage(agentName: string, packageName: string, force = false): { removed: string[]; refused: string[] } {
  const provenance = readProvenance(agentName)
  const record = provenance[packageName]
  if (!record) {
    throw new PackageNotInstalledError(`Package '${packageName}' isn't installed for '${agentName}'.`)
  }

  const removed: string[] = []
  const refused: string[] = []
  const remainingTools: string[] = []
  const remainingSkills: string[] = []

  const toolsIndexPath = join(agentDir(agentName), 'tools', 'index.ts')
  for (const toolName of record.tools) {
    const relPath = `tools/${toolName}.ts`
    const fullPath = join(agentDir(agentName), relPath)
    if (!force && isDirty(fullPath, record.contentHashes[relPath])) {
      refused.push(relPath)
      remainingTools.push(toolName)
      continue
    }
    rmSync(fullPath, { force: true })
    // Undoes installPackage's own addToolToIndex call — without this, a
    // deleted tool's import survives in tools/index.ts, and either fails
    // the next build (a dangling import to a file that no longer exists)
    // or, worse, silently duplicates on a later add-package of the same
    // tool (addToolToIndex used to have no idempotence check at all —
    // now it does, but this is the actual fix: the stale entry shouldn't
    // be there to begin with).
    removeToolFromIndex(toolsIndexPath, toolName, toCamelCase(toolName))
    removed.push(relPath)
  }

  for (const skillId of record.skills) {
    const relPath = `skills/${skillId}/SKILL.md`
    const fullPath = join(agentDir(agentName), relPath)
    if (!force && isDirty(fullPath, record.contentHashes[relPath])) {
      refused.push(relPath)
      remainingSkills.push(skillId)
      continue
    }
    rmSync(join(agentDir(agentName), 'skills', skillId), { recursive: true, force: true })
    removed.push(`skills/${skillId}/`)
  }

  for (const ruleName of record.actauthRules) {
    try {
      removeActauthRule(agentName, ruleName)
      removed.push(`actauth:${ruleName}`)
    } catch {
      // Already gone (hand-removed since install) — not a failure.
    }
  }

  if (refused.length === 0) {
    delete provenance[packageName]
  } else {
    provenance[packageName] = { ...record, tools: remainingTools, skills: remainingSkills, actauthRules: [] }
  }
  writeProvenance(agentName, provenance)

  return { removed, refused }
}
