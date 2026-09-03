import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { createKimiModelCall } from '../core/model-calls/kimi-model-call.js'
import { runAgent, type ModelCall } from '#core/run-agent.js'
import type { AgentConfig } from '#core/agent-config.js'

/** Stubbed fetch, not a live call — same approach as
 * deepseek-model-call.test.ts. Kimi (Moonshot AI)'s Chat Completions API
 * is wire-compatible with OpenAI's, so createKimiModelCall is built on
 * the real `openai` SDK client, just pointed at Moonshot's base URL. */
function stubClient(responses: unknown[]): { client: OpenAI; requests: unknown[] } {
  const requests: unknown[] = []
  let call = 0
  const fetchStub = (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string))
    const body = responses[call]
    call++
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  return { client: new OpenAI({ apiKey: 'test-key', baseURL: 'https://api.moonshot.ai/v1', fetch: fetchStub }), requests }
}

function chatCompletion(finishReason: string, message: Record<string, unknown>) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'kimi-test',
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', ...message } }],
  }
}

describe('createKimiModelCall', () => {
  it('throws a Kimi-specific error rather than silently falling back to OPENAI_API_KEY', () => {
    const originalOpenAIKey = process.env.OPENAI_API_KEY
    const originalMoonshotKey = process.env.MOONSHOT_API_KEY
    process.env.OPENAI_API_KEY = 'sk-openai-should-not-leak-into-kimi'
    delete process.env.MOONSHOT_API_KEY

    try {
      expect(() => createKimiModelCall({ model: 'kimi-test' })).toThrow(/MOONSHOT_API_KEY/)
    } finally {
      if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalOpenAIKey
      if (originalMoonshotKey === undefined) delete process.env.MOONSHOT_API_KEY
      else process.env.MOONSHOT_API_KEY = originalMoonshotKey
    }
  })

  it('translates system prompt, messages, and tool schemas into the request, using max_completion_tokens not max_tokens', async () => {
    const { client, requests } = stubClient([chatCompletion('stop', { content: 'hi' })])
    const modelCall: ModelCall = createKimiModelCall({ model: 'kimi-test', client })

    await modelCall(
      [{ role: 'user', content: 'hello' }],
      'You are a test agent.',
      [{ name: 'echo', description: 'Echoes input', input_schema: { type: 'object', properties: {} } }],
    )

    const request = requests[0] as Record<string, unknown>
    expect(request).toMatchObject({
      model: 'kimi-test',
      max_completion_tokens: 4096,
      messages: [
        { role: 'system', content: 'You are a test agent.' },
        { role: 'user', content: 'hello' },
      ],
      tools: [{ type: 'function', function: { name: 'echo', description: 'Echoes input', parameters: { type: 'object', properties: {} } } }],
    })
    // Moonshot's docs use the newer field, unlike DeepSeek's — asserting
    // max_tokens's absence, not just max_completion_tokens's presence, is
    // what actually catches a regression back to the older field name.
    expect(request.max_tokens).toBeUndefined()
  })

  it('normalizes stop_reason: tool_calls -> tool_use, stop -> end_turn (shared with createOpenAIModelCall)', async () => {
    const { client } = stubClient([chatCompletion('tool_calls', { content: null, tool_calls: [] })])
    const modelCall: ModelCall = createKimiModelCall({ model: 'kimi-test', client })
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
    const modelCall: ModelCall = createKimiModelCall({ model: 'kimi-test', client })

    const config: AgentConfig = {
      name: 'kimi-check',
      systemPrompt: 'You are a test agent.',
      tools: [
        {
          name: 'lookup_order',
          description: "Look up an order's status",
          input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
          execute: async () => ({ status: 'delivered' }),
        },
      ],
      rules: [{ scopePattern: 'default/production/kimi-check', tool: 'lookup_order', decision: 'allow' }],
      defaultDecision: 'deny',
    }

    const result = await runAgent(config, modelCall, 'is order A-1001 delivered?', [])

    expect(result.text).toBe('Order delivered.')
    // The system prompt gets an "Available skills" section appended
    // because system-skills/composio-large-outputs is always merged in
    // (see run-agent.ts's systemSkillsDir).
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
