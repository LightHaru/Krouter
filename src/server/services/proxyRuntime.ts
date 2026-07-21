import crypto from 'crypto'
import path from 'path'
import { ProxyServer, type ProxyUsageStatsUpdate } from '../../main/proxy/proxyServer'
import { configureProxyClients, type ProxyClientModel, type ProxyClientTarget } from '../../main/proxy/clientConfig'
import { interceptConsole, proxyLogStore, endpointMetrics } from '../../main/proxy/logger'
import { SkillsManager } from '../../main/proxy/skills'
import { getRuntimeUserDataPath } from '../../main/runtimePaths'
import { resolveProfileArn } from '../../main/proxy/kiroApi'
import { testBedrockCredentials, type BedrockConfig, type BedrockAvailableModel } from '../../main/proxy/bedrock'
import { testXpixiCredentials } from '../../main/proxy/xpixi'
import type { ApiKey, ProxyAccount, ProxyConfig, ProxyStats, ModelProbeResult } from '../../main/proxy/types'
import { refreshTokenByMethod } from './kiroAccounts'
import { hydrateAccountDataProfileArns } from './accountProfileHydration'
import type { WebStore } from '../store'

type EmitFn = (channel: string, ...args: unknown[]) => void
const CLIENT_PROXY_API_KEY_NAME = 'OpenClaw - Krouter API Proxy'

interface AccountDataShape {
  accounts?: Record<string, {
    id: string
    email?: string
    idp?: string
    status?: string
    lastError?: string
    groupId?: string
    profileArn?: string
    machineId?: string
    subscription?: { type?: string; title?: string; rawType?: string }
    usage?: {
      current?: number
      limit?: number
      quotaExhaustedAt?: number
      suspendedAt?: number
      suspendReason?: string
      suspendMessage?: string
      percentUsed?: number
      lastUpdated?: number
      nextResetDate?: string
      baseCurrent?: number
      baseLimit?: number
      freeTrialCurrent?: number
      freeTrialLimit?: number
      bonuses?: Array<{ current?: number; limit?: number; description?: string; expiresAt?: string }>
      resourceDetail?: unknown
    }
    credentials?: {
      accessToken?: string
      refreshToken?: string
      kiroApiKey?: string
      clientId?: string
      clientSecret?: string
      region?: string
      authRegion?: string
      apiRegion?: string
      authMethod?: string
      provider?: string
      expiresAt?: number
      profileArn?: string
    }
  }>
  accountProxyBindings?: Record<string, string>
  proxyPool?: Record<string, { url?: string; enabled?: boolean; status?: string; latencyMs?: number }>
  proxyPoolConfig?: { maxUsableLatencyMs?: number }
}

function isDirectProxyUrl(value: unknown): value is string {
  return typeof value === 'string' && /^(https?|socks4a?|socks5h?):\/\//i.test(value.trim())
}

function defaultProxyConfig(saved?: Partial<ProxyConfig>): ProxyConfig {
  return normalizeProxyConfig({
    enabled: true,
    port: 5580,
    host: '127.0.0.1',
    enableMultiAccount: true,
    selectedAccountIds: [],
    logRequests: true,
    maxConcurrent: 10,
    maxRetries: 3,
    retryDelayMs: 5000,
    tokenRefreshBeforeExpiry: 300,
    autoStart: true,
    clientDrivenToolExecution: true,
    accountSelectionStrategy: 'round-robin',
    sessionAffinityEnabled: false,
    customModels: [],
    ...saved
  })
}

function normalizeProxyConfig(config: ProxyConfig): ProxyConfig {
  const strategy = config.accountSelectionStrategy || 'round-robin'
  const normalized: ProxyConfig = {
    ...config,
    enabled: true,
    autoStart: true,
    accountSelectionStrategy: strategy
  }

  if (normalized.enableMultiAccount && strategy !== 'sticky') {
    normalized.sessionAffinityEnabled = false
  }

  return normalized
}

function serializeStats(stats: ProxyStats): Record<string, unknown> {
  return {
    ...stats,
    accountStats: Object.fromEntries(stats.accountStats),
    endpointStats: Object.fromEntries(stats.endpointStats),
    modelStats: Object.fromEntries(stats.modelStats)
  }
}

function normalizeProxyAccount(account: ProxyAccount): ProxyAccount {
  return {
    ...account,
    authMethod: account.authMethod === 'idc' ? 'IdC' : account.authMethod
  }
}

type StoredAccount = NonNullable<AccountDataShape['accounts']>[string]

function parseQuotaResetAt(value?: string): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function usagePercent(current: number, limit: number): number {
  return limit > 0 ? current / limit : 0
}

function quotaResetDue(nextResetDate: unknown, now = Date.now()): boolean {
  if (typeof nextResetDate !== 'string' || !nextResetDate.trim()) return false
  const parsed = Date.parse(nextResetDate)
  return Number.isFinite(parsed) && parsed <= now
}

