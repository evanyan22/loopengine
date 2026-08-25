import { writeFileSync } from 'node:fs'
import type { ToolDefinition } from '#agent-config.js'

export const writeFile: ToolDefinition = {
  name: 'write_file',
  description: 'Write a text file',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  execute: async (input) => {
    writeFileSync(input.path as string, input.content as string)
    return `wrote ${(input.content as string).length} bytes to ${input.path}`
  },
}
