import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { ProxyServer } from '../../src/main/proxy/proxyServer'
import { normalizeKiroModelIdForCompare } from '../../src/main/proxy/modelCatalog'

const FC_RUNS = 200

// Build a minimal ProxyServer instance. The constructor only sets up in-memory
// state (config defaults, AccountPool, stats) and performs no network/server I/O.
// We access the private members (accountModelCapabilityCache, MODEL_CAPABILITY_CACHE_TTL,
// accountTier) through a typed `any` cast so we can test them directly without
// changing their visibility. We only ever seed the in-memory capability cache
// map; fetchKiroModels is never called and the HTTP server is never started.
function createServer(config?: any): any {
  return new ProxyServer(config) as any
}

// Seed the capability cache for an account id with an already-normalized set of
// model ids and a fresh timestamp (the cache contract stores normalized ids).
function seedCache(ps: any, accountId: string, modelIds: string[]): void {
  ps.accountModelCapabilityCache.set(accountId, {
    timestamp: Date.now(),
    modelIds: new Set(modelIds)
  })
}

// Generator for realistic claude model id fragments: family + version digits.
const familyArb = fc.constantFrom('sonnet', 'haiku', 'opus')
const versionArb = fc.tuple(
  fc.integer({ min: 1, max: 9 }),
  fc.option(fc.integer({ min: 0, max: 20 }), { nil: undefined })
)
const separatorArb = fc.constantFrom('-', '.')

// Produces ids like 'claude-opus-4', 'claude-opus-4-8', 'claude-opus-4.8',
// 'claude-sonnet-4.5', etc. Returns both raw and its normalized form.
const claudeModelIdArb = fc
  .tuple(familyArb, versionArb, separatorArb)
  .map(([family, [major, minor], sep]) => {
    const raw = minor === undefined
      ? `claude-${family}-${major}`
      : `claude-${family}-${major}${sep}${minor}`
    return raw
  })

describe('ProxyServer capability — tier inference & model id normalization', () => {
  // Feature: smart-proxy-account-rotation, Property 2: For any set of available (normalized) model ids of an account, accountTier returns 'power' if and only if the set contains at least one id starting with 'claude-opus-', otherwise 'free' (when cache present and fresh).
  it('Property 2: accountTier returns power iff the (normalized) model set contains a claude-opus- id', () => {
    fc.assert(
      fc.property(
        fc.array(claudeModelIdArb, { maxLength: 8 }),
        (rawIds) => {
          // The cache contract stores already-normalized ids.
          const normalizedIds = rawIds.map((id) => normalizeKiroModelIdForCompare(id))
          const ps = createServer()
          const accountId = 'acct-prop2'
          seedCache(ps, accountId, normalizedIds)

          const account = { id: accountId } as any
          const tier = ps.accountTier(account)

          const hasOpus = normalizedIds.some((id) => id.startsWith('claude-opus-'))
          if (hasOpus) {
            expect(tier).toBe('power')
            expect(ps.isPowerAccount(account)).toBe(true)
          } else {
            expect(tier).toBe('free')
            expect(ps.isPowerAccount(account)).toBe(false)
          }
        }
      ),
      { numRuns: FC_RUNS }
    )
  })

  // Feature: smart-proxy-account-rotation, Property 3: For any model id string, normalizeKiroModelIdForCompare(normalizeKiroModelIdForCompare(x)) === normalizeKiroModelIdForCompare(x); and variants like 'claude-opus-4-8' and 'claude-opus-4.8' normalize to the same value.
  it('Property 3a: normalizeKiroModelIdForCompare is idempotent for arbitrary strings', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.string(), claudeModelIdArb),
        (x) => {
          const once = normalizeKiroModelIdForCompare(x)
          const twice = normalizeKiroModelIdForCompare(once)
          expect(twice).toBe(once)
        }
      ),
      { numRuns: FC_RUNS }
    )
  })

  // Feature: smart-proxy-account-rotation, Property 3: For any model id string, normalizeKiroModelIdForCompare(normalizeKiroModelIdForCompare(x)) === normalizeKiroModelIdForCompare(x); and variants like 'claude-opus-4-8' and 'claude-opus-4.8' normalize to the same value.
  it('Property 3b: hyphen and dot separator variants normalize to the same value', () => {
    fc.assert(
      fc.property(
        familyArb,
        fc.integer({ min: 1, max: 9 }),
        fc.integer({ min: 0, max: 20 }),
        (family, major, minor) => {
          const hyphen = `claude-${family}-${major}-${minor}`
          const dot = `claude-${family}-${major}.${minor}`
          const normHyphen = normalizeKiroModelIdForCompare(hyphen)
          const normDot = normalizeKiroModelIdForCompare(dot)
          expect(normHyphen).toBe(normDot)
          expect(normHyphen).toBe(`claude-${family}-${major}.${minor}`)
        }
      ),
      { numRuns: FC_RUNS }
    )
  })

  it('Property 3 (example): claude-opus-4-8 and claude-opus-4.8 normalize identically', () => {
    expect(normalizeKiroModelIdForCompare('claude-opus-4-8')).toBe('claude-opus-4.8')
    expect(normalizeKiroModelIdForCompare('claude-opus-4.8')).toBe('claude-opus-4.8')
    expect(normalizeKiroModelIdForCompare('CLAUDE-OPUS-4-8')).toBe('claude-opus-4.8')
  })
})

