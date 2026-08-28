import type { ToolDefinition } from '#core/agent-config.js'

export const sendEmail: ToolDefinition = {
  name: 'send_email',
  description: 'Email the customer',
  input_schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'] },
  execute: async (input) => `sent: ${input.body}`,
}
