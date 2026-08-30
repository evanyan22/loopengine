import { describe, expect, it, vi } from 'vitest'
import { DatabaseApprover, InMemoryPendingApprovalsRepository } from '#core/http-notify-triggers/database.js'

describe('DatabaseApprover', () => {
  it('inserts a row and returns a pendingId immediately, before the insert settles', async () => {
    const repository = new InMemoryPendingApprovalsRepository()
    const approver = new DatabaseApprover(repository)

    const { pendingId } = approver.requestDurableApproval(
      'issue_refund',
      { amount: 50 },
      { tenant: 'acme', environment: 'production', agent: 'support' },
      'ask rule',
    )

    expect(typeof pendingId).toBe('string')
    await vi.waitFor(() => expect(repository.rows).toHaveLength(1))
    expect(repository.rows[0]).toMatchObject({
      pendingId,
      tool: 'issue_refund',
      args: { amount: 50 },
      scope: { tenant: 'acme', environment: 'production', agent: 'support' },
      reason: 'ask rule',
    })
  })

  it('logs, rather than throws, when the repository insert rejects', async () => {
    const failingRepository = { insert: async () => Promise.reject(new Error('db down')) }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const approver = new DatabaseApprover(failingRepository)

    const { pendingId } = approver.requestDurableApproval('issue_refund', {}, { tenant: 'acme', environment: 'production', agent: 'support' }, 'ask rule')

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(expect.stringContaining(`insert failed for pendingId '${pendingId}'`), expect.any(Error)))
  })
})