// ---------------------------------------------------------------------------
// Property 4 & 5 — getNextAccountForModel selection invariants.
//
// We drive the real selection path (getNextAccountForModel → getNextAccountForRequest
// → AccountPool.getNextAccount + smart scoring), but we pre-seed
// accountModelCapabilityCache for every account so accountSupportsModel resolves
// purely from cache and NEVER calls fetchKiroModels (no network). 'power' accounts
// carry a claude-opus-* id; 'free' accounts omit any opus id.
//
// Requested model is always 'claude-opus-4.8', which requiresModelCapabilitySelection.
//
// Cooldown approach for Property 4 (approach (ii) from the task): every account in a
// "cooldown" state is given cooldownUntil = now + COOLDOWN_FAR_MS, well beyond
// MAX_COMPATIBLE_COOLDOWN_WAIT_MS (65s). getCompatibleModelCooldownWaitMs therefore
// always reports a wait > the threshold, so getNextAccountForModel returns null
// instead of sleeping/recursing. No real timer waits occur inside the property loop.
// ---------------------------------------------------------------------------

const COOLDOWN_FAR_MS = 10 * 60 * 1000 // 600000ms > MAX_COMPATIBLE_COOLDOWN_WAIT_MS (65000ms)
const OPUS_MODEL = 'claude-opus-4.8'

type AvailabilityState = 'available' | 'cooldown' | 'quota' | 'suspended'

function seedTierCache(ps: any, accountId: string, tier: 'power' | 'free'): void {
  const modelIds = tier === 'power'
    ? ['claude-opus-4.8', 'claude-sonnet-4.5']
    : ['claude-sonnet-4.5']
  seedCache(ps, accountId, modelIds.map((id) => normalizeKiroModelIdForCompare(id)))
}

// Apply an availability state to a base account. Unavailable states use mechanisms
// that AccountPool.isAccountAvailable short-circuits on (suspendedAt / quotaExhaustedAt
// / future cooldownUntil), independent of the probabilistic circuit breaker (errorCount=0).
function applyState(base: any, state: AvailabilityState, now: number): any {
  switch (state) {
    case 'cooldown':
      return { ...base, cooldownUntil: now + COOLDOWN_FAR_MS }
    case 'quota':
      return { ...base, quotaExhaustedAt: now, quotaResetAt: now + 60 * 60 * 1000 }
    case 'suspended':
      return { ...base, suspendedAt: now, suspendReason: 'TEST_SUSPEND' }
    case 'available':
    default:
      return base
  }
}

