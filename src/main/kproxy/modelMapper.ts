import * as fs from 'fs'
import * as path from 'path'
import { getRuntimeUserDataPath } from '../runtimePaths'

export type IdeType = 'kiro' | 'copilot' | 'antigravity' | 'cursor' | 'custom'

export interface ModelMapping {
  ideModel: string
  krouterModel: string
  ideType: IdeType
  enabled: boolean
}

// Synonym map: normalize IDE model names to canonical keys before lookup
const MODEL_SYNONYMS: Record<string, Record<string, string>> = {
  antigravity: {
    'gemini-default': 'gemini-3.5-flash-low',
    'gemini-3.5-flash-high': 'gemini-3-flash-agent',
    'gemini-3.5-flash-medium': 'gemini-3.5-flash-low',
    'gemini-3.5-flash-extra-low': 'gemini-3.5-flash-extra-low',
    'gemini-3.1-pro-high': 'gemini-pro-agent',
    'gemini-3-pro-high': 'gemini-pro-agent',
    'gemini-3-pro-low': 'gemini-3.1-pro-low',
  }
}

// Pattern fallback: catches renamed variants when exact + synonym + prefix fail
const MODEL_PATTERNS: Record<string, { match: RegExp; alias: string }[]> = {
  antigravity: [
    { match: /flash.*extra.*low|extra.*low.*flash|flash.*low|low.*flash/i, alias: 'gemini-3.5-flash-extra-low' },
    { match: /flash.*medium|medium.*flash/i, alias: 'gemini-3.5-flash-low' },
    { match: /flash.*agent|agent.*flash|flash/i, alias: 'gemini-3-flash-agent' },
    { match: /pro.*low|low.*pro/i, alias: 'gemini-3.1-pro-low' },
    { match: /gemini.*pro|pro.*gemini/i, alias: 'gemini-pro-agent' },
    { match: /opus/i, alias: 'claude-opus-4-6-thinking' },
    { match: /sonnet|claude/i, alias: 'claude-sonnet-4-6' },
  ]
}

// Models that must NEVER be remapped (latency-critical autocomplete)
const MODEL_NO_MAP: Record<string, RegExp[]> = {
  antigravity: [/^tab[_-]/i]
}

// Default mappings per IDE - map IDE model name to Krouter's proxy model name
const DEFAULT_MAPPINGS: ModelMapping[] = [
  // Kiro IDE (CodeWhisperer models → Krouter models)
  { ideModel: 'claude-sonnet-4-6', krouterModel: 'claude-sonnet-4-6', ideType: 'kiro', enabled: true },
  { ideModel: 'claude-opus-4-6', krouterModel: 'claude-opus-4-6', ideType: 'kiro', enabled: true },
  { ideModel: 'anthropic.claude-sonnet-4-6-v1', krouterModel: 'claude-sonnet-4-6', ideType: 'kiro', enabled: true },
  { ideModel: 'anthropic.claude-opus-4-6-v1', krouterModel: 'claude-opus-4-6', ideType: 'kiro', enabled: true },
  { ideModel: 'us.anthropic.claude-sonnet-4-6-v1:0', krouterModel: 'claude-sonnet-4-6', ideType: 'kiro', enabled: true },
  { ideModel: 'us.anthropic.claude-opus-4-6-v1:0', krouterModel: 'claude-opus-4-6', ideType: 'kiro', enabled: true },

  // GitHub Copilot (OpenAI-style model names)
  { ideModel: 'gpt-4o', krouterModel: 'claude-sonnet-4-6', ideType: 'copilot', enabled: true },
  { ideModel: 'gpt-4o-mini', krouterModel: 'claude-sonnet-4-6', ideType: 'copilot', enabled: true },
  { ideModel: 'gpt-4-turbo', krouterModel: 'claude-sonnet-4-6', ideType: 'copilot', enabled: true },
  { ideModel: 'claude-3.5-sonnet', krouterModel: 'claude-sonnet-4-6', ideType: 'copilot', enabled: true },
  { ideModel: 'claude-sonnet-4', krouterModel: 'claude-sonnet-4-6', ideType: 'copilot', enabled: true },
  { ideModel: 'o1-mini', krouterModel: 'claude-sonnet-4-6', ideType: 'copilot', enabled: true },
  { ideModel: 'o1-preview', krouterModel: 'claude-opus-4-6', ideType: 'copilot', enabled: true },

  // Antigravity (Google Cloud Code / Gemini - matched after synonym normalization)
  { ideModel: 'gemini-3-flash-agent', krouterModel: 'claude-sonnet-4-6', ideType: 'antigravity', enabled: true },
  { ideModel: 'gemini-3.5-flash-low', krouterModel: 'claude-sonnet-4-6', ideType: 'antigravity', enabled: true },
  { ideModel: 'gemini-3.5-flash-extra-low', krouterModel: 'claude-sonnet-4-6', ideType: 'antigravity', enabled: true },
  { ideModel: 'gemini-pro-agent', krouterModel: 'claude-opus-4-6', ideType: 'antigravity', enabled: true },
  { ideModel: 'gemini-3.1-pro-low', krouterModel: 'claude-sonnet-4-6', ideType: 'antigravity', enabled: true },
]

