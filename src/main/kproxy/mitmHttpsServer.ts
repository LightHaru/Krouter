import * as https from 'https'
import * as http2 from 'http2'
import * as tls from 'tls'
import * as http from 'http'
import * as dns from 'dns'
import { promisify } from 'util'
import type { CertManager } from './certManager'
import { modelMapper, type IdeType } from './modelMapper'

export interface MitmServerConfig {
  port: number
  host: string
  routerBase: string
}

export interface MitmServerStats {
  running: boolean
  port: number
  connections: number
  interceptedRequests: number
  passthroughRequests: number
  startTime: number | null
  byIdeType: Record<string, number>
}

type MitmEventHandler = (info: {
  hostname: string
  method: string
  path: string
  ideType: string
  action: 'intercept' | 'passthrough'
  mappedModel?: string
}) => void

const DEFAULT_CONFIG: MitmServerConfig = {
  port: 443,
  host: '127.0.0.1',
  routerBase: 'http://127.0.0.1:5580'
}

const TARGET_HOSTS = [
  'daily-cloudcode-pa.googleapis.com',
  'cloudcode-pa.googleapis.com',
  'api.individual.githubcopilot.com',
  'q.us-east-1.amazonaws.com',
  'codewhisperer.us-east-1.amazonaws.com',
  'runtime.us-east-1.kiro.dev',
  'api2.cursor.sh'
]

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

function getToolForHost(host: string): IdeType | null {
  const h = (host || '').split(':')[0]
  if (h === 'api.individual.githubcopilot.com') return 'copilot'
  if (h === 'daily-cloudcode-pa.googleapis.com' || h === 'cloudcode-pa.googleapis.com') return 'antigravity'
  if (h === 'q.us-east-1.amazonaws.com' || h === 'codewhisperer.us-east-1.amazonaws.com' || h === 'runtime.us-east-1.kiro.dev') return 'kiro'
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
  return (nonPrintable / sample.length) > 0.3
}

function extractModel(url: string, body: Buffer): string | null {
  const urlMatch = url.match(/\/models\/([^/:]+)/)
  if (urlMatch) return urlMatch[1]
  if (isBinaryData(body)) return null
  try {
    const parsed = JSON.parse(body.toString())
    if (parsed.conversationState) {
      return parsed.conversationState.currentMessage?.userInputMessage?.modelId || null
    }
    return parsed.model || null
  } catch { return null }
}

export class MitmHttpsServer {
  private server: https.Server | null = null
  private config: MitmServerConfig
  private certManager: CertManager | null = null
  private stats: MitmServerStats = {
    running: false,
    port: 443,
    connections: 0,
    interceptedRequests: 0,
    passthroughRequests: 0,
    startTime: null,
    byIdeType: {}
  }
  private onRequest: MitmEventHandler | null = null
  private ipCache: Map<string, { ip: string; ts: number }> = new Map()
  private alpnCache: Map<string, string> = new Map()

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

