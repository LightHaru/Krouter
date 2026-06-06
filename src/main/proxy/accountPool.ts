// 多账号智能轮询管理器
// 参考 Kiro Gateway 的 Circuit Breaker + Sticky + 指数退避 + 概率重试机制
import type { ProxyAccount, AccountStats } from './types'

// 错误类型分类（决定 failover 策略）
export enum ErrorType {
  FATAL = 'fatal',           // 请求本身有问题 → 直接返回客户端，不切号
  RECOVERABLE = 'recoverable' // 账号问题 → 切换到下一个账号
}

// 根据 HTTP 状态码和错误原因分类错误
export function classifyError(statusCode: number, reason?: string): ErrorType {
  if (reason && (isThrottleError(reason) || isBillingOrQuotaError(reason))) return ErrorType.RECOVERABLE
  // RECOVERABLE: 配额/计费问题
  if (statusCode === 402) return ErrorType.RECOVERABLE
  // RECOVERABLE: Token 过期/无效
  if (statusCode === 403) return ErrorType.RECOVERABLE
  // RECOVERABLE: 限流
  if (statusCode === 429) return ErrorType.RECOVERABLE
  // 400: 根据原因细分
  if (statusCode === 400) {
    // 上下文超限 → 所有账号都会失败
    if (reason === 'CONTENT_LENGTH_EXCEEDS_THRESHOLD') return ErrorType.FATAL
    return ErrorType.FATAL
  }
  // 422: 请求格式错误
  if (statusCode === 422) return ErrorType.FATAL
  // 5xx: 服务端错误
  if (statusCode >= 500) return ErrorType.FATAL
  return ErrorType.FATAL
}

/** Account-specific billing/quota failures that should immediately fail over. */
export function isBillingOrQuotaError(message: string): boolean {
  if (isEndpointRateLimitError(message)) return false
  return /\b402\b|payment required|billing (?:error|issue|problem)|out of credits?|run out of credits?|insufficient (?:credits?|balance)|credit balance|no (?:remaining )?credits?|credits? (?:exhausted|depleted)|quota (?:exhausted|exceeded|reached)|servicequotaexceededexception|service quota exceeded|reached (?:the|your) (?:usage )?limit|usage limit (?:reached|exceeded)|monthly limit (?:reached|exceeded)/i.test(message)
}

/** Temporary account/endpoint throttling that should use a short cooldown. */
export function isThrottleError(message: string): boolean {
  return isEndpointRateLimitError(message) || /\b429\b|throttl|too many requests|rate[ _-]?limit/i.test(message)
}

function isEndpointRateLimitError(message: string): boolean {
  return /quota exhausted on (?:amazonq|codewhisperer|amazonqcli)|endpoint .*rate[ _-]?limited/i.test(message)
}

export interface AccountPoolConfig {
  baseCooldownMs: number      // 基础冷却时间（指数退避的基数）
  maxBackoffMultiplier: number // 最大退避倍数
  quotaResetMs: number        // 配额耗尽冷却时间
  probabilisticRetryChance: number // 概率重试几率（0-1）
}

const DEFAULT_CONFIG: AccountPoolConfig = {
  baseCooldownMs: 60000,        // 60s 基础冷却
  maxBackoffMultiplier: 1440,   // 最大 1440 倍 = 24h
  quotaResetMs: 3600000,        // 1h 配额重置
  probabilisticRetryChance: 0.1 // 10% 概率重试
}

export type AccountSelectionStrategy = 'smart' | 'round-robin' | 'sticky' | 'least-used'

export class AccountPool {
  private accounts: Map<string, ProxyAccount> = new Map()
  private accountStats: Map<string, AccountStats> = new Map()
  private currentIndex: number = 0
  private config: AccountPoolConfig
  // 默认 round-robin: 选中账号时立即前进，避免并发请求集中到同一账号
  // sticky: 一个账号成功就粘住 (保留 prompt cache 命中)
  private strategy: AccountSelectionStrategy = 'smart'

