import { promises as fs, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
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

const SENSITIVE_KEY_RE = /^(accessToken|refreshToken|csrfToken|clientSecret|password|apiKey|key|token|secret|secretAccessKey|sessionToken)$/i
const ENCRYPTED_MARKER = '__kiroWebEncrypted'
// Khóa mặc định hardcode của các bản cũ. Chỉ dùng để giải mã dữ liệu cũ.
const LEGACY_ENCRYPTION_KEY = 'development-only-change-me'
const LEGACY_SESSION_SECRET = 'development-session-secret'
const INSTANCE_SECRETS_FILE = 'instance-secrets.json'
const MAX_SESSIONS_PER_USER = 20
/** Trần cho mọi danh sách tombstone (account và proxy) để chúng không phình theo vòng đời app. */
const MAX_TOMBSTONES = 5000
/**
 * Cửa sổ gom các lần ghi store. Đủ ngắn để thao tác trên UI vẫn thấy tức thì, đủ dài để một
 * chuỗi request proxy liên tiếp chỉ tốn một lần ghi thay vì một lần cho mỗi request.
 */
const SAVE_COALESCE_MS = 250
/** Nhịp tối thiểu giữa hai lần tạo file .bak (xem chú thích trong doSave). */
const BACKUP_MIN_INTERVAL_MS = 60_000
const PBKDF2_ITERATIONS = 120000

interface InstanceSecrets {
  encryptionKey: string
  sessionSecret: string
}

let cachedInstanceSecrets: InstanceSecrets | null = null
let instanceSecretsUnavailable = false

function dataDir(): string {
  return path.resolve(process.env.KROUTER_DATA_DIR || process.env.KAM_DATA_DIR || process.env.KIRO_WEB_DATA_DIR || '.web-data')
}

function storePath(): string {
  return path.join(dataDir(), 'store.json')
}

function backupPath(): string {
  return `${storePath()}.bak`
}

function instanceSecretsPath(): string {
  return path.join(dataDir(), INSTANCE_SECRETS_FILE)
}

// Bí mật riêng cho từng bản cài. Lần đầu chạy sẽ sinh ngẫu nhiên và ghi xuống
// đĩa với quyền 0600, nhờ vậy không còn bản cài nào dùng chung khóa hardcode.
function instanceSecrets(): InstanceSecrets | null {
  if (cachedInstanceSecrets) return cachedInstanceSecrets
  if (instanceSecretsUnavailable) return null
  try {
    const parsed = JSON.parse(readFileSync(instanceSecretsPath(), 'utf8')) as Partial<InstanceSecrets>
    if (parsed && typeof parsed.encryptionKey === 'string' && parsed.encryptionKey
      && typeof parsed.sessionSecret === 'string' && parsed.sessionSecret) {
      cachedInstanceSecrets = { encryptionKey: parsed.encryptionKey, sessionSecret: parsed.sessionSecret }
      return cachedInstanceSecrets
    }
    // File tồn tại nhưng hỏng/thiếu trường: TUYỆT ĐỐI không sinh khóa mới đè lên.
    // Toàn bộ token trong store.json được mã hóa bằng khóa cũ; sinh lại là hủy vĩnh viễn
    // dữ liệu đó mà chỉ để lại một dòng cảnh báo. Dừng hẳn để người dùng khôi phục được.
    throw new Error(
      `[Store] ${instanceSecretsPath()} tồn tại nhưng không hợp lệ. Không sinh khóa mới để tránh hủy dữ liệu đã mã hóa.`
      + ' Hãy khôi phục file này từ backup, hoặc xóa nó nếu chấp nhận mất toàn bộ token đã lưu.'
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Chỉ ENOENT mới được đi tiếp sang nhánh sinh mới. Mọi lỗi khác (JSON hỏng, EACCES,
    // EISDIR, và cả lỗi ném ở trên) phải nổi lên chứ không được nuốt.
    if (code !== 'ENOENT') throw error
  }
  try {
    const generated: InstanceSecrets = {
      encryptionKey: crypto.randomBytes(32).toString('hex'),
      sessionSecret: crypto.randomBytes(32).toString('hex')
    }
    mkdirSync(dataDir(), { recursive: true })
    // Ghi nguyên tử: writeFileSync trực tiếp có thể để lại file cắt dở khi mất điện /
    // hết đĩa, và chính file cắt dở đó sẽ kích hoạt nhánh "không hợp lệ" ở trên.
    const tmpPath = `${instanceSecretsPath()}.tmp`
    writeFileSync(tmpPath, JSON.stringify(generated, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmpPath, instanceSecretsPath())
    console.log(`[Store] Đã tạo bí mật riêng cho bản cài này tại ${instanceSecretsPath()}`)
    cachedInstanceSecrets = generated
    return cachedInstanceSecrets
  } catch (error) {
    instanceSecretsUnavailable = true
    console.warn(
      `[Store] CẢNH BÁO BẢO MẬT: không ghi được ${instanceSecretsPath()} nên đang dùng khóa mặc định công khai.`
      + ' Hãy đặt APP_ENCRYPTION_KEY và SESSION_SECRET ngay:',
      error
    )
    return null
  }
}

function encryptionKey(): Buffer {
  const configured = process.env.APP_ENCRYPTION_KEY || instanceSecrets()?.encryptionKey || LEGACY_ENCRYPTION_KEY
  return crypto.createHash('sha256').update(configured).digest()
}

// Shim tương thích: dữ liệu của bản cài cũ được mã hóa bằng khóa hardcode.
function legacyEncryptionKey(): Buffer {
  return crypto.createHash('sha256').update(LEGACY_ENCRYPTION_KEY).digest()
}

function sessionSecret(): string {
  return process.env.SESSION_SECRET || instanceSecrets()?.sessionSecret || LEGACY_SESSION_SECRET
}

function hashSessionId(sessionId: string): string {
  return crypto.createHmac('sha256', sessionSecret()).update(sessionId).digest('hex')
}

// Shim tương thích: phiên cũ được ký bằng secret hardcode, vẫn phải chấp nhận
// để người dùng đang đăng nhập không bị đá ra sau khi nâng cấp.
function legacyHashSessionId(sessionId: string): string {
  return crypto.createHmac('sha256', LEGACY_SESSION_SECRET).update(sessionId).digest('hex')
}

function timingSafeEqualHex(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'hex')
  const rightBuffer = Buffer.from(right, 'hex')
  if (leftBuffer.length === 0 || leftBuffer.length !== rightBuffer.length) return false
  return crypto.timingSafeEqual(leftBuffer, rightBuffer)
}

function sessionHashMatches(storedHash: string, sessionId: string): boolean {
  return timingSafeEqualHex(storedHash, hashSessionId(sessionId))
    || timingSafeEqualHex(storedHash, legacyHashSessionId(sessionId))
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

function decryptWithKey(value: Record<string, unknown>, key: Buffer): string {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(String(value.iv), 'base64')
  )
  decipher.setAuthTag(Buffer.from(String(value.tag), 'base64'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(String(value.data), 'base64')),
    decipher.final()
  ])
  return decrypted.toString('utf8')
}

function decryptString(value: Record<string, unknown>): string {
  try {
    return decryptWithKey(value, encryptionKey())
  } catch (error) {
    // Shim tương thích: thử lại bằng khóa hardcode cũ. Giá trị giải mã được
    // sẽ tự động mã hóa lại bằng khóa hiện tại ở lần ghi kế tiếp.
    try {
      return decryptWithKey(value, legacyEncryptionKey())
    } catch {
      throw error
    }
  }
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

// PBKDF2 chạy bất đồng bộ trên threadpool: 120k vòng không còn chặn event loop
// nên các endpoint chưa xác thực không thể làm treo cả tiến trình.
function pbkdf2Async(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(password, salt, PBKDF2_ITERATIONS, 32, 'sha256', (error, derivedKey) => {
      if (error) reject(error)
      else resolve(derivedKey)
    })
  })
}

export async function hashPasswordAsync(
  password: string,
  salt = crypto.randomBytes(16).toString('hex')
): Promise<{ hash: string; salt: string }> {
  const derivedKey = await pbkdf2Async(password, salt)
  return { hash: derivedKey.toString('hex'), salt }
}

export async function verifyPasswordAsync(password: string, user: UserRecord): Promise<boolean> {
  const { hash } = await hashPasswordAsync(password, user.passwordSalt)
  return timingSafeEqualHex(hash, user.passwordHash)
}

export class WebStore {
  private data: WebStoreData = defaultStore()
  private loaded = false
  private saveQueue: Promise<void> = Promise.resolve()
  /** Hẹn giờ của lần ghi gom đang chờ; null nghĩa là không có lần nào đang xếp lịch. */
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null
  private lastBackupAt = 0
  private accountDataQueue: Promise<void> = Promise.resolve()

  async load(): Promise<void> {
    if (this.loaded) return
    await fs.mkdir(dataDir(), { recursive: true })
    let raw: string | null = null
    try {
      raw = await fs.readFile(storePath(), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (raw === null) {
      this.data = defaultStore()
      await this.save()
    } else {
      let parsed: Partial<WebStoreData> = {}
      try {
        parsed = JSON.parse(raw) as Partial<WebStoreData>
        console.log(`[Store] Đã nạp dữ liệu từ ${storePath()}`)
      } catch (parseError) {
        console.error(`[Store] ${storePath()} không phải JSON hợp lệ, thử khôi phục từ bản sao lưu:`, parseError)
        try {
          parsed = JSON.parse(await fs.readFile(backupPath(), 'utf8')) as Partial<WebStoreData>
          console.warn(`[Store] Đã khôi phục dữ liệu từ ${backupPath()}`)
        } catch (backupError) {
          console.error(`[Store] Bản sao lưu ${backupPath()} cũng không dùng được:`, backupError)
          throw parseError
        }
      }
      this.data = { ...defaultStore(), ...parsed } as WebStoreData
    }
    this.loaded = true
    await this.ensureConfiguredAdminUser()
    this.pruneExpiredSessions()
    await this.save()
  }

  snapshot(): WebStoreData {
    return this.data
  }

  /**
   * Ghi store ngay. Người gọi `await` xong là dữ liệu đã nằm trên đĩa.
   *
   * Mọi lần ghi xếp hàng qua một chuỗi promise duy nhất: hai lần ghi không bao giờ chồng lên
   * nhau và làm store.json thành JSON hỏng.
   */
  async save(): Promise<void> {
    this.saveQueue = this.saveQueue.then(() => this.doSave(), () => this.doSave())
    return this.saveQueue
  }

  /**
   * Lên lịch ghi, GOM các lời gọi liên tiếp trong một cửa sổ ngắn. Không trả promise chờ ghi
   * xong — đây là đường dành cho ghi "cứ để đó" (fire-and-forget).
   *
   * Vì sao cần: `recordApiKeyUsage()` bắn onConfigChanged ở cuối MỖI request được proxy, và
   * consumer của nó là `void this.persistConfig()` — không ai chờ kết quả. Mà mỗi lần ghi là
   * stringify toàn bộ tài liệu + ghi cả file; đo trên store 593 KB là ~17 ms, nối tiếp qua một
   * hàng đợi duy nhất. Ở 10 req/s đó là 17% thời gian chỉ để ghi store, và chi phí tăng tuyến
   * tính theo kích thước store.
   *
   * CHỦ Ý không dùng cách này cho `save()`: ai đang `await save()` là đang cần đảm bảo bền
   * vững, bắt họ chờ thêm một cửa sổ gom chỉ làm chuỗi ghi tuần tự chậm đi.
   */
  scheduleSave(): void {
    if (this.coalesceTimer) return
    this.coalesceTimer = setTimeout(() => {
      this.coalesceTimer = null
      void this.save().catch((error) => {
        console.warn('[Store] Ghi theo lịch thất bại:', error)
      })
    }, SAVE_COALESCE_MS)
    this.coalesceTimer.unref?.()
  }

  /** Ghi ngay, đồng thời huỷ lần ghi đang chờ theo lịch. Dùng ở đường tắt máy. */
  async flush(): Promise<void> {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer)
      this.coalesceTimer = null
    }
    return await this.save()
  }

  private async doSave(): Promise<void> {
    await fs.mkdir(dataDir(), { recursive: true })
    const payload = JSON.stringify(this.data, null, 2)

    // Bản sao lưu có nhịp riêng, không đi kèm mọi lần ghi.
    //
    // store.json đã an toàn trước lỗi ghi dở nhờ cặp write-temp + rename (rename là nguyên tử
    // trên cùng ổ đĩa). File .bak chỉ để lùi về BẢN TRƯỚC khi dữ liệu bị hỏng về mặt logic,
    // nên không cần cập nhật theo từng lần ghi — làm vậy chỉ nhân đôi I/O.
    const now = Date.now()
    if (now - this.lastBackupAt >= BACKUP_MIN_INTERVAL_MS) {
      this.lastBackupAt = now
      try {
        await fs.copyFile(storePath(), backupPath())
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          console.warn(`[Store] Không tạo được bản sao lưu ${backupPath()}:`, error)
        }
      }
    }

    // Ghi ra file tạm rồi rename: rename là thao tác nguyên tử trên cùng ổ đĩa
    // nên store.json không bao giờ ở trạng thái bị cắt dở.
    const tempPath = `${storePath()}.tmp`
    await fs.writeFile(tempPath, payload, 'utf8')
    await fs.rename(tempPath, storePath())
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
    const { hash, salt } = await hashPasswordAsync(password)
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
    this.pruneExpiredSessions()
    const session = this.data.sessions.find((item) => item.expiresAt > Date.now() && sessionHashMatches(item.idHash, sessionId))
    if (!session) return undefined
    return this.data.users.find((user) => user.id === session.userId)
  }

  async createSession(userId: string): Promise<{ id: string; expiresAt: number }> {
    const id = crypto.randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 7
    this.pruneExpiredSessions()
    this.data.sessions.push({
      idHash: hashSessionId(id),
      userId,
      expiresAt,
      createdAt: Date.now()
    })
    // Chặn danh sách phiên phình vô hạn: mỗi user chỉ giữ N phiên mới nhất.
    const owned = this.data.sessions.filter((session) => session.userId === userId)
    if (owned.length > MAX_SESSIONS_PER_USER) {
      const dropped = new Set(
        owned
          .slice()
          .sort((left, right) => left.createdAt - right.createdAt)
          .slice(0, owned.length - MAX_SESSIONS_PER_USER)
      )
      this.data.sessions = this.data.sessions.filter((session) => !dropped.has(session))
    }
    await this.save()
    return { id, expiresAt }
  }

  async deleteSession(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return
    this.data.sessions = this.data.sessions.filter((session) => !sessionHashMatches(session.idHash, sessionId))
    await this.save()
  }

  // Dùng khi đổi mật khẩu: mọi cookie phiên cũ phải mất hiệu lực ngay.
  async invalidateUserSessions(userId: string): Promise<void> {
    const before = this.data.sessions.length
    this.data.sessions = this.data.sessions.filter((session) => session.userId !== userId)
    if (this.data.sessions.length !== before) await this.save()
  }

  getAccountData(userId: string): unknown {
    return unprotect(this.data.accountDataByUser[userId] || null)
  }

  async setAccountData(userId: string, accountData: unknown): Promise<void> {
    this.data.accountDataByUser[userId] = protect(this.enforceDeletionTombstones(userId, accountData))
    await this.save()
  }

  // Đọc-sửa-ghi an toàn: các luồng gọi được nối tiếp qua một hàng đợi và
  // mutator luôn nhận tài liệu HIỆN TẠI, nên không lần ghi nào bị nuốt mất.
  async updateAccountData(
    userId: string,
    mutator: (data: Record<string, unknown>) => void
  ): Promise<void> {
    const apply = async (): Promise<void> => {
      const current = (this.getAccountData(userId) || {}) as Record<string, unknown>
      mutator(current)
      await this.setAccountData(userId, current)
    }
    this.accountDataQueue = this.accountDataQueue.then(apply, apply)
    return this.accountDataQueue
  }

  // Safety net against deleted accounts resurrecting. Multiple writers (backend
  // auto-refresh, proxy maintenance, proxy runtime sync) each capture an in-memory
  // snapshot of accounts, do slow async work, then write back. If a delete lands
  // during that window, a stale write-back would re-add the just-deleted account.
  // Rather than fix every writer, we enforce the invariant at the single disk-write
  // boundary: union the tombstone list already on disk with the incoming one, then
  // drop any account whose id is tombstoned. Re-added accounts always get a fresh
  // UUID, so a tombstoned id can never legitimately reappear.
  private enforceDeletionTombstones(userId: string, accountData: unknown): unknown {
    if (!accountData || typeof accountData !== 'object' || Array.isArray(accountData)) return accountData
    const incoming = accountData as Record<string, unknown>
    const onDisk = this.data.accountDataByUser[userId]
    const existingTombstones = onDisk && typeof onDisk === 'object' && !Array.isArray(onDisk)
      ? (onDisk as Record<string, unknown>)._deletedAccountIds
      : undefined
    const tombstones = new Set<string>()
    for (const source of [existingTombstones, incoming._deletedAccountIds]) {
      if (Array.isArray(source)) {
        for (const id of source) if (typeof id === 'string') tombstones.add(id)
      }
    }
    // _deletedProxyIds cũng phải bị chặn trên. Mỗi proxy iplocate được thêm lại đều nhận
    // UUID mới nên một free-list hay biến động sinh tombstone mới mỗi chu kỳ 30 phút, mà
    // doSave stringify toàn bộ tài liệu + copy file backup ở gần như mọi lần ghi.
    const cappedProxyIds = Array.isArray(incoming._deletedProxyIds)
      ? (incoming._deletedProxyIds as unknown[]).filter((id): id is string => typeof id === 'string').slice(-MAX_TOMBSTONES)
      : undefined
    const withCappedProxyIds = cappedProxyIds
      ? { ...incoming, _deletedProxyIds: cappedProxyIds }
      : incoming

    if (tombstones.size === 0) return withCappedProxyIds
    const incomingCapped = withCappedProxyIds
    const accounts = incomingCapped.accounts
    let accountsChanged = false
    let nextAccounts = accounts
    if (accounts && typeof accounts === 'object' && !Array.isArray(accounts)) {
      const filtered: Record<string, unknown> = {}
      for (const [id, value] of Object.entries(accounts as Record<string, unknown>)) {
        if (tombstones.has(id)) {
          accountsChanged = true
          continue
        }
        filtered[id] = value
      }
      nextAccounts = filtered
    }
    // Cap the tombstone list so it can't grow without bound across the app lifetime.
    const merged = Array.from(tombstones).slice(-MAX_TOMBSTONES)
    return { ...incomingCapped, accounts: accountsChanged ? nextAccounts : accounts, _deletedAccountIds: merged }
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

  /**
   * Như setUserSetting nhưng ghi theo lịch có gom và KHÔNG chờ ghi xong.
   * Dành cho đường nóng ghi liên tục mà không ai await kết quả — xem scheduleSave().
   */
  setUserSettingDeferred(userId: string, key: string, value: unknown): void {
    const settings = this.getUserSettings(userId)
    settings[key] = protect(value)
    this.scheduleSave()
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
