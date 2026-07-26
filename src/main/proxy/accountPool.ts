// 多账号智能轮询管理器
// 参考 Kiro Gateway 的 Circuit Breaker + Sticky + 指数退避 + 概率重试机制
import type { ProxyAccount, AccountStats } from './types'

// 错误类型分类（决定 failover 策略）
export enum ErrorType {
  FATAL = 'fatal', // 请求本身有问题 → 直接返回客户端，不切号
  RECOVERABLE = 'recoverable' // 账号问题 → 切换到下一个账号
}

// 根据 HTTP 状态码和错误原因分类错误
export function classifyError(statusCode: number, reason?: string): ErrorType {
  if (reason && (isThrottleError(reason) || isBillingOrQuotaError(reason)))
    return ErrorType.RECOVERABLE
  // RECOVERABLE: 配额/计费问题
  if (statusCode === 402) return ErrorType.RECOVERABLE
  // RECOVERABLE: Token 过期/无效
  // 401 cũng là lỗi của account (refresh token bị thu hồi), không phải lỗi của request.
  // Nếu để FATAL thì recordError return sớm: errorCount không tăng, cooldownUntil không đặt
  // → isAccountAvailable vẫn true và round-robin phát lại account chết đó mãi mãi.
  if (statusCode === 401) return ErrorType.RECOVERABLE
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
  // Timeout luồng và lỗi tầng mạng là vấn đề của account/kết nối, không phải của request.
  // Caller (recordAccountFailure) đoán status bằng regex \b(\d{3})\b nên "Stream idle timeout
  // after 300000ms" không cho ra status nào và bị đoán thành 500 → FATAL → recordError bỏ qua:
  // account treo 300s vẫn được coi là khả dụng cho request kế tiếp.
  // Đặt trước nhánh 5xx để phân loại đúng bất kể caller đoán status là gì.
  if (
    reason &&
    /stream (first-byte|idle) timeout|socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(
      reason
    )
  ) {
    return ErrorType.RECOVERABLE
  }
  // 5xx: 服务端错误
  if (statusCode >= 500) return ErrorType.FATAL
  return ErrorType.FATAL
}

/** Account-specific billing/quota failures that should immediately fail over. */
export function isBillingOrQuotaError(message: string): boolean {
  if (isEndpointRateLimitError(message)) return false
  return /\b402\b|payment required|billing (?:error|issue|problem)|out of credits?|run out of credits?|insufficient (?:credits?|balance)|credit balance|no (?:remaining )?credits?|credits? (?:exhausted|depleted)|quota (?:exhausted|exceeded|reached)|servicequotaexceededexception|service quota exceeded|reached (?:the|your) (?:usage )?limit|usage limit (?:reached|exceeded)|monthly limit (?:reached|exceeded)/i.test(
    message
  )
}

/** Temporary account/endpoint throttling that should use a short cooldown. */
export function isThrottleError(message: string): boolean {
  return (
    isEndpointRateLimitError(message) ||
    /\b429\b|throttl|too many requests|rate[ _-]?limit/i.test(message)
  )
}

function isEndpointRateLimitError(message: string): boolean {
  return /quota exhausted on (?:amazonq|codewhisperer|amazonqcli)|endpoint .*rate[ _-]?limited/i.test(
    message
  )
}

export interface AccountPoolConfig {
  baseCooldownMs: number // 基础冷却时间（指数退避的基数）
  throttleCooldownMs: number
  maxThrottleCooldownMs: number
  maxBackoffMultiplier: number // 最大退避倍数
  quotaResetMs: number // 配额耗尽冷却时间
  probabilisticRetryChance: number // 概率重试几率（0-1）
  // Phase 1: Enhanced smart rotation
  smartTopN: number // 从 top-N 候选中加权随机选择（默认 3）
  slidingWindowSize: number // 滑动窗口大小（记录最近 N 次请求结果）
  // Phase 2: Throttling mitigation
  tpmWindowMs: number // TPM 滑动窗口（毫秒，默认 60s）
  adaptiveRateFactor: number // 自适应限流因子（0.5-1.0，从 throttling 中学习）
}

