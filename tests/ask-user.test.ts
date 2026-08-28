import { describe, expect, it, vi } from 'vitest'
import { createAskUserTool, listQuestions, answerQuestion } from '#core/system-tools/index.js'

const CONTEXT = { agent: 'test-agent', sessionId: 'session-1' }

describe('createAskUserTool', () => {
  it('fires onPending synchronously with the question (tagged with agent/session), then resolves once answered', async () => {
    const onPending = vi.fn()
    const tool = createAskUserTool(CONTEXT, onPending)

    const result = tool.execute({ question: 'Which environment?', options: ['staging', 'production'] })

    expect(onPending).toHaveBeenCalledTimes(1)
    const question = onPending.mock.calls[0][0]
    expect(question).toMatchObject({
      question: 'Which environment?',
      options: ['staging', 'production'],
      agent: 'test-agent',
      sessionId: 'session-1',
    })
    expect(question.id).toBeTruthy()

    expect(answerQuestion(question.id, 'staging')).toBe(true)
    expect(await result).toBe('staging')
  })

  it('lists a pending question and removes it once answered', async () => {
    const tool = createAskUserTool(CONTEXT, () => {})
    const result = tool.execute({ question: 'Proceed?' })

    const pending = listQuestions()
    expect(pending.some((q) => q.question === 'Proceed?')).toBe(true)
    const id = pending.find((q) => q.question === 'Proceed?')!.id

    answerQuestion(id, 'yes')
    await result

    expect(listQuestions().some((q) => q.id === id)).toBe(false)
  })

  it('scopes listQuestions by agent and session, not just a global list', async () => {
    const toolA = createAskUserTool({ agent: 'agent-a', sessionId: 'session-a' }, () => {})
    const toolB = createAskUserTool({ agent: 'agent-b', sessionId: 'session-b' }, () => {})
    const resultA = toolA.execute({ question: 'from A' })
    const resultB = toolB.execute({ question: 'from B' })

    try {
      expect(listQuestions({ agent: 'agent-a' }).map((q) => q.question)).toEqual(['from A'])
      expect(listQuestions({ agent: 'agent-b' }).map((q) => q.question)).toEqual(['from B'])
      expect(listQuestions({ agent: 'agent-a', sessionId: 'session-a' }).map((q) => q.question)).toEqual(['from A'])
      expect(listQuestions({ agent: 'agent-a', sessionId: 'wrong-session' })).toEqual([])
    } finally {
      const idA = listQuestions({ agent: 'agent-a' })[0]!.id
      const idB = listQuestions({ agent: 'agent-b' })[0]!.id
      answerQuestion(idA, 'x')
      answerQuestion(idB, 'x')
      await resultA
      await resultB
    }
  })

  it('returns false from answerQuestion for an unknown or already-answered id', async () => {
    const tool = createAskUserTool(CONTEXT, () => {})
    const result = tool.execute({ question: 'Once only?' })
    const id = listQuestions().find((q) => q.question === 'Once only?')!.id

    expect(answerQuestion(id, 'yes')).toBe(true)
    expect(answerQuestion(id, 'yes')).toBe(false)
    expect(answerQuestion('nonexistent-id', 'yes')).toBe(false)
    await result
  })

  it('omits options entirely when the model gave none', async () => {
    const onPending = vi.fn()
    const tool = createAskUserTool(CONTEXT, onPending)
    const result = tool.execute({ question: 'No options here' })

    expect(onPending.mock.calls[0][0].options).toBeUndefined()

    const id = onPending.mock.calls[0][0].id
    answerQuestion(id, 'ok')
    await result
  })

  it('times out with a fixed sentinel answer if nobody responds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const tool = createAskUserTool(CONTEXT, () => {})
    const result = tool.execute({ question: 'Anyone there?' })

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000)

    expect(await result).toBe('(no answer — timed out)')
    vi.useRealTimers()
  })
})
