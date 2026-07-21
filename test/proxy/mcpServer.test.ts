// Phase 14 tests: MCP Server
import { describe, it, expect, beforeEach } from 'vitest'
import { McpServer } from '../../src/main/proxy/mcpServer'
import { AccountPool } from '../../src/main/proxy/accountPool'
import type { ProxyAccount } from '../../src/main/proxy/types'

function createMockAccount(overrides: Partial<ProxyAccount> = {}): ProxyAccount {
  return {
    id: `acc-${Math.random().toString(36).slice(2, 8)}`,
    email: `test-${Math.random().toString(36).slice(2, 6)}@example.com`,
    isAvailable: true,
    requestCount: 0,
    errorCount: 0,
    lastUsed: 0,
    subscriptionType: 'pro',
    ...overrides
  } as ProxyAccount
}

describe('Phase 14: MCP Server', () => {
  let mcpServer: McpServer
  let accountPool: AccountPool

  beforeEach(() => {
    accountPool = new AccountPool()
    mcpServer = new McpServer({
      accountPool,
      getConfig: () => ({} as any),
      getStats: () => ({
        totalRequests: 150,
        successRequests: 140,
        failedRequests: 10,
        totalTokens: 500000,
        inputTokens: 300000,
        outputTokens: 200000,
        startTime: Date.now() - 3600000,
        accountStats: new Map()
      })
    })
  })

  describe('getTools', () => {
    it('returns all MCP tools', () => {
      const tools = mcpServer.getTools()
      expect(tools.length).toBe(5)
      expect(tools.map(t => t.name)).toEqual([
        'krouter_pool_status',
        'krouter_account_health',
        'krouter_force_refresh',
        'krouter_usage_stats',
        'krouter_register'
      ])
    })

    it('tools have valid input schemas', () => {
      const tools = mcpServer.getTools()
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe('object')
        expect(tool.description).toBeTruthy()
      }
    })
  })

  describe('krouter_pool_status', () => {
    it('returns empty pool status', async () => {
      const result = await mcpServer.callTool('krouter_pool_status', {})
      const data = JSON.parse(result.content[0].text)

      expect(data.total).toBe(0)
      expect(data.active).toBe(0)
      expect(data.health_score).toBe(0)
      expect(result.isError).toBeUndefined()
    })

    it('returns status with mixed accounts', async () => {
      accountPool.addAccount(createMockAccount({ subscriptionType: 'pro' }))
      accountPool.addAccount(createMockAccount({ subscriptionType: 'pro' }))
      accountPool.addAccount(createMockAccount({
        subscriptionType: 'free',
        suspendedAt: Date.now(),
        suspendReason: 'TEMPORARILY_SUSPENDED'
      }))
      accountPool.addAccount(createMockAccount({
        subscriptionType: 'enterprise',
        quotaExhaustedAt: Date.now(),
        quotaResetAt: Date.now() + 3600000
      }))

      const result = await mcpServer.callTool('krouter_pool_status', {})
      const data = JSON.parse(result.content[0].text)

      expect(data.total).toBe(4)
      expect(data.active).toBe(2)
      expect(data.suspended).toBe(1)
      expect(data.exhausted).toBe(1)
      expect(data.strategy).toBe('round-robin')
      expect(data.tier_breakdown.pro.total).toBe(2)
      expect(data.tier_breakdown.pro.active).toBe(2)
      expect(data.health_score).toBe(50)
    })
  })

  describe('krouter_account_health', () => {
    it('returns error for unknown account', async () => {
      const result = await mcpServer.callTool('krouter_account_health', { account: 'nonexistent' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('not found')
    })

    it('returns health for existing account by email', async () => {
      const acc = createMockAccount({ email: 'test@kiro.dev', subscriptionType: 'enterprise' })
      accountPool.addAccount(acc)

      const result = await mcpServer.callTool('krouter_account_health', { account: 'test@kiro.dev' })
      const data = JSON.parse(result.content[0].text)

      expect(data.email).toBe('test@kiro.dev')
      expect(data.tier).toBe('enterprise')
      expect(data.is_available).toBe(true)
      expect(data.is_suspended).toBe(false)
      expect(data.error_count).toBe(0)
    })

    it('returns health for suspended account', async () => {
      const acc = createMockAccount({
        suspendedAt: Date.now(),
        suspendReason: 'AccountSuspendedException'
      })
      accountPool.addAccount(acc)

      const result = await mcpServer.callTool('krouter_account_health', { account: acc.id })
      const data = JSON.parse(result.content[0].text)

      expect(data.is_suspended).toBe(true)
      expect(data.suspend_reason).toBe('AccountSuspendedException')
    })
  })

  describe('krouter_force_refresh', () => {
    it('returns error when no refresh callback', async () => {
      const result = await mcpServer.callTool('krouter_force_refresh', {})
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('not available')
    })

    it('refreshes specific account', async () => {
      const refreshed: string[] = []
      const server = new McpServer({
        accountPool,
        getConfig: () => ({} as any),
        getStats: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, startTime: Date.now(), accountStats: new Map() }),
        refreshAccount: async (id) => { refreshed.push(id); return true }
      })

      const acc = createMockAccount()
      accountPool.addAccount(acc)

      const result = await server.callTool('krouter_force_refresh', { account_id: acc.id })
      const data = JSON.parse(result.content[0].text)

      expect(data.refreshed).toBe(true)
      expect(refreshed).toContain(acc.id)
    })
  })

  describe('krouter_usage_stats', () => {
    it('returns usage statistics', async () => {
      accountPool.addAccount(createMockAccount())
      accountPool.addAccount(createMockAccount())

      const result = await mcpServer.callTool('krouter_usage_stats', {})
      const data = JSON.parse(result.content[0].text)

      expect(data.requests.total).toBe(150)
      expect(data.requests.success).toBe(140)
      expect(data.requests.failed).toBe(10)
      expect(data.requests.success_rate).toBeCloseTo(93.3, 0)
      expect(data.tokens.total).toBe(500000)
      expect(data.tokens.input).toBe(300000)
      expect(data.tokens.output).toBe(200000)
      expect(data.pool.total_accounts).toBe(2)
      expect(data.pool.active_accounts).toBe(2)
      expect(data.uptime_human).toMatch(/1h|60m/)
    })
  })

  describe('krouter_register', () => {
    it('returns error when no register callback', async () => {
      const result = await mcpServer.callTool('krouter_register', { email_provider: 'moemail' })
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('not available')
    })

    it('calls register with provided params', async () => {
      let capturedOpts: any = null
      const server = new McpServer({
        accountPool,
        getConfig: () => ({} as any),
        getStats: () => ({ totalRequests: 0, successRequests: 0, failedRequests: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0, startTime: Date.now(), accountStats: new Map() }),
        registerAccount: async (opts) => { capturedOpts = opts; return { success: true, message: 'Account registered' } }
      })

      const result = await server.callTool('krouter_register', { email_provider: 'tempmail', proxy: 'socks5://1.2.3.4:1080' })
      const data = JSON.parse(result.content[0].text)

      expect(data.success).toBe(true)
      expect(capturedOpts.emailProvider).toBe('tempmail')
      expect(capturedOpts.proxy).toBe('socks5://1.2.3.4:1080')
    })
  })

  describe('MCP JSON-RPC protocol', () => {
    it('handles unknown tool gracefully', async () => {
      const result = await mcpServer.callTool('nonexistent_tool', {})
      expect(result.isError).toBe(true)
      expect(result.content[0].text).toContain('Unknown tool')
    })
  })
})