function isStoredQuotaExhausted(account: StoredAccount, now = Date.now()): boolean {
  const usage = account.usage || {}
  if (quotaResetDue(usage.nextResetDate, now)) return false
  if (typeof usage.quotaExhaustedAt === 'number' && usage.quotaExhaustedAt > 0) return true
  const current = Number(usage.current)
  const limit = Number(usage.limit)
  return Number.isFinite(current) && Number.isFinite(limit) && limit > 0 && current >= limit
}

function isStoredAccountBlockedError(error?: string): boolean {
  if (!error) return false
  const value = error.toLowerCase()
  return value.includes('temporarily suspended') ||
    value.includes('user id') && value.includes('suspended') ||
    value.includes('account suspended') ||
    value.includes('account blocked') ||
    value.includes('tạm khóa') ||
    value.includes('bị tạm khóa')
}

function normalizeStoredRuntimeState(account: StoredAccount, now = Date.now()): { account: StoredAccount; changed: boolean } {
  const usage = { ...(account.usage || {}) }
  let changed = false
  let status = account.status

  if ((typeof usage.suspendedAt === 'number' && usage.suspendedAt > 0) || isStoredAccountBlockedError(account.lastError)) {
    if (typeof usage.suspendedAt !== 'number' || usage.suspendedAt <= 0) {
      usage.suspendedAt = now
      changed = true
    }
    status = 'blocked'
  } else if (quotaResetDue(usage.nextResetDate, now)) {
    if (usage.quotaExhaustedAt !== undefined || status === 'quota_exhausted') {
      delete usage.quotaExhaustedAt
      status = 'active'
      changed = true
    }
  } else if (isStoredQuotaExhausted({ ...account, usage }, now)) {
    status = 'quota_exhausted'
  } else if (status === 'quota_exhausted') {
    status = 'active'
  }

  if (status !== account.status) changed = true
  const next = changed ? { ...account, status, usage } : account
  return { account: next, changed }
}

function mergeUsageCurrent(existing: StoredAccount, account: ProxyAccount, nextResetDate?: string): number {
  const existingCurrent = typeof existing.usage?.current === 'number' ? existing.usage.current : 0
  const incomingCurrent = typeof account.quotaUsed === 'number' ? account.quotaUsed : existingCurrent
  const delta = typeof account.quotaUsedDelta === 'number' && account.quotaUsedDelta > 0 ? account.quotaUsedDelta : 0
  const existingReset = existing.usage?.nextResetDate

  if (existingReset && nextResetDate) {
    const existingResetTime = Date.parse(existingReset)
    const incomingResetTime = Date.parse(nextResetDate)
    if (Number.isFinite(existingResetTime) && Number.isFinite(incomingResetTime)) {
      if (incomingResetTime > existingResetTime) return incomingCurrent
      if (existingResetTime > incomingResetTime) return existingCurrent + delta
    }
  }

  if (delta > 0 && existingCurrent > incomingCurrent) {
    return existingCurrent + delta
  }
  return Math.max(existingCurrent, incomingCurrent)
}

function resolveProxyProfileArn(account: StoredAccount): string | undefined {
  const credentials = account.credentials || {}
  return resolveProfileArn({
    profileArn: account.profileArn || credentials.profileArn,
    authMethod: credentials.authMethod as ProxyAccount['authMethod'],
    provider: credentials.provider || account.idp,
    kiroApiKey: credentials.kiroApiKey || (credentials.accessToken?.trim().startsWith('ksk_') ? credentials.accessToken : undefined),
    accessToken: credentials.accessToken
  })
}

function isApiKeyStoredAccount(account: StoredAccount): boolean {
  const credentials = account.credentials || {}
  const authMethod = String(credentials.authMethod || '').trim().toLowerCase()
  const provider = String(credentials.provider || account.idp || '').trim().toLowerCase().replace(/[\s_-]/g, '')
  return Boolean(credentials.kiroApiKey) || Boolean(credentials.accessToken?.trim().startsWith('ksk_')) || authMethod === 'api_key' || authMethod === 'apikey' || provider === 'kiroapikey' || provider === 'apikey'
}

function newApiKey(input: { name?: string; key?: string; format?: 'sk' | 'simple' | 'token'; creditsLimit?: number }): ApiKey {
  return {
    id: crypto.randomUUID(),
    name: input.name || 'API Key',
    key: input.key || `sk-${crypto.randomBytes(24).toString('base64url')}`,
    format: input.format || 'sk',
    enabled: true,
    createdAt: Date.now(),
    creditsLimit: input.creditsLimit,
    usage: {
      totalRequests: 0,
      totalCredits: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      daily: {}
    }
  }
}

