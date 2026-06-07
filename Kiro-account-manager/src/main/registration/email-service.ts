import * as tls from 'tls'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { getSystemProxy, safeCreateProxyAgent } from '../proxy/systemProxy'
import { randomEmailPrefix } from './names'

function getRegistrationProxyUrl(): string | undefined {
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || getSystemProxy() || undefined
}

async function proxyFetch(url: string, options?: RequestInit): Promise<Response> {
  const agent = safeCreateProxyAgent(getRegistrationProxyUrl())
  if (agent) {
    return await undiciFetch(url, { ...options, dispatcher: agent } as UndiciRequestInit) as unknown as Response
  }
  return await fetch(url, options)
}

// ============ 验证码提取 ============

const OTP_PATTERN = /\b(\d{6})\b/g

export function extractCode(body: string): string {
  const matches = body.match(OTP_PATTERN)
  if (!matches || matches.length === 0) return ''
  return matches[matches.length - 1]
}

// ============ TempEmailService 接口 ============

export interface TempEmailService {
  create(): Promise<string>
  /** signal：注册被取消时中断轮询（停止/暂停后立即退出，而非等满 timeout） */
  waitForCode(timeoutSec: number, intervalSec: number, signal?: AbortSignal): Promise<string>
  getAddress(): string
}

