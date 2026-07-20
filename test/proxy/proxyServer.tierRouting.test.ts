import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fc from 'fast-check'

// ---------------------------------------------------------------------------
// Mock the kiroApi module so fetchKiroModels is fully controllable + spyable.
// proxyServer.ts imports fetchKiroModels from './kiroApi'; we preserve every
// real export via importActual and override ONLY fetchKiroModels with a vi.fn().
// vi.hoisted lets us reference the mock inside the hoisted vi.mock factory.
// (Same pattern as proxyServer.capability.examples.test.ts / cacheTtl.test.ts.)
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
import { normalizeKiroModelIdForCompare, normalizeKiroTier } from '../../src/main/proxy/modelCatalog'
import { proxyLogger } from '../../src/main/proxy/logger'

const FC_RUNS = 200

// Build a minimal ProxyServer instance. The constructor only sets up in-memory
// state (config defaults, AccountPool, stats) and performs no network/server I/O.
// Private tier-classification helpers are accessed through a typed `any` cast so
// we can test them directly without changing their visibility. These helpers are
// pure and tag-only: they never touch the capability cache or the network.
function createServer(config?: any): any {
  return new ProxyServer(config) as any
}

// --- Generators ------------------------------------------------------------

// Known paid-tier tags (Requirement Glossary: Paid_Tier). isPaidKiroTier
// normalizes case + separators, so cover a couple of spelling variants.
const PAID_TAGS = ['Pro', 'Pro_Plus', 'Pro Plus', 'PROPLUS', 'Enterprise', 'Teams', 'Power']
// The single free tag (normalizes to 'free').
const FREE_TAGS = ['Free', 'free', 'FREE']
// Absent / empty / unrecognized tags — all treated identically to absent.
const UNKNOWN_TAGS: Array<string | undefined> = [undefined, '', '   ', 'Basic', 'Gold', 'xyz']

const paidTagArb = fc.constantFrom(...PAID_TAGS)
const freeTagArb = fc.constantFrom(...FREE_TAGS)
const unknownTagArb = fc.oneof(
  fc.constantFrom(...UNKNOWN_TAGS),
  // arbitrary strings that genuinely normalize to 'unknown' (use the REAL normalizer,
  // which does fuzzy substring matching — e.g. "prox" contains "pro" → 'pro', so a naive
  // exact-equality filter would wrongly let paid-ish strings through).
  fc.string().filter((s) => normalizeKiroTier(s) === 'unknown')
)

const anyTagArb = fc.oneof(paidTagArb, freeTagArb, unknownTagArb)

// Premium model ids (isPremiumModel/requiresModelCapabilitySelection => true).
const premiumModelArb = fc.constantFrom(
  'claude-opus-4.8',
  'claude-opus-4.1',
  'claude-opus-4-8',
  'claude-sonnet-4.6',
  'deepseek-3.2',
  'qwen3-coder-next',
  'glm-5',
  'minimax-m2'
)
// Standard / unmapped model ids (isPremiumModel => false).
const standardModelArb = fc.oneof(
  fc.constantFrom('claude-haiku-4.5', 'claude-sonnet-4.5', 'gpt-4o', 'gemini-1.5'),
  fc.string().filter((s) => !s.toLowerCase().includes('opus') && s.trim().length > 0)
)

function accountWithTag(tag: string | undefined): any {
  return { id: 'acct-tier', subscriptionType: tag }
}

// ---------------------------------------------------------------------------
// Property 3 — Tag-eligibility matches the Tier_Eligibility_Map.
// ---------------------------------------------------------------------------

describe('ProxyServer tier routing — Property 3: tag-eligibility mapping', () => {
  // Feature: smart-tier-based-proxy-routing, Property 3: For any Requested_Model and any subscriptionType tag value (including absent, empty, and arbitrary/unrecognized strings), isTagEligibleForModel returns: for a Premium_Model, true iff the tag is a Paid_Tier value; for a Standard_Model or unmapped id, true for every tag. Unrecognized and empty tags are treated identically to an absent tag.
  // Validates: Requirements 2.2, 2.3, 2.4, 5.1, 5.2, 5.3
  it('premium model => eligible for paid AND unknown (hybrid); free excluded; standard => all', () => {
    const ps = createServer()
    fc.assert(
      fc.property(
        anyTagArb,
        fc.boolean(),
        fc.oneof(premiumModelArb, standardModelArb),
        (tag, usePremium, modelId) => {
          const model = usePremium ? modelId : modelId
          const account = accountWithTag(tag)
          const isPremium = ps.modelTierClass(model) === 'premium'
          const tier = ps.subscriptionTierOf(account)
          const eligible = ps.isTagEligibleForModel(account, model)

          if (isPremium) {
            // HYBRID: paid + unknown are tag-eligible (unknown confirmed later via
            // capability cache); only a definitively 'free' tag is hard-excluded.
            expect(eligible).toBe(tier !== 'free')
          } else {
            expect(eligible).toBe(true)
          }
        }
      ),
      { numRuns: FC_RUNS }
    )
  })

  // Explicit coverage: premium model against each tag class (hybrid rule).
  it('premium model: paid => true, unknown => true (hybrid), free => false', () => {
    const ps = createServer()
    fc.assert(
      fc.property(premiumModelArb, (model) => {
        for (const tag of PAID_TAGS) {
          expect(ps.isTagEligibleForModel(accountWithTag(tag), model)).toBe(true)
        }
        for (const tag of FREE_TAGS) {
          expect(ps.isTagEligibleForModel(accountWithTag(tag), model)).toBe(false)
        }
        // Unknown/unrecognized tags are NOT hard-excluded anymore (capability cache
        // confirms before selection in isEligibleForModel).
        for (const tag of UNKNOWN_TAGS) {
          expect(ps.isTagEligibleForModel(accountWithTag(tag), model)).toBe(true)
        }
      }),
      { numRuns: FC_RUNS }
    )
  })

  // Empty/unrecognized tags behave identically to an absent tag (Requirement 5.3).
  it('empty and unrecognized tags behave identically to an absent tag', () => {
    const ps = createServer()
    fc.assert(
      fc.property(
        fc.oneof(premiumModelArb, standardModelArb),
        unknownTagArb,
        (model, unknownTag) => {
          const absent = ps.isTagEligibleForModel(accountWithTag(undefined), model)
          const other = ps.isTagEligibleForModel(accountWithTag(unknownTag), model)
          expect(other).toBe(absent)
          // Both also share the same coarse tier classification ('unknown').
          expect(ps.subscriptionTierOf(accountWithTag(unknownTag))).toBe('unknown')
        }
      ),
      { numRuns: FC_RUNS }
    )
  })
})

