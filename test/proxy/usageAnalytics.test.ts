import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { UsageAnalyticsStore } from '../../src/main/proxy/usageAnalytics'

const tempDirs: string[] = []

async function createStore(scope = 'test'): Promise<{ store: UsageAnalyticsStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'krouter-usage-'))
  tempDirs.push(dir)
  return { store: new UsageAnalyticsStore(scope, dir), dir }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe('UsageAnalyticsStore', () => {
  it('persists safe per-request usage and aggregates provider, model, account and endpoint totals', async () => {
    const { store, dir } = await createStore()

    await store.append({
      path: '/v1/chat/completions',
      model: 'chatgpt/gpt-5.6-sol',
      status: 200,
      inputTokens: 120,
      outputTokens: 30,
      reasoningTokens: 12,
      responseTime: 900,
      accountId: 'chatgpt-account-1',
      accountEmail: 'owner@example.com'
    })
    await store.append({
      path: '/v1/messages',
      model: 'claude-sonnet-4.5',
      status: 200,
      inputTokens: 80,
      outputTokens: 20,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      credits: 1.5,
      responseTime: 300,
      accountId: 'kiro-account-1',
      accountEmail: 'kiro@example.com'
    })
    await store.append({
      path: '/v1/responses',
      model: 'chatgpt/gpt-5.6-sol',
      status: 429,
      responseTime: 50,
      error: 'Bearer private-access-token failed for sk-secretvalue'
    })

    const snapshot = await store.getSnapshot('today')
    expect(snapshot.totals).toMatchObject({
      requests: 3,
      successfulRequests: 2,
      failedRequests: 1,
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 40,
      cacheWriteTokens: 10,
      reasoningTokens: 12,
      totalTokens: 250,
      credits: 1.5
    })
    expect(snapshot.byProvider.map((item) => item.provider)).toEqual(expect.arrayContaining(['chatgpt', 'kiro']))
    expect(snapshot.byModel.find((item) => item.model === 'chatgpt/gpt-5.6-sol')?.requests).toBe(2)
    expect(snapshot.byAccount.find((item) => item.accountId === 'chatgpt-account-1')?.label).toBe('owner@example.com')
    expect(snapshot.byEndpoint.find((item) => item.path === '/v1/messages')?.cacheReadTokens).toBe(40)
    expect(snapshot.recentRequests[0].error).toContain('Bearer [redacted]')
    expect(snapshot.recentRequests[0].error).not.toContain('private-access-token')
    expect(snapshot.recentRequests[0].error).not.toContain('secretvalue')

    const restored = new UsageAnalyticsStore('test', dir)
    expect((await restored.getSnapshot('all')).totals.requests).toBe(3)
  })

  it('keeps private experimental models unpriced and clears only the usage ledger', async () => {
    const { store } = await createStore()
    await store.append({
      path: '/v1/chat/completions',
      model: 'chatgpt/gpt-5.6-sol',
      status: 200,
      inputTokens: 10,
      outputTokens: 5
    })

    const before = await store.getSnapshot('24h')
    expect(before.totals.estimatedCostUsd).toBe(0)
    expect(before.totals.pricedRequests).toBe(0)
    expect(before.series).toHaveLength(24)

    await store.clear()
    expect((await store.getSnapshot('all')).totals.requests).toBe(0)
  })

  it('classifies an unprefixed image model by its selected ChatGPT account', async () => {
    const { store } = await createStore()
    await store.append({
      path: '/v1/images/generations',
      model: 'gpt-image-2',
      status: 200,
      responseTime: 1_200,
      accountId: '32cb4d27-714d-49a6-b982-281ed8a5a382',
      accountEmail: 'safe-label@example.com'
    })

    const snapshot = await store.getSnapshot('today')
    expect(snapshot.byProvider[0]).toMatchObject({ provider: 'chatgpt', requests: 1 })
    expect(snapshot.recentRequests[0]).toMatchObject({
      path: '/v1/images/generations',
      endpoint: '/v1/images/generations',
      provider: 'chatgpt'
    })
  })
})