function detectApiKeyFormat(key: string): 'sk' | 'simple' | 'token' {
  if (key.includes(':')) return 'token'
  if (key.startsWith('sk-')) return 'sk'
  return 'simple'
}

export class ProxyRuntime {
  private server: ProxyServer | null = null
  private autoStartInFlight: Promise<{ success: boolean; port?: number; error?: string }> | null = null
  private pendingAccountPersist: Promise<void> | null = null

  constructor(
    private readonly store: WebStore,
    private readonly userId: string,
    private readonly emit: EmitFn
  ) {
    proxyLogStore.initialize(getRuntimeUserDataPath())
    interceptConsole()
  }

  private get savedConfig(): ProxyConfig {
    return defaultProxyConfig(this.store.getUserSetting<Partial<ProxyConfig>>(this.userId, 'proxyConfig', {}))
  }

  private async persistConfig(): Promise<void> {
    if (this.server) {
      await this.store.setUserSetting(this.userId, 'proxyConfig', this.server.getConfig())
    }
  }

  private restorePersistedStats(server: ProxyServer): void {
    const savedCredits = this.store.getUserSetting<number>(this.userId, 'proxyTotalCredits', 0) || 0
    const savedUsage = this.store.getUserSetting<Partial<ProxyUsageStatsUpdate>>(this.userId, 'proxyUsageStats', {}) || {}
    const inputTokens = savedUsage.inputTokens ?? this.store.getUserSetting<number>(this.userId, 'proxyInputTokens', 0) ?? 0
    const outputTokens = savedUsage.outputTokens ?? this.store.getUserSetting<number>(this.userId, 'proxyOutputTokens', 0) ?? 0
    const requestStats = this.store.getUserSetting<{ totalRequests?: number; successRequests?: number; failedRequests?: number }>(
      this.userId,
      'proxyRequestStats',
      {}
    ) || {}

    server.setTotalCredits(savedCredits)
    server.setUsageStats({
      totalTokens: savedUsage.totalTokens ?? inputTokens + outputTokens,
      inputTokens,
      outputTokens,
      cacheReadTokens: savedUsage.cacheReadTokens ?? 0,
      cacheWriteTokens: savedUsage.cacheWriteTokens ?? 0,
      reasoningTokens: savedUsage.reasoningTokens ?? 0
    })
    server.setRequestStats(
      requestStats.totalRequests || 0,
      requestStats.successRequests || 0,
      requestStats.failedRequests || 0
    )

    const savedProbes = this.store.getUserSetting<ModelProbeResult[]>(this.userId, 'modelProbeResults', []) || []
    if (Array.isArray(savedProbes) && savedProbes.length > 0) {
      server.loadModelProbeResults(savedProbes)
    }
  }

  async ensureAutoStarted(reason = 'auto'): Promise<{ success: boolean; port?: number; error?: string }> {
    const server = this.getOrCreateServer()
    if (server.isRunning()) return { success: true, port: server.getConfig().port }
    if (this.autoStartInFlight) return this.autoStartInFlight

    this.autoStartInFlight = (async () => {
      try {
        console.log(`[ProxyRuntime] Auto-starting proxy for user=${this.userId} (${reason})`)
        await this.syncAccountsFromStoreAsync()
        server.updateConfig({ enabled: true, autoStart: true })
        await server.start()
        await this.persistConfig()
        await this.store.setUserSetting(this.userId, 'proxyRunning', true)
        return { success: true, port: server.getConfig().port }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to auto-start proxy server'
        console.error('[ProxyRuntime] Auto-start failed:', message)
        return { success: false, error: message }
      } finally {
        this.autoStartInFlight = null
      }
    })()

    return this.autoStartInFlight
  }

