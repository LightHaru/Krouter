import { promises as fs } from 'fs'
import path from 'path'
import crypto from 'crypto'

export interface UserRecord {
  id: string
  email: string
  name?: string
  role: 'admin' | 'user'
  passwordHash: string
  passwordSalt: string
  createdAt: number
}

export interface SessionRecord {
  idHash: string
  userId: string
  expiresAt: number
  createdAt: number
}

export interface WebStoreData {
  version: 1
  users: UserRecord[]
  sessions: SessionRecord[]
  accountDataByUser: Record<string, unknown>
  settingsByUser: Record<string, Record<string, unknown>>
  proxyStateByUser: Record<string, Record<string, unknown>>
  auditEvents: Array<{ ts: number; userId: string; type: string; data: Record<string, unknown> }>
}

const SENSITIVE_KEY_RE = /^(accessToken|refreshToken|csrfToken|clientSecret|password|apiKey|key|token|secret)$/i
const ENCRYPTED_MARKER = '__kiroWebEncrypted'

function dataDir(): string {
  return path.resolve(process.env.KROUTER_DATA_DIR || process.env.KAM_DATA_DIR || process.env.KIRO_WEB_DATA_DIR || '.web-data')
}

function storePath(): string {
  return path.join(dataDir(), 'store.json')
}

function encryptionKey(): Buffer {
  const configured = process.env.APP_ENCRYPTION_KEY || 'development-only-change-me'
  return crypto.createHash('sha256').update(configured).digest()
}

function hashSessionId(sessionId: string): string {
  const secret = process.env.SESSION_SECRET || 'development-session-secret'
  return crypto.createHmac('sha256', secret).update(sessionId).digest('hex')
}

function encryptString(value: string): Record<string, string | number | boolean> {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    [ENCRYPTED_MARKER]: true,
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  }
}

function decryptString(value: Record<string, unknown>): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(String(value.iv), 'base64')
  )
  decipher.setAuthTag(Buffer.from(String(value.tag), 'base64'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(String(value.data), 'base64')),
    decipher.final()
  ])
  return decrypted.toString('utf8')
}

function protect(value: unknown, keyName?: string): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string' && keyName && SENSITIVE_KEY_RE.test(keyName)) {
    return encryptString(value)
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => protect(item))
  const record = value as Record<string, unknown>
  if (record[ENCRYPTED_MARKER]) return value
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, protect(child, key)]))
}

function unprotect(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((item) => unprotect(item))
  const record = value as Record<string, unknown>
  if (record[ENCRYPTED_MARKER]) return decryptString(record)
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, unprotect(child)]))
}

function defaultStore(): WebStoreData {
  return {
    version: 1,
    users: [],
    sessions: [],
    accountDataByUser: {},
    settingsByUser: {},
    proxyStateByUser: {},
    auditEvents: []
  }
}

export function hashPassword(password: string, salt = crypto.randomBytes(16).toString('hex')): {
  hash: string
  salt: string
} {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex')
  return { hash, salt }
}

export function verifyPassword(password: string, user: UserRecord): boolean {
  const { hash } = hashPassword(password, user.passwordSalt)
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.passwordHash, 'hex'))
}

export class WebStore {
  private data: WebStoreData = defaultStore()
  private loaded = false

