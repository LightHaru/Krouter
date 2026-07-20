// Xpixi provider for Krouter
//
// Adds a third-party API provider alongside Kiro and Bedrock. Requests whose
// model id targets Xpixi are proxied to api.xpiki.com with the configured API key.
//
// Supports OpenAI-compatible /v1/chat/completions and /v1/responses endpoints.

import { fetch as undiciFetch } from 'undici'
import type {
  OpenAIChatRequest,
  OpenAIChatResponse
} from './types'

export interface XpixiConfig {
  /** Master switch. When false the provider is completely inert. */
  enabled: boolean
  /** Xpixi API key (sk-...) */
  apiKey?: string
  /** Base URL, defaults to https://api.xpiki.com */
  baseUrl?: string
  /**
   * Explicit list of Xpixi model ids to expose through /v1/models.
   * When empty, uses well-known kr/ prefix models.
   */
  models?: string[]
}

const DEFAULT_XPIXI_BASE_URL = 'https://api.xpiki.com'

const XPIXI_MODEL_PREFIXES = [
  'kr/',
  'notion/',
  'zm/',
  'cx/'
]

/**
 * Check if a model ID belongs to Xpixi based on config or prefix.
 */
export function isXpixiModel(modelId: string, config?: XpixiConfig): boolean {
  if (!config?.enabled) return false

  // Explicit list takes precedence
  if (config.models && config.models.length > 0) {
    return config.models.includes(modelId)
  }

  // Fallback to prefix matching
  return XPIXI_MODEL_PREFIXES.some(prefix => modelId.startsWith(prefix))
}

/**
 * Call Xpixi /v1/chat/completions endpoint.
 */
export async function callXpixi(
  request: OpenAIChatRequest,
  config: XpixiConfig,
  signal?: AbortSignal
): Promise<OpenAIChatResponse> {
  const baseUrl = config.baseUrl || DEFAULT_XPIXI_BASE_URL
  const endpoint = `${baseUrl}/v1/chat/completions`

  if (!config.apiKey) {
    throw new Error('Xpixi API key not configured')
  }

  const response = await undiciFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      top_p: request.top_p,
      max_tokens: request.max_tokens,
      stream: request.stream || false,
      tools: request.tools,
      tool_choice: request.tool_choice,
      response_format: request.response_format
    }),
    signal
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Xpixi API error ${response.status}: ${errorText}`)
  }

  return await response.json() as OpenAIChatResponse
}

/**
 * Test Xpixi credentials by calling /v1/models.
 */
export async function testXpixiCredentials(config: {
  apiKey?: string
  baseUrl?: string
}): Promise<{ success: boolean; error?: string; models?: Array<{ id: string }> }> {
  try {
    if (!config.apiKey) {
      return { success: false, error: 'API key required' }
    }

    const baseUrl = config.baseUrl || DEFAULT_XPIXI_BASE_URL
    const response = await undiciFetch(`${baseUrl}/v1/models`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${config.apiKey}`
      }
    })

    if (!response.ok) {
      const errorText = await response.text()
      return { success: false, error: `HTTP ${response.status}: ${errorText}` }
    }

    const data = await response.json() as { data?: Array<{ id: string }> }
    const models = data.data || []

    return { success: true, models }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}
