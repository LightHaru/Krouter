import crypto from 'crypto'

type StoredRecord = Record<string, unknown>

export interface RemoteSyncInput {
  targetUrl?: string
  syncPassword?: string
  adminEmail?: string
  adminPassword?: string
  timeoutMs?: number
}

export interface AccountMergeSkip {
  id: string
  email?: string
  existingId?: string
  reason: string
}

export interface AccountMergeResult {
  success: true
  data: StoredRecord
  totalIncoming: number
  added: number
  skipped: number
  skippedAccounts: AccountMergeSkip[]
  syncedAccountIds: string[]
}

export interface AccountMergeResponse {
  success: true
  totalIncoming: number
  added: number
  skipped: number
  remoteTotal?: number
  skippedAccounts: AccountMergeSkip[]
  syncedAccountIds?: string[]
}

export interface RemoteSyncResult {
  success: boolean
  targetUrl?: string
  totalIncoming?: number
  added?: number
  skipped?: number
  remoteTotal?: number
  skippedAccounts?: AccountMergeSkip[]
  syncedAccountIds?: string[]
  error?: string
}

function isRecord(value: unknown): value is StoredRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function recordOf(value: unknown): Record<string, StoredRecord> {
  if (!isRecord(value)) return {}
  const out: Record<string, StoredRecord> = {}
  for (const [key, child] of Object.entries(value)) {
    if (isRecord(child)) out[key] = child
  }
  return out
}

function clean(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

function accountCredentials(account: StoredRecord): StoredRecord {
  return isRecord(account.credentials) ? account.credentials : {}
}

function accountProvider(account: StoredRecord): string {
  const credentials = accountCredentials(account)
  return clean(credentials.provider || account.idp || credentials.authMethod || 'unknown')
}

function isPlaceholderProfileArn(value: string): boolean {
  if (!value) return true
  return value.includes('aaaaccccxxxx') || value.includes('placeholder')
}

function duplicateKeys(account: StoredRecord): string[] {
  const credentials = accountCredentials(account)
  const provider = accountProvider(account)
  const keys: string[] = []
  const email = clean(account.email)
  const userId = clean(account.userId)
  const profileArn = clean(account.profileArn)
  const refreshToken = String(credentials.refreshToken || '').trim()
  const kiroApiKey = String(credentials.kiroApiKey || '').trim()

  if (userId) keys.push(`user:${provider}:${userId}`)
  if (email) keys.push(`email:${provider}:${email}`)
  if (profileArn && !isPlaceholderProfileArn(profileArn)) keys.push(`profile:${profileArn}`)
  if (refreshToken) keys.push(`refresh:${crypto.createHash('sha256').update(refreshToken).digest('hex')}`)
  if (kiroApiKey) keys.push(`api-key:${crypto.createHash('sha256').update(kiroApiKey).digest('hex')}`)
  return keys
}

function buildDuplicateIndex(accounts: Record<string, StoredRecord>): Map<string, string> {
  const index = new Map<string, string>()
  for (const [id, account] of Object.entries(accounts)) {
    const accountId = String(account.id || id)
    for (const key of duplicateKeys({ ...account, id: accountId })) {
      if (!index.has(key)) index.set(key, accountId)
    }
  }
  return index
}

export function mergePeerAccountData(currentRaw: unknown, incomingRaw: unknown): AccountMergeResult {
  const current = isRecord(currentRaw) ? currentRaw : {}
  const incoming = isRecord(incomingRaw) ? incomingRaw : {}
  const currentAccounts = recordOf(current.accounts)
  const incomingAccounts = recordOf(incoming.accounts)
  const currentGroups = recordOf(current.groups)
  const incomingGroups = recordOf(incoming.groups)
  const currentTags = recordOf(current.tags)
  const incomingTags = recordOf(incoming.tags)

  const accounts: Record<string, StoredRecord> = { ...currentAccounts }
  const duplicateIndex = buildDuplicateIndex(accounts)
  const skippedAccounts: AccountMergeSkip[] = []
  const syncedAccountIds: string[] = []
  let added = 0

  for (const [rawId, rawAccount] of Object.entries(incomingAccounts)) {
    const sourceId = String(rawAccount.id || rawId || crypto.randomUUID())
    const account: StoredRecord = { ...rawAccount, id: sourceId, isActive: false }
    const keys = duplicateKeys(account)
    const existingId = keys.map((key) => duplicateIndex.get(key)).find(Boolean)
    if (existingId) {
      skippedAccounts.push({
        id: sourceId,
        email: typeof account.email === 'string' ? account.email : undefined,
        existingId,
        reason: 'account_exists'
      })
      syncedAccountIds.push(sourceId)
      continue
    }

    let targetId = sourceId
    if (accounts[targetId]) targetId = crypto.randomUUID()
    accounts[targetId] = { ...account, id: targetId, isActive: false }
    for (const key of duplicateKeys(accounts[targetId])) {
      if (!duplicateIndex.has(key)) duplicateIndex.set(key, targetId)
    }
    added++
    syncedAccountIds.push(sourceId)
  }

  return {
    success: true,
    data: {
      ...current,
      groups: { ...currentGroups, ...incomingGroups },
      tags: { ...currentTags, ...incomingTags },
      accounts
    },
    totalIncoming: Object.keys(incomingAccounts).length,
    added,
    skipped: skippedAccounts.length,
    skippedAccounts,
    syncedAccountIds
  }
}

function normalizeTargetUrl(value: unknown): string {
  const raw = String(value || '').trim()
  if (!raw) throw new Error('Remote Krouter URL is required')
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Remote Krouter URL must start with http:// or https://')
  }
  return url.origin
}