const DEFAULT_CONFIG: AccountPoolConfig = {
  baseCooldownMs: 60000, // 60s 基础冷却
  throttleCooldownMs: 5000, // 首次限流仍然快速恢复
  // 429 冷却上限 15 分钟（原 10s）
  // Trần cũ 10s bị chạm ngay ở errorCount = 2: min(5000 * 2^(n-1), 10000) khiến lần throttle
  // thứ 2, thứ 5 và thứ 50 đều chờ đúng 10s → pool nhỏ đập lại AWS mỗi ~10s vô hạn và làm
  // leo thang cờ "suspicious activity". Nâng trần để backoff mũ thực sự tăng được
  // (5s → 10s → 20s → ... → tối đa 15 phút), lần throttle đầu vẫn hồi phục nhanh.
  maxThrottleCooldownMs: 15 * 60_000,
  maxBackoffMultiplier: 1440, // 最大 1440 倍 = 24h
  quotaResetMs: 3600000, // 1h 配额重置
  probabilisticRetryChance: 0.1, // 10% 概率重试
  smartTopN: 3,
  slidingWindowSize: 100,
  tpmWindowMs: 60_000,
  adaptiveRateFactor: 0.8
}

// Phase 1: Sliding window entry for success rate tracking
interface SlidingWindowEntry {
  timestamp: number
  success: boolean
  latencyMs: number
  model?: string
}

// Phase 2: Per-account rate limit budget
interface RateLimitBudget {
  windowStart: number
  requestTimestamps: number[]
  throttleCount: number
  lastThrottleAt: number
  adaptiveFactor: number
}

function getCooldownMs(
  config: AccountPoolConfig,
  statusCode: number | undefined,
  errorCount: number
): number {
  const backoffMultiplier = Math.min(
    Math.pow(2, Math.max(0, errorCount - 1)),
    config.maxBackoffMultiplier
  )
  if (statusCode === 429) {
    return Math.min(config.throttleCooldownMs * backoffMultiplier, config.maxThrottleCooldownMs)
  }
  return config.baseCooldownMs * backoffMultiplier
}

function isApiKeyAccount(account: ProxyAccount): boolean {
  const authMethod = account.authMethod?.toLowerCase()
  const provider = account.provider?.toLowerCase().replace(/[\s_-]/g, '')
  return (
    Boolean(account.kiroApiKey) ||
    Boolean(account.accessToken?.trim().startsWith('ksk_')) ||
    authMethod === 'api_key' ||
    authMethod === 'apikey' ||
    provider === 'kiroapikey' ||
    provider === 'apikey'
  )
}

export type AccountSelectionStrategy = 'smart' | 'round-robin' | 'sticky' | 'least-used'

