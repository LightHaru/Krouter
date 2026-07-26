// Image generation through the standalone Codex images endpoint.

import { fetch as undiciFetch } from 'undici'
import { proxyLogger } from './logger'
import type { ChatGPTAccountState } from './chatgptOAuth'
import { refreshAccessToken, isTokenValid, DEFAULT_CHATGPT_OAUTH_CONFIG } from './chatgptOAuth'
import type { ImageStorageManager } from './bedrockImage'

// --- Types ---

export interface ChatGPTImageConfig {
  enabled: boolean
  model: string
  baseUrl: string
  timeoutMs: number
  maxRetries: number
}

export const DEFAULT_CHATGPT_IMAGE_CONFIG: ChatGPTImageConfig = {
  enabled: true,
  model: 'gpt-image-2',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  timeoutMs: 120_000,
  maxRetries: 2
}

export interface ImageGenRequest {
  prompt: string
  model?: string
  n?: number
  size?: string
  quality?: string
  response_format?: 'url' | 'b64_json'
}

export interface ImageGenResponse {
  created: number
  data: Array<{
    url?: string
    b64_json?: string
    revised_prompt?: string
  }>
}

export class ChatGPTImageApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'ChatGPTImageApiError'
  }
}

const CODEX_IMAGE_SIZES = new Set(['auto', '1024x1024', '1024x1536', '1536x1024'])

function normalizeImageSize(size?: string): string {
  if (!size) return 'auto'
  if (CODEX_IMAGE_SIZES.has(size)) return size
  if (size === '1024x1792') return '1024x1536'
  if (size === '1792x1024') return '1536x1024'
  return '1024x1024'
}

function normalizeImageQuality(quality?: string): 'auto' | 'low' | 'medium' | 'high' {
  const normalized = quality?.toLowerCase()
  if (normalized === 'hd' || normalized === 'high') return 'high'
  if (normalized === 'low' || normalized === 'medium') return normalized
  return 'auto'
}

export function buildCodexImagePayload(
  request: ImageGenRequest,
  config: ChatGPTImageConfig
): object {
  return {
    prompt: request.prompt,
    background: 'auto',
    model: config.model,
    ...(request.n && request.n > 1 ? { n: Math.min(5, Math.floor(request.n)) } : {}),
    quality: normalizeImageQuality(request.quality),
    size: normalizeImageSize(request.size)
  }
}

export function parseCodexImageResponse(value: unknown): { created: number; images: string[] } {
  const response = value as { created?: unknown; data?: Array<{ b64_json?: unknown }> }
  const images = Array.isArray(response?.data)
    ? response.data
        .map((item) => item?.b64_json)
        .filter((image): image is string => typeof image === 'string' && image.length > 0)
    : []
  if (images.length === 0) throw new Error('ChatGPT image response contained no image data')
  return {
    created:
      typeof response.created === 'number' ? response.created : Math.floor(Date.now() / 1000),
    images
  }
}

export function extractChatGPTImageError(status: number, body: string): string {
  let detail = body.trim()
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; type?: unknown; code?: unknown }
      message?: unknown
      detail?: unknown
    }
    const candidate =
      parsed.error?.message ||
      parsed.message ||
      parsed.detail ||
      parsed.error?.type ||
      parsed.error?.code
    if (typeof candidate === 'string' && candidate.trim()) detail = candidate.trim()
  } catch {
    // Preserve a short plain-text upstream error when it is not JSON.
  }
  detail = detail.replace(/bearer\s+[^\s,;}]+/gi, 'Bearer [redacted]').slice(0, 800)
  if (!detail) detail = `HTTP ${status}`
  return status === 429
    ? `ChatGPT image limit reached: ${detail}`
    : `ChatGPT image API error (${status}): ${detail}`
}

export function buildChatGPTRequestHeaders(
  accountState: ChatGPTAccountState
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accountState.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'codex-cli',
    originator: 'krouter'
  }
  if (accountState.accountId) headers['ChatGPT-Account-Id'] = accountState.accountId
  if (accountState.isFedRAMP) headers['X-OpenAI-Fedramp'] = 'true'
  return headers
}

