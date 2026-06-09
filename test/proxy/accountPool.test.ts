import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  AccountPool,
  ErrorType,
  classifyError,
  isThrottleError,
  isBillingOrQuotaError
} from '../../src/main/proxy/accountPool'
import type { ProxyAccount } from '../../src/main/proxy/types'

const FC_RUNS = 200

// DEFAULT_CONFIG values mirrored from accountPool.ts (the module does not export
// them). These tests rely on the AccountPool default configuration.
const THROTTLE_COOLDOWN_MS = 5000
const MAX_THROTTLE_COOLDOWN_MS = 10000
const MAX_BACKOFF_MULTIPLIER = 1440
const QUOTA_RESET_MS = 3600000

// Timing tolerance (ms). recordError() reads its own Date.now() internally, which
// is always >= the `now` we capture just before the call. So observed durations
// are in [expected, expected + tolerance]. A small slack absorbs scheduler jitter.
const TIMING_TOLERANCE_MS = 250

// The cooldown formula for a 429 throttle error after `errorCount` consecutive
// failures, matching getCooldownMs() in accountPool.ts under DEFAULT_CONFIG.
function expectedThrottleCooldown(errorCount: number): number {
  const backoffMultiplier = Math.min(Math.pow(2, Math.max(0, errorCount - 1)), MAX_BACKOFF_MULTIPLIER)
  return Math.min(THROTTLE_COOLDOWN_MS * backoffMultiplier, MAX_THROTTLE_COOLDOWN_MS)
}

// Create a fresh pool with a single freshly-added account ready for error/success
// recording. Returns the pool and the account id.
function makePoolWithAccount(overrides: Partial<ProxyAccount> = {}): { pool: AccountPool; id: string } {
  const pool = new AccountPool()
  const id = 'acct-1'
  const account: ProxyAccount = {
    id,
    email: `${id}@test`,
    accessToken: 'tok',
    errorCount: 0,
    ...overrides
  }
  pool.addAccount(account)
  return { pool, id }
}

describe('AccountPool — 429 throttle cooldown bounds & backoff cap (Property 6)', () => {
  // Feature: smart-proxy-account-rotation, Property 6: For any errorCount >= 1, the cooldown after a Throttle_Error (status 429) equals min(throttleCooldownMs * 2^(min(errorCount-1, log2(maxBackoffMultiplier))), maxThrottleCooldownMs), always within [throttleCooldownMs, maxThrottleCooldownMs], and does NOT set quotaExhaustedAt.
  // Validates: Requirements 3.3, 3.6
  it('Property 6: N consecutive 429 errors produce a bounded, backoff-capped cooldown and never set quotaExhaustedAt', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 14 }), (n) => {
        const { pool, id } = makePoolWithAccount()

        // Apply n-1 errors first; capture `now` immediately before the final one so
        // the asserted duration corresponds to errorCount === n.
        for (let i = 0; i < n - 1; i++) {
          pool.recordError(id, ErrorType.RECOVERABLE, 429)
        }
        const now = Date.now()
        pool.recordError(id, ErrorType.RECOVERABLE, 429)

        const account = pool.getAccount(id)!
        expect(account.cooldownUntil).toBeTypeOf('number')

        const expected = expectedThrottleCooldown(n)
        const actualDuration = account.cooldownUntil! - now

        // Equals the formula within timing tolerance (pool's internal now >= our now).
        expect(actualDuration).toBeGreaterThanOrEqual(expected)
        expect(actualDuration).toBeLessThanOrEqual(expected + TIMING_TOLERANCE_MS)

        // Always within [throttleCooldownMs, maxThrottleCooldownMs].
        expect(expected).toBeGreaterThanOrEqual(THROTTLE_COOLDOWN_MS)
        expect(expected).toBeLessThanOrEqual(MAX_THROTTLE_COOLDOWN_MS)

        // 429 must never exhaust quota.
        expect(account.quotaExhaustedAt).toBeUndefined()
      }),
      { numRuns: FC_RUNS }
    )
  })
})

describe('AccountPool — 429 never exhausts quota (Property 7)', () => {
  // Feature: smart-proxy-account-rotation, Property 7: For any account and any number of repeated recordError(id, RECOVERABLE, 429) calls, quotaExhaustedAt is always undefined and cooldownUntil is set to a future timestamp.
  // Validates: Requirements 3.1
  it('Property 7: repeated 429 errors keep quotaExhaustedAt undefined and cooldownUntil in the future', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 25 }), (n) => {
        const { pool, id } = makePoolWithAccount()

        for (let i = 0; i < n; i++) {
          const before = Date.now()
          pool.recordError(id, ErrorType.RECOVERABLE, 429)
          const account = pool.getAccount(id)!
          // Invariant holds after every single recordError, not just at the end.
          expect(account.quotaExhaustedAt).toBeUndefined()
          expect(account.cooldownUntil).toBeTypeOf('number')
          expect(account.cooldownUntil!).toBeGreaterThan(before)
        }
      }),
      { numRuns: FC_RUNS }
    )
  })
})