/** 可被 AbortSignal 中断的 sleep：停止注册时立刻 reject，不再傻等 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error('Đăng ký đã bị hủy'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('Đăng ký đã bị hủy'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ============ MoEmail 临时邮箱 ============

export class MoEmailService implements TempEmailService {
  private baseURL: string
  private apiKey: string
  private address = ''

  constructor(baseURL: string, apiKey: string) {
    this.baseURL = MoEmailService.normalizeBaseURL(baseURL)
    this.apiKey = apiKey
  }

  /**
   * 归一化用户输入的 baseURL：
   *   - 去除首尾空白与末尾斜杠
   *   - 缺少 protocol 时补 `https://`
   *   - 校验协议仅允许 http / https，否则抛清晰错误
   * 用于规避 fetch 因协议不合法抛出
   * "Invalid URL protocol: the URL must start with `http:` or `https:`."
   */
  private static normalizeBaseURL(raw: string): string {
    const trimmed = (raw || '').trim().replace(/\/+$/, '')
    if (!trimmed) throw new Error('Chưa cấu hình MoEmail BaseURL')
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
    let u: URL
    try {
      u = new URL(withScheme)
    } catch {
      throw new Error(`Định dạng MoEmail BaseURL không hợp lệ: ${raw}`)
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`MoEmail BaseURL không hỗ trợ giao thức này (chỉ hỗ trợ http/https): ${u.protocol}`)
    }
    return withScheme
  }

  async create(): Promise<string> {
    const url = `${this.baseURL}/api/mail/create`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

    const resp = await proxyFetch(url, { method: 'POST', headers, signal: AbortSignal.timeout(30000) })
    const data = (await resp.json()) as Record<string, unknown>

    const addr =
      (data.address as string) ||
      (data.email as string) ||
      ((data.data as Record<string, unknown>)?.address as string) ||
      ((data.data as Record<string, unknown>)?.email as string) ||
      ''

    if (!addr) {
      console.log('[MoEmail] Tạo email thất bại:', JSON.stringify(data))
      return ''
    }
    this.address = addr
    return addr
  }

  async waitForCode(timeoutSec: number, intervalSec: number, signal?: AbortSignal): Promise<string> {
    if (!this.address) throw new Error('Địa chỉ email đang trống')

    const maxRetries = Math.floor(timeoutSec / intervalSec)
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('Đăng ký đã bị hủy')
      await abortableSleep(intervalSec * 1000, signal)
      try {
        const code = await this.fetchCode()
        if (code) return code
      } catch (err) {
        if (attempt % 5 === 0) console.log(`[MoEmail] [${attempt}/${maxRetries}] Truy vấn thất bại:`, err)
      }
      if (attempt % 5 === 0) console.log(`[MoEmail] [${attempt}/${maxRetries}] Chưa có mã xác minh...`)
    }
    throw new Error(`Hết thời gian chờ mã xác minh (${timeoutSec} giây)`)
  }

  getAddress(): string {
    return this.address
  }

  private async fetchCode(): Promise<string> {
    const url = `${this.baseURL}/api/mail/messages?address=${this.address}`
    const headers: Record<string, string> = {}
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`

    const resp = await proxyFetch(url, { headers, signal: AbortSignal.timeout(15000) })
    const raw = await resp.json()

    let messages: Array<Record<string, unknown>> = []
    if (Array.isArray(raw)) {
      messages = raw as Array<Record<string, unknown>>
    } else if (typeof raw === 'object' && raw !== null) {
      const wrapper = raw as Record<string, unknown>
      if (Array.isArray(wrapper.data)) {
        messages = wrapper.data as Array<Record<string, unknown>>
      }
    }

    for (const msg of messages) {
      const text = (msg.text as string) || (msg.body as string) || (msg.html as string) || ''
      if (text) {
        const code = extractCode(text)
        if (code) return code
      }
    }
    return ''
  }
}

// ============ TempMail.Plus + 自建域名 ============

export class TempMailPlusService implements TempEmailService {
  private static readonly BASE_URL = 'https://tempmail.plus/api'

  private readonly tmEmail: string   // tempmail.plus 用户名（不含 @mailto.plus）
  private readonly epin: string
  /** 支持多域名（用户填多行/逗号/空格分隔），每次 create 随机挑一个，降低单域名被风控关联 */
  private readonly domains: string[]
  private domain = ''
  private address = ''

  constructor(tmEmail: string, epin: string, domain: string) {
    this.tmEmail = tmEmail
    this.epin = epin
    this.domains = domain
      .split(/[\s,;]+/)
      .map((d) => d.trim().replace(/^@/, ''))
      .filter(Boolean)
    if (this.domains.length === 0) {
      throw new Error('Tên miền riêng của TempMail.Plus đang trống')
    }
  }

  private get headers(): Record<string, string> {
    return {
      'accept': 'application/json, text/javascript, */*; q=0.01',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      'x-requested-with': 'XMLHttpRequest',
      'Referer': 'https://tempmail.plus/zh/',
      'cookie': `email=${encodeURIComponent(this.fullEmail)}`
    }
  }

  async create(): Promise<string> {
    const prefix = randomEmailPrefix()
    this.domain = this.domains[Math.floor(Math.random() * this.domains.length)]
    this.address = `${prefix}@${this.domain}`
    if (this.domains.length > 1) {
      console.log(`[TempMailPlus] Đã tạo email: ${this.address} (kho tên miền có ${this.domains.length} mục)`)
    } else {
      console.log(`[TempMailPlus] Đã tạo email: ${this.address}`)
    }
    return this.address
  }

  getAddress(): string {
    return this.address
  }

  async waitForCode(timeoutSec: number, intervalSec: number, signal?: AbortSignal): Promise<string> {
    if (!this.address) throw new Error('Địa chỉ email đang trống')
    const maxRetries = Math.floor(timeoutSec / intervalSec)
    const checkedIds = new Set<number>()

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('Đăng ký đã bị hủy')
      await abortableSleep(intervalSec * 1000, signal)
      try {
        const mails = await this.fetchMailList()
        if (attempt === 1 || attempt % 5 === 0) {
          console.log(`[TempMailPlus] [${attempt}/${maxRetries}] Số email: ${mails.length}`)
        }
        for (const mail of mails) {
          const mailId = mail.mail_id as number
          if (checkedIds.has(mailId)) continue
          checkedIds.add(mailId)

          const detail = await this.fetchMailDetail(mailId)
          if (!detail) continue

          // 验证收件人匹配
          const toField = String(detail.to || '').toLowerCase()
          if (!toField.includes(this.address.toLowerCase())) {
            console.log(`[TempMailPlus] Người nhận không khớp: ${toField} (cần chứa: ${this.address})`)
            continue
          }

          // 提取验证码
          const code = this.extractOTP(detail)
          if (code) {
            console.log(`[TempMailPlus] Mã xác minh: ${code}`)
            await this.deleteMail(mailId)
            return code
          } else {
            console.log(`[TempMailPlus] Không lấy được mã xác minh từ email ${mailId}`)
          }
        }
      } catch (err) {
        console.log(`[TempMailPlus] [${attempt}/${maxRetries}] Truy vấn thất bại:`, err)
      }
      if (attempt % 5 === 0) console.log(`[TempMailPlus] [${attempt}/${maxRetries}] Chưa có mã xác minh...`)
    }
    throw new Error(`Hết thời gian chờ mã xác minh (${timeoutSec} giây)`)
  }

  private get fullEmail(): string {
    return `${this.tmEmail}@mailto.plus`
  }

  private async fetchMailList(): Promise<Array<Record<string, unknown>>> {
    const url = `${TempMailPlusService.BASE_URL}/mails?email=${encodeURIComponent(this.fullEmail)}&first_id=0&epin=${encodeURIComponent(this.epin)}`
    const resp = await proxyFetch(url, { headers: this.headers, signal: AbortSignal.timeout(15000) })
    const data = (await resp.json()) as Record<string, unknown>
    if (!data.result) return []
    return (data.mail_list as Array<Record<string, unknown>>) || []
  }

  private async fetchMailDetail(mailId: number): Promise<Record<string, unknown> | null> {
    const url = `${TempMailPlusService.BASE_URL}/mails/${mailId}?email=${encodeURIComponent(this.fullEmail)}&epin=${encodeURIComponent(this.epin)}`
    const resp = await proxyFetch(url, { headers: this.headers, signal: AbortSignal.timeout(15000) })
    const data = (await resp.json()) as Record<string, unknown>
    return data.result ? data : null
  }

  private async deleteMail(mailId: number): Promise<void> {
    const url = `${TempMailPlusService.BASE_URL}/mails/${mailId}`
    const headers = { ...this.headers, 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' }
    const body = `email=${encodeURIComponent(this.fullEmail)}&epin=${encodeURIComponent(this.epin)}`
    try {
      await proxyFetch(url, { method: 'DELETE', headers, body, signal: AbortSignal.timeout(10000) })
      console.log(`[TempMailPlus] Đã xóa email: ${mailId}`)
    } catch (err) {
      console.log(`[TempMailPlus] Xóa email thất bại:`, err)
    }
  }

  private extractOTP(detail: Record<string, unknown>): string {
    // 从主题提取
    const subject = String(detail.subject || '')
    const subjectMatch = subject.match(/(\d{6})/)
    if (subjectMatch) return subjectMatch[1]
    // 从正文提取
    const text = String(detail.text || '')
    const code = extractCode(text)
    if (code) return code
    // 从 HTML 提取
    const html = String(detail.html || '')
    return extractCode(html)
  }
}

// ============ Tingamefi Temp Email / Cloudflare Email Worker ============

export class TingamefiMailService implements TempEmailService {
  private readonly apiUrl: string
  private readonly adminPassword: string
  private readonly configuredDomain: string
  private address = ''

  constructor(apiUrl: string, adminPassword: string, domain: string) {
    this.apiUrl = TingamefiMailService.normalizeApiUrl(apiUrl || 'https://temp-email-worker.thienp1301.workers.dev')
    this.adminPassword = (adminPassword || '').trim()
    this.configuredDomain = (domain || 'mail.tingamefi.com').trim().replace(/^@/, '')
    if (!this.adminPassword) throw new Error('Tingamefi mail admin password is empty')
  }

  private static normalizeApiUrl(raw: string): string {
    const trimmed = raw.trim().replace(/\/+$/, '')
    if (!trimmed) return 'https://temp-email-worker.thienp1301.workers.dev'
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  }

  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-admin-auth': this.adminPassword,
      'x-lang': 'en',
      'x-fingerprint': 'kiro-account-manager-web'
    }
  }

  async create(): Promise<string> {
    const domain = await this.resolveDomain()
    let lastError = ''
    for (let attempt = 1; attempt <= 5; attempt++) {
      const name = randomEmailPrefix()
      try {
        const data = await this.fetchJson<Record<string, unknown>>('/admin/new_address', {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify({
            enablePrefix: true,
            enableRandomSubdomain: false,
            name,
            domain
          }),
          signal: AbortSignal.timeout(30000)
        })
        const address = String(data.address || '')
        if (address) {
          this.address = address
          console.log(`[TingamefiMail] created address: ${address}`)
          return address
        }
        lastError = JSON.stringify(data).slice(0, 300)
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
    }
    throw new Error(`Tingamefi mail address creation failed: ${lastError || 'empty response'}`)
  }

  getAddress(): string {
    return this.address
  }

  async waitForCode(timeoutSec: number, intervalSec: number, signal?: AbortSignal): Promise<string> {
    if (!this.address) throw new Error('Tingamefi mail address is empty')
    const maxRetries = Math.max(1, Math.floor(timeoutSec / intervalSec))

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      if (signal?.aborted) throw new Error('Registration was cancelled')
      await abortableSleep(intervalSec * 1000, signal)
      try {
        const messages = await this.fetchMessages()
        if (attempt === 1 || attempt % 5 === 0) {
          console.log(`[TingamefiMail] [${attempt}/${maxRetries}] messages: ${messages.length}`)
        }
        const preferred = messages.filter((message) => /no-reply@signin\.aws/i.test(String(message.source || message.raw || '')))
        for (const message of [...preferred, ...messages.filter((message) => !preferred.includes(message))]) {
          const text = [
            message.subject,
            message.text,
            message.html,
            message.message,
            message.raw
          ].map((value) => String(value || '')).join('\n')
          const code = extractCode(text)
          if (code) {
            console.log(`[TingamefiMail] verification code: ${code}`)
            await this.deleteMail(message.id).catch(() => undefined)
            return code
          }
        }
      } catch (error) {
        if (attempt % 5 === 0) console.log(`[TingamefiMail] [${attempt}/${maxRetries}] query failed:`, error)
      }
      if (attempt % 5 === 0) console.log(`[TingamefiMail] [${attempt}/${maxRetries}] no verification code yet...`)
    }

    throw new Error(`Timed out waiting for verification code (${timeoutSec}s)`)
  }

  private async resolveDomain(): Promise<string> {
    if (this.configuredDomain) return this.configuredDomain
    const settings = await this.fetchJson<Record<string, unknown>>('/open_api/settings', {
      headers: { 'x-lang': 'en', 'x-fingerprint': 'kiro-account-manager-web' },
      signal: AbortSignal.timeout(15000)
    })
    const domains = Array.isArray(settings.defaultDomains) ? settings.defaultDomains : settings.domains
    const first = Array.isArray(domains) ? String(domains[0] || '') : ''
    if (!first) throw new Error('Tingamefi mail domain is empty')
    return first.replace(/^@/, '')
  }

  private async fetchMessages(): Promise<Array<Record<string, unknown>>> {
    const query = `/admin/mails?limit=10&offset=0&address=${encodeURIComponent(this.address)}`
    const data = await this.fetchJson<Record<string, unknown>>(query, {
      headers: this.headers,
      signal: AbortSignal.timeout(15000)
    })
    return Array.isArray(data.results) ? data.results as Array<Record<string, unknown>> : []
  }

  private async deleteMail(id: unknown): Promise<void> {
    if (id === undefined || id === null || id === '') return
    await this.fetchJson(`/admin/mails/${encodeURIComponent(String(id))}`, {
      method: 'DELETE',
      headers: this.headers,
      signal: AbortSignal.timeout(10000)
    })
  }

  private async fetchJson<T>(pathname: string, init: RequestInit): Promise<T> {
    const response = await proxyFetch(`${this.apiUrl}${pathname}`, init)
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Tingamefi mail API ${response.status}: ${text.slice(0, 300)}`)
    }
    return (text ? JSON.parse(text) : {}) as T
  }
}

