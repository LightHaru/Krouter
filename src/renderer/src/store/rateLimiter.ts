/**
 * 注册批量任务限速 + 风控信号检测
 *
 * 设计：
 * - 滑动窗口统计：维护最近 N 秒内的成功/失败时间戳
 * - 动态退避：连续失败超过阈值时，自动延长间隔（指数退避）
 * - 风控触发：成功率突然下降到阈值以下，触发警告 + 自动放慢
 *
 * 使用方式：
 *   const limiter = createRateLimiter({...})
 *   limiter.reportResult(true / false)         // 每次任务结束上报
 *   await limiter.waitForSlot()                // 启动新任务前等待获取令牌
 *   limiter.snapshot()                          // UI 读取实时状态
 */

export interface RateLimiterConfig {
  /** 每分钟最大启动任务数（令牌桶速率） */
  maxPerMinute: number
  /** 突发上限（令牌桶容量） */
  burst: number
  /** 成功率监控窗口（秒） */
  windowSec: number
  /** 触发风控警告的成功率阈值（0-1） */
  successRateThreshold: number
  /** 触发风控警告所需最小样本数（避免少量样本误判） */
  minSamples: number
  /** 连续失败次数触发退避 */
  consecutiveFailureThreshold: number
  /** 退避基础时长（毫秒） */
  backoffBaseMs: number
  /** 退避最大时长（毫秒） */
  backoffMaxMs: number
}

export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
  maxPerMinute: 10,
  burst: 3,
  windowSec: 120,
  successRateThreshold: 0.5,
  minSamples: 5,
  consecutiveFailureThreshold: 3,
  backoffBaseMs: 8_000,
  backoffMaxMs: 120_000
}

export interface RateLimiterSnapshot {
  /** 当前桶中可用令牌数 */
  availableTokens: number
  /** 窗口内成功数 */
  windowSuccess: number
  /** 窗口内失败数 */
  windowFailed: number
  /** 当前成功率（0-1） */
  successRate: number
  /** 连续失败次数 */
  consecutiveFailures: number
  /** 当前退避剩余时长（毫秒，0 表示无退避） */
  backoffRemainingMs: number
  /** 当前是否处于风控警告状态 */
  riskWarning: boolean
  /** 实际吞吐率（个/分钟） */
  throughputPerMinute: number
}

interface RateLimiterInternal {
  config: RateLimiterConfig
  /** 令牌桶上次填充时间 */
  lastRefillTime: number
  /** 当前可用令牌 */
  tokens: number
  /** 时间戳事件队列 [timestamp, success] */
  events: Array<[number, boolean]>
  /** 连续失败次数 */
  consecutiveFailures: number
  /** 退避结束时间戳（0 表示不在退避） */
  backoffEndAt: number
}

export interface RateLimiter {
  /** 启动一个任务前调用：等待获取令牌（含退避） */
  waitForSlot: (signal?: { aborted: boolean }) => Promise<void>
  /** 任务完成后上报结果 */
  reportResult: (success: boolean) => void
  /** 读取实时状态（供 UI 显示） */
  snapshot: () => RateLimiterSnapshot
  /** 更新配置 */
  updateConfig: (next: Partial<RateLimiterConfig>) => void
  /** 重置统计 */
  reset: () => void
}

export function createRateLimiter(config: Partial<RateLimiterConfig> = {}): RateLimiter {
  const state: RateLimiterInternal = {
    config: { ...DEFAULT_RATE_LIMITER_CONFIG, ...config },
    lastRefillTime: Date.now(),
    tokens: (config.burst ?? DEFAULT_RATE_LIMITER_CONFIG.burst),
    events: [],
    consecutiveFailures: 0,
    backoffEndAt: 0
  }

  /** 按令牌桶规则补充令牌 */
  function refillTokens(): void {
    const now = Date.now()
    const elapsedMs = now - state.lastRefillTime
    if (elapsedMs <= 0) return
    const tokensPerMs = state.config.maxPerMinute / 60_000
    state.tokens = Math.min(state.config.burst, state.tokens + elapsedMs * tokensPerMs)
    state.lastRefillTime = now
  }

  /** 清理窗口外的事件 */
  function pruneEvents(): void {
    const cutoff = Date.now() - state.config.windowSec * 1000
    while (state.events.length > 0 && state.events[0][0] < cutoff) {
      state.events.shift()
    }
  }

  return {
    waitForSlot: async (signal) => {
      while (true) {
        if (signal?.aborted) return
        // 退避优先
        const now = Date.now()
        if (state.backoffEndAt > now) {
          const wait = Math.min(state.backoffEndAt - now, 1000)
          await new Promise((r) => setTimeout(r, wait))
          continue
        }
        refillTokens()
        if (state.tokens >= 1) {
          state.tokens -= 1
          return
        }
        // 令牌不足：按速率估算等待时长
        const tokensPerMs = state.config.maxPerMinute / 60_000
        const tokensNeeded = 1 - state.tokens
        const waitMs = Math.max(50, Math.min(2000, tokensNeeded / tokensPerMs))
        await new Promise((r) => setTimeout(r, waitMs))
      }
    },

    reportResult: (success) => {
      const now = Date.now()
      state.events.push([now, success])
      pruneEvents()

      if (success) {
        state.consecutiveFailures = 0
      } else {
        state.consecutiveFailures += 1
        if (state.consecutiveFailures >= state.config.consecutiveFailureThreshold) {
          // 指数退避：第 N 次失败 → backoffBase × 2^(N - threshold)
          const overflow = state.consecutiveFailures - state.config.consecutiveFailureThreshold + 1
          const backoffMs = Math.min(
            state.config.backoffBaseMs * Math.pow(2, overflow - 1),
            state.config.backoffMaxMs
          )
          state.backoffEndAt = now + backoffMs
        }
      }
    },

    snapshot: () => {
      refillTokens()
      pruneEvents()
      const now = Date.now()
      let success = 0, failed = 0
      for (const [, ok] of state.events) {
        if (ok) success++; else failed++
      }
      const total = success + failed
      const successRate = total > 0 ? success / total : 1
      const samples = total
      const riskWarning = samples >= state.config.minSamples && successRate < state.config.successRateThreshold
      const throughput = state.config.windowSec > 0
        ? (success * 60 / state.config.windowSec)
        : 0

      return {
        availableTokens: Math.floor(state.tokens),
        windowSuccess: success,
        windowFailed: failed,
        successRate,
        consecutiveFailures: state.consecutiveFailures,
        backoffRemainingMs: Math.max(0, state.backoffEndAt - now),
        riskWarning,
        throughputPerMinute: Math.round(throughput * 10) / 10
      }
    },

    updateConfig: (next) => {
      state.config = { ...state.config, ...next }
    },

    reset: () => {
      state.events = []
      state.consecutiveFailures = 0
      state.backoffEndAt = 0
      state.tokens = state.config.burst
      state.lastRefillTime = Date.now()
    }
  }
}