describe('AccountPool — 402 sets quota state correctly (Property 8)', () => {
  // Three ways to seed the initial quotaResetAt relative to `now`:
  //  - undefined: no prior reset time
  //  - clearly in the past: old <= now
  //  - clearly in the future: old > now (preserved by the 402 branch)
  // Large magnitudes (>= 10s) keep the comparison stable despite the few-ms gap
  // between our captured `now` and the pool's internal Date.now().
  type InitialReset = { kind: 'none' } | { kind: 'past'; offset: number } | { kind: 'future'; offset: number }

  const initialResetArb = fc.oneof(
    fc.constant<InitialReset>({ kind: 'none' }),
    fc.integer({ min: 10000, max: 5_000_000 }).map((offset) => ({ kind: 'past' as const, offset })),
    fc.integer({ min: 10000, max: 100_000_000 }).map((offset) => ({ kind: 'future' as const, offset }))
  )

  // Feature: smart-proxy-account-rotation, Property 8: For any account with an arbitrary initial quotaResetAt, after recordError(id, RECOVERABLE, 402) (or markQuotaExhausted): quotaExhaustedAt is set, cooldownUntil is undefined, quotaResetAt === (old quotaResetAt if it is still > now, else now + quotaResetMs), and isQuotaExhausted returns true until quotaResetAt <= now.
  // Validates: Requirements 3.4
  it('Property 8: 402 sets quotaExhaustedAt, clears cooldown, applies the quotaResetAt rule, and marks the account exhausted', () => {
    fc.assert(
      fc.property(initialResetArb, fc.boolean(), (initial, useMarkHelper) => {
        const now = Date.now()
        let initialResetAt: number | undefined
        if (initial.kind === 'past') initialResetAt = now - initial.offset
        else if (initial.kind === 'future') initialResetAt = now + initial.offset

        const { pool, id } = makePoolWithAccount({ quotaResetAt: initialResetAt })

        // markQuotaExhausted is defined as recordError(id, RECOVERABLE, 402).
        if (useMarkHelper) {
          pool.markQuotaExhausted(id)
        } else {
          pool.recordError(id, ErrorType.RECOVERABLE, 402)
        }

        const account = pool.getAccount(id)!

        // quotaExhaustedAt is set.
        expect(account.quotaExhaustedAt).toBeTypeOf('number')
        expect(account.quotaExhaustedAt!).toBeGreaterThan(0)

        // cooldownUntil is NOT set on the quota path.
        expect(account.cooldownUntil).toBeUndefined()

        // quotaResetAt rule: preserve a future old value, otherwise now + quotaResetMs.
        if (initial.kind === 'future') {
          expect(account.quotaResetAt).toBe(initialResetAt)
        } else {
          expect(account.quotaResetAt).toBeTypeOf('number')
          expect(account.quotaResetAt!).toBeGreaterThanOrEqual(now + QUOTA_RESET_MS)
          expect(account.quotaResetAt!).toBeLessThanOrEqual(now + QUOTA_RESET_MS + TIMING_TOLERANCE_MS)
        }

        // Exhausted now (quotaResetAt is in the future), recovered once reset time passes.
        expect(pool.isQuotaExhausted(account, now)).toBe(true)
        expect(pool.isQuotaExhausted(account, account.quotaResetAt!)).toBe(false)
      }),
      { numRuns: FC_RUNS }
    )
  })
})