// ============ Outlook IMAP ============

export interface OutlookAccount {
  email: string
  password: string
  clientId: string
  refreshToken: string
}

/** 按 ---- 拆分；多出的连字符(N-4)归还前一字段（refreshToken 等 base64url 可能以 '-' 结尾） */
function splitByDashes(line: string): string[] {
  const parts: string[] = []
  const re = /-{4,}/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    parts.push(line.slice(last, m.index) + '-'.repeat(m[0].length - 4))
    last = m.index + m[0].length
  }
  parts.push(line.slice(last))
  return parts
}

export function parseOutlookLines(data: string): OutlookAccount[] {
  const accounts: OutlookAccount[] = []
  data = data.trim()
  if (!data) return accounts

  const lines = data.split('\n')
  const parseEntry = (entry: string): void => {
    entry = entry.trim()
    if (!entry) return
    const parts = splitByDashes(entry)
    if (parts.length === 4) {
      accounts.push({
        email: parts[0].trim(),
        password: parts[1].trim(),
        clientId: parts[2].trim(),
        refreshToken: parts[3].trim()
      })
    }
  }

  if (lines.length === 1) {
    for (const part of data.split(/\s+/)) parseEntry(part)
  } else {
    for (const line of lines) parseEntry(line)
  }
  return accounts
}

