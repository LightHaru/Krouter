// K-Proxy MITM 代理核心
import * as http from 'http'
import * as net from 'net'
import * as tls from 'tls'
import * as url from 'url'
import type { KProxyConfig, KProxyStats, KProxyEvents, KProxyRequestInfo } from './types'
import { CertManager } from './certManager'

// Machine ID 正则匹配模式（64位十六进制）
const MACHINE_ID_REGEX = /[a-f0-9]{64}/gi
// 支持两种格式：KiroIDE-0.6.18-{machineId} 或 KiroIDE 0.6.18 {machineId}
const KIRO_UA_REGEX = /KiroIDE[-\s][\d.]+[-\s]([a-f0-9]{64})/i
/** Ranh giới header/body của HTTP, so khớp trên byte để không phụ thuộc encoding. */
const HEADER_TERMINATOR = Buffer.from('\r\n\r\n', 'latin1')

/**
 * K-Proxy MITM 代理服务器
 */
export class MitmProxy {
  private server: http.Server | null = null
  /**
   * Chỉ true sau khi listen() gọi callback thành công. Không được suy ra trạng thái chạy
   * từ `server !== null`: một server đã tạo nhưng listen fail (EADDRINUSE) vẫn khác null.
   */
  private listening = false
  private certManager: CertManager
  private config: KProxyConfig
  private stats: KProxyStats
  private events: KProxyEvents
  private tlsServers: Map<string, tls.Server> = new Map()
  /** 跟踪所有 CONNECT 隧道客户端连接，stop() 时强制销毁，避免 server.close() 等 Keep-Alive 超时 */
  private sockets = new Set<net.Socket>()

  constructor(certManager: CertManager, config: KProxyConfig, events: KProxyEvents = {}) {
    this.certManager = certManager
    this.config = config
    this.events = events
    this.stats = {
      totalRequests: 0,
      mitmRequests: 0,
      bypassRequests: 0,
      modifiedRequests: 0,
      startTime: 0,
      lastRequestTime: 0
    }
  }

