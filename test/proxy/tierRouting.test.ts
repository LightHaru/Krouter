import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  classifyModel,
  allowedTiersForModel,
  isTagEligibleForModel,
  tierPreferenceGroups,
  groupAccountsByTier,
  poolTierSet,
  poolCanServeByTag,
  tagTierOf,
  TIER_PREFERENCE_ORDER
} from '../../src/main/proxy/tierRouting'
import { normalizeKiroTier, isPaidKiroTier } from '../../src/main/proxy/modelCatalog'
import type { KiroTier, ProxyAccount } from '../../src/main/proxy/types'

const FC_RUNS = 200

function acc(subscriptionType?: string): ProxyAccount {
  return { id: `a-${subscriptionType ?? 'none'}-${Math.random()}`, accessToken: 't', subscriptionType }
}

const TAGS = ['Free', 'Pro', 'Pro+', 'Pro_Plus', 'Power', 'Enterprise', 'Teams', '', 'garbage', undefined]

describe('normalizeKiroTier', () => {
  it('maps known tier strings + variants', () => {
    expect(normalizeKiroTier('Free')).toBe('free')
    expect(normalizeKiroTier('KIRO FREE')).toBe('free')
    expect(normalizeKiroTier('Q_DEVELOPER_STANDALONE_FREE')).toBe('free')
    expect(normalizeKiroTier('Pro')).toBe('pro')
    expect(normalizeKiroTier('Pro+')).toBe('pro_plus')
    expect(normalizeKiroTier('Pro Plus')).toBe('pro_plus')
    expect(normalizeKiroTier('PRO_PLUS')).toBe('pro_plus')
    expect(normalizeKiroTier('Power')).toBe('power')       // regression: Power != Enterprise
    expect(normalizeKiroTier('KIRO POWER')).toBe('power')
    expect(normalizeKiroTier('Enterprise')).toBe('enterprise')
    expect(normalizeKiroTier('Teams')).toBe('teams')
    expect(normalizeKiroTier('')).toBe('unknown')
    expect(normalizeKiroTier(undefined)).toBe('unknown')
    expect(normalizeKiroTier('something-weird')).toBe('unknown')
  })

  it('paid tiers are everything but free/unknown', () => {
    expect(isPaidKiroTier('pro')).toBe(true)
    expect(isPaidKiroTier('pro_plus')).toBe(true)
    expect(isPaidKiroTier('power')).toBe(true)
    expect(isPaidKiroTier('enterprise')).toBe(true)
    expect(isPaidKiroTier('teams')).toBe(true)
    expect(isPaidKiroTier('free')).toBe(false)
    expect(isPaidKiroTier('unknown')).toBe(false)
  })
})

describe('classifyModel', () => {
  it('opus family + configured premium ids are premium; others standard', () => {
    expect(classifyModel('claude-opus-4.8')).toBe('premium')
    expect(classifyModel('claude-opus-4-1')).toBe('premium') // normalized to 4.1
    expect(classifyModel('claude-sonnet-4.6')).toBe('premium')
    expect(classifyModel('claude-sonnet-4.5')).toBe('standard')
    expect(classifyModel('claude-haiku-4.5')).toBe('standard')
    expect(classifyModel('some-unmapped-model')).toBe('standard')
    expect(classifyModel(undefined)).toBe('standard')
  })
})

describe('isTagEligibleForModel (hybrid)', () => {
  it('standard model => any tier eligible', () => {
    for (const tag of TAGS) {
      expect(isTagEligibleForModel(acc(tag), 'claude-sonnet-4.5')).toBe(true)
    }
  })

  it('premium model => free excluded, paid allowed, UNKNOWN allowed (hybrid, fixes bug #3)', () => {
    expect(isTagEligibleForModel(acc('Free'), 'claude-opus-4.8')).toBe(false)
    expect(isTagEligibleForModel(acc('Pro'), 'claude-opus-4.8')).toBe(true)
    expect(isTagEligibleForModel(acc('Power'), 'claude-opus-4.8')).toBe(true)
    // unknown is NOT hard-excluded (capability cache confirms later)
    expect(isTagEligibleForModel(acc(undefined), 'claude-opus-4.8')).toBe(true)
    expect(isTagEligibleForModel(acc(''), 'claude-opus-4.8')).toBe(true)
    expect(isTagEligibleForModel(acc('garbage'), 'claude-opus-4.8')).toBe(true)
  })
})

