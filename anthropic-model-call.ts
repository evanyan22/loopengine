// The one real ModelCall implementation loopengine ships. Every example
// agent (file-agent.ts, customer-service-agent.ts, rag-agent.ts) still
// uses a canned, turn-counting fake so the whole loop is runnable with no
// API key — swap that fake for createAnthropicModelCall(...) and nothing
// in run-agent.ts, the adapters, or any AgentConfig changes. ModelCall is
// the only seam this needed.
//
// loopengine's own Message type mirrors Anthropic's native shape closely
// on purpose: `content` is either a plain string or a ModelContentBlock[]
// carrying real tool_use/tool_result blocks with ids, the same identity
// Anthropic's own API expects a tool_use to be answered by a matching
// tool_result. This file's only job is translating between that shape and
// the SDK's own param/response types — see message-to-param below.
import Anthropic from '@anthropic-ai/sdk'
import type { ToolSchema } from './agent-config.js'
import type { Message, ModelCall, ModelContentBlock, ModelResponse } from './run-agent.js'

export interface AnthropicModelCallOptions {
  /** Defaults to the ANTHROPIC_API_KEY env var, same as the SDK itself. */
  apiKey?: string
  model?: string
  maxTokens?: number
  /** Inject a pre-configured client instead of building one from apiKey — e.g. to pass a custom `fetch` in tests. */
  client?: Anthropic
}

function toContentBlockParam(block: ModelContentBlock): Anthropic.Messages.ContentBlockParam {
  if (block.type === 'tool_use') {
    return { type: 'tool_use', id: block.id!, name: block.name!, input: block.input ?? {} }
  }
  if (block.type === 'tool_result') {
    return { type: 'tool_result', tool_use_id: block.tool_use_id!, content: block.content, is_error: block.is_error }
  }
  // text (and anything else this file doesn't specifically construct —
  // in practice only text/tool_use/tool_result ever end up in a Message
  // this framework builds).
  return { type: 'text', text: block.text ?? '' }
}

function toMessageParam(message: Message): Anthropic.Messages.MessageParam {
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: typeof message.content === 'string' ? message.content : message.content.map(toContentBlockParam),
  }
}

export function createAnthropicModelCall(options: AnthropicModelCallOptions = {}): ModelCall {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey })
  const model = options.model ?? 'claude-sonnet-5'
  const maxTokens = options.maxTokens ?? 4096

  return async (messages: Message[], system: string, tools: ToolSchema[]): Promise<ModelResponse> => {
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages: messages.map(toMessageParam),
      tools: tools.length
        ? tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.input_schema as Anthropic.Tool.InputSchema,
          }))
        : undefined,
    })

    const content: ModelContentBlock[] = response.content.map((block): ModelContentBlock => {
      if (block.type === 'text') return { type: 'text', text: block.text }
      if (block.type === 'tool_use') {
        return { type: 'tool_use', id: block.id, name: block.name, input: block.input as Record<string, unknown> }
      }
      return { type: block.type }
    })

    return { stop_reason: response.stop_reason ?? 'end_turn', content }
  }
}
