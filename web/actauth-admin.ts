// Lets an operator add, edit, or remove an actauth.yml rule (and set
// default_decision) from the Actauth tab in /agents/config, instead of
// hand-editing agents/<name>/actauth.yml directly. Same yaml Document
// API discipline gateway-tools.ts's appendActauthRules/
// removeAutoAddedActauthRules already established — parse → mutate the
// CST → toString, never parse-into-plain-object → re-stringify, since
// the latter silently drops every comment in a file real agents (see
// agents/customer-service/actauth.yml) use to document individual
// rules' reasoning.
//
// Deliberately does not let a rule be renamed — `name` is this admin
// UI's identifier for a rule (the :ruleName URL segment), so an "update"
// only ever touches scope/tool/decision/when; renaming is a delete +
// re-add, same as any other keyed-by-name resource here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import type { Decision } from 'actauth'
import { agentDir } from '../core/gateway-tools.js'

export class ActauthRuleExistsError extends Error {}
export class ActauthRuleNotFoundError extends Error {}

export interface ActauthRuleInput {
  name: string
  scope: string
  tool: string
  decision: Decision
}

export interface ActauthConfigView {
  defaultDecision: Decision
  rules: ActauthRuleInput[]
}

function actauthPath(dir: string): string {
  return join(dir, 'actauth.yml')
}

// Same shape parseDocument hands back for a YAML sequence's items — see
// gateway-tools.ts's removeAutoAddedActauthRules, which already needed
// this exact cast for the same reason (the `yaml` package's own types
// are the CST's, not a plain-data shape TypeScript can narrow well).
type RuleNode = { get: (key: string) => unknown; set: (key: string, value: unknown) => void }
type RulesSeq = { items: RuleNode[]; add: (item: unknown) => void }

function loadDoc(dir: string) {
  const path = actauthPath(dir)
  const doc = existsSync(path) ? parseDocument(readFileSync(path, 'utf8')) : parseDocument('default_decision: deny\nrules: []\n')
  if (doc.get('rules') == null) doc.set('rules', [])
  return { path, doc }
}

function saveDoc(dir: string, path: string, doc: ReturnType<typeof parseDocument>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, doc.toString())
}

/** The admin page's read model for the Actauth tab — every rule as plain
 * data, in file order. Unlike run-agent.ts's loadRules, this reads the
 * raw per-agent scope (e.g. "default/production", a wildcard pair)
 * rather than the 3-segment form actauth.RuleSet works with internally —
 * the admin UI edits the same file an operator would hand-edit, so it
 * should show exactly what's on disk, not a resolved/expanded form. */
export function readActauthConfig(agentName: string): ActauthConfigView {
  const dir = agentDir(agentName)
  const path = actauthPath(dir)
  if (!existsSync(path)) return { defaultDecision: 'deny', rules: [] }

  const doc = parseDocument(readFileSync(path, 'utf8'))
  const defaultDecision = (doc.get('default_decision') as Decision | undefined) ?? 'ask'
  const rules = doc.get('rules') as unknown as RulesSeq | undefined
  const rulesList: ActauthRuleInput[] = (rules?.items ?? []).map((rule) => ({
    name: String(rule.get('name') ?? ''),
    scope: String(rule.get('scope') ?? ''),
    tool: String(rule.get('tool') ?? ''),
    decision: rule.get('decision') as Decision,
  }))
  return { defaultDecision, rules: rulesList }
}

function findRuleIndex(rules: RulesSeq, ruleName: string): number {
  return rules.items.findIndex((rule) => rule.get('name') === ruleName)
}

/** Appends a new rule. `rule.name` must be unique among this agent's
 * existing rules — it's the only handle update/removeActauthRule below
 * have to find it again, so a duplicate would make those ambiguous. */
export function addActauthRule(agentName: string, rule: ActauthRuleInput): void {
  const dir = agentDir(agentName)
  const { path, doc } = loadDoc(dir)
  const rules = doc.get('rules') as unknown as RulesSeq

  if (findRuleIndex(rules, rule.name) !== -1) {
    throw new ActauthRuleExistsError(`A rule named '${rule.name}' already exists for '${agentName}' — pick a different name or remove it first.`)
  }

  rules.add(doc.createNode({ name: rule.name, scope: rule.scope, tool: rule.tool, decision: rule.decision }))
  saveDoc(dir, path, doc)
}

/** Mutates an existing rule's scope/tool/decision in place (via the
 * node's own `.set()`, not remove-then-re-add), so any comment attached
 * to that specific rule in the source YAML survives the edit. */
export function updateActauthRule(agentName: string, ruleName: string, updates: { scope: string; tool: string; decision: Decision }): void {
  const dir = agentDir(agentName)
  const { path, doc } = loadDoc(dir)
  const rules = doc.get('rules') as unknown as RulesSeq
  const index = findRuleIndex(rules, ruleName)
  if (index === -1) {
    throw new ActauthRuleNotFoundError(`No rule named '${ruleName}' for '${agentName}'.`)
  }

  const rule = rules.items[index]
  rule.set('scope', updates.scope)
  rule.set('tool', updates.tool)
  rule.set('decision', updates.decision)
  saveDoc(dir, path, doc)
}

export function removeActauthRule(agentName: string, ruleName: string): void {
  const dir = agentDir(agentName)
  const { path, doc } = loadDoc(dir)
  const rules = doc.get('rules') as unknown as RulesSeq
  const index = findRuleIndex(rules, ruleName)
  if (index === -1) {
    throw new ActauthRuleNotFoundError(`No rule named '${ruleName}' for '${agentName}'.`)
  }

  rules.items = rules.items.filter((_, i) => i !== index)
  saveDoc(dir, path, doc)
}

export function setDefaultDecision(agentName: string, decision: Decision): void {
  const dir = agentDir(agentName)
  const { path, doc } = loadDoc(dir)
  doc.set('default_decision', decision)
  saveDoc(dir, path, doc)
}
