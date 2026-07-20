import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProxyServer } from '../../src/main/proxy/proxyServer'
import { normalizeKiroModelIdForCompare } from '../../src/main/proxy/modelCatalog'

// Mock fetchKiroModels so capability checks never hit the network
const { mockFetchKiroModels } = vi.hoisted(() => ({
  mockFetchKiroModels: vi.fn()
}))

vi.mock('../../src/main/proxy/kiroApi', async (importActual) => {
  const actual = await importActual<typeof import('../../src/main/proxy/kiroApi')>()
  return {
    ...actual,
    fetchKiroModels: mockFetchKiroModels
  }
})

describe('ProxyServer tier routing — Real-world pool (118 Free + 1 Enterprise)', () => {
  function createServer(): any {
    return new ProxyServer({ enableMultiAccount: true, tierRoutingEnabled: true }) as any
  }

  function addAccount(ps: any, id: string, email: string, tier: string): any {
    const account: any = {
      id,
      email,
      accessToken: 'tok',
      refreshToken: undefined,
      errorCount: 0,
      groupId: undefined,
      subscriptionType: tier
    }
    ps.accountPool.addAccount(account)
    return account
  }

  function seedCapability(ps: any, id: string, modelId: string): void {
    ps.accountModelCapabilityCache.set(id, {
      timestamp: Date.now(),
      modelIds: new Set([normalizeKiroModelIdForCompare(modelId)])
    })
  }

  beforeEach(() => {
    mockFetchKiroModels.mockReset()
    // Never fetch (all accounts pre-seeded)
    mockFetchKiroModels.mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('Premium model (Opus): selects the 1 Enterprise account, never probes any Free account', async () => {
    const ps = createServer()
    const modelId = 'claude-opus-4.8'

    // Add 118 Free accounts
    for (let i = 0; i < 118; i++) {
      addAccount(ps, `free-${i}`, `free${i}@test`, 'Free')
      // Deliberately leave Free accounts WITHOUT capability cache for this model
      // (so if tier routing leaked, a probe WOULD happen and be visible via mock)
    }

    // Add 1 Enterprise account with capability support
    const enterprise = addAccount(ps, 'enterprise-1', 'enterprise1@test', 'Enterprise')
    seedCapability(ps, enterprise.id, modelId)

    mockFetchKiroModels.mockClear()

    // Act: select account for premium model
    const selected = await ps.getNextAccountForModel(new Set(), undefined, modelId)

    // Assert: selected the Enterprise account
    expect(selected).not.toBeNull()
    expect(selected?.id).toBe('enterprise-1')
    expect(ps.subscriptionTierOf(selected)).toBe('paid')

    // Assert: no Free account was ever probed (mockFetchKiroModels never called with a Free account)
    for (const call of mockFetchKiroModels.mock.calls) {
      const probed = call[0]
      expect(probed?.subscriptionType).not.toBe('Free')
    }

    // Assert: tier pre-filter excluded all 118 Free accounts
    // (we can't directly inspect the log in this test, but the selection proves it)
    console.log(`[Test] Pool: 118 Free + 1 Enterprise → Selected: ${selected?.email} (${ps.subscriptionTierOf(selected)} tier)`)
  })

  it('Standard model (Sonnet): prefers Free accounts, Enterprise is last resort', async () => {
    const ps = createServer()
    const modelId = 'claude-sonnet-4.5'

    // Add 118 Free accounts (all available, no capability check needed for standard models)
    const freeAccounts = []
    for (let i = 0; i < 118; i++) {
      const acc = addAccount(ps, `free-${i}`, `free${i}@test`, 'Free')
      freeAccounts.push(acc)
    }

    // Add 1 Enterprise account
    const enterprise = addAccount(ps, 'enterprise-1', 'enterprise1@test', 'Enterprise')

    // Act: select account for standard model
    const selected = await ps.getNextAccountForModel(new Set(), undefined, modelId)

    // Assert: selected a Free account (NOT the Enterprise account)
    expect(selected).not.toBeNull()
    expect(ps.subscriptionTierOf(selected)).toBe('free')
    expect(selected?.id).not.toBe('enterprise-1')

    console.log(`[Test] Standard model → Selected: ${selected?.email} (${ps.subscriptionTierOf(selected)} tier), Enterprise skipped`)
  })

  it('Standard model with all Free exhausted: falls back to Enterprise', async () => {
    const ps = createServer()
    const modelId = 'claude-sonnet-4.5'

    // Add 118 Free accounts, all quota-exhausted
    for (let i = 0; i < 118; i++) {
      addAccount(ps, `free-${i}`, `free${i}@test`, 'Free')
      // Mark as quota exhausted using AccountPool method
      ps.accountPool.markQuotaExhausted(`free-${i}`)
    }

    // Add 1 available Enterprise account
    addAccount(ps, 'enterprise-1', 'enterprise1@test', 'Enterprise')

    // Act: select account for standard model
    const selected = await ps.getNextAccountForModel(new Set(), undefined, modelId)

    // Assert: selected the Enterprise account (fallback)
    expect(selected).not.toBeNull()
    expect(selected?.id).toBe('enterprise-1')
    expect(ps.subscriptionTierOf(selected)).toBe('paid')

    console.log(`[Test] All 118 Free exhausted → Fallback to Enterprise: ${selected?.email}`)
  })

  it('Premium model with only Free accounts: returns null, never probes', async () => {
    const ps = createServer()
    const modelId = 'claude-opus-4.8'

    // Add 118 Free accounts (no Enterprise)
    for (let i = 0; i < 118; i++) {
      addAccount(ps, `free-${i}`, `free${i}@test`, 'Free')
    }

    mockFetchKiroModels.mockClear()

    // Act: try to select account for premium model
    const selected = await ps.getNextAccountForModel(new Set(), undefined, modelId)

    // Assert: no account selected (tier pre-filter excluded all 118 Free accounts)
    expect(selected).toBeNull()

    // Assert: no probe happened (fetchKiroModels never called)
    expect(mockFetchKiroModels).not.toHaveBeenCalled()

    console.log(`[Test] Premium model + 118 Free-only pool → No selection, no probe (tier pre-filter worked)`)
  })

  it('Performance: tier pre-filter is O(n) scan, no timeout with 118 Free + 1 Enterprise', async () => {
    const ps = createServer()
    const modelId = 'claude-opus-4.8'

    // Add 118 Free accounts
    for (let i = 0; i < 118; i++) {
      addAccount(ps, `free-${i}`, `free${i}@test`, 'Free')
    }

    // Add 1 Enterprise account with capability
    const enterprise = addAccount(ps, 'enterprise-1', 'enterprise1@test', 'Enterprise')
    seedCapability(ps, enterprise.id, modelId)

    // Act: measure selection time
    const start = performance.now()
    const selected = await ps.getNextAccountForModel(new Set(), undefined, modelId)
    const duration = performance.now() - start

    // Assert: selected Enterprise
    expect(selected?.id).toBe('enterprise-1')

    // Assert: fast (no 60s timeout from probing 118 Free accounts)
    // Tier pre-filter is O(n) in-memory scan, should complete in milliseconds
    expect(duration).toBeLessThan(100) // < 100ms (generous upper bound)

    console.log(`[Test] Selection time for 118 Free + 1 Enterprise: ${duration.toFixed(2)}ms`)
  })
})