// ---------------------------------------------------------------------------
// Example tests — modelTierClass shape (Requirement 2.1) and helper defaults.
// ---------------------------------------------------------------------------

describe('ProxyServer tier routing — modelTierClass shape (example)', () => {
  it('classifies premium, standard, and unmapped model ids', () => {
    const ps = createServer()
    expect(ps.modelTierClass('claude-opus-4.8')).toBe('premium')
    expect(ps.modelTierClass('claude-haiku-4.5')).toBe('standard')
    // Unmapped id => standard.
    expect(ps.modelTierClass('some-unmapped-model-id')).toBe('standard')
    // undefined => standard.
    expect(ps.modelTierClass(undefined)).toBe('standard')
  })

  it('subscriptionTierOf classifies paid/free/unknown tags', () => {
    const ps = createServer()
    expect(ps.subscriptionTierOf(accountWithTag('Pro'))).toBe('paid')
    expect(ps.subscriptionTierOf(accountWithTag('Enterprise'))).toBe('paid')
    expect(ps.subscriptionTierOf(accountWithTag('Free'))).toBe('free')
    expect(ps.subscriptionTierOf(accountWithTag(undefined))).toBe('unknown')
    expect(ps.subscriptionTierOf(accountWithTag(''))).toBe('unknown')
    expect(ps.subscriptionTierOf(accountWithTag('Mystery'))).toBe('unknown')
  })

  it('tierPreferenceGroups: premium => paid tiers + unknown last, no free; standard => free first', () => {
    const ps = createServer()
    // Premium models: no 'free' group; 'unknown' is tried last (after paid tiers).
    const premium = ps.tierPreferenceGroups('claude-opus-4.8')
    expect(premium).not.toContain('free')
    expect(premium).toContain('unknown')
    expect(premium[premium.length - 1]).toBe('unknown')
    // Standard models: 'free' is the first group, 'unknown' before the paid tiers.
    const standard = ps.tierPreferenceGroups('claude-haiku-4.5')
    expect(standard[0]).toBe('free')
    expect(standard).toContain('unknown')
    expect(ps.tierPreferenceGroups(undefined)[0]).toBe('free')
  })

  it('isTierRoutingActive reflects the config flag (default on; false disables)', () => {
    expect(createServer().isTierRoutingActive()).toBe(true)
    expect(createServer({ tierRoutingEnabled: false }).isTierRoutingActive()).toBe(false)
    expect(createServer({ tierRoutingEnabled: true }).isTierRoutingActive()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Property 1 — Tag-excluded accounts never trigger a network capability check.
//
// Harness mirrors the established capability/cacheTtl tests: the kiroApi module
// is mocked so fetchKiroModels is a spy, capability results are seeded directly
// into accountModelCapabilityCache, pools are built with >= 2 accounts (so the
// AccountPool single-account bypass is never taken), and tier routing is enabled
// (tierRoutingEnabled + enableMultiAccount). A cold cache is deliberately left
// on tag-ineligible accounts so that, were they ever probed, fetchKiroModels
// WOULD be invoked with them — the assertion is that it never is.
// ---------------------------------------------------------------------------

// Live server helper (enableMultiAccount) used by the selection-path property.
function createMultiServer(config?: any): any {
  return new ProxyServer({ enableMultiAccount: true, tierRoutingEnabled: true, ...config }) as any
}

function addPoolAccount(ps: any, id: string, tag: string | undefined): any {
  const account: any = {
    id,
    email: `${id}@test`,
    accessToken: 'tok',
    refreshToken: undefined,
    errorCount: 0,
    groupId: undefined,
    subscriptionType: tag
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

describe('ProxyServer tier routing — Property 1: no network probe for tag-excluded accounts', () => {
  beforeEach(() => {
    mockFetchKiroModels.mockReset()
    // Default: if ever called, return the model so a probe would "succeed" —
    // making an errant probe on an ineligible account observable via the spy.
    mockFetchKiroModels.mockImplementation(async (account: any) => {
      return [{ modelId: account?.__model ?? 'claude-opus-4.8', tokenLimits: { maxInputTokens: 200000 } }]
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Feature: smart-tier-based-proxy-routing, Property 1: For any account pool and any Requested_Model, when tierRoutingEnabled is true, running account selection SHALL NOT call fetchKiroModels for any account whose subscriptionType tag is ineligible for the model (in particular, no Free/unknown-tag account is ever network-probed for a Premium_Model).
  // Validates: Requirements 1.1, 1.4, 8.1, 8.2
  it('fetchKiroModels is never called for a tag-ineligible account (>=200 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A pool of >= 2 accounts, each with an arbitrary tier tag.
        fc.array(anyTagArb, { minLength: 2, maxLength: 6 }),
        // Prefer premium (where free/unknown are excluded) but cover standard too.
        fc.oneof(premiumModelArb, standardModelArb),
        async (tags, modelId) => {
          mockFetchKiroModels.mockClear()

          const ps = createMultiServer()
          const accounts = tags.map((tag, i) => addPoolAccount(ps, `p1-acct-${i}`, tag))

          // Seed the capability cache ONLY for tag-eligible accounts (so they
          // resolve from cache with no fetch). Leave tag-ineligible accounts
          // cold: if the pre-filter failed, selecting them would trigger a fetch.
          const ineligibleIds = new Set<string>()
          for (const acc of accounts) {
            if (ps.isTagEligibleForModel(acc, modelId)) {
              seedCapability(ps, acc.id, modelId)
            } else {
              ineligibleIds.add(acc.id)
            }
          }

          await ps.getNextAccountForModel(new Set(), undefined, modelId)

          // No fetchKiroModels call may reference a tag-ineligible account.
          for (const call of mockFetchKiroModels.mock.calls) {
            const probed = call[0]
            expect(ineligibleIds.has(probed?.id)).toBe(false)
          }
        }
      ),
      { numRuns: FC_RUNS }
    )
  })

  // Focused example: a premium model against a pool dominated by Free/unknown
  // accounts must never probe any of them (the core timeout-elimination goal).
  it('premium model: no Free/unknown account is ever network-probed', async () => {
    mockFetchKiroModels.mockClear()
    const ps = createMultiServer()
    addPoolAccount(ps, 'free-1', 'Free')
    addPoolAccount(ps, 'free-2', 'Free')
    addPoolAccount(ps, 'unknown-1', undefined)
    addPoolAccount(ps, 'unknown-2', 'Mystery')
    const paid = addPoolAccount(ps, 'paid-1', 'Pro')
    seedCapability(ps, paid.id, 'claude-opus-4.8')

    const selected = await ps.getNextAccountForModel(new Set(), undefined, 'claude-opus-4.8')

    expect(selected?.id).toBe('paid-1')
    for (const call of mockFetchKiroModels.mock.calls) {
      expect(['free-1', 'free-2', 'unknown-1', 'unknown-2']).not.toContain(call[0]?.id)
    }
  })
})

// ---------------------------------------------------------------------------
// Shared helpers for the selection-path properties (Properties 2, 4, 5, 6, 8)
// and the round-robin example. Unavailable states are applied WITHOUT firing
// real timers: suspendedAt (via markSuspended), quotaExhaustedAt + far-future
// quotaResetAt, or a far-future cooldownUntil (well beyond
// MAX_COMPATIBLE_COOLDOWN_WAIT_MS = 10_000ms) so the cooldown-wait fallback
// never sleeps.
// ---------------------------------------------------------------------------

const FAR_FUTURE_MS = 60 * 60 * 1000 // 1 hour >> MAX_COMPATIBLE_COOLDOWN_WAIT_MS

type UnavailKind = 'available' | 'suspended' | 'quota' | 'cooldown'

function applyState(ps: any, id: string, kind: UnavailKind): void {
  if (kind === 'available') return
  const acc = ps.accountPool.getAccount(id)
  if (!acc) return
  if (kind === 'suspended') {
    ps.accountPool.markSuspended(id, 'test-suspend')
  } else if (kind === 'quota') {
    acc.quotaExhaustedAt = Date.now()
    acc.quotaResetAt = Date.now() + FAR_FUTURE_MS
  } else if (kind === 'cooldown') {
    acc.cooldownUntil = Date.now() + FAR_FUTURE_MS
  }
}

function seedEmptyCapability(ps: any, id: string): void {
  ps.accountModelCapabilityCache.set(id, { timestamp: Date.now(), modelIds: new Set<string>() })
}

const stateArb = fc.constantFrom<UnavailKind>('available', 'suspended', 'quota', 'cooldown')
const unavailStateArb = fc.constantFrom<UnavailKind>('suspended', 'quota', 'cooldown')

// ---------------------------------------------------------------------------
// Property 2 — Every selected account is tag-eligible, capability-supported,
// untried, and available (premium models are never Free/unknown).
// ---------------------------------------------------------------------------

describe('ProxyServer tier routing — Property 2: selected-account guarantees', () => {
  beforeEach(() => {
    mockFetchKiroModels.mockReset()
    // All accounts are seeded, so a fetch would only happen if the pre-filter
    // leaked. Return [] so any errant probe caches "unsupported" (and is visible).
    mockFetchKiroModels.mockResolvedValue([])
  })
  afterEach(() => vi.restoreAllMocks())

  // Feature: smart-tier-based-proxy-routing, Property 2: For any account pool, any Requested_Model requiring capability selection, and any triedIds set, when tierRoutingEnabled is true the result of getNextAccountForModel (when non-null) is an account that (a) is tag-eligible, (b) has the model id in its capability cache, (c) is not in triedIds, and (d) passes AccountPool.isAccountAvailable; consequently a Premium_Model selection is never a Free- or unknown-tag account.
  // Validates: Requirements 1.2, 1.3, 4.4, 6.1, 6.3
  it('non-null premium selection is tag-eligible, cached, untried, available, and never Free/unknown', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ tag: anyTagArb, supports: fc.boolean(), state: stateArb, tried: fc.boolean() }),
          { minLength: 2, maxLength: 6 }
        ),
        premiumModelArb,
        async (specs, modelId) => {
          const ps = createMultiServer()
          const triedIds = new Set<string>()
          specs.forEach((spec, i) => {
            const id = `p2-acct-${i}`
            addPoolAccount(ps, id, spec.tag)
            if (spec.supports) seedCapability(ps, id, modelId)
            else seedEmptyCapability(ps, id)
            applyState(ps, id, spec.state)
            if (spec.tried) triedIds.add(id)
          })

          const result = await ps.getNextAccountForModel(new Set(triedIds), undefined, modelId)
          if (result === null) return

          // (a) tag-eligible => for premium that means paid OR unknown (hybrid: an
          // unknown-tag account may serve premium only once capability is CONFIRMED).
          expect(ps.isTagEligibleForModel(result, modelId)).toBe(true)
          const tier = ps.subscriptionTierOf(result)
          expect(tier === 'paid' || tier === 'unknown').toBe(true)
          expect(tier).not.toBe('free')
          // (b) model id present in capability cache (confirmed — true for paid AND
          // required for unknown under the hybrid gate)
          const cached = ps.accountModelCapabilityCache.get(result.id)
          expect(cached?.modelIds.has(normalizeKiroModelIdForCompare(modelId))).toBe(true)
          // (c) not in triedIds
          expect(triedIds.has(result.id)).toBe(false)
          // (d) available
          expect(ps.accountPool.isAccountAvailable(result)).toBe(true)
        }
      ),
      { numRuns: FC_RUNS }
    )
  })
})

// ---------------------------------------------------------------------------
// Property 4 — Standard models prefer Free while any Free is available.
// ---------------------------------------------------------------------------

describe('ProxyServer tier routing — Property 4: Free preference for standard models', () => {
  beforeEach(() => {
    mockFetchKiroModels.mockReset()
    mockFetchKiroModels.mockResolvedValue([])
  })
  afterEach(() => vi.restoreAllMocks())

  // Feature: smart-tier-based-proxy-routing, Property 4: For any account pool that contains at least one available Free-tag account, for any Standard_Model, when tierRoutingEnabled is true, the selected account has a Free-tag and is never a Paid_Tier account.
  // Validates: Requirements 6.4, 6.5
  it('selects a Free-tag account and never a Paid account when a Free account is available', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Extra accounts with free/paid tags in arbitrary states.
        fc.array(
          fc.record({ tag: fc.oneof(freeTagArb, paidTagArb), state: stateArb }),
          { maxLength: 5 }
        ),
        // A guaranteed available Free account (state fixed to 'available').
        paidTagArb, // an available paid account too, to make Paid a tempting alternative
        standardModelArb,
        async (extras, availablePaidTag, modelId) => {
          const ps = createMultiServer()
          // Guaranteed available Free account.
          addPoolAccount(ps, 'p4-free-avail', 'Free')
          // An available paid account, to prove Free is still preferred.
          addPoolAccount(ps, 'p4-paid-avail', availablePaidTag)
          extras.forEach((spec, i) => {
            const id = `p4-extra-${i}`
            addPoolAccount(ps, id, spec.tag)
            applyState(ps, id, spec.state)
          })

          const result = await ps.getNextAccountForModel(new Set(), undefined, modelId)
          expect(result).not.toBeNull()
          if (result) {
            expect(ps.subscriptionTierOf(result)).toBe('free')
            expect(ps.subscriptionTierOf(result)).not.toBe('paid')
          }
        }
      ),
      { numRuns: FC_RUNS }
    )
  })
})

