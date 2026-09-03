// Lets an operator edit an already-registered agent's systemPrompt/model
// directly from /agents/config's Overview tab, persisting the change to
// agents/<name>/index.ts itself — unlike gateway-tools.yml/actauth.yml/
// SKILL.md (plain data, safe to fully regenerate or edit via a
// dedicated Document API), an agent's index.ts is real TypeScript source
// that can also carry custom imports, a hand-written createModelCall,
// other AgentConfig fields, and comments an operator cares about. This
// edits via the TypeScript compiler API's AST plus exact source
// character offsets — the closest equivalent this repo has to `yaml`'s
// own Document API (parse -> locate the exact node -> splice its source
// text -> nothing else in the file changes) for TS source, since there's
// no ready-made "TS Document API" the way there is for YAML.
//
// Deliberately conservative: refuses, with a clear error, to touch a
// field whose *current* value isn't a plain, recognizable shape
// (systemPrompt: a string literal; model: an inline object literal with
// string-literal provider/model) rather than guess at rewriting anything
// more complex — a hand-customized agent (a template literal
// systemPrompt, a custom createModelCall instead of config.model, ...)
// is exactly the case this must never touch blindly.
//
// Deliberately lives outside bin/cli.ts, even though it reuses bin/cli.ts's own
// AgentModelError/Provider shape: bin/cli.ts is published as loopengine's
// own CLI binary (dist/bin/cli.js — see package.json's own "files" list),
// and this module's use of the `typescript` package (a devDependency,
// not a real dependency, of this package) would risk breaking
// `npx loopengine <command>` for any consumer whose own project doesn't
// happen to also have typescript installed. This module (like
// skills-admin.ts/actauth-admin.ts/global-config.ts before it) is only
// ever imported by adapters/http.ts, which itself is never published as
// part of the loopengine package — it's project-owned source a
// scaffolded project gets its own copy of, where `typescript` is already
// a guaranteed devDependency (see create-loopengine's own template
// package.json).
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { agentDir } from '../core/gateway-tools.js'
import { AgentModelError } from '../bin/cli.js'

export class AgentEditNotSupportedError extends Error {}
export class AgentFileNotFoundError extends Error {}

type Provider = 'anthropic' | 'openai' | 'deepseek' | 'kimi' | 'glm' | 'gemini'

const MODEL_ENV_VAR: Record<Provider, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  // Moonshot AI's own env var name, not KIMI_API_KEY — see
  // core/model-calls/kimi-model-call.ts's own header comment for why.
  kimi: 'MOONSHOT_API_KEY',
  glm: 'GLM_API_KEY',
  gemini: 'GEMINI_API_KEY',
}

// The exact shape agentIndexTemplate (bin/cli.ts) always generates for the
// model field's trailing comment — used to recognize a comment this
// tooling itself wrote (safe to correct) versus anything else an
// operator might have hand-written there (left alone — see
// updateModelComment's own doc comment).
const MODEL_COMMENT_PATTERN = /^\/\/\s*reads\s+[A-Z_]+$/

export interface AgentEditableFields {
  systemPrompt?: string
  model?: { provider: Provider; model?: string }
  maxTurns?: number
  contextBudgetTokens?: number
  skillIndexBudgetTokens?: number
}

export interface AgentEditResult {
  systemPrompt?: string
  model?: { provider: Provider; model: string }
  maxTurns?: number
  contextBudgetTokens?: number
  skillIndexBudgetTokens?: number
}

// Escapes a value for safe interpolation into a single-quoted TS string
// literal in generated code — same reasoning (and same escaping) as
// bin/cli.ts's own tsStringLiteral, duplicated rather than imported since
// bin/cli.ts's copy is a private, unexported helper and this is the only
// other place that needs it.
function tsStringLiteral(value: string): string {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'"
}

