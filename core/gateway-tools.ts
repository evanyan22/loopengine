// Lets an operator register external tool gateways (Composio today —
// Nango, Arcade, Scalekit are meant to slot in later as thin mcpplug
// ToolSource adapters, same shape, once this mechanism is proven) against
// an agent, without hand-writing a tools/index.ts. The registry is
// agents/<name>/gateway-tools.yml — plain data, read fresh off disk every
// call, same "no restart to see an edit" behavior actauth.yml already
// has (see run-agent.ts's loadRules). adapters/http.ts's admin routes are
// the only intended writer of that file; loadGatewayToolsFromDir is what
// run-agent.ts calls to actually resolve it into ToolDefinitions.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml'
import { connectComposioSource } from 'mcpplug'
import type { Decision } from 'actauth'
import type { ToolDefinition } from './agent-config.js'

const execFileAsync = promisify(execFile)

// Same "one level up from this file, not process.cwd()" reasoning
// run-agent.ts's own agentsRootDir uses (this file lives in core/
// alongside it, with agents/ one level up at repo root either way) — real
// code (an actauth.yml write, a gateway-tools.yml write) needs to land in
// the same place a built dist/ would look for it, not wherever the
// process happened to be launched from.
const agentsRootDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'agents')

export interface ResolvedGatewayTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface ComposioGatewayToolEntry {
  provider: 'composio'
  /** Namespaces every tool this source produces (`${name}_${slug}`,
   * mcpplug's own convention) — must be unique among this agent's own
   * sources. */
  name: string
  slugs: string[]
  /** Override for a non-default binary name, or a stand-in script in
   * tests — see ComposioSourceOptions.cliCommand. Defaults to 'composio'. */
  cliCommand?: string
  /** {name, description, input_schema} per slug, once resolved — see
   * connectEntry/describeGatewayTools. Populated lazily (a slug just
   * added via addGatewayTool has no entry here yet) and persisted back
   * into this same file (see persistResolvedTools), not held in memory —
   * so a schema, once resolved, survives a server restart instead of
   * costing another ~3s Composio round trip on the next load. Keyed by
   * slug, not by the derived tool name (`${name}_${slug}`), since the
   * slug is what's stable if this source were ever renamed. Hand-editing
   * this is never expected — treat it as generated, the same as
   * describeGatewayTools' own in-memory result used to be before this
   * existed. */
  resolved?: Record<string, ResolvedGatewayTool>
}

// A union of one today — every other provider (Nango, Arcade, Scalekit)
// adds its own variant here, and connectEntry below grows one more branch
// per provider. Nothing else in this file (the registry read/write,
// run-agent.ts's merge point, the HTTP admin routes) needs to change per
// provider added.
export type GatewayToolEntry = ComposioGatewayToolEntry

interface GatewayToolsFile {
  sources: GatewayToolEntry[]
}

function gatewayToolsPath(dir: string): string {
  return join(dir, 'gateway-tools.yml')
}

/** A top-level agent's real folder — exported so callers resolving other
 * per-agent paths (adapters/http.ts's describeAgent, computing the same
 * `dir` to hand to loadGatewayToolsFromDir) use the exact same base this
 * module's own registry read/writes do, rather than re-deriving it (e.g.
 * from process.cwd()) and risking the two drifting apart. */
export function agentDir(agentName: string): string {
  return join(agentsRootDir, agentName)
}

/** `dir` is the agent's real folder — `agents/<name>` for a top-level
 * agent, or the nested `agents/<parent>/subagents/<child>` a subagent
 * actually lives in (see run-agent.ts's resolveSubagentConfig, which
 * hit this exact same name-vs-folder distinction for tools/rules/
 * skillsDirs). Missing file is just `[]`, same convention every other
 * folder-form default in this repo gets. */
export function readGatewayToolsFromDir(dir: string): GatewayToolEntry[] {
  const path = gatewayToolsPath(dir)
  if (!existsSync(path)) return []
  const raw = (parseYaml(readFileSync(path, 'utf8')) ?? {}) as GatewayToolsFile
  return raw.sources ?? []
}

/** Convenience wrapper over readGatewayToolsFromDir for the common,
 * top-level-agent case — what adapters/http.ts's admin routes actually
 * call, since GET /agents/:name/gateway-tools only ever addresses a
 * top-level agent (getEntry(name) has no notion of a subagent path). */
export function readGatewayTools(agentName: string): GatewayToolEntry[] {
  return readGatewayToolsFromDir(agentDir(agentName))
}

