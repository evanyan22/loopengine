import type { ToolDefinition } from '#core/agent-config.js'

export const sendEmail: ToolDefinition = {
  name: 'send_email',
  description: 'Email the customer',
  input_schema: {
    type: 'object',
    properties: {
      body: { type: 'string' },
      // Drives actauth.yml's own send-email-tracking-info-allowed rule —
      // a tracking-info reply auto-sends, everything else (including a
      // malformed/missing value here) falls through to that file's
      // catch-all ask rule instead. See DURABLE_APPROVALS.md's own
      // "Content-conditional gating" section for why this has to be a
      // structured field the model fills in, not a keyword scan over
      // `body`.
      intent: {
        type: 'string',
        enum: ['tracking_info', 'refund', 'other'],
        description: 'Why this email is being sent, so a human reviewer knows whether to check it before it sends.',
      },
    },
    required: ['body', 'intent'],
  },
  execute: async (input) => `sent: ${input.body}`,
}
