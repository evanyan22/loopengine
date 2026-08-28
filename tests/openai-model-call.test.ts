import OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { createOpenAIModelCall } from '../core/model-calls/openai-model-call.js'
import { runAgent, type ModelCall } from '#core/run-agent.js'
import type { AgentConfig } from '#core/agent-config.js'

/** Stubbed fetch, not a live call — same approach as
 * anthropic-model-call.test.ts, captures the exact request body sent to
 * the OpenAI API and returns a scripted Chat Completions response. */
function stubClient(responses: unknown[]): { client: OpenAI; requests: unknown[] } {
  const requests: unknown[] = []
  let call = 0
  const fetchStub = (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(init.body as string))
    const body = responses[call]
    call++
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  return { client: new OpenAI({ apiKey: 'test-key', fetch: fetchStub }), requests }
}

function chatCompletion(finishReason: string, message: Record<string, unknown>) {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'gpt-test',
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', ...message } }],
  }
}

describe('createOpenAIModelCall', () => {
  it('translates system prompt, messages, and tool schemas into the request', async () => {
    const { client, requests } = stubClient([chatCompletion('stop', { content: 'hi' })])
    const modelCall: ModelCall = createOpenAIModelCall({ model: 'gpt-test', client })

    await modelCall(
      [{ role: 'user', content: 'hello' }],
      'You are a test agent.',
      [{ name: 'echo', description: 'Echoes input', input_schema: { type: 'object', properties: {} } }],
    )

    expect(requests[0]).toMatchObject({
      model: 'gpt-test',
      messages: [
        { role: 'system', content: 'You are a test agent.' },
        { role: 'user', content: 'hello' },
      ],
      tools: [{ type: 'function', function: { name: 'echo', description: 'Echoes input', parameters: { type: 'object', properties: {} } } }],
    })
  })

  it('normalizes stop_reason: tool_calls -> tool_use, stop -> end_turn', async () => {
    const { client } = stubClient([chatCompletion('tool_calls', { content: null, tool_calls: [] })])
    const modelCall: ModelCall = createOpenAIModelCall({ model: 'gpt-test', client })
    const response = await modelCall([{ role: 'user', content: 'hi' }], 'sys', [])
    expect(response.stop_reason).toBe('tool_use')
  })

  it('expands one turn of tool_result blocks into separate role: tool messages, and round-trips a tool call', async () => {
    const { client, requests } = stubClient([
      chatCompletion('tool_calls', {
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup_order', arguments: '{"orderId":"A-1001"}' } }],
      }),
      chatCompletion('stop', { content: 'Order delivered.' }),
    ])
    const modelCall: ModelCall = createOpenAIModelCall({ model: 'gpt-test', client })

    const config: AgentConfig = {
      name: 'openai-check',
      systemPrompt: 'You are a test agent.',
      tools: [
        {
          name: 'lookup_order',
          description: "Look up an order's status",
          input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
          execute: async () => ({ status: 'delivered' }),
        },
      ],
      rules: [{ scopePattern: 'default/production/openai-check', tool: 'lookup_order', decision: 'allow' }],
      defaultDecision: 'deny',
    }

    const result = await runAgent(config, modelCall, 'is order A-1001 delivered?', [])

    expect(result.text).toBe('Order delivered.')

    // Bundled loopengine-side as one user-role tool_result message, but
    // must arrive at OpenAI as its own top-level role: 'tool' message,
    // linked back by tool_call_id — the structural mismatch this file's
    // toMessageParams exists to bridge.
    // The system prompt gets an "Available skills" section appended
    // because system-skills/composio-large-outputs is always merged in
    // (see run-agent.ts's systemSkillsDir) — unrelated to this test, but
    // unavoidable without skillsDirs: [], which still wouldn't hide it.
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