  private getOrCreateServer(): ProxyServer {
    if (this.server) return this.server

    this.server = new ProxyServer(this.savedConfig, {
      onRequest: (info) => this.emit('proxy-request', info),
      onResponse: (info) => this.emit('proxy-response', info),
      onError: (error) => this.emit('proxy-error', error.message),
      onStatusChange: (running, port) => this.emit('proxy-status-change', { running, port }),
      onTokenRefresh: async (account) => {
        const result = await refreshTokenByMethod({
          refreshToken: account.refreshToken || '',
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          region: account.region || 'us-east-1',
          authMethod: account.authMethod,
          machineId: account.machineId,
          proxyUrl: account.proxyUrl
        })
        return {
          success: result.success,
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: Date.now() + (result.expiresIn || 3600) * 1000,
          error: result.error
        }
      },
      onAccountUpdate: (account) => {
        this.emit('proxy-account-update', account)
        void this.updatePersistedAccountCredentials(account)
      },
      onAccountSuspended: async (info) => {
        this.emit('proxy-account-suspended', {
          id: info.accountId,
          email: info.email,
          reason: info.reason,
          message: info.message,
          suspendedAt: Date.now()
        })
        // Persist suspended state to backend store
        const accountData = (this.store.getAccountData(this.userId) || {}) as AccountDataShape
        const existing = accountData.accounts?.[info.accountId]
        if (existing) {
          existing.status = 'blocked'
          existing.lastError = `[${info.reason}] ${info.message}`
          existing.usage = existing.usage || {}
          existing.usage.suspendedAt = Date.now()
          existing.usage.suspendReason = info.reason
          existing.usage.suspendMessage = info.message
          await this.store.setAccountData(this.userId, accountData)
        }
      },
      onAccountQuotaExhausted: async (info) => {
        this.emit('proxy-account-quota-exhausted', {
          id: info.accountId,
          email: info.email,
          resetAt: info.resetAt,
          message: info.message
        })
        const accountData = (this.store.getAccountData(this.userId) || {}) as AccountDataShape
        const existing = accountData.accounts?.[info.accountId]
        if (existing) {
          existing.status = 'quota_exhausted'
          existing.lastError = 'Quota exhausted until reset'
          existing.usage = {
            ...(existing.usage || {}),
            quotaExhaustedAt: Date.now(),
            nextResetDate: typeof info.resetAt === 'number'
              ? new Date(info.resetAt).toISOString().slice(0, 10)
              : existing.usage?.nextResetDate
          }
          await this.store.setAccountData(this.userId, accountData)
        }
      },
      onCreditsUpdate: (totalCredits) => void this.store.setUserSetting(this.userId, 'proxyTotalCredits', totalCredits),
      onTokensUpdate: (inputTokens, outputTokens) => {
        void this.store.setUserSetting(this.userId, 'proxyInputTokens', inputTokens)
        void this.store.setUserSetting(this.userId, 'proxyOutputTokens', outputTokens)
      },
      onUsageStatsUpdate: (usage) => {
        void this.store.setUserSetting(this.userId, 'proxyUsageStats', usage)
        void this.store.setUserSetting(this.userId, 'proxyInputTokens', usage.inputTokens)
        void this.store.setUserSetting(this.userId, 'proxyOutputTokens', usage.outputTokens)
      },
      onRequestStatsUpdate: (totalRequests, successRequests, failedRequests) => {
        void this.store.setUserSetting(this.userId, 'proxyRequestStats', { totalRequests, successRequests, failedRequests })
      },
      onPoolEmpty: async () => {
        await this.syncAccountsFromStoreAsync()
      }
    })
    this.restorePersistedStats(this.server)
    return this.server
  }

  private async updatePersistedAccountCredentials(account: ProxyAccount): Promise<void> {
    const accountData = (this.store.getAccountData(this.userId) || {}) as AccountDataShape
    const existing = accountData.accounts?.[account.id]
    if (!existing) return
    existing.profileArn = account.profileArn || existing.profileArn
    existing.credentials = {
      ...(existing.credentials || {}),
      accessToken: account.accessToken,
      refreshToken: account.refreshToken || existing.credentials?.refreshToken,
      expiresAt: account.expiresAt
    }
    const limit = typeof account.quotaLimit === 'number' ? account.quotaLimit : existing.usage?.limit ?? 0
    const nextResetDate = typeof account.quotaResetAt === 'number'
      ? new Date(account.quotaResetAt).toISOString().slice(0, 10)
      : existing.usage?.nextResetDate
    const current = mergeUsageCurrent(existing, account, nextResetDate)
    existing.usage = {
      ...(existing.usage || {}),
      current,
      limit,
      percentUsed: usagePercent(current, limit),
      lastUpdated: Date.now(),
      nextResetDate,
      quotaExhaustedAt: account.quotaExhaustedAt || existing.usage?.quotaExhaustedAt,
      suspendedAt: account.suspendedAt || existing.usage?.suspendedAt,
      suspendReason: account.suspendReason || existing.usage?.suspendReason,
      suspendMessage: account.suspendMessage || existing.usage?.suspendMessage
    }
    const normalized = normalizeStoredRuntimeState(existing, Date.now()).account
    existing.status = normalized.status
    existing.usage = normalized.usage
    if (existing.status === 'quota_exhausted') {
      existing.lastError = existing.lastError || 'Quota exhausted until reset'
    } else if (existing.lastError === 'Quota exhausted until reset') {
      existing.lastError = undefined
    }
    await this.store.setAccountData(this.userId, accountData)
  }

