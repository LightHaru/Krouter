import crypto from 'crypto'
import { fetch as undiciFetch } from 'undici'
import type { WebStore } from '../store'
import {
  checkAccountStatus,
  classifyKiroAccountError,
  type AccountLike
} from './kiroAccounts'
import { proxyPoolValidate } from './diagnostics'

export const IPLOCATE_PROXY_SOURCE = 'iplocate/free-proxy-list'
export const DEFAULT_IPLOCATE_SOURCE_URL =
  'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt'

type ProxyProtocol = 'http' | 'https' | 'socks4' | 'socks5'

export interface ProxyMaintenanceConfig {
  backendMaintenanceEnabled: boolean
  backendMaintenanceIntervalMin: number
  sourceSyncEnabled: boolean
  sourceUrl: string
  sourceValidateConcurrency: number
  sourceRemoveDead: boolean
  accountHealthCheckEnabled: boolean
  accountDeleteDead: boolean
  accountFailureThreshold: number
  accountCheckConcurrency: number
  testUrl: string
  testTimeoutMs: number
  maxUsableLatencyMs: number
  upstreamProxy?: string
}

export interface ProxyMaintenanceStatus {
  enabled: boolean
  running: boolean
  intervalMin: number
  sourceUrl: string
  lastReason?: string
  lastStartedAt?: number
  lastCompletedAt?: number
  nextRunAt?: number
  sourceCandidates: number
  proxiesChecked: number
  proxiesAlive: number
  proxiesAdded: number
  proxiesRemoved: number
  accountsChecked: number
  accountsRemoved: number
  lastError?: string
  recentErrors: string[]
}

interface StoredProxy {
  id: string
  url: string
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
  label?: string
  source?: string
  tags?: string[]
  status: 'untested' | 'testing' | 'alive' | 'dead' | 'slow'
  latencyMs?: number
  lastTestedAt?: number
  lastError?: string
  usedCount: number
  failCount: number
  lastUsedAt?: number
  lastBoundEmail?: string
  enabled: boolean
  createdAt: number
}

type StoredAccount = AccountLike & {
  id?: string
  status?: string
  lastError?: string
  lastCheckedAt?: number
  maintenanceFailureCount?: number
  usage?: {
    suspendedAt?: number
    suspendReason?: string
    suspendMessage?: string
    [key: string]: unknown
  }
}

type AccountCheckResult = {
  success?: boolean
  data?: {
    status?: string
    newCredentials?: {
      accessToken?: string
      refreshToken?: string
      expiresAt?: number
    }
  }
  error?: unknown
}

interface MaintenanceDependencies {
  fetchSourceText?: (url: string) => Promise<string>
  validateProxy?: typeof proxyPoolValidate
  checkAccount?: (account: AccountLike) => Promise<unknown>
  now?: () => number
  onDataChanged?: () => Promise<void> | void
}

interface ParsedProxy {
  url: string
  protocol: ProxyProtocol
  host: string
  port: number
  username?: string
  password?: string
}

interface ProxyValidationOutcome {
  proxy: ParsedProxy
  success: boolean
  latencyMs?: number
  externalIp?: string
  error?: string
}

interface AccountHealthOutcome {
  id: string
  account: StoredAccount
  result: AccountCheckResult
  terminal: boolean
  removeImmediately: boolean
  error?: string
}

const DEFAULT_CONFIG: ProxyMaintenanceConfig = {
  backendMaintenanceEnabled: true,
  backendMaintenanceIntervalMin: 30,
  sourceSyncEnabled: true,
  sourceUrl: DEFAULT_IPLOCATE_SOURCE_URL,
  sourceValidateConcurrency: 40,
  sourceRemoveDead: true,
  accountHealthCheckEnabled: true,
  accountDeleteDead: true,
  accountFailureThreshold: 2,
  accountCheckConcurrency: 8,
  testUrl: 'https://api.iplocate.io/ip',
  testTimeoutMs: 6000,
  maxUsableLatencyMs: 2500,
  upstreamProxy: ''
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(Math.floor(parsed), max))
}