function cookieFromLogin(response: Response): string {
  const anyHeaders = response.headers as Headers & { getSetCookie?: () => string[] }
  const cookies = typeof anyHeaders.getSetCookie === 'function'
    ? anyHeaders.getSetCookie()
    : [response.headers.get('set-cookie') || '']
  return cookies
    .filter(Boolean)
    .map((cookie) => cookie.split(';')[0])
    .join('; ')
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    const text = await response.text()
    const data = text ? JSON.parse(text) : null
    if (!response.ok) {
      throw new Error(data?.error || data?.message || response.statusText)
    }
    return data as T
  } finally {
    clearTimeout(timer)
  }
}

export async function pushAccountDataToRemote(input: RemoteSyncInput = {}, localAccountData: unknown): Promise<RemoteSyncResult> {
  try {
    const targetUrl = normalizeTargetUrl(input.targetUrl)
    const syncPassword = String(input.syncPassword || '').trim()
    const adminPassword = String(input.adminPassword || '')
    if (!syncPassword && !adminPassword) throw new Error('Remote sync password is required')
    const timeoutMs = Math.max(5000, Math.min(Number(input.timeoutMs) || 30000, 120000))
    const accountData = isRecord(localAccountData) ? localAccountData : {}
    const payload = {
      accounts: recordOf(accountData.accounts),
      groups: recordOf(accountData.groups),
      tags: recordOf(accountData.tags)
    }

    if (syncPassword) {
      const remoteResult = await postJson<AccountMergeResponse>(
        `${targetUrl}/api/account-sync/merge`,
        { syncPassword, accountData: payload },
        {},
        timeoutMs
      )

      return {
        success: true,
        targetUrl,
        totalIncoming: remoteResult.totalIncoming,
        added: remoteResult.added,
        skipped: remoteResult.skipped,
        remoteTotal: remoteResult.remoteTotal,
        skippedAccounts: remoteResult.skippedAccounts,
        syncedAccountIds: remoteResult.syncedAccountIds || []
      }
    }

    const loginResponse = await fetch(`${targetUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: String(input.adminEmail || '').trim(),
        password: adminPassword
      })
    })
    const loginText = await loginResponse.text()
    const loginData = loginText ? JSON.parse(loginText) : null
    if (!loginResponse.ok) {
      throw new Error(loginData?.error || loginData?.message || `Remote login failed (${loginResponse.status})`)
    }
    const cookie = cookieFromLogin(loginResponse)
    if (!cookie) throw new Error('Remote login did not return a session cookie')

    const remoteResult = await postJson<AccountMergeResponse>(
      `${targetUrl}/api/ipc`,
      { method: 'mergePeerAccounts', args: [payload] },
      { Cookie: cookie },
      timeoutMs
    )

    return {
      success: true,
      targetUrl,
      totalIncoming: remoteResult.totalIncoming,
      added: remoteResult.added,
      skipped: remoteResult.skipped,
      remoteTotal: remoteResult.remoteTotal,
      skippedAccounts: remoteResult.skippedAccounts,
      syncedAccountIds: remoteResult.syncedAccountIds || []
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