  syncAccountsFromStore(): { success: boolean; accountCount: number } {
    const server = this.getOrCreateServer()
    const pool = server.getAccountPool()
    const accountData = (this.store.getAccountData(this.userId) || {}) as AccountDataShape
    const accountMap = accountData.accounts || {}
    const accountEntries = Object.entries(accountMap)
    const bindings = accountData.accountProxyBindings || {}
    const proxyPool = accountData.proxyPool || {}
    const maxUsableLatencyMs = Math.max(100, Number(accountData.proxyPoolConfig?.maxUsableLatencyMs) || 1000)
    const proxyAccounts: ProxyAccount[] = []
    let skippedNoProfileArn = 0
    let lifecycleChanged = false

    for (const [accountId, rawAccount] of accountEntries) {
      const normalized = normalizeStoredRuntimeState({ ...rawAccount, id: rawAccount.id || accountId })
      const account = normalized.account
      if (normalized.changed) {
        accountMap[accountId] = account
        lifecycleChanged = true
      }
      if (account.status !== 'active' || !account.credentials?.accessToken) continue
      const profileArn = resolveProxyProfileArn(account)
      if (!profileArn && !isApiKeyStoredAccount(account)) {
        skippedNoProfileArn++
        continue
      }
      const proxyBinding = bindings[account.id]
      const boundProxy = proxyBinding
        ? (proxyPool[proxyBinding] || Object.values(proxyPool).find((proxy) => proxy.url === proxyBinding))
        : undefined
      const directProxyUrl = !boundProxy && isDirectProxyUrl(proxyBinding) ? proxyBinding.trim() : undefined
      const usableBoundProxy = boundProxy?.enabled === true &&
        boundProxy.status === 'alive' &&
        typeof boundProxy.latencyMs === 'number' &&
        Number.isFinite(boundProxy.latencyMs) &&
        boundProxy.latencyMs <= maxUsableLatencyMs
      proxyAccounts.push(normalizeProxyAccount({
          id: account.id,
          email: account.email,
          accessToken: account.credentials.accessToken,
          kiroApiKey: account.credentials.kiroApiKey || (account.credentials.accessToken.trim().startsWith('ksk_') ? account.credentials.accessToken : undefined),
          refreshToken: account.credentials.refreshToken,
        profileArn,
        expiresAt: account.credentials.expiresAt,
        clientId: account.credentials.clientId,
        clientSecret: account.credentials.clientSecret,
        region: account.credentials.apiRegion || account.credentials.region || 'us-east-1',
        authMethod: account.credentials.authMethod as ProxyAccount['authMethod'],
        provider: account.credentials.provider || account.idp,
        subscriptionType: account.subscription?.type,
        machineId: account.machineId,
        groupId: account.groupId,
        quotaUsed: typeof account.usage?.current === 'number' ? account.usage.current : undefined,
        quotaLimit: typeof account.usage?.limit === 'number' ? account.usage.limit : undefined,
        quotaResetAt: parseQuotaResetAt(account.usage?.nextResetDate),
        quotaExhaustedAt: account.usage?.quotaExhaustedAt,
        suspendedAt: account.usage?.suspendedAt,
        suspendReason: account.usage?.suspendReason,
        suspendMessage: account.usage?.suspendMessage,
        proxyUrl: usableBoundProxy ? boundProxy.url : directProxyUrl
      }))
    }
    pool.replaceAccounts(proxyAccounts)
    if (skippedNoProfileArn > 0) {
      console.log(`[ProxyRuntime] Skipped ${skippedNoProfileArn} account(s) without profileArn`)
    }
    if (lifecycleChanged) {
      accountData.accounts = accountMap
      this.pendingAccountPersist = this.store.setAccountData(this.userId, accountData)
        .finally(() => {
          this.pendingAccountPersist = null
        })
    }

    return { success: true, accountCount: pool.size }
  }

  async syncAccountsFromStoreAsync(): Promise<{ success: boolean; accountCount: number }> {
    const accountData = (this.store.getAccountData(this.userId) || {}) as AccountDataShape
    const hydrated = await hydrateAccountDataProfileArns(accountData)
    if (hydrated.changed) {
      await this.store.setAccountData(this.userId, hydrated.data)
    }
    const result = this.syncAccountsFromStore()
    if (this.pendingAccountPersist) await this.pendingAccountPersist
    return result
  }

  async start(config?: Partial<ProxyConfig>): Promise<{ success: boolean; port?: number; error?: string }> {
    try {
      const server = this.getOrCreateServer()
      if (config) server.updateConfig(config)
      server.updateConfig({ enabled: true, autoStart: true })
      await this.syncAccountsFromStoreAsync()
      await server.start()
      await this.persistConfig()
      await this.store.setUserSetting(this.userId, 'proxyRunning', true)
      return { success: true, port: server.getConfig().port }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start proxy server' }
    }
  }

  async stop(): Promise<{ success: boolean; error?: string }> {
    try {
      const server = this.getOrCreateServer()
      if (server.isRunning()) await server.stop()
      server.updateConfig({ enabled: true, autoStart: true })
      await this.persistConfig()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to stop proxy server' }
    }
  }