export class AccountPool {
  private accounts: Map<string, ProxyAccount> = new Map()
  private accountStats: Map<string, AccountStats> = new Map()
  private currentIndex: number = 0
  private config: AccountPoolConfig
  // 默认 round-robin: 选中账号时立即前进，避免并发请求集中到同一账号
  // sticky: 一个账号成功就粘住 (保留 prompt cache 命中)
  private strategy: AccountSelectionStrategy = 'round-robin'
  // Phase 1: Sliding window per account for success rate / latency tracking
  private slidingWindows: Map<string, SlidingWindowEntry[]> = new Map()
  // Phase 2: Per-account rate limit budgets (keyed by accountId)
  private rateLimitBudgets: Map<string, RateLimitBudget> = new Map()

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
      isAvailable: suspended ? false : (account.isAvailable ?? true),
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
      console.warn(
        `[AccountPool] Added SUSPENDED account: ${account.email || account.id} (${account.suspendReason})`
      )
    } else {
      console.log(`[AccountPool] Added account: ${account.email || account.id}`)
    }
  }

  // 移除账号
  removeAccount(accountId: string): void {
    this.accounts.delete(accountId)
    this.accountStats.delete(accountId)
    // Xoá nốt state theo id, nếu không: (1) rò rỉ ~100 SlidingWindowEntry + 1 RateLimitBudget
    // cho mỗi id từng thấy — đáng kể trên VPS liên tục tạo/xoá account; (2) một account
    // được thêm lại cùng id sẽ kế thừa lastThrottleAt cũ và bị smart-routing bỏ qua ngay
    // dù nó hoàn toàn khoẻ.
    this.rateLimitBudgets.delete(accountId)
    this.slidingWindows.delete(accountId)
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

    const now = Date.now()

    // 单账号也必须遵守配额、封禁和冷却状态。直接绕过可用性检查会在 429 后
    // 立即把下一次请求再次发给同一账号，抵消 cooldown 并加重上游限流。
    if (accountList.length === 1) {
      const account = accountList[0]
      if (excludeIds?.has(account.id)) return null
      return this.isAccountAvailable(account, now) ? account : null
    }

    if (this.strategy === 'smart') {
      return this.getSmartBalancedAccount(accountList, now, excludeIds)
    }
    if (this.strategy === 'least-used') {
      return this.getLeastUsedAccount(accountList, now, excludeIds)
    }

    // Phase 14: Quota-aware sticky — auto-unstick before exhaustion
    if (this.strategy === 'sticky' && this.shouldUnstick()) {
      this.forceUnstick()
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
    const candidates = excludeIds ? accountList.filter((a) => !excludeIds.has(a.id)) : accountList
    const allExhausted =
      candidates.length > 0 && candidates.every((a) => this.isQuotaExhausted(a, now))
    if (allExhausted) {
      console.log(
        `[AccountPool] All ${candidates.length} accounts quota exhausted, no fallback available`
      )
      return null
    }

    return null
  }

  // 获取特定账号
  getAccount(accountId: string): ProxyAccount | null {
    return this.accounts.get(accountId) || null
  }

  /**
   * 从候选子集中按配置策略选一个可用账号（供 tier 分组路由使用）。
   *
   * 与 getNextAccount 不同：调用方（proxyServer）已经把 pool 预过滤成"某个 tier 组"的
   * candidateIds，本方法只在该子集内选，并且只有真正选中时才前进 round-robin 指针
   * （selected+1），因此不会像旧的分组循环那样因反复调用而打乱全局指针（bug #5）。
   * candidateIds 为空 => 返回 null。excludeIds 为本请求已试过的账号。
   */
  getNextAccountFromCandidates(
    candidateIds: Set<string>,
    excludeIds?: Set<string>
  ): ProxyAccount | null {
    if (candidateIds.size === 0) return null
    const now = Date.now()
    const fullList = Array.from(this.accounts.values())
    const candidateList = fullList.filter(
      (account) => candidateIds.has(account.id) && !excludeIds?.has(account.id)
    )
    if (candidateList.length === 0) return null

    if (this.strategy === 'smart') {
      return this.getSmartBalancedAccount(candidateList, now)
    }
    if (this.strategy === 'least-used') {
      return this.getLeastUsedAccount(candidateList, now)
    }

    // round-robin / sticky: 扫描完整 pool 顺序（保持全局公平），但只选候选子集内、可用的账号。
    const startIndex = this.currentIndex
    for (let i = 0; i < fullList.length; i++) {
      const idx = (startIndex + i) % fullList.length
      const account = fullList[idx]
      if (!candidateIds.has(account.id)) continue
      if (excludeIds?.has(account.id)) continue
      if (!this.isAccountAvailable(account, now)) continue
      this.reserveSelection(idx, fullList.length)
      return account
    }
    return null
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
    if (
      account.expiresAt &&
      account.expiresAt < now &&
      !account.refreshToken &&
      !isApiKeyAccount(account)
    ) {
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
      const effectiveCooldown = getCooldownMs(this.config, account.lastErrorStatus, failures)

      if (timeSinceFailure < effectiveCooldown) {
        // 未超出冷却期，用概率重试
        if (Math.random() > this.config.probabilisticRetryChance) {
          return false
        }
        console.log(
          `[AccountPool] Probabilistic retry for ${account.email || account.id} (failures=${failures}, cooldown=${Math.round(effectiveCooldown / 1000)}s)`
        )
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
    // Không có gì xoá quotaResetAt đã qua, còn recordSuccess đặt quotaExhaustedAt mà không đặt
    // quotaResetAt mới → một quotaResetAt cũ vĩnh viễn vô hiệu hoá mọi kiểm tra bên dưới.
    // Chỉ cho phép mốc reset đã qua xoá cờ khi nó MỚI HƠN mốc đánh dấu cạn quota.
    if (
      account.quotaResetAt &&
      account.quotaResetAt <= now &&
      (!account.quotaExhaustedAt || account.quotaExhaustedAt < account.quotaResetAt)
    ) {
      return false
    }
    // 有明确的耗尽标记
    if (account.quotaExhaustedAt && account.quotaExhaustedAt > 0) {
      return true
    }
    // 有配额数据且已用尽
    if (
      account.quotaLimit &&
      account.quotaLimit > 0 &&
      (account.quotaUsed ?? 0) >= account.quotaLimit
    ) {
      return true
    }
    return false
  }

  private reserveSelection(selectedIndex: number, accountCount: number): void {
    if (this.strategy === 'round-robin' && accountCount > 0) {
      this.currentIndex = (selectedIndex + 1) % accountCount
    }
  }

  private getLeastUsedAccount(
    accountList: ProxyAccount[],
    now: number,
    excludeIds?: Set<string>
  ): ProxyAccount | null {
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
      } else if (
        accountRequests === bestRequests &&
        (account.lastUsed || 0) < (best.lastUsed || 0)
      ) {
        best = account
      }
    }

    if (best) {
      this.accounts.set(best.id, { ...best, lastUsed: now })
    }

    return best
  }

  private getSmartBalancedAccount(
    accountList: ProxyAccount[],
    now: number,
    excludeIds?: Set<string>
  ): ProxyAccount | null {
    // Phase 1: Score all available accounts, then weighted-random from top N
    const candidates: { account: ProxyAccount; score: number }[] = []

    for (const account of accountList) {
      if (excludeIds?.has(account.id)) continue
      if (!this.isAccountAvailable(account, now)) continue
      // Phase 2: Skip if rate limit budget exhausted
      if (this.isRateLimitBudgetExhausted(account.id, now)) continue

      const score = this.scoreAccountForSmartBalance(account, now)
      candidates.push({ account, score })
    }

    if (candidates.length === 0) return null

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score)

    // Pick from top N using weighted random (score as weight)
    const topN = Math.min(this.config.smartTopN, candidates.length)
    const topCandidates = candidates.slice(0, topN)
    const totalScore = topCandidates.reduce((sum, c) => sum + Math.max(1, c.score), 0)
    let rand = Math.random() * totalScore
    let selected = topCandidates[0]

    for (const candidate of topCandidates) {
      rand -= Math.max(1, candidate.score)
      if (rand <= 0) {
        selected = candidate
        break
      }
    }

    this.accounts.set(selected.account.id, { ...selected.account, lastUsed: now })
    return selected.account
  }

  private scoreAccountForSmartBalance(account: ProxyAccount, now: number): number {
    const stats = this.accountStats.get(account.id)
    const window = this.slidingWindows.get(account.id) || []

    // Composite score: SuccessRate * 0.35 + (1 - Latency/10s) * 0.20 +
    //                  QuotaRemaining * 0.15 + ErrorPenalty * 0.15 +
    //                  LoadBalance * 0.10 + TokenFreshness * 0.05
    let score = 0

    // 1. Success Rate (last N requests in sliding window) — weight 0.35
    const recentWindow = window.filter((e) => e.timestamp > now - 5 * 60_000) // last 5 min
    const successRate =
      recentWindow.length > 0
        ? recentWindow.filter((e) => e.success).length / recentWindow.length
        : 1.0 // no history = assume good
    score += successRate * 350

    // 2. Latency score (1 - avgLatency/10s) — weight 0.20
    const recentLatencies = recentWindow.filter((e) => e.latencyMs > 0)
    const avgLatency =
      recentLatencies.length > 0
        ? recentLatencies.reduce((sum, e) => sum + e.latencyMs, 0) / recentLatencies.length
        : 0
    const latencyScore = Math.max(0, 1 - avgLatency / 10000)
    score += latencyScore * 200

    // 3. Quota remaining — weight 0.15
    const quotaLimit = account.quotaLimit || 0
    if (quotaLimit > 0) {
      const used = Math.max(0, account.quotaUsed || 0)
      const remainingRatio = Math.max(0, Math.min(1, (quotaLimit - used) / quotaLimit))
      score += remainingRatio * 150
    } else {
      score += 150 // no quota tracking = full score
    }

    // 4. Error penalty — weight 0.15
    const errorPenalty = Math.min(1, (account.errorCount || 0) / 5)
    score += (1 - errorPenalty) * 150

    // 5. Load balance (prefer less-used accounts) — weight 0.10
    const requestCount = account.requestCount || 0
    const loadScore = Math.max(0, 1 - Math.min(requestCount, 1000) / 1000)
    score += loadScore * 100

    // 6. Token freshness (how recently token was refreshed) — weight 0.05
    if (account.expiresAt) {
      const minutesLeft = (account.expiresAt - now) / 60000
      if (minutesLeft > 30) score += 50
      else if (minutesLeft > 15) score += 30
      else if (minutesLeft > 5) score += 10
      // < 5 min: no bonus
    } else {
      score += 50 // no expiry = assume fresh
    }

    // Bonus: idle time (prefer accounts rested longer)
    const lastUsed = account.lastUsed || stats?.lastUsed || 0
    if (lastUsed > 0) {
      const idleMs = now - lastUsed
      score += Math.min(50, idleMs / 1000)
    } else {
      score += 50
    }

    // Phase 2: Rate limit budget penalty
    const budget = this.rateLimitBudgets.get(account.id)
    if (budget && budget.throttleCount > 0) {
      const throttlePenalty = Math.min(200, budget.throttleCount * 50)
      score -= throttlePenalty
    }

    // Tiny deterministic jitter prevents permanent ties without defeating balance
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

  // ============ Phase 1: Sliding Window ============

  /** Record a request result in the sliding window for success rate tracking */
  recordSlidingWindow(
    accountId: string,
    success: boolean,
    latencyMs: number,
    model?: string
  ): void {
    if (!this.slidingWindows.has(accountId)) {
      this.slidingWindows.set(accountId, [])
    }
    const window = this.slidingWindows.get(accountId)!
    window.push({ timestamp: Date.now(), success, latencyMs, model })
    // Trim to max window size
    while (window.length > this.config.slidingWindowSize) {
      window.shift()
    }
  }

  /** Get success rate for an account (0-1) from sliding window */
  getSuccessRate(accountId: string): number {
    const window = this.slidingWindows.get(accountId)
    if (!window || window.length === 0) return 1.0
    return window.filter((e) => e.success).length / window.length
  }

  /** Get average latency for an account from sliding window */
  getAvgLatency(accountId: string): number {
    const window = this.slidingWindows.get(accountId)
    if (!window || window.length === 0) return 0
    const withLatency = window.filter((e) => e.latencyMs > 0)
    if (withLatency.length === 0) return 0
    return withLatency.reduce((sum, e) => sum + e.latencyMs, 0) / withLatency.length
  }

  // ============ Phase 2: Rate Limit Budget ============

  /** Record a throttle (429) event for an account */
  recordThrottle(accountId: string): void {
    const now = Date.now()
    let budget = this.rateLimitBudgets.get(accountId)
    if (!budget) {
      budget = {
        windowStart: now,
        requestTimestamps: [],
        throttleCount: 0,
        lastThrottleAt: 0,
        adaptiveFactor: this.config.adaptiveRateFactor
      }
      this.rateLimitBudgets.set(accountId, budget)
    }
    budget.throttleCount++
    budget.lastThrottleAt = now
    // Reduce adaptive factor on each throttle (learn to be more conservative)
    budget.adaptiveFactor = Math.max(0.3, budget.adaptiveFactor * 0.85)
  }

  /** Record a successful request for rate limit budget tracking */
  recordRateLimitSuccess(accountId: string): void {
    const now = Date.now()
    let budget = this.rateLimitBudgets.get(accountId)
    if (!budget) {
      budget = {
        windowStart: now,
        requestTimestamps: [],
        throttleCount: 0,
        lastThrottleAt: 0,
        adaptiveFactor: this.config.adaptiveRateFactor
      }
      this.rateLimitBudgets.set(accountId, budget)
    }
    budget.requestTimestamps.push(now)
    // Trim timestamps outside the window
    const windowStart = now - this.config.tpmWindowMs
    budget.requestTimestamps = budget.requestTimestamps.filter((t) => t > windowStart)
    // Gradually recover adaptive factor on success
    if (budget.adaptiveFactor < this.config.adaptiveRateFactor) {
      budget.adaptiveFactor = Math.min(this.config.adaptiveRateFactor, budget.adaptiveFactor + 0.02)
    }
    // Decay throttle count over time (reset after 5 min without throttle)
    if (budget.throttleCount > 0 && now - budget.lastThrottleAt > 5 * 60_000) {
      budget.throttleCount = 0
    }
  }

  /** Check if an account's rate limit budget is exhausted */
  private isRateLimitBudgetExhausted(accountId: string, now: number): boolean {
    const budget = this.rateLimitBudgets.get(accountId)
    if (!budget) return false
    // If recently throttled (within last 30s), consider budget exhausted
    if (budget.lastThrottleAt > 0 && now - budget.lastThrottleAt < 30_000) {
      return true
    }
    return false
  }

  /** Get health metrics for an account (for dashboard display) */
  getAccountHealth(accountId: string): {
    successRate: number
    avgLatency: number
    requestsPerMinute: number
    throttleCount: number
    adaptiveFactor: number
    overallScore: number
    quotaUsagePercent: number
    isHealthy: boolean
  } {
    const now = Date.now()
    const window = this.slidingWindows.get(accountId) || []
    const budget = this.rateLimitBudgets.get(accountId)
    const recentWindow = window.filter((e) => e.timestamp > now - 60_000)
    const account = this.accounts.get(accountId)

    const successRate = this.getSuccessRate(accountId)
    const avgLatency = this.getAvgLatency(accountId)
    const throttleCount = budget?.throttleCount || 0

    // Phase 8+9: Compute overall health score (0-1)
    const latencyScore = avgLatency > 0 ? Math.max(0, 1 - avgLatency / 30000) : 1
    const throttleScore = Math.max(0, 1 - throttleCount / 10)
    const overallScore = successRate * 0.5 + latencyScore * 0.3 + throttleScore * 0.2

    // Phase 9: Quota usage prediction
    let quotaUsagePercent = 0
    if (account && typeof account.quotaLimit === 'number' && account.quotaLimit > 0) {
      quotaUsagePercent = ((account.quotaUsed || 0) / account.quotaLimit) * 100
    }

    return {
      successRate,
      avgLatency,
      requestsPerMinute: recentWindow.length,
      throttleCount,
      adaptiveFactor: budget?.adaptiveFactor || this.config.adaptiveRateFactor,
      overallScore,
      quotaUsagePercent,
      isHealthy: overallScore > 0.5 && quotaUsagePercent < 80
    }
  }

  // Phase 9: Get quota predictions for all accounts
  getQuotaPredictions(): Array<{
    accountId: string
    email?: string
    quotaUsed: number
    quotaLimit: number
    usagePercent: number
    estimatedExhaustionHours: number | null
    isLow: boolean
  }> {
    const now = Date.now()
    const predictions: Array<{
      accountId: string
      email?: string
      quotaUsed: number
      quotaLimit: number
      usagePercent: number
      estimatedExhaustionHours: number | null
      isLow: boolean
    }> = []

    for (const [id, account] of this.accounts) {
      if (typeof account.quotaLimit !== 'number' || account.quotaLimit <= 0) continue
      const used = account.quotaUsed || 0
      const limit = account.quotaLimit
      const usagePercent = (used / limit) * 100

      // Estimate usage rate from sliding window
      const window = this.slidingWindows.get(id) || []
      const oneHourAgo = now - 3600_000
      const recentEntries = window.filter((e) => e.timestamp > oneHourAgo)
      let estimatedExhaustionHours: number | null = null
      if (recentEntries.length > 0) {
        const hourlyRate = recentEntries.length
        const remainingQuota = limit - used
        if (hourlyRate > 0 && remainingQuota > 0) {
          estimatedExhaustionHours = remainingQuota / hourlyRate
        }
      }

      predictions.push({
        accountId: id,
        email: account.email,
        quotaUsed: used,
        quotaLimit: limit,
        usagePercent,
        estimatedExhaustionHours,
        isLow: usagePercent >= 80
      })
    }

    return predictions
  }

  // 记录请求成功（重置断路器 + 粘滞到当前账号 + sliding window + rate budget）
  recordSuccess(
    accountId: string,
    tokens: number = 0,
    credits: number = 0,
    responseTimeMs: number = 0,
    model?: string
  ): ProxyAccount | undefined {
    // Phase 1 + 2: Record in sliding window and rate budget
    this.recordSlidingWindow(accountId, true, responseTimeMs, model)
    this.recordRateLimitSuccess(accountId)
    const account = this.accounts.get(accountId)
    let updatedAccount: ProxyAccount | undefined
    if (account) {
      const now = Date.now()
      const creditDelta = Number.isFinite(credits) && credits > 0 ? credits : 0
      const quotaUsed =
        creditDelta > 0 ? Math.max(0, (account.quotaUsed || 0) + creditDelta) : account.quotaUsed
      const quotaLimit = account.quotaLimit
      const quotaReached =
        typeof quotaLimit === 'number' &&
        quotaLimit > 0 &&
        typeof quotaUsed === 'number' &&
        quotaUsed >= quotaLimit
      updatedAccount = {
        ...account,
        requestCount: (account.requestCount || 0) + 1,
        errorCount: 0, // 重置断路器失败计数
        lastErrorStatus: undefined,
        lastUsed: now,
        isAvailable: true,
        cooldownUntil: undefined,
        quotaUsed,
        quotaUsedDelta: creditDelta,
        quotaExhaustedAt: quotaReached ? now : undefined
      }
      this.accounts.set(accountId, updatedAccount)

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
    return updatedAccount
  }

  // 记录请求失败（区分错误类型）
  recordError(
    accountId: string,
    errorType: ErrorType = ErrorType.RECOVERABLE,
    statusCode?: number,
    responseTimeMs: number = 0
  ): void {
    const account = this.accounts.get(accountId)
    if (!account) return

    const now = Date.now()
    const stats = this.accountStats.get(accountId)
    if (stats) {
      this.accountStats.set(accountId, { ...stats, errors: stats.errors + 1, lastUsed: now })
    }

    // Phase 1: Record failure in sliding window
    this.recordSlidingWindow(accountId, false, responseTimeMs)
    // Phase 2: Record throttle event
    if (statusCode === 429) {
      this.recordThrottle(accountId)
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
    const effectiveCooldown = getCooldownMs(this.config, statusCode, errorCount)
    const cooldownStr =
      effectiveCooldown < 60000
        ? `${Math.round(effectiveCooldown / 1000)}s`
        : effectiveCooldown < 3600000
          ? `${Math.round(effectiveCooldown / 60000)}m`
          : `${Math.round(effectiveCooldown / 3600000)}h`

    console.log(
      `[AccountPool] Account ${account.email || accountId} failure #${errorCount}: status=${statusCode || '?'}, cooldown=${cooldownStr}`
    )

    this.accounts.set(accountId, {
      ...account,
      errorCount,
      lastErrorStatus: statusCode,
      quotaExhaustedAt,
      quotaResetAt: isQuotaError
        ? account.quotaResetAt && account.quotaResetAt > now
          ? account.quotaResetAt
          : now + this.config.quotaResetMs
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
      this.addAccount(
        previous
          ? {
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
            }
          : account
      )
      const stats = previousStats.get(account.id)
      if (stats) this.accountStats.set(account.id, stats)
    }

    // Account nào không còn trong danh sách mới thì phải bỏ luôn state phụ theo id của nó.
    // Account còn lại cố ý giữ nguyên (đây là "replace credentials, preserve health").
    for (const id of [...this.rateLimitBudgets.keys()]) {
      if (!this.accounts.has(id)) this.rateLimitBudgets.delete(id)
    }
    for (const id of [...this.slidingWindows.keys()]) {
      if (!this.accounts.has(id)) this.slidingWindows.delete(id)
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
      quotaExhaustedAt: used < limit ? undefined : account.quotaExhaustedAt,
      lastErrorStatus:
        used < limit && account.lastErrorStatus === 402 ? undefined : account.lastErrorStatus
    })

    if (!wasExhausted && used >= limit) {
      console.warn(
        `[AccountPool] Account ${account.email || accountId} QUOTA EXHAUSTED: ${used}/${limit} - Account will be skipped until reset`
      )
    } else if (wasExhausted && used < limit) {
      console.log(
        `[AccountPool] Account ${account.email || accountId} quota recovered: ${used}/${limit}`
      )
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

  // Phase 14: Conversation cache affinity — prefer same account for same conversation
  private conversationAffinity: Map<
    string,
    { accountId: string; lastAt: number; hitCount: number }
  > = new Map()
  private readonly CONVERSATION_AFFINITY_TTL = 10 * 60_000 // 10 minutes

  /**
   * Get preferred account for a conversation (prompt cache affinity).
   * Returns the account ID if it's still available and not near quota exhaustion.
   */
  getConversationPreferred(conversationId: string): string | null {
    const entry = this.conversationAffinity.get(conversationId)
    if (!entry) return null

    const now = Date.now()
    if (now - entry.lastAt > this.CONVERSATION_AFFINITY_TTL) {
      this.conversationAffinity.delete(conversationId)
      return null
    }

    const account = this.accounts.get(entry.accountId)
    if (!account) return null

    // Quota-aware: unstick if account is near exhaustion (>85%)
    if (account.quotaLimit && account.quotaLimit > 0) {
      const used = account.quotaUsed || 0
      if (used / account.quotaLimit > 0.85) return null
    }

    if (!this.isAccountAvailable(account, now)) return null

    return entry.accountId
  }

  /** Record that a conversation used a specific account (builds affinity). */
  recordConversationAffinity(conversationId: string, accountId: string): void {
    const existing = this.conversationAffinity.get(conversationId)
    this.conversationAffinity.set(conversationId, {
      accountId,
      lastAt: Date.now(),
      hitCount: (existing?.accountId === accountId ? existing.hitCount || 0 : 0) + 1
    })
  }

  /** Cleanup expired conversation affinity entries (called periodically). */
  cleanupConversationAffinity(): void {
    const now = Date.now()
    for (const [id, entry] of this.conversationAffinity) {
      if (now - entry.lastAt > this.CONVERSATION_AFFINITY_TTL) {
        this.conversationAffinity.delete(id)
      }
    }
  }

  // Phase 14: Quota-aware sticky — auto-unstick when quota nearing exhaustion
  /**
   * Check if sticky strategy should unstick from current account.
   * Returns true if the sticky account should be released (quota > threshold).
   */
  shouldUnstick(quotaThreshold: number = 0.85): boolean {
    if (this.strategy !== 'sticky') return false

    const accountList = Array.from(this.accounts.values())
    if (accountList.length <= 1) return false

    const stickyAccount = accountList[this.currentIndex]
    if (!stickyAccount) return false

    // Check quota usage
    if (stickyAccount.quotaLimit && stickyAccount.quotaLimit > 0) {
      const used = stickyAccount.quotaUsed || 0
      if (used / stickyAccount.quotaLimit > quotaThreshold) {
        return true
      }
    }

    // Check if too many recent errors
    const window = this.slidingWindows.get(stickyAccount.id) || []
    const recentWindow = window.filter((e) => e.timestamp > Date.now() - 60_000)
    if (recentWindow.length >= 3) {
      const recentSuccess = recentWindow.filter((e) => e.success).length / recentWindow.length
      if (recentSuccess < 0.5) return true
    }

    return false
  }

  /**
   * Force unstick: advance the round-robin pointer past the current sticky account.
   * Call when shouldUnstick() returns true.
   */
  forceUnstick(): void {
    const accountList = Array.from(this.accounts.values())
    if (accountList.length > 1) {
      this.currentIndex = (this.currentIndex + 1) % accountList.length
      console.log(`[AccountPool] Quota-aware unstick: moved pointer to index ${this.currentIndex}`)
    }
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
  getStats(): {
    accounts: Map<string, AccountStats>
    total: { requests: number; tokens: number; errors: number }
  } {
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
    // Reset phải xoá cả ngân sách rate-limit và sliding window. Nếu không, chiến lược
    // `smart` vẫn bỏ qua cứng mọi account có isRateLimitBudgetExhausted (lastThrottleAt
    // trong vòng 30 giây) — người dùng bấm "Reset pool" ngay sau một đợt 429 sẽ nhận
    // success rồi lập tức 503 no_eligible_account.
    this.rateLimitBudgets.clear()
    this.slidingWindows.clear()
    this.currentIndex = 0
  }

  // 清空所有账号
  clear(): void {
    this.accounts.clear()
    this.accountStats.clear()
    this.rateLimitBudgets.clear()
    this.slidingWindows.clear()
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