function writeGatewayToolsFile(dir: string, sources: GatewayToolEntry[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(gatewayToolsPath(dir), stringifyYaml({ sources } satisfies GatewayToolsFile))
}

// Re-reads and writes gateway-tools.yml fresh, not off whatever snapshot
// the caller (connectEntry/describeGatewayTools) originally read — a
// live resolution can take real seconds (mcpplug's per-slug CLI round
// trips), long enough for an admin-UI edit (add/remove a slug) to land
// in between. Merged into the source's existing `resolved`, not
// replaced, so two overlapping resolutions of different slug subsets
// (e.g. connectEntry resolving one newly-added slug while
// describeGatewayTools resolves another) don't clobber each other.
// Silently a no-op if the source itself is gone by the time this runs —
// nothing left to persist onto.
function persistResolvedTools(dir: string, sourceName: string, newlyResolved: Record<string, ResolvedGatewayTool>): void {
  if (!Object.keys(newlyResolved).length) return
  const sources = readGatewayToolsFromDir(dir)
  const index = sources.findIndex((s) => s.name === sourceName)
  if (index === -1) return
  const existing = sources[index]
  const updated = [...sources]
  updated[index] = { ...existing, resolved: { ...existing.resolved, ...newlyResolved } }
  writeGatewayToolsFile(dir, updated)
}

export class GatewayToolExistsError extends Error {}
export class GatewayToolNotFoundError extends Error {}

// A toolkit's own action-naming convention, not this repo's — Composio
// slugs are consistently VERB_REST (LIST_REPOS, CREATE_ISSUE, ...), just
// not consistently *which* verb, so this is a heuristic, not a spec.
// Scans every underscore-separated token (not just the first) since the
// verb isn't always right after the toolkit prefix — GITHUB_LIST_REPOS
// and github_GITHUB_LIST_REPOS (the ${entry.name}_${slug} form
// appendActauthRules actually calls this with) both still hit LIST.
const READ_ONLY_VERBS = new Set([
  'LIST',
  'GET',
  'FETCH',
  'FIND',
  'SEARCH',
  'READ',
  'RETRIEVE',
  'VIEW',
  'CHECK',
  'SHOW',
  'DESCRIBE',
  'QUERY',
  'COUNT',
  'EXPORT',
])
const MUTATING_VERBS = new Set([
  'CREATE',
  'ADD',
  'UPDATE',
  'EDIT',
  'MODIFY',
  'DELETE',
  'REMOVE',
  'SEND',
  'POST',
  'WRITE',
  'SET',
  'PUT',
  'PATCH',
  'PUBLISH',
  'UPLOAD',
  'INVITE',
  'ASSIGN',
  'MERGE',
  'CLOSE',
  'CANCEL',
  'ARCHIVE',
  'RESTORE',
  'ENABLE',
  'DISABLE',
  'GRANT',
  'REVOKE',
  'EXECUTE',
  'RUN',
  'TRIGGER',
  'START',
  'STOP',
  'PAY',
  'CHARGE',
  'REFUND',
  'TRANSFER',
  'IMPORT',
  'MOVE',
  'COPY',
  'DUPLICATE',
  'CLONE',
  'RESET',
  'REPLACE',
  'ATTACH',
  'DETACH',
  'LOCK',
  'UNLOCK',
  'BLOCK',
  'UNBLOCK',
  'BAN',
])

/** Whether a gateway tool's name reads as read-only (safe to
 * auto-allow) rather than mutating (should stay at actauth's own
 * default, typically 'ask' or 'deny', until a human explicitly grants
 * it) — see addGatewayTool's 'auto' decision mode, which is what
 * actually calls this. The first token that matches either list wins,
 * scanned in order; a name with no recognized verb at all (an
 * inconsistently-named action, or a toolkit this list hasn't seen yet)
 * defaults to *not* read-only — an unclassifiable tool staying at
 * actauth's default is the safe failure mode, the reverse would silently
 * auto-allow something this heuristic simply doesn't understand. Exported
 * for testing and because adapters/http.ts's picker UI may want to show
 * the same classification before a tool is even added. */
export function isReadOnlyToolName(toolName: string): boolean {
  const tokens = toolName.toUpperCase().split('_')
  for (const token of tokens) {
    if (READ_ONLY_VERBS.has(token)) return true
    if (MUTATING_VERBS.has(token)) return false
  }
  return false
}

/** 'auto' resolves per-tool via isReadOnlyToolName instead of one fixed
 * decision for a whole batch — see addGatewayTool's own doc comment for
 * why a single decision can't safely cover "select all" against a
 * toolkit with dozens of actions of very different risk. */
export type GatewayToolDecision = Decision | 'auto'

/** Seeds one exact-match actauth rule per tool this source produces —
 * ActAuth's own `tool` matching is exact-string, not glob (only `scope`
 * supports wildcards), so "allow everything gh_* produces" isn't
 * expressible as one rule; each `${entry.name}_${slug}` tool name gets
 * its own. Computed from `entry` directly (never a live call to the
 * gateway) so adding a source doesn't require the CLI/provider to be
 * reachable at that exact moment — only actually loading tools later
 * does. Creates agents/<name>/actauth.yml (default_decision: deny) if it
 * doesn't exist yet, same fallback loadRules' own default gets.
 *
 * `decision: 'auto'` seeds an explicit 'allow' rule for tools
 * isReadOnlyToolName reads as safe, and an explicit 'ask' rule for
 * everything else — never no rule at all. Relying on "no rule falls
 * through to actauth's own default_decision" was the first cut of this,
 * but that ties a mutating tool's actual governing decision to whatever
 * default_decision happens to be *at the time someone reads it*: change
 * default_decision later (say from 'ask' to 'allow' for an unrelated
 * reason) and every mutating tool added this way silently becomes
 * allowed too, with nothing in actauth.yml showing that ever happened.
 * An explicit 'ask' rule can't drift like that. This is what the
 * picker's own "select all" uses instead of forcing one decision onto a
 * batch that might mix GITHUB_LIST_REPOS with GITHUB_DELETE_REPO.
 *
 * Edits via `yaml`'s Document API (parse → mutate the CST → toString),
 * not parse-into-a-plain-object → re-stringify — the latter silently
 * drops every comment in the file, which for a real, hand-maintained
 * actauth.yml (see agents/customer-service/actauth.yml's own extensive
 * rule-by-rule reasoning) would mean adding one gateway tool wipes out
 * documentation an operator wrote for entirely unrelated rules. */
function appendActauthRules(dir: string, toolNames: string[], decision: GatewayToolDecision, provider: string): void {
  const path = join(dir, 'actauth.yml')
  const doc = existsSync(path) ? parseDocument(readFileSync(path, 'utf8')) : parseDocument('default_decision: deny\nrules: []\n')
  if (doc.get('rules') == null) doc.set('rules', [])

  const rules = doc.get('rules') as unknown as { add: (item: unknown) => void }
  for (const tool of toolNames) {
    const resolved = decision === 'auto' ? (isReadOnlyToolName(tool) ? 'allow' : 'ask') : decision
    // Prefixed with the *provider* (e.g. 'composio'), not the source's
    // own local `name` (e.g. 'github') — `tool` already embeds the
    // source name (`${entry.name}_${slug}`), so repeating it in the
    // rule name too would be redundant; the provider is the one piece
    // of context `tool` doesn't already carry.
    rules.add(doc.createNode({ name: `${provider}-${tool}-web-added`, scope: '*/*', tool, decision: resolved }))
  }

  mkdirSync(dir, { recursive: true })
  writeFileSync(path, doc.toString())
}

/** The inverse of appendActauthRules — strips any rule it previously
 * wrote for one of `toolNames`, recognized by the exact `-web-added`
 * name suffix that function always writes, so a hand-authored rule that
 * happens to reference the same tool (a different name, no suffix) is
 * never touched. Called from removeGatewayTool/removeGatewayToolSlug so
 * removing a tool also removes the permission it was granted, rather
 * than leaving a rule that now governs nothing. A no-op, not an error,
 * if actauth.yml doesn't exist or has no matching rule — removing a tool
 * that was never given a seeded rule (decision omitted when it was
 * added) is a completely normal case, not a problem to report. */
function removeAutoAddedActauthRules(dir: string, toolNames: string[]): void {
  const path = join(dir, 'actauth.yml')
  if (!existsSync(path)) return

  const doc = parseDocument(readFileSync(path, 'utf8'))
  const rules = doc.get('rules') as unknown as { items: Array<{ get: (key: string) => unknown }> } | undefined
  if (!rules) return

  const before = rules.items.length
  rules.items = rules.items.filter((rule) => {
    const name = rule.get('name')
    const tool = rule.get('tool')
    return !(typeof name === 'string' && name.endsWith('-web-added') && typeof tool === 'string' && toolNames.includes(tool))
  })
  if (rules.items.length === before) return

  writeFileSync(path, doc.toString())
}

function toolNamesFor(entry: GatewayToolEntry): string[] {
  return entry.slugs.map((slug) => `${entry.name}_${slug}`)
}

/** Registers a new gateway tool for `agentName` (top-level only — see
 * readGatewayTools), or, if a source with this exact `name` is already
 * registered, merges `entry.slugs` into it (deduped) instead of
 * rejecting the call — the name is just a namespace label, not a
 * one-shot slot; reusing it to add more tools under the same source is
 * the common case (picking a few more actions for an app you already
 * added), not a conflict. It's only a real conflict when the existing
 * entry is for a *different* provider — two different connection
 * configs can't share one name. `decision`, if given, pre-seeds an
 * actauth rule per tool in *this call's own* `entry.slugs` (see
 * appendActauthRules) — not the merged list, so re-adding an
 * already-registered slug doesn't also re-seed a duplicate rule for it.
 * Omit `decision` to leave every new tool at actauth's own
 * defaultDecision (typically 'deny'), the same "new tools are opt-in,
 * not silently allowed" convention every other tool in this repo
 * follows. `decision: 'auto'` — see appendActauthRules — resolves per
 * tool instead of applying one decision to the whole batch. */
export function addGatewayTool(agentName: string, entry: GatewayToolEntry, decision?: GatewayToolDecision): void {
  const dir = agentDir(agentName)
  const sources = readGatewayToolsFromDir(dir)
  const existingIndex = sources.findIndex((s) => s.name === entry.name)

  if (existingIndex === -1) {
    writeGatewayToolsFile(dir, [...sources, entry])
  } else {
    const existing = sources[existingIndex]
    if (existing.provider !== entry.provider) {
      throw new GatewayToolExistsError(
        `A gateway tool named '${entry.name}' already exists for '${agentName}' with a different provider ('${existing.provider}' vs '${entry.provider}') — pick a different name or remove it first.`,
      )
    }
    const mergedSlugs = Array.from(new Set([...existing.slugs, ...entry.slugs]))
    const updated = [...sources]
    updated[existingIndex] = { ...existing, ...entry, slugs: mergedSlugs }
    writeGatewayToolsFile(dir, updated)
  }

  if (decision) appendActauthRules(dir, toolNamesFor(entry), decision, entry.provider)
}

/** Removes a gateway tool's registration, along with any actauth rule
 * appendActauthRules previously seeded for it (see
 * removeAutoAddedActauthRules — a hand-authored rule referencing the
 * same tool under a different name is never touched). Removing a tool
 * is expected to remove the permission it was granted too, not leave a
 * rule that governs nothing behind. */
export function removeGatewayTool(agentName: string, sourceName: string): void {
  const dir = agentDir(agentName)
  const sources = readGatewayToolsFromDir(dir)
  const existing = sources.find((s) => s.name === sourceName)
  if (!existing) {
    throw new GatewayToolNotFoundError(`No gateway tool named '${sourceName}' for '${agentName}'.`)
  }
  writeGatewayToolsFile(
    dir,
    sources.filter((s) => s.name !== sourceName),
  )
  removeAutoAddedActauthRules(dir, toolNamesFor(existing))
}

/** Removes one slug from an existing source — the per-tool remove icon
 * in the Tools tab's Gateway Tools list, as opposed to removeGatewayTool
 * above, which drops the whole source at once. Deletes the source
 * entirely if that was its last slug: a source with zero slugs produces
 * zero tools anyway (mcpplug's connectComposioSource loops per slug, see
 * connectEntry), so there's nothing left worth keeping registered. Same
 * "also remove any rule this tool was auto-granted" behavior as
 * removeGatewayTool — see its own doc comment and
 * removeAutoAddedActauthRules. */
export function removeGatewayToolSlug(agentName: string, sourceName: string, slug: string): void {
  const dir = agentDir(agentName)
  const sources = readGatewayToolsFromDir(dir)
  const index = sources.findIndex((s) => s.name === sourceName)
  if (index === -1 || !sources[index].slugs.includes(slug)) {
    throw new GatewayToolNotFoundError(`No gateway tool '${slug}' registered under '${sourceName}' for '${agentName}'.`)
  }

  const remainingSlugs = sources[index].slugs.filter((s) => s !== slug)
  // Drops the removed slug's own resolved entry too — leaving it behind
  // would just be dead weight (nothing in `slugs` references it anymore,
  // so it can never be read back), and would silently reappear if the
  // exact same slug were ever re-added later, skipping what should be a
  // fresh resolution. Omitted entirely (not `resolved: {}`) once empty —
  // a source that never had any resolved slugs shouldn't gain a stray
  // empty field just because one was removed from it.
  const { [slug]: _removed, ...remainingResolved } = sources[index].resolved ?? {}
  const updated =
    remainingSlugs.length === 0
      ? sources.filter((_, i) => i !== index)
      : sources.map((s, i) => {
          if (i !== index) return s
          const next = { ...s, slugs: remainingSlugs }
          if (Object.keys(remainingResolved).length) next.resolved = remainingResolved
          else delete next.resolved
          return next
        })
  writeGatewayToolsFile(dir, updated)
  removeAutoAddedActauthRules(dir, [`${sources[index].name}_${slug}`])
}

// Builds a ToolDefinition straight from gateway-tools.yml's own persisted
// `resolved` entry — no CLI call at all for the schema/description, since
// those are exactly what's already cached. execute() itself still always
// shells out fresh (mirrors mcpplug's composio-source.ts own execute
// closure exactly — resolving *what a tool is* is cacheable, actually
// *running* it never is).
function toolFromResolved(slug: string, resolved: ResolvedGatewayTool, cliCommand?: string): ToolDefinition {
  return {
    name: resolved.name,
    description: resolved.description,
    input_schema: resolved.input_schema,
    execute: async (input) => {
      const result = (await runComposioCli(cliCommand ?? 'composio', ['execute', slug, '-d', JSON.stringify(input)])) as Record<string, unknown>
      if (result.successful === false || result.error) {
        throw new Error(`composio tool ${slug} failed: ${JSON.stringify(result.error ?? result)}`)
      }
      return result.data ?? result
    },
  }
}

// The only thing that still needs mcpplug/a live Composio round trip —
// slugs with no persisted resolution yet (just registered, or a `force`
// re-check). Returns [] without touching the CLI at all when there's
// nothing left to resolve, which is the common case once a source's
// slugs have all been resolved once.
async function fetchUnresolvedSlugs(entry: ComposioGatewayToolEntry, slugs: string[]): Promise<ToolDefinition[]> {
  if (!slugs.length) return []
  const source = await connectComposioSource(entry.name, { slugs, cliCommand: entry.cliCommand })
  try {
    return await source.loadTools()
  } finally {
    await source.close()
  }
}

/** Resolves `entry` into real ToolDefinitions for run-agent.ts to merge
 * in, preferring gateway-tools.yml's own persisted `resolved` data (see
 * ComposioGatewayToolEntry's own doc comment) over asking Composio again —
 * mcpplug's connectComposioSource (and the ~3s-per-slug CLI round trip it
 * costs) is only ever invoked for slugs that aren't resolved yet. Newly
 * resolved slugs are persisted back before returning, so the *next* call
 * (even after a restart) skips the live fetch entirely too. */
async function connectEntry(entry: GatewayToolEntry, dir: string): Promise<ToolDefinition[]> {
  if (entry.provider === 'composio') {
    const resolved = entry.resolved ?? {}
    const cachedTools = entry.slugs.filter((slug) => resolved[slug]).map((slug) => toolFromResolved(slug, resolved[slug], entry.cliCommand))
    const unresolvedSlugs = entry.slugs.filter((slug) => !resolved[slug])

    const freshTools = await fetchUnresolvedSlugs(entry, unresolvedSlugs)
    if (freshTools.length) {
      const newlyResolved: Record<string, ResolvedGatewayTool> = {}
      freshTools.forEach((tool, i) => {
        newlyResolved[unresolvedSlugs[i]] = { name: tool.name, description: tool.description, input_schema: tool.input_schema }
      })
      persistResolvedTools(dir, entry.name, newlyResolved)
    }

    return [...cachedTools, ...freshTools]
  }
  // Unreachable while GatewayToolEntry is a union of one — the check (and
  // the cast it needs) starts earning its keep the moment a second
  // provider is added and a stale gateway-tools.yml entry from before
  // that provider existed needs a real error, not a silent skip.
  throw new Error(`Unknown gateway tool provider '${(entry as GatewayToolEntry).provider}'.`)
}

/** mcpplug's own connectComposioSource fills each ToolDefinition's
 * description with a mechanically humanized slug (e.g. "abort repository
 * migration") — the only thing it has to work with is `composio execute
 * <slug> --get-schema`, which has no top-level description field, only
 * per-input ones. Composio's own catalog (`composio tools list
 * <toolkit>`) has a genuinely useful one instead (e.g. "Tool to abort a
 * repository migration that is queued or in progress. Use when you need
 * to cancel an ongoing migration operation.") — worth fetching for
 * describeGatewayTools specifically — only paid once per slug, right
 * before persisting it (see ComposioGatewayToolEntry's own `resolved`
 * doc comment), not on every load. Deliberately *not* applied inside
 * connectEntry itself, even though
 * that would also improve what the model actually sees at runtime —
 * connectEntry is loadGatewayToolsFromDir's hot path, and that function's
 * own doc comment already explicitly rejects paying any extra
 * reconnect/network cost there beyond what's unavoidable; confirmed live
 * that adding one more CLI call per distinct toolkit on every cache-miss
 * measurably slowed it down enough to blow real test timeouts.
 *
 * Toolkit is derived from each slug's own TOOLKIT_ACTION naming
 * convention, not from `entry.name` — that's just a local namespace
 * label an operator can set to anything (see ComposioGatewayToolEntry's
 * own doc comment), so it can't be trusted to name a real toolkit.
 * Best-effort per toolkit: a lookup failing (unusual slug shape, a
 * toolkit no longer connected) just leaves those tools at their
 * humanize() fallback rather than failing the whole call — same
 * fail-open reasoning loadGatewayToolsFromDir's own doc comment already
 * uses for a broken source. */
async function withRealComposioDescriptions(tools: ToolDefinition[], slugs: string[], cliCommand?: string): Promise<ToolDefinition[]> {
  const toolkits = Array.from(new Set(slugs.map((slug) => slug.split('_')[0].toLowerCase())))
  const descriptions = new Map<string, string>()
  await Promise.all(
    toolkits.map(async (toolkit) => {
      try {
        const catalog = await listComposioTools(toolkit, cliCommand)
        for (const t of catalog) descriptions.set(t.slug, t.description)
      } catch {
        // Best-effort — see this function's own doc comment.
      }
    }),
  )
  return tools.map((tool, i) => {
    const real = descriptions.get(slugs[i])
    return real ? { ...tool, description: real } : tool
  })
}

export interface GatewayToolStatus {
  entry: GatewayToolEntry
  status: 'ok' | 'error'
  tools: Array<{ name: string; description: string }>
  error?: string
}

/** The admin page's read model — every registered source for `agentName`,
 * each actually connected to and reported on individually, same
 * fail-open-per-source behavior loadGatewayToolsFromDir has (see its own
 * doc comment). The difference is what happens with a failure: this
 * function surfaces it explicitly, per source, since an operator looking
 * at this page needs to know *which* source is broken and why — where
 * loadGatewayToolsFromDir just logs and drops it, since runAgent() has no
 * structured place to hand a per-source error to.
 *
 * No in-memory cache here (or anywhere in this file, for this) — the
 * cache *is* gateway-tools.yml's own `resolved` field (see
 * ComposioGatewayToolEntry's own doc comment and connectEntry, which this
 * shares that field with), so it survives a restart instead of being
 * lost on one. Only genuinely-unresolved slugs pay for a live fetch, and
 * for those this still enriches with Composio's real catalog description
 * (see withRealComposioDescriptions) before persisting — unlike
 * connectEntry, which doesn't (see that function's own reasoning), this
 * is an occasional operator action, not runAgent()'s hot path, so paying
 * for the better description once, at resolution time, is worth it here.
 * Pass `force: true` (the admin page's own "Refresh" button) to treat
 * every slug as unresolved and overwrite their persisted entries with a
 * fresh live check — e.g. after reconnecting an account, or on the rare
 * chance a schema changed upstream without gateway-tools.yml itself
 * changing. */
export async function describeGatewayTools(agentName: string, options: { force?: boolean } = {}): Promise<GatewayToolStatus[]> {
  const dir = agentDir(agentName)
  const entries = readGatewayTools(agentName)

  return Promise.all(
    entries.map(async (entry): Promise<GatewayToolStatus> => {
      try {
        const resolved = entry.resolved ?? {}
        const cachedTools = options.force ? [] : entry.slugs.filter((slug) => resolved[slug]).map((slug) => toolFromResolved(slug, resolved[slug], entry.cliCommand))
        const unresolvedSlugs = options.force ? entry.slugs : entry.slugs.filter((slug) => !resolved[slug])

        const rawFreshTools = await fetchUnresolvedSlugs(entry, unresolvedSlugs)
        const freshTools = entry.provider === 'composio' ? await withRealComposioDescriptions(rawFreshTools, unresolvedSlugs, entry.cliCommand) : rawFreshTools
        if (freshTools.length) {
          const newlyResolved: Record<string, ResolvedGatewayTool> = {}
          freshTools.forEach((tool, i) => {
            newlyResolved[unresolvedSlugs[i]] = { name: tool.name, description: tool.description, input_schema: tool.input_schema }
          })
          persistResolvedTools(dir, entry.name, newlyResolved)
        }

        const tools = [...cachedTools, ...freshTools]
        return { entry, status: 'ok', tools: tools.map((t) => ({ name: t.name, description: t.description })) }
      } catch (err) {
        return { entry, status: 'error', tools: [], error: err instanceof Error ? err.message : String(err) }
      }
    }),
  )
}

/** In-memory, keyed by the registry file's own mtime — cheap to check
 * every call (one stat), and correct: it can only go stale if the file
 * changes without its mtime changing, which no real filesystem does.
 * Real cost here is connectEntry's own CLI subprocess-per-slug (see
 * mcpplug's composio-source.ts) — reconnecting on every single
 * runAgent() turn would be a real, unnecessary latency tax the rest of
 * this repo's folder-form defaults (loadDefaultTools, loadRules) don't
 * have to worry about, since those are plain reads/imports, not a
 * network/subprocess round trip. */
const cache = new Map<string, { mtimeMs: number; tools: ToolDefinition[] }>()

/** Resolves agents/<name>/gateway-tools.yml (or the equivalent nested path
 * for a subagent — see readGatewayToolsFromDir) into real ToolDefinitions,
 * for run-agent.ts to merge into the rest of an agent's tools. Missing
 * file is `[]`, no cache entry created.
 *
 * Fails open per source: one broken/unreachable gateway (Composio down,
 * a CLI not authenticated) is logged and contributes no tools, rather
 * than rejecting the whole call — the same reasoning a single tool's own
 * `execute()` failing doesn't crash runAgent's whole turn (ToolLane
 * reports it as an is_error tool_result instead). Without this, an agent
 * with an unrelated broken integration would fail *every* request, tools
 * it actually needs included — confirmed live: a run-agent.test.ts test
 * that reuses the real 'file-agent' name purely to exercise the
 * skillsDirs default started silently depending on the real `composio`
 * CLI/network the moment agents/file-agent/gateway-tools.yml existed,
 * before this fix made a failed (or slow/unavailable) source harmless
 * instead of fatal. */
export async function loadGatewayToolsFromDir(dir: string): Promise<ToolDefinition[]> {
  const path = gatewayToolsPath(dir)
  if (!existsSync(path)) return []

  const mtimeMs = statSync(path).mtimeMs
  const cached = cache.get(path)
  if (cached && cached.mtimeMs === mtimeMs) return cached.tools

  const entries = readGatewayToolsFromDir(dir)
  const resolved = await Promise.all(
    entries.map(async (entry) => {
      try {
        return await connectEntry(entry, dir)
      } catch (err) {
        console.error(`[gateway-tools] source '${entry.name}' (${entry.provider}) failed to load, skipping: ${err instanceof Error ? err.message : String(err)}`)
        return []
      }
    }),
  )
  const tools = resolved.flat()
  cache.set(path, { mtimeMs, tools })
  return tools
}

// ----- Discovery: what's already connected, what a connected app offers
// -----
//
// The add-a-source form used to ask an operator to already know a
// toolkit's exact slug strings by heart — real friction, and the only
// reason was that nothing in this file had actually shelled out to check
// what `composio connections list` / `composio tools list <toolkit>`
// return. Both work off the same `composio link <toolkit>` auth
// connectComposioSource already assumes — no extra "developer project"
// setup (`composio dev init`) needed, confirmed against a real CLI
// before building this.

async function runComposioCli(cliCommand: string, args: string[]): Promise<unknown> {
  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(cliCommand, args))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`composio CLI call failed (${args.join(' ')}): ${message}`)
  }
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`composio CLI returned non-JSON output for ${args.join(' ')}: ${stdout}`)
  }
}

