// A second real ModelCall implementation, alongside anthropic-model-call.ts
// — same seam, different provider. Swap createOpenAIModelCall(...) in for
// the canned fake in any agent and nothing in run-agent.ts, the adapters,
// or any AgentConfig changes.
//
// Structural mismatch worth knowing: loopengine's Message bundles every
// tool_result from one turn into a single user-role message's content
// array (mirroring Anthropic's own shape, which this framework's Message
// type was modeled on). OpenAI's Chat Completions API has no equivalent —
// each tool result is its own top-level message with role: 'tool'. So
// unlike Anthropic's 1:1 toMessageParam, toMessageParams here is plural: one
// loopengine Message can expand into several OpenAI messages, never fewer.
//
// stop_reason is normalized to the vocabulary anthropic-model-call.ts
// already established ('end_turn' / 'tool_use' / 'max_tokens') rather than
// passed through as OpenAI's own finish_reason strings — recovery.ts's
// defaultIsTruncated checks a translated ModelResponse for stop_reason ===
// 'max_tokens', so a provider-agnostic caller wiring up onTruncated later
// gets the same behavior regardless of which ModelCall is plugged in.
//
// toMessageParams/toStopReason/toModelResponse are exported for
// deepseek-model-call.ts to reuse verbatim — DeepSeek's Chat Completions
// API is wire-compatible with this same request/response shape (confirmed
// against DeepSeek's own docs), the one real difference being the token-
// limit field name, which is only decided at the request-building call
// site below, not in these shared translation functions.
import OpenAI from 'openai'
import type { ToolSchema } from '#core/agent-config.js'
import type { Message, ModelCall, ModelContentBlock, ModelResponse } from '#core/run-agent.js'

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

export interface OpenAIModelCallOptions {
  /** Defaults to the OPENAI_API_KEY env var, same as the SDK itself. */
  apiKey?: string
  /** No hardcoded default, unlike Anthropic's — OpenAI's current flagship
   * model name changes too often to bake into this file safely. Pass the
   * one you actually want. */
  model: string
  maxTokens?: number
  /** Inject a pre-configured client instead of building one from apiKey — e.g. to pass a custom `fetch` in tests. */
  client?: OpenAI
}

export function toMessageParams(message: Message): ChatMessage[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content }]
  }

  if (message.role === 'assistant') {
    const text = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
    const toolUseBlocks = message.content.filter((block) => block.type === 'tool_use')
    return [
      {
        role: 'assistant',
        // Required unless tool_calls is set — an empty string here (no
        // text, only tool calls) is rejected by the API, so this must be
        // null, not ''.
        content: text || null,
        tool_calls: toolUseBlocks.length
          ? toolUseBlocks.map((block) => ({
              id: block.id!,
              type: 'function',
              function: { name: block.name!, arguments: JSON.stringify(block.input ?? {}) },
            }))
          : undefined,
      },
    ]
  }

  // Every non-assistant, block-structured Message this loop ever builds is
  // one turn's tool_result blocks bundled together (see run-agent.ts's
  // pushMessage calls) — expand each into its own `role: 'tool'` message.
  return message.content.map((block) => ({
    role: 'tool',
    tool_call_id: block.tool_use_id!,
    content: block.content ?? '',
  }))
}

export function toStopReason(finishReason: string): string {
  if (finishReason === 'tool_calls' || finishReason === 'function_call') return 'tool_use'
  if (finishReason === 'length') return 'max_tokens'
  if (finishReason === 'stop') return 'end_turn'
  return finishReason
}

export function toModelResponse(choice: OpenAI.Chat.Completions.ChatCompletion.Choice): ModelResponse {
  const content: ModelContentBlock[] = []
  if (choice.message.content) content.push({ type: 'text', text: choice.message.content })
  for (const call of choice.message.tool_calls ?? []) {
    // A 'custom' tool call is the freeform-text tool type OpenAI added
    // alongside 'function' — this framework's ToolDefinition only ever
    // declares 'function'-shaped tools, so a custom call can't have come
    // from anything this loop offered the model.
    if (call.type !== 'function') continue
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function.name,
      input: JSON.parse(call.function.arguments) as Record<string, unknown>,
    })
  }
  return { stop_reason: toStopReason(choice.finish_reason), content }
}

export function createOpenAIModelCall(options: OpenAIModelCallOptions): ModelCall {
  const client = options.client ?? new OpenAI({ apiKey: options.apiKey })
  const maxTokens = options.maxTokens ?? 4096

  return async (messages: Message[], system: string, tools: ToolSchema[]): Promise<ModelResponse> => {
    const response = await client.chat.completions.create({
      model: options.model,
      max_completion_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages.flatMap(toMessageParams)],
      tools: tools.length
        ? tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.input_schema },
          }))
        : undefined,
    })

    return toModelResponse(response.choices[0])
  }
}
