// Phase 8, 9 tests: Account health scoring and quota predictions
import { describe, it, expect } from 'vitest'
import { AccountPool } from '../../src/main/proxy/accountPool'

describe('Phase 8: Account Health Dashboard', () => {
  it('returns health metrics for an account', () => {
    const pool = new AccountPool()
    pool.addAccount({
      id: 'test-1',
      email: 'test@example.com',
      token: 'tok',
      isAvailable: true
    })

    // Record some successes
    pool.recordSuccess('test-1', 100, 0, 500)
    pool.recordSuccess('test-1', 200, 0, 600)

    const health = pool.getAccountHealth('test-1')
    expect(health).toBeDefined()
    expect(health.successRate).toBeGreaterThan(0)
    expect(health.avgLatency).toBeGreaterThan(0)
    expect(health.overallScore).toBeGreaterThanOrEqual(0)
    expect(health.overallScore).toBeLessThanOrEqual(1)
    expect(typeof health.isHealthy).toBe('boolean')
    expect(typeof health.quotaUsagePercent).toBe('number')
  })

  it('calculates overall score correctly', () => {
    const pool = new AccountPool()
    pool.addAccount({
      id: 'healthy-1',
      email: 'healthy@test.com',
      token: 'tok',
      isAvailable: true
    })

    // All successes = high score
    for (let i = 0; i < 10; i++) {
      pool.recordSuccess('healthy-1', 50, 0, 300)
    }

    const health = pool.getAccountHealth('healthy-1')
    expect(health.overallScore).toBeGreaterThan(0.7)
    expect(health.isHealthy).toBe(true)
  })

  it('penalizes accounts with errors', () => {
    const pool = new AccountPool()
    pool.addAccount({
      id: 'unhealthy-1',
      email: 'unhealthy@test.com',
      token: 'tok',
      isAvailable: true
    })

    // All errors = low score
    for (let i = 0; i < 10; i++) {
      pool.recordError('unhealthy-1', 'test error', 429)
    }

    const health = pool.getAccountHealth('unhealthy-1')
    expect(health.overallScore).toBeLessThan(0.5)
    expect(health.successRate).toBe(0)
  })
})

describe('Phase 9: Quota Predictions', () => {
  it('returns quota predictions for accounts with limits', () => {
    const pool = new AccountPool()
    pool.addAccount({
      id: 'quota-1',
      email: 'quota@test.com',
      token: 'tok',
      isAvailable: true,
      quotaLimit: 1000,
      quotaUsed: 800
    })

    const predictions = pool.getQuotaPredictions()
    expect(predictions.length).toBe(1)
    expect(predictions[0].accountId).toBe('quota-1')
    expect(predictions[0].usagePercent).toBe(80)
    expect(predictions[0].isLow).toBe(true)
  })

  it('skips accounts without quota limits', () => {
    const pool = new AccountPool()
    pool.addAccount({
      id: 'no-limit',
      email: 'nolimit@test.com',
      token: 'tok',
      isAvailable: true
    })

    const predictions = pool.getQuotaPredictions()
    expect(predictions.length).toBe(0)
  })

  it('marks accounts below 80% as not low', () => {
    const pool = new AccountPool()
    pool.addAccount({
      id: 'ok-quota',
      email: 'ok@test.com',
      token: 'tok',
      isAvailable: true,
      quotaLimit: 1000,
      quotaUsed: 500
    })

    const predictions = pool.getQuotaPredictions()
    expect(predictions[0].usagePercent).toBe(50)
    expect(predictions[0].isLow).toBe(false)
  })
})
