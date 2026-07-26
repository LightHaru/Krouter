import * as fs from 'fs'
import * as http from 'http'
import * as https from 'https'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { CertManager } from '../../src/main/kproxy/certManager'
import { MitmHttpsServer } from '../../src/main/kproxy/mitmHttpsServer'

async function reservePort(): Promise<number> {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Unable to reserve test port')
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return address.port
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

function requestKiro(port: number, body: unknown, requestPath = '/generateAssistantResponse'): Promise<{ status: number; body: Buffer }> {
  const payload = Buffer.from(JSON.stringify(body))
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: '127.0.0.1',
      port,
      servername: 'runtime.us-east-1.kiro.dev',
      method: 'POST',
      path: requestPath,
      rejectUnauthorized: false,
      headers: {
        Host: 'runtime.us-east-1.kiro.dev',
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        Authorization: 'Bearer should-not-reach-router'
      }
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        body: Buffer.concat(chunks)
      }))
    })
    req.once('error', reject)
    req.end(payload)
  })
}

function decodeEventStream(buffer: Buffer): Array<{ eventType: string; payload: any }> {
  const events: Array<{ eventType: string; payload: any }> = []
  let offset = 0
  while (offset < buffer.length) {
    const totalLength = buffer.readUInt32BE(offset)
    const headersLength = buffer.readUInt32BE(offset + 4)
    const headersEnd = offset + 12 + headersLength
    let headerOffset = offset + 12
    let eventType = ''
    while (headerOffset < headersEnd) {
      const nameLength = buffer[headerOffset++]
      const name = buffer.subarray(headerOffset, headerOffset + nameLength).toString('utf8')
      headerOffset += nameLength
      const valueType = buffer[headerOffset++]
      if (valueType !== 7) throw new Error(`Unsupported event-stream header type ${valueType}`)
      const valueLength = buffer.readUInt16BE(headerOffset)
      headerOffset += 2
      const value = buffer.subarray(headerOffset, headerOffset + valueLength).toString('utf8')
      headerOffset += valueLength
      if (name === ':event-type') eventType = value
    }
    const payload = JSON.parse(buffer.subarray(headersEnd, offset + totalLength - 4).toString('utf8'))
    events.push({ eventType, payload })
    offset += totalLength
  }
  return events
}

describe('MITM HTTPS Kiro end-to-end routing', () => {
  const cleanup: Array<() => Promise<void> | void> = []

  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()?.()
  })

  it('routes the installed Kiro endpoint through Krouter and returns AWS event-stream frames', async () => {
    const routerPort = await reservePort()
    const mitmPort = await reservePort()
    const routerRequests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: any }> = []
    const router = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{"status":"ok"}')
        return
      }
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        routerRequests.push({
          url: req.url || '',
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8'))
        })
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"choices":[{"delta":{"content":"routed by Krouter"},"finish_reason":null}]}\n\n')
        res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      })
    })
    await listen(router, routerPort)
    cleanup.push(() => close(router))

    const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'krouter-mitm-test-'))
    cleanup.push(() => fs.rmSync(certDir, { recursive: true, force: true }))
    const certManager = new CertManager(certDir)
    await certManager.initialize()

    const mitm = new MitmHttpsServer({
      host: '127.0.0.1',
      port: mitmPort,
      routerBase: `http://127.0.0.1:${routerPort}`
    })
    mitm.setCertManager(certManager)
    mitm.setRouterApiKey('test-router-key')
    await mitm.start()
    cleanup.push(() => mitm.stop())

    const response = await requestKiro(mitmPort, {
      conversationState: {
        currentMessage: {
          userInputMessage: {
            content: 'Use Krouter, not the signed-in Kiro account',
            modelId: 'claude-sonnet-4.5'
          }
        },
        history: []
      }
    }, '/')

    expect(response.status).toBe(200)
    expect(response.body.length).toBeGreaterThan(32)
    expect(response.body.includes(Buffer.from('routed by Krouter'))).toBe(true)
    expect(decodeEventStream(response.body)).toEqual([
      {
        eventType: 'assistantResponseEvent',
        payload: { content: 'routed by Krouter', modelId: 'claude-sonnet-4.5' }
      },
      {
        eventType: 'metadataEvent',
        payload: { stopReason: 'END_TURN' }
      }
    ])
    expect(routerRequests).toHaveLength(1)
    expect(routerRequests[0].url).toBe('/v1/chat/completions')
    expect(routerRequests[0].headers.authorization).toBe('Bearer test-router-key')
    expect(routerRequests[0].headers.authorization).not.toContain('should-not-reach-router')
    expect(routerRequests[0].body).toMatchObject({
      model: 'claude-sonnet-4.5',
      stream: true,
      messages: [{ role: 'user', content: 'Use Krouter, not the signed-in Kiro account' }]
    })

    const stats = mitm.getStats()
    expect(stats.listenerReachable).toBe(true)
    expect(stats.routerReachable).toBe(true)
    expect(stats.lastDiagnosticError).toBeNull()
    expect(stats.interceptedRequests).toBe(1)
    expect(stats.passthroughRequests).toBe(0)
    expect(stats.routerSuccesses).toBe(1)
    expect(stats.routerFailures).toBe(0)
    expect(stats.recentDecisions.map((decision) => decision.action)).toEqual([
      'router-success',
      'intercept'
    ])
  })
})
