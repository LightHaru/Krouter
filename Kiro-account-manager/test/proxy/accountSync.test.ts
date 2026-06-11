import { describe, expect, it } from 'vitest'
import { mergePeerAccountData } from '../../src/server/services/accountSync'

function account(id: string, email: string, provider = 'BuilderId', refreshToken = `rt-${id}`, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    email,
    idp: provider,
    credentials: {
      provider,
      refreshToken,
      accessToken: `at-${id}`,
      csrfToken: '',
      expiresAt: Date.now() + 3600000
    },
    subscription: { type: 'Free' },
    usage: { current: 0, limit: 50, percentUsed: 0, lastUpdated: Date.now() },
    tags: [],
    status: 'active',
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    isActive: false,
    ...extra
  }
}

describe('mergePeerAccountData', () => {
  it('adds new local accounts to remote data', () => {
    const result = mergePeerAccountData(
      { accounts: {}, groups: {}, tags: {} },
      { accounts: { a1: account('a1', 'one@example.com') }, groups: {}, tags: {} }
    )

    expect(result.added).toBe(1)
    expect(result.skipped).toBe(0)
    expect(result.addedAccountIds).toEqual(['a1'])
    expect(result.skippedAccountIds).toEqual([])
    expect(result.syncedAccountIds).toEqual(['a1'])
    expect(Object.keys(result.data.accounts as Record<string, unknown>)).toEqual(['a1'])
  })

  it('skips accounts already present by email/provider', () => {
    const remote = { accounts: { r1: account('r1', 'same@example.com', 'BuilderId', 'remote-rt') }, groups: {}, tags: {} }
    const local = { accounts: { l1: account('l1', 'same@example.com', 'BuilderId', 'local-rt') }, groups: {}, tags: {} }
    const result = mergePeerAccountData(remote, local)

    expect(result.added).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.addedAccountIds).toEqual([])
    expect(result.skippedAccountIds).toEqual(['l1'])
    expect(result.syncedAccountIds).toEqual(['l1'])
    expect(result.skippedAccounts[0]).toMatchObject({ id: 'l1', email: 'same@example.com', existingId: 'r1', reason: 'account_exists' })
    expect(Object.keys(result.data.accounts as Record<string, unknown>)).toEqual(['r1'])
  })

  it('skips accounts already present by refresh token or api key', () => {
    const remote = {
      accounts: {
        r1: account('r1', 'refresh@example.com', 'BuilderId', 'same-refresh'),
        r2: account('r2', 'api@example.com', 'KiroApiKey', '', { credentials: { provider: 'KiroApiKey', kiroApiKey: 'ksk_same', accessToken: 'ksk_same', csrfToken: '', expiresAt: 0 } })
      },
      groups: {},
      tags: {}
    }
    const local = {
      accounts: {
        l1: account('l1', 'other@example.com', 'BuilderId', 'same-refresh'),
        l2: account('l2', 'other-api@example.com', 'KiroApiKey', '', { credentials: { provider: 'KiroApiKey', kiroApiKey: 'ksk_same', accessToken: 'ksk_same', csrfToken: '', expiresAt: 0 } })
      },
      groups: {},
      tags: {}
    }
    const result = mergePeerAccountData(remote, local)

    expect(result.added).toBe(0)
    expect(result.skipped).toBe(2)
    expect(result.addedAccountIds).toEqual([])
    expect(result.skippedAccountIds).toEqual(['l1', 'l2'])
    expect(result.syncedAccountIds).toEqual(['l1', 'l2'])
    expect(Object.keys(result.data.accounts as Record<string, unknown>).sort()).toEqual(['r1', 'r2'])
  })

  it('does not treat the fixed placeholder profileArn as a duplicate identity', () => {
    const placeholderArn = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
    const remote = {
      accounts: {
        r1: account('r1', 'existing@example.com', 'BuilderId', 'remote-rt', { profileArn: placeholderArn })
      },
      groups: {},
      tags: {}
    }
    const local = {
      accounts: {
        l1: account('l1', 'new@example.com', 'BuilderId', 'local-rt', { profileArn: placeholderArn })
      },
      groups: {},
      tags: {}
    }
    const result = mergePeerAccountData(remote, local)

    expect(result.added).toBe(1)
    expect(result.skipped).toBe(0)
    expect(result.addedAccountIds).toEqual(['l1'])
    expect(result.skippedAccountIds).toEqual([])
    expect(result.syncedAccountIds).toEqual(['l1'])
    expect(Object.keys(result.data.accounts as Record<string, unknown>).sort()).toEqual(['l1', 'r1'])
  })
})
