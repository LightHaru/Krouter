import http from 'http'
import net from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { ProxyServer } from '../../src/main/proxy/proxyServer'

interface OpenAIChatResponse {
  model: string
  choices: Array<{ message: { content: string } }>
}

interface AnthropicMessageResponse {
  type: string
  content: Array<{ text: string }>
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

describe('Custom API proxy integration', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => { await Promise.all(cleanup.splice(0).map((fn) => fn())) })

  it('discovers, routes, converts Claude requests and probes an OpenAI-compatible provider', async () => {
    const upstreamPort = await freePort()
    const proxyPort = await freePort()
    const upstreamRequests: Array<{ path: string; auth?: string; body?: Record<string, unknown> }> = []
    const upstream = http.createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += String(chunk)
      const body = raw ? JSON.parse(raw) : undefined
      upstreamRequests.push({ path: req.url || '', auth: req.headers.authorization, body })
      res.setHeader('content-type', 'application/json')
      if (req.url === '/v1/models') {
        res.end(JSON.stringify({ data: [{ id: 'gpt-test', name: 'GPT Test' }] }))
        return
      }
      res.end(JSON.stringify({
        id: 'chatcmpl_custom',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: 'custom pong' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      }))
    })
    await new Promise<void>((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve))
    cleanup.push(async () => await new Promise<void>((resolve) => upstream.close(() => resolve())))

    const proxy = new ProxyServer({
      port: proxyPort,
      host: '127.0.0.1',
      autoStart: false,
      customApiProviders: [{
        id: 'acme',
        name: 'Acme API',
        enabled: true,
        protocol: 'openai',
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        routePrefix: 'acme',
        models: ['gpt-test'],
        reasoningEffort: 'high',
        keys: [
          { id: 'disabled', name: 'Disabled', apiKey: 'must-not-be-used', enabled: false },
          { id: 'live', name: 'Live', apiKey: 'upstream-secret', enabled: true }
        ]
      }]
    })
    await proxy.start()
    cleanup.push(async () => await proxy.stop())
    const base = `http://127.0.0.1:${proxyPort}`

    const models = await fetch(`${base}/v1/models`).then((response) => response.json()) as { data: Array<{ id: string }> }
    expect(models.data.some((model) => model.id === 'acme/gpt-test')).toBe(true)

    const chat = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'acme/gpt-test', messages: [{ role: 'user', content: 'ping' }] }) }).then((response) => response.json()) as OpenAIChatResponse
    expect(chat.choices[0].message.content).toBe('custom pong')
    expect(chat.model).toBe('acme/gpt-test')

    const claude = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'acme/gpt-test', max_tokens: 16, messages: [{ role: 'user', content: 'ping' }] }) }).then((response) => response.json()) as AnthropicMessageResponse
    expect(claude.type).toBe('message')
    expect(claude.content[0].text).toBe('custom pong')

    const stream = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'acme/gpt-test', stream: true, messages: [{ role: 'user', content: 'ping' }] }) }).then((response) => response.text())
    expect(stream).toContain('custom pong')
    expect(stream).toContain('[DONE]')

    const probes = await proxy.probeModels({ modelIds: ['acme/gpt-test'], concurrency: 1 })
    expect(probes).toEqual([expect.objectContaining({ modelId: 'acme/gpt-test', tier: 'custom:acme', ok: true })])
    expect(upstreamRequests.filter((request) => request.path === '/v1/chat/completions')).toHaveLength(4)
    expect(upstreamRequests.every((request) => request.auth === 'Bearer upstream-secret')).toBe(true)
    expect(upstreamRequests.find((request) => request.path === '/v1/chat/completions')?.body.model).toBe('gpt-test')
    expect(upstreamRequests.find((request) => request.path === '/v1/chat/completions')?.body.reasoning_effort).toBe('high')
  })
})
