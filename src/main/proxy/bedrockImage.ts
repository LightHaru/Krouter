// Phase 11: Amazon Nova Canvas Image Generation
// OpenAI-compatible /v1/images/generations endpoint via AWS Bedrock

import { fetch as undiciFetch } from 'undici'
import { signBedrockRequest, type BedrockConfig, type BedrockCredentials } from './bedrock'
import { proxyLogger } from './logger'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

// --- Types ---

interface OpenAIImageRequest {
  prompt: string
  model?: string
  n?: number
  size?: string
  quality?: string
  style?: string
  response_format?: 'url' | 'b64_json'
  negative_prompt?: string
  cfg_scale?: number
  seed?: number
}

interface OpenAIImageResponse {
  created: number
  data: Array<{
    url?: string
    b64_json?: string
    revised_prompt?: string
  }>
}

interface NovaCanvasRequest {
  taskType: 'TEXT_IMAGE'
  textToImageParams: {
    text: string
    negativeText?: string
  }
  imageGenerationConfig: {
    numberOfImages: number
    quality: 'standard' | 'premium'
    height: number
    width: number
    cfgScale: number
    seed?: number
  }
}

interface NovaCanvasResponse {
  images?: string[]
  error?: string
}

// --- Size mappings ---

const SIZE_MAP: Record<string, { width: number; height: number }> = {
  '256x256': { width: 512, height: 512 },
  '512x512': { width: 512, height: 512 },
  '1024x1024': { width: 1024, height: 1024 },
  '1024x1792': { width: 1024, height: 1792 },
  '1792x1024': { width: 1792, height: 1024 }
}

const NOVA_CANVAS_MODEL = 'amazon.nova-canvas-v1:0'

// --- Image Storage ---

export class ImageStorageManager {
  private storagePath: string
  private maxAgeMs: number
  private maxSizeBytes: number

  constructor(opts?: { storagePath?: string; maxAgeMs?: number; maxSizeBytes?: number }) {
    this.storagePath = opts?.storagePath || '/tmp/krouter-images'
    this.maxAgeMs = opts?.maxAgeMs || 24 * 60 * 60 * 1000
    this.maxSizeBytes = opts?.maxSizeBytes || 1024 * 1024 * 1024
    fs.mkdirSync(this.storagePath, { recursive: true })
  }

  saveImage(base64Data: string): string {
    const id = crypto.randomBytes(16).toString('hex')
    const filename = `${id}.png`
    const filePath = path.join(this.storagePath, filename)
    fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'))
    return filename
  }

  getImagePath(filename: string): string | null {
    const filePath = path.join(this.storagePath, filename)
    if (fs.existsSync(filePath)) return filePath
    return null
  }

  cleanup(): { removed: number } {
    let removed = 0
    try {
      const now = Date.now()
      const files = fs.readdirSync(this.storagePath)
      for (const file of files) {
        const filePath = path.join(this.storagePath, file)
        const stat = fs.statSync(filePath)
        if (now - stat.mtimeMs > this.maxAgeMs) {
          fs.unlinkSync(filePath)
          removed++
        }
      }
    } catch (e) {
      proxyLogger.warn('ImageStorage', `Cleanup error: ${(e as Error).message}`)
    }
    return { removed }
  }

  getStoragePath(): string {
    return this.storagePath
  }
}

// --- Core Logic ---

function resolveBedrockCredentials(config: BedrockConfig): BedrockCredentials | null {
  const accessKeyId = config.accessKeyId || process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = config.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY
  const region = config.region || process.env.AWS_REGION || 'us-east-1'
  const sessionToken = config.sessionToken || process.env.AWS_SESSION_TOKEN
  if (!accessKeyId || !secretAccessKey) return null
  return { accessKeyId, secretAccessKey, sessionToken, region }
}

export function buildNovaCanvasRequest(req: OpenAIImageRequest): NovaCanvasRequest {
  const size = SIZE_MAP[req.size || '1024x1024'] || SIZE_MAP['1024x1024']
  const quality = req.quality === 'hd' ? 'premium' : 'standard'
  const n = Math.min(4, Math.max(1, req.n || 1))
  const cfgScale = req.cfg_scale ?? 7.0

  const novaReq: NovaCanvasRequest = {
    taskType: 'TEXT_IMAGE',
    textToImageParams: {
      text: req.prompt
    },
    imageGenerationConfig: {
      numberOfImages: n,
      quality,
      height: size.height,
      width: size.width,
      cfgScale
    }
  }

  if (req.negative_prompt) {
    novaReq.textToImageParams.negativeText = req.negative_prompt
  }
  if (req.seed !== undefined) {
    novaReq.imageGenerationConfig.seed = req.seed
  }

  return novaReq
}

export async function generateImage(
  config: BedrockConfig,
  request: OpenAIImageRequest,
  imageStorage: ImageStorageManager,
  serverBaseUrl: string,
  signal?: AbortSignal
): Promise<OpenAIImageResponse> {
  const creds = resolveBedrockCredentials(config)
  if (!creds) throw new Error('AWS credentials not configured for image generation')

  const novaReq = buildNovaCanvasRequest(request)
  const body = JSON.stringify(novaReq)
  const host = `bedrock-runtime.${creds.region}.amazonaws.com`
  const apiPath = `/model/${NOVA_CANVAS_MODEL}/invoke`

  const signed = signBedrockRequest({
    creds,
    service: 'bedrock',
    method: 'POST',
    host,
    path: apiPath,
    body,
    extraHeaders: {
      'content-type': 'application/json',
      accept: 'application/json'
    }
  })

  proxyLogger.info('BedrockImage', `Generating ${novaReq.imageGenerationConfig.numberOfImages} image(s)`, {
    size: `${novaReq.imageGenerationConfig.width}x${novaReq.imageGenerationConfig.height}`,
    quality: novaReq.imageGenerationConfig.quality
  })

  const startTime = Date.now()
  const resp = await undiciFetch(signed.url, {
    method: signed.method,
    headers: signed.headers,
    body: signed.body,
    signal
  })

  if (!resp.ok) {
    const errText = await resp.text()
    proxyLogger.error('BedrockImage', `Generation failed: ${resp.status}`, { error: errText })
    throw new Error(`Nova Canvas API error (${resp.status}): ${errText}`)
  }

  const result = (await resp.json()) as NovaCanvasResponse
  const elapsed = Date.now() - startTime
  proxyLogger.info('BedrockImage', `Generated ${result.images?.length || 0} image(s) in ${elapsed}ms`)

  if (!result.images || result.images.length === 0) {
    throw new Error(result.error || 'No images generated')
  }

  const responseFormat = request.response_format || 'url'
  const data: OpenAIImageResponse['data'] = []

  for (const base64Image of result.images) {
    if (responseFormat === 'b64_json') {
      data.push({ b64_json: base64Image, revised_prompt: request.prompt })
    } else {
      const filename = imageStorage.saveImage(base64Image)
      const url = `${serverBaseUrl}/v1/images/${filename}`
      data.push({ url, revised_prompt: request.prompt })
    }
  }

  return {
    created: Math.floor(Date.now() / 1000),
    data
  }
}
