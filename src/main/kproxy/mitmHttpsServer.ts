import * as https from 'https'
import * as http2 from 'http2'
import * as tls from 'tls'
import * as http from 'http'
import * as net from 'net'
import * as dns from 'dns'
import { promisify } from 'util'
import type { CertManager } from './certManager'
import { modelMapper, type IdeType } from './modelMapper'
import { hostsManager } from './hostsManager'

export interface MitmServerConfig {
  port: number
  host: string
  routerBase: string
}

export interface MitmServerStats {
  running: boolean
  port: number
  listenerReachable: boolean
  routerReachable: boolean
  lastDiagnosticAt: number | null
  lastDiagnosticError: string | null
  connections: number
  interceptedRequests: number
  passthroughRequests: number
  startTime: number | null
  byIdeType: Record<string, number>
  routerSuccesses: number
  routerFailures: number
  lastRequestAt: number | null
  lastInterceptAt: number | null
  lastRouterStatus: number | null
  recentDecisions: MitmDecision[]
}

export type MitmPassthroughReason =
  | 'internal-loop'
  | 'unknown-host'
  | 'non-chat-path'
  | 'no-map-model'
  | 'mapping-missing'
  | 'binary-payload'
  | 'unsupported-handler'

export interface MitmDecision {
  timestamp: number
  hostname: string
  method: string
  path: string
  ideType: string
  action: 'intercept' | 'passthrough' | 'router-success' | 'router-failure'
  reason?: MitmPassthroughReason
  sourceModel?: string
  mappedModel?: string
  status?: number
}

type MitmEventHandler = (info: {
  hostname: string
  method: string
  path: string
  ideType: string
  action: 'intercept' | 'passthrough'
  mappedModel?: string
  reason?: MitmPassthroughReason
}) => void

const DEFAULT_CONFIG: MitmServerConfig = {
  port: 443,
  host: '127.0.0.1',
  routerBase: 'http://127.0.0.1:5580'
}

const URL_PATTERNS: Record<string, string[]> = {
  antigravity: [':generateContent', ':streamGenerateContent'],
  copilot: ['/chat/completions', '/v1/messages', '/responses'],
  kiro: ['/generateAssistantResponse'],
  cursor: ['/BidiAppend', '/RunSSE', '/RunPoll', '/Run']
}

const MODEL_NO_MAP: Record<string, RegExp[]> = {
  antigravity: [/^tab[_-]/i]
}

const HOST_REWRITE: Record<string, string> = {
  'cloudcode-pa.googleapis.com': 'daily-cloudcode-pa.googleapis.com'
}

const INTERNAL_HEADER = 'x-krouter-mitm-source'
const INTERNAL_VALUE = 'local'

/** Trần dung lượng body: quá ngưỡng thì hủy request thay vì để OOM giết tiến trình main. */
const MAX_BODY_BYTES = 32 * 1024 * 1024
/** Không nhận thêm byte nào trong khoảng này thì hủy request (chống slowloris). */
const BODY_IDLE_TIMEOUT_MS = 60_000
/** Thời gian chờ tối đa để stop() giải quyết dù server.close() chưa gọi lại. */
const STOP_SETTLE_TIMEOUT_MS = 3_000

/** Lấy thông điệp lỗi mà không cần ép kiểu `any` cho biến catch. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ===== Hình dạng payload CodeWhisperer (phía vào) =====
// Chỉ khai báo những field bộ chuyển đổi thật sự đọc; toàn bộ đều optional vì đây là JSON
// từ IDE bên ngoài, không có gì bảo đảm.

interface CwToolResultContent {
  text?: string
}

interface CwToolResult {
  toolUseId?: string
  content?: CwToolResultContent[]
}

interface CwToolSpecification {
  name?: string
  description?: string
  inputSchema?: { json?: unknown }
}

interface CwTool {
  toolSpecification?: CwToolSpecification
  name?: string
  description?: string
  inputSchema?: { json?: unknown }
}

interface CwUserInputMessage {
  content?: string
  modelId?: string
  userInputMessageContext?: {
    toolResults?: CwToolResult[]
    tools?: CwTool[]
  }
}

interface CwToolUse {
  toolUseId?: string
  name?: string
  input?: unknown
}

interface CwAssistantResponseMessage {
  content?: string
  toolUses?: CwToolUse[]
}

interface CwHistoryItem {
  userInputMessage?: CwUserInputMessage
  assistantResponseMessage?: CwAssistantResponseMessage
}

interface CwRequestBody {
  conversationState?: {
    history?: CwHistoryItem[]
    currentMessage?: { userInputMessage?: CwUserInputMessage }
  }
}

// ===== Hình dạng payload OpenAI (phía ra) =====

interface OpenAiToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface OpenAiMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: OpenAiToolCall[]
}

interface OpenAiToolDefinition {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

interface OpenAiChatBody {
  model: string
  messages: OpenAiMessage[]
  stream: boolean
  tools?: OpenAiToolDefinition[]
  tool_choice?: 'auto'
}

/** Một chunk SSE của /v1/chat/completions ở chế độ stream. */
interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string
  }>
}

/**
 * Trạng thái tích luỹ khi dịch stream OpenAI -> khung AWS event-stream.
 * `toolCallInit` khoá theo chỉ số tool call, giữ id/name của lần khởi tạo để các chunk
 * arguments phía sau gắn đúng toolUseId.
 */
interface KiroFrameState {
  modelId: string
  toolCallInit: Record<number, { id: string; name: string }>
  hasToolCalls: boolean
  finishSent: boolean
}

