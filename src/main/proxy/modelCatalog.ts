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
  'claude-sonnet-4.5',
  'claude-sonnet-4',
  'claude-opus-4.8',
  'claude-opus-4.7',
  'claude-opus-4.5',
  'claude-haiku-4.5'
]

export const KIRO_PROXY_MODEL_PRESETS: KiroProxyModelPreset[] = [
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

export function isAutoKiroModelId(id: string): boolean {
  return normalizeKiroModelIdForCompare(id) === 'auto'
}

