import { describe, expect, it } from 'vitest'
import { ProxyServer } from '../../src/main/proxy/proxyServer'
import type { ProxyAccount } from '../../src/main/proxy/types'

function createAccount(id = 'acct-usage-1'): ProxyAccount {
  return {
    id,
    email: `${id}@test.local`,
    accessToken: 'test-token',
    profileArn: 'arn:aws:codewhisperer:us-east-1:test:profile/test'
  }
}

describe('ProxyServer usage stats', () => {
  it('records cache, reasoning, credits, response event, and recent log from one success path', () => {
    const usageSnapshots: unknown[] = []
    const tokenSnapshots: Array<[number, number]> = []
    const responses: unknown[] = []
    const credits: number[] = []
    const ps = new ProxyServer({}, {
      onUsageStatsUpdate: (usage) => usageSnapshots.push(usage),
      onTokensUpdate: (inputTokens, outputTokens) => tokenSnapshots.push([inputTokens, outputTokens]),
      onResponse: (info) => responses.push(info),
      onCreditsUpdate: (totalCredits) => credits.push(totalCredits)
    }) as any
    const account = createAccount()
    ps.accountPool.addAccount(account)

    ps.recordSuccessfulUsage({
      path: '/v1/messages',
      model: 'claude-opus-4.8',
      account,
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        credits: 1.25,
        reasoningTokens: 33
      },
      simulatedCacheUsage: {
        cacheCreationInputTokens: 40,
        cacheReadInputTokens: 12
      },
      startTime: Date.now() - 250
    })

    const stats = ps.getStats()
    expect(stats.successRequests).toBe(1)
    expect(stats.totalTokens).toBe(165)
    expect(stats.inputTokens).toBe(120)
    expect(stats.outputTokens).toBe(45)
    expect(stats.cacheReadTokens).toBe(12)
    expect(stats.cacheWriteTokens).toBe(40)
    expect(stats.reasoningTokens).toBe(33)
    expect(stats.totalCredits).toBe(1.25)

    expect(credits).toEqual([1.25])
    expect(tokenSnapshots).toEqual([[120, 45]])
    expect(usageSnapshots.at(-1)).toMatchObject({
      totalTokens: 165,
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 12,
      cacheWriteTokens: 40,
      reasoningTokens: 33
    })
    expect(responses.at(-1)).toMatchObject({
      path: '/v1/messages',
      model: 'claude-opus-4.8',
      cacheReadTokens: 12,
      cacheWriteTokens: 40,
      reasoningTokens: 33,
      credits: 1.25
    })
    expect(stats.recentRequests.at(-1)).toMatchObject({
      path: '/v1/messages',
      model: 'claude-opus-4.8',
      accountId: account.id,
      inputTokens: 120,
      outputTokens: 45,
      cacheReadTokens: 12,
      cacheWriteTokens: 40,
      reasoningTokens: 33,
      credits: 1.25,
      success: true
    })
  })

  it('resets all token counters including cache and reasoning', () => {
    const usageSnapshots: unknown[] = []
    const ps = new ProxyServer({}, {
      onUsageStatsUpdate: (usage) => usageSnapshots.push(usage)
    }) as any
    ps.setTotalTokens(10, 20, 3, 4, 5)

    ps.resetTotalTokens()

    const stats = ps.getStats()
    expect(stats.totalTokens).toBe(0)
    expect(stats.inputTokens).toBe(0)
    expect(stats.outputTokens).toBe(0)
    expect(stats.cacheReadTokens).toBe(0)
    expect(stats.cacheWriteTokens).toBe(0)
    expect(stats.reasoningTokens).toBe(0)
    expect(usageSnapshots.at(-1)).toMatchObject({
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0
    })
  })
})