describe('tierPreferenceGroups', () => {
  it('standard model => full preference order (free first, paid last)', () => {
    expect(tierPreferenceGroups('claude-sonnet-4.5')).toEqual(TIER_PREFERENCE_ORDER)
  })

  it('premium model => no free group; unknown tried last', () => {
    const groups = tierPreferenceGroups('claude-opus-4.8')
    expect(groups).not.toContain('free')
    expect(groups).toContain('unknown')
    expect(groups[groups.length - 1]).toBe('unknown')
    // every non-unknown group must be a paid tier
    for (const g of groups) {
      if (g !== 'unknown') expect(isPaidKiroTier(g)).toBe(true)
    }
  })
})

describe('groupAccountsByTier / poolTierSet / poolCanServeByTag', () => {
  const pool = [acc('Free'), acc('Free'), acc('Pro'), acc(undefined)]

  it('groups accounts by normalized tag tier', () => {
    const byTier = groupAccountsByTier(pool)
    expect(byTier.get('free')?.length).toBe(2)
    expect(byTier.get('pro')?.length).toBe(1)
    expect(byTier.get('unknown')?.length).toBe(1)
  })

  it('poolTierSet reflects present tiers', () => {
    const set = poolTierSet(pool)
    expect(set.has('free')).toBe(true)
    expect(set.has('pro')).toBe(true)
    expect(set.has('unknown')).toBe(true)
    expect(set.has('power')).toBe(false)
  })

  it('poolCanServeByTag: standard always true with accounts; premium needs paid-or-unknown', () => {
    expect(poolCanServeByTag(pool, 'claude-sonnet-4.5')).toBe(true)
    expect(poolCanServeByTag(pool, 'claude-opus-4.8')).toBe(true) // has Pro + unknown
    expect(poolCanServeByTag([acc('Free'), acc('Free')], 'claude-opus-4.8')).toBe(false) // free-only
    expect(poolCanServeByTag([], 'claude-sonnet-4.5')).toBe(false) // empty pool
  })
})

describe('property: premium selection never includes a Free-tagged account', () => {
  it('for any pool + premium model, free accounts are never in preference groups', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...TAGS), { minLength: 1, maxLength: 20 }), (tags) => {
        const pool = tags.map((t) => acc(t as string | undefined))
        const groups = new Set(tierPreferenceGroups('claude-opus-4.8'))
        const byTier = groupAccountsByTier(pool)
        // Free bucket must never be a group we iterate for a premium model.
        expect(groups.has('free')).toBe(false)
        // Every account whose tag tier is 'free' is tag-ineligible for premium.
        for (const account of byTier.get('free') ?? []) {
          expect(isTagEligibleForModel(account, 'claude-opus-4.8')).toBe(false)
        }
        return true
      }),
      { numRuns: FC_RUNS }
    )
  })
})

describe('property: allowedTiersForModel consistency', () => {
  it('standard => all tiers; premium => only paid tiers', () => {
    fc.assert(
      fc.property(fc.constantFrom('claude-sonnet-4.5', 'claude-opus-4.8', 'claude-haiku-4.5', 'unmapped-x'), (modelId) => {
        const allowed = allowedTiersForModel(modelId)
        if (classifyModel(modelId) === 'premium') {
          for (const t of allowed) expect(isPaidKiroTier(t as KiroTier)).toBe(true)
        } else {
          expect(allowed).toEqual(TIER_PREFERENCE_ORDER)
        }
        return true
      }),
      { numRuns: FC_RUNS }
    )
  })
})

describe('tagTierOf', () => {
  it('matches normalizeKiroTier over the account tag', () => {
    for (const tag of TAGS) {
      expect(tagTierOf(acc(tag))).toBe(normalizeKiroTier(tag as string | undefined))
    }
  })
})
