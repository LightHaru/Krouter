// Phase 15: Image Generation via ChatGPT OAuth
// Uses chatgpt.com/backend-api/codex/responses with image_generation tool
// Works with free ChatGPT accounts (limited quota) and paid accounts

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
  model: 'gpt-5.4',
  baseUrl: 'https://chatgpt.com/backend-api/codex',
  timeoutMs: 120_000,
  maxRetries: 2,
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

interface CodexResponseEvent {
  type: string
  item?: {
    type: string
    result?: string
    call_id?: string
  }
  response?: {
    id?: string
    status?: string
  }
}

// --- Size Mapping ---

const SIZE_INSTRUCTIONS: Record<string, string> = {
  '256x256': 'small square image (256x256)',
  '512x512': 'medium square image (512x512)',
  '1024x1024': 'square image (1024x1024)',
  '1024x1536': 'portrait image (1024x1536)',
  '1536x1024': 'landscape image (1536x1024)',
  '1024x1792': 'tall portrait image (1024x1792)',
  '1792x1024': 'wide landscape image (1792x1024)',
}

// --- Core Functions ---

function buildCodexPayload(request: ImageGenRequest, config: ChatGPTImageConfig): object {
  let promptText = request.prompt

  // Add size instruction if specified
  const sizeInstruction = SIZE_INSTRUCTIONS[request.size || '']
  if (sizeInstruction) {
    promptText = `Generate a ${sizeInstruction}: ${promptText}`
  }

  // Add quality instruction
  if (request.quality === 'hd' || request.quality === 'high') {
    promptText = `${promptText}. Make it high quality and detailed.`
  }

  return {
    model: config.model,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: promptText }
        ]
      }
    ],
    tools: [{ type: 'image_generation' }],
    stream: true,
    store: false,
  }
}

async function parseSSEStream(
  response: Response,
  signal?: AbortSignal
): Promise<{ images: Array<{ base64: string; callId?: string; revisedPrompt?: string }> }> {
  const images: Array<{ base64: string; callId?: string; revisedPrompt?: string }> = []

  const body = response.body
  if (!body) throw new Error('No response body')

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (signal?.aborted) throw new Error('Request aborted')

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const data = line.slice(6).trim()
        if (data === '[DONE]') return { images }

        try {
          const event = JSON.parse(data) as CodexResponseEvent

          if (event.type === 'response.output_item.done' &&
              event.item?.type === 'image_generation_call' &&
              event.item?.result) {
            images.push({
              base64: event.item.result,
              callId: event.item.call_id,
            })
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  return { images }
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
    } catch (err) {
      throw new Error(`Token refresh failed: ${(err as Error).message}`)
    }
  }

  const payload = buildCodexPayload(request, config)
  const url = `${config.baseUrl}/responses`

  proxyLogger.info('ChatGPTImage', `Generating image: "${request.prompt.slice(0, 80)}..."`, {
    model: config.model,
    size: request.size || '1024x1024',
  })

  const startTime = Date.now()

  let lastError: Error | null = null
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (attempt > 0) {
      proxyLogger.info('ChatGPTImage', `Retry attempt ${attempt}/${config.maxRetries}`)
      await new Promise(r => setTimeout(r, 2000 * attempt))
    }

    try {
      const resp = await undiciFetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accountState.accessToken}`,
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(payload),
        signal: signal || AbortSignal.timeout(config.timeoutMs),
      })

      if (!resp.ok) {
        const errText = await resp.text()
        lastError = new Error(`ChatGPT API error (${resp.status}): ${errText}`)

        if (resp.status === 401) {
          // Token invalid, try refresh once
          try {
            const newTokens = await refreshAccessToken(
              accountState.refreshToken,
              DEFAULT_CHATGPT_OAUTH_CONFIG
            )
            accountState.accessToken = newTokens.accessToken
            accountState.refreshToken = newTokens.refreshToken
            accountState.expiresAt = newTokens.expiresAt
            continue
          } catch {
            throw new Error('Authentication failed - please re-login to ChatGPT')
          }
        }

        if (resp.status === 429) {
          throw new Error('ChatGPT rate limit exceeded - quota exhausted for this account')
        }

        if (resp.status >= 500) continue // Retry on server errors
        throw lastError
      }

      const result = await parseSSEStream(resp as unknown as Response, signal)
      const elapsed = Date.now() - startTime

      if (result.images.length === 0) {
        lastError = new Error('No images generated in response')
        continue
      }

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

      for (const img of result.images) {
        if (responseFormat === 'b64_json') {
          data.push({ b64_json: img.base64, revised_prompt: request.prompt })
        } else {
          const filename = imageStorage.saveImage(img.base64)
          const imageUrl = `${serverBaseUrl}/v1/images/${filename}`
          data.push({ url: imageUrl, revised_prompt: request.prompt })
        }
      }

      return { created: Math.floor(Date.now() / 1000), data }

    } catch (err) {
      lastError = err as Error
      if ((err as Error).message.includes('rate limit') ||
          (err as Error).message.includes('Authentication failed')) {
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
  return lower === 'gpt-image' ||
         lower === 'gpt-image-2' ||
         lower === 'chatgpt' ||
         lower === 'dall-e-3' ||
         lower === 'dall-e' ||
         lower.startsWith('gpt-') && !lower.includes('nova')
}

export function isBedrockImageModel(model?: string): boolean {
  if (!model) return false
  const lower = model.toLowerCase()
  return lower === 'nova-canvas' ||
         lower.startsWith('amazon.') ||
         lower.startsWith('stability.')
}
