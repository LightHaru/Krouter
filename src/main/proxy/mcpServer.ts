// Krouter MCP Server — exposes pool management and auto-healing tools
// Protocol: MCP (Model Context Protocol) over stdio or HTTP SSE
import * as http from 'http'
import type { AccountPool } from './accountPool'
import type { ProxyConfig } from './types'

export interface McpTool {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface McpToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

export interface McpServerDeps {
  accountPool: AccountPool
  getConfig: () => ProxyConfig
  getStats: () => {
    totalRequests: number
    successRequests: number
    failedRequests: number
    totalTokens: number
    inputTokens: number
    outputTokens: number
    startTime: number
    accountStats: Map<string, unknown>
  }
  refreshAccount?: (accountId: string) => Promise<boolean>
  registerAccount?: (opts: {
    emailProvider?: string
    proxy?: string
  }) => Promise<{ success: boolean; message: string }>
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'krouter_pool_status',
    description:
      'Get account pool health summary: total accounts, active, suspended, cooling down, exhausted, and per-tier breakdown',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'krouter_account_health',
    description: 'Get detailed health info for a specific account by ID or email',
    inputSchema: {
      type: 'object',
      properties: {
        account: {
          type: 'string',
          description: 'Account ID or email address'
        }
      },
      required: ['account']
    }
  },
  {
    name: 'krouter_force_refresh',
    description: 'Force token refresh for one or all accounts. Use when detecting auth failures',
    inputSchema: {
      type: 'object',
      properties: {
        account_id: {
          type: 'string',
          description: 'Specific account ID to refresh (omit to refresh all)'
        }
      }
    }
  },
  {
    name: 'krouter_usage_stats',
    description:
      'Get usage statistics: total requests, tokens consumed, error rates, uptime, and per-account breakdown',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['current', 'summary'],
          description: 'Period to query (default: current session)'
        }
      }
    }
  },
  {
    name: 'krouter_register',
    description: 'Trigger automated registration of a new Kiro account to expand the pool',
    inputSchema: {
      type: 'object',
      properties: {
        email_provider: {
          type: 'string',
          enum: ['moemail', 'tempmail', 'tingamefi', 'proton', 'outlook'],
          description: 'Email provider to use for registration'
        },
        proxy: {
          type: 'string',
          description: 'Proxy URL for registration (socks5://... or http://...)'
        }
      }
    }
  }
]

export class McpServer {
  private deps: McpServerDeps
  private httpServer: http.Server | null = null

  constructor(deps: McpServerDeps) {
    this.deps = deps
  }

  getTools(): McpTool[] {
    return MCP_TOOLS
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    switch (name) {
      case 'krouter_pool_status':
        return this.handlePoolStatus()
      case 'krouter_account_health':
        return this.handleAccountHealth(args.account as string)
      case 'krouter_force_refresh':
        return await this.handleForceRefresh(args.account_id as string | undefined)
      case 'krouter_usage_stats':
        return this.handleUsageStats(args.period as string | undefined)
      case 'krouter_register':
        return await this.handleRegister(
          args.email_provider as string | undefined,
          args.proxy as string | undefined
        )
      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
    }
  }