/**
 * Từ chối địa chỉ loopback / nội bộ / link-local do DNS ngược dòng trả về.
 * Bản ghi hosts đã trỏ chính các tên miền này về 127.0.0.1, nên nếu phân giải ra một địa chỉ
 * trong các dải đó thì hoặc là hijack đã vòng ngược vào chính nó (vòng lặp vô hạn), hoặc là
 * ai đó đã giả mạo phản hồi DNS để kéo lưu lượng về máy họ.
 */
export function isDisallowedResolvedAddress(ip: string): boolean {
  const parts = (ip || '').split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = parts
  if (a === 0 || a === 127) return true // 0.0.0.0/8, loopback
  if (a === 10) return true // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 169 && b === 254) return true // link-local
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
  if (a >= 224) return true // multicast + reserved
  return false
}

export function getToolForHost(host: string): IdeType | null {
  const h = (host || '').split(':')[0]
  if (h === 'api.individual.githubcopilot.com') return 'copilot'
  if (h === 'daily-cloudcode-pa.googleapis.com' || h === 'cloudcode-pa.googleapis.com')
    return 'antigravity'
  if (
    /^(?:q|codewhisperer)\.[a-z0-9-]+\.amazonaws\.com$/i.test(h) ||
    /^runtime\.[a-z0-9-]+\.kiro\.dev$/i.test(h)
  )
    return 'kiro'
  if (h === 'api2.cursor.sh') return 'cursor'
  return null
}

function isBinaryData(buffer: Buffer): boolean {
  if (!buffer || buffer.length === 0) return false
  const sample = buffer.slice(0, Math.min(100, buffer.length))
  let nonPrintable = 0
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i]
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) nonPrintable++
    if (byte > 0x7e) nonPrintable++
  }
  return nonPrintable / sample.length > 0.3
}

export function extractModel(url: string, body: Buffer): string | null {
  const urlMatch = url.match(/\/models\/([^/:]+)/)
  if (urlMatch) return urlMatch[1]
  if (isBinaryData(body)) return null
  try {
    const parsed = JSON.parse(body.toString())
    if (parsed.conversationState) {
      return parsed.conversationState.currentMessage?.userInputMessage?.modelId || null
    }
    return (
      parsed.model || parsed.modelId || parsed.request?.model || parsed.request?.modelId || null
    )
  } catch {
    return null
  }
}

export function isKiroChatRequest(
  method: string,
  requestPath: string,
  headers: http.IncomingHttpHeaders,
  body: Buffer
): boolean {
  if (method.toUpperCase() !== 'POST') return false
  if (requestPath.toLowerCase().includes('/generateassistantresponse')) return true

  const operationHeaders = [
    headers['x-amz-target'],
    headers['x-amzn-target'],
    headers['x-amzn-operation-name']
  ].flatMap((value) => (Array.isArray(value) ? value : value ? [value] : []))
  if (operationHeaders.some((value) => /generateassistantresponse/i.test(value))) return true

  if (isBinaryData(body)) return false
  try {
    const parsed = JSON.parse(body.toString('utf8'))
    return Boolean(parsed?.conversationState?.currentMessage)
  } catch {
    return false
  }
}

export class MitmHttpsServer {
  private server: https.Server | null = null
  private config: MitmServerConfig
  private certManager: CertManager | null = null
  private stats: MitmServerStats = {
    running: false,
    port: 443,
    listenerReachable: false,
    routerReachable: false,
    lastDiagnosticAt: null,
    lastDiagnosticError: null,
    connections: 0,
    interceptedRequests: 0,
    passthroughRequests: 0,
    startTime: null,
    byIdeType: {},
    routerSuccesses: 0,
    routerFailures: 0,
    lastRequestAt: null,
    lastInterceptAt: null,
    lastRouterStatus: null,
    recentDecisions: []
  }
  private onRequest: MitmEventHandler | null = null
  private ipCache: Map<string, { ip: string; ts: number }> = new Map()
  private alpnCache: Map<string, string> = new Map()
  /** Theo dõi mọi socket đang mở: server.close() chỉ ngừng nhận kết nối MỚI, các kết nối
   *  keep-alive của IDE sẽ giữ callback treo vô hạn nếu không chủ động hủy (giống MitmProxy). */
  private sockets = new Set<net.Socket>()

  constructor(config?: Partial<MitmServerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.stats.port = this.config.port
  }

  setCertManager(cm: CertManager): void {
    this.certManager = cm
  }

  setOnRequest(handler: MitmEventHandler): void {
    this.onRequest = handler
  }

  /**
   * Tiêm địa chỉ router thật (cổng proxy do người dùng cấu hình) trước khi start().
   * Singleton được tạo không kèm config nên mặc định vẫn là http://127.0.0.1:5580; nếu người dùng
   * đổi proxy sang cổng khác mà không gọi hàm này thì chẩn đoán khởi động sẽ báo sai cổng.
   */
  setRouterBase(base: string): void {
    const trimmed = (base || '').trim().replace(/\/+$/, '')
    if (!trimmed) return
    this.config.routerBase = trimmed
  }

  /** Cập nhật một phần cấu hình; port/host chỉ có hiệu lực từ lần start() kế tiếp. */
  setConfig(partial: Partial<MitmServerConfig>): void {
    this.config = { ...this.config, ...partial }
    this.stats.port = this.config.port
  }

  /**
   * Host có được phép sinh chứng chỉ MITM hay không.
   * SNI là dữ liệu do client điều khiển; không lọc thì mỗi giá trị lạ sẽ kích hoạt một lần
   * generateKeyPair(2048) đồng bộ trên main thread của Electron và thêm một mục vào cache.
   */
  private isInterceptableHost(hostname: string): boolean {
    const h = (hostname || '').split(':')[0].trim().toLowerCase()
    if (!h) return false
    // localhost dùng cho probeListener (/_mitm_health)
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true
    if (getToolForHost(h)) return true
    return hostsManager.getDefaultEntries().some((entry) => entry.hostname.toLowerCase() === h)
  }

