import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mock the kiroApi module so fetchKiroModels is fully controllable per-test.
// proxyServer.ts imports { callKiroApiStream, callKiroApi, fetchKiroModels,
// setModelContextWindow, KiroModel } from './kiroApi'. We preserve every real
// export via importActual and override ONLY fetchKiroModels with a vi.fn().
// vi.hoisted lets us reference the mock fn inside the hoisted vi.mock factory.
// ---------------------------------------------------------------------------
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

import { ProxyServer } from '../../src/main/proxy/proxyServer'
import { proxyLogger } from '../../src/main/proxy/logger'
import { normalizeKiroModelIdForCompare } from '../../src/main/proxy/modelCatalog'

// Construct a minimal ProxyServer. The constructor only sets up in-memory state
// (config, AccountPool, stats) and starts no server / makes no network calls.
// Private members are reached through a typed `any` cast.
function createServer(config?: any, events?: any): any {
  return new ProxyServer(config, events) as any
}

function addAvailableAccount(ps: any, id: string, extra: Record<string, unknown> = {}): any {
  const account: any = {
    id,
    email: `${id}@test`,
    accessToken: 'tok',
    errorCount: 0,
    groupId: undefined,
    ...extra
  }
  ps.accountPool.addAccount(account)
  return account
}

beforeEach(() => {
  mockFetchKiroModels.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ===========================================================================
// Criterion 2.5 — a model that does NOT require capability selection takes the
// normal selection flow (getNextAccountForRequest) and never inspects model
// capability (no accountSupportsModel / fetchKiroModels call).
//
// 'claude-sonnet-4.5' is NOT in the capability-requiring set
// (requiresModelCapabilitySelection: opus*, sonnet-4.6, deepseek-3.2,
// qwen3-coder-next, glm-5, minimax-*), so getNextAccountForModel must early-return
// via getNextAccountForRequest(...).
// ===========================================================================
describe('ProxyServer capability examples — criterion 2.5 (non-capability model uses normal flow)', () => {
  it('returns an account via the normal flow without calling accountSupportsModel', async () => {
    const ps = createServer({ enableMultiAccount: true })
    addAvailableAccount(ps, 'normal-acct-1')
    addAvailableAccount(ps, 'normal-acct-2')

    // Guard: confirm the model genuinely does not require capability selection.
    expect(ps.requiresModelCapabilitySelection('claude-sonnet-4.5')).toBe(false)

    const spy = vi.spyOn(ps, 'accountSupportsModel')

    const account = await ps.getNextAccountForModel(new Set(), undefined, 'claude-sonnet-4.5')

    // Early-return path picked a real account from the pool ...
    expect(account).not.toBeNull()
    expect(['normal-acct-1', 'normal-acct-2']).toContain(account.id)
    // ... and the capability inspection path was never taken.
    expect(spy).not.toHaveBeenCalled()
    expect(mockFetchKiroModels).not.toHaveBeenCalled()
  })

  it('still returns an account with only a single account in the pool (normal flow)', async () => {
    const ps = createServer({ enableMultiAccount: true })
    addAvailableAccount(ps, 'solo-acct')

    const spy = vi.spyOn(ps, 'accountSupportsModel')

    const account = await ps.getNextAccountForModel(new Set(), undefined, 'claude-sonnet-4.5')

    expect(account).not.toBeNull()
    expect(account.id).toBe('solo-acct')
    expect(spy).not.toHaveBeenCalled()
    expect(mockFetchKiroModels).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// Criterion 1.6 — when fetching a tier-requiring model list fails (throws) even
// after a token refresh attempt, accountSupportsModel must:
//   - cache an EMPTY model set for the account,
//   - return false (account treated as not supporting the model),
//   - log a warning (proxyLogger.warn).
//
// 'claude-opus-4.8' requiresModelCapabilitySelection, forcing the fetch path.
// No seeded capability cache => a fresh fetch is attempted.
// ===========================================================================
describe('ProxyServer capability examples — criterion 1.6 (fetch failure → not supported + warning)', () => {
  const OPUS_MODEL = 'claude-opus-4.8'

  it('returns false, caches an empty model set, and warns when fetch throws (no refresh token)', async () => {
    const ps = createServer({ enableMultiAccount: true })
    // No refreshToken => the refresh branch is not eligible; the very first
    // fetchKiroModels throw lands directly in the catch block.
    const account = addAvailableAccount(ps, 'fetch-fail-1', { refreshToken: undefined })

    mockFetchKiroModels.mockRejectedValue(new Error('network down'))
    const warnSpy = vi.spyOn(proxyLogger, 'warn')

    const supports = await ps.accountSupportsModel(account, OPUS_MODEL)

    expect(supports).toBe(false)
    // An empty-set cache entry was recorded for this account.
    const cached = ps.accountModelCapabilityCache.get(account.id)
    expect(cached).toBeTruthy()
    expect(cached.modelIds instanceof Set).toBe(true)
    expect(cached.modelIds.size).toBe(0)
    // A warning was logged.
    expect(warnSpy).toHaveBeenCalled()
    expect(mockFetchKiroModels).toHaveBeenCalled()
  })

  it('returns false + empty cache + warning when fetch still throws after a successful token refresh', async () => {
    // Mirrors accountSupportsModel refresh-then-retry: first fetch returns [],
    // which (with a refreshToken) triggers refreshToken; on success it re-fetches
    // and that retry throws -> catch -> empty cache + warn + false.
    const onTokenRefresh = vi.fn().mockResolvedValue({
      success: true,
      accessToken: 'refreshed-token'
    })
    const ps = createServer({ enableMultiAccount: true }, { onTokenRefresh })
    const account = addAvailableAccount(ps, 'fetch-fail-2', { refreshToken: 'rt-123' })

    mockFetchKiroModels
      .mockResolvedValueOnce([]) // first call: empty -> triggers refresh
      .mockRejectedValueOnce(new Error('still failing after refresh')) // retry throws

    const warnSpy = vi.spyOn(proxyLogger, 'warn')

    const supports = await ps.accountSupportsModel(account, OPUS_MODEL)

    expect(supports).toBe(false)
    const cached = ps.accountModelCapabilityCache.get(account.id)
    expect(cached).toBeTruthy()
    expect(cached.modelIds.size).toBe(0)
    expect(warnSpy).toHaveBeenCalled()
    // The refresh path was exercised: an initial fetch, a refresh, then a retry fetch.
    expect(onTokenRefresh).toHaveBeenCalledTimes(1)
    expect(mockFetchKiroModels).toHaveBeenCalledTimes(2)
  })

  it('does not match the requested model after a failed fetch (empty set has no opus id)', async () => {
    const ps = createServer({ enableMultiAccount: true })
    const account = addAvailableAccount(ps, 'fetch-fail-3', { refreshToken: undefined })

    mockFetchKiroModels.mockRejectedValue(new Error('boom'))
    vi.spyOn(proxyLogger, 'warn')

    await ps.accountSupportsModel(account, OPUS_MODEL)

    const cached = ps.accountModelCapabilityCache.get(account.id)
    expect(cached.modelIds.has(normalizeKiroModelIdForCompare(OPUS_MODEL))).toBe(false)
  })
})
