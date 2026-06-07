import http, { IncomingMessage, ServerResponse } from 'http'
import { execFile, spawn } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { WebStore, verifyPassword, type UserRecord } from './store'
import {
  type AccountLike,
  checkAccountStatus,
  refreshAccountToken,
  verifyAccountCredentials
} from './services/kiroAccounts'
import { hydrateAccountDataProfileArns } from './services/accountProfileHydration'
import {
  getLocalActiveAccount,
  loadKiroCredentials,
  logoutAccount,
  switchAccount,
  switchAccountCli
} from './services/localKiroCredentials'
import {
  machineIdBackupToFile,
  machineIdCheckAdmin,
  machineIdGenerateRandom,
  machineIdGetCurrent,
  machineIdGetOSType,
  machineIdRestoreFromFile,
  machineIdSet
} from './services/machineIdRuntime'
import {
  createDefaultRules,
  deleteMcpServer,
  deleteSteeringFile,
  ensureKiroSettingsFile,
  ensureMcpConfig,
  ensureSteeringFolder,
  getKiroSettings,
  readSteeringFile,
  saveKiroSettings,
  saveMcpServer,
  saveSteeringFile
} from './services/kiroSettings'
import { getProxyRuntime } from './services/proxyRuntime'
import { getKProxyRuntime } from './services/kproxyRuntime'
import {
  diagnoseAccountLiveness,
  networkRouteValidate,
  proxyPoolDiagnoseChain,
  proxyPoolValidate
} from './services/diagnostics'
import {
  accountGetModels,
  accountGetSubscriptionUrl,
  accountGetSubscriptions,
  accountSetOverage
} from './services/accountExtras'
import {
  cancelBuilderIdLogin,
  cancelIamSsoLogin,
  cancelSocialLogin,
  completeIamSsoLogin,
  exchangeSocialToken,
  handleIamSsoCallback,
  handleSocialCallback,
  importFromSsoToken,
  pollBuilderIdAuth,
  pollIamSsoAuth,
  sendAuthHtml,
  startBuilderIdLogin,
  startIamSsoLogin,
  startSocialLogin
} from './services/authFlows'
import {
  protonClose,
  protonLoginStatus,
  protonOpenLogin,
  registrationCancel,
  registrationManualPhase1,
  registrationManualPhase2,
  registrationManualPhase3,
  registrationStartAuto,
  registrationStatus
} from './services/registrationRuntime'
import {
  captureProtonScreenshot,
  clickProtonPage,
  navigateProton,
  pressProtonKey,
  scrollProtonPage,
  typeProtonText
} from './services/protonBrowserRuntime'
import { getDashboardTunnelRuntime } from './services/dashboardTunnel'

type JsonValue = unknown
type SseClient = ServerResponse

const store = new WebStore()
const sseClients = new Set<SseClient>()
const dashboardTunnelRuntime = getDashboardTunnelRuntime()
const SESSION_COOKIE_NAME = 'krouter_session'
const LEGACY_SESSION_COOKIE_NAME = 'kam_session'
const TOKEN_REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000
const BACKEND_AUTO_REFRESH_MIN_INTERVAL_MS = 60 * 1000
const backendAutoRefreshTimers = new Map<string, ReturnType<typeof setInterval>>()
const backendAutoRefreshRunning = new Set<string>()
const KROUTER_NPM_PACKAGE = '@lightharu/krouter'
const KROUTER_NPM_LATEST_URL = 'https://registry.npmjs.org/@lightharu%2Fkrouter/latest'
const KROUTER_NPM_PACKAGE_URL = 'https://registry.npmjs.org/@lightharu%2Fkrouter'
let krouterUpdatePromise: Promise<Record<string, unknown>> | null = null

function envFlag(name: string): boolean | undefined {
  const raw = process.env[name]
  if (raw === undefined) return undefined
  if (/^(1|true|yes|on)$/i.test(raw)) return true
  if (/^(0|false|no|off)$/i.test(raw)) return false
  return undefined
}

function shouldServeStatic(): boolean {
  if (process.argv.includes('--api-only') || process.argv.includes('--backend-only')) return false
  if (process.argv.includes('--serve-static')) return true
  const mode = (process.env.KROUTER_SERVER_MODE || process.env.KAM_SERVER_MODE || process.env.SERVER_MODE || '').trim().toLowerCase()
  if (mode === 'api' || mode === 'backend' || mode === 'cli') return false
  if (mode === 'fullstack' || mode === 'web') return true
  return envFlag('SERVE_STATIC') ?? true
}

function shouldAutoStartDashboardTunnel(): boolean {
  return Boolean(
    envFlag('KROUTER_DASHBOARD_TUNNEL_AUTOSTART') ??
      envFlag('KAM_DASHBOARD_TUNNEL_AUTOSTART') ??
      envFlag('DASHBOARD_TUNNEL_AUTOSTART') ??
      false
  )
}

const serveStaticAssets = shouldServeStatic()

function packageVersion(): string {
  try {
    const raw = require('fs').readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
    return JSON.parse(raw).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function sendJson(response: ServerResponse, status: number, data: JsonValue): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  response.end(JSON.stringify(data))
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  response.end(html)
}

function parseCookies(request: IncomingMessage): Record<string, string> {
  const header = request.headers.cookie || ''
  return Object.fromEntries(
    header
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=')
        if (index === -1) return [part, '']
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))]
      })
  )
}

function sessionCookie(sessionId: string, expiresAt: number): string {
  const secure = process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Expires=${new Date(expiresAt).toUTCString()}`,
    secure
  ].join('; ')
}

function clearCookie(name: string): string {
  return `${name}=; HttpOnly; SameSite=Lax; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
}

async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  if (chunks.length === 0) return null
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function getUser(request: IncomingMessage): UserRecord | undefined {
  const cookies = parseCookies(request)
  return store.findUserBySession(cookies[SESSION_COOKIE_NAME] || cookies[LEGACY_SESSION_COOKIE_NAME])
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress || ''
  return address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address === 'localhost'
}

function getCliUser(request: IncomingMessage): UserRecord | undefined {
  if (!isLoopbackRequest(request)) return undefined
  const expected = String(process.env.KROUTER_CLI_TOKEN || process.env.KAM_CLI_TOKEN || '').trim()
  if (!expected) return undefined
  const provided = String(request.headers['x-krouter-cli-token'] || request.headers['x-kam-cli-token'] || '').trim()
  if (provided !== expected) return undefined
  return store.getUsers().find(item => item.role === 'admin') || store.getUsers()[0]
}

function getApiUser(request: IncomingMessage): UserRecord | undefined {
  return getUser(request) || getCliUser(request)
}

