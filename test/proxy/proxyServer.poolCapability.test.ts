import { describe, expect, it } from 'vitest'
import { ProxyServer } from '../../src/main/proxy/proxyServer'

// Minimal ProxyServer instance. The constructor only wires in-memory state
// (config, AccountPool, stats) and performs no network/server I/O. We reach the
// private capability cache + getPoolCapabilityUnion through a typed `any` cast,
// mirroring proxyServer.capability.test.ts. No account is probed over the network:
// getPoolCapabilityUnion(false) only reads the already-seeded per-account cache.
function createServer(config?: any): any {
  return new ProxyServer(config) as any
}

function addAccount(ps: any, id: string, subscriptionType?: string): void {
  ps.getAccountPool().addAccount({
    id,
    email: `${id}@test`,
    accessToken: 'tok',
    subscriptionType
  })
}

function seedCache(ps: any, accountId: string, modelIds: string[]): void {
  ps.accountModelCapabilityCache.set(accountId, {
    timestamp: Date.now(),
    modelIds: new Set(modelIds)
  })
}

describe('HM1 — pool capability union (getPoolCapabilityUnion, no forceScan)', () => {
  it('unions the capability ids across every account with a fresh cache', async () => {
    const ps = createServer()
    addAccount(ps, 'free-1', 'Free')
    addAccount(ps, 'pro-1', 'Pro')
    // Free account only sees sonnet/haiku; pro account additionally has opus.
    seedCache(ps, 'free-1', ['claude-sonnet-4.5', 'claude-haiku-4.5'])
    seedCache(ps, 'pro-1', ['claude-sonnet-4.5', 'claude-opus-4.8'])

    const union: Set<string> = await ps.getPoolCapabilityUnion(false)

    // Opus surfaces because at least one account (the Pro one) can serve it —
    // this is the whole point of aggregating instead of picking one account.
    expect(union.has('claude-opus-4.8')).toBe(true)
    expect(union.has('claude-sonnet-4.5')).toBe(true)
    expect(union.has('claude-haiku-4.5')).toBe(true)
  })

  it('excludes accounts whose capability cache is stale', async () => {
    const ps = createServer()
    addAccount(ps, 'stale-pro', 'Pro')
    // Seed then force-expire by rewinding the timestamp past the TTL.
    seedCache(ps, 'stale-pro', ['claude-opus-4.8'])
    ps.accountModelCapabilityCache.get('stale-pro').timestamp =
      Date.now() - ps.MODEL_CAPABILITY_CACHE_TTL - 1000

    const union: Set<string> = await ps.getPoolCapabilityUnion(false)
    expect(union.has('claude-opus-4.8')).toBe(false)
    expect(union.size).toBe(0)
  })

  it('caches the union result so a second read returns the same set instance', async () => {
    const ps = createServer()
    addAccount(ps, 'pro-1', 'Pro')
    seedCache(ps, 'pro-1', ['claude-opus-4.8'])

    const first: Set<string> = await ps.getPoolCapabilityUnion(false)
    const second: Set<string> = await ps.getPoolCapabilityUnion(false)
    expect(second).toBe(first)
  })

  it('requestPoolCapabilityScan arms a rescan and drops the cached union', async () => {
    const ps = createServer()
    addAccount(ps, 'pro-1', 'Pro')
    seedCache(ps, 'pro-1', ['claude-opus-4.8'])
    await ps.getPoolCapabilityUnion(false)
    expect(ps.poolCapabilityCache).not.toBeNull()

    ps.requestPoolCapabilityScan()
    expect(ps.pendingPoolScan).toBe(true)
    expect(ps.poolCapabilityCache).toBeNull()
  })
})
