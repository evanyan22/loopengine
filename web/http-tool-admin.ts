// Lets an operator generate a real, hand-editable tool file from a
// constrained form — the Tools tab's fourth section, alongside Local
// tools/Subagents/Gateway Tools — instead of writing agents/<name>/
// tools/<tool>.ts by hand. Deliberately narrow: the only thing this
// generates is a parameterized HTTP call (method, a {field}-templated
// URL, headers, an optional JSON body/response-path mapping), never
// arbitrary code. A SKILL.md-style "store code as markdown, eval it at
// request time" version of this was considered and rejected: SKILL.md
// is safe specifically because its content is only ever read by the
// model, never executed — this generates a normal, readable, type-
// checked .ts file instead, the same class of artifact a human would
// have written by hand, just templated for one well-understood shape.
//
// Field/URL/header substitution is compiled into the *generated code*
// (a template literal with ${...} interpolations), not resolved at
// generation time — so a value is only ever combined with the URL via
// real encodeURIComponent, at call time, off whatever the model actually
// passed as input. A header value may also reference {{ENV_VAR}} — the
// generated code reads that from process.env at call time; the literal
// secret itself is never accepted by this module, persisted to the
// generated file, or echoed back through the admin API, the same
// "always env-sourced, never a config literal" rule SendEmail/
// HttpNotifierConfig's own secrets already follow (core/agent-config.ts).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { agentDir } from '../core/gateway-tools.js'
import type { ToolDefinition } from '../core/agent-config.js'

export class HttpToolNameError extends Error {}
export class HttpToolExistsError extends Error {}
export class HttpToolIndexShapeError extends Error {}
export class HttpToolNotFoundError extends Error {}
export class HttpToolNotEditableError extends Error {}

export interface HttpToolField {
  name: string
  type: 'string' | 'number' | 'boolean'
  description?: string
  required: boolean
}

export interface HttpToolSpec {
  name: string
  description: string
  fields: HttpToolField[]
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  headers: { key: string; value: string }[]
  sendFieldsAsJsonBody: boolean
  responseJsonPath?: string
}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/
const FIELD_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/

// Same escaping bin/cli.ts's own local tsStringLiteral uses for a
// single-quoted literal — duplicated here rather than imported, since
// it's two lines and not worth a cross-module export for.
function tsStringLiteral(value: string): string {
  return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
}

// snake_case tool name -> camelCase export identifier, e.g.
// "lookup_order_status" -> "lookupOrderStatus" — matches every
// hand-written tool file's own convention (see agents/customer-service/
// tools/*.ts: issue_refund.ts exports `issueRefund`, etc.).
function toCamelCase(snakeCase: string): string {
  return snakeCase.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

// Escapes a literal segment for safe interpolation inside a generated
// JS template literal (backtick string) — the three characters that
// would otherwise break out of it or start a nested interpolation.
function escapeTemplateLiteralSegment(segment: string): string {
  return segment.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

/** Compiles a "{field}" template string into the *inside* of a JS
 * template literal (caller wraps it in backticks) — each {field}
 * becomes `${wrap(fieldExpr)}`, everything else is a literal segment,
 * escaped for backtick safety. Throws if a referenced field isn't one
 * of `fieldNames` — a typo'd placeholder should fail at generation
 * time, not silently produce "undefined" in a live request later. */
function compileFieldTemplate(template: string, fieldNames: Set<string>, wrap: (fieldExpr: string) => string): string {
  let out = ''
  let lastIndex = 0
  const pattern = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(template))) {
    out += escapeTemplateLiteralSegment(template.slice(lastIndex, match.index))
    const field = match[1]
    if (!fieldNames.has(field)) {
      throw new HttpToolNameError(`Template references {${field}}, which isn't one of this tool's own fields.`)
    }
    out += '${' + wrap(`input.${field}`) + '}'
    lastIndex = pattern.lastIndex
  }
  out += escapeTemplateLiteralSegment(template.slice(lastIndex))
  return out
}

