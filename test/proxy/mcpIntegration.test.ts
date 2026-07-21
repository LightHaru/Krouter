// Phase 14 tests: MCP Server protocol integration (simulates OpenClaw MCP client)
import { describe, it, expect, beforeEach } from 'vitest'
import { McpServer } from '../../src/main/proxy/mcpServer'
import { AccountPool } from '../../src/main/proxy/accountPool'
import type { ProxyAccount } from '../../src/main/proxy/types'

function createAccount(id: string, opts: Partial<ProxyAccount> = {}): ProxyAccount {
  return {
    id,
    email: `${id}@kiro.aws`,
    isAvailable: true,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    subscriptionType: 'pro',
    ...opts
  } as ProxyAccount
}

describe('Phase 14: MCP Integration — OpenClaw Agent Scenarios', () => {
  let pool: AccountPool
  let mcp: McpServer

  beforeEach(() => {
    pool = new AccountPool()
    pool.addAccount(createAccount('a1', { subscriptionType: 'pro' }))
    pool.addAccount(createAccount('a2', { subscriptionType: 'enterprise' }))
    pool.addAccount(createAccount('a3', { subscriptionType: 'free' }))

    mcp = new McpServer({
      accountPool: pool,
      getConfig: () => ({} as any),
      getStats: () => ({
        totalRequests: 500,
        successRequests: 480,
        failedRequests: 20,
        totalTokens: 2000000,
        inputTokens: 1200000,
        outputTokens: 800000,
        startTime: Date.now() - 7200000,
        accountStats: new Map()
      }),
      refreshAccount: async (id) => {
        const acc = pool.getAccount(id)
        return !!acc
      }
    })
  })

  it('Scenario: Agent checks health before heavy task', async () => {
    const status = await mcp.callTool('krouter_pool_status', {})
    const data = JSON.parse(status.content[0].text)

    expect(data.total).toBe(3)
    expect(data.active).toBe(3)
    expect(data.health_score).toBe(100)
    expect(data.tier_breakdown.pro.total).toBe(1)
    expect(data.tier_breakdown.enterprise.total).toBe(1)
    expect(data.tier_breakdown.free.total).toBe(1)
  })

  it('Scenario: Agent detects degraded pool and refreshes', async () => {
    // Simulate 2 accounts down
    pool.updateAccount('a1', { isAvailable: false })
    pool.markSuspended('a3', 'TEMPORARILY_SUSPENDED')

    const status = await mcp.callTool('krouter_pool_status', {})
    const data = JSON.parse(status.content[0].text)
    expect(data.health_score).toBeLessThan(50)
    expect(data.suspended).toBe(1)

    // Agent refreshes the unavailable account
    const refresh = await mcp.callTool('krouter_force_refresh', { account_id: 'a1' })
    const refreshData = JSON.parse(refresh.content[0].text)
    expect(refreshData.refreshed).toBe(true)
  })

  it('Scenario: Agent checks specific account after errors', async () => {
    pool.updateAccount('a2', { errorCount: 5, lastErrorStatus: 429 })

    const health = await mcp.callTool('krouter_account_health', { account: 'a2@kiro.aws' })
    const data = JSON.parse(health.content[0].text)

    expect(data.tier).toBe('enterprise')
    expect(data.error_count).toBe(5)
  })

  it('Scenario: Agent gets usage report', async () => {
    const usage = await mcp.callTool('krouter_usage_stats', { period: 'current' })
    const data = JSON.parse(usage.content[0].text)

    expect(data.requests.success_rate).toBe(96)
    expect(data.tokens.total).toBe(2000000)
    expect(data.uptime_human).toMatch(/2h/)
  })

  it('Scenario: All tools return structured text content', async () => {
    const tools = mcp.getTools()
    for (const tool of tools) {
      const result = await mcp.callTool(tool.name, {})
      expect(result.content).toHaveLength(1)
      expect(result.content[0].type).toBe('text')
      expect(result.content[0].text.length).toBeGreaterThan(0)
      // Non-error results should be valid JSON
      if (!result.isError) {
        expect(() => JSON.parse(result.content[0].text)).not.toThrow()
      }
    }
  })

  it('Scenario: Pool with exhausted accounts shows correct breakdown', async () => {
    pool.updateAccount('a1', { quotaExhaustedAt: Date.now(), quotaResetAt: Date.now() + 3600000 })
    pool.updateAccount('a2', { cooldownUntil: Date.now() + 60000 })

    const status = await mcp.callTool('krouter_pool_status', {})
    const data = JSON.parse(status.content[0].text)

    expect(data.active).toBe(1) // only a3
    expect(data.exhausted).toBe(1) // a1
    expect(data.cooling_down).toBe(1) // a2
    expect(data.health_score).toBe(33) // 1/3
  })
})