  constructor(config: Partial<AccountPoolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  // 切换账号选择策略
  setStrategy(strategy: AccountSelectionStrategy): void {
    if (this.strategy !== strategy) {
      console.log(`[AccountPool] Strategy changed: ${this.strategy} → ${strategy}`)
      this.strategy = strategy
    }
  }

  getStrategy(): AccountSelectionStrategy {
    return this.strategy
  }

  // 添加账号
  // 如果传入的 account 已带 suspended 字段（启动复原场景），保留其 suspended 状态
  addAccount(account: ProxyAccount): void {
    const suspended = this.isSuspended(account)
    this.accounts.set(account.id, {
      ...account,
      isAvailable: suspended ? false : account.isAvailable ?? true,
      requestCount: account.requestCount ?? 0,
      errorCount: account.errorCount ?? 0,
      lastUsed: account.lastUsed ?? 0
    })
    this.accountStats.set(account.id, {
      requests: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      errors: 0,
      lastUsed: 0,
      avgResponseTime: 0,
      totalResponseTime: 0
    })
    if (suspended) {
      console.warn(`[AccountPool] Added SUSPENDED account: ${account.email || account.id} (${account.suspendReason})`)
    } else {
      console.log(`[AccountPool] Added account: ${account.email || account.id}`)
    }
  }

  // 移除账号
  removeAccount(accountId: string): void {
    this.accounts.delete(accountId)
    this.accountStats.delete(accountId)
    console.log(`[AccountPool] Removed account: ${accountId}`)
  }

  // 更新账号
  updateAccount(accountId: string, updates: Partial<ProxyAccount>): void {
    const account = this.accounts.get(accountId)
    if (account) {
      this.accounts.set(accountId, { ...account, ...updates })
    }
  }

  // 获取下一个可用账号（粘滞 + 断路器 + 指数退避 + 概率重试）
  getNextAccount(excludeIds?: Set<string>): ProxyAccount | null {
    const accountList = Array.from(this.accounts.values())
    if (accountList.length === 0) {
      return null
    }

    // 单账号特殊处理：绕过断路器，直接返回（让用户看到真实 API 错误）
    if (accountList.length === 1) {
      const account = accountList[0]
      if (excludeIds?.has(account.id)) return null
      return account
    }

    const now = Date.now()
    if (this.strategy === 'smart') {
      return this.getSmartBalancedAccount(accountList, now, excludeIds)
    }
    if (this.strategy === 'least-used') {
      return this.getLeastUsedAccount(accountList, now, excludeIds)
    }
    // 从当前粘滞索引开始遍历所有账号
    const startIndex = this.currentIndex

    for (let i = 0; i < accountList.length; i++) {
      const idx = (startIndex + i) % accountList.length
      const account = accountList[idx]

      // 跳过当前请求已试过的账号
      if (excludeIds?.has(account.id)) continue

      // 检查账号是否可用（含断路器状态）
      if (this.isAccountAvailable(account, now)) {
        this.reserveSelection(idx, accountList.length)
        return account
      }
    }

    // 没有可用账号：检查是否全部因配额耗尽
    const candidates = excludeIds
      ? accountList.filter(a => !excludeIds.has(a.id))
      : accountList
    const allExhausted = candidates.length > 0 && candidates.every(a => this.isQuotaExhausted(a, now))
    if (allExhausted) {
      console.log(`[AccountPool] All ${candidates.length} accounts quota exhausted, no fallback available`)
      return null
    }

    return null
  }

  // 获取特定账号
  getAccount(accountId: string): ProxyAccount | null {
    return this.accounts.get(accountId) || null
  }

  // 获取下一个可用账号（排除指定账号；支持单 ID 或 ID 集合）
  // 集合形式用于「请求级累计已试账号」，避免重试时循环命中已经失败过的账号
  getNextAvailableAccount(exclude: string | Set<string>): ProxyAccount | null {
    const excludeSet = typeof exclude === 'string' ? new Set([exclude]) : exclude
    const accountList = Array.from(this.accounts.values())
    if (accountList.length === 0) return null

    const now = Date.now()
    if (this.strategy === 'smart') {
      return this.getSmartBalancedAccount(accountList, now, excludeSet)
    }
    if (this.strategy === 'least-used') {
      return this.getLeastUsedAccount(accountList, now, excludeSet)
    }

    // 从轮询指针开始找，failover 也均匀分配到健康账号。
    const startIndex = this.currentIndex
    for (let i = 0; i < accountList.length; i++) {
      const idx = (startIndex + i) % accountList.length
      const account = accountList[idx]
      if (!excludeSet.has(account.id) && this.isAccountAvailable(account, now)) {
        this.reserveSelection(idx, accountList.length)
        return account
      }
    }

    return null
  }

  // 获取所有账号
  getAllAccounts(): ProxyAccount[] {
    return Array.from(this.accounts.values())
  }

  // 检查账号是否可用（断路器 + 指数退避 + 概率重试）
  isAccountAvailable(account: ProxyAccount, now: number = Date.now()): boolean {
    // 检查是否被 Kiro 后端封禁（需人工解封）
    if (this.isSuspended(account)) {
      return false
    }

    // 检查配额是否耗尽
    if (this.isQuotaExhausted(account, now)) {
      return false
    }

    // 检查 token 是否过期
    // - 无 refreshToken 时直接判为不可用（无法刷新）
    // - 有 refreshToken 时让账号通过 —— proxyServer.getAvailableAccount 会检测
    //   isTokenExpiringSoon 并主动调用 refreshToken；若刷新失败会通过 markNeedsRefresh
    //   设置 isAvailable=false，下次循环再被本函数 line 210 跳过，形成闭环
    if (account.expiresAt && account.expiresAt < now && !account.refreshToken) {
      return false
    }

    if (account.isAvailable === false) {
      return false
    }

    if (account.cooldownUntil && account.cooldownUntil > now) {
      return false
    }

    // 断路器检查：指数退避 + 概率重试
    const failures = account.errorCount || 0
    if (failures > 0 && account.lastUsed) {
      const timeSinceFailure = now - account.lastUsed
      // 指数退避：base * 2^(failures-1)，封顶为 maxBackoffMultiplier
      const backoffMultiplier = Math.min(Math.pow(2, failures - 1), this.config.maxBackoffMultiplier)
      const effectiveCooldown = account.lastErrorStatus === 429
        ? Math.min(2_000 * backoffMultiplier, 5 * 60_000)
        : this.config.baseCooldownMs * backoffMultiplier

      if (timeSinceFailure < effectiveCooldown) {
        // 未超出冷却期，用概率重试
        if (Math.random() > this.config.probabilisticRetryChance) {
          return false
        }
        console.log(`[AccountPool] Probabilistic retry for ${account.email || account.id} (failures=${failures}, cooldown=${Math.round(effectiveCooldown / 1000)}s)`)
      }
      // else: 冷却期已过，Half-Open 状态，允许重试
    }

    return true
  }

  // 检查账号是否被长期封禁（TEMPORARILY_SUSPENDED / AccountSuspendedException 等风控触发）
  // 不同于临时 errorCount 冷却，需要人工解封或调用 clearSuspended
  isSuspended(account: ProxyAccount): boolean {
    return typeof account.suspendedAt === 'number' && account.suspendedAt > 0
  }

  // 标记账号为被封禁状态，账号池会持续跳过该账号直到 clearSuspended
  markSuspended(accountId: string, reason: string, message?: string): boolean {
    const account = this.accounts.get(accountId)
    if (!account) return false
    if (this.isSuspended(account) && account.suspendReason === reason) {
      // 已标记过同样原因，不重复记录
      return false
    }
    this.accounts.set(accountId, {
      ...account,
      suspendedAt: Date.now(),
      suspendReason: reason,
      suspendMessage: message,
      isAvailable: false
    })
    console.warn(`[AccountPool] Account ${account.email || accountId} SUSPENDED (${reason})`)
    return true
  }

  // 解除账号封禁标记（供手动重置或检测到被解封后调用）
  clearSuspended(accountId: string): void {
    const account = this.accounts.get(accountId)
    if (!account || !this.isSuspended(account)) return
    this.accounts.set(accountId, {
      ...account,
      suspendedAt: undefined,
      suspendReason: undefined,
      suspendMessage: undefined,
      isAvailable: true,
      errorCount: 0,
      lastErrorStatus: undefined
    })
    console.log(`[AccountPool] Account ${account.email || accountId} unsuspended`)
  }

  // 检查账号配额是否耗尽
  isQuotaExhausted(account: ProxyAccount, now: number = Date.now()): boolean {
    // 如果配额已重置（过了重置时间），不再视为耗尽
    if (account.quotaResetAt && account.quotaResetAt <= now) {
      return false
    }
    // 有明确的耗尽标记
    if (account.quotaExhaustedAt && account.quotaExhaustedAt > 0) {
      return true
    }
    // 有配额数据且已用尽
    if (account.quotaLimit && account.quotaLimit > 0 && (account.quotaUsed ?? 0) >= account.quotaLimit) {
      return true
    }
    return false
  }

  private reserveSelection(selectedIndex: number, accountCount: number): void {
    if (this.strategy === 'round-robin' && accountCount > 0) {
      this.currentIndex = (selectedIndex + 1) % accountCount
    }
  }

  private getLeastUsedAccount(accountList: ProxyAccount[], now: number, excludeIds?: Set<string>): ProxyAccount | null {
    let best: ProxyAccount | null = null

    for (const account of accountList) {
      if (excludeIds?.has(account.id)) continue
      if (!this.isAccountAvailable(account, now)) continue

      if (!best) {
        best = account
        continue
      }

      const accountRequests = account.requestCount || 0
      const bestRequests = best.requestCount || 0
      if (accountRequests < bestRequests) {
        best = account
      } else if (accountRequests === bestRequests && (account.lastUsed || 0) < (best.lastUsed || 0)) {
        best = account
      }
    }

    if (best) {
      this.accounts.set(best.id, { ...best, lastUsed: now })
    }

    return best
  }

  private getSmartBalancedAccount(accountList: ProxyAccount[], now: number, excludeIds?: Set<string>): ProxyAccount | null {
    let best: { account: ProxyAccount; score: number } | null = null

    for (const account of accountList) {
      if (excludeIds?.has(account.id)) continue
      if (!this.isAccountAvailable(account, now)) continue

      const score = this.scoreAccountForSmartBalance(account, now)
      if (
        !best ||
        score > best.score ||
        (score === best.score && (account.lastUsed || 0) < (best.account.lastUsed || 0))
      ) {
        best = { account, score }
      }
    }

    if (best) {
      this.accounts.set(best.account.id, { ...best.account, lastUsed: now })
    }

    return best?.account || null
  }

  private scoreAccountForSmartBalance(account: ProxyAccount, now: number): number {
    const stats = this.accountStats.get(account.id)
    let score = 1000

    const quotaLimit = account.quotaLimit || 0
    if (quotaLimit > 0) {
      const used = Math.max(0, account.quotaUsed || 0)
      const remainingRatio = Math.max(0, Math.min(1, (quotaLimit - used) / quotaLimit))
      score += remainingRatio * 500
      if (remainingRatio < 0.1) score -= 300
      else if (remainingRatio < 0.2) score -= 150
    } else {
      score += 100
    }

    score -= Math.min(500, (account.errorCount || 0) * 140)
    score -= Math.min(200, (stats?.errors || 0) * 25)
    score -= Math.min(180, (account.requestCount || 0) * 3)
    score -= Math.min(120, (stats?.requests || 0) * 2)

    if (stats?.avgResponseTime) {
      score -= Math.min(120, stats.avgResponseTime / 100)
    }

    const lastUsed = account.lastUsed || stats?.lastUsed || 0
    if (lastUsed > 0) {
      const idleMs = now - lastUsed
      score += Math.min(120, Math.max(0, idleMs) / 1000 / 2)
    } else {
      score += 120
    }

    if (account.expiresAt) {
      const minutesLeft = (account.expiresAt - now) / 60000
      if (minutesLeft < 5) score -= 250
      else if (minutesLeft < 15) score -= 80
    }

    // Tiny deterministic jitter prevents permanent ties without defeating balance.
    score += this.stableAccountJitter(account.id)
    return score
  }

  private stableAccountJitter(accountId: string): number {
    let hash = 0
    for (let i = 0; i < accountId.length; i++) {
      hash = ((hash << 5) - hash + accountId.charCodeAt(i)) | 0
    }
    return Math.abs(hash % 17) / 10
  }

  // 记录请求成功（重置断路器 + 粘滞到当前账号）
  recordSuccess(accountId: string, tokens: number = 0): void {
    const account = this.accounts.get(accountId)
    if (account) {
      this.accounts.set(accountId, {
        ...account,
        requestCount: (account.requestCount || 0) + 1,
        errorCount: 0, // 重置断路器失败计数
        lastErrorStatus: undefined,
        lastUsed: Date.now(),
        isAvailable: true,
        cooldownUntil: undefined,
        quotaExhaustedAt: undefined
      })

      const accountList = Array.from(this.accounts.keys())
      const successIndex = accountList.indexOf(accountId)
      if (successIndex >= 0 && accountList.length > 0) {
        if (this.strategy === 'sticky') {
          // 粘滞: 成功后将全局索引固定在这个账号 (保留 prompt cache 命中)
          this.currentIndex = successIndex
        }
      }
    }

    const stats = this.accountStats.get(accountId)
    if (stats) {
      this.accountStats.set(accountId, {
        ...stats,
        requests: stats.requests + 1,
        tokens: stats.tokens + tokens,
        lastUsed: Date.now()
      })
    }
  }

  // 记录请求失败（区分错误类型）
  recordError(accountId: string, errorType: ErrorType = ErrorType.RECOVERABLE, statusCode?: number): void {
    const account = this.accounts.get(accountId)
    if (!account) return

    const now = Date.now()
    const stats = this.accountStats.get(accountId)
    if (stats) {
      this.accountStats.set(accountId, { ...stats, errors: stats.errors + 1, lastUsed: now })
    }

    // FATAL 错误不增加失败计数（是请求的问题，不是账号的问题）
    if (errorType === ErrorType.FATAL) return

    // RECOVERABLE: 增加失败计数，断路器指数退避自动生效
    const errorCount = (account.errorCount || 0) + 1
    let quotaExhaustedAt = account.quotaExhaustedAt

    // 402 表示账号配额/计费耗尽；429 只做短期节流冷却。
    const isQuotaError = statusCode === 402
    if (isQuotaError) {
      quotaExhaustedAt = now
    }

    // 计算当前退避时间用于日志
    const backoffMultiplier = Math.min(Math.pow(2, errorCount - 1), this.config.maxBackoffMultiplier)
    const effectiveCooldown = statusCode === 429
      ? Math.min(2_000 * backoffMultiplier, 5 * 60_000)
      : this.config.baseCooldownMs * backoffMultiplier
    const cooldownStr = effectiveCooldown < 60000 ? `${Math.round(effectiveCooldown / 1000)}s`
      : effectiveCooldown < 3600000 ? `${Math.round(effectiveCooldown / 60000)}m`
      : `${Math.round(effectiveCooldown / 3600000)}h`

    console.log(`[AccountPool] Account ${account.email || accountId} failure #${errorCount}: status=${statusCode || '?'}, cooldown=${cooldownStr}`)

    this.accounts.set(accountId, {
      ...account,
      errorCount,
      lastErrorStatus: statusCode,
      quotaExhaustedAt,
      quotaResetAt: isQuotaError
        ? (account.quotaResetAt && account.quotaResetAt > now ? account.quotaResetAt : now + this.config.quotaResetMs)
        : account.quotaResetAt,
      cooldownUntil: isQuotaError ? undefined : now + effectiveCooldown,
      lastUsed: now
    })
  }

  /** Replace credentials/config while preserving runtime health and quota state. */
  replaceAccounts(accounts: ProxyAccount[]): void {
    const previousAccounts = this.accounts
    const previousStats = this.accountStats
    this.accounts = new Map()
    this.accountStats = new Map()

    for (const account of accounts) {
      const previous = previousAccounts.get(account.id)
      this.addAccount(previous ? {
        ...account,
        requestCount: previous.requestCount,
        errorCount: previous.errorCount,
        lastErrorStatus: previous.lastErrorStatus,
        lastUsed: previous.lastUsed,
        isAvailable: previous.isAvailable,
        cooldownUntil: previous.cooldownUntil,
        quotaUsed: previous.quotaUsed,
        quotaLimit: previous.quotaLimit,
        quotaExhaustedAt: previous.quotaExhaustedAt,
        quotaResetAt: previous.quotaResetAt,
        suspendedAt: previous.suspendedAt,
        suspendReason: previous.suspendReason,
        suspendMessage: previous.suspendMessage
      } : account)
      const stats = previousStats.get(account.id)
      if (stats) this.accountStats.set(account.id, stats)
    }

    this.currentIndex = this.accounts.size > 0 ? this.currentIndex % this.accounts.size : 0
  }

  markQuotaExhausted(accountId: string): void {
    this.recordError(accountId, ErrorType.RECOVERABLE, 402)
  }

  // 更新账号配额信息
  updateQuota(accountId: string, used: number, limit: number, resetAt?: number): void {
    const account = this.accounts.get(accountId)
    if (!account) return

    const wasExhausted = this.isQuotaExhausted(account)
    this.accounts.set(accountId, {
      ...account,
      quotaUsed: used,
      quotaLimit: limit,
      quotaResetAt: resetAt,
      // 如果配额从耗尽恢复，清除耗尽标记
      quotaExhaustedAt: (used < limit) ? undefined : account.quotaExhaustedAt,
      lastErrorStatus: (used < limit && account.lastErrorStatus === 402) ? undefined : account.lastErrorStatus
    })

    if (!wasExhausted && used >= limit) {
      console.log(`[AccountPool] Account ${account.email || accountId} quota reached: ${used}/${limit}`)
    } else if (wasExhausted && used < limit) {
      console.log(`[AccountPool] Account ${account.email || accountId} quota recovered: ${used}/${limit}`)
    }
  }

  // 获取配额状态摘要
  getQuotaStatus(): { total: number; available: number; exhausted: number; cooldown: number } {
    const now = Date.now()
    const all = Array.from(this.accounts.values())
    let available = 0
    let exhausted = 0
    let cooldown = 0

    for (const account of all) {
      if (this.isQuotaExhausted(account, now)) {
        exhausted++
      } else if (account.cooldownUntil && account.cooldownUntil > now) {
        cooldown++
      } else if (this.isAccountAvailable(account, now)) {
        available++
      }
    }

    return { total: all.length, available, exhausted, cooldown }
  }

  // 标记账号需要刷新 Token
  markNeedsRefresh(accountId: string): void {
    const account = this.accounts.get(accountId)
    if (account) {
      this.accounts.set(accountId, {
        ...account,
        isAvailable: false
      })
    }
  }

  // 获取统计信息
  getStats(): { accounts: Map<string, AccountStats>; total: { requests: number; tokens: number; errors: number } } {
    let totalRequests = 0
    let totalTokens = 0
    let totalErrors = 0

    for (const stats of this.accountStats.values()) {
      totalRequests += stats.requests
      totalTokens += stats.tokens
      totalErrors += stats.errors
    }

    return {
      accounts: new Map(this.accountStats),
      total: {
        requests: totalRequests,
        tokens: totalTokens,
        errors: totalErrors
      }
    }
  }

  // 重置所有账号状态（含封禁标记 — 手动重置表示用户已确认可用）
  reset(): void {
    for (const [id, account] of this.accounts) {
      this.accounts.set(id, {
        ...account,
        isAvailable: true,
        errorCount: 0,
        lastErrorStatus: undefined,
        cooldownUntil: undefined,
        quotaExhaustedAt: undefined,
        suspendedAt: undefined,
        suspendReason: undefined,
        suspendMessage: undefined
      })
    }
    this.currentIndex = 0
  }

  // 清空所有账号
  clear(): void {
    this.accounts.clear()
    this.accountStats.clear()
    this.currentIndex = 0
  }

  // 获取账号数量
  get size(): number {
    return this.accounts.size
  }

  // 获取可用账号数量
  get availableCount(): number {
    const now = Date.now()
    let count = 0
    for (const account of this.accounts.values()) {
      if (this.isAccountAvailable(account, now)) {
        count++
      }
    }
    return count
  }
}
