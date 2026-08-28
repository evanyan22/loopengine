// Tools every agent gets automatically (see run-agent.ts's own tools
// merge, and this folder's own index.ts) — not something an agent opts
// into, the way its own agents/<name>/tools/ or a gateway-tools.yml
// source is. Kept to the one thing that's genuinely required
// infrastructure, not a convenience: a gateway tool (Composio's,
// confirmed live) that reports `storedInFile: true` instead of returning
// its real output inline is otherwise a dead end for an agent that never
// happened to define its own file-reading tool.
import { readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, sep } from 'node:path'
import type { ToolDefinition } from '../agent-config.js'

// Resolved once, at import time — os.tmpdir() itself doesn't change at
// runtime, and resolving it through realpathSync up front (not per call)
// means a symlink in the OS temp path itself (e.g. macOS's /tmp ->
// /private/tmp) is accounted for once, not re-resolved on every call.
const ALLOWED_ROOT = realpathSync(tmpdir())

function isWithinAllowedRoot(path: string): boolean {
  return path === ALLOWED_ROOT || path.startsWith(ALLOWED_ROOT + sep)
}

/** A path-restricted read_file, auto-available to every agent (see
 * run-agent.ts's own dedupeToolsByName + tools merge) — narrowly scoped
 * to the OS temp directory, which is where a gateway tool's real result
 * lands when a call returns `storedInFile: true` instead of the data
 * itself (confirmed live against the real composio CLI: `composio
 * execute`'s own outputFilePath always lands under os.tmpdir()).
 *
 * Deliberately *not* the same unscoped tool agents/file-agent/tools/
 * read_file.ts already has (arbitrary path, no restriction at all,
 * predates this): making arbitrary-path file reads available to *every*
 * agent by default — including ones wired to less-trusted gateway tools
 * or end-user-facing flows — would be a real, unbounded new capability,
 * not just a convenience. Resolving symlinks (realpathSync) on both the
 * allowed root and the requested path closes the obvious bypass (a
 * symlink inside the temp dir pointing outside it).
 *
 * Named `system_read_file`, not the bare `read_file` an agent author
 * would naturally reach for on their own (file-agent's own tool included)
 * — a `system_`-prefixed name is unlikely enough to collide by accident
 * that dedupeToolsByName's "an agent's own tool of the same name always
 * wins" rule stays a deliberate, rare opt-out rather than something a
 * completely unrelated tool name silently triggers. It also matters for
 * run-agent.ts's own systemToolInstances gate bypass (see there): once an
 * agent's own tool *does* collide on this exact name, gating goes back to
 * normal for it, on purpose — a name this specific is what makes that
 * an intentional choice on the agent author's part, not an accident. */
export const readFile: ToolDefinition = {
  name: 'system_read_file',
  description:
    "Read a text file from the OS temp directory — this is where a gateway tool's real output lands when its result says storedInFile: true instead of returning the data directly (see the outputFilePath it gives you). Not for reading arbitrary project or system files.",
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async (input) => {
    const requested = resolve(String(input.path))
    let real: string
    try {
      real = realpathSync(requested)
    } catch {
      throw new Error(`No such file: ${requested}`)
    }
    if (!isWithinAllowedRoot(real)) {
      throw new Error(`system_read_file can only read files under the OS temp directory (${ALLOWED_ROOT}) — got ${real}.`)
    }
    return readFileSync(real, 'utf8')
  },
}