  private handlePoolStatus(): McpToolResult {
    const accounts = this.deps.accountPool.getAllAccounts()
    const now = Date.now()

    let active = 0,
      suspended = 0,
      cooling = 0,
      exhausted = 0,
      expired = 0

    const tierBreakdown: Record<string, { total: number; active: number }> = {}

    for (const acc of accounts) {
      const tier = acc.subscriptionType || 'unknown'
      if (!tierBreakdown[tier]) tierBreakdown[tier] = { total: 0, active: 0 }
      tierBreakdown[tier].total++

      if (acc.suspendedAt && acc.suspendedAt > 0) {
        suspended++
      } else if (
        acc.quotaExhaustedAt &&
        acc.quotaExhaustedAt > 0 &&
        (!acc.quotaResetAt || acc.quotaResetAt > now)
      ) {
        exhausted++
      } else if (acc.cooldownUntil && acc.cooldownUntil > now) {
        cooling++
      } else if (acc.expiresAt && acc.expiresAt < now && !acc.refreshToken) {
        expired++
      } else if (acc.isAvailable !== false) {
        active++
        tierBreakdown[tier].active++
      }
    }

    const strategy = this.deps.accountPool.getStrategy()

    const result = {
      total: accounts.length,
      active,
      suspended,
      cooling_down: cooling,
      exhausted,
      expired,
      strategy,
      tier_breakdown: tierBreakdown,
      health_score: accounts.length > 0 ? Math.round((active / accounts.length) * 100) : 0
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  private handleAccountHealth(accountQuery: string): McpToolResult {
    const accounts = this.deps.accountPool.getAllAccounts()
    const account = accounts.find((a) => a.id === accountQuery || a.email === accountQuery)

    if (!account) {
      return {
        content: [{ type: 'text', text: `Account not found: ${accountQuery}` }],
        isError: true
      }
    }

    const now = Date.now()
    const health = this.deps.accountPool.getAccountHealth(account.id)

    const result = {
      id: account.id,
      email: account.email,
      tier: account.subscriptionType || 'unknown',
      is_available: account.isAvailable !== false,
      is_suspended: !!(account.suspendedAt && account.suspendedAt > 0),
      suspend_reason: account.suspendReason,
      is_quota_exhausted: !!(account.quotaExhaustedAt && account.quotaExhaustedAt > 0),
      quota_reset_at: account.quotaResetAt ? new Date(account.quotaResetAt).toISOString() : null,
      is_cooling: !!(account.cooldownUntil && account.cooldownUntil > now),
      cooldown_remaining_ms: account.cooldownUntil ? Math.max(0, account.cooldownUntil - now) : 0,
      token_expires_at: account.expiresAt ? new Date(account.expiresAt).toISOString() : null,
      token_expired: !!(account.expiresAt && account.expiresAt < now),
      has_refresh_token: !!account.refreshToken,
      error_count: account.errorCount || 0,
      request_count: account.requestCount || 0,
      last_used: account.lastUsed ? new Date(account.lastUsed).toISOString() : null,
      health
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  private async handleForceRefresh(accountId?: string): Promise<McpToolResult> {
    if (!this.deps.refreshAccount) {
      return {
        content: [
          { type: 'text', text: 'Token refresh not available (no refresh callback configured)' }
        ],
        isError: true
      }
    }

    if (accountId) {
      const success = await this.deps.refreshAccount(accountId)
      return {
        content: [
          { type: 'text', text: JSON.stringify({ account_id: accountId, refreshed: success }) }
        ],
        isError: !success
      }
    }

    const accounts = this.deps.accountPool.getAllAccounts()
    const results: { id: string; email?: string; refreshed: boolean }[] = []

    for (const acc of accounts) {
      if (acc.refreshToken && acc.isAvailable !== false) {
        const success = await this.deps.refreshAccount(acc.id)
        results.push({ id: acc.id, email: acc.email, refreshed: success })
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ total: results.length, results }, null, 2) }]
    }
  }

  private handleUsageStats(_period?: string): McpToolResult {
    const stats = this.deps.getStats()
    const accounts = this.deps.accountPool.getAllAccounts()

    const result = {
      uptime_ms: Date.now() - stats.startTime,
      uptime_human: this.formatDuration(Date.now() - stats.startTime),
      requests: {
        total: stats.totalRequests,
        success: stats.successRequests,
        failed: stats.failedRequests,
        success_rate:
          stats.totalRequests > 0
            ? Math.round((stats.successRequests / stats.totalRequests) * 1000) / 10
            : 100
      },
      tokens: {
        total: stats.totalTokens,
        input: stats.inputTokens,
        output: stats.outputTokens
      },
      pool: {
        total_accounts: accounts.length,
        active_accounts: accounts.filter((a) => a.isAvailable !== false && !a.suspendedAt).length
      }
    }

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }

  private async handleRegister(emailProvider?: string, proxy?: string): Promise<McpToolResult> {
    if (!this.deps.registerAccount) {
      return {
        content: [
          { type: 'text', text: 'Registration not available (no registration callback configured)' }
        ],
        isError: true
      }
    }

    const result = await this.deps.registerAccount({ emailProvider, proxy })
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: !result.success
    }
  }

