// The one real ModelCall implementation loopengine ships. Every example
// agent (file-agent.ts, customer-service-agent.ts, mcp-filesystem-agent.ts)
// still uses a canned, turn-counting fake so the whole loop is runnable
// with no API key — swap that fake for createAnthropicModelCall(...) and
// nothing in run-agent.ts, the adapters, or any AgentConfig changes.
// ModelCall is the only seam this needed.
//
// loopengine's Message type (contextclip) is deliberately generic —
// {role, content: string} — so conversation history round-trips to the
// API as plain user/assistant text turns, not Anthropic's native
// tool_use/tool_result content blocks. Claude reads
// "[lookup_order result] {...}" as plain text just fine and the
// conversation still works correctly, but it's not the structured,
// block-native history the API is built around. If you need that
// fidelity later, it means changing what run-agent.ts stores in
// `messages`, not this file.
import Anthropic from '@anthropic-ai/sdk'
import type { Message } from 'contextclip'
import type { ToolSchema } from './agent-config.js'
import type { ModelCall, ModelContentBlock, ModelResponse } from './run-agent.js'

export interface AnthropicModelCallOptions {
  /** Defaults to the ANTHROPIC_API_KEY env var, same as the SDK itself. */
  apiKey?: string
  model?: string
  maxTokens?: number
  /** Inject a pre-configured client instead of building one from apiKey — e.g. to pass a custom `fetch` in tests. */
  client?: Anthropic
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
      messages: messages.map((m) => ({
        role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: m.content,
      })),
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