// ---------------------------------------------------------------------------
// Property 5 — Standard models fall back to Paid only when all Free unavailable.
// ---------------------------------------------------------------------------

describe('ProxyServer tier routing — Property 5: Paid fallback for standard models', () => {
  beforeEach(() => {
    mockFetchKiroModels.mockReset()
    mockFetchKiroModels.mockResolvedValue([])
  })
  afterEach(() => vi.restoreAllMocks())

  // Feature: smart-tier-based-proxy-routing, Property 5: For any account pool in which every Free-tag account is unavailable (quota-exhausted, on cooldown, or suspended) and at least one Paid_Tier account is available, for any Standard_Model, when tierRoutingEnabled is true, the selected account (when non-null) is a Paid_Tier account.
  // Validates: Requirements 6.6
  it('falls back to a Paid account when every Free account is unavailable', async () => {
    await fc.assert(
      fc.asyncProperty(
        // >=1 Free accounts, each forced unavailable.
        fc.array(fc.record({ kind: unavailStateArb }), { minLength: 1, maxLength: 4 }),
        // >=1 additional Paid accounts in arbitrary states (at least one guaranteed available below).
        fc.array(fc.record({ tag: paidTagArb, state: stateArb }), { maxLength: 3 }),
        paidTagArb,
        standardModelArb,
        async (frees, paids, availablePaidTag, modelId) => {
          const ps = createMultiServer()
          frees.forEach((f, i) => {
            const id = `p5-free-${i}`
            addPoolAccount(ps, id, 'Free')
            applyState(ps, id, f.kind)
          })
          // Guaranteed available Paid account.
          addPoolAccount(ps, 'p5-paid-avail', availablePaidTag)
          paids.forEach((p, i) => {
            const id = `p5-paid-${i}`
            addPoolAccount(ps, id, p.tag)
            applyState(ps, id, p.state)
          })

          const result = await ps.getNextAccountForModel(new Set(), undefined, modelId)
          if (result === null) return
          expect(ps.subscriptionTierOf(result)).toBe('paid')
        }
      ),
      { numRuns: FC_RUNS }
    )
  })
})

