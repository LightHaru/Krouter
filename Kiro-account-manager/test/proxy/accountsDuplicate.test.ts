import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '../../src/renderer/src/types/account'
import { isPlaceholderProfileArn, useAccountsStore } from '../../src/renderer/src/store/accounts'

const PLACEHOLDER_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'

function accountData(
  email: string,
  refreshToken: string,
  profileArn = PLACEHOLDER_PROFILE_ARN
): Omit<Account, 'id' | 'createdAt' | 'isActive'> {
  return {
    email,
    idp: 'BuilderId',
    profileArn,
    credentials: {
      provider: 'BuilderId',
      accessToken: `at-${refreshToken}`,
      csrfToken: '',
      refreshToken,
      expiresAt: Date.now() + 3600000
    },
    subscription: { type: 'Free' },
    usage: { current: 0, limit: 50, percentUsed: 0, lastUpdated: Date.now() },
    tags: [],
    status: 'active',
    lastUsedAt: Date.now()
  }
}

describe('account duplicate detection', () => {
  beforeEach(() => {
    useAccountsStore.setState({
      accounts: new Map(),
      groups: new Map(),
      tags: new Map(),
      activeAccountId: null,
      saveToStorage: vi.fn(async () => {})
    })
  })

  it('does not treat the fixed placeholder profileArn as a duplicate identity', () => {
    const firstId = useAccountsStore.getState().addAccount(
      accountData('existing@example.com', 'rt-existing')
    )
    const secondId = useAccountsStore.getState().addAccount(
      accountData('new@example.com', 'rt-new')
    )

    expect(secondId).not.toBe(firstId)
    expect(useAccountsStore.getState().accounts.size).toBe(2)
    expect(Array.from(useAccountsStore.getState().accounts.values()).map((account) => account.email).sort()).toEqual([
      'existing@example.com',
      'new@example.com'
    ])
  })

  it('still skips real duplicates by email/provider and refresh token', () => {
    const firstId = useAccountsStore.getState().addAccount(
      accountData('existing@example.com', 'rt-existing')
    )
    const duplicateEmailId = useAccountsStore.getState().addAccount(
      accountData('existing@example.com', 'rt-other')
    )
    const duplicateRefreshId = useAccountsStore.getState().addAccount(
      accountData('other@example.com', 'rt-existing')
    )

    expect(duplicateEmailId).toBe(firstId)
    expect(duplicateRefreshId).toBe(firstId)
    expect(useAccountsStore.getState().accounts.size).toBe(1)
  })

  it('recognizes empty and placeholder profileArn values as non-identities', () => {
    expect(isPlaceholderProfileArn('')).toBe(true)
    expect(isPlaceholderProfileArn(PLACEHOLDER_PROFILE_ARN)).toBe(true)
    expect(isPlaceholderProfileArn('placeholder-profile')).toBe(true)
    expect(isPlaceholderProfileArn('arn:aws:codewhisperer:us-east-1:123456789012:profile/real')).toBe(false)
  })
})