describe('AccountPool — success restores health (Property 9)', () => {
  // A recoverable error in an arbitrary sequence: 429 (throttle) or 402 (quota).
  const recoverableStatusArb = fc.constantFrom(429, 402)

  // Feature: smart-proxy-account-rotation, Property 9: For any account after an arbitrary sequence of recoverable errors, after recordSuccess the account has errorCount === 0, cooldownUntil === undefined, lastErrorStatus === undefined, and isAvailable === true.
  // Validates: Requirements 3.5
  it('Property 9: recordSuccess resets errorCount, cooldownUntil, lastErrorStatus and restores availability', () => {
    fc.assert(
      fc.property(
        fc.array(recoverableStatusArb, { minLength: 1, maxLength: 15 }),
        fc.integer({ min: 0, max: 100000 }),
        fc.integer({ min: 0, max: 100000 }),
        (statuses, tokens, credits) => {
          const { pool, id } = makePoolWithAccount()

          for (const status of statuses) {
            pool.recordError(id, ErrorType.RECOVERABLE, status)
          }

          pool.recordSuccess(id, tokens, credits)

          const account = pool.getAccount(id)!
          expect(account.errorCount).toBe(0)
          expect(account.cooldownUntil).toBeUndefined()
          expect(account.lastErrorStatus).toBeUndefined()
          expect(account.isAvailable).toBe(true)
        }
      ),
      { numRuns: FC_RUNS }
    )
  })
})

// ---------------------------------------------------------------------------
// Property 10–15 (Task 5.2): error classification, smart-score monotonicity,
// success accounting, unavailable-never-selected, getQuotaStatus bounds.
// ---------------------------------------------------------------------------

// JITTER_SLACK absorbs the stable per-account jitter in scoreAccountForSmartBalance.
// stableAccountJitter = Math.abs(hash % 17) / 10, so its range is [0, 1.6]. Two
// accounts can therefore differ by at most 1.6 purely due to jitter. We pick 2
// (> 1.6) as a safe slack so a genuinely "better-or-equal" account never loses
// to jitter noise in the monotonicity assertion.
const JITTER_SLACK = 2

// Innocuous filler tokens that cannot match any throttle/billing/endpoint regex
// in accountPool.ts. Deliberately excludes 'rate', 'limit', 'credit', 'quota',
// 'throttl', 'payment', 'billing', 'balance', 'usage', 'monthly', 'reached',
// 'exhausted', 'exceeded', 'on', 'amazonq', 'codewhisperer', 'endpoint', digits, etc.
const safeWordArb = fc.constantFrom(
  'alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'server', 'context',
  'session', 'connection', 'timeout', 'status', 'code', 'error', 'message', 'detail'
)
const fillerArb = fc.array(safeWordArb, { maxLength: 5 }).map((words) => words.join(' '))

// Phrases that genuinely match isBillingOrQuotaError but NOT isEndpointRateLimitError.
const billingPhraseArb = fc.constantFrom(
  '402', 'payment required', 'out of credits', 'run out of credits',
  'insufficient credits', 'insufficient balance', 'credit balance', 'no credits',
  'no remaining credits', 'credits exhausted', 'credits depleted', 'quota exhausted',
  'quota exceeded', 'quota reached', 'service quota exceeded',
  'servicequotaexceededexception', 'reached the limit', 'reached your usage limit',
  'usage limit reached', 'usage limit exceeded', 'monthly limit reached',
  'monthly limit exceeded'
)

// Phrases that are genuine throttling signals (recognized by isThrottleError) and
// that must NOT be misread as billing/quota by isBillingOrQuotaError.
const throttlePhraseArb = fc.constantFrom(
  '429', 'throttle', 'throttling', 'throttled', 'too many requests',
  'rate limit', 'rate-limit', 'rate_limit'
)

describe('AccountPool — error classification (Property 10)', () => {
  // Feature: smart-proxy-account-rotation, Property 10: For any message matched by isBillingOrQuotaError but NOT by isEndpointRateLimitError, classifyError(402, message) === ErrorType.RECOVERABLE; and any throttle phrase (429/throttle/too many requests/rate limit) is recognized by isThrottleError and NOT misclassified as a real billing/quota error by isBillingOrQuotaError.
  // Validates: Requirements 3.2
  it('Property 10: billing/quota phrases classify as RECOVERABLE and throttle phrases are throttle-only', () => {
    fc.assert(
      fc.property(billingPhraseArb, fillerArb, fillerArb, (phrase, pre, post) => {
        const message = `${pre} ${phrase} ${post}`.trim()
        // The phrase is a genuine billing/quota signal...
        expect(isBillingOrQuotaError(message)).toBe(true)
        // ...so classifyError(402, message) must be RECOVERABLE (fail over the account).
        expect(classifyError(402, message)).toBe(ErrorType.RECOVERABLE)
      }),
      { numRuns: FC_RUNS }
    )

    fc.assert(
      fc.property(throttlePhraseArb, fillerArb, fillerArb, (phrase, pre, post) => {
        const message = `${pre} ${phrase} ${post}`.trim()
        // Throttle phrases are recognized as throttling...
        expect(isThrottleError(message)).toBe(true)
        // ...and must NOT be treated as a real billing/quota exhaustion.
        expect(isBillingOrQuotaError(message)).toBe(false)
      }),
      { numRuns: FC_RUNS }
    )
  })
})

