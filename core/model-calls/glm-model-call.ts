// A fifth real ModelCall implementation. GLM (Zhipu AI / Z.ai)'s Chat
// Completions API is OpenAI-compatible — confirmed against Zhipu's own
// docs (docs.bigmodel.cn/cn/guide/develop/openai/introduction): same
// messages/tools/tool_choice request shape, same tool_calls response
// shape — so this reuses openai-model-call.ts's message/response
// translation verbatim via the real `openai` SDK client, just pointed at
// Zhipu's base URL, rather than duplicating that logic. Same pattern
// deepseek-model-call.ts/kimi-model-call.ts already established.
//
// Uses the newer `max_completion_tokens` field, same as Kimi — no
// DeepSeek-style documented exception for GLM.
import OpenAI from 'openai'
import type { ToolSchema } from '#core/agent-config.js'
import type { Message, ModelCall, ModelResponse } from '#core/run-agent.js'
import { toMessageParams, toModelResponse } from './openai-model-call.js'

export interface GlmModelCallOptions {
  /** Defaults to the GLM_API_KEY env var. */
  apiKey?: string
  /** No hardcoded default — same reasoning as OpenAIModelCallOptions.model:
   * pass the one you actually want. */
  model: string
  maxTokens?: number
  /** Defaults to Zhipu's own API — override to point at a proxy/mirror. */
  baseURL?: string
  /** Inject a pre-configured client instead of building one from apiKey/baseURL — e.g. to pass a custom `fetch` in tests. */
  client?: OpenAI
}

export function createGlmModelCall(options: GlmModelCallOptions): ModelCall {
  if (!options.client && !options.apiKey && !process.env.GLM_API_KEY) {
    // Fails here, with a GLM-specific message, rather than letting the
    // OpenAI SDK's own constructor validation reject it — that error says
    // "set OPENAI_API_KEY", which would send someone who never touched
    // that variable chasing the wrong fix.
    throw new Error('createGlmModelCall: no apiKey given and GLM_API_KEY is not set.')
  }

  const client =
    options.client ??
    new OpenAI({
      // Explicitly null, not undefined, if neither is set — see
      // kimi-model-call.ts's identical comment for why this matters even
      // though the guard above already rules out reaching here with no
      // key at all.
      apiKey: options.apiKey ?? process.env.GLM_API_KEY ?? null,
      baseURL: options.baseURL ?? 'https://open.bigmodel.cn/api/paas/v4/',
    })
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