  async getStatus(): Promise<{ running: boolean; config: ProxyConfig; stats: unknown; sessionStats: unknown }> {
    await this.ensureAutoStarted('status')
    const server = this.getOrCreateServer()
    return {
      running: server.isRunning(),
      config: server.getConfig(),
      stats: serializeStats(server.getStats()),
      sessionStats: server.getSessionStats()
    }
  }

  async updateConfig(config: Partial<ProxyConfig>): Promise<{ success: boolean; config?: ProxyConfig; error?: string }> {
    try {
      const server = this.getOrCreateServer()
      server.updateConfig({ ...config, enabled: true, autoStart: true })
      await this.persistConfig()
      if (server.needsRestart()) {
        await this.syncAccountsFromStoreAsync()
        await server.restartServer()
        await this.persistConfig()
      }
      if (!server.isRunning()) {
        const started = await this.ensureAutoStarted('config-update')
        if (!started.success) {
          return { success: false, config: server.getConfig(), error: started.error }
        }
      }
      return { success: true, config: server.getConfig() }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to update proxy config' }
    }
  }

  needsRestart(): { needsRestart: boolean } {
    return { needsRestart: this.server?.needsRestart() || false }
  }

  async restart(): Promise<{ success: boolean; error?: string }> {
    try {
      const server = this.getOrCreateServer()
      await this.syncAccountsFromStoreAsync()
      await server.restartServer()
      await this.persistConfig()
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to restart proxy server' }
    }
  }

  addAccount(account: ProxyAccount): { success: boolean; accountCount?: number; error?: string } {
    try {
      const pool = this.getOrCreateServer().getAccountPool()
      pool.addAccount(normalizeProxyAccount(account))
      return { success: true, accountCount: pool.size }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to add account' }
    }
  }

  removeAccount(accountId: string): { success: boolean; accountCount?: number; error?: string } {
    try {
      const pool = this.getOrCreateServer().getAccountPool()
      pool.removeAccount(accountId)
      return { success: true, accountCount: pool.size }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to remove account' }
    }
  }

  syncAccounts(accounts: ProxyAccount[]): { success: boolean; accountCount?: number; error?: string } {
    try {
      const pool = this.getOrCreateServer().getAccountPool()
      pool.replaceAccounts(accounts.map(normalizeProxyAccount))
      return { success: true, accountCount: pool.size }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to sync accounts' }
    }
  }

  getAccounts(): { accounts: ProxyAccount[]; availableCount: number } {
    const pool = this.getOrCreateServer().getAccountPool()
    return { accounts: pool.getAllAccounts(), availableCount: pool.availableCount }
  }

  resetPool(): { success: boolean; error?: string } {
    this.getOrCreateServer().getAccountPool().reset()
    return { success: true }
  }

  clearAccountSuspended(accountId: string): { success: boolean; error?: string } {
    this.getOrCreateServer().getAccountPool().clearSuspended(accountId)
    return { success: true }
  }

  async getModels(): Promise<{ success: boolean; models: unknown[]; fromCache?: boolean; error?: string }> {
    try {
      const result = await this.getOrCreateServer().getAvailableModels()
      return { success: true, ...result }
    } catch (error) {
      return { success: false, models: [], error: error instanceof Error ? error.message : 'Failed to get models' }
    }
  }

  refreshModels(): { success: boolean; error?: string } {
    const server = this.getOrCreateServer()
    server.clearModelCache()
    // Arm a full-pool capability scan so the next getModels() probes every account
    // and the model list reflects the whole pool's tier coverage (e.g. Opus shows
    // up when any Pro account has it), not just one arbitrarily-picked account.
    server.requestPoolCapabilityScan()
    return { success: true }
  }

  /**
   * "Test thật": live-probe từng model trên 1 account đại diện mỗi tier. Phát tiến độ
   * qua SSE (model-probe-progress) và persist kết quả vào store để lần sau không probe lại.
   */
  async probeModels(input?: { modelIds?: string[]; concurrency?: number }): Promise<{
    success: boolean
    results?: unknown[]
    error?: string
  }> {
    try {
      const server = this.getOrCreateServer()
      const results = await server.probeModels({
        modelIds: input?.modelIds,
        concurrency: input?.concurrency,
        onProgress: (done, total, last) => this.emit('model-probe-progress', { done, total, last })
      })
      await this.store.setUserSetting(this.userId, 'modelProbeResults', results)
      this.emit('model-probe-complete', { total: results.length })
      return { success: true, results }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to probe models' }
    }
  }

  getModelProbeResults(): { success: boolean; results: unknown[] } {
    return { success: true, results: this.getOrCreateServer().getModelProbeResults() }
  }

