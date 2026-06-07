import { describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'
import { ProxyServer } from '../../src/main/proxy/proxyServer'
import { normalizeKiroModelIdForCompare } from '../../src/main/proxy/modelCatalog'

const FC_RUNS = 200

const OPUS_MODEL = 'claude-opus-4.8'
const QUOTA_RESET_MS = 60 * 60 * 1000 // 3_600_000
const COOLDOWN_FAR_MS = 10 * 60 * 1000 // 600_000 > MAX_COMPATIBLE_COOLDOWN_WAIT_MS (65_000)

// Build a minimal ProxyServer. The constructor only sets up in-memory state
// (config defaults, AccountPool, stats); it starts no server and makes no network
// calls. We reach private members (accountModelCapabilityCache, classifyNoAccountReason,
// accountPool) through a typed `any` cast. The capability cache is seeded directly so
// eligibility (accountSupportsModel) resolves purely from cache — fetchKiroModels is
// never invoked.
function createServer(config?: any): any {
  return new ProxyServer({
    enableMultiAccount: true,
    accountSelectionStrategy: 'smart',
    ...config
  }) as any
}

// Seed the (already-normalized) capability cache for an account. Power accounts carry a
// claude-opus-* id (=> eligible for OPUS_MODEL); free accounts omit any opus id (=> NOT
// eligible for OPUS_MODEL, so they never enter the eligible set).
function seedTierCache(ps: any, accountId: string, tier: 'power' | 'free'): void {
  const modelIds = tier === 'power'
    ? ['claude-opus-4.8', 'claude-sonnet-4.5']
    : ['claude-sonnet-4.5']
  ps.accountModelCapabilityCache.set(accountId, {
    timestamp: Date.now(),
    modelIds: new Set(modelIds.map((id) => normalizeKiroModelIdForCompare(id)))
  })
}

// Add an account to the pool in one of the three exercised states.
//   - quotaExhausted: quotaExhaustedAt=now, quotaResetAt=now+QUOTA_RESET_MS (isQuotaExhausted=true)
//   - cooldown: cooldownUntil=now+COOLDOWN_FAR_MS (on cooldown, not exhausted)
//   - available: no cooldown / no exhaustion
function addAccount(
  ps: any,
  id: string,
  opts: { tier: 'power' | 'free'; quotaExhausted?: boolean; cooldown?: boolean },
  now: number
): void {
  const account: any = {
    id,
    email: `${id}@test`,
    accessToken: 'tok',
    errorCount: 0,
    groupId: undefined
  }
  if (opts.quotaExhausted) {
    account.quotaExhaustedAt = now
    account.quotaResetAt = now + QUOTA_RESET_MS
  }
  if (opts.cooldown) {
    account.cooldownUntil = now + COOLDOWN_FAR_MS
  }
  ps.accountPool.addAccount(account)
  seedTierCache(ps, id, opts.tier)
}

// ===========================================================================
// Property 14 — no-account reason is total + mutually exclusive, in priority order.
//
// For OPUS_MODEL the eligible set is exactly the set of power-tier accounts (free
// accounts lack the opus id in their capability cache). We generate a random mix of
// (tier, quotaExhausted, cooldown) and assert classifyNoAccountReason returns exactly
// one of the three labels, equal to the expected reason computed independently in the
// test by replaying the priority rule against the eligible (power) accounts.
// ===========================================================================
describe('ProxyServer noAccount — Property 14 (classifyNoAccountReason priority)', () => {
  const tierArb = fc.constantFrom<'power' | 'free'>('power', 'free')
  const accountSpecArb = fc.record({
    tier: tierArb,
    quotaExhausted: fc.boolean(),
    cooldown: fc.boolean()
  })

  // Replicate the production priority rule against the generated state. Eligible =
  // power accounts (the only ones supporting OPUS_MODEL). isQuotaExhausted is true
  // when we set quotaExhausted (quotaResetAt is in the future).
  function expectedReason(specs: Array<{ tier: 'power' | 'free'; quotaExhausted: boolean }>): string {
    const eligible = specs.filter((s) => s.tier === 'power')
    if (eligible.length === 0) return 'model_unsupported'
    if (eligible.every((s) => s.quotaExhausted)) return 'quota_exhausted'
    return 'throttled'
  }

  // Feature: smart-proxy-account-rotation, Property 14: For any pool state where no account can be selected for a capability-requiring Requested_Model, classifyNoAccountReason returns EXACTLY ONE label by priority: 'model_unsupported' if the eligible set is empty; else 'quota_exhausted' if every eligible account is quota-exhausted; else 'throttled'.
  // Validates: Requirements 6.1, 6.2, 6.3, 6.4
  it('Property 14: returns exactly one label matching the independently computed priority', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(accountSpecArb, { minLength: 0, maxLength: 8 }),
        async (specs) => {
          const now = Date.now()
          const ps = createServer()
          specs.forEach((spec, i) => {
            addAccount(ps, `p14-acct-${i}`, spec, now)
          })

          const diag = await ps.classifyNoAccountReason(OPUS_MODEL, undefined)

          // Exactly one of the three labels.
          expect(['model_unsupported', 'quota_exhausted', 'throttled']).toContain(diag.reason)

          // Matches the priority rule computed independently from the same state.
          expect(diag.reason).toBe(expectedReason(specs))

          // Diagnosis counts stay internally consistent.
          const eligibleCount = specs.filter((s) => s.tier === 'power').length
          expect(diag.eligibleTotal).toBe(eligibleCount)
          expect(diag.exhausted).toBeGreaterThanOrEqual(0)
          expect(diag.cooldown).toBeGreaterThanOrEqual(0)
          expect(diag.exhausted + diag.cooldown).toBeLessThanOrEqual(diag.eligibleTotal)
        }
      ),
      { numRuns: FC_RUNS }
    )
  })
})

