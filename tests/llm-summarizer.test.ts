import { describe, expect, it, vi } from 'vitest'
import { LLMSummarizer } from '#core/llm-summarizer.js'
import type { ModelCall, ModelResponse } from '#core/run-agent.js'
import type { Message } from '#core/budget.js'

function textResponse(text: string): ModelResponse {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text }] }
}

const oldMessages: Message[] = [
  { role: 'user', content: 'my order number is ORD-4471, it never arrived' },
  { role: 'assistant', content: 'Sorry to hear that — checking now.' },
]

describe('LLMSummarizer', () => {
  it('calls modelCall with the flattened transcript and no tools, and wraps the response text', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('Facts established: order ORD-4471 never arrived.'))

    const summarizer = new LLMSummarizer({ modelCall })
    const result = await summarizer.summarize(oldMessages)

    expect(modelCall).toHaveBeenCalledTimes(1)
    const [messages, system, tools] = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(tools).toEqual([])
    expect(system).toContain('Facts established')
    expect(messages).toEqual([{ role: 'user', content: expect.stringContaining('ORD-4471') }])

    expect(result.role).toBe('system')
    expect(result.content).toContain('[compacted 2 earlier message(s)]')
    expect(result.content).toContain('order ORD-4471 never arrived')
  })

  it('accepts a custom systemPrompt override', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('summary'))
    const summarizer = new LLMSummarizer({ modelCall, systemPrompt: 'custom instructions' })
    await summarizer.summarize(oldMessages)

    const [, system] = (modelCall as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(system).toBe('custom instructions')
  })

  it('falls back to truncation when modelCall throws', async () => {
    const modelCall: ModelCall = vi.fn(async () => {
      throw new Error('rate limited')
    })

    const summarizer = new LLMSummarizer({ modelCall })
    const result = await summarizer.summarize(oldMessages)

    expect(result.role).toBe('system')
    expect(result.content).toContain('[compacted 2 earlier message(s)]')
    expect(result.content).toContain('ORD-4471')
  })

  it('falls back to truncation when modelCall returns no text block', async () => {
    const modelCall: ModelCall = vi.fn(async () => ({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'noop', input: {} }],
    }))

    const summarizer = new LLMSummarizer({ modelCall })
    const result = await summarizer.summarize(oldMessages)

    expect(result.content).toContain('[compacted 2 earlier message(s)]')
  })

  it('falls back to truncation when modelCall returns blank text', async () => {
    const modelCall: ModelCall = vi.fn(async () => textResponse('   '))

    const summarizer = new LLMSummarizer({ modelCall })
    const result = await summarizer.summarize(oldMessages)

    expect(result.content).toContain('[compacted 2 earlier message(s)]')
  })
})
