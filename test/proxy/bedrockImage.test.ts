// Phase 11 tests: Nova Canvas image generation
import { describe, it, expect } from 'vitest'
import { buildNovaCanvasRequest } from '../../src/main/proxy/bedrockImage'

describe('Phase 11: Nova Canvas Image Generation', () => {
  describe('buildNovaCanvasRequest', () => {
    it('builds a basic request with defaults', () => {
      const req = buildNovaCanvasRequest({ prompt: 'A cat sitting on a table' })

      expect(req.taskType).toBe('TEXT_IMAGE')
      expect(req.textToImageParams.text).toBe('A cat sitting on a table')
      expect(req.imageGenerationConfig.numberOfImages).toBe(1)
      expect(req.imageGenerationConfig.quality).toBe('standard')
      expect(req.imageGenerationConfig.width).toBe(1024)
      expect(req.imageGenerationConfig.height).toBe(1024)
      expect(req.imageGenerationConfig.cfgScale).toBe(7.0)
    })

    it('maps HD quality to premium', () => {
      const req = buildNovaCanvasRequest({ prompt: 'test', quality: 'hd' })
      expect(req.imageGenerationConfig.quality).toBe('premium')
    })

    it('maps standard quality', () => {
      const req = buildNovaCanvasRequest({ prompt: 'test', quality: 'standard' })
      expect(req.imageGenerationConfig.quality).toBe('standard')
    })

    it('supports landscape size', () => {
      const req = buildNovaCanvasRequest({ prompt: 'test', size: '1792x1024' })
      expect(req.imageGenerationConfig.width).toBe(1792)
      expect(req.imageGenerationConfig.height).toBe(1024)
    })

    it('supports portrait size', () => {
      const req = buildNovaCanvasRequest({ prompt: 'test', size: '1024x1792' })
      expect(req.imageGenerationConfig.width).toBe(1024)
      expect(req.imageGenerationConfig.height).toBe(1792)
    })

    it('clamps n between 1 and 4', () => {
      expect(buildNovaCanvasRequest({ prompt: 'test', n: 0 }).imageGenerationConfig.numberOfImages).toBe(1)
      expect(buildNovaCanvasRequest({ prompt: 'test', n: 5 }).imageGenerationConfig.numberOfImages).toBe(4)
      expect(buildNovaCanvasRequest({ prompt: 'test', n: 3 }).imageGenerationConfig.numberOfImages).toBe(3)
    })

    it('supports negative prompt', () => {
      const req = buildNovaCanvasRequest({ prompt: 'test', negative_prompt: 'no blur' })
      expect(req.textToImageParams.negativeText).toBe('no blur')
    })

    it('supports seed', () => {
      const req = buildNovaCanvasRequest({ prompt: 'test', seed: 42 })
      expect(req.imageGenerationConfig.seed).toBe(42)
    })

    it('supports custom cfg_scale', () => {
      const req = buildNovaCanvasRequest({ prompt: 'test', cfg_scale: 3.5 })
      expect(req.imageGenerationConfig.cfgScale).toBe(3.5)
    })

    it('falls back to 1024x1024 for unknown sizes', () => {
      const req = buildNovaCanvasRequest({ prompt: 'test', size: '999x999' })
      expect(req.imageGenerationConfig.width).toBe(1024)
      expect(req.imageGenerationConfig.height).toBe(1024)
    })
  })
})