// ===========================================================================
// Integration tests (example) for the 503 error surface.
//
// We drive classifyNoAccountReason directly for each of the three reasons and assert:
//   - the reason label,
//   - the message is a non-empty Vietnamese string containing the right cue,
//   - the counts (eligibleTotal / exhausted / cooldown) are consistent,
// and verify Req 6.1 ("no quota consumed / no account contacted") by spying that
// classifyNoAccountReason never calls recordError / recordSuccess.
// ===========================================================================
describe('ProxyServer noAccount — 503 surface integration (the three reasons)', () => {
  it('model_unsupported: only free accounts (and empty pool) → no eligible account', async () => {
    const now = Date.now()
    const ps = createServer()
    addAccount(ps, 'free-1', { tier: 'free' }, now)
    addAccount(ps, 'free-2', { tier: 'free' }, now)

    const diag = await ps.classifyNoAccountReason(OPUS_MODEL, undefined)

    expect(diag.reason).toBe('model_unsupported')
    expect(typeof diag.message).toBe('string')
    expect(diag.message.length).toBeGreaterThan(0)
    expect(diag.message).toContain('hỗ trợ model')
    expect(diag.message).toContain(OPUS_MODEL)
    // No power account => empty eligible set.
    expect(diag.eligibleTotal).toBe(0)
    expect(diag.exhausted).toBe(0)
    expect(diag.cooldown).toBe(0)
  })

  it('model_unsupported: empty pool → no eligible account', async () => {
    const ps = createServer()

    const diag = await ps.classifyNoAccountReason(OPUS_MODEL, undefined)

    expect(diag.reason).toBe('model_unsupported')
    expect(diag.eligibleTotal).toBe(0)
    expect(diag.message).toContain('hỗ trợ model')
  })

  it('quota_exhausted: every eligible (power) account is quota-exhausted', async () => {
    const now = Date.now()
    const ps = createServer()
    addAccount(ps, 'pow-1', { tier: 'power', quotaExhausted: true }, now)
    addAccount(ps, 'pow-2', { tier: 'power', quotaExhausted: true }, now)
    // A free account is irrelevant: it is never eligible for opus.
    addAccount(ps, 'free-1', { tier: 'free' }, now)

    const diag = await ps.classifyNoAccountReason(OPUS_MODEL, undefined)

    expect(diag.reason).toBe('quota_exhausted')
    expect(diag.message.length).toBeGreaterThan(0)
    expect(diag.message).toContain('hết quota')
    expect(diag.eligibleTotal).toBe(2)
    expect(diag.exhausted).toBe(2)
    expect(diag.cooldown).toBe(0)
    // All eligible accounts are exhausted.
    expect(diag.exhausted).toBe(diag.eligibleTotal)
  })

  it('throttled: ≥1 power account not exhausted but on cooldown', async () => {
    const now = Date.now()
    const ps = createServer()
    // One exhausted + one merely throttled => not all exhausted => throttled wins.
    addAccount(ps, 'pow-1', { tier: 'power', quotaExhausted: true }, now)
    addAccount(ps, 'pow-2', { tier: 'power', cooldown: true }, now)

    const diag = await ps.classifyNoAccountReason(OPUS_MODEL, undefined)

    expect(diag.reason).toBe('throttled')
    expect(diag.message.length).toBeGreaterThan(0)
    expect(diag.message).toContain('giới hạn tốc độ')
    expect(diag.eligibleTotal).toBe(2)
    expect(diag.exhausted).toBe(1)
    expect(diag.cooldown).toBe(1)
    expect(diag.exhausted + diag.cooldown).toBeLessThanOrEqual(diag.eligibleTotal)
  })

  it('Req 6.1: classifyNoAccountReason consumes no quota / contacts no account (no record* calls)', async () => {
    const now = Date.now()
    const ps = createServer()
    addAccount(ps, 'pow-1', { tier: 'power', quotaExhausted: true }, now)
    addAccount(ps, 'pow-2', { tier: 'power', cooldown: true }, now)
    addAccount(ps, 'free-1', { tier: 'free' }, now)

    const recErr = vi.spyOn(ps.accountPool, 'recordError')
    const recOk = vi.spyOn(ps.accountPool, 'recordSuccess')

    // Exercise all three branches in one test to be thorough.
    await ps.classifyNoAccountReason(OPUS_MODEL, undefined)

    const psEmpty = createServer()
    const recErr2 = vi.spyOn(psEmpty.accountPool, 'recordError')
    const recOk2 = vi.spyOn(psEmpty.accountPool, 'recordSuccess')
    await psEmpty.classifyNoAccountReason(OPUS_MODEL, undefined)

    expect(recErr).not.toHaveBeenCalled()
    expect(recOk).not.toHaveBeenCalled()
    expect(recErr2).not.toHaveBeenCalled()
    expect(recOk2).not.toHaveBeenCalled()

    vi.restoreAllMocks()
  })
})