export async function refreshOutlookToken(acc: OutlookAccount): Promise<string> {
  const form = new URLSearchParams({
    client_id: acc.clientId,
    refresh_token: acc.refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://outlook.office.com/IMAP.AccessAsUser.All offline_access'
  })

  const resp = await proxyFetch(
    'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }
  )
  const data = (await resp.json()) as Record<string, unknown>
  if (resp.status !== 200) throw new Error(`Làm mới thất bại ${resp.status}: ${JSON.stringify(data).slice(0, 300)}`)
  const token = data.access_token as string
  if (!token) throw new Error('Phản hồi không có access_token')
  return token
}

function buildXOAuth2(email: string, accessToken: string): string {
  const auth = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`
  return Buffer.from(auth).toString('base64')
}

class IMAPClient {
  private socket: tls.TLSSocket | null = null
  private buffer = ''
  private tag = 0

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = tls.connect(993, 'outlook.office365.com', { servername: 'outlook.office365.com' })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('Kết nối hết thời gian chờ'))
      }, 15000)

      socket.once('error', (err) => { clearTimeout(timer); reject(err) })
      socket.once('secureConnect', () => {
        clearTimeout(timer)
        this.socket = socket
        this.readLine().then(() => resolve()).catch(reject)
      })
    })
  }

  private readLine(timeoutMs = 30000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('Chưa kết nối'))

      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        this.socket?.removeListener('data', onData)
        this.socket?.removeListener('error', onError)
        reject(new Error('IMAP readLine 超时'))
      }, timeoutMs)

      const done = (line: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.socket?.removeListener('data', onData)
        this.socket?.removeListener('error', onError)
        resolve(line)
      }

      const onError = (err: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.socket?.removeListener('data', onData)
        reject(err)
      }

      const check = (): boolean => {
        const idx = this.buffer.indexOf('\r\n')
        if (idx >= 0) {
          const line = this.buffer.slice(0, idx)
          this.buffer = this.buffer.slice(idx + 2)
          done(line)
          return true
        }
        return false
      }
      if (check()) return

      const onData = (chunk: Buffer): void => {
        this.buffer += chunk.toString()
        check()
      }
      this.socket.on('data', onData)
      this.socket.once('error', onError)
    })
  }

  private async sendCommand(cmd: string): Promise<string> {
    if (!this.socket) throw new Error('Chưa kết nối')
    this.tag++
    const tagStr = `A${String(this.tag).padStart(3, '0')}`
    this.socket.write(`${tagStr} ${cmd}\r\n`)
    return tagStr
  }

  private async readUntilTag(tag: string): Promise<{ lines: string[]; result: string }> {
    const lines: string[] = []
    while (true) {
      const line = await this.readLine()
      if (line.startsWith(`${tag} `)) return { lines, result: line }
      lines.push(line)
    }
  }

  async authenticate(email: string, accessToken: string): Promise<void> {
    const xoauth2 = buildXOAuth2(email, accessToken)
    const tag = await this.sendCommand(`AUTHENTICATE XOAUTH2 ${xoauth2}`)
    const { result } = await this.readUntilTag(tag)
    if (!result.includes('OK')) throw new Error(`Xác thực thất bại: ${result}`)
    console.log('[IMAP] Xác thực thành công')
    await sleep(800)
  }

  async selectInbox(): Promise<number> {
    for (let retry = 0; retry < 3; retry++) {
      const tag = await this.sendCommand('SELECT INBOX')
      const { lines, result } = await this.readUntilTag(tag)
      if (result.includes('OK')) {
        for (const line of lines) {
          const m = line.match(/\*\s+(\d+)\s+EXISTS/)
          if (m) return parseInt(m[1], 10)
        }
        return 0
      }
      if (retry < 2) {
        console.log(`[IMAP] SELECT INBOX thất bại (${result}), thử lại ${retry + 1}/3...`)
        await sleep((1 + retry) * 1000)
      }
    }
    throw new Error('SELECT INBOX vẫn thất bại sau tất cả lần thử')
  }

  async fetchLatestBody(seq: number): Promise<string> {
    if (seq <= 0) throw new Error('Số thứ tự email không hợp lệ')
    const tag = await this.sendCommand(`FETCH ${seq} (BODY.PEEK[TEXT])`)
    const { lines, result } = await this.readUntilTag(tag)
    if (!result.includes('OK')) throw new Error(`FETCH TEXT thất bại: ${result}`)

    const rawLines: string[] = []
    let inBody = false
    for (const line of lines) {
      if (line.includes('FETCH')) { inBody = true; continue }
      if (line === ')') continue
      if (inBody) rawLines.push(line)
    }
    const raw = rawLines.join('\n')

    // 尝试解码 MIME base64
    const parts = raw.split('------=_Part_')
    let decoded = ''
    for (const part of parts) {
      if (part.includes('base64')) {
        const idx = part.indexOf('base64')
        const content = part.slice(idx + 6)
        const b64 = content.replace(/[\s]/g, '')
        try {
          decoded += Buffer.from(b64, 'base64').toString() + ' '
        } catch { /* ignore */ }
      }
    }
    if (decoded) return decoded

    // 整体 base64 解码
    const cleaned = raw.replace(/[\s]/g, '')
    try {
      return Buffer.from(cleaned, 'base64').toString()
    } catch {
      return raw
    }
  }

  close(): void {
    if (this.socket) {
      try { this.socket.write('A999 LOGOUT\r\n') } catch { /* ignore */ }
      this.socket.destroy()
      this.socket = null
    }
  }
}

export async function getInboxCount(acc: OutlookAccount): Promise<number> {
  const accessToken = await refreshOutlookToken(acc)
  const client = new IMAPClient()
  try {
    await client.connect()
    await client.authenticate(acc.email, accessToken)
    return await client.selectInbox()
  } finally {
    client.close()
  }
}

export async function waitForOTP(
  acc: OutlookAccount,
  beforeCount: number,
  timeout: number,
  interval: number,
  signal?: AbortSignal
): Promise<string> {
  console.log(`[Outlook IMAP] Đang chờ mã xác minh, email=${acc.email}, số email trước khi gửi=${beforeCount}`)
  let accessToken = await refreshOutlookToken(acc)
  const maxRetries = Math.floor(timeout / interval)

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (signal?.aborted) throw new Error('Đăng ký đã bị hủy')
    let client: IMAPClient | null = null
    try {
      client = new IMAPClient()
      await client.connect()
      await client.authenticate(acc.email, accessToken)
      const total = await client.selectInbox()

      if (total <= beforeCount) {
        if (attempt % 5 === 0) console.log(`[Outlook IMAP] [${attempt}/${maxRetries}] Chưa có email mới (hiện có ${total})...`)
        await abortableSleep(interval * 1000, signal)
        continue
      }

      for (let i = total; i > beforeCount; i--) {
        try {
          const body = await client.fetchLatestBody(i)
          const code = extractCode(body)
          if (code) {
            console.log(`[Outlook IMAP] Đã lấy mã xác minh: ${code}`)
            return code
          }
        } catch { /* continue */ }
      }

      if (attempt % 5 === 0) console.log(`[Outlook IMAP] [${attempt}/${maxRetries}] Không tìm thấy mã xác minh trong email mới...`)
    } catch (err) {
      if (attempt % 5 === 0) console.log(`[Outlook IMAP] Kết nối thất bại:`, err)
      try { accessToken = await refreshOutlookToken(acc) } catch { /* ignore */ }
    } finally {
      client?.close()
    }
    await abortableSleep(interval * 1000, signal)
  }
  throw new Error(`Hết thời gian chờ mã xác minh (${timeout} giây)`)
}

// ============ Proton 邮箱（webview 借壳官方网页，轻量读 DOM 取码） ============

/**
 * Proton 点号别名取码源：用一个 Proton 母邮箱（如 evanbartellchae@protonmail.com），
 * 前端用 dotVariants 生成点号变体（evanbar.tellcha.e@protonmail.com）作为每个账号的注册邮箱，
 * 所有变体都进同一个 Proton 收件箱。读码经由主进程的隐藏 Proton 窗口（见 proton-mail-window.ts），
 * 官方网页负责登录与 PGP 解密，本类只接收前端生成好的具体地址并等待取码。
 */
export class ProtonWebviewService implements TempEmailService {
  /** 本次注册使用的具体邮箱地址（母邮箱或其点号变体，由前端生成传入） */
  private readonly address: string
  /** 日志回调：传入 registrar.this.log 时，取码日志会推送到注册页面日志面板；缺省回退 console */
  private readonly log: (msg: string) => void

  constructor(presetAddress: string, log?: (msg: string) => void) {
    this.address = (presetAddress || '').trim()
    if (!this.address) {
      throw new Error('Địa chỉ email Proton đang trống')
    }
    this.log = log || ((m) => console.log(m))
  }

  async create(): Promise<string> {
    this.log(`[Proton] Sử dụng email: ${this.address}`)
    return this.address
  }

  getAddress(): string {
    return this.address
  }

  async waitForCode(timeoutSec: number, intervalSec: number, signal?: AbortSignal): Promise<string> {
    const runtime = process.versions.electron
      ? await import('./proton-mail-window')
      : await import('../../server/services/protonBrowserRuntime')
    const { waitProtonOtp } = runtime
    return waitProtonOtp(this.address, {
      timeoutSec,
      intervalSec,
      signal,
      log: this.log
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
