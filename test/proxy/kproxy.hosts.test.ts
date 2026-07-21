// Phase 12 tests: MITM hosts manager and model mapper
import { describe, it, expect } from 'vitest'
import { HostsManager } from '../../src/main/kproxy/hostsManager'
import { ModelMapper } from '../../src/main/kproxy/modelMapper'

describe('Phase 12: MITM Integration', () => {
  describe('HostsManager', () => {
    it('provides default DNS entries', () => {
      const mgr = new HostsManager()
      const entries = mgr.getDefaultEntries()

      expect(entries.length).toBeGreaterThanOrEqual(4)
      expect(entries.every(e => e.ip === '127.0.0.1')).toBe(true)

      const hostnames = entries.map(e => e.hostname)
      expect(hostnames).toContain('runtime.us-east-1.kiro.dev')
      expect(hostnames).toContain('api.individual.githubcopilot.com')
      expect(hostnames).toContain('daily-cloudcode-pa.googleapis.com')
    })

    it('entries have ideType classification', () => {
      const mgr = new HostsManager()
      const entries = mgr.getDefaultEntries()

      const kiroEntries = entries.filter(e => e.ideType === 'kiro')
      const copilotEntries = entries.filter(e => e.ideType === 'copilot')
      const antigravityEntries = entries.filter(e => e.ideType === 'antigravity')

      expect(kiroEntries.length).toBeGreaterThanOrEqual(2)
      expect(copilotEntries.length).toBeGreaterThanOrEqual(1)
      expect(antigravityEntries.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('ModelMapper', () => {
    it('maps Kiro IDE models', () => {
      const mapper = new ModelMapper()
      expect(mapper.mapModel('anthropic.claude-sonnet-4-6-v1', 'kiro')).toBe('claude-sonnet-4-6')
      expect(mapper.mapModel('anthropic.claude-opus-4-6-v1', 'kiro')).toBe('claude-opus-4-6')
    })

    it('maps Copilot models', () => {
      const mapper = new ModelMapper()
      expect(mapper.mapModel('gpt-4o', 'copilot')).toBe('claude-sonnet-4-6')
      expect(mapper.mapModel('gpt-4o-mini', 'copilot')).toBe('claude-sonnet-4-6')
    })

    it('maps Antigravity models with synonym normalization', () => {
      const mapper = new ModelMapper()
      // gemini-3.5-flash-high → synonym → gemini-3-flash-agent → claude-sonnet-4-6
      expect(mapper.mapModel('gemini-3.5-flash-high', 'antigravity')).toBe('claude-sonnet-4-6')
    })

    it('returns null for unknown models', () => {
      const mapper = new ModelMapper()
      expect(mapper.mapModel('totally-unknown-model')).toBeNull()
    })

    it('returns null for no-map models (tab autocomplete)', () => {
      const mapper = new ModelMapper()
      expect(mapper.mapModel('tab_flash_lite_preview', 'antigravity')).toBeNull()
    })

    it('provides default mappings', () => {
      const mapper = new ModelMapper()
      const defaults = mapper.getDefaults()
      expect(defaults.length).toBeGreaterThanOrEqual(5)
    })

    it('returns all mappings', () => {
      const mapper = new ModelMapper()
      const mappings = mapper.getMappings()
      expect(mappings.length).toBeGreaterThanOrEqual(5)
      expect(mappings[0]).toHaveProperty('ideModel')
      expect(mappings[0]).toHaveProperty('krouterModel')
      expect(mappings[0]).toHaveProperty('ideType')
    })
  })
})