export interface ComposioConnection {
  toolkit: string
  status: string
  alias: string | null
  wordId: string | null
}

interface RawComposioConnection {
  status: string
  alias?: string | null
  word_id?: string | null
}

/** Flattens `composio connections list`'s own shape (a map of toolkit
 * slug -> array of accounts) into one array — easier for a caller (the
 * add-source picker) to filter/sort without knowing that shape itself.
 * Every toolkit with at least one connected account appears, `status`
 * and all; deciding what counts as "usable" (typically just `'ACTIVE'`)
 * is left to the caller; a CLI/auth failure propagates as a normal
 * rejection — see runComposioCli. */
export async function listComposioConnections(cliCommand = 'composio'): Promise<ComposioConnection[]> {
  const raw = (await runComposioCli(cliCommand, ['connections', 'list'])) as Record<string, RawComposioConnection[]>
  const connections: ComposioConnection[] = []
  for (const [toolkit, accounts] of Object.entries(raw)) {
    for (const account of accounts) {
      connections.push({ toolkit, status: account.status, alias: account.alias ?? null, wordId: account.word_id ?? null })
    }
  }
  return connections
}

export interface ComposioToolInfo {
  slug: string
  name: string
  description: string
}

interface RawComposioTool {
  slug: string
  name: string
  description: string
}

