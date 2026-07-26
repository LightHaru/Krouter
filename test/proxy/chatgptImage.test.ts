// Phase 15 tests: ChatGPT Image Generation
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it, expect } from 'vitest'
import {
  isChatGPTImageModel,
  isBedrockImageModel,
  buildCodexImagePayload,
  buildChatGPTRequestHeaders,
  parseCodexImageResponse,
  extractChatGPTImageError,
  DEFAULT_CHATGPT_IMAGE_CONFIG
} from '../../src/main/proxy/chatgptImage'
import { ProxyServer } from '../../src/main/proxy/proxyServer'

async function listenOnRandomPort(server: ReturnType<typeof createHttpServer>): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return (server.address() as AddressInfo).port
}

async function availablePort(): Promise<number> {
  const server = createHttpServer()
  const port = await listenOnRandomPort(server)
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return port
}

describe('Phase 15: ChatGPT Image Generation', () => {
  describe('isChatGPTImageModel', () => {
    it('returns true for undefined model (default to ChatGPT)', () => {
      expect(isChatGPTImageModel(undefined)).toBe(true)
    })

    it('returns true for empty string', () => {
      expect(isChatGPTImageModel('')).toBe(true)
    })

    it('returns true for gpt-image', () => {
      expect(isChatGPTImageModel('gpt-image')).toBe(true)
    })

    it('returns true for gpt-image-2', () => {
      expect(isChatGPTImageModel('gpt-image-2')).toBe(true)
    })

    it('returns true for chatgpt', () => {
      expect(isChatGPTImageModel('chatgpt')).toBe(true)
    })

    it('returns true for dall-e-3', () => {
      expect(isChatGPTImageModel('dall-e-3')).toBe(true)
    })

    it('returns true for dall-e', () => {
      expect(isChatGPTImageModel('dall-e')).toBe(true)
    })

    it('returns true for gpt-5.4 (default codex model)', () => {
      expect(isChatGPTImageModel('gpt-5.4')).toBe(true)
    })

    it('returns false for nova-canvas', () => {
      expect(isChatGPTImageModel('nova-canvas')).toBe(false)
    })

    it('returns false for amazon.nova-canvas-v1:0', () => {
      expect(isChatGPTImageModel('amazon.nova-canvas-v1:0')).toBe(false)
    })
  })

  describe('isBedrockImageModel', () => {
    it('returns false for undefined model', () => {
      expect(isBedrockImageModel(undefined)).toBe(false)
    })

    it('returns true for nova-canvas', () => {
      expect(isBedrockImageModel('nova-canvas')).toBe(true)
    })

    it('returns true for amazon.nova-canvas-v1:0', () => {
      expect(isBedrockImageModel('amazon.nova-canvas-v1:0')).toBe(true)
    })

    it('returns true for stability.* models', () => {
      expect(isBedrockImageModel('stability.stable-diffusion-xl-v1')).toBe(true)
    })

    it('returns false for gpt-image', () => {
      expect(isBedrockImageModel('gpt-image')).toBe(false)
    })

    it('returns false for dall-e-3', () => {
      expect(isBedrockImageModel('dall-e-3')).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(isBedrockImageModel('')).toBe(false)
    })
  })

  describe('DEFAULT_CHATGPT_IMAGE_CONFIG', () => {
    it('has correct defaults', () => {
      expect(DEFAULT_CHATGPT_IMAGE_CONFIG.enabled).toBe(true)
      expect(DEFAULT_CHATGPT_IMAGE_CONFIG.model).toBe('gpt-image-2')
      expect(DEFAULT_CHATGPT_IMAGE_CONFIG.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
      expect(DEFAULT_CHATGPT_IMAGE_CONFIG.timeoutMs).toBe(120_000)
      expect(DEFAULT_CHATGPT_IMAGE_CONFIG.maxRetries).toBe(2)
    })
  })

  describe('Codex image request and response parsing', () => {
    it('adds the workspace and FedRAMP headers required by the current Codex backend', () => {
      const now = Date.now()
      const headers = buildChatGPTRequestHeaders({
        id: 'account',
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        expiresAt: now + 3600_000,
        accountId: 'workspace-123',
        isFedRAMP: true,
        consecutiveFailures: 0,
        createdAt: now,
        updatedAt: now
      })

      expect(headers.Authorization).toBe('Bearer access-secret')
      expect(headers.Accept).toBe('application/json')
      expect(headers['User-Agent']).toBe('codex-cli')
      expect(headers.originator).toBe('krouter')
      expect(headers['ChatGPT-Account-Id']).toBe('workspace-123')
      expect(headers['X-OpenAI-Fedramp']).toBe('true')
    })

    it('builds the native standalone image payload', () => {
      const payload = buildCodexImagePayload(
        { prompt: 'A lighthouse at sunrise', size: '1536x1024', quality: 'hd' },
        DEFAULT_CHATGPT_IMAGE_CONFIG
      )

      expect(payload).toEqual({
        prompt: 'A lighthouse at sunrise',
        background: 'auto',
        model: 'gpt-image-2',
        quality: 'high',
        size: '1536x1024'
      })
    })

    it('normalizes legacy sizes and defaults unsupported options safely', () => {
      expect(buildCodexImagePayload({ prompt: 'portrait', size: '1024x1792' }, DEFAULT_CHATGPT_IMAGE_CONFIG)).toMatchObject({ size: '1024x1536', quality: 'auto' })
      expect(buildCodexImagePayload({ prompt: 'odd', size: '800x600', quality: 'standard' }, DEFAULT_CHATGPT_IMAGE_CONFIG)).toMatchObject({ size: '1024x1024', quality: 'auto' })
    })

    it('extracts base64 images from the direct JSON response', () => {
      expect(parseCodexImageResponse({ created: 123, data: [{ b64_json: 'image-one' }, {}, { b64_json: 'image-two' }] })).toEqual({
        created: 123,
        images: ['image-one', 'image-two']
      })
    })

    it('fails clearly when the response has no image data', () => {
      expect(() => parseCodexImageResponse({ data: [] })).toThrow('contained no image data')
    })

    it('preserves a useful upstream limit message without leaking bearer tokens', () => {
      const message = extractChatGPTImageError(429, JSON.stringify({ error: { message: 'limit reached for Bearer secret-token' } }))
      expect(message).toContain('limit reached')
      expect(message).toContain('[redacted]')
      expect(message).not.toContain('secret-token')
    })
  })

  describe('Model routing logic', () => {
    it('default (no model) routes to ChatGPT', () => {
      expect(isChatGPTImageModel(undefined)).toBe(true)
      expect(isBedrockImageModel(undefined)).toBe(false)
    })

    it('explicit gpt-image routes to ChatGPT', () => {
      const model = 'gpt-image-2'
      expect(isChatGPTImageModel(model)).toBe(true)
      expect(isBedrockImageModel(model)).toBe(false)
    })

    it('explicit nova-canvas routes to Bedrock', () => {
      const model = 'nova-canvas'
      expect(isChatGPTImageModel(model)).toBe(false)
      expect(isBedrockImageModel(model)).toBe(true)
    })

    it('case insensitive matching', () => {
      expect(isChatGPTImageModel('GPT-IMAGE-2')).toBe(true)
      expect(isChatGPTImageModel('DALL-E-3')).toBe(true)
      expect(isBedrockImageModel('NOVA-CANVAS')).toBe(true)
      expect(isBedrockImageModel('Amazon.Nova-Canvas-v1:0')).toBe(true)
    })
  })

  it('rotates to the next ChatGPT account when image generation fails for one account', async () => {
    const attemptedAccounts: string[] = []
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
    const upstream = createHttpServer((request, response) => {
      const accountId = String(request.headers['chatgpt-account-id'] || '')
      attemptedAccounts.push(accountId)
      if (accountId === 'workspace-bad') {
        response.writeHead(403, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'account cannot generate images' } }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ created: 123, data: [{ b64_json: png }] }))
    })
    const upstreamPort = await listenOnRandomPort(upstream)
    const proxyPort = await availablePort()
    const now = Date.now()
    const proxy = new ProxyServer({
      host: '127.0.0.1',
      port: proxyPort,
      autoStart: false,
      chatgptImage: {
        ...DEFAULT_CHATGPT_IMAGE_CONFIG,
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        maxRetries: 0
      },
      chatgptAccounts: [
        {
          id: 'bad',
          accessToken: 'bad-token',
          refreshToken: 'bad-refresh',
          expiresAt: now + 3_600_000,
          accountId: 'workspace-bad',
          consecutiveFailures: 0,
          createdAt: now,
          updatedAt: now - 2
        },
        {
          id: 'good',
          accessToken: 'good-token',
          refreshToken: 'good-refresh',
          expiresAt: now + 3_600_000,
          accountId: 'workspace-good',
          consecutiveFailures: 0,
          createdAt: now,
          updatedAt: now - 1
        }
      ]
    })

    try {
      await proxy.start()
      const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/images/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'green K', response_format: 'url' })
      })
      expect(response.status).toBe(200)
      const payload = await response.json() as { data: Array<{ url: string }> }
      expect(attemptedAccounts).toEqual(['workspace-bad', 'workspace-good'])
      expect(payload.data[0].url).toMatch(/^http:\/\/127\.0\.0\.1:/)

      const image = await fetch(payload.data[0].url)
      expect(image.status).toBe(200)
      expect(image.headers.get('content-type')).toBe('image/png')
      expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(0)
    } finally {
      await proxy.stop()
      await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()))
    }
  })
})