function generateToolCode(spec: HttpToolSpec): string {
  const fieldNames = new Set(spec.fields.map((f) => f.name))
  for (const field of spec.fields) {
    if (!FIELD_NAME_PATTERN.test(field.name)) {
      throw new HttpToolNameError(`Field name "${field.name}" must be a valid identifier (letters, digits, underscore, not starting with a digit).`)
    }
  }

  // Every distinct {{ENV_VAR}} referenced across header values becomes
  // one `const NAME = process.env.NAME` read (with a clear failure if
  // unset), generated once up front — cleaner than inlining a
  // read-and-check expression at every point of use, and it means a
  // missing secret fails loudly the moment the tool actually runs, not
  // silently as an empty header value.
  const envVars = new Set<string>()
  const headerEntries = spec.headers.map(({ key, value }) => {
    let compiled = ''
    let lastIndex = 0
    const pattern = /\{\{([A-Z_][A-Z0-9_]*)\}\}|\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g
    let match: RegExpExecArray | null
    while ((match = pattern.exec(value))) {
      compiled += escapeTemplateLiteralSegment(value.slice(lastIndex, match.index))
      if (match[1]) {
        if (!ENV_VAR_PATTERN.test(match[1])) {
          throw new HttpToolNameError(`"{{${match[1]}}}" isn't a valid env var name (uppercase letters, digits, underscore).`)
        }
        envVars.add(match[1])
        compiled += '${' + match[1] + '}'
      } else {
        const field = match[2]
        if (!fieldNames.has(field)) {
          throw new HttpToolNameError(`Header "${key}" references {${field}}, which isn't one of this tool's own fields.`)
        }
        compiled += '${String(input.' + field + ')}'
      }
      lastIndex = pattern.lastIndex
    }
    compiled += escapeTemplateLiteralSegment(value.slice(lastIndex))
    return { key, compiled }
  })

  const urlInner = compileFieldTemplate(spec.url, fieldNames, (expr) => `encodeURIComponent(String(${expr}))`)

  const properties = spec.fields
    .map((f) => `      ${JSON.stringify(f.name)}: { type: ${JSON.stringify(f.type)}${f.description ? `, description: ${JSON.stringify(f.description)}` : ''} },`)
    .join('\n')
  const required = spec.fields.filter((f) => f.required).map((f) => JSON.stringify(f.name))

  const envReads = [...envVars]
    .map((name) => `    const ${name} = process.env.${name}\n    if (!${name}) throw new Error(${tsStringLiteral(`${spec.name}: ${name} is not set`)})\n`)
    .join('')

  const headersObj =
    headerEntries.length === 0
      ? ''
      : `      headers: {\n${headerEntries.map(({ key, compiled }) => `        ${JSON.stringify(key)}: \`${compiled}\`,`).join('\n')}\n      },\n`

  const bodyLine =
    spec.sendFieldsAsJsonBody && spec.method !== 'GET' && spec.method !== 'DELETE' ? '      body: JSON.stringify(input),\n' : ''

  const responseHandling = spec.responseJsonPath
    ? (() => {
        const segments = spec.responseJsonPath!.split('.').filter(Boolean)
        for (const seg of segments) {
          if (!FIELD_NAME_PATTERN.test(seg)) {
            throw new HttpToolNameError(`responseJsonPath segment "${seg}" must be a valid identifier.`)
          }
        }
        const access = segments.map((s) => `?.${s}`).join('')
        return `    const body = await res.json()\n    return JSON.stringify(body${access} ?? null)\n`
      })()
    : '    return await res.text()\n'

  return `// Generated by the Admin UI's HTTP tool builder (Tools tab) — a
// parameterized HTTP call, not hand-written logic. Edit freely for
// anything this template can't express, but note that hand-editing this
// file directly (rather than through the Tools tab's own Edit button)
// leaves the sidecar ${spec.name}.http-tool.json out of sync — the next
// edit through the UI will overwrite your hand-edits with whatever that
// sidecar still says. The Admin UI only ever regenerates a tool it
// created itself, never overwrites a file it doesn't recognize (see
// web/http-tool-admin.ts's own HttpToolExistsError/HttpToolNotEditableError).
import type { ToolDefinition } from 'loopengine'

