// Phase 14 tests: Conversation cache affinity + quota-aware sticky
import { describe, it, expect, beforeEach } from 'vitest'
import { AccountPool } from '../../src/main/proxy/accountPool'
import type { ProxyAccount } from '../../src/main/proxy/types'

function createAccount(id: string, overrides: Partial<ProxyAccount> = {}): ProxyAccount {
  return {
    id,
    email: `${id}@test.com`,
    isAvailable: true,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    subscriptionType: 'pro',
    ...overrides
  } as ProxyAccount
}

describe('Phase 14: Conversation Cache Affinity', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
    pool.addAccount(createAccount('acc-1'))
    pool.addAccount(createAccount('acc-2'))
    pool.addAccount(createAccount('acc-3'))
  })

  it('returns null for unknown conversation', () => {
    expect(pool.getConversationPreferred('conv-unknown')).toBeNull()
  })

  it('returns preferred account after recording affinity', () => {
    pool.recordConversationAffinity('conv-123', 'acc-2')
    expect(pool.getConversationPreferred('conv-123')).toBe('acc-2')
  })

  it('returns null when preferred account is unavailable', () => {
    pool.recordConversationAffinity('conv-123', 'acc-2')
    pool.updateAccount('acc-2', { isAvailable: false })
    expect(pool.getConversationPreferred('conv-123')).toBeNull()
  })

  it('returns null when preferred account quota > 85%', () => {
    pool.recordConversationAffinity('conv-123', 'acc-2')
    pool.updateAccount('acc-2', { quotaLimit: 100, quotaUsed: 90 })
    expect(pool.getConversationPreferred('conv-123')).toBeNull()
  })

  it('returns account when quota < 85%', () => {
    pool.recordConversationAffinity('conv-123', 'acc-2')
    pool.updateAccount('acc-2', { quotaLimit: 100, quotaUsed: 50 })
    expect(pool.getConversationPreferred('conv-123')).toBe('acc-2')
  })

  it('expires affinity after TTL', () => {
    pool.recordConversationAffinity('conv-old', 'acc-1')
    // Manually expire by accessing internal state
    const affinityMap = (pool as any).conversationAffinity as Map<string, any>
    const entry = affinityMap.get('conv-old')
    entry.lastAt = Date.now() - 11 * 60_000 // 11 minutes ago (TTL is 10)
    expect(pool.getConversationPreferred('conv-old')).toBeNull()
  })

  it('cleanup removes expired entries', () => {
    pool.recordConversationAffinity('conv-1', 'acc-1')
    pool.recordConversationAffinity('conv-2', 'acc-2')

    const affinityMap = (pool as any).conversationAffinity as Map<string, any>
    affinityMap.get('conv-1').lastAt = Date.now() - 11 * 60_000

    pool.cleanupConversationAffinity()
    expect(affinityMap.has('conv-1')).toBe(false)
    expect(affinityMap.has('conv-2')).toBe(true)
  })
})

describe('Phase 14: Quota-Aware Sticky Unstick', () => {
  let pool: AccountPool

  beforeEach(() => {
    pool = new AccountPool()
    pool.setStrategy('sticky')
    pool.addAccount(createAccount('acc-1', { quotaLimit: 100, quotaUsed: 0 }))
    pool.addAccount(createAccount('acc-2', { quotaLimit: 100, quotaUsed: 0 }))
  })

  it('shouldUnstick returns false when quota is low', () => {
    pool.updateAccount('acc-1', { quotaUsed: 50 })
    expect(pool.shouldUnstick()).toBe(false)
  })

  it('shouldUnstick returns true when quota > 85%', () => {
    // First make acc-1 the sticky account (index 0)
    const acc = pool.getNextAccount()
    expect(acc?.id).toBe('acc-1')
    pool.recordSuccess('acc-1') // stick to acc-1

    pool.updateAccount('acc-1', { quotaUsed: 90 })
    expect(pool.shouldUnstick()).toBe(true)
  })

  it('shouldUnstick returns false for non-sticky strategy', () => {
    pool.setStrategy('round-robin')
    pool.updateAccount('acc-1', { quotaUsed: 95 })
    expect(pool.shouldUnstick()).toBe(false)
  })

  it('forceUnstick advances pointer', () => {
    pool.getNextAccount() // acc-1
    pool.recordSuccess('acc-1') // stick to index 0
    pool.updateAccount('acc-1', { quotaUsed: 90 })

    pool.forceUnstick()
    const next = pool.getNextAccount()
    expect(next?.id).toBe('acc-2')
  })

  it('auto-unsticks during getNextAccount when quota high', () => {
    pool.getNextAccount() // acc-1 selected
    pool.recordSuccess('acc-1') // stick to acc-1
    pool.updateAccount('acc-1', { quotaUsed: 90 })

    // Next call should unstick and move to acc-2
    const next = pool.getNextAccount()
    expect(next?.id).toBe('acc-2')
  })
})