// ts.getTrailingCommentRanges only looks for a comment starting exactly
// at `pos`, skipping whitespace but not other tokens — a trailing comma
// right after the model property's own end (the common case: model
// usually isn't the last property) sits in the way, so this retries one
// character further in if the first attempt found nothing and that
// character is a comma. Confirmed both cases live against a real parse
// before landing this — `getTrailingCommentRanges` genuinely returns
// undefined at the property's own end when a comma follows.
function trailingCommentAfter(source: string, pos: number): ts.CommentRange | undefined {
  const ranges = ts.getTrailingCommentRanges(source, pos) ?? (source[pos] === ',' ? ts.getTrailingCommentRanges(source, pos + 1) : undefined)
  return ranges?.[0]
}

function findConfigObjectLiteral(sourceFile: ts.SourceFile): ts.ObjectLiteralExpression | undefined {
  for (const stmt of sourceFile.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    if (!stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === 'config' && decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
        return decl.initializer
      }
    }
  }
  return undefined
}

function findProperty(obj: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return obj.properties.find((p) => p.name !== undefined && ts.isIdentifier(p.name) && p.name.text === name)
}

interface TextEdit {
  start: number
  end: number
  text: string
}

// maxTurns/contextBudgetTokens/skillIndexBudgetTokens are the only three
// AgentConfig fields this file edits that are *usually absent* — every
// agent in this repo, and create-loopengine's own scaffold template,
// leaves all three unset and rides run-agent.ts's own defaults (25 /
// 100000 / 2000), unlike systemPrompt/model which agentIndexTemplate always
// writes out explicitly. So "the property isn't in this file" can't mean
// refuse here the way it does for a genuinely unusual systemPrompt/model
// shape — that would make every freshly scaffolded agent's limits
// permanently uneditable through this API. Missing properties are
// collected into `toInsert` instead and spliced in as new lines just
// before the object literal's closing brace (see editAgentFile's own use
// of this); an *existing* property whose value isn't a plain number
// literal is still refused, same "don't guess" rule as everything else
// in this file.
function upsertNumericProperty(
  configObj: ts.ObjectLiteralExpression,
  sourceFile: ts.SourceFile,
  edits: TextEdit[],
  toInsert: string[],
  name: string,
  value: number,
): void {
  const prop = findProperty(configObj, name)
  if (!prop) {
    toInsert.push(`${name}: ${value}`)
    return
  }
  if (!ts.isPropertyAssignment(prop) || !ts.isNumericLiteral(prop.initializer)) {
    throw new AgentEditNotSupportedError(`${name} in this file is not a plain number literal — edit it directly.`)
  }
  edits.push({ start: prop.initializer.getStart(sourceFile), end: prop.initializer.getEnd(), text: String(value) })
}

/** Surgically rewrites just the fields given in `fields` — see this
 * file's own header comment for why, and for the "refuse rather than
 * guess" rule this follows for anything that isn't a plain, recognizable
 * shape. Returns the values actually written (model's own default
 * resolution included), so the caller (adapters/http.ts's
 * handleEditAgent) can apply the exact same values to the *live*
 * registry entry — see core/agent-registry.ts's own updateAgent — without
 * needing to re-derive them. A field omitted from `fields` entirely is
 * left completely untouched, both on disk and in the return value. */