  /**
   * Verify Bedrock (AWS IAM) credentials and return the models the identity can
   * actually invoke. Does NOT persist anything; the UI decides whether to save.
   */
  getBedrockStatus(): { configured: boolean; error?: string; lastChecked?: number } {
    const server = this.getOrCreateServer()
    const cfg = (server as any).config?.bedrock
    if (!cfg?.enabled) return { configured: false }
    const lastError = (server as any).bedrockLastError as { message: string; timestamp: number } | null | undefined
    if (lastError) {
      return { configured: true, error: lastError.message, lastChecked: lastError.timestamp }
    }
    return { configured: true }
  }

  async testBedrock(input: { accessKeyId?: string; secretAccessKey?: string; sessionToken?: string; region?: string }): Promise<{ success: boolean; region?: string; models?: BedrockAvailableModel[]; error?: string }> {
    const cfg: BedrockConfig = {
      enabled: true,
      accessKeyId: (input.accessKeyId || '').trim(),
      secretAccessKey: (input.secretAccessKey || '').trim(),
      sessionToken: input.sessionToken?.trim() || undefined,
      region: (input.region || 'us-east-1').trim()
    }
    const result = await testBedrockCredentials(cfg)
    if (!result.ok) return { success: false, region: result.region, error: result.error }
    return { success: true, region: result.region, models: result.models }
  }

  /**
   * Verify an Xpixi API key by listing models. Does NOT persist anything;
   * the UI decides whether to save the provider afterwards.
   */
  async testXpixi(input: { apiKey?: string; baseUrl?: string }): Promise<{ success: boolean; error?: string; models?: Array<{ id: string }> }> {
    return testXpixiCredentials({
      apiKey: input?.apiKey?.trim(),
      baseUrl: input?.baseUrl?.trim()
    })
  }


  selfSignedCertInfo(): unknown {
    const cert = this.getOrCreateServer().getSelfSignedCertInfo()
    return cert ? { success: true, ...cert } : { success: false, error: 'Failed to generate certificate' }
  }

  selfSignedCertRegenerate(): unknown {
    const cert = this.getOrCreateServer().regenerateSelfSignedCert()
    return cert ? { success: true, ...cert } : { success: false, error: 'Failed to regenerate certificate' }
  }

  getLogs(count?: number): unknown[] {
    return count ? proxyLogStore.getLast(count) : proxyLogStore.getAll()
  }

  clearLogs(): { success: boolean } {
    proxyLogStore.clear()
    return { success: true }
  }

  getLogsCount(): number {
    return proxyLogStore.count()
  }

  resetCredits(): { success: boolean } {
    this.getOrCreateServer().resetTotalCredits()
    return { success: true }
  }

  resetTokens(): { success: boolean } {
    this.getOrCreateServer().resetTotalTokens()
    void this.store.setUserSetting(this.userId, 'proxyUsageStats', {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0
    })
    return { success: true }
  }

  resetRequestStats(): { success: boolean } {
    this.getOrCreateServer().resetRequestStats()
    return { success: true }
  }

  getApiKeys(): { success: boolean; apiKeys: ApiKey[]; error?: string } {
    return { success: true, apiKeys: this.getOrCreateServer().getConfig().apiKeys || [] }
  }

  private async getOrCreateClientApiKey(): Promise<ApiKey> {
    const server = this.getOrCreateServer()
    const config = server.getConfig()
    const apiKeys = [...(config.apiKeys || [])]
    let apiKey = apiKeys.find((item) => item.name === CLIENT_PROXY_API_KEY_NAME)
    let changed = false

    if (!apiKey) {
      const legacyKey = (config.apiKey || '').trim()
      apiKey = newApiKey({
        name: CLIENT_PROXY_API_KEY_NAME,
        key: legacyKey || undefined,
        format: legacyKey ? detectApiKeyFormat(legacyKey) : 'sk'
      })
      apiKeys.unshift(apiKey)
      changed = true
    }

    if (!apiKey.enabled) {
      apiKey.enabled = true
      changed = true
    }

    if (changed) {
      server.updateConfig({ apiKeys })
      await this.persistConfig()
    }

    return apiKey
  }

  async addApiKey(input: { name?: string; key?: string; format?: 'sk' | 'simple' | 'token'; creditsLimit?: number }): Promise<{ success: boolean; apiKey?: ApiKey; error?: string }> {
    const server = this.getOrCreateServer()
    const apiKeys = [...(server.getConfig().apiKeys || []), newApiKey(input || {})]
    server.updateConfig({ apiKeys })
    await this.persistConfig()
    return { success: true, apiKey: apiKeys[apiKeys.length - 1] }
  }

