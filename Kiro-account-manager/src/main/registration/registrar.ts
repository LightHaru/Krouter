import { SessionClient, type ModuleClient } from 'tlsclientwrapper'
import { acquireModuleClient } from './tlsClientPool'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { RegistrationConfig } from './config'
import { BrowserIdentity, randomIdentity } from './browser-identity'
import { ChainProxyRelay } from './chainProxy'
import { FingerprintContext, newFPContext, resetPerfTiming, generateFingerprint } from './fingerprint'
import { encryptPassword } from './jwe'
import { refreshAppJSConfig } from './xxtea'
import {
  visitorId, awsccc, ubidGen, newUUID, gmtDate,
  extractParam, splitAfter, saveCookies,
  getNestedMap, getNestedStringMap
} from './http-utils'
import {
  TempEmailService, MoEmailService, TempMailPlusService, TingamefiMailService, ProtonWebviewService,
  parseOutlookLines, getInboxCount, waitForOTP
} from './email-service'
import { getSystemProxy, safeCreateProxyAgent } from '../proxy/systemProxy'
import { redactString } from '../utils/redact'
import { getRuntimeUserDataPath } from '../runtimePaths'

export type LogFn = (message: string) => void

export interface FingerprintSnapshot {
  chromeVer: string
  ua: string
  gpuVendor: string
  gpuModel: string
  canvasHash: number
  screen: { width: number; height: number }
  /** 注册时使用的出口代理 URL（脱敏前缀） */
  proxyUrl?: string
  /** 探测到的出口 IP（注册时实际用的公网 IP） */
  exitIP?: string
}

export interface RegistrationResult {
  status: 'success' | 'failed'
  email: string
  password?: string
  error?: string
  clientId?: string
  clientSecret?: string
  refreshToken?: string
  accessToken?: string
  region?: string
  provider?: string
  verify?: Record<string, unknown>
  /** 本次注册使用的指纹摘要（用于审计与后续复用） */
  fingerprint?: FingerprintSnapshot
}

type StepFn = () => Promise<void>

/** 注册流程的可观察「阶段」标识，供前端按 taskId 实时显示进度 */
export type RegStepName =
  | 'init' | 'proxy-chain-ready' | 'tls-ready' | 'exit-ip'
  | 'oidc' | 'device' | 'email-created'
  | 'portal' | 'workflow-init' | 'submit-email'
  | 'signup' | 'send-otp' | 'waiting-otp' | 'otp-received'
  | 'create-identity' | 'set-password' | 'sso-workflow' | 'sso-token'
  | 'verify-alive' | 'done'

export interface RegStepEvent {
  name: RegStepName
  ts: number
  email?: string
  exitIp?: string
  extra?: Record<string, unknown>
}

export type StepFn2 = (event: RegStepEvent) => void

export class Registrar {
  private cfg: RegistrationConfig
  private session: SessionClient | null = null
  /** 共享的 ModuleClient（来自 tlsClientPool）；不在 cleanup 中 terminate，由进程退出时统一释放 */
  private moduleClient: ModuleClient | null = null
  private cookies = new Map<string, string>()
  private identity: BrowserIdentity
  private fpCtx: FingerprintContext
  private vid: string

  private email = ''
  private emailSvc: TempEmailService | null = null
  private clientId = ''
  private clientSecret = ''
  private deviceCode = ''
  private userCode = ''
  private workflowHandle = ''
  private workflowId = ''
  private workflowState = ''
  private ubid = ''
  private regCode = ''
  private signState = ''
  private authCode = ''
  private ssoState = ''
  private wdcCSRFToken = ''
  private ssoToken = ''
  private outlookMailCount = 0

  private log: LogFn
  private onStep: StepFn2
  private abortController = new AbortController()
  private chainRelay: ChainProxyRelay | null = null
  private chainTargetProxy = ''
  private exitIP = ''
  private readonly tlsSessionId = newUUID() // 固定：整个 Registrar 生命周期内 DLL 中只注册一个 session

  constructor(cfg: RegistrationConfig, log?: LogFn, onStep?: StepFn2) {
    this.cfg = cfg
    this.identity = randomIdentity()
    this.fpCtx = newFPContext(this.identity)
    this.vid = visitorId()
    // 注册日志会推送到 UI / 控制台，统一脱敏代理账密、token 等敏感片段
    const rawLog = log || ((msg: string): void => console.log(msg))
    this.log = (msg: string): void => rawLog(redactString(msg))
    this.onStep = onStep || ((): void => {})
  }

  /** 触发 step 事件：上层（前端 UI）可据此实时展示注册到了哪一步。失败时静默以不影响主流程。 */
  private emitStep(name: RegStepName, info?: Partial<RegStepEvent>): void {
    try {
      this.onStep({ name, ts: Date.now(), email: this.email || undefined, exitIp: this.exitIP || undefined, ...info })
    } catch { /* ignore */ }
  }

  /** 基于当前 identity 的 sec-ch-ua 头（动态生成，跟 chromeVer 对齐） */
  private get secUA(): string {
    const major = this.identity.chromeVer.split('.')[0]
    return `"Chromium";v="${major}", "Not/A)Brand";v="24", "Google Chrome";v="${major}"`
  }

  /** 中止当前注册流程 */
  abort(): void {
    this.abortController.abort()
  }

  /**
   * 启用代理链：若同时配置了 upstreamProxy(上游中转) 与 proxy(目标代理)，
   * 在本机起一个中继把链路串成「本机 → 中继 → 上游中转(非大陆) → 目标代理 → 目标站点」，
   * 并把 cfg.proxy 指向本地中继，使后续所有请求自动走链路。
   */
  private async setupProxyChain(): Promise<void> {
    const target = (this.cfg.proxy || '').trim()
    const upstream = (this.cfg.upstreamProxy || '').trim()
    if (!target || !upstream) return
    try {
      this.chainRelay = new ChainProxyRelay(upstream, target, (m) => this.log(m))
      const relayUrl = await this.chainRelay.start()
      this.chainTargetProxy = target
      this.cfg.proxy = relayUrl
      this.log('[ProxyChain] Đã bật chuỗi proxy: máy cục bộ → proxy trung chuyển → proxy đích → trang đích')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.chainRelay = null
      // 严格代理模式下，链路失败必须立刻中止，防止"回退仅用目标代理"时大陆 IP 被目标拒绝
      if (this.cfg.strictProxy) {
        throw new Error(`[ProxyChain] Bật thất bại, chế độ proxy nghiêm ngặt đã dừng: ${msg}`)
      }
      this.log(`[ProxyChain] Bật thất bại, chuyển sang dùng trực tiếp proxy đích: ${msg}`)
    }
  }

  private checkAborted(): void {
    if (this.abortController.signal.aborted) throw new Error('Đăng ký đã bị hủy')
  }

  /**
   * 探测当前代理的出口 IP 并写入日志。
   * 如果探测失败且代理 URL 是参数化格式（bestproxy 等），自动换 session 重建代理链重试。
   * 最多重试 maxRetries 次（默认 2），保证拿到可用出口再继续注册。
   */
  private async detectExitIP(maxRetries = 2): Promise<void> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const proxyUrl = this.sessionOpts.proxyUrl
      try {
        const agent = safeCreateProxyAgent(proxyUrl)
        const resp = await undiciFetch('https://api.ipify.org?format=json', {
          method: 'GET',
          dispatcher: agent || undefined,
          signal: AbortSignal.timeout(10000),
          headers: { 'User-Agent': this.identity.ua }
        } as UndiciRequestInit)
        if (resp.ok) {
          const body = await resp.json() as Record<string, unknown>
          const ip = String(body.ip || body.query || body.origin || '').trim()
          if (ip) {
            this.exitIP = ip
            this.emitStep('exit-ip', { exitIp: ip })
          }
          const via = proxyUrl ? proxyUrl.replace(/:([^:@/]+)@/, ':***@') : undefined
          this.log(`[✓ IP] IP đầu ra: ${ip || 'không xác định'}${via ? ` (qua ${via})` : ' (kết nối trực tiếp)'}`)
          return // 成功，退出
        }
        this.log(`[IP] Kiểm tra IP đầu ra thất bại: HTTP ${resp.status}`)
      } catch (err) {
        this.log(`[IP] Kiểm tra IP đầu ra thất bại: ${err instanceof Error ? err.message : String(err)}`)
      }

