import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { createDeepSeekModelCall } from '../core/model-calls/deepseek-model-call.js'
import { runAgent, type ModelCall } from '#core/run-agent.js'
import type { AgentConfig } from '#core/agent-config.js'

/** Stubbed fetch, not a live call — same approach as
 * openai-model-call.test.ts. DeepSeek's Chat Completions API is wire-
 * compatible with OpenAI's, so createDeepSeekModelCall is built on the
 * real `openai` SDK client, just pointed at DeepSeek's base URL. */
function stubClient(responses: unknown[]): { client: OpenAI; requests: unknown[] } {
  const requests: unknown[] = []
  let call = 0
  const fetchStub = (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string))
    const body = responses[call]
    call++
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  return { client: new OpenAI({ apiKey: 'test-key', baseURL: 'https://api.deepseek.com', fetch: fetchStub }), requests }
}

function chatCompletion(finishReason: string, message: Record<string, unknown>) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'deepseek-test',
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', ...message } }],
  }
}

describe('createDeepSeekModelCall', () => {
  it('throws a DeepSeek-specific error rather than silently falling back to OPENAI_API_KEY', () => {
    const originalOpenAIKey = process.env.OPENAI_API_KEY
    const originalDeepSeekKey = process.env.DEEPSEEK_API_KEY
    process.env.OPENAI_API_KEY = 'sk-openai-should-not-leak-into-deepseek'
    delete process.env.DEEPSEEK_API_KEY

    try {
      expect(() => createDeepSeekModelCall({ model: 'deepseek-test' })).toThrow(/DEEPSEEK_API_KEY/)
    } finally {
      if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalOpenAIKey
      if (originalDeepSeekKey === undefined) delete process.env.DEEPSEEK_API_KEY
      else process.env.DEEPSEEK_API_KEY = originalDeepSeekKey
    }
  })

  it('translates system prompt, messages, and tool schemas into the request, using max_tokens not max_completion_tokens', async () => {
    const { client, requests } = stubClient([chatCompletion('stop', { content: 'hi' })])
    const modelCall: ModelCall = createDeepSeekModelCall({ model: 'deepseek-test', client })

    await modelCall(
      [{ role: 'user', content: 'hello' }],
      'You are a test agent.',
      [{ name: 'echo', description: 'Echoes input', input_schema: { type: 'object', properties: {} } }],
    )

    const request = requests[0] as Record<string, unknown>
    expect(request).toMatchObject({
      model: 'deepseek-test',
      max_tokens: 4096,
      messages: [
        { role: 'system', content: 'You are a test agent.' },
        { role: 'user', content: 'hello' },
      ],
      tools: [{ type: 'function', function: { name: 'echo', description: 'Echoes input', parameters: { type: 'object', properties: {} } } }],
    })
    // DeepSeek's docs don't list this field at all — asserting its
    // absence, not just max_tokens's presence, is what actually catches
    // a regression back to openai-model-call.ts's field name.
    expect(request.max_completion_tokens).toBeUndefined()
  })

  it('normalizes stop_reason: tool_calls -> tool_use, stop -> end_turn (shared with createOpenAIModelCall)', async () => {
    const { client } = stubClient([chatCompletion('tool_calls', { content: null, tool_calls: [] })])
    const modelCall: ModelCall = createDeepSeekModelCall({ model: 'deepseek-test', client })
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
    const modelCall: ModelCall = createDeepSeekModelCall({ model: 'deepseek-test', client })

    const config: AgentConfig = {
      name: 'deepseek-check',
      systemPrompt: 'You are a test agent.',
      tools: [
        {
          name: 'lookup_order',
          description: "Look up an order's status",
          input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
          execute: async () => ({ status: 'delivered' }),
        },
      ],
      rules: [{ scopePattern: 'default/production/deepseek-check', tool: 'lookup_order', decision: 'allow' }],
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