  /**
   * 启动代理服务器
   */
  async start(): Promise<void> {
    if (this.server) {
      console.log('[MitmProxy] Server already running')
      return
    }

    return await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleHttpRequest(req, res)
      })
      this.server = server

      // 处理 CONNECT 请求（HTTPS 隧道）
      server.on('connect', (req, clientSocket: net.Socket, head) => {
        this.handleConnect(req, clientSocket, head)
      })

      server.on('error', (error: NodeJS.ErrnoException) => {
        // Nếu listen chưa từng thành công thì server này KHÔNG dùng được. Phải trả
        // this.server về null, nếu không isRunning() (chính là `this.server !== null`)
        // sẽ báo "đang chạy" trong khi không có gì listen trên cổng, và guard ở đầu
        // start() sẽ short-circuit mọi lần thử lại bằng success.
        if (!this.listening) {
          this.server = null
          server.removeAllListeners()
          try {
            server.close()
          } catch {
            /* ignore */
          }
        }
        if (error.code === 'EADDRINUSE') {
          console.error(`[MitmProxy] Port ${this.config.port} is already in use`)
          reject(new Error(`Port ${this.config.port} is already in use`))
        } else {
          console.error('[MitmProxy] Server error:', error)
          this.events.onError?.(error)
          reject(error)
        }
      })

      server.listen(this.config.port, this.config.host, () => {
        console.log(`[MitmProxy] Started on ${this.config.host}:${this.config.port}`)
        this.listening = true
        this.stats.startTime = Date.now()
        this.events.onStatusChange?.(true, this.config.port)
        resolve()
      })
    })
  }

  /**
   * 停止代理服务器
   */
  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    // 关闭所有 TLS 服务器
    for (const [_host, tlsServer] of this.tlsServers) {
      try {
        tlsServer.close()
      } catch {
        /* ignore */
      }
    }
    this.tlsServers.clear()

    // 强制销毁所有活跃隧道连接：否则 server.close() 会等 Keep-Alive 连接自然超时（~60s）
    for (const sock of this.sockets) {
      try {
        sock.destroy()
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear()

    const srv = this.server
    this.server = null
    this.listening = false
    return await new Promise((resolve) => {
      // Không có cờ settled thì cả close callback lẫn timeout dự phòng đều chạy finish(),
      // bắn onStatusChange(false) hai lần: nếu người dùng stop rồi start lại trong 1 giây,
      // phát lần hai sẽ lật UI về "đã dừng" trong khi proxy đang phục vụ.
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(fallback)
        console.log('[MitmProxy] Stopped')
        this.events.onStatusChange?.(false, this.config.port)
        resolve()
      }
      // 双保险：1 秒后无论 close 回调是否触发都 resolve
      const fallback = setTimeout(finish, 1000)
      srv.close(finish)
    })
  }

  /**
   * 处理 HTTP 请求
   */
  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    this.stats.totalRequests++
    this.stats.lastRequestTime = Date.now()

    const targetUrl = url.parse(req.url || '')
    const options: http.RequestOptions = {
      hostname: targetUrl.hostname,
      port: targetUrl.port || 80,
      path: targetUrl.path,
      method: req.method,
      headers: req.headers
    }

    const proxyReq = http.request(options, (proxyRes) => {
      if (!res.headersSent) {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers)
      }
      // Upstream reset giữa chừng (rất thường gặp với SSE dài) phải được xử lý tại chỗ,
      // nếu không lỗi sẽ nổ ra ngoài EventEmitter và không ai bắt được.
      proxyRes.on('error', (error) => {
        console.error('[MitmProxy] Upstream response error:', error.message)
        proxyReq.destroy()
        if (!res.writableEnded) res.end()
      })
      proxyRes.pipe(res)
    })

    proxyReq.on('error', (error) => {
      console.error('[MitmProxy] HTTP proxy error:', error)
      // Thiếu guard headersSent thì writeHead ném ERR_HTTP_HEADERS_SENT ngay trong handler của
      // EventEmitter → uncaughtException → chết cả tiến trình main của Electron.
      if (!res.headersSent) res.writeHead(502)
      if (!res.writableEnded) res.end('Bad Gateway')
    })

    req.on('error', (error) => {
      console.error('[MitmProxy] Client request error:', error.message)
      proxyReq.destroy()
      if (!res.writableEnded) res.end()
    })

    res.on('error', (error) => {
      console.error('[MitmProxy] Client response error:', error.message)
      proxyReq.destroy()
    })

    req.pipe(proxyReq)
  }

  /**
   * 处理 CONNECT 请求（HTTPS 隧道）
   */
  private handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    // 跟踪隧道连接，stop() 时强制断开
    this.sockets.add(clientSocket)
    clientSocket.once('close', () => this.sockets.delete(clientSocket))
    this.stats.totalRequests++
    this.stats.lastRequestTime = Date.now()

    const [hostname, portStr] = (req.url || '').split(':')
    const port = parseInt(portStr, 10) || 443

    // 检查是否需要 MITM
    const shouldMitm = this.shouldMitm(hostname)

    if (shouldMitm) {
      this.stats.mitmRequests++
      this.handleMitmConnect(hostname, port, clientSocket, head)
    } else {
      this.stats.bypassRequests++
      this.handleDirectConnect(hostname, port, clientSocket, head)
    }
  }

  /**
   * 检查域名是否需要 MITM
   */
  private shouldMitm(hostname: string): boolean {
    for (const domain of this.config.mitmDomains) {
      // Khớp có neo: `includes` khiến `amazon.com.evil.net` cũng trùng `amazon.com`,
      // Krouter sẽ giả mạo chứng chỉ, giải mã đường hầm và viết lại body của tên miền lạ đó.
      if (hostname === domain || hostname.endsWith('.' + domain)) {
        if (this.config.logRequests) {
          console.log(`[MitmProxy] MITM: ${hostname} matches ${domain}`)
        }
        return true
      }
    }
    if (this.config.logRequests) {
      console.log(`[MitmProxy] Bypass: ${hostname}`)
    }
    return false
  }

  /**
   * 直接转发连接（不解密）
   */
  private handleDirectConnect(
    hostname: string,
    port: number,
    clientSocket: net.Socket,
    head: Buffer
  ): void {
    const serverSocket = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      serverSocket.write(head)
      serverSocket.pipe(clientSocket)
      clientSocket.pipe(serverSocket)
    })

    serverSocket.on('error', (error) => {
      console.error(`[MitmProxy] Direct connect error to ${hostname}:${port}:`, error.message)
      clientSocket.end()
    })

    clientSocket.on('error', (error) => {
      console.error(`[MitmProxy] Client socket error:`, error.message)
      serverSocket.end()
    })
  }

  /**
   * MITM 拦截连接
   */
  private handleMitmConnect(
    hostname: string,
    port: number,
    clientSocket: net.Socket,
    _head: Buffer
  ): void {
    try {
      // 为目标域名生成证书
      const { cert, key } = this.certManager.generateCertForHost(hostname)

      // 创建 TLS 连接选项
      const tlsOptions = {
        key,
        cert
      }

      // 通知客户端连接已建立
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

      // 创建 TLS 连接
      const tlsSocket = new tls.TLSSocket(clientSocket, {
        ...tlsOptions,
        isServer: true
      })

      // 处理 TLS 错误
      tlsSocket.on('error', (error) => {
        console.error(`[MitmProxy] TLS error for ${hostname}:`, error.message)
        clientSocket.end()
      })

      // 处理解密后的请求
      this.handleDecryptedConnection(tlsSocket, hostname, port)
    } catch (error) {
      console.error(`[MitmProxy] MITM setup error for ${hostname}:`, error)
      clientSocket.end()
    }
  }

  /**
   * 处理解密后的 HTTPS 连接
   */
  private handleDecryptedConnection(
    clientSocket: tls.TLSSocket,
    hostname: string,
    port: number
  ): void {
    // Gom bằng Buffer, KHÔNG bằng chuỗi. Trước đây `requestData += chunk.toString()` decode
    // từng chunk rời rạc theo utf8: một ký tự nhiều byte (tiếng Việt có dấu, CJK, emoji) nằm
    // vắt qua ranh giới chunk sẽ biến nửa đầu thành U+FFFD (3 byte) trong khi các byte tiếp
    // theo sang chunk sau vẫn nguyên vẹn — body gửi lên AWS vừa sai nội dung vừa lệch số byte
    // so với Content-Length.
    const headerChunks: Buffer[] = []
    let headersParsed = false
    let contentLength = 0
    let bodyReceived = 0
    let modifiedHeaders: string = ''
    let requestInfo: KProxyRequestInfo | null = null
    // Các mảnh body đến TRONG LÚC bắt tay TLS với upstream (100ms+): trước đây chúng rơi vào
    // handler này mà không có nhánh else nào nên bị vứt bỏ hoàn toàn — request 60KB gửi lên
    // Content-Length: 61440 nhưng chỉ có ~14KB đầu tới nơi, AWS treo chờ số byte không bao giờ đến.
    const pendingBody: Buffer[] = []
    // live = true sau khi forwardRequest đã nối thẳng client → upstream (hết giai đoạn đệm)
    const forwardState = { live: false }

    clientSocket.on('data', (chunk: Buffer) => {
      if (!headersParsed) {
        headerChunks.push(chunk)
        const buffered = headerChunks.length === 1 ? headerChunks[0] : Buffer.concat(headerChunks)
        const headerEnd = buffered.indexOf(HEADER_TERMINATOR)

        if (headerEnd !== -1) {
          headersParsed = true
          headerChunks.length = 0
          // Header HTTP theo spec là ISO-8859-1; latin1 ánh xạ 1 byte <-> 1 ký tự nên
          // decode/encode luôn khứ hồi đúng từng byte.
          const headers = buffered.subarray(0, headerEnd).toString('latin1')
          const body = buffered.subarray(headerEnd + HEADER_TERMINATOR.length)

          // 解析并修改请求头
          const { modified, newHeaders, info } = this.modifyHeaders(headers, hostname)
          modifiedHeaders = newHeaders
          requestInfo = info

          // 记录请求
          if (requestInfo) {
            this.events.onRequest?.(requestInfo)
            this.events.onMitmIntercept?.(hostname, modified)
          }

          // 获取 Content-Length
          const clMatch = headers.match(/content-length:\s*(\d+)/i)
          if (clMatch) {
            contentLength = parseInt(clMatch[1], 10)
          }

          // 替换 body 中的 machineId（thao tác trên byte, không đụng tới encoding)
          const modifiedBody = this.modifyBody(body)
          if (modifiedBody.length !== body.length) {
            // body 长度变了，更新 Content-Length
            const newLength = contentLength - body.length + modifiedBody.length
            modifiedHeaders = modifiedHeaders.replace(
              /content-length:\s*\d+/i,
              `content-length: ${newLength}`
            )
            contentLength = newLength
          }
          bodyReceived = modifiedBody.length

          // 转发请求到目标服务器
          this.forwardRequest(
            modifiedHeaders,
            modifiedBody,
            hostname,
            port,
            clientSocket,
            contentLength,
            bodyReceived,
            pendingBody,
            forwardState
          )
        }
      } else if (!forwardState.live) {
        // Đệm lại cho tới khi đường hầm upstream sẵn sàng; forwardRequest sẽ xả mảng này ra trước
        // khi nối trực tiếp, nên không mảnh nào bị mất và cũng không mảnh nào bị gửi hai lần.
        pendingBody.push(chunk)
      }
      // TODO: Sau khi một response hoàn tất, trạng thái parser (headersParsed / requestData /
      // contentLength / bodyReceived) KHÔNG được reset, nên chỉ request ĐẦU TIÊN trên một kết nối
      // TLS keep-alive được phân tích và viết lại machineId; các request tiếp theo chỉ được chuyển
      // tiếp thô lên upstream. Hiện tại forwardRequest đóng clientSocket ngay khi upstream kết thúc
      // (serverSocket 'end' → clientSocket.end()) nên client không thể dùng lại kết nối, vì vậy
      // chưa gây lỗi thực tế. Nếu sau này giữ kết nối sống thì phải reset trạng thái ở đây.
    })

    clientSocket.on('error', (error) => {
      console.error(`[MitmProxy] Decrypted connection error:`, error.message)
    })
  }

  /**
   * 替换请求体中的 Machine ID
   */
  private modifyBody(body: Buffer): Buffer {
    const targetDeviceId = this.config.deviceId
    if (!targetDeviceId || body.length === 0) return body
    // Device ID là 64 ký tự hex thuần ASCII, nên latin1 (1 byte <-> 1 ký tự) cho phép
    // tìm/thay trên chuỗi mà vẫn khứ hồi đúng từng byte cho phần body nhị phân xung quanh.
    const text = body.toString('latin1')
    // 只在 body 中包含 64 位十六进制时才替换（避免误伤无关内容）
    MACHINE_ID_REGEX.lastIndex = 0
    if (!MACHINE_ID_REGEX.test(text)) {
      MACHINE_ID_REGEX.lastIndex = 0
      return body
    }
    MACHINE_ID_REGEX.lastIndex = 0
    const result = text.replace(MACHINE_ID_REGEX, (match) => {
      // 不替换已经是目标 ID 的
      if (match.toLowerCase() === targetDeviceId.toLowerCase()) return match
      if (this.config.logRequests) {
        console.log(
          `[MitmProxy] Replaced Machine ID in body: ${match.substring(0, 16)}... -> ${targetDeviceId.substring(0, 16)}...`
        )
      }
      return targetDeviceId
    })
    MACHINE_ID_REGEX.lastIndex = 0
    if (result === text) return body
    return Buffer.from(result, 'latin1')
  }

  /**
   * 修改请求头（替换 Machine ID）
   */
  private modifyHeaders(
    headers: string,
    hostname: string
  ): { modified: boolean; newHeaders: string; info: KProxyRequestInfo } {
    const lines = headers.split('\r\n')
    const firstLine = lines[0]
    const [method, path] = firstLine.split(' ')

    let modified = false
    let originalDeviceId: string | undefined
    let newDeviceId: string | undefined
    const targetDeviceId = this.config.deviceId

    const info: KProxyRequestInfo = {
      timestamp: Date.now(),
      method: method || 'UNKNOWN',
      host: hostname,
      path: path || '/',
      isMitm: true,
      deviceIdReplaced: false
    }

    if (!targetDeviceId) {
      return { modified: false, newHeaders: headers, info }
    }

    const modifiedLines = lines.map((line) => {
      const lowerLine = line.toLowerCase()

      // 检查 user-agent 和 x-amz-user-agent
      if (lowerLine.startsWith('user-agent:') || lowerLine.startsWith('x-amz-user-agent:')) {
        const match = line.match(KIRO_UA_REGEX)
        if (match) {
          originalDeviceId = match[1]
          const newLine = line.replace(MACHINE_ID_REGEX, targetDeviceId)
          if (newLine !== line) {
            modified = true
            newDeviceId = targetDeviceId
            if (this.config.logRequests) {
              console.log(`[MitmProxy] Replaced Machine ID in ${line.split(':')[0]}`)
              console.log(`  Original: ${originalDeviceId?.substring(0, 16)}...`)
              console.log(`  New: ${targetDeviceId.substring(0, 16)}...`)
            }
            return newLine
          }
        }
      }
      return line
    })

    if (modified) {
      this.stats.modifiedRequests++
      info.deviceIdReplaced = true
      info.originalDeviceId = originalDeviceId
      info.newDeviceId = newDeviceId
    }

    return {
      modified,
      newHeaders: modifiedLines.join('\r\n'),
      info
    }
  }

  /**
   * 转发请求到目标服务器
   */
  private forwardRequest(
    headers: string,
    initialBody: Buffer,
    hostname: string,
    port: number,
    clientSocket: tls.TLSSocket,
    contentLength: number,
    bodyReceived: number,
    pendingBody: Buffer[],
    forwardState: { live: boolean }
  ): void {
    const startTime = Date.now()

    // 连接到目标服务器
    const serverSocket = tls.connect(
      {
        host: hostname,
        port,
        servername: hostname,
        rejectUnauthorized: true
      },
      () => {
        // 发送修改后的请求头 — ghi dưới dạng latin1 để số byte trên dây khớp đúng với
        // những gì modifyHeaders đã tính (write() mặc định utf8 sẽ phình ký tự >127).
        serverSocket.write(Buffer.from(headers + '\r\n\r\n', 'latin1'))

        // 发送已接收的请求体
        if (initialBody.length > 0) {
          serverSocket.write(initialBody)
        }

        // Xả các mảnh body đã đệm trong lúc bắt tay TLS TRƯỚC khi nối listener trực tiếp,
        // để thứ tự byte trên đường hầm giữ nguyên như client đã gửi.
        for (const chunk of pendingBody) {
          serverSocket.write(chunk)
          bodyReceived += chunk.length
        }
        pendingBody.length = 0

        if (this.config.logRequests && bodyReceived < contentLength) {
          console.log(`[MitmProxy] Còn chờ body: ${bodyReceived}/${contentLength} byte`)
        }

        // Từ đây chuyển tiếp trực tiếp, handler ở handleDecryptedConnection ngừng đệm
        forwardState.live = true
        clientSocket.on('data', (chunk: Buffer) => {
          serverSocket.write(chunk)
          bodyReceived += chunk.length
        })
      }
    )

    // Phase 14: Response interception — buffer response if configured
    if (this.config.interceptResponses) {
      let responseBuffer = Buffer.alloc(0)
      let responseHeadersParsed = false
      let responseHeaders = ''

      serverSocket.on('data', (chunk: Buffer) => {
        if (!responseHeadersParsed) {
          responseBuffer = Buffer.concat([responseBuffer, chunk])
          const headerEnd = responseBuffer.indexOf('\r\n\r\n')
          if (headerEnd !== -1) {
            responseHeadersParsed = true
            responseHeaders = responseBuffer.subarray(0, headerEnd).toString()
            const responseBody = responseBuffer.subarray(headerEnd + 4)

            const modifiedResponseHeaders = this.modifyResponseHeaders(responseHeaders)
            clientSocket.write(modifiedResponseHeaders + '\r\n\r\n')

            if (responseBody.length > 0) {
              clientSocket.write(responseBody)
            }
          }
        } else {
          clientSocket.write(chunk)
        }
      })
    } else {
      serverSocket.on('data', (chunk: Buffer) => {
        clientSocket.write(chunk)
      })
    }

    serverSocket.on('end', () => {
      const duration = Date.now() - startTime
      this.events.onResponse?.({
        timestamp: Date.now(),
        host: hostname,
        statusCode: 200,
        duration
      })
      clientSocket.end()
    })

    serverSocket.on('error', (error) => {
      console.error(`[MitmProxy] Server connection error to ${hostname}:`, error.message)
      clientSocket.end()
    })

    clientSocket.on('end', () => {
      serverSocket.end()
    })

    clientSocket.on('error', () => {
      serverSocket.end()
    })
  }

  /**
   * Phase 14: Modify response headers (e.g., inject custom headers, modify model list responses)
   */
  private modifyResponseHeaders(headers: string): string {
    if (!this.config.modelMappings || Object.keys(this.config.modelMappings).length === 0) {
      return headers
    }
    return headers
  }

  /**
   * Phase 14: Get device ID for a specific account (per-account rotation)
   */
  getDeviceIdForAccount(accountId: string): string | undefined {
    if (!this.config.deviceIdMappings) return this.config.deviceId
    const mapping = this.config.deviceIdMappings.find((m) => m.accountId === accountId)
    return mapping?.deviceId || this.config.deviceId
  }

  /**
   * Phase 14: Set device ID for the current request context
   */
  setActiveDeviceId(deviceId: string): void {
    this.config.deviceId = deviceId
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<KProxyConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * 获取配置
   */
  getConfig(): KProxyConfig {
    return { ...this.config }
  }

  /**
   * 获取统计信息
   */
  getStats(): KProxyStats {
    return { ...this.stats }
  }

  /**
   * 重置统计
   */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      mitmRequests: 0,
      bypassRequests: 0,
      modifiedRequests: 0,
      startTime: this.stats.startTime,
      lastRequestTime: 0
    }
  }

  /**
   * 检查是否运行中
   */
  isRunning(): boolean {
    return this.server !== null && this.listening
  }
}