export function editAgentFile(agentName: string, fields: AgentEditableFields): AgentEditResult {
  const indexPath = join(agentDir(agentName), 'index.ts')
  let source: string
  try {
    source = readFileSync(indexPath, 'utf8')
  } catch {
    throw new AgentFileNotFoundError(`agents/${agentName}/index.ts not found.`)
  }

  const sourceFile = ts.createSourceFile(indexPath, source, ts.ScriptTarget.Latest, true)
  const configObj = findConfigObjectLiteral(sourceFile)
  if (!configObj) {
    throw new AgentEditNotSupportedError('Could not find "export const config: AgentConfig = { ... }" in this file — edit it directly.')
  }

  const edits: TextEdit[] = []
  const result: AgentEditResult = {}

  if (fields.systemPrompt !== undefined) {
    const prop = findProperty(configObj, 'systemPrompt')
    if (!prop || !ts.isPropertyAssignment(prop) || !ts.isStringLiteral(prop.initializer)) {
      throw new AgentEditNotSupportedError('systemPrompt in this file is not a plain string literal — edit it directly.')
    }
    edits.push({ start: prop.initializer.getStart(sourceFile), end: prop.initializer.getEnd(), text: tsStringLiteral(fields.systemPrompt) })
    result.systemPrompt = fields.systemPrompt
  }

  if (fields.model !== undefined) {
    const prop = findProperty(configObj, 'model')
    if (!prop || !ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) {
      throw new AgentEditNotSupportedError('model in this file is not a plain inline object — it may use a custom createModelCall; edit it directly.')
    }
    const provider = fields.model.provider
    const modelName = fields.model.model?.trim() || (provider === 'anthropic' ? 'claude-sonnet-5' : '')
    if (provider !== 'anthropic' && !modelName) {
      throw new AgentModelError(`A model name is required for provider '${provider}' — only anthropic has a default (claude-sonnet-5).`)
    }
    edits.push({
      start: prop.initializer.getStart(sourceFile),
      end: prop.initializer.getEnd(),
      text: `{ provider: '${provider}', model: ${tsStringLiteral(modelName)} }`,
    })
    result.model = { provider, model: modelName }

    // The property's own value is now correct, but a stale
    // "// reads ANTHROPIC_API_KEY" sitting right after it (from before a
    // provider change) would be actively misleading, not just cosmetic —
    // it'd point an operator at the wrong env var. Only touched if it
    // still matches the exact shape agentIndexTemplate itself generates
    // (see MODEL_COMMENT_PATTERN) — a hand-written comment in that spot
    // is left alone, same "don't guess" rule the value itself follows.
    const comment = trailingCommentAfter(source, prop.getEnd())
    if (comment && MODEL_COMMENT_PATTERN.test(source.slice(comment.pos, comment.end))) {
      edits.push({ start: comment.pos, end: comment.end, text: `// reads ${MODEL_ENV_VAR[provider]}` })
    }
  }

  const toInsert: string[] = []
  for (const name of ['maxTurns', 'contextBudgetTokens', 'skillIndexBudgetTokens'] as const) {
    const value = fields[name]
    if (value === undefined) continue
    if (!Number.isInteger(value) || value < 1) {
      throw new AgentEditNotSupportedError(`${name} must be a positive integer.`)
    }
    upsertNumericProperty(configObj, sourceFile, edits, toInsert, name, value)
    result[name] = value
  }

  if (toInsert.length) {
    // Insert right before the closing "}", not right after the last
    // property node — a hand-written trailing line comment there (like
    // model's own "// reads ANTHROPIC_API_KEY" above) would otherwise end
    // up with new properties spliced into the middle of it. The object's
    // own pre-existing newline-before-"}" becomes the separator before
    // the first inserted line for free; only an object with *no*
    // properties at all needs its own leading newline.
    const closeBracePos = configObj.getEnd() - 1
    const hasProps = configObj.properties.length > 0
    const needsLeadingComma = hasProps && !configObj.properties.hasTrailingComma
    const text = (hasProps ? '' : '\n') + (needsLeadingComma ? ',' : '') + toInsert.map((p) => `  ${p},\n`).join('')
    edits.push({ start: closeBracePos, end: closeBracePos, text })
  }

  if (!edits.length) return result

  // Apply from the end of the file backward — each edit's start/end was
  // computed against the *original* source, so splicing front-to-back
  // would shift every later offset out from under the next edit.
  edits.sort((a, b) => b.start - a.start)
  let updated = source
  for (const edit of edits) {
    updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end)
  }
  writeFileSync(indexPath, updated)

  return result
}
