export type CustomApiReasoningEffort = 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface CustomApiKeyView {
  id: string
  name: string
  apiKey: string
  enabled: boolean
  createdAt?: number
  lastTestedAt?: number
  lastError?: string
}

export interface CustomProviderView {
  id: string
  name: string
  enabled: boolean
  protocol: 'openai' | 'anthropic'
  authType?: 'bearer' | 'x-api-key'
  apiKey?: string
  baseUrl: string
  routePrefix?: string
  models?: string[]
  customHeaders?: Record<string, string>
  keys?: CustomApiKeyView[]
  reasoningEffort?: CustomApiReasoningEffort
  modelDiscoveryMode?: 'auto' | 'manual'
  modelsSyncedAt?: number
  modelsSyncError?: string
  legacy?: boolean
}

export const CUSTOM_REASONING_EFFORTS: CustomApiReasoningEffort[] = [
  'auto',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
]

export function providerKeys(provider: CustomProviderView): CustomApiKeyView[] {
  if (Array.isArray(provider.keys)) return provider.keys
  if (!provider.apiKey) return []
  return [{
    id: `${provider.id}-key-1`,
    name: 'Key 1',
    apiKey: provider.apiKey,
    enabled: true
  }]
}

export function maskCustomApiKey(key?: string): string {
  if (!key) return 'not set'
  if (key.length < 12) return `${key.slice(0, 3)}....`
  return `${key.slice(0, 6)}....${key.slice(-4)}`
}