/** What `composio tools list <toolkit>` offers for one already-connected
 * app — the picker's second step, once a toolkit is chosen from
 * listComposioConnections. Every action a toolkit exposes, not just ones
 * already registered as a gateway tool source — the picker's whole point
 * is showing what's *available* to add. `--limit 1000` (the CLI's own
 * max) is explicit rather than left to the CLI's own default: without
 * it, `composio tools list github` silently caps at 30 results — out of
 * GitHub's real ~900, and alphabetically sorted, so a picker session
 * would only ever see a narrow, unrepresentative slice (every result
 * starting with "A" — ABORT/ACCEPT/ADD/API/APPROVE/ASSIGN — almost all
 * mutating verbs), not "every tool this toolkit has" the doc comment
 * above already promises. Confirmed live against the real CLI: no
 * --limit gave 30, --limit 1000 gave 893. */
export async function listComposioTools(toolkit: string, cliCommand = 'composio'): Promise<ComposioToolInfo[]> {
  const raw = (await runComposioCli(cliCommand, ['tools', 'list', toolkit, '--limit', '1000'])) as RawComposioTool[]
  return raw.map((t) => ({ slug: t.slug, name: t.name, description: t.description }))
}

export interface ComposioAuthStatus {
  connected: boolean
  email?: string
  org?: string
}