describe('ProxyServer capability — getNextAccountForModel selection invariants', () => {
  const tierArb = fc.constantFrom<'power' | 'free'>('power', 'free')
  const stateArb = fc.constantFrom<AvailabilityState>('available', 'cooldown', 'quota', 'suspended')

  // Feature: smart-proxy-account-rotation, Property 4: For any account pool, any capability-requiring Requested_Model, and any triedIds set, the result of getNextAccountForModel (when non-null) is an account that supports the requested model, is not in triedIds, and is not suspended / quota-exhausted / on cooldown (passes isAccountAvailable).
  // Validates: Requirements 2.1, 2.2, 2.3, 4.1, 4.2, 5.1
  it('Property 4: getNextAccountForModel only returns eligible, untried, available accounts', async () => {
    await fc.assert(
      fc.asyncProperty(
        // >=2 accounts so AccountPool never takes its single-account bypass (which
        // ignores availability). Each spec: tier, availability state, whether tried.
        fc.array(
          fc.record({ tier: tierArb, state: stateArb, tried: fc.boolean() }),
          { minLength: 2, maxLength: 8 }
        ),
        async (specs) => {
          const now = Date.now()
          const ps = createServer()
          const triedIds = new Set<string>()

          specs.forEach((spec, i) => {
            const id = `p4-acct-${i}`
            const base: any = {
              id,
              email: `${id}@test`,
              accessToken: 'tok',
              errorCount: 0,
              groupId: undefined
            }
            ps.accountPool.addAccount(applyState(base, spec.state, now))
            seedTierCache(ps, id, spec.tier)
            if (spec.tried) triedIds.add(id)
          })

          const result = await ps.getNextAccountForModel(new Set(triedIds), undefined, OPUS_MODEL)

          if (result !== null) {
            // (b) not in triedIds
            expect(triedIds.has(result.id)).toBe(false)
            // (a) supports the requested opus model (cache contains the normalized id)
            const cached = ps.accountModelCapabilityCache.get(result.id)
            expect(cached).toBeTruthy()
            expect(cached.modelIds.has(normalizeKiroModelIdForCompare(OPUS_MODEL))).toBe(true)
            // (c) passes isAccountAvailable (not suspended / quota-exhausted / cooldown)
            expect(ps.accountPool.isAccountAvailable(result)).toBe(true)
          }
        }
      ),
      { numRuns: FC_RUNS }
    )
  })

  // Feature: smart-proxy-account-rotation, Property 5: For any pool, any apiKeyAccountBindings config, and any multiAccountSelectionMode='groups' + multiAccountGroupIds config, the selected account (when non-null) is in the API-key-allowed set AND belongs to a selected group.
  // Validates: Requirements 2.4, 8.4
  it('Property 5: getNextAccountForModel respects apiKeyAccountBindings and group membership', async () => {
    const groupArb = fc.constantFrom<string | undefined>('g1', 'g2', 'g3', undefined)
    const groupChoices = ['g1', 'g2', 'g3', '__ungrouped__']

    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({ groupId: groupArb, allowed: fc.boolean() }),
          { minLength: 2, maxLength: 8 }
        ),
        // Subset of group ids that are "selected" for the request.
        fc.subarray(groupChoices, { minLength: 0, maxLength: groupChoices.length }),
        async (specs, selectedGroups) => {
          const apiKeyId = 'key1'
          const ids = specs.map((_, i) => `p5-acct-${i}`)
          const allowedIds = ids.filter((_, i) => specs[i].allowed)

          const ps = createServer({
            enableMultiAccount: true,
            accountSelectionStrategy: 'smart',
            multiAccountSelectionMode: 'groups',
            multiAccountGroupIds: selectedGroups,
            apiKeyAccountBindings: { [apiKeyId]: allowedIds }
          })

          specs.forEach((spec, i) => {
            const id = ids[i]
            // All accounts available + power tier, so only membership constraints
            // (bindings + group) decide eligibility.
            ps.accountPool.addAccount({
              id,
              email: `${id}@test`,
              accessToken: 'tok',
              errorCount: 0,
              groupId: spec.groupId
            } as any)
            seedTierCache(ps, id, 'power')
          })

          const result = await ps.getNextAccountForModel(new Set(), apiKeyId, OPUS_MODEL)

          if (result !== null) {
            // API-key binding constraint: empty bindings => unrestricted (getAllowedAccountIds
            // returns undefined). Otherwise the selected id must be in the allowed set.
            if (allowedIds.length > 0) {
              expect(allowedIds).toContain(result.id)
            }
            // Group membership constraint (mode='groups'): account's effective group
            // (groupId or '__ungrouped__') must be among the selected groups.
            const effectiveGroup = result.groupId || '__ungrouped__'
            expect(selectedGroups).toContain(effectiveGroup)
          }
        }
      ),
      { numRuns: FC_RUNS }
    )
  })
})