export function normalizeProxyMaintenanceConfig(raw: unknown): ProxyMaintenanceConfig {
  const config = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    backendMaintenanceEnabled: config.backendMaintenanceEnabled !== false,
    backendMaintenanceIntervalMin: clampNumber(config.backendMaintenanceIntervalMin, 30, 5, 1440),
    sourceSyncEnabled: config.sourceSyncEnabled !== false,
    sourceUrl: String(config.sourceUrl || DEFAULT_IPLOCATE_SOURCE_URL).trim() || DEFAULT_IPLOCATE_SOURCE_URL,
    sourceValidateConcurrency: clampNumber(config.sourceValidateConcurrency, 40, 1, 100),
    sourceRemoveDead: config.sourceRemoveDead !== false,
    accountHealthCheckEnabled: config.accountHealthCheckEnabled !== false,
    accountDeleteDead: config.accountDeleteDead !== false,
    accountFailureThreshold: clampNumber(config.accountFailureThreshold, 2, 1, 10),
    accountCheckConcurrency: clampNumber(config.accountCheckConcurrency, 8, 1, 50),
    testUrl: String(config.testUrl || DEFAULT_CONFIG.testUrl).trim() || DEFAULT_CONFIG.testUrl,
    testTimeoutMs: clampNumber(config.testTimeoutMs, DEFAULT_CONFIG.testTimeoutMs, 1000, 30000),
    maxUsableLatencyMs: clampNumber(config.maxUsableLatencyMs, DEFAULT_CONFIG.maxUsableLatencyMs, 100, 10000),
    upstreamProxy: typeof config.upstreamProxy === 'string' ? config.upstreamProxy.trim() : ''
  }
}

function normalizeProxyUrl(value: string): ParsedProxy | null {
  const raw = value.trim()
  if (!raw || raw.startsWith('#')) return null
  try {
    const parsed = new URL(raw)
    const protocol = parsed.protocol.slice(0, -1).toLowerCase()
    if (!['http', 'https', 'socks4', 'socks5'].includes(protocol)) return null
    const port = Number(parsed.port)
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null
    const username = parsed.username ? decodeURIComponent(parsed.username) : undefined
    const password = parsed.password ? decodeURIComponent(parsed.password) : undefined
    const auth = username
      ? `${encodeURIComponent(username)}${password ? `:${encodeURIComponent(password)}` : ''}@`
      : ''
    return {
      url: `${protocol}://${auth}${parsed.hostname}:${port}`,
      protocol: protocol as ProxyProtocol,
      host: parsed.hostname,
      port,
      username,
      password
    }
  } catch {
    return null
  }
}

export function parseIplocateProxyList(text: string): ParsedProxy[] {
  const unique = new Map<string, ParsedProxy>()
  for (const line of String(text || '').split(/\r?\n/)) {
    const parsed = normalizeProxyUrl(line)
    if (parsed) unique.set(parsed.url, parsed)
  }
  return Array.from(unique.values())
}

