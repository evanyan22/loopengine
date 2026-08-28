import type { ToolDefinition } from '#core/agent-config.js'

export const listDir: ToolDefinition = {
  name: 'list_dir',
  description: 'List files in the working directory',
  input_schema: { type: 'object', properties: {} },
  execute: async () => ['examples/file-agent/a.txt', 'examples/file-agent/b.txt'],
  safe: true,
}
