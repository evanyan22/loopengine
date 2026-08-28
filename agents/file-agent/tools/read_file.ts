import { readFileSync } from 'node:fs'
import type { ToolDefinition } from '#core/agent-config.js'

export const readFile: ToolDefinition = {
  name: 'read_file',
  description: 'Read a text file',
  input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  execute: async (input) => readFileSync(input.path as string, 'utf8'),
  safe: true,
}
