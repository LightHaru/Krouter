import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProxyServer } from '../../src/main/proxy/proxyServer'
import { normalizeKiroModelIdForCompare } from '../../src/main/proxy/modelCatalog'

// ---------------------------------------------------------------------------
// Task 6.2 — 429 cooldown-wait behavior in getNextAccountForModel.
//
// getNextAccountForModel, when no eligible account is immediately selectable but
// >=1 eligible (model-supporting, not suspended, not quota-exhausted) account is
// on cooldown, computes the minimum remaining cooldown via
// getCompatibleModelCooldownWaitMs:
//   - if that wait <= MAX_COMPATIBLE_COOLDOWN_WAIT_MS (10000ms) → waitForRetry()
//     then recurse and return the account once its cooldown elapses;
//   - otherwise → return null (caller surfaces this as 'throttled', R6).
//
// waitForRetry uses setTimeout, so we drive it with vi.useFakeTimers() +
// vi.advanceTimersByTimeAsync. The capability cache is pre-seeded so
// accountSupportsModel resolves purely from cache (no network / no fetchKiroModels).
//
// >=2 power accounts are used so the AccountPool single-account bypass (which
// ignores availability) never applies and the genuine cooldown-wait path runs.
// ---------------------------------------------------------------------------

const OPUS_MODEL = 'claude-opus-4.8'
const MAX_COMPATIBLE_COOLDOWN_WAIT_MS = 10000

function createServer(config?: any): any {
  return new ProxyServer({ enableMultiAccount: true, accountSelectionStrategy: 'smart', ...config }) as any
}

function addPowerAccount(ps: any, id: string, cooldownUntil: number): void {
  ps.accountPool.addAccount({
    id,
    email: `${id}@test`,
    accessToken: 'tok',
    errorCount: 0,
    cooldownUntil
  })
  // Seed power-tier capability cache (normalized ids) so accountSupportsModel
  // is cache-only and never calls fetchKiroModels.
  ps.accountModelCapabilityCache.set(id, {
    timestamp: Date.now(),
    modelIds: new Set(['claude-opus-4.8', 'claude-sonnet-4.5'].map(normalizeKiroModelIdForCompare))
  })
}

describe('ProxyServer — 429 cooldown-wait in getNextAccountForModel (Task 6.2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // Requirements 4.3, 4.4: short cooldown (<= MAX_COMPATIBLE_COOLDOWN_WAIT_MS) → wait then retry.
  it('waits for a short cooldown (<= 10s) then returns the account once it elapses', async () => {
    const ps = createServer()
    const now = Date.now()
    // Both eligible power accounts on cooldown ending in 5s (< 10s).
    addPowerAccount(ps, 'pow-1', now + 5000)
    addPowerAccount(ps, 'pow-2', now + 5000)

    // No await yet: getNextAccountForModel will internally waitForRetry(setTimeout).
    const pending = ps.getNextAccountForModel(new Set(), undefined, OPUS_MODEL)

    // Advance past the cooldown + the +100ms buffer so the recursion can select.
    await vi.advanceTimersByTimeAsync(5200)

    const result = await pending
    expect(result).not.toBeNull()
    expect(['pow-1', 'pow-2']).toContain(result.id)
  })

  // Requirement 4.5: cooldown beyond MAX_COMPATIBLE_COOLDOWN_WAIT_MS → no wait, return null.
  it('does not wait and returns null when the minimum cooldown exceeds 10s', async () => {
    const ps = createServer()
    const now = Date.now()
    // Both eligible power accounts on cooldown ending in 12s (> 10s).
    addPowerAccount(ps, 'pow-1', now + 12000)
    addPowerAccount(ps, 'pow-2', now + 12000)

    // Should resolve to null without needing a long timer advance.
    const result = await ps.getNextAccountForModel(new Set(), undefined, OPUS_MODEL)
    expect(result).toBeNull()
  })

  // Boundary sanity: exactly at the threshold (10s) is still within the wait window.
  it('waits when the cooldown equals exactly MAX_COMPATIBLE_COOLDOWN_WAIT_MS', async () => {
    const ps = createServer()
    const now = Date.now()
    addPowerAccount(ps, 'pow-1', now + MAX_COMPATIBLE_COOLDOWN_WAIT_MS)
    addPowerAccount(ps, 'pow-2', now + MAX_COMPATIBLE_COOLDOWN_WAIT_MS)

    const pending = ps.getNextAccountForModel(new Set(), undefined, OPUS_MODEL)
    // wait = min(cooldown)+100 = 65100ms; advance a little past it.
    await vi.advanceTimersByTimeAsync(MAX_COMPATIBLE_COOLDOWN_WAIT_MS + 200)

    const result = await pending
    expect(result).not.toBeNull()
    expect(['pow-1', 'pow-2']).toContain(result.id)
  })
})