// ---------------------------------------------------------------------------
// Property 6 — No eligible account yields null with no network probe.
// ---------------------------------------------------------------------------

describe('ProxyServer tier routing — Property 6: null selection, no probe', () => {
  beforeEach(() => {
    mockFetchKiroModels.mockReset()
    // If a non-eligible account were ever probed, this would "succeed" and be visible.
    mockFetchKiroModels.mockResolvedValue([
      { modelId: 'claude-opus-4.8', tokenLimits: { maxInputTokens: 200000 } }
    ])
  })
  afterEach(() => vi.restoreAllMocks())

  // Feature: smart-tier-based-proxy-routing, Property 6: For any account pool in which no account is both tag-eligible and capability-supported for a Requested_Model, when tierRoutingEnabled is true, getNextAccountForModel returns null and does not issue any fetchKiroModels call to a non-eligible account.
  // Validates: Requirements 1.4, 3.1
  it('returns null and never probes a non-eligible account', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Tag-ineligible accounts for a premium model: Free/unknown tags.
        fc.array(fc.oneof(freeTagArb, unknownTagArb), { minLength: 1, maxLength: 4 }),
        // Paid accounts that are tag-eligible but NOT capability-supported (seeded empty).
        fc.array(paidTagArb, { minLength: 1, maxLength: 3 }),
        premiumModelArb,
        async (ineligibleTags, paidTags, modelId) => {
          mockFetchKiroModels.mockClear()
          const ps = createMultiServer()

          // Free-tag accounts are HARD-excluded and must never be probed.
          // Unknown-tag accounts are hybrid: eligible by tag but require CONFIRMED
          // capability — seed them empty so the confirmed-gate fails from cache (no warm).
          const freeIds = new Set<string>()
          ineligibleTags.forEach((tag, i) => {
            const id = `p6-inelig-${i}`
            addPoolAccount(ps, id, tag)
            const tier = ps.subscriptionTierOf({ subscriptionType: tag })
            if (tier === 'free') freeIds.add(id)
            else seedEmptyCapability(ps, id) // unknown: confirmed-gate fails from cache
          })
          paidTags.forEach((tag, i) => {
            const id = `p6-paid-${i}`
            addPoolAccount(ps, id, tag)
            seedEmptyCapability(ps, id) // eligible by tag but unsupported by capability
          })

          const result = await ps.getNextAccountForModel(new Set(), undefined, modelId)
          expect(result).toBeNull()
          // A Free-tag account must NEVER be network-probed (hard tag exclusion).
          for (const call of mockFetchKiroModels.mock.calls) {
            expect(freeIds.has(call[0]?.id)).toBe(false)
          }
        }
      ),
      { numRuns: FC_RUNS }
    )
  })
})

