// A fourth real ModelCall implementation. Kimi (Moonshot AI)'s Chat
// Completions API is wire-compatible with OpenAI's — confirmed against
// Moonshot's own docs (platform.kimi.ai/docs/api/chat): same messages/
// tools/tool_choice request shape, same tool_calls response shape — so
// this reuses openai-model-call.ts's message/response translation
// verbatim via the real `openai` SDK client, just pointed at Moonshot's
// base URL, rather than duplicating that logic. Same pattern
// deepseek-model-call.ts already established for a third provider.
//
// Unlike DeepSeek, Moonshot's docs use the newer `max_completion_tokens`
// field (matching the current OpenAI SDK) rather than the deprecated
// `max_tokens` DeepSeek's own docs still list — decided at the request-
// building call site below, since toMessageParams/toModelResponse don't
// touch that field either way.
//
// Env var is MOONSHOT_API_KEY, not KIMI_API_KEY, despite every other
// provider here matching its own literal exactly — deliberate: this
// matches the underlying API/company's own docs and what anyone
// copy-pasting from Moonshot's own examples already has set, not this
// package's own provider name.
import OpenAI from 'openai'
import type { ToolSchema } from '#core/agent-config.js'
import type { Message, ModelCall, ModelResponse } from '#core/run-agent.js'
import { toMessageParams, toModelResponse } from './openai-model-call.js'

export interface KimiModelCallOptions {
  /** Defaults to the MOONSHOT_API_KEY env var. */
  apiKey?: string
  /** No hardcoded default — same reasoning as OpenAIModelCallOptions.model:
   * pass the one you actually want. */
  model: string
  maxTokens?: number
  /** Defaults to Moonshot's own API — override to point at a proxy/mirror. */
  baseURL?: string
  /** Inject a pre-configured client instead of building one from apiKey/baseURL — e.g. to pass a custom `fetch` in tests. */
  client?: OpenAI
}

export function createKimiModelCall(options: KimiModelCallOptions): ModelCall {
  if (!options.client && !options.apiKey && !process.env.MOONSHOT_API_KEY) {
    // Fails here, with a Kimi-specific message, rather than letting the
    // OpenAI SDK's own constructor validation reject it — that error says
    // "set OPENAI_API_KEY", which would send someone who never touched
    // that variable chasing the wrong fix.
    throw new Error('createKimiModelCall: no apiKey given and MOONSHOT_API_KEY is not set.')
  }

  const client =
    options.client ??
    new OpenAI({
      // Explicitly null, not undefined, if neither is set — the OpenAI
      // SDK's own constructor falls back to reading OPENAI_API_KEY itself
      // when apiKey is undefined (its normal, correct behavior for
      // createOpenAIModelCall), which here would silently authenticate
      // against Moonshot with an OpenAI key if one happens to be set. The
      // guard above already rules out reaching here with no key at all,
      // but null (not undefined) is kept regardless so this line is
      // correct on its own, not just because of the guard before it.
      apiKey: options.apiKey ?? process.env.MOONSHOT_API_KEY ?? null,
      baseURL: options.baseURL ?? 'https://api.moonshot.ai/v1',
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