  async load(): Promise<void> {
    if (this.loaded) return
    await fs.mkdir(dataDir(), { recursive: true })
    try {
      const raw = await fs.readFile(storePath(), 'utf8')
      this.data = { ...defaultStore(), ...JSON.parse(raw) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.data = defaultStore()
      await this.save()
    }
    this.loaded = true
    await this.ensureConfiguredAdminUser()
    this.pruneExpiredSessions()
    await this.save()
  }

  snapshot(): WebStoreData {
    return this.data
  }

  async save(): Promise<void> {
    await fs.mkdir(dataDir(), { recursive: true })
    await fs.writeFile(storePath(), JSON.stringify(this.data, null, 2), 'utf8')
  }

  isSetupRequired(): boolean {
    return this.data.users.length === 0
  }

  static generateAdminPassword(): string {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
    const bytes = crypto.randomBytes(18)
    let value = ''
    for (const byte of bytes) value += alphabet[byte % alphabet.length]
    return `kr-${value.slice(0, 6)}-${value.slice(6, 12)}-${value.slice(12, 18)}`
  }

  private adminEmailFromEnv(): string {
    return process.env.KROUTER_ADMIN_EMAIL
      || process.env.KAM_ADMIN_EMAIL
      || process.env.ADMIN_EMAIL
      || 'admin@krouter.local'
  }

  private configuredAdminPassword(): string | undefined {
    return process.env.KROUTER_ADMIN_PASSWORD
      || process.env.KAM_ADMIN_PASSWORD
      || process.env.ADMIN_PASSWORD
  }

  async ensureConfiguredAdminUser(): Promise<void> {
    if (this.data.users.length > 0) return
    const password = this.configuredAdminPassword()
    if (!password) return
    await this.createInitialAdmin({ email: this.adminEmailFromEnv(), password })
  }

  async createInitialAdmin(input: { email?: string; password: string; name?: string }): Promise<UserRecord> {
    if (this.data.users.length > 0) throw new Error('Krouter is already set up')
    const password = String(input.password || '')
    if (password.length < 8) throw new Error('Password must be at least 8 characters')
    const email = String(input.email || this.adminEmailFromEnv()).trim() || 'admin@krouter.local'
    const { hash, salt } = hashPassword(password)
    const user: UserRecord = {
      id: crypto.randomUUID(),
      email,
      name: input.name || 'Admin',
      role: 'admin',
      passwordHash: hash,
      passwordSalt: salt,
      createdAt: Date.now()
    }
    this.data.users.push(user)
    await this.save()
    return user
  }

  findUserByEmail(email: string): UserRecord | undefined {
    return this.data.users.find((user) => user.email.toLowerCase() === email.toLowerCase())
  }

  getUsers(): UserRecord[] {
    return [...this.data.users]
  }

  findUserBySession(sessionId: string | undefined): UserRecord | undefined {
    if (!sessionId) return undefined
    const idHash = hashSessionId(sessionId)
    const session = this.data.sessions.find((item) => item.idHash === idHash && item.expiresAt > Date.now())
    if (!session) return undefined
    return this.data.users.find((user) => user.id === session.userId)
  }

  async createSession(userId: string): Promise<{ id: string; expiresAt: number }> {
    const id = crypto.randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7
    this.data.sessions.push({
      idHash: hashSessionId(id),
      userId,
      expiresAt,
      createdAt: Date.now()
    })
    await this.save()
    return { id, expiresAt }
  }

  async deleteSession(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return
    const idHash = hashSessionId(sessionId)
    this.data.sessions = this.data.sessions.filter((session) => session.idHash !== idHash)
    await this.save()
  }

  getAccountData(userId: string): unknown {
    return unprotect(this.data.accountDataByUser[userId] || null)
  }

  async setAccountData(userId: string, accountData: unknown): Promise<void> {
    this.data.accountDataByUser[userId] = protect(accountData)
    await this.save()
  }

  getUserSettings(userId: string): Record<string, unknown> {
    const settings = this.data.settingsByUser[userId]
    if (!settings) {
      this.data.settingsByUser[userId] = {}
      return this.data.settingsByUser[userId]
    }
    return settings
  }

  async setUserSetting(userId: string, key: string, value: unknown): Promise<void> {
    const settings = this.getUserSettings(userId)
    settings[key] = protect(value)
    await this.save()
  }

  getUserSetting<T>(userId: string, key: string, fallback: T): T {
    const settings = this.getUserSettings(userId)
    if (!(key in settings)) return fallback
    return unprotect(settings[key]) as T
  }

  getProxyState(userId: string): Record<string, unknown> {
    if (!this.data.proxyStateByUser[userId]) {
      this.data.proxyStateByUser[userId] = {}
    }
    return this.data.proxyStateByUser[userId]
  }

  async updateProxyState(userId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    const current = this.getProxyState(userId)
    Object.assign(current, protect(patch))
    await this.save()
    return unprotect(current) as Record<string, unknown>
  }

  async audit(userId: string, type: string, data: Record<string, unknown>): Promise<void> {
    this.data.auditEvents.push({ ts: Date.now(), userId, type, data: protect(data) as Record<string, unknown> })
    if (this.data.auditEvents.length > 1000) this.data.auditEvents.splice(0, this.data.auditEvents.length - 1000)
    await this.save()
  }

  getAuditEvents(userId: string): Array<{ ts: number; type: string; data: Record<string, unknown> }> {
    return this.data.auditEvents
      .filter((event) => event.userId === userId)
      .map((event) => ({
        ts: event.ts,
        type: event.type,
        data: unprotect(event.data) as Record<string, unknown>
      }))
  }

  private pruneExpiredSessions(): void {
    const now = Date.now()
    this.data.sessions = this.data.sessions.filter((session) => session.expiresAt > now)
  }
}