// ---------------------------------------------------------------------------
// Example — round-robin strategy pass-through WITHIN a tier group.
// ---------------------------------------------------------------------------

describe('ProxyServer tier routing — round-robin within a group (example)', () => {
  beforeEach(() => {
    mockFetchKiroModels.mockReset()
    mockFetchKiroModels.mockResolvedValue([])
  })
  afterEach(() => vi.restoreAllMocks())

  // Requirements 6.2, 6.7: the configured accountSelectionStrategy runs WITHIN the
  // selected tier group. With round-robin over 3 Paid accounts (premium) and over
  // 3 Free accounts (standard), successive selections rotate within the correct group.
  it('premium: rotates across 3 Paid accounts, never leaving the Paid group', async () => {
    const ps = createMultiServer({ accountSelectionStrategy: 'round-robin' })
    for (let i = 0; i < 3; i++) {
      const id = `rr-paid-${i}`
      addPoolAccount(ps, id, 'Pro')
      seedCapability(ps, id, 'claude-opus-4.8')
    }
    const picked = new Set<string>()
    for (let n = 0; n < 6; n++) {
      const sel = await ps.getNextAccountForModel(new Set(), undefined, 'claude-opus-4.8')
      expect(sel).not.toBeNull()
      if (sel) {
        expect(ps.subscriptionTierOf(sel)).toBe('paid')
        picked.add(sel.id)
        ps.accountPool.recordSuccess(sel.id)
      }
    }
    // Stayed within the Paid group and covered more than one distinct account.
    expect(picked.size).toBeGreaterThan(1)
  })

  it('standard: rotates across 3 Free accounts, never selecting a Paid account', async () => {
    const ps = createMultiServer({ accountSelectionStrategy: 'round-robin' })
    for (let i = 0; i < 3; i++) {
      addPoolAccount(ps, `rr-free-${i}`, 'Free')
    }
    // A paid account exists but must never be chosen while Free accounts are available.
    addPoolAccount(ps, 'rr-paid-fallback', 'Pro')
    const picked = new Set<string>()
    for (let n = 0; n < 6; n++) {
      const sel = await ps.getNextAccountForModel(new Set(), undefined, 'claude-haiku-4.5')
      expect(sel).not.toBeNull()
      if (sel) {
        expect(ps.subscriptionTierOf(sel)).toBe('free')
        picked.add(sel.id)
        ps.accountPool.recordSuccess(sel.id)
      }
    }
    expect(picked.size).toBeGreaterThan(1)
    expect(picked.has('rr-paid-fallback')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Property 7 — Fail-fast reason classification is correct and mutually exclusive.
//
// classifyNoAccountReason inspects the Eligible_Account_Set (buildEligibleSet,
// which now applies the tag pre-filter) and returns exactly one reason:
//   - empty eligible set                       => 'model_unsupported'
//   - non-empty, all quota-exhausted           => 'quota_exhausted'
//   - non-empty, has quota but all on cooldown  => 'throttled'
// Eligibility ("who CAN serve") ignores availability, so quota/cooldown state is
// applied on top of tag+capability eligibility. Unavailable states use far-future
// timers so no real timer fires. Pools have >= 2 accounts.
// ---------------------------------------------------------------------------

describe('ProxyServer tier routing — Property 7: fail-fast reason classification', () => {
  beforeEach(() => {
    mockFetchKiroModels.mockReset()
    // Accounts are seeded directly; a fetch would only happen on a pre-filter leak.
    mockFetchKiroModels.mockResolvedValue([])
  })
  afterEach(() => vi.restoreAllMocks())

  const scenarioArb = fc.constantFrom<'empty' | 'allQuota' | 'throttled'>('empty', 'allQuota', 'throttled')

  // Feature: smart-tier-based-proxy-routing, Property 7: For any account pool and Requested_Model, classifyNoAccountReason returns exactly one reason such that: an empty Eligible_Account_Set yields 'model_unsupported'; a non-empty Eligible_Account_Set whose accounts are all quota-exhausted yields 'quota_exhausted'; and a non-empty Eligible_Account_Set that still has quota but is entirely on cooldown/rate-limited yields 'throttled'.
  // Validates: Requirements 3.3, 3.4
  it('returns exactly one correct reason for empty / all-quota / throttled eligible sets (>=200 runs)', async () => {
    await fc.assert(
      fc.asyncProperty(
        scenarioArb,
        // Number of accounts to build for the scenario (>= 2 accounts total).
        fc.integer({ min: 2, max: 5 }),
        premiumModelArb,
        async (scenario, count, modelId) => {
          const ps = createMultiServer()

          if (scenario === 'empty') {
            // Premium model + only tag-ineligible (Free/unknown) accounts =>
            // tag pre-filter empties the eligible set => model_unsupported.
            for (let i = 0; i < count; i++) {
              addPoolAccount(ps, `p7-empty-${i}`, i % 2 === 0 ? 'Free' : undefined)
            }
            const diag = await ps.classifyNoAccountReason(modelId, undefined, undefined)
            expect(diag.reason).toBe('model_unsupported')
            expect(diag.eligibleTotal).toBe(0)
          } else if (scenario === 'allQuota') {
            // Paid + capability-supported (eligible), every account quota-exhausted.
            for (let i = 0; i < count; i++) {
              const id = `p7-quota-${i}`
              addPoolAccount(ps, id, 'Pro')
              seedCapability(ps, id, modelId)
              applyState(ps, id, 'quota')
            }
            const diag = await ps.classifyNoAccountReason(modelId, undefined, undefined)
            expect(diag.reason).toBe('quota_exhausted')
            expect(diag.eligibleTotal).toBe(count)
            expect(diag.exhausted).toBe(count)
          } else {
            // Paid + capability-supported (eligible), still have quota but all on
            // far-future cooldown => throttled.
            for (let i = 0; i < count; i++) {
              const id = `p7-cool-${i}`
              addPoolAccount(ps, id, 'Pro')
              seedCapability(ps, id, modelId)
              applyState(ps, id, 'cooldown')
            }
            const diag = await ps.classifyNoAccountReason(modelId, undefined, undefined)
            expect(diag.reason).toBe('throttled')
            expect(diag.eligibleTotal).toBe(count)
            expect(diag.exhausted).toBe(0)
          }
        }
      ),
      { numRuns: FC_RUNS }
    )
  })
})

// ---------------------------------------------------------------------------
// Example — No_Eligible_Account_Error body shape (Requirement 3.2).
//
// Drives classifyNoAccountReason + sendNoEligibleAccountError serialization via a
// minimal fake ServerResponse that captures writeHead/end, then asserts the JSON
// body carries type/code/message and the requested model.
// ---------------------------------------------------------------------------

function fakeServerResponse(): { res: any; captured: { status?: number; headers?: any; body?: string } } {
  const captured: { status?: number; headers?: any; body?: string } = {}
  const res: any = {
    writableEnded: false,
    destroyed: false,
    writeHead: vi.fn((status: number, headers: any) => {
      captured.status = status
      captured.headers = headers
    }),
    end: vi.fn((body?: string) => {
      captured.body = body
      res.writableEnded = true
    })
  }
  return { res, captured }
}

describe('ProxyServer tier routing — No_Eligible_Account_Error body shape (example)', () => {
  beforeEach(() => {
    mockFetchKiroModels.mockReset()
    mockFetchKiroModels.mockResolvedValue([])
  })
  afterEach(() => vi.restoreAllMocks())

  // Requirement 3.2: the error body includes the requested model id and reason category.
  it('openai format body carries type=no_eligible_account, reason code, message, and model', async () => {
    const ps = createMultiServer()
    const modelId = 'claude-opus-4.8'
    // Free-only pool + premium model => empty eligible set => model_unsupported.
    addPoolAccount(ps, 'ex-free-1', 'Free')
    addPoolAccount(ps, 'ex-free-2', undefined)

    const diag = await ps.classifyNoAccountReason(modelId, undefined, undefined)
    expect(diag.reason).toBe('model_unsupported')

    const { res, captured } = fakeServerResponse()
    ps.sendNoEligibleAccountError(res, 503, diag, modelId, 'openai', '/v1/chat/completions')

    expect(captured.status).toBe(503)
    const parsed = JSON.parse(captured.body as string)
    expect(parsed.error.type).toBe('no_eligible_account')
    expect(parsed.error.code).toBe(diag.reason)
    expect(typeof parsed.error.message).toBe('string')
    expect(parsed.error.message.length).toBeGreaterThan(0)
    expect(parsed.error.model).toBe(modelId)
  })

  // Anthropic envelope stays valid (type:'error', error.type from getAnthropicErrorType)
  // while still surfacing the reason + model.
  it('anthropic format body keeps a valid envelope and surfaces reason + model', async () => {
    const ps = createMultiServer()
    const modelId = 'claude-opus-4.8'
    addPoolAccount(ps, 'ex-a-free-1', 'Free')
    addPoolAccount(ps, 'ex-a-free-2', undefined)

    const diag = await ps.classifyNoAccountReason(modelId, undefined, undefined)

    const { res, captured } = fakeServerResponse()
    ps.sendNoEligibleAccountError(res, 503, diag, modelId, 'anthropic', '/v1/messages')

    expect(captured.status).toBe(503)
    const parsed = JSON.parse(captured.body as string)
    expect(parsed.type).toBe('error')
    expect(parsed.error.type).toBe('api_error') // getAnthropicErrorType(503)
    expect(parsed.error.code).toBe('no_eligible_account')
    expect(parsed.error.reason).toBe(diag.reason)
    expect(parsed.error.model).toBe(modelId)
    expect(typeof parsed.error.message).toBe('string')
  })

  // Guards res.writableEnded/destroyed like sendError does.
  it('does not write when the response is already ended', async () => {
    const ps = createMultiServer()
    const diag = { reason: 'model_unsupported', message: 'x', eligibleTotal: 0, exhausted: 0, cooldown: 0 }
    const { res, captured } = fakeServerResponse()
    res.writableEnded = true
    ps.sendNoEligibleAccountError(res, 503, diag as any, 'claude-opus-4.8', 'openai', '/v1/chat/completions')
    expect(res.writeHead).not.toHaveBeenCalled()
    expect(captured.body).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Task 7.3 — Observability logging + RequestLog.tierRoutingActive recording.
//
// Requirement 7.1: a tier pre-filter log fires with excluded/remaining counts.
// Requirement 7.2: a selection log carries the account identifier + model.
// Requirement 7.3: a No_Eligible_Account_Error log carries the model + reason.
// Requirement 7.4: each request-log entry records whether tier routing was active.
//
// proxyLogger.info/warn are spied so we can assert the emitted messages without
// touching the log file. The selection-path harness (createMultiServer,
// addPoolAccount, seedCapability) is reused from the property tests above.
// ---------------------------------------------------------------------------

describe('ProxyServer tier routing — observability logging (Requirements 7.1, 7.2, 7.3)', () => {
  let infoSpy: any
  let warnSpy: any

  beforeEach(() => {
    mockFetchKiroModels.mockReset()
    mockFetchKiroModels.mockResolvedValue([])
    infoSpy = vi.spyOn(proxyLogger, 'info').mockImplementation(() => {})
    warnSpy = vi.spyOn(proxyLogger, 'warn').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  // Requirement 7.1: pre-filter log with excluded/remaining counts on a tier-routing selection.
  it('emits a pre-filter log with excluded and remaining counts during a tier-routing selection', async () => {
    const ps = createMultiServer()
    // Premium model: 2 Free (excluded) + 1 Pro (remaining, capability-supported).
    addPoolAccount(ps, 'log-free-1', 'Free')
    addPoolAccount(ps, 'log-free-2', 'Free')
    addPoolAccount(ps, 'log-paid-1', 'Pro')
    seedCapability(ps, 'log-paid-1', 'claude-opus-4.8')

    await ps.getNextAccountForModel(new Set(), undefined, 'claude-opus-4.8')

    const prefilterCall = infoSpy.mock.calls.find((c: any[]) =>
      typeof c[1] === 'string' && c[1].includes('Tier pre-filter for model claude-opus-4.8')
    )
    expect(prefilterCall).toBeDefined()
    // excluded 2 (the two Free accounts), remaining 1 (the Pro account).
    expect(prefilterCall[1]).toContain('excluded 2')
    expect(prefilterCall[1]).toContain('remaining 1')
  })

  // Requirement 7.2: selection log with the selected account identifier + model.
  it('emits a selection log with the selected account id and model', async () => {
    const ps = createMultiServer()
    addPoolAccount(ps, 'log-sel-paid', 'Pro')
    seedCapability(ps, 'log-sel-paid', 'claude-opus-4.8')

    const selected = await ps.getNextAccountForModel(new Set(), undefined, 'claude-opus-4.8')
    expect(selected).not.toBeNull()

    const selectionCall = infoSpy.mock.calls.find((c: any[]) =>
      typeof c[1] === 'string' && c[1].startsWith('Selected ') && c[1].includes('claude-opus-4.8')
    )
    expect(selectionCall).toBeDefined()
    // Account identifier (email or id prefix) is present in the message.
    const identifier = selected.email || selected.id.slice(0, 8)
    expect(selectionCall[1]).toContain(identifier)
  })

  // Requirement 7.3: no-eligible log with model + reason via sendNoEligibleAccountError.
  it('emits a no-eligible warn log with model and reason category', async () => {
    const ps = createMultiServer()
    const modelId = 'claude-opus-4.8'
    // Free-only pool + premium model => empty eligible set => model_unsupported.
    addPoolAccount(ps, 'log-ne-free-1', 'Free')
    addPoolAccount(ps, 'log-ne-free-2', undefined)

    const diag = await ps.classifyNoAccountReason(modelId, undefined, undefined)
    const { res } = fakeServerResponse()
    ps.sendNoEligibleAccountError(res, 503, diag, modelId, 'openai', '/v1/chat/completions')

    const noEligibleCall = warnSpy.mock.calls.find((c: any[]) =>
      typeof c[1] === 'string' && c[1].includes('No eligible account for model')
    )
    expect(noEligibleCall).toBeDefined()
    expect(noEligibleCall[1]).toContain(modelId)
    expect(noEligibleCall[1]).toContain(diag.reason)
  })
})

// ---------------------------------------------------------------------------
// Task 7.3 — RequestLog.tierRoutingActive recording (Requirement 7.4).
//
// recordRequest writes tierRoutingActive into the pushed RequestLog, defaulting
// to isTierRoutingActive() at record time when the caller omits it. The last
// entry of ps.stats.recentRequests is inspected via the `any` cast.
// ---------------------------------------------------------------------------

describe('ProxyServer tier routing — RequestLog.tierRoutingActive (Requirement 7.4)', () => {
  function lastLog(ps: any): any {
    const logs = ps.stats.recentRequests
    return logs[logs.length - 1]
  }

  it('defaults tierRoutingActive to true when tier routing is active', () => {
    const ps = createMultiServer() // tierRoutingEnabled: true
    ps.recordRequest({ path: '/v1/chat/completions', model: 'claude-opus-4.8', success: true })
    expect(lastLog(ps).tierRoutingActive).toBe(true)
  })

  it('defaults tierRoutingActive to true even without the (deprecated) flag set', () => {
    // Tier routing is always active by design, so the default is true regardless
    // of the deprecated tierRoutingEnabled flag being unset.
    const ps = createServer({ enableMultiAccount: true }) // tierRoutingEnabled unset
    ps.recordRequest({ path: '/v1/chat/completions', model: 'claude-opus-4.8', success: true })
    expect(lastLog(ps).tierRoutingActive).toBe(true)
  })

  it('honors an explicit tierRoutingActive override regardless of the flag', () => {
    // Flag on, but caller explicitly records false.
    const psOn = createMultiServer()
    psOn.recordRequest({ path: '/v1/messages', model: 'm', success: false, tierRoutingActive: false })
    expect(lastLog(psOn).tierRoutingActive).toBe(false)

    // Flag off, but caller explicitly records true.
    const psOff = createServer({ enableMultiAccount: true })
    psOff.recordRequest({ path: '/v1/messages', model: 'm', success: false, tierRoutingActive: true })
    expect(lastLog(psOff).tierRoutingActive).toBe(true)
  })
})