export const ${toCamelCase(spec.name)}: ToolDefinition = {
  name: ${tsStringLiteral(spec.name)},
  description: ${tsStringLiteral(spec.description)},
  input_schema: {
    type: 'object',
    properties: {
${properties}
    },
    required: [${required.join(', ')}],
  },
  execute: async (input) => {
${envReads}    const res = await fetch(\`${urlInner}\`, {
      method: ${tsStringLiteral(spec.method)},
${headersObj}${bodyLine}    })
    if (!res.ok) throw new Error(\`${spec.name}: HTTP \${res.status}\`)
${responseHandling}  },
}
`
}

// tools/index.ts's own shape is deliberately simple and consistent
// across every real example in this repo (agents/customer-service/
// tools/index.ts, create-loopengine's own template) — a handful of
// named imports, then one `export const tools: ToolDefinition[] = [...]`
// array literal. This patches that exact shape with two small string
// edits (one new import line, one new array entry) rather than a full
// TS-AST rewrite; if the file has been hand-edited into something this
// pattern doesn't recognize, it refuses instead of risking corrupting it
// — same "refuse rather than guess" discipline agent-file-admin.ts's own
// doc comment already establishes for index.ts edits.
function addToolToIndex(toolsIndexPath: string, toolFileName: string, exportName: string): void {
  const source = readFileSync(toolsIndexPath, 'utf8')
  const arrayMatch = source.match(/export const tools: ToolDefinition\[\] = \[([^\]]*)\]/)
  if (!arrayMatch) {
    throw new HttpToolIndexShapeError(`${toolsIndexPath} doesn't match the expected "export const tools: ToolDefinition[] = [...]" shape — add this tool to it by hand instead.`)
  }

  const importLine = `import { ${exportName} } from './${toolFileName}.js'\n`
  const lastImportMatch = [...source.matchAll(/^import .+\n/gm)].pop()
  const insertAt = lastImportMatch ? lastImportMatch.index! + lastImportMatch[0].length : 0
  const withImport = source.slice(0, insertAt) + importLine + source.slice(insertAt)

  const existingEntries = arrayMatch[1].trim()
  const newEntries = existingEntries ? `${existingEntries}, ${exportName}` : exportName
  const withEntry = withImport.replace(/export const tools: ToolDefinition\[\] = \[([^\]]*)\]/, `export const tools: ToolDefinition[] = [${newEntries}]`)

  writeFileSync(toolsIndexPath, withEntry)
}

// The spec is persisted alongside the generated .ts file, under the same
// name — this is what lets the Tools tab's Edit button repopulate the
// form later without reverse-parsing generated code back into a spec,
// and (its second job) is how readHttpToolSpec/listEditableHttpToolNames
// tell an admin-created tool apart from a hand-written one: only a tool
// this module itself created has one.
function specSidecarPath(toolsDir: string, name: string): string {
  return join(toolsDir, `${name}.http-tool.json`)
}

/** Generates agents/<agentName>/tools/<spec.name>.ts, registers it in
 * that agent's tools/index.ts, then imports the file it just wrote and
 * returns the real, callable ToolDefinition object — so the route
 * handler (adapters/http.ts's POST /agents/:name/tools/http) can splice
 * it straight into the live agent registry (core/agent-registry.ts's
 * updateAgent) without guessing an export name or re-deriving anything
 * this module already knows. */
export async function createHttpTool(agentName: string, spec: HttpToolSpec): Promise<{ path: string; tool: ToolDefinition }> {
  if (!TOOL_NAME_PATTERN.test(spec.name)) {
    throw new HttpToolNameError(`Tool name must be lowercase snake_case (e.g. "lookup_order_status") — got "${spec.name}"`)
  }

  const toolsDir = join(agentDir(agentName), 'tools')
  const toolPath = join(toolsDir, `${spec.name}.ts`)
  if (existsSync(toolPath)) {
    throw new HttpToolExistsError(`agents/${agentName}/tools/${spec.name}.ts already exists — pick a different name or edit it directly.`)
  }

  const code = generateToolCode(spec)

  mkdirSync(toolsDir, { recursive: true })
  writeFileSync(toolPath, code)
  writeFileSync(specSidecarPath(toolsDir, spec.name), JSON.stringify(spec, null, 2))

  const indexPath = join(toolsDir, 'index.ts')
  if (existsSync(indexPath)) {
    addToolToIndex(indexPath, spec.name, toCamelCase(spec.name))
  } else {
    writeFileSync(
      indexPath,
      `import type { ToolDefinition } from 'loopengine'\nimport { ${toCamelCase(spec.name)} } from './${spec.name}.js'\n\nexport const tools: ToolDefinition[] = [${toCamelCase(spec.name)}]\n`,
    )
  }

  const exportName = toCamelCase(spec.name)
  const mod = (await import(pathToFileURL(toolPath).href)) as Record<string, ToolDefinition>
  return { path: toolPath, tool: mod[exportName] }
}