describe('AccountPool — smart score monotonicity (Property 11)', () => {
  // Feature: smart-proxy-account-rotation, Property 11: For any pair of accounts A and B where A is better-or-equal on every priority dimension (quota remaining >=, errorCount <=, requestCount <=, idle time >=), scoreAccountForSmartBalance(A) + JITTER_SLACK >= scoreAccountForSmartBalance(B), i.e. the smart score is monotone in the priority dimensions up to the stable jitter slack.
  // Validates: Requirements 5.2
  it('Property 11: an account better-or-equal on all dimensions scores at least as high (up to jitter slack)', () => {
    const NOW = 1_000_000_000_000
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),   // shared quotaLimit
        fc.integer({ min: 0, max: 100_000 }),   // remainingB (clamped to limit below)
        fc.integer({ min: 0, max: 100_000 }),   // extra remaining for A
        fc.integer({ min: 0, max: 12 }),        // errorCountB
        fc.integer({ min: 0, max: 12 }),        // errorCount reduction for A
        fc.integer({ min: 0, max: 300 }),       // requestCountB
        fc.integer({ min: 0, max: 300 }),       // requestCount reduction for A
        fc.integer({ min: 0, max: 5_000_000 }), // idleB (ms)
        fc.integer({ min: 0, max: 5_000_000 }), // extra idle for A
        (limit, remBraw, remAExtra, errB, errADrop, reqB, reqADrop, idleB, idleAExtra) => {
          const pool = new AccountPool()

          const remB = Math.min(remBraw, limit)
          const remA = Math.min(remB + remAExtra, limit)   // remA >= remB  => quota remaining A >= B
          const errA = Math.max(0, errB - errADrop)        // errA <= errB
          const reqA = Math.max(0, reqB - reqADrop)        // reqA <= reqB
          const idleA = idleB + idleAExtra                 // idleA >= idleB

          const accountA: ProxyAccount = {
            id: 'acct-A', accessToken: 'tok',
            quotaLimit: limit, quotaUsed: limit - remA,
            errorCount: errA, requestCount: reqA,
            lastUsed: NOW - idleA
          }
          const accountB: ProxyAccount = {
            id: 'acct-B', accessToken: 'tok',
            quotaLimit: limit, quotaUsed: limit - remB,
            errorCount: errB, requestCount: reqB,
            lastUsed: NOW - idleB
          }

          const scoreA = (pool as any).scoreAccountForSmartBalance(accountA, NOW) as number
          const scoreB = (pool as any).scoreAccountForSmartBalance(accountB, NOW) as number

          expect(scoreA + JITTER_SLACK).toBeGreaterThanOrEqual(scoreB)
        }
      ),
      { numRuns: FC_RUNS }
    )
  })
})

describe('AccountPool — success increments exactly one request (Property 12)', () => {
  // Feature: smart-proxy-account-rotation, Property 12: For an account in any state, recordSuccess increments requestCount by exactly 1 and updates lastUsed to (approximately) the current time.
  // Validates: Requirements 5.4
  it('Property 12: recordSuccess increments requestCount by exactly 1 and sets lastUsed to ~now', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),  // initial requestCount
        fc.integer({ min: 0, max: 100_000 }),  // tokens
        fc.integer({ min: 0, max: 100_000 }),  // credits
        (initialRequests, tokens, credits) => {
          const { pool, id } = makePoolWithAccount({ requestCount: initialRequests })

          const before = Date.now()
          pool.recordSuccess(id, tokens, credits)
          const after = Date.now()

          const account = pool.getAccount(id)!
          expect(account.requestCount).toBe(initialRequests + 1)
          expect(account.lastUsed).toBeTypeOf('number')
          expect(account.lastUsed!).toBeGreaterThanOrEqual(before)
          expect(account.lastUsed!).toBeLessThanOrEqual(after)
        }
      ),
      { numRuns: FC_RUNS }
    )
  })
})

