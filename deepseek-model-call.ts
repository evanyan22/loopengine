// A third real ModelCall implementation. DeepSeek's Chat Completions API
// is wire-compatible with OpenAI's — confirmed against DeepSeek's own docs
// (api-docs.deepseek.com/api/create-chat-completion/): same messages/
// tools/tool_choice request shape, same tool_calls response shape — so
// this reuses openai-model-call.ts's message/response translation
// verbatim via the real `openai` SDK client, just pointed at DeepSeek's
// base URL, rather than duplicating that logic.
//
// The one real difference: DeepSeek's docs list `max_tokens` as the
// token-limit field, not the newer `max_completion_tokens`
// openai-model-call.ts uses (OpenAI deprecated max_tokens in favor of
// max_completion_tokens; DeepSeek's endpoint doesn't document the newer
// field at all) — decided at the request-building call site below, since
// toMessageParams/toModelResponse don't touch that field either way.
import OpenAI from 'openai'
import type { ToolSchema } from './agent-config.js'
import type { Message, ModelCall, ModelResponse } from './run-agent.js'
import { toMessageParams, toModelResponse } from './openai-model-call.js'

export interface DeepSeekModelCallOptions {
  /** Defaults to the DEEPSEEK_API_KEY env var. */
  apiKey?: string
  /** No hardcoded default — same reasoning as OpenAIModelCallOptions.model:
   * pass the one you actually want. */
  model: string
  maxTokens?: number
  /** Defaults to DeepSeek's own API — override to point at a proxy/mirror. */
  baseURL?: string
  /** Inject a pre-configured client instead of building one from apiKey/baseURL — e.g. to pass a custom `fetch` in tests. */
  client?: OpenAI
}

export function createDeepSeekModelCall(options: DeepSeekModelCallOptions): ModelCall {
  if (!options.client && !options.apiKey && !process.env.DEEPSEEK_API_KEY) {
    // Fails here, with a DeepSeek-specific message, rather than letting
    // the OpenAI SDK's own constructor validation reject it — that error
    // says "set OPENAI_API_KEY", which would send someone who never
    // touched that variable chasing the wrong fix.
    throw new Error('createDeepSeekModelCall: no apiKey given and DEEPSEEK_API_KEY is not set.')
  }

  const client =
    options.client ??
    new OpenAI({
      // Explicitly null, not undefined, if neither is set — the OpenAI
      // SDK's own constructor falls back to reading OPENAI_API_KEY itself
      // when apiKey is undefined (its normal, correct behavior for
      // createOpenAIModelCall), which here would silently authenticate
      // against DeepSeek with an OpenAI key if one happens to be set. The
      // guard above already rules out reaching here with no key at all,
      // but null (not undefined) is kept regardless so this line is
      // correct on its own, not just because of the guard before it.
      apiKey: options.apiKey ?? process.env.DEEPSEEK_API_KEY ?? null,
      baseURL: options.baseURL ?? 'https://api.deepseek.com',
    })
  const maxTokens = options.maxTokens ?? 4096

  return async (messages: Message[], system: string, tools: ToolSchema[]): Promise<ModelResponse> => {
    const response = await client.chat.completions.create({
      model: options.model,
      max_tokens: maxTokens,
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