export async function generateChatGPTImage(
  accountState: ChatGPTAccountState,
  request: ImageGenRequest,
  config: ChatGPTImageConfig,
  imageStorage: ImageStorageManager,
  serverBaseUrl: string,
  signal?: AbortSignal
): Promise<ImageGenResponse> {
  // Auto-refresh token if needed
  if (!isTokenValid(accountState)) {
    proxyLogger.info('ChatGPTImage', 'Token expired, refreshing...')
    try {
      const newTokens = await refreshAccessToken(
        accountState.refreshToken,
        DEFAULT_CHATGPT_OAUTH_CONFIG
      )
      accountState.accessToken = newTokens.accessToken
      accountState.refreshToken = newTokens.refreshToken
      accountState.expiresAt = newTokens.expiresAt
      accountState.updatedAt = Date.now()
    } catch (err) {
      throw new Error(`Token refresh failed: ${(err as Error).message}`)
    }
  }

  const payload = buildCodexImagePayload(request, config)
  const url = `${config.baseUrl}/images/generations`

  proxyLogger.info('ChatGPTImage', `Generating image: "${request.prompt.slice(0, 80)}..."`, {
    model: config.model,
    size: request.size || '1024x1024'
  })

  const startTime = Date.now()

  let lastError: Error | null = null
  let refreshedAfterUnauthorized = false
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (attempt > 0) {
      proxyLogger.info('ChatGPTImage', `Retry attempt ${attempt}/${config.maxRetries}`)
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }

    try {
      const resp = await undiciFetch(url, {
        method: 'POST',
        headers: buildChatGPTRequestHeaders(accountState),
        body: JSON.stringify(payload),
        signal: signal || AbortSignal.timeout(config.timeoutMs)
      })

      if (!resp.ok) {
        const errText = await resp.text()
        lastError = new ChatGPTImageApiError(
          resp.status,
          extractChatGPTImageError(resp.status, errText)
        )

        if (resp.status === 401 && !refreshedAfterUnauthorized) {
          // Token invalid, try refresh once
          try {
            const newTokens = await refreshAccessToken(
              accountState.refreshToken,
              DEFAULT_CHATGPT_OAUTH_CONFIG
            )
            accountState.accessToken = newTokens.accessToken
            accountState.refreshToken = newTokens.refreshToken
            accountState.expiresAt = newTokens.expiresAt
            accountState.updatedAt = Date.now()
            refreshedAfterUnauthorized = true
            continue
          } catch {
            throw new ChatGPTImageApiError(
              401,
              'Authentication failed - please re-login to ChatGPT'
            )
          }
        }

        if (resp.status === 429) throw lastError

        if (resp.status >= 500) continue // Retry on server errors
        throw lastError
      }

      const result = parseCodexImageResponse(await resp.json())
      const elapsed = Date.now() - startTime

      proxyLogger.info('ChatGPTImage', `Generated ${result.images.length} image(s) in ${elapsed}ms`)

      // Update account state
      accountState.lastImageGenAt = Date.now()
      accountState.consecutiveFailures = 0
      if (accountState.imageQuota) {
        accountState.imageQuota.used += result.images.length
      }

      // Build response
      const responseFormat = request.response_format || 'url'
      const data: ImageGenResponse['data'] = []

      for (const base64 of result.images) {
        if (responseFormat === 'b64_json') {
          data.push({ b64_json: base64, revised_prompt: request.prompt })
        } else {
          const filename = imageStorage.saveImage(base64)
          const imageUrl = `${serverBaseUrl}/v1/images/${filename}`
          data.push({ url: imageUrl, revised_prompt: request.prompt })
        }
      }

      return { created: result.created, data }
    } catch (err) {
      lastError = err as Error
      if (
        err instanceof ChatGPTImageApiError &&
        (err.status === 401 || err.status === 403 || err.status === 429)
      ) {
        accountState.consecutiveFailures++
        accountState.updatedAt = Date.now()
        throw err
      }
    }
  }

  accountState.consecutiveFailures++
  throw lastError || new Error('Image generation failed after retries')
}

export function isChatGPTImageModel(model?: string): boolean {
  if (!model) return true // Default to ChatGPT when no model specified
  const lower = model.toLowerCase()
  return (
    lower === 'gpt-image' ||
    lower === 'gpt-image-2' ||
    lower === 'chatgpt' ||
    lower === 'dall-e-3' ||
    lower === 'dall-e' ||
    (lower.startsWith('gpt-') && !lower.includes('nova'))
  )
}

export function isBedrockImageModel(model?: string): boolean {
  if (!model) return false
  const lower = model.toLowerCase()
  return lower === 'nova-canvas' || lower.startsWith('amazon.') || lower.startsWith('stability.')
}