      // 失败后尝试换 session 重建代理链
      if (attempt < maxRetries && this.canRefreshProxySession()) {
        this.log(`[IP] Đổi phiên và thử lại (${attempt + 1}/${maxRetries})...`)
        await this.refreshProxySession()
      }
    }
    if (this.cfg.strictProxy) {
      throw new Error('[NetworkGuard] Không thể xác minh IP đầu ra của route đã khóa; đã dừng đăng ký')
    }
    this.log('[IP] Tất cả lần kiểm tra IP đầu ra đều thất bại, tiếp tục bằng kết nối hệ thống')
  }

  /** 判断当前代理是否支持 session 轮换（参数化格式 + 含 _session- 或含 _area-/_life- 等） */
  private canRefreshProxySession(): boolean {
    return false
  }

  /** 重新随机 session 并重建代理链 */
  private async refreshProxySession(): Promise<void> {
    // 还原到原始目标代理 URL（代理链会把 cfg.proxy 替换为本地中继地址）
    const original = this.chainTargetProxy || this.cfg.proxy || ''
    if (!original) return

    // 替换或追加 _session-随机值
    const session = Array.from({ length: 8 }, () =>
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]
    ).join('')

    let newTarget: string
    if (/_session-[^_:@/]*/i.test(original)) {
      // 已有 _session-xxx → 替换
      newTarget = original.replace(/(_session-)[^_:@/]*/i, `$1${session}`)
    } else {
      // 没有 _session- → 在 : 或 @ 之前插入
      const atIdx = original.indexOf('@')
      const colonIdx = original.indexOf(':', original.indexOf('://') + 3)
      const insertPos = colonIdx > 0 && colonIdx < atIdx ? colonIdx : atIdx
      newTarget = original.slice(0, insertPos) + `_session-${session}` + original.slice(insertPos)
    }

    this.log(`[IP] Phiên mới: ${newTarget.replace(/:([^:@/]+)@/, ':***@')}`)

    // 停掉旧代理链
    if (this.chainRelay) {
      await this.chainRelay.stop()
      this.chainRelay = null
    }

    // 重建
    this.cfg.proxy = newTarget
    this.chainTargetProxy = ''
    await this.setupProxyChain()
  }

  /** TLS SessionClient 选项 */
  private get sessionOpts() {
    const explicit = (this.cfg.proxy && this.cfg.proxy.trim()) || undefined
    // 严格模式：必须有显式代理，禁止回退到环境变量/系统代理，避免网络路径静默改变。
    if (this.cfg.strictProxy) {
      if (!explicit) {
        throw new Error('Chế độ proxy nghiêm ngặt: cfg.proxy đang trống, đã dừng để tránh tự động đổi cấu hình mạng')
      }
    }
    const proxyUrl = this.cfg.strictProxy
      ? explicit
      : (explicit
        || process.env.HTTPS_PROXY || process.env.https_proxy
        || process.env.HTTP_PROXY || process.env.http_proxy
        || getSystemProxy() || undefined)
    return {
      tlsClientIdentifier: 'chrome_146' as const,
      // 25s：AWS 注册 API 正常响应 1-5s，慢住宅代理 10-15s；超过基本是挂起。
      // 配合 sendRequest 的 3 次重试，单步最坏 ~75s（旧值 60s 会到 ~180s，是批量卡 1-5 分钟主因）
      timeoutSeconds: 25,
      followRedirects: true,
      insecureSkipVerify: true,
      // 多线程隔离：固定 sessionId 隔离 DLL 层面共享的 TLS session cache
      // 整个 Registrar 生命周期内用同一个 ID，避免 rebuildTlsClient 产生僵尸 session
      sessionId: this.tlsSessionId,
      proxyUrl
    }
  }

  /**
   * 初始化 TLS 客户端
   *
   * DLL 存储策略（按优先级，从高到低）：
   *   1. userData/tls-client/ — 应用用户数据目录（系统不会清理，**永久复用**）
   *   2. resources/ — 应用安装目录（打包资源，开发版可能不存在）
   *   3. tmpdir → 自动迁移到 userData（老版本兼容）
   *   4. GitHub 下载到 userData（最后兜底，仅首次）
   */
  private async initTlsClient(): Promise<void> {
    const { existingPath, downloadDir } = this.ensureTlsLib()
    const opts = existingPath
      ? { customLibraryPath: existingPath }
      : { customLibraryDownloadPath: downloadDir }
    // 共享池：首次注册才真正 open(DLL+worker pool)，之后所有注册秒级复用
    this.moduleClient = await acquireModuleClient(opts)
    this.log('[TLS] using shared ModuleClient, pool stats: ' + JSON.stringify(this.moduleClient.getPoolStats()))
    this.session = new SessionClient(this.moduleClient, this.sessionOpts)
  }

  /**
   * 确保 tls-client 共享库可用
   * @returns existingPath 已经存在的完整 DLL 文件路径（如有，传 customLibraryPath）
   *          downloadDir  需要下载到的目录（如未找到，传 customLibraryDownloadPath 让 tlsclientwrapper 自动下载）
   *
   * 优先放到 userData，避免被系统临时目录清理工具误删（之前用 tmpdir 会被清理）
   */
  private ensureTlsLib(): { existingPath?: string; downloadDir: string } {
    const os = require('os')
    const path = require('path')
    const fs = require('fs')

    const platform = os.platform()
    const arch = os.arch()
    let filename = 'tls-client-xgo-1.14.0-'
    if (platform === 'win32') {
      filename += (arch.includes('64') ? 'windows-amd64' : 'windows-386') + '.dll'
    } else if (platform === 'darwin') {
      filename += (arch === 'arm64' ? 'darwin-arm64' : 'darwin-amd64') + '.dylib'
    } else {
      filename += (arch === 'arm64' ? 'linux-arm64' : 'linux-amd64') + '.so'
    }

    // 1. userData 永久目录（首选）
    const userDataDir = getRuntimeUserDataPath()
    const tlsClientDir = path.join(userDataDir, 'tls-client')
    const finalPath = path.join(tlsClientDir, filename)

    // 确保目录存在
    try { fs.mkdirSync(tlsClientDir, { recursive: true }) } catch { /* ignore */ }

    // 已存在 → 直接复用
    if (fs.existsSync(finalPath)) {
      this.log('[TLS] Library reused from userData (persistent): ' + finalPath)
      return { existingPath: finalPath, downloadDir: tlsClientDir }
    }

    // 2. 从打包资源复制（安装包自带）
    const resourceCandidates = [
      path.join(process.resourcesPath || '', filename),
      path.join(__dirname, '..', '..', '..', 'resources', filename)
    ]
    const resourcePath = resourceCandidates.find((candidate) => fs.existsSync(candidate))
    if (resourcePath) {
      this.log('[TLS] Copying library from resources to userData (one-time): ' + resourcePath + ' -> ' + finalPath)
      try {
        fs.copyFileSync(resourcePath, finalPath)
        return { existingPath: finalPath, downloadDir: tlsClientDir }
      } catch (err) {
        this.log('[TLS] Failed to copy from resources: ' + (err as Error).message)
      }
    }

    // 3. 兼容老版本：检测 tmpdir 副本并迁移到 userData
    const tmpPath = path.join(os.tmpdir(), filename)
    if (fs.existsSync(tmpPath)) {
      this.log('[TLS] Migrating library from tmpdir to userData: ' + tmpPath + ' -> ' + finalPath)
      try {
        fs.copyFileSync(tmpPath, finalPath)
        return { existingPath: finalPath, downloadDir: tlsClientDir }
      } catch (err) {
        this.log('[TLS] Migration failed, will use tmpdir as fallback: ' + (err as Error).message)
        return { existingPath: tmpPath, downloadDir: tlsClientDir }
      }
    }

    // 4. 都没有 → 返回 downloadDir，让 tlsclientwrapper open() 自动下载到此目录（永久保存）
    this.log('[TLS] Library not found, will download from GitHub to userData (one-time): ' + tlsClientDir)
    return { downloadDir: tlsClientDir }
  }

  private async rebuildTlsClient(): Promise<void> {
    // 只重建轻量级的 SessionClient（新 TLS 连接），复用重量级的 ModuleClient（worker pool + DLL）
    // 之前的实现会 terminate + 重新 open ModuleClient，导致每次注册创建 2 个 worker pool
    try { await this.session?.destroySession() } catch { /* ignore */ }
    if (!this.moduleClient) {
      await this.initTlsClient()
      return
    }
    this.session = new SessionClient(this.moduleClient, this.sessionOpts)
  }

  /**
   * 用 undici 直接 fetch 静态资源（如 AWS signin app.js），绕过 tls-client。
   * 原因：tls-client 的 dll 是进程级单例，失败请求会污染其全局状态，
   * 导致后续重建 SessionClient 后仍报 "no tls client for modification check"。
   * 静态资源不需要 TLS 指纹伪装，直接用 Node/undici fetch 即可。
   */
  private async fetchAppJS(url: string, init?: RequestInit): Promise<Response> {
    const proxyUrl = (this.cfg.proxy && this.cfg.proxy.trim())
      || process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || getSystemProxy() || undefined
    const agent = safeCreateProxyAgent(proxyUrl)
    if (agent) {
      const resp = await undiciFetch(url, { ...(init as UndiciRequestInit), dispatcher: agent })
      return resp as unknown as Response
    }
    return await fetch(url, init)
  }

  private isRecoverableTlsClientError(err: unknown): boolean {
    if (!(err instanceof Error)) return false
    return err.message.includes('EOF')
      || err.message.includes('no tls client for modification check')
      || err.message.includes('failed to modify existing client')
  }

  /** 清理 TLS 客户端资源：仅销毁 SessionClient；ModuleClient 是进程级共享池，不再每次 terminate */
  private async cleanup(): Promise<void> {
    if (this.chainRelay) {
      try { await this.chainRelay.stop() } catch { /* ignore */ }
      this.chainRelay = null
    }
    if (this.session) {
      // destroySession 带 3 秒超时：Go runtime 的 idle connections 可能要等 60 秒才关闭
      const s = this.session
      this.session = null
      try {
        await Promise.race([
          s.destroySession(),
          new Promise(resolve => setTimeout(resolve, 3000))
        ])
      } catch { /* ignore */ }
    }
    // moduleClient 是共享引用，不能 terminate（会影响其它正在跑的注册）
    this.moduleClient = null
  }

  /** 公共销毁方法，供外部调用释放资源。同时 abort 所有进行中的异步操作。 */
  async destroy(): Promise<void> {
    this.abortController.abort()
    await this.cleanup()
  }

  // ============ HTTP 工具方法 ============

  private cookieString(): string {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ')
  }

  private buildHeaders(referer: string, origin: string): Record<string, string> {
    const h: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Content-Type': 'application/json',
      'User-Agent': this.identity.ua,
      'sec-ch-ua': this.secUA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin'
    }
    if (referer) h['Referer'] = referer
    if (origin) h['Origin'] = origin
    if (this.cookies.size > 0) h['Cookie'] = this.cookieString()
    return h
  }

  private buildProfileHeaders(referer: string): Record<string, string> {
    const h: Record<string, string> = {
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Content-Type': 'application/json;charset=UTF-8',
      'User-Agent': this.identity.ua,
      'Origin': this.cfg.profileBase,
      'Referer': referer,
      'sec-ch-ua': this.secUA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'priority': 'u=1, i'
    }
    const keys = ['awsccc', 'aws-user-profile-ubid', 'i18next']
    if (this.cookies.has('awsd2c-token')) keys.push('awsd2c-token', 'awsd2c-token-c')
    const parts = keys.filter((k) => this.cookies.has(k)).map((k) => `${k}=${this.cookies.get(k)}`)
    if (parts.length) h['Cookie'] = parts.join('; ')
    return h
  }

  private async doGet(url: string, headers: Record<string, string>): Promise<{ body: string; status: number; headers: Record<string, string | string[]> }> {
    return this.sendRequest('GET', url, headers)
  }

  private async doPost(url: string, payload: unknown, headers: Record<string, string>): Promise<{ body: string; status: number; headers: Record<string, string | string[]> }> {
    return this.sendRequest('POST', url, headers, JSON.stringify(payload))
  }

  /** 网络层退避时长：指数 + 抖动（约 0.8s / 1.6s / 3.2s，封顶 8s） */
  private netBackoffMs(attempt: number): number {
    const base = Math.min(800 * Math.pow(2, attempt - 1), 8000)
    return base + Math.floor(Math.random() * 400)
  }

  /**
   * 判断响应是否为「瞬时失败」需要重试。
   * 关键：tlsclientwrapper 会把连接层失败（EOF / 重置 / 超时）包装成 status=0 + body 错误描述，
   * 并不抛异常；若不在响应层识别，会被上层当成业务失败直接判死号（如 #9 的「未获取到加密公钥」）。
   */
  private isTransientResponse(status: number, body: string): boolean {
    if (status === 0 || status === 429 || status === 502 || status === 503 || status === 504) return true
    const lower = body.toLowerCase()
    return lower.includes('failed to do request') || lower.includes('eof')
      || lower.includes('connection reset') || lower.includes('timeout')
  }

  /**
   * 判断是否为「超时类」失败（出口链路慢 / 网络抖动 / 隧道挂起）。
   * 这类失败重建 TLS 通常无用，应 refresh proxy session 后重建链路。
   */
  private isTimeoutResponse(status: number, body: string): boolean {
    if (status === 504) return true
    if (status !== 0) return false
    const lower = body.toLowerCase()
    return lower.includes('timeout') || lower.includes('deadline')
      || lower.includes('client.timeout') || lower.includes('failed to do request')
  }

  /**
   * 统一的 TLS 请求发送：对瞬时网络失败（status=0 / EOF / 5xx / 429）自动「重建 TLS + 指数退避」重试。
   * 连接类失败才重建客户端，限流类仅退避；cookies 存于 this.cookies，不随重建丢失。
   */
  private async sendRequest(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    body?: string
  ): Promise<{ body: string; status: number; headers: Record<string, string | string[]> }> {
    if (!this.session) throw new Error('TLS client chưa được khởi tạo')
    const maxAttempts = 3
    let lastErr: unknown = null
    let sessionRefreshed = false // 整个请求最多换 1 次 proxy session，避免频繁停建代理链
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const resp = method === 'GET'
          ? await this.session!.get(url, { headers })
          : await this.session!.post(url, body ?? '', { headers })
        const decoded = this.decodeBody(resp.body)
        const status = resp.status
        if (attempt < maxAttempts && this.isTransientResponse(status, decoded)) {
          const broken = status === 0 || /eof|reset|failed to do request/i.test(decoded)
          // 超时类（出口链路慢/网络抖动/隧道挂起）：refresh proxy session 后重建链路。
          if (this.isTimeoutResponse(status, decoded) && !sessionRefreshed && this.canRefreshProxySession()) {
            this.log(`[Mạng] ${method} hết thời gian chờ (status=${status}), làm mới phiên proxy rồi thử lại ${attempt}/${maxAttempts - 1}`)
            try {
              await this.refreshProxySession()
              await this.rebuildTlsClient()
              sessionRefreshed = true
            } catch (e) {
              this.log(`[Mạng] Đổi phiên thất bại, chuyển sang tạo lại kết nối thông thường: ${e instanceof Error ? e.message : String(e)}`)
              await this.rebuildTlsClient()
            }
          } else {
            this.log(`[Mạng] ${method} tạm thời thất bại status=${status}, ${broken ? 'tạo lại TLS + ' : ''}chờ rồi thử lại ${attempt}/${maxAttempts - 1}`)
            if (broken) await this.rebuildTlsClient()
          }
          await this.abortableSleep(this.netBackoffMs(attempt))
          continue
        }
        return { body: decoded, status, headers: (resp.headers || {}) as Record<string, string | string[]> }
      } catch (err: unknown) {
        lastErr = err
        if (attempt < maxAttempts && this.isRecoverableTlsClientError(err)) {
          this.log(`[TLS] ${method} gặp lỗi có thể khôi phục: ${err instanceof Error ? err.message : String(err)}, tạo lại TLS rồi thử lại ${attempt}/${maxAttempts - 1}`)
          await this.rebuildTlsClient()
          await this.abortableSleep(this.netBackoffMs(attempt))
          continue
        }
        throw err
      }
    }
    if (lastErr) throw lastErr
    throw new Error(`${method} ${url} vẫn thất bại sau ${maxAttempts} lần thử`)
  }

  /** 可被中止打断的 sleep：停止注册时立即结束等待，让 abort 即时生效 */
  private abortableSleep(ms: number): Promise<void> {
    const signal = this.abortController.signal
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Đăng ký đã bị hủy')); return }
      let timer: ReturnType<typeof setTimeout>
      const onAbort = (): void => { clearTimeout(timer); reject(new Error('Đăng ký đã bị hủy')) }
      timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** 拟人随机延迟：步骤之间停顿，降低机械化节奏特征 */
  private async humanDelay(min = 280, max = 1200): Promise<void> {
    await this.abortableSleep(min + Math.floor(Math.random() * Math.max(1, max - min)))
  }

  /**
   * 整体超时看门狗：给任意步骤 Promise 加上限，超时后 reject（原 Promise 在后台自生自灭）。
   * 用于批量场景快速释放卡住的线程，避免单个账号占用并发槽 1-5 分钟。支持 abort 即时中断。
   */
  private withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    const signal = this.abortController.signal
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) { reject(new Error('Đăng ký đã bị hủy')); return }
      let done = false
      const settle = (fn: () => void): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        fn()
      }
      const timer = setTimeout(() => settle(() => reject(new Error(`${label} hết thời gian chờ tổng thể ${Math.round(ms / 1000)} giây`))), ms)
      const onAbort = (): void => settle(() => reject(new Error('Đăng ký đã bị hủy')))
      signal.addEventListener('abort', onAbort, { once: true })
      p.then(
        (v) => settle(() => resolve(v)),
        (e) => settle(() => reject(e))
      )
    })
  }

  /**
   * 幂等步骤重试：失败后退避重试（仅用于无副作用的前置步骤，如 OIDC / Device / Portal / WorkflowInit）。
   * - timeoutMs：每次尝试加整体超时看门狗，超时即判失败进入下一次（防止单次卡满 3×25s）
   * - refreshSession：失败后若代理支持，refresh proxy session 再退避（处理慢链路或隧道挂起）
   */
  private async retryStep(
    name: string,
    fn: StepFn,
    attempts: number,
    opts?: { timeoutMs?: number; refreshSession?: boolean }
  ): Promise<void> {
    let lastErr: unknown = null
    for (let i = 1; i <= attempts; i++) {
      try {
        if (opts?.timeoutMs) await this.withTimeout(fn(), opts.timeoutMs, name)
        else await fn()
        return
      } catch (err) {
        lastErr = err
        if (i < attempts) {
          // 幂等步骤失败：若支持 session refresh，先重建代理会话再退避。
          if (opts?.refreshSession && this.canRefreshProxySession()) {
            try {
              await this.refreshProxySession()
              await this.rebuildTlsClient()
              this.log(`[${name}] Đã làm mới phiên proxy`)
            } catch { /* 换 session 失败则继续普通重试 */ }
          }
          const wait = 1500 * i + Math.floor(Math.random() * 800)
          this.log(`[${name}] Lần ${i}/${attempts} thất bại: ${(err as Error).message}, thử lại sau ${wait}ms`)
          await this.abortableSleep(wait)
        }
      }
    }
    throw lastErr
  }

  /**
   * tls-client 返回的 body 是字节透传字符串（latin1）；
   * 如果响应实际是 UTF-8 编码（含中文等多字节），需要二次解码。
   * 实现：把 string 当作 latin1 字节读回，再用 UTF-8 解码；
   * 若解码后含 U+FFFD 替换字符比原文多很多，则回退原值（说明原本就是 latin1 / ASCII）。
   */
  private decodeBody(body: string | undefined | null): string {
    if (!body) return ''
    try {
      // 快速路径：纯 ASCII 直接返回
      // eslint-disable-next-line no-control-regex
      if (/^[\x00-\x7F]*$/.test(body)) return body
      const buf = Buffer.from(body, 'latin1')
      const utf8 = buf.toString('utf-8')
      // 检测 mojibake：原文如果在 latin1 解码 UTF-8 字节，会出现大量字符在 \u00a0-\u00ff 区间
      // 重解后如果替换字符数量明显多于原文，说明不是 UTF-8，回退原值
      const replaceInOriginal = (body.match(/\uFFFD/g) || []).length
      const replaceInUtf8 = (utf8.match(/\uFFFD/g) || []).length
      if (replaceInUtf8 > replaceInOriginal + 2) return body
      return utf8
    } catch {
      return body
    }
  }

  private parseBody(body: string): Record<string, unknown> {
    try { return JSON.parse(body) } catch { return {} }
  }

  /**
   * 识别 AWS 风控触发的错误响应，返回人类可读的标签
   * @returns 风控类型标签（如 'AWS-RISK-CONTROL'），不是风控返回 null
   */
  private detectRiskControl(body: string, status: number): string | null {
    if (status !== 400) return null
    const lower = body.toLowerCase()
    // 中文消息（已正确解码）
    if (body.includes('请稍后再试') && body.includes('管理员')) return 'AWS-RISK-CONTROL'
    if (body.includes('发生意外错误')) return 'AWS-RISK-CONTROL'
    // 英文消息
    if (lower.includes('try again later') && lower.includes('administrator')) return 'AWS-RISK-CONTROL'
    if (lower.includes('unexpected error') && lower.includes('contact')) return 'AWS-RISK-CONTROL'
    return null
  }

  /** 把响应错误格式化为更友好的消息（含风控识别） */
  private formatErrorBody(body: string, status: number): string {
    const risk = this.detectRiskControl(body, status)
    if (risk) {
      return `${risk} (AWS đã chặn yêu cầu; đề xuất: 1) dừng tác vụ hàng loạt hiện tại; 2) bật giới hạn tốc độ và tự động tạm dừng; 3) tránh đăng ký hàng loạt cùng một tên miền email; 4) nếu tài khoản bị hạn chế, liên hệ Support theo hướng dẫn của AWS/Kiro)`
    }
    return `status=${status} body=${body.substring(0, 200)}`
  }

  private async fetchD2CToken(origin: string, referer: string): Promise<void> {
    const headers: Record<string, string> = {
      'Accept': '*/*', 'Content-Type': 'application/json',
      'User-Agent': this.identity.ua, 'Origin': origin, 'Referer': referer,
      'sec-ch-ua': this.secUA, 'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site', 'priority': 'u=1, i'
    }
    const parts: string[] = []
    if (this.cookies.has('awsccc')) parts.push('awsccc=' + this.cookies.get('awsccc'))
    if (this.cookies.has('awsd2c-token')) {
      const old = this.cookies.get('awsd2c-token')!
      parts.push('awsd2c-token=' + old, 'awsd2c-token-c=' + old)
    }
    if (parts.length) headers['Cookie'] = parts.join('; ')

    const payload: Record<string, string> = {}
    if (this.cookies.has('awsd2c-token')) payload.token = this.cookies.get('awsd2c-token')!

    const resp = await this.doPost('https://vs.aws.amazon.com/token', payload, headers)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    const tok = data.token as string
    if (tok) {
      this.cookies.set('awsd2c-token', tok)
      this.cookies.set('awsd2c-token-c', tok)
      // 从 JWT 中提取 visitor ID
      const jwtParts = tok.split('.')
      if (jwtParts.length >= 2) {
        try {
          const decoded = JSON.parse(Buffer.from(jwtParts[1], 'base64url').toString())
          if (decoded.vid) this.vid = decoded.vid
        } catch { /* ignore */ }
      }
    }
  }

  // ============ 指纹生成 ============

  private genFP(pageType: string, eventType: string, emailLen: number, emailAddr: string): string {
    return this.genFPWithTime(pageType, eventType, 0, emailLen, emailAddr)
  }

  private genFPWithTime(pageType: string, eventType: string, timeOnPage: number, emailLen: number, emailAddr: string): string {
    const did = this.cfg.directoryId
    let loc = '', ref = ''

    switch (pageType) {
      case 'signin':
        loc = `${this.cfg.signinBase}/platform/${did}/login?workflowStateHandle=${this.workflowHandle}`
        break
      case 'signup':
        loc = `${this.cfg.signinBase}/platform/${did}/signup?workflowStateHandle=${this.workflowHandle}`
        break
      default: // profile
        if (eventType === 'PageSubmit') {
          loc = `${this.cfg.profileBase}/?workflowID=${this.workflowId}#/signup/enter-email`
        } else {
          loc = `${this.cfg.profileBase}/?workflowID=${this.workflowId}#/signup/start`
        }
        if (!this.workflowId) loc = this.cfg.profileBase + '/'
    }

    if (pageType === 'profile') {
      ref = `${this.cfg.signinBase}/platform/${did}/signup?workflowStateHandle=${this.workflowHandle}`
    } else {
      ref = this.cfg.viewBase + '/'
    }

    return generateFingerprint(this.identity, loc, ref, this.fpCtx, pageType, eventType, timeOnPage, emailLen, emailAddr)
  }

  // ============ 注册步骤 ============

  private async step1OIDC(): Promise<void> {
    this.emitStep('oidc')
    this.log('[1] Đăng ký OIDC')
    const payload = {
      clientName: 'Amazon Q Developer for command line',
      clientType: 'public',
      scopes: ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations', 'codewhisperer:transformations', 'codewhisperer:taskassist']
    }
    const headers = { 'Content-Type': 'application/json' }

    let resp: { body: string; status: number; headers: Record<string, string | string[]> } | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        resp = await this.doPost(this.cfg.oidcBase + '/client/register', payload, headers)
        if (resp.status === 200) break
      } catch (err: unknown) {
        if (attempt < 2) {
          this.log(`[1] Thử lại OIDC (${attempt + 1}/3)...`)
          await this.abortableSleep(2000 * (attempt + 1))
          await this.rebuildTlsClient()
          continue
        }
        throw err
      }
    }
    if (!resp) throw new Error('Đăng ký OIDC thất bại: tất cả lần thử đều thất bại')
    const data = this.parseBody(resp.body)
    this.clientId = (data.clientId as string) || ''
    this.clientSecret = (data.clientSecret as string) || ''
    if (!this.clientId) throw new Error(`Đăng ký OIDC thất bại: ${resp.body.slice(0, 200)}`)
  }

  private async step2Device(): Promise<void> {
    this.emitStep('device')
    this.log('[2] Cấp quyền thiết bị')
    const resp = await this.doPost(this.cfg.oidcBase + '/device_authorization', {
      clientId: this.clientId, clientSecret: this.clientSecret,
      startUrl: this.cfg.startURL
    }, { 'Content-Type': 'application/json' })
    const data = this.parseBody(resp.body)
    this.deviceCode = (data.deviceCode as string) || ''
    this.userCode = (data.userCode as string) || ''
    this.log(`user_code=${this.userCode}`)
  }

  private async step3Email(): Promise<void> {
    if (this.cfg.manualMode) return // 手动模式在外部设置

    if (this.cfg.useOutlook && this.cfg.outlookData) {
      this.log('[3] Sử dụng email Outlook')
      const accounts = parseOutlookLines(this.cfg.outlookData)
      if (accounts.length === 0) throw new Error('Không có tài khoản Outlook khả dụng')
      // 单行 → 直接用（批量并发时前端已为每个 task 切一行，避免并发抢占）
      // 多行（单次注册）→ 随机挑一行
      const acc = accounts.length === 1
        ? accounts[0]
        : accounts[Math.floor(Math.random() * accounts.length)]
      this.email = acc.email
      this.emitStep('email-created')
      this.log(`email=${this.email}`)
      return
    }

    if (this.cfg.useTempMailPlus) {
      this.log('[3] Sử dụng email tên miền riêng (TempMail.Plus)')
      if (!this.cfg.tempMailPlusEmail || !this.cfg.tempMailPlusEpin || !this.cfg.tempMailPlusDomain) {
        throw new Error('Cấu hình TempMail.Plus chưa đầy đủ')
      }
      this.emailSvc = new TempMailPlusService(
        this.cfg.tempMailPlusEmail, this.cfg.tempMailPlusEpin, this.cfg.tempMailPlusDomain
      )
      this.email = await this.emailSvc.create()
      if (!this.email) throw new Error('Tạo địa chỉ email thất bại')
      this.emitStep('email-created')
      this.log(`email=${this.email}`)
      return
    }

    if (this.cfg.useTingamefiMail) {
      this.log('[3] Sử dụng email tạm Tingamefi')
      if (!this.cfg.tingamefiMailApiUrl || !this.cfg.tingamefiMailAdminPassword || !this.cfg.tingamefiMailDomain) {
        throw new Error('Cấu hình email Tingamefi chưa đầy đủ')
      }
      this.emailSvc = new TingamefiMailService(
        this.cfg.tingamefiMailApiUrl,
        this.cfg.tingamefiMailAdminPassword,
        this.cfg.tingamefiMailDomain
      )
      this.email = await this.emailSvc.create()
      if (!this.email) throw new Error('Tạo địa chỉ email Tingamefi thất bại')
      this.emitStep('email-created')
      this.log(`email=${this.email}`)
      return
    }

    if (this.cfg.useProton) {
      this.log('[3] Sử dụng email Proton (bí danh dấu chấm)')
      if (!this.cfg.protonEmail) {
        throw new Error('Chưa cấu hình địa chỉ email Proton')
      }
      this.emailSvc = new ProtonWebviewService(this.cfg.protonEmail, (m) => this.log(m))
      this.email = await this.emailSvc.create()
      if (!this.email) throw new Error('Địa chỉ email Proton đang trống')
      this.emitStep('email-created')
      this.log(`email=${this.email}`)
      return
    }

    this.log('[3] Tạo email tạm')
    if (!this.cfg.moEmailBaseURL) throw new Error('Chưa cấu hình MoEmail')
    this.emailSvc = new MoEmailService(this.cfg.moEmailBaseURL, this.cfg.moEmailAPIKey)
    this.email = await this.emailSvc.create()
    if (!this.email) throw new Error('Tạo email tạm thất bại')
    this.emitStep('email-created')
    this.log(`email=${this.email}`)
  }

  private async step4Portal(): Promise<void> {
    this.emitStep('portal')
    this.log('[4] Khởi tạo Portal')
    this.cookies.set('awsccc', awsccc())
    const redirect = `${this.cfg.viewBase}/start/#/device?user_code=${this.userCode}`
    const url = `${this.cfg.portalBase}/login?directory_id=view&redirect_url=${redirect}`

    const h: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/json',
      'Origin': this.cfg.viewBase,
      'Referer': this.cfg.viewBase + '/',
      'User-Agent': this.identity.ua
    }
    const resp = await this.doGet(url, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)

    const rurl = (data.redirectUrl as string) || ''
    if (rurl.includes('workflowStateHandle=')) {
      this.workflowHandle = splitAfter(rurl, 'workflowStateHandle=')
    }
    if (data.csrfToken) this.cookies.set('loginCsrfToken', data.csrfToken as string)
    if (!this.workflowHandle) throw new Error('Portal không trả về workflow handle')

    const loginURL = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`
    await this.fetchD2CToken(this.cfg.signinBase, loginURL)
  }

  private async step5WorkflowInit(): Promise<void> {
    this.emitStep('workflow-init')
    this.log('[5] Khởi tạo quy trình')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`

    let fp = this.genFP('signin', 'first_load', 0, '')
    let rid = newUUID()
    let h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    let resp = await this.doPost(api, {
      stepId: '', workflowStateHandle: this.workflowHandle,
      inputs: [{ input_type: 'FingerPrintRequestInput', fingerPrint: fp }],
      requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    let data = this.parseBody(resp.body)
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string

    if (data.stepId === 'start') {
      fp = this.genFP('signin', 'PageLoad', 0, '')
      rid = newUUID()
      h = this.buildHeaders(ref, this.cfg.signinBase)
      h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

      resp = await this.doPost(api, {
        stepId: 'start', workflowStateHandle: this.workflowHandle,
        inputs: [{ input_type: 'FingerPrintRequestInput', fingerPrint: fp }],
        requestId: rid
      }, h)
      saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
      data = this.parseBody(resp.body)
      if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string
    }
  }

  private async step6SubmitEmail(): Promise<'signup' | 'login'> {
    this.emitStep('submit-email')
    this.log(`[6] Gửi email ${this.email}`)
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`
    const fp = this.genFP('signin', 'PageSubmit', this.email.length, this.email)
    const rid = newUUID()
    const h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    const resp = await this.doPost(api, {
      stepId: 'get-identity-user', workflowStateHandle: this.workflowHandle,
      actionId: 'SUBMIT',
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'ApplicationTypeRequestInput', applicationType: 'SSO_INDIVIDUAL_ID' },
        {
          input_type: 'UserEventRequestInput', directoryId: this.cfg.directoryId,
          userName: this.email,
          userEvents: [{ input_type: 'UserEvent', eventType: 'PAGE_SUBMIT', pageName: 'IDENTIFICATION', timeSpentOnPage: 5000 }]
        },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string

    if (resp.status === 400) return 'signup'
    if (resp.status === 200) return 'login'
    throw new Error(`Gửi email thất bại: ${resp.status} - ${resp.body.slice(0, 200)}`)
  }

  private async step7Signup(): Promise<void> {
    this.emitStep('signup')
    this.log('[7] Đăng ký (SIGNUP)')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${this.workflowHandle}`
    const fp = this.genFP('signup', 'PageSubmit', 0, '')
    const rid = newUUID()
    const h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    const resp = await this.doPost(api, {
      stepId: 'get-identity-user', workflowStateHandle: this.workflowHandle,
      actionId: 'SIGNUP',
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    const redir = data.redirect as Record<string, unknown> | undefined
    const rurl = redir?.url as string
    if (rurl?.includes('workflowStateHandle=')) {
      this.workflowHandle = splitAfter(rurl, 'workflowStateHandle=')
    }
  }

  private async step7_5SignupInit(): Promise<void> {
    this.log('[7.5] Khởi tạo API đăng ký')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup?workflowStateHandle=${this.workflowHandle}`

    let fp = this.genFP('signup', 'first_load', 0, '')
    let rid = newUUID()
    let h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    let resp = await this.doPost(api, {
      stepId: '', workflowStateHandle: this.workflowHandle,
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    let data = this.parseBody(resp.body)
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string
    if (data.stepId !== 'start') throw new Error(`Khởi tạo đăng ký thất bại: ${this.formatErrorBody(resp.body, resp.status)}`)

    fp = this.genFP('signup', 'PageLoad', 0, '')
    rid = newUUID()
    h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    resp = await this.doPost(api, {
      stepId: 'start', workflowStateHandle: this.workflowHandle,
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    data = this.parseBody(resp.body)
    if (data.workflowStateHandle) this.workflowHandle = data.workflowStateHandle as string
    const redir = data.redirect as Record<string, unknown> | undefined
    const rurl = redir?.url as string
    if (rurl?.includes('workflowID=')) {
      let wid = splitAfter(rurl, 'workflowID=')
      const hashIdx = wid.indexOf('#')
      if (hashIdx >= 0) wid = wid.slice(0, hashIdx)
      this.workflowId = wid
    }
    if (!this.workflowId) throw new Error('Khởi tạo đăng ký không trả về workflowID')
  }

  private async step7_8ProfileInit(): Promise<void> {
    this.log('[7.8] Khởi tạo trang hồ sơ')
    this.ubid = ubidGen()
    this.cookies.set('aws-user-profile-ubid', this.ubid)
    this.cookies.set('i18next', 'zh-CN')
    if (!this.cookies.has('awsccc')) this.cookies.set('awsccc', awsccc())

    const url = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`
    const resp = await this.doGet(url, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': this.identity.ua,
      'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate'
    })
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    resetPerfTiming(this.fpCtx)
    await this.fetchD2CToken(this.cfg.profileBase, url)
  }

  private async step8ProfileStart(): Promise<void> {
    this.log('[8] Khởi động hồ sơ')
    const ref = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`
    const fp = this.genFP('profile', 'PageLoad', 0, '')

    const resp = await this.doPost(this.cfg.profileBase + '/api/start', {
      workflowID: this.workflowId,
      browserData: {
        attributes: {
          fingerprint: fp,
          eventTimestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
          timeSpentOnPage: '38', eventType: 'PageLoad',
          ubid: this.ubid, visitorId: this.vid
        },
        cookies: {}
      }
    }, this.buildProfileHeaders(ref))
    const data = this.parseBody(resp.body)
    this.workflowState = (data.workflowState as string) || ''
    if (!this.workflowState) throw new Error(`Khởi động hồ sơ không trả về workflowState: ${resp.body.slice(0, 200)}`)
  }

  private async step9SendOTP(): Promise<void> {
    this.emitStep('send-otp')
    this.log('[9] Gửi mã xác minh')

    if (this.cfg.useOutlook && this.cfg.outlookData) {
      const accounts = parseOutlookLines(this.cfg.outlookData)
      const acc = accounts.find((a) => a.email === this.email)
      if (acc) {
        try {
          this.outlookMailCount = await getInboxCount(acc)
          this.log(`Số email trước khi gửi: ${this.outlookMailCount}`)
        } catch (err) {
          this.log(`Lấy số lượng email thất bại: ${err}, dùng giá trị mặc định 0`)
        }
      }
    }

    const ref = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`
    const timeOnPage = 5000 + Math.floor(Math.random() * 3001)
    const fp = this.genFPWithTime('profile', 'PageSubmit', timeOnPage, this.email.length, this.email)
    const tsp = String(timeOnPage)

    const payload = {
      workflowState: this.workflowState,
      email: this.email,
      browserData: {
        attributes: {
          fingerprint: fp,
          eventTimestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
          timeSpentOnPage: tsp, pageName: 'EMAIL_COLLECTION',
          eventType: 'PageSubmit', ubid: this.ubid, visitorId: this.vid
        },
        cookies: {}
      }
    }

    const resp = await this.doPost(this.cfg.profileBase + '/api/send-otp', payload, this.buildProfileHeaders(ref))
    if (resp.status !== 200) throw new Error(`Gửi mã xác minh thất bại (${resp.status}), body: ${resp.body.substring(0, 300)}`)
    this.log('Đã gửi mã xác minh')
  }

  private async step10GetOTP(): Promise<string> {
    if (this.cfg.manualMode) throw new Error('Chế độ thủ công yêu cầu cung cấp mã xác minh từ bên ngoài')

    this.emitStep('waiting-otp')
    this.log('[10] Chờ mã xác minh')
    const signal = this.abortController.signal
    if (this.cfg.useOutlook && this.cfg.outlookData) {
      const accounts = parseOutlookLines(this.cfg.outlookData)
      const acc = accounts.find((a) => a.email === this.email)
      if (!acc) throw new Error('Không tìm thấy tài khoản Outlook tương ứng')
      return await waitForOTP(acc, this.outlookMailCount, 120, 5, signal)
    }
    if (!this.emailSvc) throw new Error('Dịch vụ email chưa được khởi tạo')
    return await this.emailSvc.waitForCode(120, 3, signal)
  }

  private async step11CreateIdentity(otp: string): Promise<void> {
    this.emitStep('otp-received')
    this.emitStep('create-identity')
    this.log('[11] Tạo danh tính')
    const ref = `${this.cfg.profileBase}/?workflowID=${this.workflowId}`
    const fp = this.genFP('profile', 'EmailVerification', 0, '')

    const resp = await this.doPost(this.cfg.profileBase + '/api/create-identity', {
      workflowState: this.workflowState,
      userData: { email: this.email, fullName: this.cfg.fullName },
      otpCode: otp,
      browserData: {
        attributes: {
          fingerprint: fp,
          eventTimestamp: new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z'),
          timeSpentOnPage: '45000', pageName: 'EMAIL_VERIFICATION',
          eventType: 'EmailVerification', ubid: this.ubid, visitorId: this.vid
        },
        cookies: {}
      }
    }, this.buildProfileHeaders(ref))
    const data = this.parseBody(resp.body)
    this.regCode = (data.registrationCode as string) || ''
    this.signState = (data.signInState as string) || ''
    if (!this.regCode) throw new Error(`create-identity không trả về registrationCode: ${resp.body.slice(0, 200)}`)
  }

  private async step12SetPassword(): Promise<void> {
    this.emitStep('set-password')
    this.log('[12] Đặt mật khẩu')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/signup?registrationCode=${this.regCode}&state=${this.signState}`
    let fp = this.genFP('signup', 'PageSubmit', 0, '')

    // 12a: 获取加密公钥
    let rid = newUUID()
    let h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    let resp = await this.doPost(api, {
      stepId: '', state: this.signState,
      inputs: [
        { input_type: 'UserRegistrationRequestInput', registrationCode: this.regCode, state: this.signState },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    let data = this.parseBody(resp.body)
    this.workflowHandle = (data.workflowStateHandle as string) || ''

    const encCtx = getNestedMap(data as Record<string, unknown>, 'workflowResponseData', 'encryptionContextResponse')
    const pubKeyMap = encCtx ? getNestedStringMap(encCtx, 'publicKey') : null
    if (!pubKeyMap?.n) throw new Error(`Không lấy được khóa công khai mã hóa: ${this.formatErrorBody(resp.body, resp.status)}`)

    const issuer = (encCtx?.issuer as string) || 'signin'
    const audience = (encCtx?.audience as string) || 'AWSPasswordService'
    const region = (encCtx?.region as string) || 'us-east-1'

    const encrypted = encryptPassword(this.cfg.password, pubKeyMap, issuer, audience, region)

    // 12b: 提交密码
    fp = this.genFP('signup', 'PageSubmit', 0, '')
    rid = newUUID()
    h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    resp = await this.doPost(api, {
      stepId: 'get-new-password-for-password-creation',
      workflowStateHandle: this.workflowHandle, actionId: 'SUBMIT',
      inputs: [
        { input_type: 'PasswordRequestInput', password: encrypted, successfullyEncrypted: 'SUCCESSFUL' },
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    data = this.parseBody(resp.body)

    const redir = data.redirect as Record<string, unknown> | undefined
    const rurl = redir?.url as string
    if (!rurl) throw new Error(`Bước đặt mật khẩu không trả về redirect: ${resp.body.slice(0, 200)}`)

    const wh = extractParam(rurl, 'workflowStateHandle')
    const st = extractParam(rurl, 'state')
    const rh = extractParam(rurl, 'workflowResultHandle')
    await this.completeSignup(wh, st, rh)
  }

  private async completeSignup(wh: string, state: string, rh: string): Promise<void> {
    this.log('[12.5] Hoàn tất quy trình đăng ký')
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${wh}&state=${state}&workflowResultHandle=${rh}`
    const fp = this.genFP('signin', 'PageLoad', 0, '')
    const rid = newUUID()
    const h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    const resp = await this.doPost(api, {
      stepId: '', workflowStateHandle: wh,
      workflowResultHandle: rh, state,
      inputs: [
        { input_type: 'UserRequestInput', username: this.email },
        { input_type: 'FingerPrintRequestInput', fingerPrint: fp }
      ],
      visitorId: this.vid, requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    if (data.stepId !== 'end-of-workflow-success') throw new Error(`Hoàn tất quy trình thất bại: ${data.stepId || 'undefined'} ${this.formatErrorBody(resp.body, resp.status)}`)

    const redir = data.redirect as Record<string, unknown> | undefined
    const rurl = redir?.url as string
    if (rurl) {
      this.authCode = extractParam(rurl, 'workflowResultHandle')
      this.ssoState = extractParam(rurl, 'state')
      this.wdcCSRFToken = extractParam(rurl, 'wdc_csrf_token')
    }
  }

  // ============ SSO 授权 (Step12.8-13) ============

  private async step12_8SSOWorkflow(): Promise<void> {
    this.emitStep('sso-workflow')
    this.log('[12.8] Quy trình SSO')
    const redirectURL = encodeURIComponent(this.cfg.viewBase + '/start/#/')
    const loginURL = `${this.cfg.portalBase}/login?directory_id=view&redirect_url=${redirectURL}`

    const h: Record<string, string> = {
      'Accept': '*/*', 'User-Agent': this.identity.ua,
      'Origin': this.cfg.viewBase, 'Referer': this.cfg.viewBase + '/',
      'sec-ch-ua': this.secUA, 'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site', 'priority': 'u=1, i'
    }
    if (this.cookies.has('awsccc')) h['Cookie'] = 'awsccc=' + this.cookies.get('awsccc')

    const resp = await this.doGet(loginURL, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    const data = this.parseBody(resp.body)
    if (data.csrfToken) this.cookies.set('loginCsrfToken', data.csrfToken as string)

    const rurl = (data.redirectUrl as string) || ''
    let wh = ''
    if (rurl.includes('workflowStateHandle=')) {
      wh = splitAfter(rurl, 'workflowStateHandle=')
    }
    if (!wh) throw new Error('SSO không lấy được workflowStateHandle')

    await this.completeSSOWorkflow(wh)
  }

  private async completeSSOWorkflow(wh: string): Promise<void> {
    const api = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/api/execute`
    const ref = `${this.cfg.signinBase}/platform/${this.cfg.directoryId}/login?workflowStateHandle=${wh}`
    let fp = this.genFP('signin', 'PageLoad', 0, '')
    let rid = newUUID()
    let h = this.buildHeaders(ref, this.cfg.signinBase)
    h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

    let resp = await this.doPost(api, {
      stepId: '', workflowStateHandle: wh,
      inputs: [{ input_type: 'FingerPrintRequestInput', fingerPrint: fp }],
      requestId: rid
    }, h)
    saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
    let data = this.parseBody(resp.body)
    let newWH = (data.workflowStateHandle as string) || wh

    if (data.stepId === 'start') {
      fp = this.genFP('signin', 'PageLoad', 0, '')
      rid = newUUID()
      h = this.buildHeaders(ref, this.cfg.signinBase)
      h['x-amzn-requestid'] = rid; h['x-amz-date'] = gmtDate(); h['priority'] = 'u=1, i'

      resp = await this.doPost(api, {
        stepId: 'start', workflowStateHandle: newWH,
        inputs: [{ input_type: 'FingerPrintRequestInput', fingerPrint: fp }],
        requestId: rid
      }, h)
      saveCookies(this.cookies, resp.headers as Record<string, string | string[] | undefined>)
      data = this.parseBody(resp.body)
    }

    if (data.stepId === 'end-of-workflow-success') {
      const redir = data.redirect as Record<string, unknown> | undefined
      const rurl = redir?.url as string
      if (rurl) {
        this.authCode = extractParam(rurl, 'workflowResultHandle')
        this.ssoState = extractParam(rurl, 'state')
        this.wdcCSRFToken = extractParam(rurl, 'wdc_csrf_token')
      }
    }

    // 访问 start 页面
    const params = new URLSearchParams()
    if (this.ssoState) params.set('state', this.ssoState)
    params.set('workflowResultHandle', this.authCode)
    if (this.wdcCSRFToken) params.set('wdc_csrf_token', this.wdcCSRFToken)
    const startURL = this.cfg.viewBase + '/start/?' + params.toString()

    const cookieParts: string[] = []
    if (this.cookies.has('loginCsrfToken')) cookieParts.push('loginCsrfToken=' + this.cookies.get('loginCsrfToken'))
    if (this.cookies.has('awsccc')) cookieParts.push('awsccc=' + this.cookies.get('awsccc'))

    await this.doGet(startURL, {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': this.identity.ua,
      'Referer': this.cfg.signinBase + '/',
      'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate',
      ...(cookieParts.length ? { Cookie: cookieParts.join('; ') } : {})
    })
  }

  private async step13SSOToken(): Promise<Record<string, unknown>> {
    this.emitStep('sso-token')
    this.log('[13] Lấy SSO Token')
    const csrf = this.cookies.get('loginCsrfToken')
    if (!csrf) throw new Error('Thiếu loginCsrfToken')

    const h: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': this.identity.ua, 'Origin': this.cfg.viewBase,
      'Referer': this.cfg.viewBase + '/',
      'x-amz-sso-csrf-token': csrf,
      'sec-ch-ua': this.secUA, 'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"', 'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors', 'sec-fetch-site': 'cross-site', 'priority': 'u=1, i'
    }
    const formData = `authCode=${encodeURIComponent(this.authCode)}&state=${encodeURIComponent(this.ssoState)}&orgId=view`

    // 使用新客户端轮询 SSO Token
    const ssoSession = new SessionClient(this.moduleClient!, this.sessionOpts)

    try {
      for (let retry = 0; retry < 5; retry++) {
        const resp = await ssoSession.post(this.cfg.portalBase + '/auth/sso-token', formData, { headers: h })
        const data = JSON.parse(resp.body || '{}')

        if (data.token) {
          this.ssoToken = data.token
          break
        }
        const errMsg = (data.errorMessage || '') as string
        if (errMsg.toLowerCase().includes('not authorized')) {
          await this.abortableSleep(3000)
          continue
        }
        throw new Error(`Lấy SSO Token thất bại: ${resp.body?.slice(0, 200)}`)
      }
    } finally {
      try { await ssoSession.destroySession() } catch { /* ignore */ }
    }

    if (!this.ssoToken) throw new Error('Lấy SSO Token vẫn thất bại sau 5 lần thử')

    // Accept device + Associate token
    let resp = await this.doPost(this.cfg.oidcBase + '/device_authorization/accept_user_code', {
      userCode: this.userCode, userSessionId: this.ssoToken
    }, { 'Content-Type': 'application/json' })
    const dcData = this.parseBody(resp.body)
    const dc = dcData.deviceContext

    await this.doPost(this.cfg.oidcBase + '/device_authorization/associate_token', {
      deviceContext: dc, userSessionId: this.ssoToken
    }, { 'Content-Type': 'application/json' })

    // 轮询 token
    for (let i = 0; i < 30; i++) {
      resp = await this.doPost(this.cfg.oidcBase + '/token', {
        clientId: this.clientId, clientSecret: this.clientSecret,
        deviceCode: this.deviceCode,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code'
      }, { 'Content-Type': 'application/json' })

      if (resp.status === 200) return this.parseBody(resp.body)
      await this.abortableSleep(2000)
    }
    throw new Error('Hết thời gian chờ lấy Token')
  }

  // ============ 验活 ============

  private async verifyAlive(awsToken: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.log('[Kiểm tra] Làm mới Token và đọc hạn mức')
    const refreshToken = (awsToken.refreshToken as string) || ''

    const resp = await this.doPost('https://oidc.us-east-1.amazonaws.com/token', {
      clientId: this.clientId, clientSecret: this.clientSecret,
      refreshToken, grantType: 'refresh_token'
    }, { 'Content-Type': 'application/json' })

    if (resp.status !== 200) {
      this.log(`Làm mới Token thất bại: ${resp.status}`)
      return { alive: false, error: `refresh failed: ${resp.status}` }
    }

    const tok = this.parseBody(resp.body)
    const access = (tok.accessToken as string) || ''
    if (access) {
      awsToken.accessToken = access
    }

    const usageUA = 'aws-sdk-js/1.0.18 ua/2.1 os/windows lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.18 m/E KiroIDE-0.6.18'
    const usageErrors: string[] = []

    for (const baseURL of ['https://q.us-east-1.amazonaws.com/getUsageLimits', 'https://q.eu-central-1.amazonaws.com/getUsageLimits']) {
      const usageURL = baseURL + '?origin=AI_EDITOR&resourceType=AGENTIC_REQUEST&isEmailRequired=true'
      const usageResp = await this.doGet(usageURL, {
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + access,
        'User-Agent': usageUA
      })

      if (usageResp.status === 403 && usageResp.body.toLowerCase().includes('suspended')) {
        return { alive: false, suspended: true, error: 'suspended' }
      }
      if (usageResp.status === 200) {
        return this.parseUsage(usageResp.body)
      }
      if (usageResp.status === 401 || usageResp.status === 403) {
        const err = `${baseURL} -> ${usageResp.status}: ${usageResp.body.slice(0, 200)}`
        usageErrors.push(err)
        this.log(`[Kiểm tra] ${err}`)
      } else {
        usageErrors.push(`${baseURL} -> ${usageResp.status}`)
      }
    }
    return { alive: false, error: `usage query failed${usageErrors.length ? ` (${usageErrors.join(' | ')})` : ''}` }
  }

  private parseUsage(body: string): Record<string, unknown> {
    const usage = this.parseBody(body)
    const userInfo = (usage.userInfo as Record<string, unknown>) || {}
    const emailAddr = (userInfo.email as string) || ''
    const subInfo = (usage.subscriptionInfo as Record<string, unknown>) || {}
    let sub = (subInfo.subscriptionTitle as string) || 'Free'

    let totalLimit = 0, totalUsed = 0
    const breakdown = usage.usageBreakdownList as Array<Record<string, unknown>> | undefined
    if (breakdown) {
      for (const item of breakdown) {
        const rt = item.resourceType as string
        const dn = item.displayName as string
        if (rt === 'CREDIT' || dn === 'Credits') {
          totalLimit = (item.usageLimitWithPrecision as number) || (item.usageLimit as number) || 0
          totalUsed = (item.currentUsageWithPrecision as number) || (item.currentUsage as number) || 0

          const ft = item.freeTrialInfo as Record<string, unknown> | undefined
          if (ft?.freeTrialStatus === 'ACTIVE') {
            totalLimit += (ft.usageLimitWithPrecision as number) || 0
            totalUsed += (ft.currentUsageWithPrecision as number) || 0
          }
          break
        }
      }
    }

    this.log(`Kiểm tra thành công! Email=${emailAddr} Gói=${sub} Credit=${totalUsed}/${totalLimit}`)
    return { alive: true, email: emailAddr, subscription: sub, credit_used: totalUsed, credit_limit: totalLimit }
  }

  // ============ 主流程 ============

  /** 执行完整注册流程（自动模式） */
  async run(): Promise<RegistrationResult> {
    this.emitStep('init')
    try {
      await this.setupProxyChain()
      if (this.chainRelay) this.emitStep('proxy-chain-ready')
      await this.initTlsClient()
      this.emitStep('tls-ready')
      await this.detectExitIP()
      await refreshAppJSConfig((url, init) => this.fetchAppJS(url, init))
      await this.rebuildTlsClient()

      // 幂等只读步骤：retry 次数 + 整体超时看门狗 + session refresh。
      // OIDC 为首步（失败即废号）保留自带 3 次重试不快速超时；Email 创建有副作用不重试。
      const initSteps: Array<{ name: string; fn: StepFn; retry?: number; timeoutMs?: number; refreshSession?: boolean }> = [
        { name: 'OIDC', fn: () => this.step1OIDC() },
        { name: 'Device', fn: () => this.step2Device(), retry: 2, timeoutMs: 30000, refreshSession: true },
        { name: 'Email', fn: () => this.step3Email() },
        { name: 'Portal', fn: () => this.step4Portal(), retry: 3, timeoutMs: 35000, refreshSession: true },
        { name: 'WorkflowInit', fn: () => this.step5WorkflowInit(), retry: 2, timeoutMs: 35000, refreshSession: true }
      ]
      for (const s of initSteps) {
        this.checkAborted()
        try {
          if (s.retry) await this.retryStep(s.name, s.fn, s.retry, { timeoutMs: s.timeoutMs, refreshSession: s.refreshSession })
          else await s.fn()
        } catch (err) {
          return { status: 'failed', email: this.email, error: `[${s.name}] ${(err as Error).message}` }
        }
        await this.humanDelay()
      }

      this.checkAborted()
      // 非幂等步骤统一加整体超时看门狗（默认 55s）：卡住时快速失败释放并发槽，不死等 3×25s
      const STEP_TIMEOUT = 55000
      const emailStatus = await this.withTimeout(this.step6SubmitEmail(), STEP_TIMEOUT, 'SubmitEmail')

      if (emailStatus === 'signup') {
        const signupSteps: Array<{ name: string; fn: StepFn }> = [
          { name: 'Signup', fn: () => this.step7Signup() },
          { name: 'SignupInit', fn: () => this.step7_5SignupInit() },
          { name: 'ProfileInit', fn: () => this.step7_8ProfileInit() },
          { name: 'ProfileStart', fn: () => this.step8ProfileStart() },
          { name: 'SendOTP', fn: () => this.step9SendOTP() }
        ]
        for (const s of signupSteps) {
          this.checkAborted()
          try { await this.withTimeout(s.fn(), STEP_TIMEOUT, s.name) } catch (err) {
            return { status: 'failed', email: this.email, error: `[${s.name}] ${(err as Error).message}` }
          }
          await this.humanDelay()
        }

        this.checkAborted()
        let otp: string
        try { otp = await this.step10GetOTP() } catch (err) {
          return { status: 'failed', email: this.email, error: `[GetOTP] ${(err as Error).message}` }
        }

        for (const s of [
          { name: 'CreateIdentity', fn: () => this.step11CreateIdentity(otp) },
          { name: 'SetPassword', fn: () => this.step12SetPassword() }
        ] as Array<{ name: string; fn: StepFn }>) {
          this.checkAborted()
          try { await this.withTimeout(s.fn(), STEP_TIMEOUT, s.name) } catch (err) {
            return { status: 'failed', email: this.email, error: `[${s.name}] ${(err as Error).message}` }
          }
          await this.humanDelay()
        }
      } else {
        return { status: 'failed', email: this.email, error: 'Email này đã được đăng ký' }
      }

      // ====== 后期步骤（SSO + Token）======
      // 到这里账号已创建（Step 11-12 成功），后续只是获取登录凭证。
      // 如果因网络波动失败，在同一个 Registrar 内重试（复用已有注册状态），
      // 避免让外层从头开始白白浪费已完成的注册流程。
      this.checkAborted()
      let awsToken: Record<string, unknown> | null = null
      const SSO_MAX_RETRIES = 2
      for (let ssoAttempt = 0; ssoAttempt <= SSO_MAX_RETRIES; ssoAttempt++) {
        try {
          // SSO 含 token 轮询，单次尝试加整体超时（卡死时切断进入下一次重试）
          await this.withTimeout(this.step12_8SSOWorkflow(), 60000, 'SSOWorkflow')
          await this.abortableSleep(2000)
          this.checkAborted()
          awsToken = await this.withTimeout(this.step13SSOToken(), 90000, 'SSOToken')
          break // SSO 成功
        } catch (err) {
          const errMsg = (err as Error).message
          if (ssoAttempt < SSO_MAX_RETRIES) {
            this.log(`[SSO] Bước cuối thất bại, thử lại nội bộ (${ssoAttempt + 1}/${SSO_MAX_RETRIES}): ${errMsg}`)
            await this.abortableSleep(3000 + Math.floor(Math.random() * 2000))
          } else {
            // 最终失败：账号已创建但拿不到 Token
            return { status: 'failed', email: this.email, error: `[SSOToken] ${errMsg} (tài khoản đã được tạo, có thể nhập thủ công để làm mới)` }
          }
        }
      }

      const token = awsToken!
      this.emitStep('verify-alive')
      const verify = await this.withTimeout(this.verifyAlive(token), 60000, 'VerifyAlive')
      if (verify.suspended) {
        return { status: 'failed', email: this.email, error: 'suspended' }
      }

      this.emitStep('done')
      return {
        status: 'success',
        email: this.email,
        password: this.cfg.password,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: (token.refreshToken as string) || '',
        accessToken: (token.accessToken as string) || '',
        region: 'us-east-1',
        provider: 'BuilderId',
        verify,
        fingerprint: this.fingerprintSnapshot()
      }
    } finally {
      await this.cleanup()
    }
  }

  /**
   * 返回本次注册实际生效的代理 URL（按 sessionOpts 同样的优先级解析），
   * 用于在指纹摘要里准确显示是直连还是走代理。
   */
  private resolvedProxyUrl(): string | undefined {
    // 代理链启用时 cfg.proxy 是本地中继地址，审计应显示真正的目标代理
    return (this.chainTargetProxy && this.chainTargetProxy.trim())
      || (this.cfg.proxy && this.cfg.proxy.trim())
      || process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy
      || getSystemProxy() || undefined
  }

  /** 输出本次注册使用的指纹摘要（用于审计与后续复用） */
  private fingerprintSnapshot(): FingerprintSnapshot {
    const resolved = this.resolvedProxyUrl()
    return {
      chromeVer: this.identity.chromeVer,
      ua: this.identity.ua,
      gpuVendor: this.identity.gpuVendor,
      gpuModel: this.identity.gpuModel,
      canvasHash: this.identity.canvasHash,
      screen: { width: this.identity.screen.width, height: this.identity.screen.height },
      // 脱敏后保存（隐藏密码部分），同时确保系统/环境变量代理也被捕获
      proxyUrl: resolved ? resolved.replace(/:([^:@/]+)@/, ':***@') : undefined,
      exitIP: this.exitIP || undefined
    }
  }

  /** 手动模式注册 - Step1-2 自动，Step3 等待外部设置邮箱，Step4-9 自动，Step10 等待外部 OTP */
  async runManualPhase1(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.setupProxyChain()
      await this.initTlsClient()
      await this.detectExitIP()
      await refreshAppJSConfig((url, init) => this.fetchAppJS(url, init))
      await this.rebuildTlsClient()

      await this.step1OIDC()
      await this.withTimeout(this.step2Device(), 30000, 'Device')
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /** 手动模式 - 设置邮箱后继续注册流程到发送 OTP */
  async runManualPhase2(email: string, fullName?: string): Promise<{ success: boolean; error?: string }> {
    this.email = email
    if (fullName) this.cfg.fullName = fullName

    try {
      // 幂等只读步骤：retry + 超时看门狗 + session refresh；后续非幂等步骤仅加超时快速失败
      const STEP_TIMEOUT = 55000
      await this.retryStep('Portal', () => this.step4Portal(), 3, { timeoutMs: 35000, refreshSession: true })
      await this.retryStep('WorkflowInit', () => this.step5WorkflowInit(), 2, { timeoutMs: 35000, refreshSession: true })

      const status = await this.withTimeout(this.step6SubmitEmail(), STEP_TIMEOUT, 'SubmitEmail')
      if (status !== 'signup') return { success: false, error: 'Email này đã được đăng ký' }

      await this.withTimeout(this.step7Signup(), STEP_TIMEOUT, 'Signup')
      await this.withTimeout(this.step7_5SignupInit(), STEP_TIMEOUT, 'SignupInit')
      await this.withTimeout(this.step7_8ProfileInit(), STEP_TIMEOUT, 'ProfileInit')
      await this.withTimeout(this.step8ProfileStart(), STEP_TIMEOUT, 'ProfileStart')
      await this.withTimeout(this.step9SendOTP(), STEP_TIMEOUT, 'SendOTP')
      return { success: true }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  }

  /** 手动模式 - 输入 OTP 后完成注册 */
  async runManualPhase3(otp: string): Promise<RegistrationResult> {
    try {
      // 非幂等步骤加整体超时看门狗，卡住时快速失败
      await this.withTimeout(this.step11CreateIdentity(otp), 55000, 'CreateIdentity')
      await this.withTimeout(this.step12SetPassword(), 55000, 'SetPassword')

      // SSO + Token：账号已创建，网络波动时在同一 Registrar 内重试（复用已有注册状态），避免白费已完成的注册
      let awsToken: Record<string, unknown> | null = null
      const SSO_MAX_RETRIES = 2
      for (let ssoAttempt = 0; ssoAttempt <= SSO_MAX_RETRIES; ssoAttempt++) {
        try {
          await this.withTimeout(this.step12_8SSOWorkflow(), 60000, 'SSOWorkflow')
          await this.abortableSleep(2000)
          this.checkAborted()
          awsToken = await this.withTimeout(this.step13SSOToken(), 90000, 'SSOToken')
          break
        } catch (err) {
          const errMsg = (err as Error).message
          if (ssoAttempt < SSO_MAX_RETRIES) {
            this.log(`[SSO] Bước cuối thất bại, thử lại nội bộ (${ssoAttempt + 1}/${SSO_MAX_RETRIES}): ${errMsg}`)
            await this.abortableSleep(3000 + Math.floor(Math.random() * 2000))
          } else {
            return { status: 'failed', email: this.email, error: `[SSOToken] ${errMsg} (tài khoản đã được tạo, có thể nhập thủ công để làm mới)` }
          }
        }
      }

      const token = awsToken!
      const verify = await this.withTimeout(this.verifyAlive(token), 60000, 'VerifyAlive')
      if (verify.suspended) {
        return { status: 'failed', email: this.email, error: 'suspended' }
      }

      return {
        status: 'success',
        email: this.email,
        password: this.cfg.password,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: (token.refreshToken as string) || '',
        accessToken: (token.accessToken as string) || '',
        region: 'us-east-1',
        provider: 'BuilderId',
        verify,
        fingerprint: this.fingerprintSnapshot()
      }
    } catch (err) {
      return { status: 'failed', email: this.email, error: (err as Error).message }
    } finally {
      await this.cleanup()
    }
  }
}
