import crypto from 'crypto'
import { ProxyServer } from '../../main/proxy/proxyServer'
import { configureProxyClients, type ProxyClientModel, type ProxyClientTarget } from '../../main/proxy/clientConfig'
import { interceptConsole, proxyLogStore } from '../../main/proxy/logger'
import { getRuntimeUserDataPath } from '../../main/runtimePaths'
import { resolveProfileArn } from '../../main/proxy/kiroApi'
import type { ApiKey, ProxyAccount, ProxyConfig, ProxyStats } from '../../main/proxy/types'
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
    groupId?: string
    profileArn?: string
    machineId?: string
    credentials?: {
      accessToken?: string
      refreshToken?: string
      clientId?: string
      clientSecret?: string
      region?: string
      authMethod?: string
      provider?: string
      expiresAt?: number
      profileArn?: string
    }
  }>
  accountProxyBindings?: Record<string, string>
  proxyPool?: Record<string, { url?: string; enabled?: boolean; status?: string }>
}

function defaultProxyConfig(saved?: Partial<ProxyConfig>): ProxyConfig {
  return normalizeProxyConfig({
    enabled: false,
    port: 5580,
    host: '127.0.0.1',
    enableMultiAccount: true,
    selectedAccountIds: [],
    logRequests: true,
    maxConcurrent: 10,
    maxRetries: 3,
    retryDelayMs: 1000,
    tokenRefreshBeforeExpiry: 300,
    clientDrivenToolExecution: true,
    accountSelectionStrategy: 'smart',
    sessionAffinityEnabled: false,
    ...saved
  })
}

function normalizeProxyConfig(config: ProxyConfig): ProxyConfig {
  const strategy = config.accountSelectionStrategy || 'smart'
  const normalized: ProxyConfig = {
    ...config,
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

function resolveProxyProfileArn(account: StoredAccount): string | undefined {
  const credentials = account.credentials || {}
  return resolveProfileArn({
    profileArn: account.profileArn || credentials.profileArn,
    authMethod: credentials.authMethod as ProxyAccount['authMethod'],
    provider: credentials.provider || account.idp
  })
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

  private wantsRunning(config: ProxyConfig): boolean {
    const lastRunning = this.store.getUserSetting<boolean>(this.userId, 'proxyRunning', false)
    return Boolean(config.autoStart || config.enabled || lastRunning)
  }

  async ensureAutoStarted(reason = 'auto'): Promise<{ success: boolean; port?: number; error?: string }> {
    const server = this.getOrCreateServer()
    if (server.isRunning()) return { success: true, port: server.getConfig().port }
    if (!this.wantsRunning(server.getConfig())) return { success: true }
    if (this.autoStartInFlight) return this.autoStartInFlight

    this.autoStartInFlight = (async () => {
      try {
        console.log(`[ProxyRuntime] Auto-starting proxy for user=${this.userId} (${reason})`)
        await this.syncAccountsFromStoreAsync()
        server.updateConfig({ enabled: true })
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
          machineId: account.machineId
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
      onAccountSuspended: (info) => {
        this.emit('proxy-account-suspended', {
          id: info.accountId,
          email: info.email,
          reason: info.reason,
          message: info.message,
          suspendedAt: Date.now()
        })
      },
      onCreditsUpdate: (totalCredits) => void this.store.setUserSetting(this.userId, 'proxyTotalCredits', totalCredits),
      onTokensUpdate: (inputTokens, outputTokens) => {
        void this.store.setUserSetting(this.userId, 'proxyInputTokens', inputTokens)
        void this.store.setUserSetting(this.userId, 'proxyOutputTokens', outputTokens)
      },
      onRequestStatsUpdate: (totalRequests, successRequests, failedRequests) => {
        void this.store.setUserSetting(this.userId, 'proxyRequestStats', { totalRequests, successRequests, failedRequests })
      },
      onPoolEmpty: async () => {
        await this.syncAccountsFromStoreAsync()
      }
    })
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
    await this.store.setAccountData(this.userId, accountData)
  }

  syncAccountsFromStore(): { success: boolean; accountCount: number } {
    const server = this.getOrCreateServer()
    const pool = server.getAccountPool()
    const accountData = (this.store.getAccountData(this.userId) || {}) as AccountDataShape
    const accounts = Object.values(accountData.accounts || {})
    const bindings = accountData.accountProxyBindings || {}
    const proxyPool = accountData.proxyPool || {}
    const proxyAccounts: ProxyAccount[] = []
    let skippedNoProfileArn = 0

    for (const account of accounts) {
      if (account.status !== 'active' || !account.credentials?.accessToken) continue
      const profileArn = resolveProxyProfileArn(account)
      if (!profileArn) {
        skippedNoProfileArn++
        continue
      }
      const proxyId = bindings[account.id]
      const boundProxy = proxyId ? proxyPool[proxyId] : undefined
      proxyAccounts.push(normalizeProxyAccount({
        id: account.id,
        email: account.email,
        accessToken: account.credentials.accessToken,
        refreshToken: account.credentials.refreshToken,
        profileArn,
        expiresAt: account.credentials.expiresAt,
        clientId: account.credentials.clientId,
        clientSecret: account.credentials.clientSecret,
        region: account.credentials.region || 'us-east-1',
        authMethod: account.credentials.authMethod as ProxyAccount['authMethod'],
        provider: account.credentials.provider || account.idp,
        machineId: account.machineId,
        groupId: account.groupId,
        proxyUrl: boundProxy?.enabled && boundProxy.status !== 'dead' ? boundProxy.url : undefined
      }))
    }
    pool.replaceAccounts(proxyAccounts)
    if (skippedNoProfileArn > 0) {
      console.log(`[ProxyRuntime] Skipped ${skippedNoProfileArn} account(s) without profileArn`)
    }

    return { success: true, accountCount: pool.size }
  }

  async syncAccountsFromStoreAsync(): Promise<{ success: boolean; accountCount: number }> {
    const accountData = (this.store.getAccountData(this.userId) || {}) as AccountDataShape
    const hydrated = await hydrateAccountDataProfileArns(accountData)
    if (hydrated.changed) {
      await this.store.setAccountData(this.userId, hydrated.data)
    }
    return this.syncAccountsFromStore()
  }

  async start(config?: Partial<ProxyConfig>): Promise<{ success: boolean; port?: number; error?: string }> {
    try {
      const server = this.getOrCreateServer()
      if (config) server.updateConfig(config)
      server.updateConfig({ enabled: true })
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
      server.updateConfig({ enabled: false })
      await this.persistConfig()
      await this.store.setUserSetting(this.userId, 'proxyRunning', false)
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
      server.updateConfig(config)
      await this.persistConfig()
      if (!server.isRunning() && (config.autoStart === true || config.enabled === true)) {
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
    this.getOrCreateServer().clearModelCache()
    return { success: true }
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
}

const runtimes = new Map<string, ProxyRuntime>()

export function getProxyRuntime(store: WebStore, userId: string, emit: EmitFn): ProxyRuntime {
  const existing = runtimes.get(userId)
  if (existing) return existing
  const runtime = new ProxyRuntime(store, userId, emit)
  runtimes.set(userId, runtime)
  return runtime
}
