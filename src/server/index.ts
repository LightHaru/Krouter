import http, { IncomingMessage, ServerResponse } from 'http'
import crypto from 'crypto'
import { execFile, spawn } from 'child_process'
import { promises as fs, readFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { WebStore, hashPasswordAsync, verifyPasswordAsync, type UserRecord } from './store'
import {
  type AccountLike,
  checkAccountStatus,
  classifyKiroAccountError,
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
  getKiroAvailableModels,
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
import { mergePeerAccountData, pushAccountDataToRemote, summarizeAccounts } from './services/accountSync'
import type { AccountMergeResult } from './services/accountSync'
import {
  getProxyMaintenanceRuntime,
  IPLOCATE_PROXY_SOURCE
} from './services/proxyMaintenance'
import type { ProxyMaintenanceRuntime } from './services/proxyMaintenance'

type JsonValue = unknown
// Mỗi kết nối SSE nhớ luôn user sở hữu để sự kiện riêng tư không phát tán ra
// mọi client đang mở.
type SseClient = { res: ServerResponse; userId: string }
type EmitFn = (channel: string, ...args: unknown[]) => void

function loadRuntimeEnvFile(): void {
  const configuredDataDir = process.env.KROUTER_DATA_DIR
    || process.env.KAM_DATA_DIR
    || process.env.KIRO_WEB_DATA_DIR
  const dataDir = path.resolve(configuredDataDir || path.join(os.homedir(), '.krouter'))
  const envFile = path.resolve(
    process.env.KROUTER_ENV_FILE
      || process.env.KAM_ENV_FILE
      || path.join(dataDir, '.env')
  )

  try {
    const raw = readFileSync(envFile, 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const separator = trimmed.indexOf('=')
      if (separator <= 0) continue
      const key = trimmed.slice(0, separator).trim()
      if (!key || process.env[key] !== undefined) continue
      process.env[key] = trimmed
        .slice(separator + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '')
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[Server] Could not load runtime env ${envFile}:`, error)
    }
  }

  if (!process.env.KROUTER_DATA_DIR && !process.env.KAM_DATA_DIR && !process.env.KIRO_WEB_DATA_DIR) {
    process.env.KIRO_WEB_DATA_DIR = dataDir
  }
  if (!process.env.KIRO_RUNTIME_DATA_DIR) {
    process.env.KIRO_RUNTIME_DATA_DIR = process.env.KIRO_WEB_DATA_DIR || dataDir
  }
}

loadRuntimeEnvFile()

const store = new WebStore()
const sseClients = new Set<SseClient>()
const dashboardTunnelRuntime = getDashboardTunnelRuntime()
const SESSION_COOKIE_NAME = 'krouter_session'
const LEGACY_SESSION_COOKIE_NAME = 'kam_session'
const TOKEN_REFRESH_BEFORE_EXPIRY_MS = 5 * 60 * 1000
const BACKEND_AUTO_REFRESH_MIN_INTERVAL_MS = 60 * 1000
const backendAutoRefreshTimers = new Map<string, ReturnType<typeof setInterval>>()
/** Chu kỳ (ms) mà timer hiện tại của mỗi user đang chạy — dùng để tránh dựng lại timer vô ích. */
const backendAutoRefreshIntervals = new Map<string, number>()
const backendAutoRefreshRunning = new Set<string>()
const KROUTER_NPM_PACKAGE = '@lightharu/krouter'
const KROUTER_NPM_LATEST_URL = 'https://registry.npmjs.org/@lightharu%2Fkrouter/latest'
const KROUTER_NPM_PACKAGE_URL = 'https://registry.npmjs.org/@lightharu%2Fkrouter'
const ACCOUNT_SYNC_PASSWORD_SETTING_KEY = 'accountSyncPassword'
const DEFAULT_MAX_JSON_BODY_BYTES = 1024 * 1024
const ACCOUNT_SYNC_MAX_BODY_BYTES = 16 * 1024 * 1024
// /api/ipc đã qua xác thực và mang cả tài liệu account (saveAccounts,
// mergePeerAccounts) nên cần hạn mức rộng hơn mặc định.
const IPC_MAX_BODY_BYTES = 16 * 1024 * 1024
const PROXY_LOGS_MAX_ENTRIES = 1000
const PROXY_LOGS_MAX_BYTES = 1024 * 1024
const AUTH_ATTEMPT_WINDOW_MS = 5 * 60 * 1000
const AUTH_ATTEMPT_LIMIT = 10
const AUTH_BLOCK_MAX_MS = 15 * 60 * 1000
const AUTH_ATTEMPT_MAP_LIMIT = 5000
const SHUTDOWN_TIMEOUT_MS = 10000
let krouterUpdatePromise: Promise<Record<string, unknown>> | null = null

type AccountSyncPasswordSetting = {
  enabled?: boolean
  hash?: string
  salt?: string
  createdAt?: number
  updatedAt?: number
}

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
    const raw = readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')
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

// Một cookie hỏng (ví dụ lạc dấu '%') không được phép làm hỏng cả request:
// decodeURIComponent ném URIError nên phải bọc try/catch và lấy chuỗi thô.
function decodeCookiePart(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
}

function parseCookies(request: IncomingMessage): Record<string, string> {
  const header = request.headers.cookie || ''
  const cookies: Record<string, string> = {}
  for (const rawPart of header.split(';')) {
    const part = rawPart.trim()
    if (!part) continue
    const index = part.indexOf('=')
    if (index === -1) {
      cookies[part] = ''
      continue
    }
    const rawName = part.slice(0, index)
    const rawValue = part.slice(index + 1)
    cookies[decodeCookiePart(rawName) ?? rawName] = decodeCookiePart(rawValue) ?? rawValue
  }
  return cookies
}

function isSecureRequest(request: IncomingMessage): boolean {
  if ((request.socket as { encrypted?: boolean }).encrypted) return true
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  return forwardedProto === 'https'
}

// Mặc định bật Secure vì sản phẩm publish dashboard qua cloudflared. Chỉ tắt khi
// COOKIE_SECURE=false hoặc khi request đến bằng HTTP thuần trên loopback (dev).
function shouldMarkCookieSecure(request: IncomingMessage): boolean {
  if (process.env.COOKIE_SECURE === 'false') return false
  if (process.env.COOKIE_SECURE === 'true') return true
  if (isSecureRequest(request)) return true
  return !isLoopbackRequest(request)
}

function sessionCookie(request: IncomingMessage, sessionId: string, expiresAt: number): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Expires=${new Date(expiresAt).toUTCString()}`
  ]
  if (shouldMarkCookieSecure(request)) parts.push('Secure')
  return parts.join('; ')
}

function clearCookie(name: string): string {
  return `${name}=; HttpOnly; SameSite=Lax; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
}

function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode })
}

// Chặn body khổng lồ trên các endpoint chưa xác thực: đếm dồn từng chunk và
// hủy kết nối ngay khi vượt ngưỡng thay vì gom hết vào RAM.
async function readJson(request: IncomingMessage, maxBytes = DEFAULT_MAX_JSON_BODY_BYTES): Promise<Record<string, unknown> | null> {
  const contentType = String(request.headers['content-type'] || '').trim()
  // Thiếu content-type vẫn chấp nhận để không phá client cũ.
  if (contentType && !/^application\/json\b/i.test(contentType)) {
    throw httpError(415, 'Unsupported content type, expected application/json')
  }
  // pause() chứ KHÔNG destroy(): IncomingMessage.destroy() phá luôn socket bên dưới khi
  // request chưa đọc hết, nên phản hồi 413 viết sau đó rơi vào socket đã chết và client
  // chỉ thấy ECONNRESET. Ngừng đọc là đủ để không phình RAM; socket được đóng ở tầng
  // gửi phản hồi (Connection: close).
  const declaredLength = Number(request.headers['content-length'])
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.pause()
    throw httpError(413, 'Payload too large')
  }
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk)
    total += buffer.length
    if (total > maxBytes) {
      request.pause()
      throw httpError(413, 'Payload too large')
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, 'Invalid JSON body')
  }
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

// So sánh bí mật theo thời gian hằng định: băm cả hai vế trước để độ dài luôn
// bằng nhau, tránh lộ độ dài/tiền tố token qua thời gian phản hồi.
function secretsMatch(provided: string, expected: string): boolean {
  const providedHash = crypto.createHash('sha256').update(provided).digest()
  const expectedHash = crypto.createHash('sha256').update(expected).digest()
  return crypto.timingSafeEqual(providedHash, expectedHash)
}

function getCliUser(request: IncomingMessage): UserRecord | undefined {
  if (!isLoopbackRequest(request)) return undefined
  const expected = String(process.env.KROUTER_CLI_TOKEN || process.env.KAM_CLI_TOKEN || '').trim()
  if (!expected) return undefined
  const provided = String(request.headers['x-krouter-cli-token'] || request.headers['x-kam-cli-token'] || '').trim()
  if (!secretsMatch(provided, expected)) return undefined
  return store.getUsers().find(item => item.role === 'admin') || store.getUsers()[0]
}

function getApiUser(request: IncomingMessage): UserRecord | undefined {
  return getUser(request) || getCliUser(request)
}

function getAccountSyncUser(): UserRecord | undefined {
  return store.getUsers().find((item) => item.role === 'admin') || store.getUsers()[0]
}

function makeAccountSyncPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = crypto.randomBytes(24)
  let value = ''
  for (const byte of bytes) value += alphabet[byte % alphabet.length]
  return `ksync-${value.slice(0, 6)}-${value.slice(6, 12)}-${value.slice(12, 18)}-${value.slice(18, 24)}`
}

function getAccountSyncPasswordSetting(user: UserRecord): AccountSyncPasswordSetting {
  return store.getUserSetting<AccountSyncPasswordSetting>(user.id, ACCOUNT_SYNC_PASSWORD_SETTING_KEY, {})
}

async function verifyAccountSyncPassword(user: UserRecord, password: string): Promise<boolean> {
  const setting = getAccountSyncPasswordSetting(user)
  if (!setting.enabled || !setting.hash || !setting.salt || !password) return false
  const { hash } = await hashPasswordAsync(password, setting.salt)
  const expected = Buffer.from(setting.hash, 'hex')
  const actual = Buffer.from(hash, 'hex')
  if (expected.length === 0 || expected.length !== actual.length) return false
  return crypto.timingSafeEqual(actual, expected)
}

// Đếm số lần thử sai theo IP để chặn brute-force và chặn luôn việc dội PBKDF2
// làm nghẽn tiến trình. Chặn tăng dần: 2^n phút, tối đa 15 phút.
type AuthAttemptRecord = { count: number; firstAt: number; blockCount: number; blockedUntil?: number }
const authAttempts = new Map<string, AuthAttemptRecord>()

function clientIp(request: IncomingMessage): string {
  return request.socket.remoteAddress || 'unknown'
}

function pruneAuthAttempts(now: number): void {
  if (authAttempts.size <= AUTH_ATTEMPT_MAP_LIMIT) return
  for (const [key, record] of authAttempts) {
    const blocked = record.blockedUntil !== undefined && record.blockedUntil > now
    if (!blocked && now - record.firstAt > AUTH_ATTEMPT_WINDOW_MS) authAttempts.delete(key)
  }
}

function authRetryAfterSeconds(key: string, now = Date.now()): number {
  const record = authAttempts.get(key)
  if (!record || record.blockedUntil === undefined) return 0
  if (record.blockedUntil <= now) return 0
  return Math.max(1, Math.ceil((record.blockedUntil - now) / 1000))
}

function registerAuthFailure(key: string, now = Date.now()): void {
  pruneAuthAttempts(now)
  const record = authAttempts.get(key)
  if (!record || now - record.firstAt > AUTH_ATTEMPT_WINDOW_MS) {
    authAttempts.set(key, { count: 1, firstAt: now, blockCount: record?.blockCount || 0 })
    return
  }
  record.count += 1
  if (record.count > AUTH_ATTEMPT_LIMIT) {
    record.blockCount += 1
    record.blockedUntil = now + Math.min(2 ** record.blockCount * 60 * 1000, AUTH_BLOCK_MAX_MS)
    record.count = 0
    record.firstAt = now
  }
}

function clearAuthFailures(key: string): void {
  authAttempts.delete(key)
}

function rejectWhenThrottled(request: IncomingMessage, response: ServerResponse, scope: string): boolean {
  const key = `${scope}:${clientIp(request)}`
  const retryAfter = authRetryAfterSeconds(key)
  if (retryAfter <= 0) return false
  response.setHeader('Retry-After', String(retryAfter))
  sendJson(response, 429, { error: 'Too many failed attempts. Please try again later.', retryAfter })
  return true
}

async function saveAccountSyncPassword(user: UserRecord, password: string): Promise<AccountSyncPasswordSetting> {
  const cleanPassword = String(password || '').trim()
  if (cleanPassword.length < 8) throw new Error('Account sync password must be at least 8 characters')
  const current = getAccountSyncPasswordSetting(user)
  const { hash, salt } = await hashPasswordAsync(cleanPassword)
  const now = Date.now()
  const next: AccountSyncPasswordSetting = {
    enabled: true,
    hash,
    salt,
    createdAt: current.createdAt || now,
    updatedAt: now
  }
  await store.setUserSetting(user.id, ACCOUNT_SYNC_PASSWORD_SETTING_KEY, next)
  return next
}

function accountSyncPasswordStatus(user: UserRecord): {
  success: true
  enabled: boolean
  createdAt?: number
  updatedAt?: number
} {
  const setting = getAccountSyncPasswordSetting(user)
  return {
    success: true,
    enabled: Boolean(setting.enabled && setting.hash && setting.salt),
    createdAt: setting.createdAt,
    updatedAt: setting.updatedAt
  }
}

function publicUser(user: UserRecord): { id: string; email: string; name?: string; role: 'admin' | 'user' } {
  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

function broadcast(userId: string | undefined, channel: string, args: unknown[]): void {
  const payload = JSON.stringify({ channel, args })
  for (const client of sseClients) {
    if (userId !== undefined && client.userId !== userId) continue
    try {
      client.res.write(`data: ${payload}\n\n`)
    } catch (error) {
      console.warn('[Server] Không gửi được sự kiện SSE:', error instanceof Error ? error.message : error)
    }
  }
}

// emit() chỉ dành cho sự kiện thật sự toàn cục (không mang dữ liệu riêng của user).
function emit(channel: string, ...args: unknown[]): void {
  broadcast(undefined, channel, args)
}

// Sự kiện gắn với một user chỉ được gửi tới đúng các socket của user đó.
function emitToUser(userId: string, channel: string, ...args: unknown[]): void {
  broadcast(userId, channel, args)
}

const userEmitters = new Map<string, EmitFn>()

function emitForUser(userId: string): EmitFn {
  let emitter = userEmitters.get(userId)
  if (!emitter) {
    emitter = (channel: string, ...args: unknown[]): void => emitToUser(userId, channel, ...args)
    userEmitters.set(userId, emitter)
  }
  return emitter
}

async function startAutoProxyRuntimes(): Promise<void> {
  for (const user of store.getUsers()) {
    const runtime = getProxyRuntime(store, user.id, emitForUser(user.id))
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
    const runtime = getKProxyRuntime(store, user.id, emitForUser(user.id))
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
      maxUsableLatencyMs: 2500,
      autoValidateIntervalMin: 0,
      autoValidateConcurrency: 5,
      upstreamProxy: '',
      backendMaintenanceEnabled: true,
      backendMaintenanceIntervalMin: 30,
      sourceSyncEnabled: true,
      sourceUrl: 'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/all-proxies.txt',
      sourceValidateConcurrency: 40,
      sourceRemoveDead: true,
      accountHealthCheckEnabled: true,
      accountDeleteDead: true,
      accountFailureThreshold: 2,
      accountCheckConcurrency: 8
    },
    proxyPoolCursor: 0,
    accountProxyBindings: {}
  }
}

function mergeAccountRecordPreservingBlockedState(currentValue: unknown, incomingValue: unknown): unknown {
  if (!isPlainRecord(currentValue) || !isPlainRecord(incomingValue)) return incomingValue
  const currentUsage = isPlainRecord(currentValue.usage) ? currentValue.usage : {}
  const incomingUsage = isPlainRecord(incomingValue.usage) ? incomingValue.usage : {}
  const currentBlocked = currentValue.status === 'blocked' ||
    (typeof currentUsage.suspendedAt === 'number' && currentUsage.suspendedAt > 0) ||
    isBannedAccountError(typeof currentValue.lastError === 'string' ? currentValue.lastError : undefined)
  const incomingBlocked = incomingValue.status === 'blocked' ||
    (typeof incomingUsage.suspendedAt === 'number' && incomingUsage.suspendedAt > 0) ||
    isBannedAccountError(typeof incomingValue.lastError === 'string' ? incomingValue.lastError : undefined)

  if (!currentBlocked || incomingBlocked) return incomingValue
  return {
    ...incomingValue,
    status: 'blocked',
    lastError: currentValue.lastError || incomingValue.lastError || 'Account blocked by Kiro',
    usage: {
      ...incomingUsage,
      suspendedAt: currentUsage.suspendedAt || Date.now(),
      suspendReason: currentUsage.suspendReason,
      suspendMessage: currentUsage.suspendMessage
    }
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
  const accounts = { ...currentAccounts }
  for (const [id, incomingAccount] of Object.entries(incomingAccounts)) {
    accounts[id] = mergeAccountRecordPreservingBlockedState(currentAccounts[id], incomingAccount)
  }
  for (const id of deletedIds) delete accounts[id]
  const currentProxyPool = current.proxyPool && typeof current.proxyPool === 'object'
    ? current.proxyPool as Record<string, unknown>
    : {}
  const incomingHasProxyPool = Boolean(incoming.proxyPool && typeof incoming.proxyPool === 'object')
  const incomingProxyPool = incomingHasProxyPool
    ? incoming.proxyPool as Record<string, unknown>
    : currentProxyPool
  const currentProxyPoolConfig = current.proxyPoolConfig && typeof current.proxyPoolConfig === 'object'
    ? current.proxyPoolConfig as Record<string, unknown>
    : {}
  const incomingProxyPoolConfig = incoming.proxyPoolConfig && typeof incoming.proxyPoolConfig === 'object'
    ? incoming.proxyPoolConfig as Record<string, unknown>
    : {}
  const maxUsableLatencyMs = Math.max(
    100,
    Number(incomingProxyPoolConfig.maxUsableLatencyMs ?? currentProxyPoolConfig.maxUsableLatencyMs) || 2500
  )
  const proxyPoolConfig = {
    ...currentProxyPoolConfig,
    ...incomingProxyPoolConfig,
    maxUsableLatencyMs
  }
  const currentBindings = current.accountProxyBindings && typeof current.accountProxyBindings === 'object'
    ? current.accountProxyBindings as Record<string, string>
    : {}
  const incomingBindings = incoming.accountProxyBindings && typeof incoming.accountProxyBindings === 'object'
    ? incoming.accountProxyBindings as Record<string, string>
    : currentBindings
  const accountProxyBindings = { ...incomingBindings }
  const deletedProxyIds = new Set<string>([
    ...(Array.isArray(current._deletedProxyIds) ? current._deletedProxyIds.filter((id): id is string => typeof id === 'string') : []),
    ...(Array.isArray(incoming._deletedProxyIds) ? incoming._deletedProxyIds.filter((id): id is string => typeof id === 'string') : [])
  ])
  const proxyPool = { ...incomingProxyPool }
  for (const [id, value] of Object.entries(currentProxyPool)) {
    const source = value && typeof value === 'object'
      ? String((value as Record<string, unknown>).source || '')
      : ''
    if (source === IPLOCATE_PROXY_SOURCE && !(id in proxyPool) && !deletedProxyIds.has(id)) {
      proxyPool[id] = value
    }
  }
  const rejectedProxyIds = new Set<string>(deletedProxyIds)
  const rejectedProxyUrls = new Set<string>()
  for (const id of deletedProxyIds) {
    const removed = (proxyPool[id] || currentProxyPool[id]) as Record<string, unknown> | undefined
    if (typeof removed?.url === 'string') rejectedProxyUrls.add(removed.url)
    delete proxyPool[id]
  }
  for (const [accountId, binding] of Object.entries(accountProxyBindings)) {
    if (rejectedProxyIds.has(binding) || rejectedProxyUrls.has(binding)) {
      delete accountProxyBindings[accountId]
    }
  }
  return {
    ...current,
    ...incoming,
    accounts,
    proxyPool,
    proxyPoolConfig,
    accountProxyBindings,
    _deletedAccountIds: Array.from(deletedIds),
    _deletedProxyIds: Array.from(deletedProxyIds)
  }
}

function unsupported(method: string): { success: false; error: string } {
  return {
    success: false,
    error: `Web backend handler '${method}' is not implemented.`
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
    const latest = (await latestResponse.json()) as {
      version?: string
      description?: string
      dist?: { tarball?: string; unpackedSize?: number }
    }
    const latestVersion = String(latest.version || currentVersion).replace(/^v/i, '')
    let publishedAt: string | undefined
    try {
      const packageResponse = await fetch(KROUTER_NPM_PACKAGE_URL, {
        headers: { 'Accept': 'application/json' }
      })
      if (packageResponse.ok) {
        const metadata = (await packageResponse.json()) as { time?: Record<string, string> }
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
  } catch {
    try {
      const response = await fetch('https://api.github.com/repos/LightHaru/Krouter/releases/latest')
      if (!response.ok) throw new Error(`GitHub returned ${response.status}`)
      const release = (await response.json()) as {
        tag_name?: string
        name?: string
        body?: string
        html_url?: string
        published_at?: string
        assets?: Array<{ name?: string; browser_download_url?: string; size?: number }>
      }
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
  accountProxyBindings?: Record<string, string>
  proxyPool?: Record<string, { id?: string; url?: string; enabled?: boolean; status?: string }>
}

function errorMessageFromResult(result: unknown): string {
  const error = isPlainRecord(result) ? result.error : undefined
  if (isPlainRecord(error) && typeof error.message === 'string' && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'Unknown error'
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
    lowerError.includes('permanently_suspended') ||
    lowerError.includes('temporarily suspended') ||
    lowerError.includes('permanently suspended') ||
    (lowerError.includes('user id is') && lowerError.includes('suspended')) ||
    lowerError.includes('user id is temporarily suspended') ||
    lowerError.includes('account is locked') ||
    lowerError.includes('locked it as a security precaution') ||
    lowerError.includes('security precaution') ||
    lowerError.includes('unusual user activity') ||
    lowerError.includes('restricted your ability to use kiro') ||
    lowerError.includes('账户已封禁') ||
    lowerError.includes('已封禁') ||
    /\b423\b/.test(lowerError)
  )
}

function isDirectProxyUrl(value: unknown): value is string {
  return typeof value === 'string' && /^(https?|socks4a?|socks5h?):\/\//i.test(value.trim())
}

function resolveStoredAccountProxyUrl(accountData: StoredAccountData, accountId: string): string | undefined {
  const binding = accountData.accountProxyBindings?.[accountId]
  if (!binding) return undefined
  const proxyPool = accountData.proxyPool || {}
  const poolEntry = proxyPool[binding] || Object.values(proxyPool).find((proxy) => proxy.id === binding || proxy.url === binding)
  if (poolEntry?.url && poolEntry.enabled !== false && poolEntry.status !== 'dead') return poolEntry.url
  return isDirectProxyUrl(binding) ? binding.trim() : undefined
}

function withStoredAccountProxy(accountData: StoredAccountData, accountId: string, account: StoredAccount): StoredAccount {
  const proxyUrl = resolveStoredAccountProxyUrl(accountData, accountId)
  return proxyUrl ? { ...account, proxyUrl } : account
}

function isProfileArnOnlyAccountError(error?: string): boolean {
  if (!error) return false
  const lowerError = error.toLowerCase()
  return lowerError.includes('profilearn is required') ||
    lowerError.includes('no profilearn') ||
    lowerError.includes('without profilearn') ||
    lowerError.includes('no usable streaming profilearn') ||
    lowerError.includes('placeholder profilearn') ||
    lowerError.includes('model liveness skipped') ||
    lowerError.includes('credential and quota check passed')
}

function isTransientAccountError(error?: string): boolean {
  if (!error) return false
  const lowerError = error.toLowerCase()
  return lowerError.includes('fetch failed') ||
    lowerError.includes('network') ||
    lowerError.includes('timeout') ||
    lowerError.includes('timed out') ||
    lowerError.includes('econnreset') ||
    lowerError.includes('etimedout') ||
    lowerError.includes('socket hang up') ||
    lowerError.includes('too many requests') ||
    lowerError.includes('rate limited') ||
    /\b429\b/.test(lowerError)
}

function isHardAccountError(error?: string): boolean {
  if (!error) return false
  if (isBannedAccountError(error)) return true
  if (isTransientAccountError(error) || isProfileArnOnlyAccountError(error)) return false
  const info = classifyKiroAccountError(error)
  if (info.isAuthError) return true
  const lowerError = error.toLowerCase()
  return /\b403\b/.test(lowerError) ||
    lowerError.includes('bad credentials') ||
    lowerError.includes('invalid bearer') ||
    lowerError.includes('invalid token')
}

function shouldKeepStoredAccountLiveState(account: StoredAccount, error?: string): boolean {
  if (account.status !== 'active') return false
  if (isHardAccountError(error)) return false
  return isTransientAccountError(error) || isProfileArnOnlyAccountError(error)
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(parsed, max))
}

/**
 * Hình dạng phần `data` mà checkAccountStatus trả về — chỉ liệt kê những field mà server
 * thật sự đọc. API upstream có thể trả thêm field khác, chúng đi qua nguyên vẹn.
 */
interface BackgroundStatusData {
  newCredentials?: { accessToken?: string; refreshToken?: string; expiresAt?: number }
  subscription?: Record<string, unknown> & {
    type?: string
    title?: string
    rawType?: string
    subscriptionManagementTarget?: string
    managementTarget?: string
  }
  usage?: unknown
  subscriptionType?: string
  subscriptionTitle?: string
  daysRemaining?: number
  expiresAt?: number
  email?: string
  userId?: string
  profileArn?: string
  status?: string
  errorMessage?: string
}

/** Kết quả bọc ngoài của checkAccountStatus. */
interface BackgroundStatusResult {
  success?: boolean
  data?: BackgroundStatusData
  error?: unknown
}

function normalizeBackgroundStatusData(data: BackgroundStatusData | undefined): Record<string, unknown> {
  const credentials = data?.newCredentials
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

// Payload phát ra ngoài không được mang bí mật. Bản đầy đủ vẫn phải giữ lại cho
// applyRefreshDataToStoredAccount (nó cần accessToken/refreshToken để lưu store),
// nên chỉ lọc đúng ở ranh giới phát sự kiện.
type BackgroundResultPayload = { id: string; success: boolean; data?: unknown; error?: string }

function sanitizeBackgroundPayloadForEmit(payload: BackgroundResultPayload): BackgroundResultPayload {
  if (!isPlainRecord(payload.data)) return payload
  const safeData: Record<string, unknown> = { ...payload.data }
  delete safeData.accessToken
  delete safeData.refreshToken
  delete safeData.clientSecret
  // expiresIn/expiresAt phải đi cùng token. Nếu để lại, renderer sẽ fallback về accessToken
  // CŨ (accounts.ts: `refreshData?.accessToken || account.credentials.accessToken`) rồi gắn
  // hạn MỚI cho nó, ghi đè bản đúng của server -> token chết bị coi là còn sống và
  // accountNeedsBackendRefresh không bao giờ chọn nó nữa.
  delete safeData.expiresIn
  delete safeData.expiresAt
  return { ...payload, data: safeData }
}

/**
 * Đối chiếu kết quả merge với những gì store thật sự giữ lại sau khi ghi.
 * setAccountData còn chạy enforceDeletionTombstones nên một account vừa merge vẫn có thể
 * bị loại; nếu báo cáo dựng từ dữ liệu trước khi lọc thì API sẽ báo thành công cho account
 * đã biến mất.
 */
function reconcileMergeWithStore(
  merged: AccountMergeResult,
  userId: string
): {
  storedAccounts: Record<string, unknown>
  addedAccountIds: string[]
  droppedAccountIds: string[]
  syncedAccountIds: string[]
} {
  const stored = store.getAccountData(userId) as Record<string, unknown> | undefined
  const rawAccounts = stored?.accounts
  const storedAccounts = rawAccounts && typeof rawAccounts === 'object' ? (rawAccounts as Record<string, unknown>) : {}
  const addedAccountIds: string[] = []
  const droppedAccountIds: string[] = []
  for (const entry of merged.addedAccountTargets) {
    if (entry.targetId in storedAccounts) addedAccountIds.push(entry.sourceId)
    else droppedAccountIds.push(entry.sourceId)
  }
  if (droppedAccountIds.length > 0) {
    console.warn(`[AccountSync] ${droppedAccountIds.length} account bị store loại bỏ sau khi ghi:`, droppedAccountIds)
  }
  return {
    storedAccounts,
    addedAccountIds,
    droppedAccountIds,
    syncedAccountIds: merged.syncedAccountIds.filter((id) => !droppedAccountIds.includes(id))
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

function quotaResetDueForStoredAccount(account: StoredAccount, now = Date.now()): boolean {
  const reset = typeof account.usage?.nextResetDate === 'string' ? Date.parse(account.usage.nextResetDate) : NaN
  return Number.isFinite(reset) && reset <= now
}

function isStoredAccountQuotaExhausted(account: StoredAccount, now = Date.now()): boolean {
  if (quotaResetDueForStoredAccount(account, now)) return false
  const usage = account.usage || {}
  if (typeof usage.quotaExhaustedAt === 'number' && usage.quotaExhaustedAt > 0) return true
  const current = Number(usage.current)
  const limit = Number(usage.limit)
  return Number.isFinite(current) && Number.isFinite(limit) && limit > 0 && current >= limit
}

function normalizeStoredAccountLifecycle(account: StoredAccount, now = Date.now()): StoredAccount {
  const usage = isPlainRecord(account.usage) ? { ...account.usage } : {}
  const suspended = typeof usage.suspendedAt === 'number' && usage.suspendedAt > 0
  if (suspended || isBannedAccountError(account.lastError)) {
    if (typeof usage.suspendedAt !== 'number' || usage.suspendedAt <= 0) {
      usage.suspendedAt = now
    }
    return { ...account, status: 'blocked', usage }
  }

  if (quotaResetDueForStoredAccount({ ...account, usage }, now)) {
    delete usage.quotaExhaustedAt
    return {
      ...account,
      usage,
      status: account.status === 'quota_exhausted' ? 'active' : account.status,
      lastError: account.lastError === 'Quota exhausted until reset' ? undefined : account.lastError
    }
  }

  if (isStoredAccountQuotaExhausted({ ...account, usage }, now)) {
    return { ...account, usage, status: 'quota_exhausted', lastError: account.lastError || 'Quota exhausted until reset' }
  }

  return account.status === 'quota_exhausted'
    ? { ...account, usage, status: 'active', lastError: account.lastError === 'Quota exhausted until reset' ? undefined : account.lastError }
    : account
}

function getStoredAccounts(accountData: StoredAccountData): Record<string, StoredAccount> {
  return isPlainRecord(accountData.accounts) ? accountData.accounts as Record<string, StoredAccount> : {}
}

function applyRefreshDataToStoredAccount(
  id: string,
  account: StoredAccount,
  data: Record<string, unknown> | undefined,
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
  const errorMessage = typeof data?.errorMessage === 'string' && data.errorMessage ? data.errorMessage : undefined
  const currentBanned = isBannedAccountError(account.lastError)
  const incomingBanned = isBannedAccountError(errorMessage)
  const keepLive = data?.status === 'error' && shouldKeepStoredAccountLiveState(account, errorMessage)
  const status = keepLive ? 'active' : currentBanned || incomingBanned || data?.status === 'error' ? 'error' : 'active'
  const lastError = keepLive ? account.lastError : incomingBanned ? errorMessage : currentBanned ? account.lastError : errorMessage
  const lastCheckedAt = keepLive ? account.lastCheckedAt : now

  return normalizeStoredAccountLifecycle({
    ...account,
    id: account.id || id,
    email: typeof userInfo.email === 'string' && userInfo.email ? userInfo.email : account.email,
    userId: typeof userInfo.userId === 'string' && userInfo.userId ? userInfo.userId : account.userId,
    profileArn: typeof data?.profileArn === 'string' && data.profileArn ? data.profileArn : account.profileArn,
    credentials: nextCredentials,
    usage,
    subscription,
    status,
    lastError,
    lastCheckedAt
  }, now)
}

function applyBackendRefreshFailure(id: string, account: StoredAccount, error: string, now: number): StoredAccount {
  const currentBanned = isBannedAccountError(account.lastError)
  const incomingBanned = isBannedAccountError(error)
  if (shouldKeepStoredAccountLiveState(account, error)) {
    return normalizeStoredAccountLifecycle({
      ...account,
      id: account.id || id,
      status: 'active',
      lastError: account.lastError,
      lastCheckedAt: account.lastCheckedAt
    }, now)
  }
  return normalizeStoredAccountLifecycle({
    ...account,
    id: account.id || id,
    status: 'error',
    lastError: currentBanned && !incomingBanned ? account.lastError : error,
    lastCheckedAt: now
  }, now)
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
    const accounts = getStoredAccounts(accountData)
    let lifecycleChanged = false
    const now = Date.now()
    for (const [id, account] of Object.entries(accounts)) {
      const seeded = account.id ? account : { ...account, id }
      const normalized = normalizeStoredAccountLifecycle(seeded, now)
      if (seeded !== account || normalized !== seeded) {
        accounts[id] = normalized
        lifecycleChanged = true
      }
    }
    if (accountData.autoRefreshEnabled === false) {
      if (lifecycleChanged) {
        accountData.accounts = accounts
        await store.setAccountData(user.id, accountData)
        await getProxyRuntime(store, user.id, emitForUser(user.id)).syncAccountsFromStoreAsync()
      }
      return
    }
    const entries = Object.entries(accounts)
    const syncInfo = accountData.autoRefreshSyncInfo !== false
    const autoSwitch = Boolean(accountData.autoSwitchEnabled)
    const pending = entries
      .map(([id, account]) => ({
        id,
        account,
        needsTokenRefresh: accountNeedsBackendRefresh(account, now)
      }))
      .filter(({ account, needsTokenRefresh }) => {
        if (account.status === 'blocked' || isBannedAccountError(account.lastError)) return false
        if (isStoredAccountQuotaExhausted(account, now)) return false
        if (!account.credentials?.refreshToken) return false
        return needsTokenRefresh || syncInfo || autoSwitch
      })

    if (pending.length === 0) {
      if (lifecycleChanged) {
        accountData.accounts = accounts
        await store.setAccountData(user.id, accountData)
        await getProxyRuntime(store, user.id, emitForUser(user.id)).syncAccountsFromStoreAsync()
      }
      return
    }

    const concurrency = clampNumber(accountData.autoRefreshConcurrency, 5, 1, 100)
    let completed = 0
    let successCount = 0
    let failedCount = 0
    let changed = false
    // Collect refresh outcomes instead of mutating the stale snapshot. The write-back
    // re-reads fresh store state so a delete that lands during the (slow, networked)
    // refresh loop is not clobbered — otherwise the stale snapshot resurrects it.
    const refreshPayloads: Array<{ id: string; success: boolean; data?: Record<string, unknown>; error?: string; finishedAt: number }> = []
    console.log(`[BackendAutoRefresh] ${user.email}: processing ${pending.length} account(s), reason=${reason}, syncInfo=${syncInfo}`)

    for (let index = 0; index < pending.length; index += concurrency) {
      const batch = pending.slice(index, index + concurrency)
      await Promise.all(batch.map(async ({ id, account, needsTokenRefresh }) => {
        const accountForApi = withStoredAccountProxy(accountData, id, account)
        const backgroundAccount: BackgroundAccount = {
          ...accountForApi,
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
            const status = (await checkAccountStatus(
          accountForStatusCheck(backgroundAccount, needsTokenRefresh)
        )) as BackgroundStatusResult
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
        } else {
          failedCount++
        }
        refreshPayloads.push({
          id,
          success: payload.success,
          data: payload.data as Record<string, unknown> | undefined,
          error: payload.error,
          finishedAt
        })
        changed = true
        emitToUser(user.id, 'background-refresh-result', sanitizeBackgroundPayloadForEmit(payload))
      }))

      completed += batch.length
      emitToUser(user.id, 'background-refresh-progress', { completed, total: pending.length, success: successCount, failed: failedCount })
      if (index + concurrency < pending.length) await new Promise((resolve) => setTimeout(resolve, 100))
    }

    if (changed || lifecycleChanged) {
      // Re-read fresh store state at write-back time. Between the initial snapshot
      // (top of this function) and now, the user may have deleted accounts via
      // saveAccounts — which persists a tombstone AND removes the account. If we wrote
      // back the stale in-memory snapshot we'd resurrect the just-deleted account.
      // So we merge our refresh results into the FRESH data, skipping any account that
      // no longer exists or is tombstoned.
      const freshData = (store.getAccountData(user.id) || defaultAccountData()) as StoredAccountData
      const freshAccounts = getStoredAccounts(freshData)
      const tombstoned = new Set<string>(
        Array.isArray(freshData._deletedAccountIds)
          ? (freshData._deletedAccountIds as unknown[]).filter((id): id is string => typeof id === 'string')
          : []
      )
      const writeBackNow = Date.now()

      // Re-apply lifecycle normalization on the fresh accounts (cheap, idempotent).
      for (const [id, account] of Object.entries(freshAccounts)) {
        if (tombstoned.has(id)) continue
        const seeded = account.id ? account : { ...account, id }
        freshAccounts[id] = normalizeStoredAccountLifecycle(seeded, writeBackNow)
      }

      // Apply refresh outcomes only to accounts that still exist and are not tombstoned.
      for (const payload of refreshPayloads) {
        if (tombstoned.has(payload.id)) continue
        const current = freshAccounts[payload.id]
        if (!current) continue
        freshAccounts[payload.id] = payload.success
          ? applyRefreshDataToStoredAccount(payload.id, current, payload.data, payload.finishedAt)
          : applyBackendRefreshFailure(payload.id, current, payload.error || 'Unknown error', payload.finishedAt)
      }

      freshData.accounts = freshAccounts
      await store.setAccountData(user.id, freshData)
      await getProxyRuntime(store, user.id, emitForUser(user.id)).syncAccountsFromStoreAsync()
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
  backendAutoRefreshIntervals.delete(userId)
}

function scheduleBackendAutoRefreshForUser(user: UserRecord, runNow: boolean): void {
  if (!backendAutoRefreshEnabled()) {
    clearBackendAutoRefreshForUser(user.id)
    return
  }
  const accountData = (store.getAccountData(user.id) || defaultAccountData()) as StoredAccountData
  if (accountData.autoRefreshEnabled === false) {
    console.log(`[BackendAutoRefresh] ${user.email}: token refresh disabled; account lifecycle reconciliation remains enabled`)
  }

  const intervalMinutes = clampNumber(accountData.autoRefreshInterval, 5, 1, 1440)
  const intervalMs = Math.max(BACKEND_AUTO_REFRESH_MIN_INTERVAL_MS, intervalMinutes * 60 * 1000)

  // Hàm này được gọi lại sau MỌI lần saveAccounts, mà dashboard autosave 30 giây/lần.
  // Nếu vô điều kiện clearInterval + setInterval thì chu kỳ 5 phút không bao giờ chạm mốc
  // và token trên VPS hết hạn mà không có gì refresh. Chỉ dựng lại timer khi chu kỳ đổi.
  const existing = backendAutoRefreshTimers.get(user.id)
  if (existing && backendAutoRefreshIntervals.get(user.id) === intervalMs) {
    if (runNow) {
      const bootTimer = setTimeout(() => {
        void runBackendAutoRefreshForUser(user, 'server-boot')
      }, 2000)
      bootTimer.unref?.()
    }
    return
  }

  clearBackendAutoRefreshForUser(user.id)
  const timer = setInterval(() => {
    void runBackendAutoRefreshForUser(user, 'interval')
  }, intervalMs)
  timer.unref?.()
  backendAutoRefreshTimers.set(user.id, timer)
  backendAutoRefreshIntervals.set(user.id, intervalMs)

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

function proxyMaintenanceRuntimeForUser(user: UserRecord): ProxyMaintenanceRuntime {
  return getProxyMaintenanceRuntime(store, user.id, emitForUser(user.id), async () => {
    await getProxyRuntime(store, user.id, emitForUser(user.id)).syncAccountsFromStoreAsync()
  })
}

function scheduleProxyMaintenanceForUser(user: UserRecord, runOnBoot: boolean): void {
  proxyMaintenanceRuntimeForUser(user).configure(runOnBoot)
}

async function startProxyMaintenanceRuntimes(): Promise<void> {
  for (const user of store.getUsers()) {
    scheduleProxyMaintenanceForUser(user, true)
  }
}

async function handleBackgroundBatch(method: string, args: unknown[], user: UserRecord): Promise<{
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
          const status = (await checkAccountStatus(
            accountForStatusCheck(account, allowRefresh)
          )) as BackgroundStatusResult
          payload = status?.success && status.data
            ? { id: account.id, success: true, data: normalizeBackgroundStatusData(status.data) }
            : { id: account.id, success: false, error: errorMessageFromResult(status) }
        }
      } catch (error) {
        payload = { id: account.id, success: false, error: error instanceof Error ? error.message : String(error) }
      }

      if (payload.success) successCount++
      else failedCount++
      // Luồng này do chính user gọi và renderer cần token mới trả về để cập nhật
      // store phía client, nên giữ nguyên payload nhưng chỉ gửi cho đúng user đó.
      emitToUser(user.id, resultChannel, payload)
    }))

    completed += batch.length
    emitToUser(user.id, progressChannel, { completed, total: accounts.length, success: successCount, failed: failedCount })
    if (index + concurrency < accounts.length) await new Promise((resolve) => setTimeout(resolve, 100))
  }

  return { success: true, completed, successCount, failedCount }
}

async function handleIpc(method: string, args: unknown[], user: UserRecord): Promise<unknown> {
  const settings = store.getUserSettings(user.id)
  const proxyRuntime = getProxyRuntime(store, user.id, emitForUser(user.id))
  const kproxyRuntime = getKProxyRuntime(store, user.id, emitForUser(user.id))
  switch (method) {
    case 'accountSyncGetStatus':
      return accountSyncPasswordStatus(user)
    case 'accountSyncGeneratePassword':
      {
        const password = makeAccountSyncPassword()
        const setting = await saveAccountSyncPassword(user, password)
        return {
          success: true,
          enabled: true,
          password,
          createdAt: setting.createdAt,
          updatedAt: setting.updatedAt
        }
      }
    case 'accountSyncSetPassword':
      {
        const body = args[0] && typeof args[0] === 'object' ? args[0] as Record<string, unknown> : {}
        const setting = await saveAccountSyncPassword(user, String(body.password || ''))
        return {
          success: true,
          enabled: true,
          createdAt: setting.createdAt,
          updatedAt: setting.updatedAt
        }
      }
    case 'getAppVersion':
      return packageVersion()
    case 'loadAccounts':
      {
        // Loading the Accounts page must remain a local operation. Resolving a
        // missing profile ARN can refresh credentials and call Kiro endpoints;
        // doing that here made one slow/offline account block the whole UI.
        // Proxy maintenance and explicit account checks perform hydration where
        // network failures can be isolated per account.
        return (store.getAccountData(user.id) || defaultAccountData()) as Record<string, unknown>
      }
    case 'saveAccounts':
      {
        const merged = mergeAccountData(store.getAccountData(user.id), args[0])
        const hydrated = await hydrateAccountDataProfileArns(merged)
        await store.setAccountData(user.id, hydrated.data)
        await getProxyRuntime(store, user.id, emitForUser(user.id)).syncRoutingStateFromStore()
        scheduleBackendAutoRefreshForUser(user, false)
        scheduleProxyMaintenanceForUser(user, false)
      }
      return null
    case 'mergePeerAccounts':
      {
        const merged = mergePeerAccountData(store.getAccountData(user.id) || defaultAccountData(), args[0])
        const hydrated = await hydrateAccountDataProfileArns(merged.data)
        await store.setAccountData(user.id, hydrated.data)
        await getProxyRuntime(store, user.id, emitForUser(user.id)).syncRoutingStateFromStore()
        scheduleBackendAutoRefreshForUser(user, false)
        scheduleProxyMaintenanceForUser(user, false)
        const reconciled = reconcileMergeWithStore(merged, user.id)
        return {
          success: true,
          totalIncoming: merged.totalIncoming,
          added: reconciled.addedAccountIds.length,
          skipped: merged.skipped,
          addedAccountIds: reconciled.addedAccountIds,
          droppedAccountIds: reconciled.droppedAccountIds,
          skippedAccountIds: merged.skippedAccountIds,
          skippedAccounts: merged.skippedAccounts,
          syncedAccountIds: reconciled.syncedAccountIds,
          remoteAccounts: summarizeAccounts(reconciled.storedAccounts),
          remoteTotal: Object.keys(reconciled.storedAccounts).length
        }
      }
    case 'syncAccountsToRemote':
      return pushAccountDataToRemote(args[0] as Parameters<typeof pushAccountDataToRemote>[0], store.getAccountData(user.id) || defaultAccountData())
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
      return startSocialLogin(args[0] as 'Google' | 'Github', user.id)
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
    case 'checkForUpdates':
      return checkForUpdatesManual()
    case 'checkForUpdatesManual':
      return checkForUpdatesManual()
    case 'applyKrouterUpdate':
    case 'installKrouterUpdate':
      return applyKrouterUpdate()
    case 'proxyGetStatus':
      return proxyRuntime.getStatus()
    case 'proxyGetUsageAnalytics':
      return proxyRuntime.getUsageAnalytics(args[0] as Parameters<typeof proxyRuntime.getUsageAnalytics>[0])
    case 'proxyClearUsageAnalytics':
      return proxyRuntime.clearUsageAnalytics()
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
    case 'proxySaveLogs': {
      // store.json bị ghi lại toàn bộ ở mỗi lần mutate, nên log của client phải
      // bị chặn cả về kiểu, số dòng lẫn kích thước đã serialize.
      const incomingLogs = args[0]
      if (!Array.isArray(incomingLogs)) {
        return { success: false, error: 'proxySaveLogs requires an array of log entries' }
      }
      const trimmedLogs = incomingLogs.slice(-PROXY_LOGS_MAX_ENTRIES)
      const serializedBytes = Buffer.byteLength(JSON.stringify(trimmedLogs), 'utf8')
      if (serializedBytes > PROXY_LOGS_MAX_BYTES) {
        console.warn(`[Server] proxySaveLogs bị từ chối: ${serializedBytes} bytes vượt giới hạn ${PROXY_LOGS_MAX_BYTES}`)
        return { success: false, error: 'Proxy logs payload is too large' }
      }
      await store.setUserSetting(user.id, 'proxyLogs', trimmedLogs)
      return { success: true }
    }
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
    case 'proxyProbeModels':
      return proxyRuntime.probeModels(args[0] as { modelIds?: string[]; concurrency?: number } | undefined)
    case 'proxyGetModelProbeResults':
      return proxyRuntime.getModelProbeResults()
    case 'proxyTestBedrock':
      return proxyRuntime.testBedrock(args[0] as Parameters<typeof proxyRuntime.testBedrock>[0])
    case 'proxyGetBedrockStatus':
      return proxyRuntime.getBedrockStatus()
    case 'chatgptOAuthGetStatus':
      return proxyRuntime.getChatGPTOAuthStatus()
    case 'chatgptOAuthStart':
      return proxyRuntime.startChatGPTOAuth()
    case 'chatgptOAuthSubmitCallback':
      return proxyRuntime.submitChatGPTOAuthCallback(String(args[0] || ''))
    case 'chatgptOAuthRefresh':
      return proxyRuntime.refreshChatGPTCodexState(String(args[0] || '') || undefined)
    case 'chatgptOAuthCancel':
      return proxyRuntime.cancelChatGPTOAuth()
    case 'chatgptOAuthLogout':
      return proxyRuntime.logoutChatGPTAccount(String(args[0] || '') || undefined)
    case 'proxyTestXpixi':
      return proxyRuntime.testXpixi(args[0] as Parameters<typeof proxyRuntime.testXpixi>[0])
    case 'proxyTestCustomApi':
      return proxyRuntime.testCustomApi(args[0] as Parameters<typeof proxyRuntime.testCustomApi>[0])
    case 'getKiroAvailableModels':
      return getKiroAvailableModels(
        store.getAccountData(user.id) as { accounts?: Record<string, unknown> } | undefined
      )
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
    case 'proxyMaintenanceGetStatus':
      return proxyMaintenanceRuntimeForUser(user).getStatus()
    case 'proxyMaintenanceRunNow':
      return proxyMaintenanceRuntimeForUser(user).runNow('manual')
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
      return registrationStartAuto(args[0] as Parameters<typeof registrationStartAuto>[0], emitForUser(user.id))
    case 'registrationManualPhase1':
      return registrationManualPhase1(args[0] as Parameters<typeof registrationManualPhase1>[0], emitForUser(user.id))
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
      const accountData = (store.getAccountData(user.id) || defaultAccountData()) as Record<string, unknown>
      // Giữ tham chiếu có kiểu để không phải ép kiểu lại ở từng lần truy cập.
      const bindings: Record<string, string> = {
        ...((accountData.accountProxyBindings as Record<string, string> | undefined) || {})
      }
      accountData.accountProxyBindings = bindings
      if (!proxyUrl) {
        delete bindings[accountId]
      } else {
        const proxyPool = (accountData.proxyPool as Record<string, unknown> | undefined) || {}
        const matchingProxyId = Object.entries(proxyPool).find(([, proxy]) => {
          const entry = proxy as { id?: string; url?: string }
          return entry.id === proxyUrl || entry.url === proxyUrl
        })?.[0]
        bindings[accountId] = matchingProxyId || proxyUrl
      }
      await store.setAccountData(user.id, accountData)
      return { success: true }
    }
    case 'backgroundBatchRefresh':
    case 'backgroundBatchCheck':
      return handleBackgroundBatch(method, args, user)
    // Phase 13: Skills system
    case 'fetchSkillsList':
      return proxyRuntime.fetchSkillsList()
    case 'fetchSkillContent':
      return proxyRuntime.fetchSkillContent(String(args[0] || ''))
    // Phase 8: Account health dashboard
    case 'proxyGetAccountHealth':
      return proxyRuntime.getAccountHealth()
    // Phase 9: Quota predictions
    case 'proxyGetQuotaPredictions':
      return proxyRuntime.getQuotaPredictions()
    // Phase 7/10: Endpoint metrics
    case 'proxyGetEndpointMetrics':
      return proxyRuntime.getEndpointMetrics()
    case 'proxyResetEndpointMetrics':
      return proxyRuntime.resetEndpointMetrics()
    // Phase 12: MITM model mappings
    case 'kproxyGetModelMappings':
      return kproxyRuntime.getModelMappings()
    case 'kproxySaveModelMappings':
      return kproxyRuntime.saveModelMappings(args[0] as unknown[])
    case 'kproxyGetHostsStatus':
      return kproxyRuntime.getHostsStatus()
    case 'kproxyToggleHosts':
      return kproxyRuntime.toggleHosts(Boolean(args[0]))
    case 'kproxySetHostsIdeTypes':
      return kproxyRuntime.setHostsIdeTypes(Array.isArray(args[0]) ? args[0] as string[] : [])
    // Phase 12: MITM HTTPS server
    case 'mitmGetStatus':
      return kproxyRuntime.mitmGetStatus()
    case 'mitmStart':
      return kproxyRuntime.mitmStart(args[0] as { port?: number } | undefined)
    case 'mitmStop':
      return kproxyRuntime.mitmStop()
    default:
      return unsupported(method)
  }
}

async function handleAuth(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (pathname === '/api/auth/social/callback' && request.method === 'GET') {
    const callbackUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
    const result = handleSocialCallback(callbackUrl, (uid) => (uid ? emitForUser(uid) : emit))
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
      scheduleProxyMaintenanceForUser(user, false)
      response.setHeader('Set-Cookie', sessionCookie(request, session.id, session.expiresAt))
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
    if (rejectWhenThrottled(request, response, 'login')) return
    const throttleKey = `login:${clientIp(request)}`
    const body = await readJson(request)
    const email = String(body?.email || '').trim()
    const user = email
      ? store.findUserByEmail(email)
      : store.getUsers().find(item => item.role === 'admin') || store.getUsers()[0]
    if (!user || !(await verifyPasswordAsync(String(body?.password || ''), user))) {
      registerAuthFailure(throttleKey)
      sendJson(response, 401, { error: email ? 'Invalid email or password' : 'Invalid password' })
      return
    }
    clearAuthFailures(throttleKey)
    const session = await store.createSession(user.id)
    response.setHeader('Set-Cookie', sessionCookie(request, session.id, session.expiresAt))
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

async function handleAccountSyncMerge(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'Method not allowed' })
    return
  }
  if (store.isSetupRequired()) {
    sendJson(response, 428, { error: 'Krouter setup is required first', setupRequired: true })
    return
  }
  const user = getAccountSyncUser()
  if (!user) {
    sendJson(response, 401, { error: 'No account sync user is configured' })
    return
  }
  const setting = getAccountSyncPasswordSetting(user)
  if (!setting.enabled || !setting.hash || !setting.salt) {
    sendJson(response, 403, { error: 'Account sync password is not configured. Run krouter sync-password on the VPS.' })
    return
  }
  if (rejectWhenThrottled(request, response, 'account-sync')) return
  const throttleKey = `account-sync:${clientIp(request)}`

  // Endpoint này mang nhiều account nên cần hạn mức body lớn hơn mặc định.
  const body = await readJson(request, ACCOUNT_SYNC_MAX_BODY_BYTES)
  const syncPassword = String(body?.syncPassword || '')
  if (!(await verifyAccountSyncPassword(user, syncPassword))) {
    registerAuthFailure(throttleKey)
    sendJson(response, 401, { error: 'Invalid account sync password' })
    return
  }
  clearAuthFailures(throttleKey)

  const incoming = body?.accountData && typeof body.accountData === 'object' ? body.accountData : body
  const merged = mergePeerAccountData(store.getAccountData(user.id) || defaultAccountData(), incoming)
  const hydrated = await hydrateAccountDataProfileArns(merged.data)
  await store.setAccountData(user.id, hydrated.data)
  await getProxyRuntime(store, user.id, emitForUser(user.id)).syncRoutingStateFromStore()
  scheduleBackendAutoRefreshForUser(user, false)
  const reconciled = reconcileMergeWithStore(merged, user.id)
  sendJson(response, 200, {
    success: true,
    totalIncoming: merged.totalIncoming,
    added: reconciled.addedAccountIds.length,
    skipped: merged.skipped,
    addedAccountIds: reconciled.addedAccountIds,
    droppedAccountIds: reconciled.droppedAccountIds,
    skippedAccountIds: merged.skippedAccountIds,
    skippedAccounts: merged.skippedAccounts,
    syncedAccountIds: reconciled.syncedAccountIds,
    remoteAccounts: summarizeAccounts(reconciled.storedAccounts),
    remoteTotal: Object.keys(reconciled.storedAccounts).length
  })
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
    const cacheControl = ext === '.html'
      ? 'no-store, no-cache, must-revalidate'
      : requested.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache'
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': cacheControl,
    })
    response.end(data)
  } catch {
    const indexPath = path.join(dist, 'index.html')
    try {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      })
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

  if (url.pathname === '/api/account-sync/merge') {
    await handleAccountSyncMerge(request, response)
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
    const client: SseClient = { res: response, userId: user.id }
    sseClients.add(client)
    request.on('close', () => sseClients.delete(client))
    return
  }

  if (url.pathname === '/api/ipc' && request.method === 'POST') {
    const user = getApiUser(request)
    if (!user) {
      sendJson(response, 401, { error: 'Unauthorized' })
      return
    }
    const body = await readJson(request, IPC_MAX_BODY_BYTES)
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

function errorStatusCode(error: unknown): number {
  const candidate = (error as { statusCode?: unknown })?.statusCode
  return typeof candidate === 'number' && candidate >= 400 && candidate <= 599 ? candidate : 500
}

// Không có handler nào cho unhandledRejection/uncaughtException thì một lỗi lẻ
// cũng đủ giết tiến trình mà không để lại dấu vết. Ở đây luôn log thật to.
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled promise rejection:', reason)
})

process.on('uncaughtException', (error) => {
  console.error('[Server] Uncaught exception:', error)
  const code = (error as NodeJS.ErrnoException).code
  // Lỗi socket lẻ tẻ (client tự ngắt, header đã gửi) không làm hỏng state nên
  // tiếp tục chạy. Mọi lỗi khác có thể để lại state dở dang: thoát khác 0 sau
  // một nhịp ngắn cho log kịp flush để supervisor khởi động lại.
  if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_HTTP_HEADERS_SENT') return
  setTimeout(() => process.exit(1), 100)
})

async function main(): Promise<void> {
  await store.load()
  startAutoProxyRuntimes().catch((error) => console.error('[startup] startAutoProxyRuntimes failed:', error))
  startAutoKProxyRuntimes().catch((error) => console.error('[startup] startAutoKProxyRuntimes failed:', error))
  startBackendAutoRefreshRuntimes().catch((error) => console.error('[startup] startBackendAutoRefreshRuntimes failed:', error))
  startProxyMaintenanceRuntimes().catch((error) => console.error('[startup] startProxyMaintenanceRuntimes failed:', error))
  const port = Number(process.env.PORT || 4010)
  const host = process.env.HOST || '127.0.0.1'
  const server = http.createServer((request, response) => {
    route(request, response).catch((error) => {
      console.error('[Server] Request failed:', error)
      if (response.headersSent) {
        response.end()
        return
      }
      const status = errorStatusCode(error)
      // Body bị chặn vì quá lớn: request chưa đọc hết nên phải đóng kết nối sau khi
      // đã ghi xong phản hồi, nếu không client sẽ tiếp tục gửi vào một socket đã hết ý nghĩa.
      if (status === 413) {
        response.writeHead(413, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'close'
        })
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Payload too large' }), () => {
          request.destroy()
        })
        return
      }
      sendJson(response, status, { error: error instanceof Error ? error.message : 'Internal server error' })
    })
  })

  /**
   * Gỡ block hosts của Krouter khi tắt, nếu nó đang bật.
   *
   * Có ngân sách thời gian RIÊNG và nhỏ hơn SHUTDOWN_TIMEOUT_MS: trên Windows không chạy
   * quyền cao, hostsManager phải nâng quyền để ghi, và thao tác đó có thể chờ người dùng.
   * Không được để nó nuốt hết ngân sách tắt máy rồi khiến store không kịp lưu.
   *
   * Không bao giờ ném ra ngoài — tắt máy phải chạy tiếp dù bước này hỏng.
   */
  async function restoreHostsOnShutdown(): Promise<void> {
    const HOSTS_RESTORE_BUDGET_MS = 8_000
    try {
      const { hostsManager } = await import('../main/kproxy/hostsManager')
      const status = await hostsManager.getStatus()
      if (!status.enabled) return

      await Promise.race([
        hostsManager.removeEntries(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`quá ${HOSTS_RESTORE_BUDGET_MS}ms`)),
            HOSTS_RESTORE_BUDGET_MS
          )
        )
      ])
      console.log('[Server] Đã gỡ chuyển hướng hosts')
    } catch (error) {
      // In thật to: máy người dùng đang ở trạng thái hỏng DNS và họ cần biết để sửa tay.
      console.error(
        '[Server] KHÔNG gỡ được chuyển hướng hosts:',
        error instanceof Error ? error.message : error
      )
      console.error(
        '[Server] Các tên miền kiro.dev / amazonaws.com / githubcopilot.com / cursor.com có thể ' +
          'vẫn đang trỏ về 127.0.0.1 trên toàn máy. Hãy chạy lại Krouter rồi tắt chuyển hướng ' +
          'hosts, hoặc sửa tay file hosts với quyền quản trị.'
      )
    }
  }

  // Điểm tắt máy duy nhất của tiến trình: ngừng nhận kết nối mới, dừng tunnel,
  // ghi nốt store rồi mới thoát. Module tunnel không được tự ý gọi process.exit.
  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[Server] Nhận ${signal}, đang tắt an toàn...`)
    const forceExit = setTimeout(() => {
      console.error(`[Server] Tắt an toàn quá ${SHUTDOWN_TIMEOUT_MS}ms, thoát cưỡng bức`)
      process.exit(1)
    }, SHUTDOWN_TIMEOUT_MS)
    void (async () => {
      try {
        server.close()
        for (const client of sseClients) {
          try {
            client.res.end()
          } catch {
            // best effort
          }
        }
        sseClients.clear()
        dashboardTunnelRuntime.stopSync()

        // Gỡ chuyển hướng hosts TRƯỚC khi thoát.
        //
        // K-Proxy trỏ kiro.dev / amazonaws.com / githubcopilot.com / cursor.com về 127.0.0.1
        // trên TOÀN MÁY. Nếu tiến trình chết mà không gỡ, các tên miền đó vẫn trỏ vào một cổng
        // không còn ai nghe — Kiro IDE, Copilot và Cursor hỏng cho tới khi người dùng sửa tay
        // file hosts. Trên VPS thì một lần restart hay OOM-kill là đủ để rơi vào trạng thái đó.
        //
        // removeEntries() chỉ xoá block nằm giữa marker của Krouter nên entry do người dùng
        // tự thêm không bao giờ bị đụng tới.
        await restoreHostsOnShutdown()

        await store.save()
      } catch (error) {
        console.error('[Server] Lỗi khi tắt an toàn:', error)
      } finally {
        clearTimeout(forceExit)
        process.exit(0)
      }
    })()
  }
  process.once('SIGINT', () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))

  server.listen(port, host, () => {
    const mode = serveStaticAssets ? 'fullstack web/API' : 'backend CLI API'
    startDashboardTunnelIfConfigured().catch((error) => console.error('[startup] startDashboardTunnelIfConfigured failed:', error))
    console.log(`[Server] Krouter ${mode} đang chạy tại http://${host}:${port}`)
  })
}

main().catch((error) => {
  console.error('[Server] Fatal startup failure:', error)
  process.exit(1)
})
