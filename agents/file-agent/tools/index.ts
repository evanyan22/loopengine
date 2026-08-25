// Aggregates this agent's hand-written tools — one file per tool. The
// Composio-sourced GitHub tool isn't here: it's fetched dynamically at
// runtime (see ../index.ts's connectComposioSource call), not static code
// that could live in its own file the way these three can.
import type { ToolDefinition } from '#agent-config.js'
import { readFile } from './read_file.js'
import { listDir } from './list_dir.js'
import { writeFile } from './write_file.js'

export const tools: ToolDefinition[] = [readFile, listDir, writeFile]
