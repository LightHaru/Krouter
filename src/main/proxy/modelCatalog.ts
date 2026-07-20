export interface KiroProxyModelPreset {
  id: string
  name: string
  description: string
  inputTypes: string[]
  maxInputTokens: number
  maxOutputTokens: number
  modelProvider?: string
}

export const KIRO_PROXY_PREFERRED_MODEL_IDS = [
  'claude-sonnet-4.6',
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-opus-4.5',
  'claude-opus-4.1',
  'claude-haiku-4.5'
]

export const KIRO_PROXY_DEFAULT_THINKING_EFFORTS = ['low', 'medium', 'high', 'max']

export const KIRO_PROXY_MODEL_PRESETS: KiroProxyModelPreset[] = [
  {
    id: 'claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    description: 'Claude Sonnet 4.6 (premium; routed to Bedrock when Kiro pool lacks it)',
    inputTypes: ['TEXT', 'IMAGE'],
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    modelProvider: 'anthropic'
  },
  {
    id: 'claude-sonnet-4.5',
    name: 'Claude Sonnet 4.5',
    description: 'Claude Sonnet 4.5 for Kiro coding and agent tasks',
    inputTypes: ['TEXT', 'IMAGE'],
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    modelProvider: 'anthropic'
  },
  {
    id: 'claude-sonnet-4',
    name: 'Claude Sonnet 4',
    description: 'Claude Sonnet 4 for Kiro coding and reasoning',
    inputTypes: ['TEXT', 'IMAGE'],
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    modelProvider: 'anthropic'
  },
  {
    id: 'claude-opus-4.8',
    name: 'Claude Opus 4.8',
    description: 'Claude Opus 4.8 for Kiro Power accounts',
    inputTypes: ['TEXT', 'IMAGE'],
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    modelProvider: 'anthropic'
  },
  {
    id: 'claude-opus-4.7',
    name: 'Claude Opus 4.7',
    description: 'Claude Opus 4.7 for Kiro Power accounts',
    inputTypes: ['TEXT', 'IMAGE'],
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    modelProvider: 'anthropic'
  },
  {
    id: 'claude-opus-4.5',
    name: 'Claude Opus 4.5',
    description: 'Claude Opus 4.5 for Kiro Power accounts',
    inputTypes: ['TEXT', 'IMAGE'],
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    modelProvider: 'anthropic'
  },
  {
    id: 'claude-opus-4.1',
    name: 'Claude Opus 4.1',
    description: 'Claude Opus 4.1 (premium; routed to Bedrock when Kiro pool lacks it)',
    inputTypes: ['TEXT', 'IMAGE'],
    maxInputTokens: 200000,
    maxOutputTokens: 32000,
    modelProvider: 'anthropic'
  },
  {
    id: 'claude-haiku-4.5',
    name: 'Claude Haiku 4.5',
    description: 'Claude Haiku 4.5 for fast Kiro tasks',
    inputTypes: ['TEXT', 'IMAGE'],
    maxInputTokens: 200000,
    maxOutputTokens: 64000,
    modelProvider: 'anthropic'
  }
]

export function normalizeKiroModelIdForCompare(id: string): string {
  return id.trim().toLowerCase().replace(/^(claude-(?:sonnet|haiku|opus)-\d+)-(\d+)(.*)$/u, '$1.$2$3')
}

export function kiroProxyModelSupportsThinking(modelId: string): boolean {
  const lower = modelId.trim().toLowerCase().replace(/_/g, '-')
  if (!lower || lower === 'auto') return false
  if (!lower.includes('claude')) return false
  if (lower.includes('claude-3-') || lower.includes('claude-3.')) return false

  const normalized = normalizeKiroModelIdForCompare(lower)
  return /^claude-(?:sonnet|haiku|opus)-[4-9](?:[.-]|$)/u.test(normalized)
}

export function isAutoKiroModelId(id: string): boolean {
  return normalizeKiroModelIdForCompare(id) === 'auto'
}

// ============ Tier-based routing ============
import type { KiroTier, TierEligibilityRule } from './types'

/** Paid Kiro tiers (mọi tier trừ free/unknown). */
export const PAID_KIRO_TIERS: ReadonlySet<KiroTier> = new Set<KiroTier>([
  'pro',
  'pro_plus',
  'power',
  'enterprise',
  'teams'
])

/**
 * Chuẩn hóa một chuỗi subscriptionType/title bất kỳ về KiroTier.
 * Nhận cả biến thể: 'Pro+', 'Pro Plus', 'PRO_PLUS', 'KIRO POWER', 'Q_DEVELOPER_STANDALONE_FREE'...
 */
export function normalizeKiroTier(raw?: string | null): KiroTier {
  if (!raw) return 'unknown'
  // '+' nghĩa là "plus" (Pro+), phải chuyển thành 'plus' TRƯỚC khi gộp separator.
  const key = raw.trim().toLowerCase().replace(/\+/g, 'plus').replace(/[\s-]+/g, '_')
  if (!key) return 'unknown'
  if (key.includes('pro_plus') || key.includes('proplus')) return 'pro_plus'
  if (key.includes('power')) return 'power'
  if (key.includes('enterprise')) return 'enterprise'
  if (key.includes('teams') || key.includes('team')) return 'teams'
  if (key.includes('pro')) return 'pro'
  if (key.includes('free')) return 'free'
  return 'unknown'
}

/** True khi tier là paid (mở khóa premium model). */
export function isPaidKiroTier(tier: KiroTier): boolean {
  return PAID_KIRO_TIERS.has(tier)
}

/**
 * Tier_Eligibility_Map mặc định. Model premium chỉ paid tier phục vụ; còn lại standard.
 * Danh sách premium suy ra từ các model chỉ tier cao mới có trên Kiro (Opus family,
 * Sonnet 4.6, và một số model bên thứ ba định tuyến qua Kiro). Có thể override qua
 * ProxyConfig.tierEligibilityMap.
 */
const ALL_PAID: KiroTier[] = ['pro', 'pro_plus', 'power', 'enterprise', 'teams']

export const DEFAULT_TIER_ELIGIBILITY_MAP: TierEligibilityRule[] = [
  { modelPattern: 'claude-opus-*', class: 'premium', allowedTiers: ALL_PAID },
  { modelPattern: 'claude-sonnet-4.6', class: 'premium', allowedTiers: ALL_PAID },
  { modelPattern: 'deepseek-3.2', class: 'premium', allowedTiers: ALL_PAID },
  { modelPattern: 'qwen3-coder-next', class: 'premium', allowedTiers: ALL_PAID },
  { modelPattern: 'glm-5', class: 'premium', allowedTiers: ALL_PAID },
  { modelPattern: 'minimax-*', class: 'premium', allowedTiers: ALL_PAID }
]

/** Khớp một modelId (đã normalize) với một rule pattern (hỗ trợ hậu tố '*'). */
export function matchesModelPattern(normalizedModelId: string, pattern: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase()
  if (normalizedPattern.endsWith('*')) {
    return normalizedModelId.startsWith(normalizedPattern.slice(0, -1))
  }
  return normalizedModelId === normalizedPattern
}
