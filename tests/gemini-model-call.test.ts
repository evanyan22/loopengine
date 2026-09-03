import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { createGeminiModelCall } from '../core/model-calls/gemini-model-call.js'
import { runAgent, type ModelCall } from '#core/run-agent.js'
import type { AgentConfig } from '#core/agent-config.js'

/** Stubbed fetch, not a live call — same approach as
 * deepseek-model-call.test.ts. Google's own OpenAI-compatible endpoint
 * for Gemini is what createGeminiModelCall is built on, via the real
 * `openai` SDK client pointed at Google's base URL. */
function stubClient(responses: unknown[]): { client: OpenAI; requests: unknown[] } {
  const requests: unknown[] = []
  let call = 0
  const fetchStub = (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string))
    const body = responses[call]
    call++
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  return {
    client: new OpenAI({ apiKey: 'test-key', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/', fetch: fetchStub }),
    requests,
  }
}

function chatCompletion(finishReason: string, message: Record<string, unknown>) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'gemini-test',
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', ...message } }],
  }
}

describe('createGeminiModelCall', () => {
  it('throws a Gemini-specific error rather than silently falling back to OPENAI_API_KEY', () => {
    const originalOpenAIKey = process.env.OPENAI_API_KEY
    const originalGeminiKey = process.env.GEMINI_API_KEY
    process.env.OPENAI_API_KEY = 'sk-openai-should-not-leak-into-gemini'
    delete process.env.GEMINI_API_KEY

    try {
      expect(() => createGeminiModelCall({ model: 'gemini-test' })).toThrow(/GEMINI_API_KEY/)
    } finally {
      if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalOpenAIKey
      if (originalGeminiKey === undefined) delete process.env.GEMINI_API_KEY
      else process.env.GEMINI_API_KEY = originalGeminiKey
    }
  })

  it('translates system prompt, messages, and tool schemas into the request, using max_completion_tokens not max_tokens', async () => {
    const { client, requests } = stubClient([chatCompletion('stop', { content: 'hi' })])
    const modelCall: ModelCall = createGeminiModelCall({ model: 'gemini-test', client })

    await modelCall(
      [{ role: 'user', content: 'hello' }],
      'You are a test agent.',
      [{ name: 'echo', description: 'Echoes input', input_schema: { type: 'object', properties: {} } }],
    )

    const request = requests[0] as Record<string, unknown>
    expect(request).toMatchObject({
      model: 'gemini-test',
      max_completion_tokens: 4096,
      messages: [
        { role: 'system', content: 'You are a test agent.' },
        { role: 'user', content: 'hello' },
      ],
      tools: [{ type: 'function', function: { name: 'echo', description: 'Echoes input', parameters: { type: 'object', properties: {} } } }],
    })
    expect(request.max_tokens).toBeUndefined()
  })

  it('normalizes stop_reason: tool_calls -> tool_use, stop -> end_turn (shared with createOpenAIModelCall)', async () => {
    const { client } = stubClient([chatCompletion('tool_calls', { content: null, tool_calls: [] })])
    const modelCall: ModelCall = createGeminiModelCall({ model: 'gemini-test', client })
    const response = await modelCall([{ role: 'user', content: 'hi' }], 'sys', [])
    expect(response.stop_reason).toBe('tool_use')
  })

  it('round-trips a tool call end to end through runAgent', async () => {
    const { client, requests } = stubClient([
      chatCompletion('tool_calls', {
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"orderId":"A-1001"}' } }],
      }),
      chatCompletion('stop', { content: 'Order delivered.' }),
    ])
    const modelCall: ModelCall = createGeminiModelCall({ model: 'gemini-test', client })

    const config: AgentConfig = {
      name: 'gemini-check',
      systemPrompt: 'You are a test agent.',
      tools: [
        {
          name: 'lookup_order',
          description: "Look up an order's status",
          input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
          execute: async () => ({ status: 'delivered' }),
        },
      ],
      rules: [{ scopePattern: 'default/production/gemini-check', tool: 'lookup_order', decision: 'allow' }],
      defaultDecision: 'deny',
    }

    const result = await runAgent(config, modelCall, 'is order A-1001 delivered?', [])

    expect(result.text).toBe('Order delivered.')
    expect(requests[1]).toMatchObject({
      messages: [
        {
          role: 'system',
          content:
            "You are a test agent.\n\nAvailable skills:\n- composio-large-outputs: How to retrieve a gateway tool's real output when its result says storedInFile is true instead of returning the data inline.",
        },
        { role: 'user', content: 'is order A-1001 delivered?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"orderId":"A-1001"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"status":"delivered"}' },
      ],
    })
  })
})