/** Whether the composio CLI itself (not any one connected app — see
 * listComposioConnections for that) is authenticated on this machine.
 * `composio whoami` succeeds once `composio login` has run and fails
 * otherwise, so a failure here is read as "not connected", not
 * propagated as an error the way listComposioConnections' own CLI
 * failures are — this is a normal, expected state for an environment
 * that just hasn't been logged in yet, not a bug. Deliberately
 * read-only: login is an interactive, machine-wide CLI session (opens a
 * browser, affects every agent's gateway tools, not just one web
 * request), so the global config page's Gateways panel that calls this
 * only ever shows status + instructions, never drives login/logout
 * itself. */
export async function getComposioAuthStatus(cliCommand = 'composio'): Promise<ComposioAuthStatus> {
  try {
    const raw = (await runComposioCli(cliCommand, ['whoami'])) as { email?: string; current_org_name?: string }
    return { connected: true, email: raw.email, org: raw.current_org_name }
  } catch {
    return { connected: false }
  }
}

/** `composio logout` — already non-interactive on its own (see its own
 * --help), unlike login. Machine-wide: this deauthenticates the CLI for
 * every agent's gateway tools on this machine, not just the browser tab
 * that clicked Disconnect — same as running it in a terminal yourself.
 *
 * There's no connectComposioAccount counterpart: `composio login`'s only
 * non-interactive path is `--user-api-key`, which turned out not to be
 * what an operator actually has on hand — the key Composio's own
 * dashboard hands out for MCP client auth (sent via an x-consumer-api-key
 * header) isn't the same credential, and 401s against this flag.
 * Composio's own documented path is plain, interactive `composio login`
 * (opens a browser) after installing the CLI — not something a web
 * request can drive, so the Gateways panel shows that as instructions
 * instead of a form; see its own comment in web/global-config-page.ts. */
export async function disconnectComposioAccount(cliCommand = 'composio'): Promise<void> {
  await execFileAsync(cliCommand, ['logout'])
}