  async start(): Promise<void> {
    if (this.server) return
    if (!this.certManager) throw new Error('CertManager not set. Call setCertManager() first.')

    const fallbackCert = this.certManager.generateCertForHost('localhost')
    const caPem = this.certManager.getCACertPem() || ''

    this.server = https.createServer({
      cert: fallbackCert.cert,
      key: fallbackCert.key,
      SNICallback: (hostname, cb) => {
        try {
          const hostCert = this.certManager!.generateCertForHost(hostname)
          const ctx = tls.createSecureContext({
            cert: hostCert.cert + '\n' + caPem,
            key: hostCert.key
          })
          cb(null, ctx)
        } catch (err) {
          cb(err instanceof Error ? err : new Error(String(err)), undefined as any)
        }
      }
    }, (req, res) => this.handleRequest(req, res))

    this.server.on('connection', () => { this.stats.connections++ })

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        this.stats.running = true
        this.stats.startTime = Date.now()
        console.log(`[MITM] Listening on https://${this.config.host}:${this.config.port}`)
        resolve()
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
    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null
        this.stats.running = false
        console.log('[MITM] Stopped')
        resolve()
      })
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
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.url === '/_mitm_health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, pid: process.pid }))
        return
      }

      const bodyBuffer = await this.collectBody(req)

      if (req.headers[INTERNAL_HEADER] === INTERNAL_VALUE) {
        return this.passthrough(req, res, bodyBuffer)
      }

      const tool = getToolForHost(req.headers.host || '')
      if (!tool) return this.passthrough(req, res, bodyBuffer)

      const patterns = URL_PATTERNS[tool] || []
      const isChat = patterns.some(p => (req.url || '').includes(p))
      if (!isChat) return this.passthrough(req, res, bodyBuffer)

      const model = extractModel(req.url || '', bodyBuffer)

      if (model && (MODEL_NO_MAP[tool] || []).some(re => re.test(model))) {
        return this.passthrough(req, res, bodyBuffer)
      }

      const mappedModel = modelMapper.mapModel(model || '', tool)
      if (!mappedModel) {
        return this.passthrough(req, res, bodyBuffer)
      }

      this.stats.interceptedRequests++
      this.stats.byIdeType[tool] = (this.stats.byIdeType[tool] || 0) + 1
      this.onRequest?.({
        hostname: (req.headers.host || '').split(':')[0],
        method: req.method || 'GET',
        path: req.url || '/',
        ideType: tool,
        action: 'intercept',
        mappedModel
      })

      await this.interceptRequest(req, res, bodyBuffer, tool, mappedModel)
    } catch (e: any) {
      console.error(`[MITM] Unhandled error: ${e.message}`)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: e.message, type: 'mitm_error' } }))
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
        return this.passthrough(req, res, bodyBuffer)
      }
    } catch (error: any) {
      console.error(`[MITM][${tool}] Intercept error: ${error.message}`)
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: error.message, type: 'mitm_error', handler: tool } }))
    }
  }

  private async interceptCopilot(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bodyBuffer: Buffer,
    mappedModel: string
  ): Promise<void> {
    const body = JSON.parse(bodyBuffer.toString())
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
    const body = JSON.parse(bodyBuffer.toString())
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
      return this.passthrough(req, res, bodyBuffer)
    }

    const body = JSON.parse(bodyBuffer.toString())
    const messages = this.codeWhispererToMessages(body)
    if (messages.length === 0) {
      throw new Error('codeWhispererToMessages produced 0 messages')
    }

    const tools = this.extractKiroTools(body)
    const openaiBody: any = {
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

  private codeWhispererToMessages(body: any): any[] {
    const cs = body.conversationState || {}
    const history = cs.history || []
    const currentMsg = cs.currentMessage
    const messages: any[] = []

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

  private convertUserInputMessage(uim: any): any[] {
    const out: any[] = []
    const toolResults = uim.userInputMessageContext?.toolResults || []

    for (const tr of toolResults) {
      const text = (tr.content || []).map((c: any) => c.text || '').join('\n')
      out.push({ role: 'tool', tool_call_id: tr.toolUseId || '', content: text })
    }

    const text = (uim.content || '').trim()
    if (text || toolResults.length === 0) {
      out.push({ role: 'user', content: text })
    }

    return out
  }

  private convertAssistantMessage(arm: any): any {
    const toolUses = arm.toolUses || []
    if (toolUses.length > 0) {
      return {
        role: 'assistant',
        content: arm.content || null,
        tool_calls: toolUses.map((tu: any) => ({
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

  private extractKiroTools(body: any): any[] {
    const cs = body.conversationState || {}
    const fromCurrent = cs.currentMessage?.userInputMessage?.userInputMessageContext?.tools || []
    const fromHistory = cs.history?.find((h: any) => h.userInputMessage?.userInputMessageContext?.tools)
      ?.userInputMessage?.userInputMessageContext?.tools || []
    const cwTools = fromCurrent.length > 0 ? fromCurrent : fromHistory
    if (!cwTools.length) return []

    return cwTools.map((item: any) => {
      const spec = item.toolSpecification || item
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
      'Connection': 'keep-alive'
    })

    if (!routerRes.body) {
      res.end()
      return
    }

    const reader = routerRes.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: false })
    let buffer = ''
    const state = { modelId, toolCallInit: {} as any, hasToolCalls: false, finishSent: false }

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
          const parsed = JSON.parse(data)
          const frames = this.convertOpenAIToKiroFrames(parsed, state)
          if (frames) {
            for (const frame of frames) {
              res.write(frame)
            }
          }
        } catch { /* skip unparseable */ }
      }
    }

    if (!state.finishSent) {
      const stopFrame = this.buildEventStreamFrame('messageStopEvent', {})
      res.write(stopFrame)
    }
    res.end()
  }

  private convertOpenAIToKiroFrames(chunk: any, state: any): Buffer[] | null {
    const frames: Buffer[] = []
    const choice = chunk.choices?.[0]
    const delta = choice?.delta || {}

    if (delta.tool_calls) {
      state.hasToolCalls = true
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0
        if (tc.id && tc.function?.name && !state.toolCallInit[idx]) {
          state.toolCallInit[idx] = { id: tc.id, name: tc.function.name }
          frames.push(this.buildEventStreamFrame('toolUseEvent', {
            name: tc.function.name, toolUseId: tc.id
          }))
        }
        if (tc.function?.arguments) {
          const init = state.toolCallInit[idx]
          frames.push(this.buildEventStreamFrame('toolUseEvent', {
            input: tc.function.arguments,
            name: init?.name || tc.function?.name || '',
            toolUseId: init?.id || tc.id || ''
          }))
        }
      }
    }

    if (delta.content) {
      frames.push(this.buildEventStreamFrame('assistantResponseEvent', {
        content: delta.content,
        modelId: state.modelId
      }))
    }

    if (choice?.finish_reason) {
      if (state.hasToolCalls) {
        for (const idx of Object.keys(state.toolCallInit).sort()) {
          const tc = state.toolCallInit[idx]
          frames.push(this.buildEventStreamFrame('toolUseEvent', {
            name: tc.name, stop: true, toolUseId: tc.id
          }))
        }
      } else {
        frames.push(this.buildEventStreamFrame('messageStopEvent', {}))
      }
      state.finishSent = true
      state.toolCallInit = {}
    }

    return frames.length > 0 ? frames : null
  }

  private buildEventStreamFrame(eventType: string, payload: any): Buffer {
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
    nameBuf.copy(buf, o); o += nameBuf.length
    buf[o++] = 7
    buf.writeUInt16BE(valueBuf.length, o); o += 2
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

  private async fetchRouter(body: any, path: string, clientHeaders: http.IncomingHttpHeaders): Promise<Response> {
    const stripHeaders = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'content-type', 'authorization'])
    const forwarded: Record<string, string> = {}
    for (const [k, v] of Object.entries(clientHeaders)) {
      if (!stripHeaders.has(k.toLowerCase()) && typeof v === 'string') {
        forwarded[k] = v
      }
    }

    const url = `${this.config.routerBase}${path}`
    return fetch(url, {
      method: 'POST',
      headers: {
        ...forwarded,
        'Content-Type': 'application/json',
        [INTERNAL_HEADER]: INTERNAL_VALUE,
        ...(this.routerApiKey && { 'Authorization': `Bearer ${this.routerApiKey}` })
      },
      body: JSON.stringify(body)
    })
  }

  private async pipeResponse(routerRes: Response, res: http.ServerResponse): Promise<void> {
    const ct = routerRes.headers.get('content-type') || 'application/json'
    const status = routerRes.status || 200
    const resHeaders: Record<string, string> = {
      'Content-Type': ct,
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
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
      if (done) { res.end(); break }
      res.write(decoder.decode(value, { stream: true }))
    }
  }

  private async passthrough(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    bodyBuffer: Buffer
  ): Promise<void> {
    this.stats.passthroughRequests++
    const originalHost = (req.headers.host || '').split(':')[0]
    const isChatEndpoint = (req.url || '').includes(':generateContent') || (req.url || '').includes(':streamGenerateContent')
    const targetHost = isChatEndpoint ? (HOST_REWRITE[originalHost] || originalHost) : originalHost

    this.onRequest?.({
      hostname: originalHost,
      method: req.method || 'GET',
      path: req.url || '/',
      ideType: getToolForHost(req.headers.host || '') || 'unknown',
      action: 'passthrough'
    })

    try {
      const proto = await this.negotiateAlpn(targetHost)
      if (proto === 'h2') {
        return await this.passthroughHttp2(req, res, bodyBuffer, targetHost)
      }
    } catch {
      // fallback to HTTP/1.1
    }
    return this.passthroughHttps(req, res, bodyBuffer, targetHost)
  }

  private async negotiateAlpn(host: string): Promise<string> {
    if (this.alpnCache.has(host)) return this.alpnCache.get(host)!
    const ip = await this.resolveTargetIP(host)
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: ip, port: 443, servername: host,
        ALPNProtocols: ['h2', 'http/1.1'], rejectUnauthorized: false
      }, () => {
        const proto = socket.alpnProtocol || 'http/1.1'
        this.alpnCache.set(host, proto)
        socket.end()
        resolve(proto)
      })
      socket.once('error', reject)
      socket.setTimeout(5000, () => { socket.destroy(new Error('ALPN timeout')) })
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
      if (['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection'].includes(lk)) continue
      h2Headers[lk] = v
    }
    h2Headers[':method'] = req.method || 'GET'
    h2Headers[':path'] = req.url || '/'
    h2Headers[':scheme'] = 'https'
    h2Headers[':authority'] = targetHost

    return new Promise((resolve) => {
      const client = http2.connect(`https://${targetHost}`, {
        createConnection: () => tls.connect({
          host: targetIP, port: 443, servername: targetHost,
          ALPNProtocols: ['h2'], rejectUnauthorized: false
        }) as any
      })
      client.once('error', (e) => {
        console.error(`[MITM] H2 error: ${e.message}`)
        if (!res.headersSent) res.writeHead(502)
        if (!res.writableEnded) res.end('Bad Gateway')
        try { client.close() } catch {}
        resolve()
      })

      const stream = client.request(h2Headers as any, { endStream: bodyBuffer.length === 0 })
      if (bodyBuffer.length > 0) stream.end(bodyBuffer)

      stream.once('response', (responseHeaders) => {
        const status = responseHeaders[':status'] as number
        const outHeaders: Record<string, any> = {}
        for (const [k, v] of Object.entries(responseHeaders)) {
          if (k.startsWith(':') || ['connection', 'keep-alive', 'transfer-encoding'].includes(k)) continue
          outHeaders[k] = v
        }
        res.writeHead(status, outHeaders)

        stream.on('data', (chunk: Buffer) => { res.write(chunk) })
        stream.on('end', () => {
          if (!res.writableEnded) res.end()
          try { client.close() } catch {}
          resolve()
        })
      })
      stream.once('error', (e) => {
        console.error(`[MITM] H2 stream error: ${e.message}`)
        if (!res.headersSent) res.writeHead(502)
        if (!res.writableEnded) res.end()
        try { client.close() } catch {}
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
    const targetIP = await this.resolveTargetIP(targetHost)
    const headers = { ...req.headers, host: targetHost }

    return new Promise((resolve) => {
      const forwardReq = https.request({
        hostname: targetIP,
        port: 443,
        path: req.url,
        method: req.method,
        headers,
        servername: targetHost,
        rejectUnauthorized: false
      }, (forwardRes) => {
        res.writeHead(forwardRes.statusCode || 502, forwardRes.headers)
        forwardRes.on('data', (chunk: Buffer) => { res.write(chunk) })
        forwardRes.on('end', () => { res.end(); resolve() })
      })

      forwardReq.on('error', (e) => {
        console.error(`[MITM] Passthrough error: ${e.message}`)
        if (!res.headersSent) res.writeHead(502)
        res.end('Bad Gateway')
        resolve()
      })

      if (bodyBuffer.length > 0) forwardReq.write(bodyBuffer)
      forwardReq.end()
    })
  }

  private async resolveTargetIP(hostname: string): Promise<string> {
    const cached = this.ipCache.get(hostname)
    if (cached && Date.now() - cached.ts < 5 * 60 * 1000) return cached.ip

    const resolver = new dns.Resolver()
    resolver.setServers(['8.8.8.8'])
    const resolve4 = promisify(resolver.resolve4.bind(resolver))
    const addresses = await resolve4(hostname)
    this.ipCache.set(hostname, { ip: addresses[0], ts: Date.now() })
    return addresses[0]
  }

  private collectBody(req: http.IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks)))
      req.on('error', reject)
    })
  }
}

export const mitmHttpsServer = new MitmHttpsServer()