async function defaultFetchSourceText(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await undiciFetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/plain',
        'User-Agent': 'Krouter-ProxyMaintenance/1.0'
      }
    })
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`)
    return await response.text()
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Proxy source request timed out')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return []
  const results = new Array<R>(items.length)
  let cursor = 0
  const runners = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++
        results[index] = await worker(items[index])
      }
    }
  )
  await Promise.all(runners)
  return results
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message?: unknown }).message || 'Unknown error')
  }
  return String(error || 'Unknown error')
}

function isPermanentCredentialFailure(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('invalid_grant') ||
    lower.includes('invalid grant') ||
    lower.includes('invalid_client') ||
    lower.includes('invalid client') ||
    lower.includes('refresh token has expired') ||
    lower.includes('refresh token expired') ||
    lower.includes('invalid refresh token') ||
    lower.includes('missing access token') ||
    lower.includes('bad credentials') ||
    lower.includes('unauthorized') ||
    /\b401\b/.test(lower)
  )
}

function shouldKeepForTransientFailure(message: string): boolean {
  const lower = message.toLowerCase()
  return (
    lower.includes('too many requests') ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('fetch failed') ||
    lower.includes('timed out') ||
    lower.includes('timeout') ||
    lower.includes('econnreset') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('network') ||
    /\b429\b/.test(lower) ||
    /\b5\d\d\b/.test(lower)
  )
}

function isFastProxyOutcome(validation: ProxyValidationOutcome, maxLatencyMs: number): boolean {
  return validation.success === true &&
    typeof validation.latencyMs === 'number' &&
    Number.isFinite(validation.latencyMs) &&
    validation.latencyMs >= 0 &&
    validation.latencyMs <= maxLatencyMs
}

function isReachableProxyOutcome(validation: ProxyValidationOutcome): boolean {
  return validation.success === true &&
    typeof validation.latencyMs === 'number' &&
    Number.isFinite(validation.latencyMs) &&
    validation.latencyMs >= 0
}

function buildProxyEntry(proxy: ParsedProxy, validation: ProxyValidationOutcome, now: number, maxLatencyMs: number): StoredProxy {
  return {
    id: crypto.randomUUID(),
    url: proxy.url,
    protocol: proxy.protocol,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
    label: 'IPLocate',
    source: IPLOCATE_PROXY_SOURCE,
    tags: ['iplocate', 'free-proxy'],
    status: isFastProxyOutcome(validation, maxLatencyMs) ? 'alive' : 'slow',
    latencyMs: validation.latencyMs,
    lastTestedAt: now,
    usedCount: 0,
    failCount: 0,
    enabled: true,
    createdAt: now
  }
}

function updateProxyEntry(entry: StoredProxy, validation: ProxyValidationOutcome, now: number, maxLatencyMs: number): StoredProxy {
  if (!validation.success) {
    return {
      ...entry,
      status: 'dead',
      latencyMs: validation.latencyMs,
      lastTestedAt: now,
      lastError: validation.error,
      failCount: (entry.failCount || 0) + 1
    }
  }
  return {
    ...entry,
    status: isFastProxyOutcome(validation, maxLatencyMs) ? 'alive' : 'slow',
    latencyMs: validation.latencyMs,
    lastTestedAt: now,
    lastError: undefined,
    failCount: 0,
    enabled: true
  }
}

function initialStatus(config: ProxyMaintenanceConfig): ProxyMaintenanceStatus {
  return {
    enabled: config.backendMaintenanceEnabled,
    running: false,
    intervalMin: config.backendMaintenanceIntervalMin,
    sourceUrl: config.sourceUrl,
    sourceCandidates: 0,
    proxiesChecked: 0,
    proxiesAlive: 0,
    proxiesAdded: 0,
    proxiesRemoved: 0,
    accountsChecked: 0,
    accountsRemoved: 0,
    recentErrors: []
  }
}

export class ProxyMaintenanceRuntime {
  private intervalTimer?: ReturnType<typeof setInterval>
  private initialTimer?: ReturnType<typeof setTimeout>
  /** Cấu hình mà interval timer hiện tại đang phục vụ — để configure() nhận ra khi không có gì đổi. */
  private activeIntervalMin?: number
  private activeEnabled?: boolean
  private runningPromise?: Promise<ProxyMaintenanceStatus>
  private status: ProxyMaintenanceStatus
  private readonly fetchSourceText: (url: string) => Promise<string>
  private readonly validateProxy: typeof proxyPoolValidate
  private readonly checkAccount: (account: AccountLike) => Promise<unknown>
  private readonly now: () => number
  private readonly onDataChanged: () => Promise<void> | void

  constructor(
    private readonly store: WebStore,
    private readonly userId: string,
    private readonly emit: (channel: string, ...args: unknown[]) => void,
    dependencies: MaintenanceDependencies = {}
  ) {
    const config = this.getConfig()
    this.status = {
      ...initialStatus(config),
      ...this.store.getUserSetting<Partial<ProxyMaintenanceStatus>>(this.userId, 'proxyMaintenanceStatus', {})
    }
    this.fetchSourceText = dependencies.fetchSourceText || defaultFetchSourceText
    this.validateProxy = dependencies.validateProxy || proxyPoolValidate
    this.checkAccount = dependencies.checkAccount || checkAccountStatus
    this.now = dependencies.now || Date.now
    this.onDataChanged = dependencies.onDataChanged || (() => undefined)
  }

  getConfig(): ProxyMaintenanceConfig {
    const data = this.store.getAccountData(this.userId)
    const accountData = data && typeof data === 'object' ? data as Record<string, unknown> : {}
    return normalizeProxyMaintenanceConfig(accountData.proxyPoolConfig)
  }

  getStatus(): ProxyMaintenanceStatus {
    const config = this.getConfig()
    return {
      ...this.status,
      enabled: config.backendMaintenanceEnabled,
      intervalMin: config.backendMaintenanceIntervalMin,
      sourceUrl: config.sourceUrl
    }
  }

  configure(runOnBoot = false): ProxyMaintenanceStatus {
    const config = this.getConfig()

    // configure() được gọi lại sau mỗi saveAccounts/mergePeerAccounts, mà dashboard autosave
    // 30 giây/lần. Dựng lại interval vô điều kiện đồng nghĩa chu kỳ 30 phút không bao giờ
    // chạm mốc. Giữ nguyên timer đang chạy khi cấu hình không đổi.
    const unchanged =
      this.intervalTimer !== undefined &&
      this.activeIntervalMin === config.backendMaintenanceIntervalMin &&
      this.activeEnabled === config.backendMaintenanceEnabled
    if (unchanged && !runOnBoot) return this.getStatus()

    this.clearTimers()
    this.status = {
      ...this.status,
      enabled: config.backendMaintenanceEnabled,
      intervalMin: config.backendMaintenanceIntervalMin,
      sourceUrl: config.sourceUrl,
      nextRunAt: config.backendMaintenanceEnabled
        ? this.now() + config.backendMaintenanceIntervalMin * 60_000
        : undefined
    }

    if (!config.backendMaintenanceEnabled) {
      this.activeEnabled = false
      this.activeIntervalMin = undefined
      void this.persistStatus()
      return this.getStatus()
    }

    const intervalMs = config.backendMaintenanceIntervalMin * 60_000
    this.intervalTimer = setInterval(() => {
      void this.runNow('interval')
    }, intervalMs)
    this.intervalTimer.unref?.()
    this.activeEnabled = true
    this.activeIntervalMin = config.backendMaintenanceIntervalMin

    if (runOnBoot) {
      this.initialTimer = setTimeout(() => {
        void this.runNow('server-boot')
      }, 3000)
      this.initialTimer.unref?.()
    }
    void this.persistStatus()
    return this.getStatus()
  }

  stop(): void {
    this.clearTimers()
  }

  async runNow(reason = 'manual'): Promise<ProxyMaintenanceStatus> {
    if (this.runningPromise) return this.runningPromise
    this.runningPromise = this.execute(reason)
    try {
      return await this.runningPromise
    } finally {
      this.runningPromise = undefined
    }
  }

  private clearTimers(): void {
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    if (this.initialTimer) clearTimeout(this.initialTimer)
    this.intervalTimer = undefined
    this.initialTimer = undefined
    this.activeIntervalMin = undefined
    this.activeEnabled = undefined
  }

  private async persistStatus(): Promise<void> {
    await this.store.setUserSetting(this.userId, 'proxyMaintenanceStatus', this.status)
    this.emit('proxy-maintenance-status', this.getStatus())
  }

  private async execute(reason: string): Promise<ProxyMaintenanceStatus> {
    const config = this.getConfig()
    const startedAt = this.now()
    this.status = {
      ...initialStatus(config),
      running: true,
      lastReason: reason,
      lastStartedAt: startedAt,
      lastCompletedAt: this.status.lastCompletedAt,
      nextRunAt: startedAt + config.backendMaintenanceIntervalMin * 60_000
    }
    await this.persistStatus()

    try {
      if (!config.backendMaintenanceEnabled && reason !== 'manual') return this.getStatus()

      let proxyOutcomes: ProxyValidationOutcome[] = []
      if (config.sourceSyncEnabled) {
        const sourceText = await this.fetchSourceText(config.sourceUrl)
        const candidates = parseIplocateProxyList(sourceText)
        this.status.sourceCandidates = candidates.length
        let proxiesChecked = 0
        let proxiesAlive = 0
        proxyOutcomes = await mapConcurrent(
          candidates,
          config.sourceValidateConcurrency,
          async (proxy): Promise<ProxyValidationOutcome> => {
            let outcome: ProxyValidationOutcome
            try {
              const result = await this.validateProxy({
                url: proxy.url,
                testUrl: config.testUrl,
                timeoutMs: config.testTimeoutMs,
                upstreamProxy: config.upstreamProxy,
                requireAwsSigninRoute: true
              })
              outcome = { proxy, ...result }
            } catch (error) {
              outcome = { proxy, success: false, error: errorText(error) }
            }
            proxiesChecked++
            if (isReachableProxyOutcome(outcome)) proxiesAlive++
            this.status.proxiesChecked = proxiesChecked
            this.status.proxiesAlive = proxiesAlive
            if (proxiesChecked % 50 === 0 || proxiesChecked === candidates.length) {
              this.emit('proxy-maintenance-status', this.getStatus())
            }
            return outcome
          }
        )
        this.status.proxiesChecked = proxyOutcomes.length
        this.status.proxiesAlive = proxyOutcomes.filter(isReachableProxyOutcome).length
      }

      const accountDataAtStart = this.getAccountData()
      const accountsAtStart = this.getAccounts(accountDataAtStart)
      let accountOutcomes: AccountHealthOutcome[] = []
      if (config.accountHealthCheckEnabled) {
        let accountsChecked = 0
        accountOutcomes = await mapConcurrent(
          Object.entries(accountsAtStart),
          config.accountCheckConcurrency,
          async ([id, account]): Promise<AccountHealthOutcome> => {
            let outcome: AccountHealthOutcome
            try {
              const result = await this.checkAccount({ ...account, id }) as AccountCheckResult
              if (result?.success) {
                outcome = { id, account, result, terminal: false, removeImmediately: false }
                accountsChecked++
                this.status.accountsChecked = accountsChecked
                if (accountsChecked % 10 === 0 || accountsChecked === Object.keys(accountsAtStart).length) {
                  this.emit('proxy-maintenance-status', this.getStatus())
                }
                return outcome
              }
              const message = errorText(result?.error)
              const classified = classifyKiroAccountError(message)
              const transient = shouldKeepForTransientFailure(message) || classified.isQuotaExhausted
              outcome = {
                id,
                account,
                result,
                terminal: !transient && (Boolean(classified.isBanned) || isPermanentCredentialFailure(message)),
                removeImmediately: Boolean(classified.isBanned),
                error: message
              }
            } catch (error) {
              const message = errorText(error)
              outcome = {
                id,
                account,
                result: { success: false, error: message },
                terminal: false,
                removeImmediately: false,
                error: message
              }
            }
            accountsChecked++
            this.status.accountsChecked = accountsChecked
            if (accountsChecked % 10 === 0 || accountsChecked === Object.keys(accountsAtStart).length) {
              this.emit('proxy-maintenance-status', this.getStatus())
            }
            return outcome
          }
        )
        this.status.accountsChecked = accountOutcomes.length
      }

      await this.applyResults(config, proxyOutcomes, accountOutcomes)
      this.status.lastError = undefined
    } catch (error) {
      const message = errorText(error)
      this.status.lastError = message
      this.status.recentErrors = [message, ...this.status.recentErrors].slice(0, 10)
    } finally {
      const completedAt = this.now()
      this.status = {
        ...this.status,
        running: false,
        lastCompletedAt: completedAt,
        nextRunAt: config.backendMaintenanceEnabled
          ? completedAt + config.backendMaintenanceIntervalMin * 60_000
          : undefined
      }
      await this.persistStatus()
      await this.store.audit(this.userId, 'proxy-maintenance', {
        reason,
        sourceCandidates: this.status.sourceCandidates,
        proxiesChecked: this.status.proxiesChecked,
        proxiesAlive: this.status.proxiesAlive,
        proxiesAdded: this.status.proxiesAdded,
        proxiesRemoved: this.status.proxiesRemoved,
        accountsChecked: this.status.accountsChecked,
        accountsRemoved: this.status.accountsRemoved,
        error: this.status.lastError
      })
    }
    return this.getStatus()
  }

  private getAccountData(): Record<string, unknown> {
    const data = this.store.getAccountData(this.userId)
    return data && typeof data === 'object' ? data as Record<string, unknown> : {}
  }

  private getAccounts(accountData: Record<string, unknown>): Record<string, StoredAccount> {
    return accountData.accounts && typeof accountData.accounts === 'object'
      ? accountData.accounts as Record<string, StoredAccount>
      : {}
  }

  private getProxyPool(accountData: Record<string, unknown>): Record<string, StoredProxy> {
    return accountData.proxyPool && typeof accountData.proxyPool === 'object'
      ? accountData.proxyPool as Record<string, StoredProxy>
      : {}
  }

  private async applyResults(
    config: ProxyMaintenanceConfig,
    proxyOutcomes: ProxyValidationOutcome[],
    accountOutcomes: AccountHealthOutcome[]
  ): Promise<void> {
    const accountData = this.getAccountData()
    const accounts = { ...this.getAccounts(accountData) }
    const proxyPool = { ...this.getProxyPool(accountData) }
    const bindings = accountData.accountProxyBindings && typeof accountData.accountProxyBindings === 'object'
      ? { ...accountData.accountProxyBindings as Record<string, string> }
      : {}
    const deletedAccountIds = new Set(
      Array.isArray(accountData._deletedAccountIds)
        ? accountData._deletedAccountIds.filter((id): id is string => typeof id === 'string')
        : []
    )
    const deletedProxyIds = new Set(
      Array.isArray(accountData._deletedProxyIds)
        ? accountData._deletedProxyIds.filter((id): id is string => typeof id === 'string')
        : []
    )
    const now = this.now()

    if (config.sourceSyncEnabled && proxyOutcomes.length > 0) {
      const reachable = proxyOutcomes.filter(isReachableProxyOutcome)
      const minimumAlive = Math.min(3, proxyOutcomes.length)
      const systemicFailure = reachable.length < minimumAlive && reachable.length / proxyOutcomes.length < 0.01
      if (systemicFailure) {
        const message = `Source validation returned only ${reachable.length}/${proxyOutcomes.length} reachable proxies; previously verified reachable proxies were preserved`
        this.status.recentErrors = [message, ...this.status.recentErrors].slice(0, 10)
      } else {
        const outcomesByUrl = new Map(proxyOutcomes.map((item) => [item.proxy.url, item]))
        const existingByUrl = new Map<string, StoredProxy>()
        for (const entry of Object.values(proxyPool)) {
          if (entry.source === IPLOCATE_PROXY_SOURCE) existingByUrl.set(entry.url, entry)
        }

        for (const [id, entry] of Object.entries(proxyPool)) {
          if (entry.source !== IPLOCATE_PROXY_SOURCE) continue
          const outcome = outcomesByUrl.get(entry.url)
          if (!outcome || !isReachableProxyOutcome(outcome)) {
            if (!config.sourceRemoveDead) {
              if (outcome) proxyPool[id] = updateProxyEntry(entry, outcome, now, config.maxUsableLatencyMs)
              continue
            }
            delete proxyPool[id]
            deletedProxyIds.add(id)
            this.status.proxiesRemoved++
            for (const [accountId, proxyId] of Object.entries(bindings)) {
              if (proxyId === id) delete bindings[accountId]
            }
          } else {
            proxyPool[id] = updateProxyEntry(entry, outcome, now, config.maxUsableLatencyMs)
          }
        }

        for (const outcome of reachable) {
          const existing = existingByUrl.get(outcome.proxy.url)
          if (existing && proxyPool[existing.id]) continue
          const entry = buildProxyEntry(outcome.proxy, outcome, now, config.maxUsableLatencyMs)
          proxyPool[entry.id] = entry
          this.status.proxiesAdded++
        }
      }
    }

    for (const outcome of accountOutcomes) {
      const current = accounts[outcome.id]
      if (!current) continue
      if (outcome.result.success) {
        const newCredentials = outcome.result.data?.newCredentials
        const alreadyBlocked = current.status === 'blocked' ||
          (typeof current.usage?.suspendedAt === 'number' && current.usage.suspendedAt > 0) ||
          Boolean(classifyKiroAccountError(current.lastError).isBanned)
        accounts[outcome.id] = {
          ...current,
          // Credential/quota success does not prove that model access was unblocked.
          status: alreadyBlocked ? 'blocked' : outcome.result.data?.status || 'active',
          lastError: alreadyBlocked ? current.lastError : undefined,
          lastCheckedAt: now,
          maintenanceFailureCount: 0,
          credentials: newCredentials
            ? {
                ...current.credentials,
                accessToken: newCredentials.accessToken || current.credentials?.accessToken,
                refreshToken: newCredentials.refreshToken || current.credentials?.refreshToken,
                expiresAt: newCredentials.expiresAt || current.credentials?.expiresAt
              }
            : current.credentials
        }
        continue
      }

      if (!outcome.terminal) {
        accounts[outcome.id] = {
          ...current,
          lastCheckedAt: now,
          maintenanceFailureCount: 0
        }
        continue
      }

      if (outcome.removeImmediately) {
        accounts[outcome.id] = {
          ...current,
          status: 'blocked',
          lastError: outcome.error || current.lastError || 'Account blocked by Kiro',
          lastCheckedAt: now,
          maintenanceFailureCount: 0,
          usage: {
            ...(current.usage || {}),
            suspendedAt: current.usage?.suspendedAt || now,
            suspendReason: current.usage?.suspendReason || 'TEMPORARILY_SUSPENDED',
            suspendMessage: outcome.error || current.usage?.suspendMessage || 'Account blocked by Kiro'
          }
        }
        if (accountData.activeAccountId === outcome.id) accountData.activeAccountId = null
        continue
      }

      const failureCount = (Number(current.maintenanceFailureCount) || 0) + 1
      const shouldDelete = config.accountDeleteDead &&
        failureCount >= config.accountFailureThreshold
      if (!shouldDelete) {
        accounts[outcome.id] = {
          ...current,
          status: 'error',
          lastError: outcome.error,
          lastCheckedAt: now,
          maintenanceFailureCount: failureCount
        }
        continue
      }

      delete accounts[outcome.id]
      delete bindings[outcome.id]
      deletedAccountIds.add(outcome.id)
      this.status.accountsRemoved++
      if (accountData.activeAccountId === outcome.id) accountData.activeAccountId = null
    }

    accountData.accounts = accounts
    accountData.proxyPool = proxyPool
    accountData.proxyPoolConfig = {
      ...(accountData.proxyPoolConfig && typeof accountData.proxyPoolConfig === 'object'
        ? accountData.proxyPoolConfig as Record<string, unknown>
        : {}),
      ...config,
      maxUsableLatencyMs: config.maxUsableLatencyMs
    }
    accountData.accountProxyBindings = bindings
    accountData._deletedAccountIds = Array.from(deletedAccountIds)
    accountData._deletedProxyIds = Array.from(deletedProxyIds)
    await this.store.setAccountData(this.userId, accountData)
    await this.onDataChanged()
  }
}

const runtimes = new Map<string, ProxyMaintenanceRuntime>()

export function getProxyMaintenanceRuntime(
  store: WebStore,
  userId: string,
  emit: (channel: string, ...args: unknown[]) => void,
  onDataChanged?: () => Promise<void> | void
): ProxyMaintenanceRuntime {
  let runtime = runtimes.get(userId)
  if (!runtime) {
    runtime = new ProxyMaintenanceRuntime(store, userId, emit, { onDataChanged })
    runtimes.set(userId, runtime)
  }
  return runtime
}