describe('AccountPool — unavailable accounts are never selected (Property 13)', () => {
  // Each unavailable reason keeps errorCount === 0 so the probabilistic-retry
  // branch in isAccountAvailable is never taken; every reason below is therefore
  // a deterministic "unavailable".
  type UnavailableReason = 'suspend' | 'quota' | 'cooldown'
  const reasonArb = fc.constantFrom<UnavailableReason>('suspend', 'quota', 'cooldown')

  function buildUnavailable(id: string, reason: UnavailableReason, now: number): ProxyAccount {
    const base: ProxyAccount = { id, accessToken: 'tok', errorCount: 0 }
    if (reason === 'suspend') return { ...base, suspendedAt: now, suspendReason: 'TEMPORARILY_SUSPENDED' }
    if (reason === 'quota') return { ...base, quotaExhaustedAt: now }
    return { ...base, cooldownUntil: now + 10_000_000 } // far-future cooldown
  }

  function buildAvailable(id: string): ProxyAccount {
    return { id, accessToken: 'tok', errorCount: 0 }
  }

  // Feature: smart-proxy-account-rotation, Property 13: For any pool of >=2 accounts that are all unavailable (suspended, quota-exhausted, or in cooldown), getNextAccount returns null; and for any mixed pool, the returned account is non-null and satisfies isAccountAvailable.
  // Validates: Requirements 5.5
  it('Property 13: all-unavailable pool returns null', () => {
    fc.assert(
      fc.property(fc.array(reasonArb, { minLength: 2, maxLength: 6 }), (reasons) => {
        const pool = new AccountPool()
        const now = Date.now()
        reasons.forEach((reason, i) => pool.addAccount(buildUnavailable(`acct-${i}`, reason, now)))

        expect(pool.getNextAccount()).toBeNull()
      }),
      { numRuns: FC_RUNS }
    )
  })

  it('Property 13: mixed pool returns a non-null account that is available', () => {
    fc.assert(
      fc.property(
        fc.array(reasonArb, { minLength: 1, maxLength: 5 }), // unavailable accounts
        fc.integer({ min: 1, max: 3 }),                       // available accounts
        (reasons, availableCount) => {
          const pool = new AccountPool()
          const now = Date.now()
          reasons.forEach((reason, i) => pool.addAccount(buildUnavailable(`unavail-${i}`, reason, now)))
          for (let i = 0; i < availableCount; i++) pool.addAccount(buildAvailable(`avail-${i}`))

          const result = pool.getNextAccount()
          expect(result).not.toBeNull()
          expect(pool.isAccountAvailable(result!)).toBe(true)
        }
      ),
      { numRuns: FC_RUNS }
    )
  })
})

describe('AccountPool — getQuotaStatus bounds (Property 15)', () => {
  // An arbitrary account with a random mix of health/quota/cooldown/suspend fields.
  const accountSpecArb = fc.record({
    quotaLimit: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: undefined }),
    quotaUsed: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: undefined }),
    quotaExhaustedAt: fc.option(fc.integer({ min: 0, max: 2_000_000_000_000 }), { nil: undefined }),
    quotaResetAt: fc.option(fc.integer({ min: 0, max: 4_000_000_000_000 }), { nil: undefined }),
    cooldownUntil: fc.option(fc.integer({ min: 0, max: 4_000_000_000_000 }), { nil: undefined }),
    suspendedAt: fc.option(fc.integer({ min: 0, max: 2_000_000_000_000 }), { nil: undefined }),
    errorCount: fc.integer({ min: 0, max: 10 }),
    requestCount: fc.integer({ min: 0, max: 1000 }),
    lastUsed: fc.option(fc.integer({ min: 0, max: 2_000_000_000_000 }), { nil: undefined }),
    isAvailable: fc.option(fc.boolean(), { nil: undefined }),
    expiresAt: fc.option(fc.integer({ min: 0, max: 4_000_000_000_000 }), { nil: undefined })
  })

  // Feature: smart-proxy-account-rotation, Property 15: For any pool of accounts, getQuotaStatus returns total === number of accounts, with available, exhausted and cooldown all non-negative and available + exhausted + cooldown <= total.
  // Validates: Requirements 7.5
  it('Property 15: getQuotaStatus partitions are non-negative and bounded by the total', () => {
    fc.assert(
      fc.property(fc.array(accountSpecArb, { maxLength: 12 }), (specs) => {
        const pool = new AccountPool()
        specs.forEach((spec, i) => pool.addAccount({ id: `acct-${i}`, accessToken: 'tok', ...spec }))

        const status = pool.getQuotaStatus()

        expect(status.total).toBe(specs.length)
        expect(status.available).toBeGreaterThanOrEqual(0)
        expect(status.exhausted).toBeGreaterThanOrEqual(0)
        expect(status.cooldown).toBeGreaterThanOrEqual(0)
        expect(status.available + status.exhausted + status.cooldown).toBeLessThanOrEqual(status.total)
      }),
      { numRuns: FC_RUNS }
    )
  })
})