function publicUser(user: UserRecord): { id: string; email: string; name?: string; role: 'admin' | 'user' } {
  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

function emit(channel: string, ...args: unknown[]): void {
  const payload = JSON.stringify({ channel, args })
  for (const client of sseClients) {
    client.write(`data: ${payload}\n\n`)
  }
}

async function startAutoProxyRuntimes(): Promise<void> {
  for (const user of store.getUsers()) {
    const runtime = getProxyRuntime(store, user.id, emit)
    const result = await runtime.ensureAutoStarted('server-boot')
    if (!result.success) {
      console.error(`[Server] Proxy auto-start skipped for ${user.email}: ${result.error}`)
    }
  }
}

async function startAutoKProxyRuntimes(): Promise<void> {
  for (const user of store.getUsers()) {
    const config = store.getUserSetting<Record<string, unknown>>(user.id, 'kproxyConfig', {})
    if (!config.autoStart) continue
    const runtime = getKProxyRuntime(store, user.id, emit)
    const result = await runtime.start(config)
    if (!result.success) {
      console.error(`[Server] K-Proxy auto-start skipped for ${user.email}: ${result.error}`)
    }
  }
}

async function startDashboardTunnelIfConfigured(): Promise<void> {
  if (!shouldAutoStartDashboardTunnel()) return
  const result = await dashboardTunnelRuntime.start()
  if (!result.success) {
    console.error(`[Server] Dashboard tunnel auto-start skipped: ${result.error || result.status.error || 'unknown error'}`)
  } else if (result.status.publicUrl) {
    console.log(`[Server] Dashboard tunnel running at ${result.status.publicUrl}`)
  } else {
    console.log('[Server] Dashboard tunnel start requested; public URL is not ready yet')
  }
}

function defaultAccountData(): Record<string, unknown> {
  return {
    accounts: {},
    groups: {},
    tags: {},
    activeAccountId: null,
    autoRefreshEnabled: true,
    autoRefreshInterval: 5,
    autoRefreshConcurrency: 100,
    autoRefreshSyncInfo: true,
    statusCheckInterval: 60,
    privacyMode: false,
    usagePrecision: false,
    proxyEnabled: false,
    proxyUrl: '',
    autoSwitchEnabled: false,
    autoSwitchThreshold: 0,
    autoSwitchInterval: 5,
    switchTarget: 'ide',
    theme: 'default',
    darkMode: false,
    language: 'auto',
    machineIdConfig: {
      autoSwitchOnAccountChange: false,
      bindMachineIdToAccount: false,
      useBindedMachineId: true
    },
    currentMachineId: '',
    originalMachineId: null,
    originalBackupTime: null,
    accountMachineIds: {},
    machineIdHistory: [],
    proxyPool: {},
    proxyPoolConfig: {
      enabled: false,
      strategy: 'round_robin',
      validateOnStartup: false,
      autoDisableDead: true,
      failureThreshold: 3,
      testUrl: 'https://api.ipify.org?format=json',
      testTimeoutMs: 8000,
      autoValidateIntervalMin: 0,
      autoValidateConcurrency: 5,
      upstreamProxy: ''
    },
    proxyPoolCursor: 0,
    accountProxyBindings: {}
  }
}

function mergeAccountData(currentRaw: unknown, incomingRaw: unknown): Record<string, unknown> {
  const current = currentRaw && typeof currentRaw === 'object'
    ? currentRaw as Record<string, unknown>
    : defaultAccountData()
  const incoming = incomingRaw && typeof incomingRaw === 'object'
    ? incomingRaw as Record<string, unknown>
    : defaultAccountData()
  const currentAccounts = current.accounts && typeof current.accounts === 'object'
    ? current.accounts as Record<string, unknown>
    : {}
  const incomingAccounts = incoming.accounts && typeof incoming.accounts === 'object'
    ? incoming.accounts as Record<string, unknown>
    : {}
  const deletedIds = new Set<string>([
    ...(Array.isArray(current._deletedAccountIds) ? current._deletedAccountIds.filter((id): id is string => typeof id === 'string') : []),
    ...(Array.isArray(incoming._deletedAccountIds) ? incoming._deletedAccountIds.filter((id): id is string => typeof id === 'string') : [])
  ])
  const accounts = { ...currentAccounts, ...incomingAccounts }
  for (const id of deletedIds) delete accounts[id]
  return {
    ...current,
    ...incoming,
    accounts,
    _deletedAccountIds: Array.from(deletedIds)
  }
}

function unsupported(method: string): { success: false; error: string } {
  return {
    success: false,
    error: `Web backend handler '${method}' has not been ported from Electron yet.`
  }
}

async function httpProbe(params: { url: string; method?: 'GET' | 'HEAD'; timeoutMs?: number }): Promise<{
  success: boolean
  latencyMs?: number
  status?: number
  error?: string
}> {
  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs || 5000)
  try {
    const response = await fetch(params.url, {
      method: params.method || 'GET',
      signal: controller.signal
    })
    return { success: true, status: response.status, latencyMs: Date.now() - started }
  } catch (error) {
    return { success: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}

function compareVersions(a: string, b: string): number {
  const normalize = (value: string): number[] => String(value || '0')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((part) => {
      const match = part.match(/\d+/)
      return match ? Number(match[0]) : 0
    })
  const left = normalize(a)
  const right = normalize(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    const diff = (left[i] || 0) - (right[i] || 0)
    if (diff !== 0) return diff > 0 ? 1 : -1
  }
  return 0
}

async function checkForUpdatesManual(): Promise<Record<string, unknown>> {
  const currentVersion = packageVersion()
  try {
    const latestResponse = await fetch(KROUTER_NPM_LATEST_URL, {
      headers: { 'Accept': 'application/json' }
    })
    if (!latestResponse.ok) throw new Error(`npm registry returned ${latestResponse.status}`)
    const latest = await latestResponse.json() as Record<string, any>
    const latestVersion = String(latest.version || currentVersion).replace(/^v/i, '')
    let publishedAt: string | undefined
    try {
      const packageResponse = await fetch(KROUTER_NPM_PACKAGE_URL, {
        headers: { 'Accept': 'application/json' }
      })
      if (packageResponse.ok) {
        const metadata = await packageResponse.json() as Record<string, any>
        publishedAt = metadata.time?.[latestVersion]
      }
    } catch {
      // Package time is optional; the latest endpoint is enough for update checks.
    }
    return {
      hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
      currentVersion,
      latestVersion,
      releaseName: `Krouter v${latestVersion}`,
      releaseNotes: latest.description || 'Krouter package update from npm.',
      releaseUrl: `https://www.npmjs.com/package/${KROUTER_NPM_PACKAGE}/v/${latestVersion}`,
      publishedAt,
      source: 'npm',
      packageName: KROUTER_NPM_PACKAGE,
      assets: latest.dist?.tarball ? [{
        name: `${KROUTER_NPM_PACKAGE}-${latestVersion}.tgz`,
        downloadUrl: latest.dist.tarball,
        size: latest.dist.unpackedSize || 0
      }] : []
    }
  } catch (error) {
    try {
      const response = await fetch('https://api.github.com/repos/LightHaru/Krouter/releases/latest')
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`)
      const release = await response.json() as Record<string, any>
      const latestVersion = String(release.tag_name || currentVersion).replace(/^v/i, '')
      return {
        hasUpdate: compareVersions(latestVersion, currentVersion) > 0,
        currentVersion,
        latestVersion,
        releaseName: release.name || `Krouter v${latestVersion}`,
        releaseNotes: release.body,
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
        source: 'github',
        packageName: KROUTER_NPM_PACKAGE,
        assets: Array.isArray(release.assets)
          ? release.assets.map((asset) => ({
              name: asset.name,
              downloadUrl: asset.browser_download_url,
              size: asset.size
            }))
          : []
      }
    } catch (fallbackError) {
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion: currentVersion,
        error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      }
    }
  }
}

function npmCommand(): string {
  return process.env.KROUTER_NPM_COMMAND || process.env.NPM_COMMAND || (process.platform === 'win32' ? 'npm.cmd' : 'npm')
}

function runUpdateCommand(): Promise<{ code: number; stdout: string; stderr: string }> {
  const override = process.env.KROUTER_UPDATE_COMMAND || process.env.KAM_UPDATE_COMMAND
  if (override?.trim()) {
    return new Promise((resolve) => {
      const child = spawn(override, {
        shell: true,
        windowsHide: true
      })
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => { stdout += chunk.toString() })
      child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
      child.on('error', (error) => resolve({ code: 1, stdout, stderr: error.message }))
    })
  }

  return new Promise((resolve) => {
    execFile(
      npmCommand(),
      ['install', '-g', `${KROUTER_NPM_PACKAGE}@latest`, '--registry', 'https://registry.npmjs.org/', '--no-audit', '--no-fund'],
      { windowsHide: true, timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 * 8 },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof (error as NodeJS.ErrnoException & { code?: number | string }).code === 'number'
            ? Number((error as NodeJS.ErrnoException & { code?: number }).code)
            : 1
          resolve({ code, stdout, stderr: stderr || error.message })
          return
        }
        resolve({ code: 0, stdout, stderr })
      }
    )
  })
}

function scheduleRestartAfterUpdate(): { scheduled: boolean; command?: string } {
  const command = process.env.KROUTER_RESTART_COMMAND || process.env.KAM_RESTART_COMMAND
  if (!command?.trim()) return { scheduled: false }
  setTimeout(() => {
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
  }, 1200)
  return { scheduled: true, command }
}

async function applyKrouterUpdate(): Promise<Record<string, unknown>> {
  if (krouterUpdatePromise) {
    return {
      success: false,
      inProgress: true,
      error: 'Krouter update is already running.'
    }
  }

  krouterUpdatePromise = (async () => {
    const check = await checkForUpdatesManual()
    if (check.error) return { success: false, ...check }
    if (!check.hasUpdate) return { success: true, updated: false, ...check }

    const startedAt = Date.now()
    const result = await runUpdateCommand()
    if (result.code !== 0) {
      return {
        success: false,
        updated: false,
        ...check,
        exitCode: result.code,
        output: result.stdout.slice(-4000),
        error: (result.stderr || result.stdout || 'Update command failed').slice(-4000)
      }
    }

    const restart = scheduleRestartAfterUpdate()
    return {
      success: true,
      updated: true,
      restartScheduled: restart.scheduled,
      restartCommandConfigured: restart.scheduled,
      durationMs: Date.now() - startedAt,
      output: result.stdout.slice(-4000),
      ...check
    }
  })()

  try {
    return await krouterUpdatePromise
  } finally {
    krouterUpdatePromise = null
  }
}

type BackgroundAccount = AccountLike & {
  id: string
  email?: string
  needsTokenRefresh?: boolean
}

type StoredAccount = AccountLike & {
  id?: string
  email?: string
  userId?: string
  status?: string
  lastError?: string
  lastCheckedAt?: number
  usage?: Record<string, unknown>
  subscription?: Record<string, unknown>
}

type StoredAccountData = Record<string, unknown> & {
  accounts?: Record<string, StoredAccount>
  autoRefreshEnabled?: boolean
  autoRefreshInterval?: number
  autoRefreshConcurrency?: number
  autoRefreshSyncInfo?: boolean
  autoSwitchEnabled?: boolean
}

function errorMessageFromResult(result: any): string {
  return result?.error?.message || result?.error || 'Unknown error'
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isBannedAccountError(error?: string): boolean {
  if (!error) return false
  const lowerError = error.toLowerCase()
  return (
    lowerError.includes('accountsuspendedexception') ||
    lowerError.includes('account suspended') ||
    lowerError.includes('temporarily_suspended') ||
    lowerError.includes('temporarily suspended') ||
    (lowerError.includes('user id is') && lowerError.includes('suspended')) ||
    lowerError.includes('account is locked') ||
    lowerError.includes('security precaution') ||
    lowerError.includes('账户已封禁') ||
    lowerError.includes('已封禁') ||
    /\b423\b/.test(lowerError)
  )
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(parsed, max))
}

function normalizeBackgroundStatusData(data: any): Record<string, unknown> {
  const credentials = data?.newCredentials as { accessToken?: string; refreshToken?: string; expiresAt?: number } | undefined
  const subscription = data?.subscription || {}
  return {
    accessToken: credentials?.accessToken,
    refreshToken: credentials?.refreshToken,
    expiresIn: credentials?.expiresAt ? Math.max(0, Math.floor((credentials.expiresAt - Date.now()) / 1000)) : undefined,
    usage: data?.usage,
    subscription: {
      ...subscription,
      type: data?.subscriptionType || subscription.type || subscription.rawType,
      title: data?.subscriptionTitle || subscription.title,
      daysRemaining: data?.daysRemaining,
      expiresAt: data?.expiresAt,
      subscriptionManagementTarget: subscription.subscriptionManagementTarget || subscription.managementTarget
    },
    userInfo: {
      email: data?.email,
      userId: data?.userId
    },
    profileArn: data?.profileArn,
    status: data?.status,
    errorMessage: data?.errorMessage
  }
}

function accountForStatusCheck(account: BackgroundAccount, allowRefresh: boolean): BackgroundAccount {
  if (allowRefresh || !account.credentials?.accessToken) return account
  return {
    ...account,
    credentials: {
      ...account.credentials,
      expiresAt: account.credentials.expiresAt || Date.now() + 3600000
    }
  }
}

function accountNeedsBackendRefresh(account: StoredAccount, now: number): boolean {
  const credentials = account.credentials || {}
  const expiresAt = Number(credentials.expiresAt || 0)
  return !credentials.accessToken || !expiresAt || expiresAt - now <= TOKEN_REFRESH_BEFORE_EXPIRY_MS
}

function normalizeStoredUsagePercent(usage: Record<string, unknown>): Record<string, unknown> {
  const current = Number(usage.current)
  const limit = Number(usage.limit)
  if (Number.isFinite(current) && Number.isFinite(limit) && limit > 0) {
    return { ...usage, percentUsed: current / limit }
  }
  const persisted = Number(usage.percentUsed)
  if (Number.isFinite(persisted) && persisted > 1 && persisted <= 100) {
    return { ...usage, percentUsed: persisted / 100 }
  }
  return usage
}

function usageResetAdvanced(currentUsage: Record<string, unknown>, incomingUsage: Record<string, unknown>): boolean {
  const currentReset = typeof currentUsage.nextResetDate === 'string' ? Date.parse(currentUsage.nextResetDate) : NaN
  const incomingReset = typeof incomingUsage.nextResetDate === 'string' ? Date.parse(incomingUsage.nextResetDate) : NaN
  return Number.isFinite(currentReset) && Number.isFinite(incomingReset) && incomingReset > currentReset
}

function mergeStoredUsage(currentUsage: Record<string, unknown>, incomingUsage: Record<string, unknown>, now: number): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...currentUsage, ...incomingUsage, lastUpdated: now }
  const current = Number(currentUsage.current)
  const incoming = Number(incomingUsage.current)
  if (
    Number.isFinite(current) &&
    Number.isFinite(incoming) &&
    incoming < current &&
    !usageResetAdvanced(currentUsage, incomingUsage)
  ) {
    merged.current = current
  }
  return normalizeStoredUsagePercent(merged)
}

function getStoredAccounts(accountData: StoredAccountData): Record<string, StoredAccount> {
  return isPlainRecord(accountData.accounts) ? accountData.accounts as Record<string, StoredAccount> : {}
}

function applyRefreshDataToStoredAccount(
  id: string,
  account: StoredAccount,
  data: Record<string, any> | undefined,
  now: number
): StoredAccount {
  const credentials = account.credentials || {}
  const nextCredentials = { ...credentials }
  if (typeof data?.accessToken === 'string' && data.accessToken) {
    nextCredentials.accessToken = data.accessToken
  }
  if (typeof data?.refreshToken === 'string' && data.refreshToken) {
    nextCredentials.refreshToken = data.refreshToken
  }
  const expiresIn = Number(data?.expiresIn)
  if (Number.isFinite(expiresIn) && expiresIn > 0 && nextCredentials.accessToken) {
    nextCredentials.expiresAt = now + expiresIn * 1000
  }

  let usage = account.usage
  if (isPlainRecord(data?.usage)) {
    const currentUsage = isPlainRecord(account.usage) ? account.usage : {}
    usage = mergeStoredUsage(currentUsage, data.usage, now)
  }

  let subscription = account.subscription
  if (isPlainRecord(data?.subscription)) {
    const currentSubscription = isPlainRecord(account.subscription) ? account.subscription : {}
    subscription = { ...currentSubscription, ...data.subscription }
    const managementTarget = data.subscription.subscriptionManagementTarget ?? data.subscription.managementTarget ?? currentSubscription.managementTarget
    if (managementTarget !== undefined) subscription.managementTarget = managementTarget
  }

  const userInfo = isPlainRecord(data?.userInfo) ? data.userInfo : {}
  const status = data?.status === 'error' ? 'error' : 'active'
  const errorMessage = typeof data?.errorMessage === 'string' && data.errorMessage ? data.errorMessage : undefined

  return {
    ...account,
    id: account.id || id,
    email: typeof userInfo.email === 'string' && userInfo.email ? userInfo.email : account.email,
    userId: typeof userInfo.userId === 'string' && userInfo.userId ? userInfo.userId : account.userId,
    profileArn: typeof data?.profileArn === 'string' && data.profileArn ? data.profileArn : account.profileArn,
    credentials: nextCredentials,
    usage,
    subscription,
    status,
    lastError: errorMessage,
    lastCheckedAt: now
  }
}

function applyBackendRefreshFailure(id: string, account: StoredAccount, error: string, now: number): StoredAccount {
  return {
    ...account,
    id: account.id || id,
    status: 'error',
    lastError: error,
    lastCheckedAt: now
  }
}

function backendAutoRefreshEnabled(): boolean {
  return envFlag('KROUTER_BACKEND_AUTO_REFRESH') ?? envFlag('KAM_BACKEND_AUTO_REFRESH') ?? true
}

async function runBackendAutoRefreshForUser(user: UserRecord, reason: string): Promise<void> {
  if (!backendAutoRefreshEnabled()) return
  if (backendAutoRefreshRunning.has(user.id)) return
  backendAutoRefreshRunning.add(user.id)
  try {
    const accountData = (store.getAccountData(user.id) || defaultAccountData()) as StoredAccountData
    if (accountData.autoRefreshEnabled === false) return

    const accounts = getStoredAccounts(accountData)
    const entries = Object.entries(accounts)
    const now = Date.now()
    const syncInfo = accountData.autoRefreshSyncInfo !== false
    const autoSwitch = Boolean(accountData.autoSwitchEnabled)
    const pending = entries
      .map(([id, account]) => ({
        id,
        account,
        needsTokenRefresh: accountNeedsBackendRefresh(account, now)
      }))
      .filter(({ account, needsTokenRefresh }) => {
        if (isBannedAccountError(account.lastError)) return false
        if (!account.credentials?.refreshToken) return false
        return needsTokenRefresh || syncInfo || autoSwitch
      })

    if (pending.length === 0) return

    const concurrency = clampNumber(accountData.autoRefreshConcurrency, 5, 1, 100)
    let completed = 0
    let successCount = 0
    let failedCount = 0
    let changed = false
    console.log(`[BackendAutoRefresh] ${user.email}: processing ${pending.length} account(s), reason=${reason}, syncInfo=${syncInfo}`)

    for (let index = 0; index < pending.length; index += concurrency) {
      const batch = pending.slice(index, index + concurrency)
      await Promise.all(batch.map(async ({ id, account, needsTokenRefresh }) => {
        const backgroundAccount: BackgroundAccount = {
          ...account,
          id,
          needsTokenRefresh
        }
        let payload: { id: string; success: boolean; data?: unknown; error?: string }
        try {
          if (!syncInfo && !autoSwitch) {
            const refresh = await refreshAccountToken(backgroundAccount)
            payload = refresh.success && refresh.data
              ? { id, success: true, data: refresh.data }
              : { id, success: false, error: errorMessageFromResult(refresh) }
          } else {
            const status = await checkAccountStatus(accountForStatusCheck(backgroundAccount, needsTokenRefresh)) as any
            payload = status?.success && status.data
              ? { id, success: true, data: normalizeBackgroundStatusData(status.data) }
              : { id, success: false, error: errorMessageFromResult(status) }
          }
        } catch (error) {
          payload = { id, success: false, error: error instanceof Error ? error.message : String(error) }
        }

        const finishedAt = Date.now()
        if (payload.success) {
          successCount++
          accounts[id] = applyRefreshDataToStoredAccount(id, accounts[id] || account, payload.data as Record<string, any> | undefined, finishedAt)
        } else {
          failedCount++
          accounts[id] = applyBackendRefreshFailure(id, accounts[id] || account, payload.error || 'Unknown error', finishedAt)
        }
        changed = true
        emit('background-refresh-result', payload)
      }))

      completed += batch.length
      emit('background-refresh-progress', { completed, total: pending.length, success: successCount, failed: failedCount })
      if (index + concurrency < pending.length) await new Promise((resolve) => setTimeout(resolve, 100))
    }

    if (changed) {
      accountData.accounts = accounts
      await store.setAccountData(user.id, accountData)
      await store.audit(user.id, 'backend-token-refresh', {
        reason,
        completed,
        successCount,
        failedCount
      })
    }
  } catch (error) {
    console.error(`[BackendAutoRefresh] ${user.email}: failed`, error)
  } finally {
    backendAutoRefreshRunning.delete(user.id)
  }
}

function clearBackendAutoRefreshForUser(userId: string): void {
  const timer = backendAutoRefreshTimers.get(userId)
  if (timer) clearInterval(timer)
  backendAutoRefreshTimers.delete(userId)
}

function scheduleBackendAutoRefreshForUser(user: UserRecord, runNow: boolean): void {
  clearBackendAutoRefreshForUser(user.id)
  if (!backendAutoRefreshEnabled()) return
  const accountData = (store.getAccountData(user.id) || defaultAccountData()) as StoredAccountData
  if (accountData.autoRefreshEnabled === false) {
    console.log(`[BackendAutoRefresh] ${user.email}: disabled by account settings`)
    return
  }

  const intervalMinutes = clampNumber(accountData.autoRefreshInterval, 5, 1, 1440)
  const intervalMs = Math.max(BACKEND_AUTO_REFRESH_MIN_INTERVAL_MS, intervalMinutes * 60 * 1000)
  const timer = setInterval(() => {
    void runBackendAutoRefreshForUser(user, 'interval')
  }, intervalMs)
  timer.unref?.()
  backendAutoRefreshTimers.set(user.id, timer)

  if (runNow) {
    const initialTimer = setTimeout(() => {
      void runBackendAutoRefreshForUser(user, 'server-boot')
    }, 2000)
    initialTimer.unref?.()
  }
}

async function startBackendAutoRefreshRuntimes(): Promise<void> {
  if (!backendAutoRefreshEnabled()) {
    console.log('[BackendAutoRefresh] Disabled by environment')
    return
  }
  for (const user of store.getUsers()) {
    scheduleBackendAutoRefreshForUser(user, true)
  }
}

async function handleBackgroundBatch(method: string, args: unknown[]): Promise<{
  success: boolean
  completed: number
  successCount: number
  failedCount: number
}> {
  const accounts = Array.isArray(args[0]) ? args[0] as BackgroundAccount[] : []
  const concurrency = Math.max(1, Math.min(Number(args[1]) || 5, 100))
  const syncInfo = Boolean(args[2])
  const isRefresh = method === 'backgroundBatchRefresh'
  const resultChannel = isRefresh ? 'background-refresh-result' : 'background-check-result'
  const progressChannel = isRefresh ? 'background-refresh-progress' : 'background-check-progress'
  let completed = 0
  let successCount = 0
  let failedCount = 0

  for (let index = 0; index < accounts.length; index += concurrency) {
    const batch = accounts.slice(index, index + concurrency)
    await Promise.all(batch.map(async (account) => {
      let payload: { id: string; success: boolean; data?: unknown; error?: string }
      try {
        if (isRefresh && !syncInfo) {
          const refresh = await refreshAccountToken(account)
          payload = refresh.success && refresh.data
            ? { id: account.id, success: true, data: refresh.data }
            : { id: account.id, success: false, error: errorMessageFromResult(refresh) }
        } else {
          const allowRefresh = isRefresh && Boolean(account.needsTokenRefresh)
          const status = await checkAccountStatus(accountForStatusCheck(account, allowRefresh)) as any
          payload = status?.success && status.data
            ? { id: account.id, success: true, data: normalizeBackgroundStatusData(status.data) }
            : { id: account.id, success: false, error: errorMessageFromResult(status) }
        }
      } catch (error) {
        payload = { id: account.id, success: false, error: error instanceof Error ? error.message : String(error) }
      }

      if (payload.success) successCount++
      else failedCount++
      emit(resultChannel, payload)
    }))

    completed += batch.length
    emit(progressChannel, { completed, total: accounts.length, success: successCount, failed: failedCount })
    if (index + concurrency < accounts.length) await new Promise((resolve) => setTimeout(resolve, 100))
  }

  return { success: true, completed, successCount, failedCount }
}

async function handleIpc(method: string, args: unknown[], user: UserRecord): Promise<unknown> {
  const settings = store.getUserSettings(user.id)
  const proxyRuntime = getProxyRuntime(store, user.id, emit)
  const kproxyRuntime = getKProxyRuntime(store, user.id, emit)
  switch (method) {
    case 'getAppVersion':
      return packageVersion()
    case 'loadAccounts':
      {
        const accountData = (store.getAccountData(user.id) || defaultAccountData()) as Record<string, unknown>
        const hydrated = await hydrateAccountDataProfileArns(accountData)
        if (hydrated.changed) await store.setAccountData(user.id, hydrated.data)
        return hydrated.data
      }
    case 'saveAccounts':
      {
        const merged = mergeAccountData(store.getAccountData(user.id), args[0])
        const hydrated = await hydrateAccountDataProfileArns(merged)
        await store.setAccountData(user.id, hydrated.data)
        scheduleBackendAutoRefreshForUser(user, false)
      }
      return null
    case 'getLocalActiveAccount':
      return getLocalActiveAccount()
    case 'loadKiroCredentials':
      return loadKiroCredentials()
    case 'importFromSsoToken':
      return importFromSsoToken(String(args[0] || ''), String(args[1] || 'us-east-1'))
    case 'startBuilderIdLogin':
      return startBuilderIdLogin(String(args[0] || 'us-east-1'))
    case 'pollBuilderIdAuth':
      return pollBuilderIdAuth(String(args[0] || 'us-east-1'))
    case 'cancelBuilderIdLogin':
      return cancelBuilderIdLogin()
    case 'startIamSsoLogin':
      return startIamSsoLogin(String(args[0] || ''), String(args[1] || 'us-east-1'))
    case 'pollIamSsoAuth':
      return pollIamSsoAuth()
    case 'completeIamSsoLogin':
      return completeIamSsoLogin(String(args[0] || ''))
    case 'cancelIamSsoLogin':
      return cancelIamSsoLogin()
    case 'startSocialLogin':
      return startSocialLogin(args[0] as 'Google' | 'Github')
    case 'exchangeSocialToken':
      return exchangeSocialToken(String(args[0] || ''), String(args[1] || ''))
    case 'cancelSocialLogin':
      return cancelSocialLogin()
    case 'switchAccount':
      return switchAccount(args[0] as Parameters<typeof switchAccount>[0])
    case 'switchAccountCli':
      return switchAccountCli(args[0] as Parameters<typeof switchAccountCli>[0])
    case 'logoutAccount':
      return logoutAccount()
    case 'refreshAccountToken':
      return refreshAccountToken(args[0] as Parameters<typeof refreshAccountToken>[0])
    case 'verifyAccountCredentials':
      return verifyAccountCredentials(args[0] as Parameters<typeof verifyAccountCredentials>[0])
    case 'checkAccountStatus':
      return checkAccountStatus(args[0] as Parameters<typeof checkAccountStatus>[0])
    case 'accountGetModels':
      return accountGetModels(args)
    case 'accountGetSubscriptions':
      return accountGetSubscriptions(args)
    case 'accountGetSubscriptionUrl':
      return accountGetSubscriptionUrl(args)
    case 'accountSetOverage':
      return accountSetOverage(args)
    case 'machineIdGetOSType':
      return machineIdGetOSType()
    case 'machineIdGenerateRandom':
      return machineIdGenerateRandom()
    case 'machineIdCheckAdmin':
      return machineIdCheckAdmin()
    case 'machineIdGetCurrent':
      return machineIdGetCurrent()
    case 'machineIdSet':
      return machineIdSet(String(args[0] || ''))
    case 'machineIdRequestAdminRestart':
      return false
    case 'machineIdBackupToFile':
      return machineIdBackupToFile(String(args[0] || ''))
    case 'machineIdRestoreFromFile':
      return machineIdRestoreFromFile()
    case 'setProxy':
      await store.setUserSetting(user.id, 'proxy', { enabled: args[0], url: args[1] })
      return { success: true, normalizedUrl: args[1] }
    case 'getUsageApiType':
      return store.getUserSetting(user.id, 'usageApiType', 'rest')
    case 'setUsageApiType':
      await store.setUserSetting(user.id, 'usageApiType', args[0])
      return { success: true, type: args[0] }
    case 'getUseKProxyForApi':
      return store.getUserSetting(user.id, 'useKProxyForApi', false)
    case 'setUseKProxyForApi':
      await store.setUserSetting(user.id, 'useKProxyForApi', Boolean(args[0]))
      return { success: true, enabled: Boolean(args[0]) }
    case 'getShowWindowShortcut':
      return store.getUserSetting(user.id, 'showWindowShortcut', 'Ctrl+Shift+K')
    case 'setShowWindowShortcut':
      await store.setUserSetting(user.id, 'showWindowShortcut', args[0])
      return { success: true }
    case 'getTraySettings':
      return store.getUserSetting(user.id, 'traySettings', {
        enabled: false,
        closeAction: 'quit',
        showNotifications: false,
        minimizeOnStart: false
      })
    case 'saveTraySettings':
      await store.setUserSetting(user.id, 'traySettings', { ...(settings.traySettings as Record<string, unknown> || {}), ...(args[0] as Record<string, unknown> || {}) })
      return { success: true }
    case 'checkForUpdates':
      return checkForUpdatesManual()
    case 'checkForUpdatesManual':
      return checkForUpdatesManual()
    case 'applyKrouterUpdate':
    case 'installKrouterUpdate':
      return applyKrouterUpdate()
    case 'proxyGetStatus':
      return proxyRuntime.getStatus()
    case 'proxyStart':
      return proxyRuntime.start(args[0] as Record<string, unknown>)
    case 'proxyStop':
      return proxyRuntime.stop()
    case 'proxyUpdateConfig':
      return proxyRuntime.updateConfig(args[0] as Record<string, unknown>)
    case 'proxyNeedsRestart':
      return proxyRuntime.needsRestart()
    case 'proxyRestart':
      return proxyRuntime.restart()
    case 'proxyGetLogs':
      return proxyRuntime.getLogs(args[0] as number | undefined)
    case 'proxyGetLogsCount':
      return proxyRuntime.getLogsCount()
    case 'proxyClearLogs':
      return proxyRuntime.clearLogs()
    case 'proxySaveLogs':
      await store.setUserSetting(user.id, 'proxyLogs', args[0] || [])
      return { success: true }
    case 'proxyLoadLogs':
      return { success: true, logs: store.getUserSetting(user.id, 'proxyLogs', []) }
    case 'proxyAuditLog':
      return proxyRuntime.auditLog()
    case 'proxyResetCredits':
      return proxyRuntime.resetCredits()
    case 'proxyResetTokens':
      return proxyRuntime.resetTokens()
    case 'proxyResetRequestStats':
      return proxyRuntime.resetRequestStats()
    case 'proxyResetPool':
      return proxyRuntime.resetPool()
    case 'proxyClearAccountSuspended':
      return proxyRuntime.clearAccountSuspended(String(args[0] || ''))
    case 'proxySelfSignedCertInfo':
      return proxyRuntime.selfSignedCertInfo()
    case 'proxySelfSignedCertRegenerate':
      return proxyRuntime.selfSignedCertRegenerate()
    case 'proxyAddAccount':
      return proxyRuntime.addAccount(args[0] as Parameters<typeof proxyRuntime.addAccount>[0])
    case 'proxyRemoveAccount':
      return proxyRuntime.removeAccount(String(args[0] || ''))
    case 'proxySyncAccounts':
      return proxyRuntime.syncAccounts(args[0] as Parameters<typeof proxyRuntime.syncAccounts>[0])
    case 'proxySyncAccountsFromStore':
      return proxyRuntime.syncAccountsFromStoreAsync()
    case 'proxyGetAccounts':
      return proxyRuntime.getAccounts()
    case 'proxyRefreshModels':
      return proxyRuntime.refreshModels()
    case 'proxyGetModels':
      return proxyRuntime.getModels()
    case 'getKiroAvailableModels':
      return proxyRuntime.getModels()
    case 'getKiroSettings':
      return getKiroSettings()
    case 'saveKiroSettings':
      return saveKiroSettings(args[0] as Record<string, unknown>)
    case 'openKiroSettingsFile':
      return ensureKiroSettingsFile()
    case 'openKiroMcpConfig':
      return ensureMcpConfig((args[0] as 'user' | 'workspace') || 'user')
    case 'openKiroSteeringFolder':
      return ensureSteeringFolder()
    case 'openKiroSteeringFile':
      return readSteeringFile(String(args[0] || ''))
    case 'createKiroDefaultRules':
      return createDefaultRules()
    case 'readKiroSteeringFile':
      return readSteeringFile(String(args[0] || ''))
    case 'saveKiroSteeringFile':
      return saveSteeringFile(String(args[0] || ''), String(args[1] || ''))
    case 'deleteKiroSteeringFile':
      return deleteSteeringFile(String(args[0] || ''))
    case 'saveMcpServer':
      return saveMcpServer(String(args[0] || ''), args[1] as { command: string; args?: string[]; env?: Record<string, string> }, args[2] as string | undefined)
    case 'deleteMcpServer':
      return deleteMcpServer(String(args[0] || ''))
    case 'proxyGetApiKeys':
      return proxyRuntime.getApiKeys()
    case 'proxyAddApiKey':
      return proxyRuntime.addApiKey(args[0] as Parameters<typeof proxyRuntime.addApiKey>[0])
    case 'proxyUpdateApiKey':
      return proxyRuntime.updateApiKey(String(args[0] || ''), args[1] as Parameters<typeof proxyRuntime.updateApiKey>[1])
    case 'proxyDeleteApiKey':
      return proxyRuntime.deleteApiKey(String(args[0] || ''))
    case 'proxyResetApiKeyUsage':
      return proxyRuntime.resetApiKeyUsage(String(args[0] || ''))
    case 'proxyConfigureClients':
      return proxyRuntime.configureClients(args[0] as Parameters<typeof proxyRuntime.configureClients>[0])
    case 'proxyPoolValidate':
      return proxyPoolValidate(args[0] as Parameters<typeof proxyPoolValidate>[0])
    case 'networkRouteValidate':
      return networkRouteValidate(args[0] as Parameters<typeof networkRouteValidate>[0])
    case 'proxyPoolDiagnoseChain':
      return proxyPoolDiagnoseChain(args[0] as Parameters<typeof proxyPoolDiagnoseChain>[0])
    case 'diagnoseHttpProbe':
      return httpProbe(args[0] as { url: string; method?: 'GET' | 'HEAD'; timeoutMs?: number })
    case 'diagnoseRun': {
      const input = args[0] as { targets?: Array<{ id: string; label: string; url: string; timeoutMs?: number; expectStatus?: number[] }> }
      const targets = input?.targets || []
      const results = await Promise.all(targets.map(async (target) => {
        const result = await httpProbe({ url: target.url, timeoutMs: target.timeoutMs })
        return {
          id: target.id,
          label: target.label,
          url: target.url,
          success: result.success && (!target.expectStatus || target.expectStatus.includes(result.status || 0)),
          httpStatus: result.status,
          latencyMs: result.latencyMs,
          error: result.error
        }
      }))
      return { results }
    }
    case 'diagnoseAccountLiveness':
      return diagnoseAccountLiveness(args[0] as Parameters<typeof diagnoseAccountLiveness>[0])
    case 'dashboardTunnelGetStatus':
      return dashboardTunnelRuntime.getStatus()
    case 'dashboardTunnelStart':
      return dashboardTunnelRuntime.start(args[0] as Parameters<typeof dashboardTunnelRuntime.start>[0])
    case 'dashboardTunnelStop':
      return dashboardTunnelRuntime.stop()
    case 'registrationStartAuto':
      return registrationStartAuto(args[0] as Parameters<typeof registrationStartAuto>[0], emit)
    case 'registrationManualPhase1':
      return registrationManualPhase1(args[0] as Parameters<typeof registrationManualPhase1>[0], emit)
    case 'registrationManualPhase2':
      return registrationManualPhase2(String(args[0] || ''), args[1] as string | undefined)
    case 'registrationManualPhase3':
      return registrationManualPhase3(String(args[0] || ''))
    case 'registrationStatus':
      return registrationStatus()
    case 'registrationCancel':
      return registrationCancel(args[0] as string | undefined)
    case 'protonOpenLogin':
      return protonOpenLogin()
    case 'protonLoginStatus':
      return protonLoginStatus()
    case 'protonClose':
      return protonClose()
    case 'kproxyGetStatus':
      return kproxyRuntime.getStatus()
    case 'kproxyGenerateDeviceId':
      return kproxyRuntime.generateDeviceId()
    case 'kproxyGetDeviceMappings':
      return kproxyRuntime.getDeviceMappings()
    case 'kproxyInit':
      return kproxyRuntime.init()
    case 'kproxyStart':
      return kproxyRuntime.start(args[0] as Record<string, unknown>)
    case 'kproxyStop':
      return kproxyRuntime.stop()
    case 'kproxyUpdateConfig':
      return kproxyRuntime.updateConfig(args[0] as Record<string, unknown>)
    case 'kproxySetDeviceId':
      return kproxyRuntime.setDeviceId(String(args[0] || ''))
    case 'kproxyAddDeviceMapping':
      return kproxyRuntime.addDeviceMapping(args[0] as Parameters<typeof kproxyRuntime.addDeviceMapping>[0])
    case 'kproxySwitchToAccount':
      return kproxyRuntime.switchToAccount(String(args[0] || ''))
    case 'kproxyGetCaCert':
      return kproxyRuntime.getCaCert()
    case 'kproxyExportCaCert':
      return kproxyRuntime.exportCaCert(args[0] as string | undefined)
    case 'kproxyCheckCaCertInstalled':
      return kproxyRuntime.checkCaCertInstalled()
    case 'kproxyInstallCaCert':
      return kproxyRuntime.installCaCert()
    case 'kproxyUninstallCaCert':
      return kproxyRuntime.uninstallCaCert()
    case 'kproxyResetStats':
      return kproxyRuntime.resetStats()
    case 'accountSetProxyBinding': {
      const [accountId, proxyUrl] = args as [string, string | undefined]
      const accountData = (store.getAccountData(user.id) || defaultAccountData()) as Record<string, any>
      accountData.accountProxyBindings = { ...(accountData.accountProxyBindings || {}), [accountId]: proxyUrl }
      if (!proxyUrl) delete accountData.accountProxyBindings[accountId]
      await store.setAccountData(user.id, accountData)
      return { success: true }
    }
    case 'backgroundBatchRefresh':
    case 'backgroundBatchCheck':
      return handleBackgroundBatch(method, args)
    default:
      return unsupported(method)
  }
}

async function handleAuth(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (pathname === '/api/auth/social/callback' && request.method === 'GET') {
    const callbackUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    const result = handleSocialCallback(callbackUrl, emit)
    sendAuthHtml(response, result.title, result.body)
    return
  }

  if (pathname === '/api/auth/iam-sso/callback' && request.method === 'GET') {
    const callbackUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    const result = await handleIamSsoCallback(callbackUrl)
    sendAuthHtml(response, result.title, result.body)
    return
  }

  if (pathname === '/api/auth/session' && request.method === 'GET') {
    const user = getUser(request)
    sendJson(response, 200, user
      ? { authenticated: true, setupRequired: false, user: publicUser(user) }
      : { authenticated: false, setupRequired: store.isSetupRequired() })
    return
  }

  if (pathname === '/api/auth/setup/status' && request.method === 'GET') {
    sendJson(response, 200, { setupRequired: store.isSetupRequired() })
    return
  }

  if (pathname === '/api/auth/setup' && request.method === 'POST') {
    if (!store.isSetupRequired()) {
      sendJson(response, 409, { error: 'Krouter is already set up' })
      return
    }
    const body = await readJson(request)
    const mode = String(body?.mode || '').trim()
    const generatedPassword = mode === 'random' ? WebStore.generateAdminPassword() : undefined
    const password = generatedPassword || String(body?.password || '')
    if (mode !== 'random' && mode !== 'custom') {
      sendJson(response, 400, { error: 'Choose random or custom password setup' })
      return
    }
    try {
      const user = await store.createInitialAdmin({
        email: String(body?.email || '').trim() || undefined,
        password
      })
      const session = await store.createSession(user.id)
      scheduleBackendAutoRefreshForUser(user, false)
      response.setHeader('Set-Cookie', sessionCookie(session.id, session.expiresAt))
      sendJson(response, 200, {
        authenticated: true,
        setupRequired: false,
        user: publicUser(user),
        generatedPassword
      })
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (pathname === '/api/auth/login' && request.method === 'POST') {
    if (store.isSetupRequired()) {
      sendJson(response, 428, { error: 'Krouter setup is required first', setupRequired: true })
      return
    }
    const body = await readJson(request)
    const email = String(body?.email || '').trim()
    const user = email
      ? store.findUserByEmail(email)
      : store.getUsers().find(item => item.role === 'admin') || store.getUsers()[0]
    if (!user || !verifyPassword(String(body?.password || ''), user)) {
      sendJson(response, 401, { error: email ? 'Invalid email or password' : 'Invalid password' })
      return
    }
    const session = await store.createSession(user.id)
    response.setHeader('Set-Cookie', sessionCookie(session.id, session.expiresAt))
    sendJson(response, 200, { authenticated: true, user: publicUser(user) })
    return
  }

  if (pathname === '/api/auth/logout' && request.method === 'POST') {
    const cookies = parseCookies(request)
    await store.deleteSession(cookies[SESSION_COOKIE_NAME] || cookies[LEGACY_SESSION_COOKIE_NAME])
    response.setHeader('Set-Cookie', [clearCookie(SESSION_COOKIE_NAME), clearCookie(LEGACY_SESSION_COOKIE_NAME)])
    sendJson(response, 200, { success: true })
    return
  }

  sendJson(response, 404, { error: 'Not found' })
}

function protonLoginPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Proton Login</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; min-height: 100vh; background: #111827; color: #e5e7eb; }
    .bar { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 10px; background: #0f172a; border-bottom: 1px solid #334155; }
    button, input { height: 34px; border-radius: 6px; border: 1px solid #475569; background: #1e293b; color: #f8fafc; font: inherit; }
    button { padding: 0 12px; cursor: pointer; }
    button:hover { background: #334155; }
    input { min-width: 220px; padding: 0 10px; }
    .status { flex: 1 1 320px; min-width: 260px; color: #cbd5e1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .wrap { padding: 12px; }
    .screen { display: block; max-width: 100%; height: auto; margin: 0 auto; border: 1px solid #334155; background: #020617; cursor: crosshair; }
    .hint { padding: 8px 12px 0; color: #94a3b8; font-size: 13px; }
    .error { color: #fca5a5; }
  </style>
</head>
<body>
  <div class="bar">
    <button id="refresh">Refresh</button>
    <button id="inbox">Inbox</button>
    <button id="statusBtn">Check</button>
    <input id="text" autocomplete="off" placeholder="Text for focused field">
    <button id="typeBtn">Type</button>
    <button data-key="Tab">Tab</button>
    <button data-key="Enter">Enter</button>
    <button data-key="Backspace">Backspace</button>
    <button data-key="Escape">Esc</button>
    <button id="closeBtn">Close Browser</button>
    <span class="status" id="status">Starting Proton browser...</span>
  </div>
  <div class="hint">Click the screenshot to interact with the server browser. Use the text box to type into the currently focused Proton field.</div>
  <div class="wrap"><img id="screen" class="screen" alt="Proton browser screenshot"></div>
  <script>
    const screen = document.getElementById("screen");
    const statusEl = document.getElementById("status");
    const textInput = document.getElementById("text");
    let lastWidth = 1280;
    let lastHeight = 900;
    let busy = false;

    function setStatus(text, isError) {
      statusEl.textContent = text;
      statusEl.className = isError ? "status error" : "status";
    }

    async function api(path, body) {
      const init = body === undefined
        ? { credentials: "include" }
        : { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
      const response = await fetch(path, init);
      const data = await response.json();
      if (!response.ok || data.success === false) throw new Error(data.error || response.statusText);
      return data;
    }

    async function refresh() {
      if (busy) return;
      busy = true;
      try {
        setStatus("Refreshing screenshot...", false);
        const width = Math.max(900, Math.min(1280, Math.floor(window.innerWidth - 32)));
        const data = await api("/api/proton/screenshot?width=" + width + "&height=900");
        lastWidth = data.width || lastWidth;
        lastHeight = data.height || lastHeight;
        screen.src = data.dataUrl;
        setStatus((data.loggedIn ? "Logged in" : "Not logged in") + " - " + (data.url || ""), false);
      } catch (error) {
        setStatus(error.message || String(error), true);
      } finally {
        busy = false;
      }
    }

    async function sendAction(path, body, delayMs) {
      try {
        await api(path, body);
        setTimeout(refresh, delayMs || 350);
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    }

    screen.addEventListener("click", (event) => {
      const rect = screen.getBoundingClientRect();
      const x = (event.clientX - rect.left) * lastWidth / rect.width;
      const y = (event.clientY - rect.top) * lastHeight / rect.height;
      sendAction("/api/proton/click", { x, y });
    });

    screen.addEventListener("wheel", (event) => {
      event.preventDefault();
      const rect = screen.getBoundingClientRect();
      const x = (event.clientX - rect.left) * lastWidth / rect.width;
      const y = (event.clientY - rect.top) * lastHeight / rect.height;
      sendAction("/api/proton/scroll", { x, y, deltaY: event.deltaY }, 200);
    }, { passive: false });

    document.getElementById("refresh").onclick = refresh;
    document.getElementById("inbox").onclick = () => sendAction("/api/proton/navigate", {});
    document.getElementById("statusBtn").onclick = async () => {
      try {
        const data = await api("/api/proton/status");
        setStatus((data.loggedIn ? "Logged in" : "Not logged in") + " - " + (data.url || ""), false);
      } catch (error) {
        setStatus(error.message || String(error), true);
      }
    };
    document.getElementById("typeBtn").onclick = () => {
      const text = textInput.value;
      textInput.value = "";
      sendAction("/api/proton/type", { text });
    };
    document.querySelectorAll("[data-key]").forEach((button) => {
      button.onclick = () => sendAction("/api/proton/key", { key: button.getAttribute("data-key") });
    });
    document.getElementById("closeBtn").onclick = () => sendAction("/api/proton/close", {}, 0);
    window.addEventListener("resize", () => setTimeout(refresh, 250));
    refresh();
  </script>
</body>
</html>`
}

async function handleProtonRemote(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  url: URL
): Promise<void> {
  if (pathname === '/api/proton/status' && request.method === 'GET') {
    sendJson(response, 200, await protonLoginStatus())
    return
  }

  if (pathname === '/api/proton/screenshot' && request.method === 'GET') {
    sendJson(response, 200, await captureProtonScreenshot(
      Number(url.searchParams.get('width') || 0),
      Number(url.searchParams.get('height') || 0)
    ))
    return
  }

  if (pathname === '/api/proton/click' && request.method === 'POST') {
    const body = await readJson(request)
    sendJson(response, 200, await clickProtonPage(Number(body?.x || 0), Number(body?.y || 0)))
    return
  }

  if (pathname === '/api/proton/type' && request.method === 'POST') {
    const body = await readJson(request)
    sendJson(response, 200, await typeProtonText(String(body?.text || '')))
    return
  }

  if (pathname === '/api/proton/key' && request.method === 'POST') {
    const body = await readJson(request)
    sendJson(response, 200, await pressProtonKey(String(body?.key || 'Enter')))
    return
  }

  if (pathname === '/api/proton/scroll' && request.method === 'POST') {
    const body = await readJson(request)
    sendJson(response, 200, await scrollProtonPage(Number(body?.deltaY || 0), Number(body?.x || 0), Number(body?.y || 0)))
    return
  }

  if (pathname === '/api/proton/navigate' && request.method === 'POST') {
    const body = await readJson(request)
    sendJson(response, 200, await navigateProton(String(body?.url || '')))
    return
  }

  if (pathname === '/api/proton/close' && request.method === 'POST') {
    sendJson(response, 200, await protonClose())
    return
  }

  sendJson(response, 404, { error: 'Not found' })
}

async function serveStatic(response: ServerResponse, pathname: string): Promise<void> {
  const dist = path.join(process.cwd(), 'dist-web')
  const requested = pathname === '/' ? '/index.html' : pathname
  const filePath = path.normalize(path.join(dist, requested))
  if (!filePath.startsWith(dist)) {
    response.writeHead(403)
    response.end()
    return
  }

  try {
    const data = await fs.readFile(filePath)
    const ext = path.extname(filePath)
    const contentType = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.svg' ? 'image/svg+xml'
      : ext === '.png' ? 'image/png'
      : 'application/octet-stream'
    response.writeHead(200, { 'Content-Type': contentType })
    response.end(data)
  } catch {
    const indexPath = path.join(dist, 'index.html')
    try {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(await fs.readFile(indexPath))
    } catch {
      sendJson(response, 404, { error: 'Web build not found. Run npm run build:web first.' })
    }
  }
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  if (url.pathname === '/healthz') {
    sendJson(response, 200, {
      ok: true,
      version: packageVersion(),
      mode: serveStaticAssets ? 'fullstack' : 'backend-cli',
      static: serveStaticAssets
    })
    return
  }

  if (url.pathname.startsWith('/api/auth/')) {
    await handleAuth(request, response, url.pathname)
    return
  }

  if (url.pathname === '/proton-login' && request.method === 'GET') {
    const user = getUser(request)
    if (!user) {
      sendHtml(response, 401, '<!doctype html><title>Unauthorized</title><body>Unauthorized</body>')
      return
    }
    sendHtml(response, 200, protonLoginPageHtml())
    return
  }

  if (url.pathname === '/api/events') {
    const user = getApiUser(request)
    if (!user) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    response.write('data: {"channel":"connected","args":[]}\n\n')
    sseClients.add(response)
    request.on('close', () => sseClients.delete(response))
    return
  }

  if (url.pathname === '/api/ipc' && request.method === 'POST') {
    const user = getApiUser(request)
    if (!user) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }
    const body = await readJson(request)
    const method = String(body?.method || '')
    const args = Array.isArray(body?.args) ? body.args : []
    const result = await handleIpc(method, args, user)
    sendJson(response, 200, result)
    return
  }

  if (url.pathname.startsWith('/api/proton/')) {
    const user = getUser(request)
    if (!user) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }
    await handleProtonRemote(request, response, url.pathname, url)
    return
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(response, 404, { error: 'Not found' })
    return
  }

  if (serveStaticAssets) {
    await serveStatic(response, url.pathname)
    return
  }

  sendJson(response, 404, {
    error: 'Frontend static serving is disabled because this process is running in backend CLI mode.'
  })
}

async function main(): Promise<void> {
  await store.load()
  void startAutoProxyRuntimes()
  void startAutoKProxyRuntimes()
  void startBackendAutoRefreshRuntimes()
  const port = Number(process.env.PORT || 4010)
  const host = process.env.HOST || '127.0.0.1'
  const server = http.createServer((request, response) => {
    route(request, response).catch((error) => {
      console.error('[Server] Request failed:', error)
      sendJson(response, 500, { error: error instanceof Error ? error.message : 'Internal server error' })
    })
  })
  server.listen(port, host, () => {
    const mode = serveStaticAssets ? 'fullstack web/API' : 'backend CLI API'
    void startDashboardTunnelIfConfigured()
    console.log(`[Server] Krouter ${mode} đang chạy tại http://${host}:${port}`)
  })
}

void main()
