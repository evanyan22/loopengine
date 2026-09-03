// A sixth real ModelCall implementation. Google's own OpenAI-compatible
// endpoint for Gemini (ai.google.dev/gemini-api/docs/openai) supports the
// same messages/tools/tool_choice request shape and tool_calls response
// shape as OpenAI's Chat Completions API, so this reuses
// openai-model-call.ts's translation verbatim via the real `openai` SDK
// client, same pattern deepseek/kimi/glm-model-call.ts already
// established — rather than a bespoke native @google/genai integration
// (Gemini's own SDK has a meaningfully different message-role/content-
// parts/function-calling shape).
//
// Caveat, from Google's own docs: "Support for the OpenAI libraries is
// still in beta while we extend feature support" — this is the one
// provider here riding a compatibility layer its own vendor calls beta,
// not a fully stable wire contract the way DeepSeek/Kimi/GLM's own docs
// present theirs. Uses `max_completion_tokens`, same as Kimi/GLM.
//
// The trailing slash on the base URL matters — Google's endpoint 404s
// without it (confirmed against their own docs' exact example URL).
import OpenAI from 'openai'
import type { ToolSchema } from '#core/agent-config.js'
import type { Message, ModelCall, ModelResponse } from '#core/run-agent.js'
import { toMessageParams, toModelResponse } from './openai-model-call.js'

export interface GeminiModelCallOptions {
  /** Defaults to the GEMINI_API_KEY env var. */
  apiKey?: string
  /** No hardcoded default — same reasoning as OpenAIModelCallOptions.model:
   * pass the one you actually want. */
  model: string
  maxTokens?: number
  /** Defaults to Google's own OpenAI-compatible endpoint — override to
   * point at a proxy/mirror. Trailing slash required (see this file's
   * own header comment). */
  baseURL?: string
  /** Inject a pre-configured client instead of building one from apiKey/baseURL — e.g. to pass a custom `fetch` in tests. */
  client?: OpenAI
}

export function createGeminiModelCall(options: GeminiModelCallOptions): ModelCall {
  if (!options.client && !options.apiKey && !process.env.GEMINI_API_KEY) {
    // Fails here, with a Gemini-specific message, rather than letting the
    // OpenAI SDK's own constructor validation reject it — that error says
    // "set OPENAI_API_KEY", which would send someone who never touched
    // that variable chasing the wrong fix.
    throw new Error('createGeminiModelCall: no apiKey given and GEMINI_API_KEY is not set.')
  }

  const client =
    options.client ??
    new OpenAI({
      // Explicitly null, not undefined, if neither is set — see
      // kimi-model-call.ts's identical comment for why this matters even
      // though the guard above already rules out reaching here with no
      // key at all.
      apiKey: options.apiKey ?? process.env.GEMINI_API_KEY ?? null,
      baseURL: options.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta/openai/',
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
