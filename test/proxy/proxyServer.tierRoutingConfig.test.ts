import { describe, expect, it } from 'vitest'

import { ProxyServer } from '../../src/main/proxy/proxyServer'

// Construct a minimal ProxyServer. The constructor only sets up in-memory state
// (config, AccountPool, stats) and starts no server / makes no network calls.
// Private members are reached through a typed `any` cast.
function createServer(config?: any, events?: any): any {
  return new ProxyServer(config, events) as any
}

// ===========================================================================
// tierRoutingEnabled config flag — now a REAL runtime toggle.
//
// Semantics (see tierRouting.ts): default ON. Only an explicit `false` disables
// tier routing (legacy capability-only path). The flag merges onto config,
// survives filterAdminConfigUpdate, is runtime-updatable, and is NOT a
// restart-triggering field.
// ===========================================================================
describe('ProxyServer tierRoutingEnabled config flag (real toggle)', () => {
  it('stores the constructor value; false disables, true enables', () => {
    const on = createServer({ enableMultiAccount: true, tierRoutingEnabled: true })
    const off = createServer({ enableMultiAccount: true, tierRoutingEnabled: false })

    expect(on.config.tierRoutingEnabled).toBe(true)
    expect(off.config.tierRoutingEnabled).toBe(false)

    expect(on.isTierRoutingActive()).toBe(true)
    expect(off.isTierRoutingActive()).toBe(false)
  })

  it('is active by default when the flag is not supplied', () => {
    const ps = createServer({ enableMultiAccount: true })

    // Flag unset => default ON.
    expect(ps.config.tierRoutingEnabled).toBeUndefined()
    expect(ps.isTierRoutingActive()).toBe(true)
  })

  it('applies updateConfig({ tierRoutingEnabled }) mid-life without requiring a restart', () => {
    const ps = createServer({ enableMultiAccount: true, tierRoutingEnabled: false })
    expect(ps.config.tierRoutingEnabled).toBe(false)
    expect(ps.isTierRoutingActive()).toBe(false)

    ps.updateConfig({ tierRoutingEnabled: true })

    // The merge (this.config = { ...this.config, ...config }) applies immediately.
    expect(ps.config.tierRoutingEnabled).toBe(true)
    // tierRoutingEnabled is NOT a restart-triggering field, so no restart is flagged.
    expect(ps._needsRestart).not.toBe(true)

    // Now active after the runtime toggle.
    expect(ps.isTierRoutingActive()).toBe(true)
  })

  it('includes tierRoutingEnabled in the filterAdminConfigUpdate allow-list', () => {
    const ps = createServer({ enableMultiAccount: true })

    const filtered = ps.filterAdminConfigUpdate({
      tierRoutingEnabled: true,
      strictTierRouting: true,
      // deliberately excluded fields must NOT survive the filter
      port: 9999,
      apiKey: 'secret'
    })

    expect(filtered.tierRoutingEnabled).toBe(true)
    // sanity: excluded fields are dropped (proves allow-list gating is real)
    expect('port' in filtered).toBe(false)
    expect('apiKey' in filtered).toBe(false)
  })

  it('does not treat tierRoutingEnabled as a restart-triggering field', () => {
    const ps = createServer({ enableMultiAccount: true })

    // A pure tierRoutingEnabled change never raises the restart flag.
    ps.updateConfig({ tierRoutingEnabled: true })
    expect(ps._needsRestart).not.toBe(true)

    ps.updateConfig({ tierRoutingEnabled: false })
    expect(ps._needsRestart).not.toBe(true)
  })
})
