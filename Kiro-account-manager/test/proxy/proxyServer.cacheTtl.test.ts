import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'

// ---------------------------------------------------------------------------
// Mock the kiroApi module so fetchKiroModels is fully controllable per-test.
// proxyServer.ts imports { callKiroApiStream, callKiroApi, fetchKiroModels,
// setModelContextWindow, KiroModel } from './kiroApi'. We preserve every real
// export via importActual and override ONLY fetchKiroModels with a vi.fn().
// vi.hoisted lets us reference the mock fn inside the hoisted vi.mock factory.
// (Same pattern as test/proxy/proxyServer.capability.examples.test.ts.)
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

// MODEL_CAPABILITY_CACHE_TTL = 5 * 60 * 1000 ms (see proxyServer.ts). Kept as a
// constant reference so the boundary (< ttl => cache-hit, >= ttl => refetch) is
// mirrored precisely against the production freshness check
// `Date.now() - cached.timestamp < MODEL_CAPABILITY_CACHE_TTL`.
const MODEL_CAPABILITY_CACHE_TTL = 5 * 60 * 1000 // 300000ms

const OPUS_MODEL = 'claude-opus-4.8'
// Fixed, non-empty model list mirroring the KiroModel shape that
// accountSupportsModel reads (model.modelId + model.tokenLimits?.maxInputTokens).
const MODEL_LIST = [{ modelId: OPUS_MODEL, tokenLimits: { maxInputTokens: 200000 } }]

const BASE_TIME = 1_700_000_000_000

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
  mockFetchKiroModels.mockResolvedValue(MODEL_LIST)
  vi.useFakeTimers()
  vi.setSystemTime(BASE_TIME)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ===========================================================================
// Feature: smart-proxy-account-rotation, Property 1: Capability cache được dùng
// lại trong TTL. For any account and query time, when the gap to the cache
// entry's timestamp is smaller than MODEL_CAPABILITY_CACHE_TTL, accountSupportsModel
// serves from cache WITHOUT calling fetchKiroModels; when the gap is >= TTL it
// must call fetchKiroModels again.
//
// Fake timers (vi.useFakeTimers + vi.setSystemTime) drive Date.now() inside the
// freshness check deterministically, while the hoisted vi.mock of fetchKiroModels
// lets us count network calls. The two combine to assert call-count semantics
// across the TTL boundary.
//
// Validates: Requirements 1.1, 1.2
// ===========================================================================
describe('ProxyServer capability cache — Property 1 (TTL semantics)', () => {
  it('within TTL serves from cache; at/after TTL refetches (fast-check, >=100 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // within-TTL delta in [0, 299999] => cache-hit (no extra fetch)
        fc.integer({ min: 0, max: MODEL_CAPABILITY_CACHE_TTL - 1 }),
        // beyond-TTL delta in [300000, large] => refetch
        fc.integer({ min: MODEL_CAPABILITY_CACHE_TTL, max: MODEL_CAPABILITY_CACHE_TTL + 10_000_000 }),
        async (withinDelta, beyondDelta) => {
          mockFetchKiroModels.mockReset()
          mockFetchKiroModels.mockResolvedValue(MODEL_LIST)
          vi.setSystemTime(BASE_TIME)

          const ps = createServer({ enableMultiAccount: true })
          const account = addAvailableAccount(ps, 'ttl-acct', { refreshToken: undefined })

          // First call: cache empty => exactly one fetch, returns true.
          const first = await ps.accountSupportsModel(account, OPUS_MODEL)
          expect(first).toBe(true)
          expect(mockFetchKiroModels).toHaveBeenCalledTimes(1)

          // Second call strictly WITHIN ttl => served from cache, no new fetch.
          vi.setSystemTime(BASE_TIME + withinDelta)
          const second = await ps.accountSupportsModel(account, OPUS_MODEL)
          expect(second).toBe(true)
          expect(mockFetchKiroModels).toHaveBeenCalledTimes(1)

          // Third call AT/AFTER ttl (measured from the cache timestamp set during
          // the first fetch, which happened at BASE_TIME) => refetch.
          vi.setSystemTime(BASE_TIME + beyondDelta)
          const third = await ps.accountSupportsModel(account, OPUS_MODEL)
          expect(third).toBe(true)
          expect(mockFetchKiroModels).toHaveBeenCalledTimes(2)
        }
      ),
      { numRuns: 100 }
    )
  })

  it('boundary: delta exactly TTL-1 hits cache, exactly TTL refetches', async () => {
    const ps = createServer({ enableMultiAccount: true })
    const account = addAvailableAccount(ps, 'boundary-acct', { refreshToken: undefined })

    await ps.accountSupportsModel(account, OPUS_MODEL)
    expect(mockFetchKiroModels).toHaveBeenCalledTimes(1)

    // exactly TTL - 1 => still a cache-hit (< ttl)
    vi.setSystemTime(BASE_TIME + (MODEL_CAPABILITY_CACHE_TTL - 1))
    await ps.accountSupportsModel(account, OPUS_MODEL)
    expect(mockFetchKiroModels).toHaveBeenCalledTimes(1)

    // exactly TTL => refetch (>= ttl)
    vi.setSystemTime(BASE_TIME + MODEL_CAPABILITY_CACHE_TTL)
    await ps.accountSupportsModel(account, OPUS_MODEL)
    expect(mockFetchKiroModels).toHaveBeenCalledTimes(2)
  })
})