/** Reads back the spec a previous createHttpTool/updateHttpTool call
 * persisted, for the Tools tab's Edit form to repopulate itself from —
 * or null if this tool was never created through this module (a
 * hand-written tools/<name>.ts, or one from before this sidecar existed),
 * which is exactly the signal the route handler uses to decide whether
 * to even show an Edit button for it. */
export function readHttpToolSpec(agentName: string, toolName: string): HttpToolSpec | null {
  const sidecarPath = specSidecarPath(join(agentDir(agentName), 'tools'), toolName)
  if (!existsSync(sidecarPath)) return null
  return JSON.parse(readFileSync(sidecarPath, 'utf8')) as HttpToolSpec
}

/** Every tool name in this agent's tools/ dir with a saved spec — i.e.
 * every tool the Tools tab can offer an Edit button for. Cheap (one
 * readdirSync), safe to call on every GET /agents/:name/config. */
export function listEditableHttpToolNames(agentName: string): string[] {
  const toolsDir = join(agentDir(agentName), 'tools')
  if (!existsSync(toolsDir)) return []
  return readdirSync(toolsDir)
    .filter((f) => f.endsWith('.http-tool.json'))
    .map((f) => f.slice(0, -'.http-tool.json'.length))
}

/** Overwrites an existing admin-created tool in place — same generated-
 * code shape createHttpTool produces, just written to the file that's
 * already there instead of a new one, and without touching tools/index.ts
 * (the import/export names are unchanged, since renaming isn't supported
 * here: spec.name must match toolName). Refuses a tool this module didn't
 * create (no sidecar spec) rather than silently clobbering hand-written
 * logic — same "refuse rather than guess" rule addToolToIndex's own doc
 * comment already applies to index.ts. */
export async function updateHttpTool(agentName: string, toolName: string, spec: HttpToolSpec): Promise<{ path: string; tool: ToolDefinition }> {
  if (spec.name !== toolName) {
    throw new HttpToolNameError(`A tool's name can't be changed by editing it — "${toolName}" vs "${spec.name}".`)
  }
  if (!TOOL_NAME_PATTERN.test(spec.name)) {
    throw new HttpToolNameError(`Tool name must be lowercase snake_case (e.g. "lookup_order_status") — got "${spec.name}"`)
  }

  const toolsDir = join(agentDir(agentName), 'tools')
  const toolPath = join(toolsDir, `${spec.name}.ts`)
  if (!existsSync(toolPath)) {
    throw new HttpToolNotFoundError(`agents/${agentName}/tools/${spec.name}.ts doesn't exist — nothing to edit.`)
  }
  const sidecarPath = specSidecarPath(toolsDir, spec.name)
  if (!existsSync(sidecarPath)) {
    throw new HttpToolNotEditableError(`agents/${agentName}/tools/${spec.name}.ts wasn't created by this form — edit the file directly instead.`)
  }

  const code = generateToolCode(spec)
  writeFileSync(toolPath, code)
  writeFileSync(sidecarPath, JSON.stringify(spec, null, 2))

  const exportName = toCamelCase(spec.name)
  // Cache-busted: this exact file URL was already imported once before
  // (at creation, or whenever this agent's tools were last resolved), and
  // Node's ESM cache is keyed by the literal URL string — a plain
  // re-import would silently hand back the stale pre-edit module instead
  // of the code just written above.
  const mod = (await import(`${pathToFileURL(toolPath).href}?edited=${Date.now()}`)) as Record<string, ToolDefinition>
  return { path: toolPath, tool: mod[exportName] }
}