export class ModelMapper {
  private mappings: ModelMapping[]
  private configPath: string

  constructor() {
    this.configPath = path.join(getRuntimeUserDataPath(), 'model-mappings.json')
    this.mappings = this.load()
  }

  private load(): ModelMapping[] {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = JSON.parse(fs.readFileSync(this.configPath, 'utf8'))
        if (Array.isArray(data.mappings)) return data.mappings
      }
    } catch { /* use defaults */ }
    return [...DEFAULT_MAPPINGS]
  }

  save(): void {
    const dir = path.dirname(this.configPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(this.configPath, JSON.stringify({ mappings: this.mappings }, null, 2))
  }

  mapModel(ideModel: string, ideType?: IdeType): string | null {
    if (!ideModel) return null
    const normalizedModel = ideModel.replace(/^models\//, '')

    // Apply synonym normalization for the IDE type
    const synonyms = ideType ? MODEL_SYNONYMS[ideType] : undefined
    const lookup = synonyms?.[normalizedModel] || normalizedModel

    // Check if model should never be remapped
    if (ideType && MODEL_NO_MAP[ideType]?.some(re => re.test(lookup))) {
      return null
    }

    // Exact match
    const exactMatch = this.mappings.find(m => m.enabled && m.ideModel === lookup && (!ideType || m.ideType === ideType))
    if (exactMatch) return exactMatch.krouterModel

    // Prefix match
    const prefixMatch = this.mappings.find(m =>
      m.enabled && (!ideType || m.ideType === ideType) &&
      (lookup.startsWith(m.ideModel) || m.ideModel.startsWith(lookup))
    )
    if (prefixMatch) return prefixMatch.krouterModel

    // Pattern fallback (per IDE type)
    if (ideType) {
      const patterns = MODEL_PATTERNS[ideType] || []
      for (const { match, alias } of patterns) {
        if (match.test(lookup)) {
          const aliasMapping = this.mappings.find(m => m.enabled && m.ideModel === alias && m.ideType === ideType)
          if (aliasMapping) return aliasMapping.krouterModel
        }
      }
    }

    // Global fallback (any IDE type)
    const globalMatch = this.mappings.find(m => m.enabled && m.ideModel === lookup)
    if (globalMatch) return globalMatch.krouterModel

    return null
  }

  getMappings(): ModelMapping[] {
    return [...this.mappings]
  }

  setMappings(mappings: ModelMapping[]): void {
    this.mappings = mappings
    this.save()
  }

  addMapping(mapping: ModelMapping): void {
    this.mappings.push(mapping)
    this.save()
  }

  removeMapping(ideModel: string): void {
    this.mappings = this.mappings.filter(m => m.ideModel !== ideModel)
    this.save()
  }

  getDefaults(): ModelMapping[] {
    return [...DEFAULT_MAPPINGS]
  }
}

export const modelMapper = new ModelMapper()