  private formatDuration(ms: number): string {
    const hours = Math.floor(ms / 3600000)
    const minutes = Math.floor((ms % 3600000) / 60000)
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  // --- MCP Protocol Handlers ---

  // Handle MCP JSON-RPC over HTTP (SSE transport)
  startHttpTransport(port: number, host: string = '127.0.0.1'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        // handleMcpHttpRequest là async: bỏ promise trần ở đây thì mọi lỗi lọt ra khỏi
        // try/catch bên trong nó sẽ thành unhandledRejection và không ai đóng response,
        // client treo cho tới khi tự timeout.
        void this.handleMcpHttpRequest(req, res).catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error('[MCP] Lỗi không bắt được khi xử lý request:', message)
          try {
            if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
            if (!res.writableEnded) {
              res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message } }))
            }
          } catch {
            /* response đã hỏng, không còn gì để làm */
          }
        })
      })

      this.httpServer.on('error', reject)
      this.httpServer.listen(port, host, () => {
        console.log(`[MCP] Server listening on http://${host}:${port}`)
        resolve()
      })
    })
  }

  stopHttpTransport(): void {
    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = null
    }
  }

  // Handle MCP over stdio (for `openclaw mcp add --transport stdio`)
  startStdioTransport(): void {
    let buffer = ''

    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.trim()) {
          // Thiếu nhánh reject thì một message hỏng làm chết im lặng cả stdio transport:
          // client MCP ngồi chờ phản hồi mãi mãi mà không có lỗi nào được in ra.
          void this.handleJsonRpcMessage(line.trim()).then(
            (response) => {
              if (response) {
                process.stdout.write(JSON.stringify(response) + '\n')
              }
            },
            (error) => {
              console.error('[MCP] Xử lý message thất bại:', error instanceof Error ? error.message : error)
            }
          )
        }
      }
    })

    process.stdin.on('end', () => {})
  }

  // Handle HTTP endpoint for MCP (integrated into proxy server)
  async handleMcpHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // proxyServer chỉ route vào đây khi path bắt đầu bằng "/mcp/" (hoặc bằng "/mcp") và KHÔNG
    // cắt tiền tố, nên req.url luôn là "/mcp/..." → so sánh với "/sse" trần luôn trượt và trả
    // 404 cho mọi request: toàn bộ tích hợp MCP chết trên HTTP. Bỏ query string, cắt tiền tố
    // /mcp, đồng thời vẫn nhận path trần để mount độc lập của startHttpTransport() chạy được.
    const rawPath = (req.url || '/').split('?')[0]
    const mcpPrefix = /^\/mcp(?=\/|$)/.test(rawPath) ? '/mcp' : ''
    const path = rawPath.replace(/^\/mcp(?=\/|$)/, '') || '/'
    const method = req.method || 'GET'

    // Handler này không có lớp xác thực riêng: khi mount qua proxy server thì được API-key của
    // server đó bảo vệ, nhưng mount độc lập thì không. Vì vậy chỉ phát CORS wildcard cho
    // request đến từ loopback; nguồn khác thì bỏ hẳn header CORS để trình duyệt không cho
    // trang web bất kỳ đọc danh sách account qua các tool quản lý pool.
    if (this.isLoopbackRequest(req)) {
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    }

    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (path === '/sse' && method === 'GET') {
      this.handleSseConnection(res, mcpPrefix)
      return
    }

    if (path === '/message' && method === 'POST') {
      const body = await this.readRequestBody(req)
      const response = await this.handleJsonRpcMessage(body)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(response))
      return
    }

    res.writeHead(404)
    res.end('Not Found')
  }

  // Chỉ coi là loopback khi kết nối đến từ chính máy này (IPv4 127.x, IPv6 ::1 và ::ffff:127.x)
  private isLoopbackRequest(req: http.IncomingMessage): boolean {
    const addr = req.socket?.remoteAddress
    if (!addr) return false
    const normalized = addr.replace(/^::ffff:/, '')
    return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.')
  }

  private handleSseConnection(res: http.ServerResponse, pathPrefix: string = ''): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })

    // Endpoint phải kèm tiền tố mount, nếu không client sẽ POST vào /message và trượt route
    const endpointEvent = `data: ${JSON.stringify({ endpoint: `${pathPrefix}/message` })}\n\n`
    res.write(`event: endpoint\n${endpointEvent}`)

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keepalive\n\n')
      }
    }, 30000)

    res.on('close', () => {
      clearInterval(keepAlive)
    })
  }

  private async handleJsonRpcMessage(message: string): Promise<unknown> {
    let parsed: { jsonrpc: string; id?: number | string; method: string; params?: unknown }
    try {
      parsed = JSON.parse(message)
    } catch {
      return { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }
    }

    const { id, method, params } = parsed

    switch (method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'krouter', version: '2.0.0' }
          }
        }

      case 'notifications/initialized':
        return undefined

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: MCP_TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema
            }))
          }
        }

      case 'tools/call': {
        const toolParams = params as { name: string; arguments?: Record<string, unknown> }
        const toolResult = await this.callTool(toolParams.name, toolParams.arguments || {})
        return {
          jsonrpc: '2.0',
          id,
          result: toolResult
        }
      }

      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` }
        }
    }
  }

  private readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString()
      })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }
}