  async start(): Promise<void> {
    if (this.server) return
    if (!this.certManager) throw new Error('CertManager not set. Call setCertManager() first.')

    const fallbackCert = this.certManager.generateCertForHost('localhost')
    const caPem = this.certManager.getCACertPem() || ''

    this.server = https.createServer(
      {
        cert: fallbackCert.cert,
        key: fallbackCert.key,
        SNICallback: (hostname, cb) => {
          // Chỉ sinh chứng chỉ cho các host thực sự nằm trong danh sách chặn/bắt.
          // Mọi SNI khác dùng context mặc định của server (client sẽ tự từ chối vì tên không khớp),
          // nhờ vậy SNI ngẫu nhiên không thể khóa main thread 100-1000ms mỗi lần.
          if (!this.isInterceptableHost(hostname)) {
            cb(null, undefined)
            return
          }
          try {
            const hostCert = this.certManager!.generateCertForHost(hostname)
            const ctx = tls.createSecureContext({
              cert: hostCert.cert + '\n' + caPem,
              key: hostCert.key
            })
            cb(null, ctx)
          } catch (err) {
            cb(err instanceof Error ? err : new Error(String(err)), undefined)
          }
        }
      },
      (req, res) => {
        // handleRequest là async: nếu bỏ promise trần ở đây thì mọi rejection lọt được ra khỏi
        // try/catch bên trong nó sẽ thành unhandledRejection và không ai đóng response.
        void this.handleRequest(req, res).catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`[MITM] handleRequest rejected: ${message}`)
          try {
            if (!res.headersSent)
              res.writeHead(500, { 'Content-Type': 'application/json', Connection: 'close' })
            if (!res.writableEnded)
              res.end(JSON.stringify({ error: { message, type: 'mitm_error' } }))
          } catch {
            /* response đã hỏng, không còn gì để làm */
          }
        })
      }
    )

    this.server.on('connection', (socket: net.Socket) => {
      this.stats.connections++
      this.sockets.add(socket)
      socket.once('close', () => {
        this.sockets.delete(socket)
      })
    })

    return await new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        this.stats.running = true
        this.stats.startTime = Date.now()
        console.log(`[MITM] Listening on https://${this.config.host}:${this.config.port}`)
        this.runStartupDiagnostics().then(resolve, (error) => {
          // stop() cũng có thể reject; không bắt thì lỗi gốc bị che bởi một
          // unhandledRejection khác và promise start() không bao giờ settle.
          void this.stop()
            .catch((stopError) => {
              console.error('[MITM] Dọn dẹp sau khi chẩn đoán thất bại cũng lỗi:', stopError)
            })
            .finally(() => reject(error))
        })
      })
      this.server!.on('error', (err) => {
        if (!this.stats.running) {
          this.server = null
          reject(err)
        } else {
          console.error('[MITM] Server error:', err.message)
        }
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const srv = this.server

    // Đặt trạng thái ĐỒNG BỘ ngay tại đây: nếu chỉ gán trong callback của close(), một IDE
    // đang giữ kết nối keep-alive sẽ khiến callback không bao giờ chạy → mitm-stop chờ mãi,
    // UI treo, và start() sau đó bị chặn bởi `if (this.server) return` nên MITM không thể bật lại.
    this.server = null
    this.stats.running = false
    this.stats.listenerReachable = false

    // server.close() chỉ ngừng nhận kết nối MỚI → phải chủ động hủy các socket đang mở.
    for (const socket of this.sockets) {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear()
    const closeAll = (srv as unknown as { closeAllConnections?: () => void }).closeAllConnections
    if (typeof closeAll === 'function') {
      try {
        closeAll.call(srv)
      } catch {
        /* ignore */
      }
    }

    return await new Promise((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        console.log('[MITM] Stopped')
        resolve()
      }
      srv.close(() => finish())
      // Chốt chặn: hết thời gian thì vẫn resolve, tuyệt đối không để lời gọi stop() treo vĩnh viễn.
      setTimeout(finish, STOP_SETTLE_TIMEOUT_MS)
    })
  }

  isRunning(): boolean {
    return this.stats.running
  }

  getStats(): MitmServerStats {
    return { ...this.stats }
  }

  resetStats(): void {
    this.stats.interceptedRequests = 0
    this.stats.passthroughRequests = 0
    this.stats.connections = 0
    this.stats.byIdeType = {}
    this.stats.routerSuccesses = 0
    this.stats.routerFailures = 0
    this.stats.lastRequestAt = null
    this.stats.lastInterceptAt = null
    this.stats.lastRouterStatus = null
    this.stats.recentDecisions = []
  }

  private async runStartupDiagnostics(): Promise<void> {
    const failures: string[] = []
    this.stats.listenerReachable = await this.probeListener().catch((error) => {
      failures.push(`TLS listener: ${error instanceof Error ? error.message : String(error)}`)
      return false
    })
    this.stats.routerReachable = await this.probeRouter().catch((error) => {
      failures.push(
        `Krouter ${this.config.routerBase}: ${error instanceof Error ? error.message : String(error)}`
      )
      return false
    })
    this.stats.lastDiagnosticAt = Date.now()
    this.stats.lastDiagnosticError = failures.length ? failures.join('; ') : null
    if (failures.length) {
      throw new Error(`MITM startup check failed. ${failures.join('; ')}`)
    }
  }

  private probeListener(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: this.config.host,
          port: this.config.port,
          servername: 'localhost',
          method: 'GET',
          path: '/_mitm_health',
          rejectUnauthorized: false,
          timeout: 3_000
        },
        (res) => {
          res.resume()
          res.once('end', () => {
            if (res.statusCode === 200) resolve(true)
            else reject(new Error(`health probe returned HTTP ${res.statusCode || 0}`))
          })
        }
      )
      req.once('timeout', () => req.destroy(new Error('health probe timed out')))
      req.once('error', reject)
      req.end()
    })
  }

  private async probeRouter(): Promise<boolean> {
    const response = await fetch(`${this.config.routerBase}/health`, {
      signal: AbortSignal.timeout(3_000)
    })
    if (!response.ok) throw new Error(`health probe returned HTTP ${response.status}`)
    await response.body?.cancel().catch(() => undefined)
    return true
  }

  private recordDecision(decision: Omit<MitmDecision, 'timestamp'>): void {
    const next = { ...decision, timestamp: Date.now() }
    this.stats.lastRequestAt = next.timestamp
    if (next.action === 'intercept') this.stats.lastInterceptAt = next.timestamp
    this.stats.recentDecisions = [next, ...this.stats.recentDecisions].slice(0, 40)
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.url === '/_mitm_health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, pid: process.pid }))
        return
      }

      let bodyBuffer: Buffer
      try {
        bodyBuffer = await this.collectBody(req)
      } catch (bodyError) {
        // 413 khi vượt trần dung lượng, 408 khi client ngừng gửi giữa chừng.
        const code = (bodyError as { code?: string } | null)?.code
        const status = code === 'body-too-large' ? 413 : code === 'body-timeout' ? 408 : 400
        console.error(`[MITM] Body rejected (${status}): ${errorMessage(bodyError)}`)
        const destroyReq = (): void => {
          try {
            req.destroy()
          } catch {
            /* ignore */
          }
        }
        // Connection: close để Node đóng socket sau khi đẩy xong phản hồi — phần body chưa đọc
        // không thể bị hiểu thành request kế tiếp, và client slowloris cũng bị ngắt.
        if (!res.headersSent)
          res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' })
        if (!res.writableEnded) {
          res.end(
            JSON.stringify({
              error: {
                message: errorMessage(bodyError) || 'invalid request body',
                type: 'mitm_error'
              }
            }),
            destroyReq
          )
        } else {
          destroyReq()
        }
        return
      }
      const hostname = (req.headers.host || '').split(':')[0]
      const method = req.method || 'GET'
      const path = req.url || '/'

      // `return await` chứ KHÔNG phải `return` trần: promise trả về trần được adopt sau khi
      // frame try đã pop, nên rejection không bao giờ tới catch bên dưới — chỗ duy nhất ghi
      // 500 và đóng response. Thiếu await thì request treo tới khi client timeout và
      // rejection trôi nổi (main process không có handler unhandledRejection).
      if (req.headers[INTERNAL_HEADER] === INTERNAL_VALUE) {
        return await this.passthrough(req, res, bodyBuffer, 'internal-loop')
      }

      const tool = getToolForHost(req.headers.host || '')
      if (!tool) return await this.passthrough(req, res, bodyBuffer, 'unknown-host')

      const patterns = URL_PATTERNS[tool] || []
      const isChat =
        patterns.some((p) => path.toLowerCase().includes(p.toLowerCase())) ||
        (tool === 'kiro' && isKiroChatRequest(method, path, req.headers, bodyBuffer))
      if (!isChat) return await this.passthrough(req, res, bodyBuffer, 'non-chat-path')

      const model = extractModel(req.url || '', bodyBuffer)

      if (model && (MODEL_NO_MAP[tool] || []).some((re) => re.test(model))) {
        return await this.passthrough(req, res, bodyBuffer, 'no-map-model')
      }

      const mappedModel =
        modelMapper.mapModel(model || '', tool) ||
        (!model && tool === 'kiro' ? modelMapper.getDefaultTarget('kiro') : null)
      if (!mappedModel) {
        return await this.passthrough(req, res, bodyBuffer, 'mapping-missing')
      }

      this.stats.interceptedRequests++
      this.stats.byIdeType[tool] = (this.stats.byIdeType[tool] || 0) + 1
      this.recordDecision({
        hostname,
        method,
        path,
        ideType: tool,
        action: 'intercept',
        sourceModel: model || undefined,
        mappedModel
      })
      this.onRequest?.({
        hostname,
        method,
        path,
        ideType: tool,
        action: 'intercept',
        mappedModel
      })

      await this.interceptRequest(req, res, bodyBuffer, tool, mappedModel)
    } catch (e) {
      const message = errorMessage(e)
      console.error(`[MITM] Unhandled error: ${message}`)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      if (!res.writableEnded)
        res.end(JSON.stringify({ error: { message, type: 'mitm_error' } }))
    }
  }

  private async interceptRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bodyBuffer: Buffer,
    tool: IdeType,
    mappedModel: string
  ): Promise<void> {
    try {
      if (tool === 'kiro') {
        await this.interceptKiro(req, res, bodyBuffer, mappedModel)
      } else if (tool === 'copilot') {
        await this.interceptCopilot(req, res, bodyBuffer, mappedModel)
      } else if (tool === 'antigravity') {
        await this.interceptAntigravity(req, res, bodyBuffer, mappedModel)
      } else {
        // `return await`: nếu trả promise trần thì rejection được adopt sau khi frame try đã
        // pop, nên khối catch bên dưới (chỗ duy nhất ghi lỗi và đóng response) không bao giờ
        // thấy nó — request treo tới khi client timeout.
        return await this.passthrough(req, res, bodyBuffer, 'unsupported-handler')
      }
    } catch (error) {
      const message = errorMessage(error)
      console.error(`[MITM][${tool}] Intercept error: ${message}`)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      if (!res.writableEnded)
        res.end(
          JSON.stringify({ error: { message, type: 'mitm_error', handler: tool } })
        )
    }
  }

  private async interceptCopilot(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bodyBuffer: Buffer,
    mappedModel: string
  ): Promise<void> {
    const body = JSON.parse(bodyBuffer.toString()) as Record<string, unknown>
    body.model = mappedModel

    const routerRes = await this.fetchRouter(body, req.url || '/v1/chat/completions', req.headers)
    await this.pipeResponse(routerRes, res)
  }

  private async interceptAntigravity(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bodyBuffer: Buffer,
    mappedModel: string
  ): Promise<void> {
    const body = JSON.parse(bodyBuffer.toString()) as Record<string, unknown>
    if (body.model) body.model = mappedModel

    const routerRes = await this.fetchRouter(body, '/v1/chat/completions', req.headers)
    await this.pipeResponse(routerRes, res)
  }

  private async interceptKiro(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bodyBuffer: Buffer,
    mappedModel: string
  ): Promise<void> {
    if (isBinaryData(bodyBuffer)) {
      return await this.passthrough(req, res, bodyBuffer, 'binary-payload')
    }

    const body = JSON.parse(bodyBuffer.toString())
    const messages = this.codeWhispererToMessages(body)
    if (messages.length === 0) {
      throw new Error('codeWhispererToMessages produced 0 messages')
    }

    const tools = this.extractKiroTools(body)
    const openaiBody: OpenAiChatBody = {
      model: mappedModel,
      messages,
      stream: true
    }
    if (tools.length > 0) {
      openaiBody.tools = tools
      openaiBody.tool_choice = 'auto'
    }

    const routerRes = await this.fetchRouter(openaiBody, '/v1/chat/completions', req.headers)
    await this.pipeKiroEventStream(routerRes, res, mappedModel)
  }

  private codeWhispererToMessages(body: CwRequestBody): OpenAiMessage[] {
    const cs = body.conversationState || {}
    const history = cs.history || []
    const currentMsg = cs.currentMessage
    const messages: OpenAiMessage[] = []

    for (const item of history) {
      if (item.userInputMessage) {
        messages.push(...this.convertUserInputMessage(item.userInputMessage))
      } else if (item.assistantResponseMessage) {
        messages.push(this.convertAssistantMessage(item.assistantResponseMessage))
      }
    }

    if (currentMsg?.userInputMessage) {
      messages.push(...this.convertUserInputMessage(currentMsg.userInputMessage))
    }

    return messages
  }

  private convertUserInputMessage(uim: CwUserInputMessage): OpenAiMessage[] {
    const out: OpenAiMessage[] = []
    const toolResults = uim.userInputMessageContext?.toolResults || []

    for (const tr of toolResults) {
      const text = (tr.content || []).map((c) => c.text || '').join('\n')
      out.push({ role: 'tool', tool_call_id: tr.toolUseId || '', content: text })
    }

    const text = (uim.content || '').trim()
    if (text || toolResults.length === 0) {
      out.push({ role: 'user', content: text })
    }

    return out
  }

  private convertAssistantMessage(arm: CwAssistantResponseMessage): OpenAiMessage {
    const toolUses = arm.toolUses || []
    if (toolUses.length > 0) {
      return {
        role: 'assistant',
        content: arm.content || null,
        tool_calls: toolUses.map((tu) => ({
          id: tu.toolUseId || `call_${this.stats.interceptedRequests}`,
          type: 'function',
          function: {
            name: tu.name || '',
            arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {})
          }
        }))
      }
    }
    return { role: 'assistant', content: arm.content || '' }
  }

  private extractKiroTools(body: CwRequestBody): OpenAiToolDefinition[] {
    const cs = body.conversationState || {}
    const fromCurrent = cs.currentMessage?.userInputMessage?.userInputMessageContext?.tools || []
    const fromHistory =
      cs.history?.find((h) => h.userInputMessage?.userInputMessageContext?.tools)?.userInputMessage
        ?.userInputMessageContext?.tools || []
    const cwTools = fromCurrent.length > 0 ? fromCurrent : fromHistory
    if (!cwTools.length) return []

    return cwTools.map((item) => {
      const spec: CwToolSpecification = item.toolSpecification || item
      return {
        type: 'function',
        function: {
          name: spec.name || '',
          description: spec.description || `Tool: ${spec.name || 'unknown'}`,
          parameters: spec.inputSchema?.json || { type: 'object', properties: {}, required: [] }
        }
      }
    })
  }

  private async pipeKiroEventStream(
    routerRes: Response,
    res: http.ServerResponse,
    modelId: string
  ): Promise<void> {
    res.writeHead(200, {
      'Content-Type': 'application/vnd.amazon.eventstream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })

    if (!routerRes.body) {
      res.end()
      return
    }

    const reader = routerRes.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let buffer = ''
    const state: KiroFrameState = { modelId, toolCallInit: {}, hasToolCalls: false, finishSent: false }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (data === '[DONE]') continue

        try {
          const parsed = JSON.parse(data) as OpenAiStreamChunk
          const frames = this.convertOpenAIToKiroFrames(parsed, state)
          if (frames) {
            for (const frame of frames) {
              res.write(frame)
            }
          }
        } catch {
          /* skip unparseable */
        }
      }
    }

    if (!state.finishSent)
      res.write(this.buildEventStreamFrame('metadataEvent', { stopReason: 'END_TURN' }))
    res.end()
  }

  private convertOpenAIToKiroFrames(chunk: OpenAiStreamChunk, state: KiroFrameState): Buffer[] | null {
    const frames: Buffer[] = []
    const choice = chunk.choices?.[0]
    const delta = choice?.delta || {}

    if (delta.tool_calls) {
      state.hasToolCalls = true
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        if (tc.id && tc.function?.name && !state.toolCallInit[idx]) {
          state.toolCallInit[idx] = { id: tc.id, name: tc.function.name }
          frames.push(
            this.buildEventStreamFrame('toolUseEvent', {
              name: tc.function.name,
              toolUseId: tc.id
            })
          )
        }
        if (tc.function?.arguments) {
          const init = state.toolCallInit[idx]
          frames.push(
            this.buildEventStreamFrame('toolUseEvent', {
              input: tc.function.arguments,
              name: init?.name || tc.function?.name || '',
              toolUseId: init?.id || tc.id || ''
            })
          )
        }
      }
    }

    if (delta.content) {
      frames.push(
        this.buildEventStreamFrame('assistantResponseEvent', {
          content: delta.content,
          modelId: state.modelId
        })
      )
    }

    if (choice?.finish_reason) {
      if (state.hasToolCalls) {
        // Sắp xếp theo SỐ: sort() mặc định so sánh chuỗi nên "10" đứng trước "2",
        // từ 11 tool call song song trở lên Kiro sẽ gán tham số nhầm toolUseId.
        // Object.keys luôn trả string nên phải đổi về number trước khi tra Record<number, …>.
        const indices = Object.keys(state.toolCallInit)
          .map(Number)
          .sort((a, b) => a - b)
        for (const idx of indices) {
          const tc = state.toolCallInit[idx]
          frames.push(
            this.buildEventStreamFrame('toolUseEvent', {
              name: tc.name,
              stop: true,
              toolUseId: tc.id
            })
          )
        }
      }
      const stopReason = state.hasToolCalls
        ? 'TOOL_USE'
        : choice.finish_reason === 'length'
          ? 'MAX_TOKENS'
          : 'END_TURN'
      frames.push(this.buildEventStreamFrame('metadataEvent', { stopReason }))
      state.finishSent = true
      state.toolCallInit = {}
    }

    return frames.length > 0 ? frames : null
  }

  private buildEventStreamFrame(eventType: string, payload: Record<string, unknown>): Buffer {
    const payloadBuf = Buffer.from(JSON.stringify(payload), 'utf8')
    const headersBuf = Buffer.concat([
      this.encodeHeader(':message-type', 'event'),
      this.encodeHeader(':event-type', eventType),
      this.encodeHeader(':content-type', 'application/json')
    ])
    const headersLen = headersBuf.length
    const totalLen = 4 + 4 + 4 + headersLen + payloadBuf.length + 4
    const frame = Buffer.alloc(totalLen)

    frame.writeUInt32BE(totalLen, 0)
    frame.writeUInt32BE(headersLen, 4)
    frame.writeUInt32BE(this.crc32(frame.slice(0, 8)), 8)
    headersBuf.copy(frame, 12)
    payloadBuf.copy(frame, 12 + headersLen)
    frame.writeUInt32BE(this.crc32(frame.slice(0, totalLen - 4)), totalLen - 4)

    return frame
  }

  private encodeHeader(name: string, value: string): Buffer {
    const nameBuf = Buffer.from(name, 'utf8')
    const valueBuf = Buffer.from(value, 'utf8')
    const buf = Buffer.alloc(1 + nameBuf.length + 1 + 2 + valueBuf.length)
    let o = 0
    buf[o++] = nameBuf.length
    nameBuf.copy(buf, o)
    o += nameBuf.length
    buf[o++] = 7
    buf.writeUInt16BE(valueBuf.length, o)
    o += 2
    valueBuf.copy(buf, o)
    return buf
  }

  private crc32Table = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })()

  private crc32(buf: Buffer): number {
    let crc = 0xffffffff
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ this.crc32Table[(crc ^ buf[i]) & 0xff]
    }
    return (crc ^ 0xffffffff) >>> 0
  }

  private routerApiKey: string | null = null

  setRouterApiKey(key: string): void {
    this.routerApiKey = key
  }

  private async fetchRouter(
    // Body chỉ được JSON.stringify rồi gửi đi; riêng `model` được đọc để ghi vào decision log.
    // Dùng union thay vì Record<string, unknown> vì OpenAiChatBody là interface nên không
    // có index signature.
    body: OpenAiChatBody | Record<string, unknown>,
    path: string,
    clientHeaders: http.IncomingHttpHeaders
  ): Promise<Response> {
    const stripHeaders = new Set([
      'host',
      'content-length',
      'connection',
      'transfer-encoding',
      'content-type',
      'authorization'
    ])
    const forwarded: Record<string, string> = {}
    for (const [k, v] of Object.entries(clientHeaders)) {
      if (!stripHeaders.has(k.toLowerCase()) && typeof v === 'string') {
        forwarded[k] = v
      }
    }

    const url = `${this.config.routerBase}${path}`
    const ideType = getToolForHost(clientHeaders.host || '') || 'unknown'
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          ...forwarded,
          'Content-Type': 'application/json',
          [INTERNAL_HEADER]: INTERNAL_VALUE,
          ...(this.routerApiKey && { Authorization: `Bearer ${this.routerApiKey}` })
        },
        body: JSON.stringify(body)
      })
      this.stats.routerReachable = true
      this.stats.lastRouterStatus = response.status
      if (response.ok) this.stats.routerSuccesses++
      else this.stats.routerFailures++
      this.recordDecision({
        hostname: new URL(this.config.routerBase).hostname,
        method: 'POST',
        path,
        ideType,
        action: response.ok ? 'router-success' : 'router-failure',
        mappedModel: typeof body?.model === 'string' ? body.model : undefined,
        status: response.status
      })
      return response
    } catch (error) {
      this.stats.routerReachable = false
      this.stats.routerFailures++
      this.stats.lastRouterStatus = 0
      this.stats.lastDiagnosticAt = Date.now()
      this.stats.lastDiagnosticError = error instanceof Error ? error.message : String(error)
      this.recordDecision({
        hostname: new URL(this.config.routerBase).hostname,
        method: 'POST',
        path,
        ideType,
        action: 'router-failure',
        mappedModel: typeof body?.model === 'string' ? body.model : undefined,
        status: 0
      })
      throw error
    }
  }

  private async pipeResponse(routerRes: Response, res: http.ServerResponse): Promise<void> {
    const ct = routerRes.headers.get('content-type') || 'application/json'
    const status = routerRes.status || 200
    const resHeaders: Record<string, string> = {
      'Content-Type': ct,
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    }
    if (ct.includes('text/event-stream')) resHeaders['X-Accel-Buffering'] = 'no'
    res.writeHead(status, resHeaders)

    if (!routerRes.body) {
      const text = await routerRes.text().catch(() => '')
      res.end(text)
      return
    }

    const reader = routerRes.body.getReader()
    const decoder = new TextDecoder()
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        res.end()
        break
      }
      res.write(decoder.decode(value, { stream: true }))
    }
  }

  private async passthrough(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bodyBuffer: Buffer,
    reason: MitmPassthroughReason
  ): Promise<void> {
    this.stats.passthroughRequests++
    const originalHost = (req.headers.host || '').split(':')[0]
    const isChatEndpoint =
      (req.url || '').includes(':generateContent') ||
      (req.url || '').includes(':streamGenerateContent')
    const targetHost = isChatEndpoint ? HOST_REWRITE[originalHost] || originalHost : originalHost
    const ideType = getToolForHost(req.headers.host || '') || 'unknown'

    this.recordDecision({
      hostname: originalHost,
      method: req.method || 'GET',
      path: req.url || '/',
      ideType,
      action: 'passthrough',
      reason
    })

    this.onRequest?.({
      hostname: originalHost,
      method: req.method || 'GET',
      path: req.url || '/',
      ideType,
      action: 'passthrough',
      reason
    })

    try {
      const proto = await this.negotiateAlpn(targetHost)
      if (proto === 'h2') {
        return await this.passthroughHttp2(req, res, bodyBuffer, targetHost)
      }
    } catch {
      // fallback to HTTP/1.1
    }
    // `return await`: nếu passthroughHttps reject (ví dụ resolveTargetIP không phân giải
    // được host) thì rejection phải nổi lên caller đang có try/catch, chứ không được thoát ra
    // ngoài dưới dạng promise trần.
    return await this.passthroughHttps(req, res, bodyBuffer, targetHost)
  }

  private async negotiateAlpn(host: string): Promise<string> {
    if (this.alpnCache.has(host)) return this.alpnCache.get(host)!
    const ip = await this.resolveTargetIP(host)
    return await new Promise((resolve, reject) => {
      const socket = tls.connect(
        {
          // Xác thực chứng chỉ theo servername (tên miền thật), không theo IP đã phân giải.
          host: ip,
          port: 443,
          servername: host,
          ALPNProtocols: ['h2', 'http/1.1'],
          rejectUnauthorized: true
        },
        () => {
          const proto = socket.alpnProtocol || 'http/1.1'
          this.alpnCache.set(host, proto)
          socket.end()
          resolve(proto)
        }
      )
      socket.once('error', reject)
      socket.setTimeout(5000, () => {
        socket.destroy(new Error('ALPN timeout'))
      })
    })
  }

  private async passthroughHttp2(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bodyBuffer: Buffer,
    targetHost: string
  ): Promise<void> {
    const targetIP = await this.resolveTargetIP(targetHost)
    const h2Headers: Record<string, string | string[] | undefined> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase()
      if (
        [
          'host',
          'connection',
          'keep-alive',
          'transfer-encoding',
          'upgrade',
          'proxy-connection'
        ].includes(lk)
      )
        continue
      h2Headers[lk] = v
    }
    h2Headers[':method'] = req.method || 'GET'
    h2Headers[':path'] = req.url || '/'
    h2Headers[':scheme'] = 'https'
    h2Headers[':authority'] = targetHost

    return await new Promise((resolve) => {
      const client = http2.connect(`https://${targetHost}`, {
        createConnection: () =>
          tls.connect({
            // Bắt buộc xác thực chứng chỉ: request passthrough mang theo Authorization: Bearer thật
            // của IDE, tắt kiểm tra là trao thẳng token cho bất kỳ ai giả mạo được phản hồi DNS.
            host: targetIP,
            port: 443,
            servername: targetHost,
            ALPNProtocols: ['h2'],
            rejectUnauthorized: true
          })
      })
      client.once('error', (e) => {
        console.error(`[MITM] H2 error: ${e.message}`)
        if (!res.headersSent) res.writeHead(502)
        if (!res.writableEnded) res.end('Bad Gateway')
        try {
          client.close()
        } catch {
          /* client đã đóng hoặc hỏng — không còn gì để dọn */
        }
        resolve()
      })

      const stream = client.request(h2Headers as http2.OutgoingHttpHeaders, { endStream: bodyBuffer.length === 0 })
      if (bodyBuffer.length > 0) stream.end(bodyBuffer)

      stream.once('response', (responseHeaders) => {
        const status = responseHeaders[':status'] as number
        const outHeaders: http.OutgoingHttpHeaders = {}
        for (const [k, v] of Object.entries(responseHeaders)) {
          if (k.startsWith(':') || ['connection', 'keep-alive', 'transfer-encoding'].includes(k))
            continue
          outHeaders[k] = v
        }
        res.writeHead(status, outHeaders)

        stream.on('data', (chunk: Buffer) => {
          res.write(chunk)
        })
        stream.on('end', () => {
          if (!res.writableEnded) res.end()
          try {
            client.close()
          } catch {
            /* client đã đóng hoặc hỏng — không còn gì để dọn */
          }
          resolve()
        })
      })
      stream.once('error', (e) => {
        console.error(`[MITM] H2 stream error: ${e.message}`)
        if (!res.headersSent) res.writeHead(502)
        if (!res.writableEnded) res.end()
        try {
          client.close()
        } catch {
          /* client đã đóng hoặc hỏng — không còn gì để dọn */
        }
        resolve()
      })
    })
  }

  private async passthroughHttps(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bodyBuffer: Buffer,
    targetHost: string
  ): Promise<void> {
    // resolveTargetIP ném khi không phân giải được (DNS chỉ định 8.8.8.8, không có fallback).
    // Không bắt tại đây thì request treo không có status line nào cả.
    let targetIP: string
    try {
      targetIP = await this.resolveTargetIP(targetHost)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[MITM] Không phân giải được ${targetHost}: ${message}`)
      if (!res.headersSent)
        res.writeHead(502, { 'Content-Type': 'application/json', Connection: 'close' })
      if (!res.writableEnded) {
        res.end(
          JSON.stringify({
            error: {
              message: `DNS resolution failed for ${targetHost}: ${message}`,
              type: 'mitm_error'
            }
          })
        )
      }
      return
    }
    const headers = { ...req.headers, host: targetHost }

    return await new Promise((resolve) => {
      const forwardReq = https.request(
        {
          hostname: targetIP,
          port: 443,
          path: req.url,
          method: req.method,
          headers,
          // servername giữ tên miền thật nên chứng chỉ vẫn được kiểm tra đúng dù kết nối theo IP.
          servername: targetHost,
          rejectUnauthorized: true
        },
        (forwardRes) => {
          if (!res.headersSent) res.writeHead(forwardRes.statusCode || 502, forwardRes.headers)
          forwardRes.on('data', (chunk: Buffer) => {
            res.write(chunk)
          })
          forwardRes.on('error', (e) => {
            console.error(`[MITM] Passthrough response error: ${e.message}`)
            if (!res.writableEnded) res.end()
            resolve()
          })
          forwardRes.on('end', () => {
            if (!res.writableEnded) res.end()
            resolve()
          })
        }
      )

      forwardReq.on('error', (e) => {
        console.error(`[MITM] Passthrough error: ${e.message}`)
        if (!res.headersSent) res.writeHead(502)
        if (!res.writableEnded) res.end('Bad Gateway')
        resolve()
      })

      if (bodyBuffer.length > 0) forwardReq.write(bodyBuffer)
      forwardReq.end()
    })
  }

  private async resolveTargetIP(hostname: string): Promise<string> {
    const cached = this.ipCache.get(hostname)
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.ip

    // Không dùng được resolver hệ thống ở đây: chính các tên miền này đã bị file hosts trỏ về
    // 127.0.0.1, hỏi hệ thống sẽ quay ngược vào chính MITM. Phương án lý tưởng là DoH
    // (https://1.1.1.1/dns-query) có xác thực TLS; ở đây giữ truy vấn UDP ngược dòng nhưng
    // (a) loại bỏ mọi địa chỉ loopback/nội bộ do phản hồi UDP có thể bị giả mạo, và
    // (b) mọi kết nối phía trên đều bật rejectUnauthorized — chính việc kiểm tra chứng chỉ mới
    // là thứ thực sự chặn được tấn công giả mạo DNS.
    const resolver = new dns.Resolver()
    resolver.setServers(['8.8.8.8'])
    const resolve4 = promisify(resolver.resolve4.bind(resolver))
    const addresses = (await resolve4(hostname)) as string[]
    const usable = (addresses || []).filter((ip) => !isDisallowedResolvedAddress(ip))
    if (usable.length === 0) {
      throw new Error(
        `Upstream DNS returned no usable address for ${hostname}: ${(addresses || []).join(', ') || '(empty)'}`
      )
    }
    this.ipCache.set(hostname, { ip: usable[0], ts: Date.now() })
    return usable[0]
  }

  /**
   * Đọc toàn bộ body có trần dung lượng và thời gian chờ nhàn rỗi.
   * Không có hai giới hạn này thì một body vài GB sẽ OOM giết tiến trình main, còn một client
   * slowloris giữ request mở vô thời hạn. Lỗi mang `code` để caller trả đúng 413 / 408.
   */
  private collectBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let total = 0
      let settled = false
      let idleTimer: ReturnType<typeof setTimeout> | null = null

      const clearIdle = (): void => {
        if (idleTimer) {
          clearTimeout(idleTimer)
          idleTimer = null
        }
      }
      const fail = (message: string, code: 'body-too-large' | 'body-timeout'): void => {
        if (settled) return
        settled = true
        clearIdle()
        chunks.length = 0
        // pause() thay vì destroy(): ngừng đệm ngay nhưng vẫn còn socket để caller gửi được
        // 413/408 cho client. Caller hủy socket sau khi phản hồi đã đẩy xong.
        try {
          req.pause()
        } catch {
          /* ignore */
        }
        const error = new Error(message) as Error & { code?: string }
        error.code = code
        reject(error)
      }
      const armIdle = (): void => {
        clearIdle()
        idleTimer = setTimeout(
          () => fail(`Request body idle for more than ${BODY_IDLE_TIMEOUT_MS}ms`, 'body-timeout'),
          BODY_IDLE_TIMEOUT_MS
        )
      }

      armIdle()
      req.on('data', (chunk: Buffer) => {
        if (settled) return
        total += chunk.length
        if (total > MAX_BODY_BYTES) {
          fail(`Request body exceeds ${MAX_BODY_BYTES} bytes`, 'body-too-large')
          return
        }
        chunks.push(chunk)
        armIdle()
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        clearIdle()
        resolve(Buffer.concat(chunks))
      })
      req.on('error', (error) => {
        if (settled) return
        settled = true
        clearIdle()
        reject(error)
      })
    })
  }
}

export const mitmHttpsServer = new MitmHttpsServer()