  async updateApiKey(id: string, updates: Partial<ApiKey> & { creditsLimit?: number | null }): Promise<{ success: boolean; apiKey?: ApiKey; error?: string }> {
    const server = this.getOrCreateServer()
    const apiKeys = [...(server.getConfig().apiKeys || [])]
    const apiKey = apiKeys.find((item) => item.id === id)
    if (!apiKey) return { success: false, error: 'API key not found' }
    Object.assign(apiKey, updates)
    if (updates.creditsLimit === null) delete apiKey.creditsLimit
    server.updateConfig({ apiKeys })
    await this.persistConfig()
    return { success: true, apiKey }
  }

  async deleteApiKey(id: string): Promise<{ success: boolean; error?: string }> {
    const server = this.getOrCreateServer()
    const apiKeys = (server.getConfig().apiKeys || []).filter((item) => item.id !== id)
    server.updateConfig({ apiKeys })
    await this.persistConfig()
    return { success: true }
  }

  async resetApiKeyUsage(id: string): Promise<{ success: boolean; error?: string }> {
    const server = this.getOrCreateServer()
    const apiKeys = [...(server.getConfig().apiKeys || [])]
    const apiKey = apiKeys.find((item) => item.id === id)
    if (!apiKey) return { success: false, error: 'API key not found' }
    apiKey.usage = { totalRequests: 0, totalCredits: 0, totalInputTokens: 0, totalOutputTokens: 0, daily: {} }
    apiKey.usageHistory = []
    server.updateConfig({ apiKeys })
    await this.persistConfig()
    return { success: true }
  }

  auditLog(): { entries: unknown[] } {
    return { entries: [...this.getOrCreateServer().getAuditLog()] }
  }

  async configureClients(input: {
    clients: ProxyClientTarget[]
    modelId: string
    modelName?: string
    models?: ProxyClientModel[]
  }): Promise<unknown> {
    const config = this.getOrCreateServer().getConfig()
    const apiKey = await this.getOrCreateClientApiKey()
    const result = await configureProxyClients({
      clients: input.clients,
      host: config.host,
      port: config.port,
      tlsEnabled: config.tls?.enabled,
      apiKey: apiKey.key,
      modelId: input.modelId,
      modelName: input.modelName,
      models: input.models
    })
    return {
      ...result,
      apiKey: {
        id: apiKey.id,
        name: apiKey.name,
        key: apiKey.key
      }
    }
  }

  // Phase 13: Skills
  fetchSkillsList(): { skills: unknown[] } {
    const builtinDir = path.join(__dirname, '../../../docs/skills')
    const customDir = path.join(getRuntimeUserDataPath(), 'skills')
    const mgr = new SkillsManager(builtinDir, customDir)
    const server = this.getOrCreateServer()
    const config = server.getConfig()
    const protocol = config.tls?.enabled ? 'https' : 'http'
    const baseUrl = `${protocol}://${config.host || '127.0.0.1'}:${config.port}`
    return { skills: mgr.listSkills(baseUrl) }
  }

  fetchSkillContent(id: string): { id: string; content: string | null } {
    const builtinDir = path.join(__dirname, '../../../docs/skills')
    const customDir = path.join(getRuntimeUserDataPath(), 'skills')
    const mgr = new SkillsManager(builtinDir, customDir)
    return { id, content: mgr.getSkillContent(id) }
  }

  // Phase 8: Account health
  getAccountHealth(): { accounts: unknown[] } {
    const server = this.getOrCreateServer()
    const pool = (server as any).accountPool
    if (!pool) return { accounts: [] }
    const accounts = pool.getAllAccounts()
    return {
      accounts: accounts.map((a: any) => ({
        id: a.id,
        email: a.email,
        tier: a.subscriptionType,
        isAvailable: a.isAvailable !== false,
        health: pool.getAccountHealth(a.id),
        lastUsed: a.lastUsed,
        requestCount: a.requestCount || 0,
        quotaUsed: a.quotaUsed || 0,
        quotaLimit: a.quotaLimit
      }))
    }
  }

  // Phase 9: Quota predictions
  getQuotaPredictions(): { predictions: unknown[]; status: unknown } {
    const server = this.getOrCreateServer()
    const pool = (server as any).accountPool
    if (!pool) return { predictions: [], status: { total: 0, available: 0, exhausted: 0, cooldown: 0 } }
    return {
      predictions: pool.getQuotaPredictions(),
      status: pool.getQuotaStatus()
    }
  }

  // Phase 7/10: Endpoint metrics
  getEndpointMetrics(): { endpoints: unknown[] } {
    return { endpoints: endpointMetrics.getAll() }
  }

  resetEndpointMetrics(): { success: boolean } {
    endpointMetrics.reset()
    return { success: true }
  }
}

const runtimes = new Map<string, ProxyRuntime>()

export function getProxyRuntime(store: WebStore, userId: string, emit: EmitFn): ProxyRuntime {
  const existing = runtimes.get(userId)
  if (existing) return existing
  const runtime = new ProxyRuntime(store, userId, emit)
  runtimes.set(userId, runtime)
  return runtime
}
