// Phase 15 tests: ChatGPT Image Generation
import { describe, it, expect } from 'vitest'
import {
  isChatGPTImageModel,
  isBedrockImageModel,
  DEFAULT_CHATGPT_IMAGE_CONFIG
} from '../../src/main/proxy/chatgptImage'

describe('Phase 15: ChatGPT Image Generation', () => {
  describe('isChatGPTImageModel', () => {
    it('returns true for undefined model (default to ChatGPT)', () => {
      expect(isChatGPTImageModel(undefined)).toBe(true)
    })

    it('returns true for empty string', () => {
      expect(isChatGPTImageModel('')).toBe(true)
    })

    it('returns true for gpt-image', () => {
      expect(isChatGPTImageModel('gpt-image')).toBe(true)
    })

    it('returns true for gpt-image-2', () => {
      expect(isChatGPTImageModel('gpt-image-2')).toBe(true)
    })

    it('returns true for chatgpt', () => {
      expect(isChatGPTImageModel('chatgpt')).toBe(true)
    })

    it('returns true for dall-e-3', () => {
      expect(isChatGPTImageModel('dall-e-3')).toBe(true)
    })

    it('returns true for dall-e', () => {
      expect(isChatGPTImageModel('dall-e')).toBe(true)
    })

    it('returns true for gpt-5.4 (default codex model)', () => {
      expect(isChatGPTImageModel('gpt-5.4')).toBe(true)
    })

    it('returns false for nova-canvas', () => {
      expect(isChatGPTImageModel('nova-canvas')).toBe(false)
    })

    it('returns false for amazon.nova-canvas-v1:0', () => {
      expect(isChatGPTImageModel('amazon.nova-canvas-v1:0')).toBe(false)
    })
  })

  describe('isBedrockImageModel', () => {
    it('returns false for undefined model', () => {
      expect(isBedrockImageModel(undefined)).toBe(false)
    })

    it('returns true for nova-canvas', () => {
      expect(isBedrockImageModel('nova-canvas')).toBe(true)
    })

    it('returns true for amazon.nova-canvas-v1:0', () => {
      expect(isBedrockImageModel('amazon.nova-canvas-v1:0')).toBe(true)
    })

    it('returns true for stability.* models', () => {
      expect(isBedrockImageModel('stability.stable-diffusion-xl-v1')).toBe(true)
    })

    it('returns false for gpt-image', () => {
      expect(isBedrockImageModel('gpt-image')).toBe(false)
    })

    it('returns false for dall-e-3', () => {
      expect(isBedrockImageModel('dall-e-3')).toBe(false)
    })

    it('returns false for empty string', () => {
      expect(isBedrockImageModel('')).toBe(false)
    })
  })

  describe('DEFAULT_CHATGPT_IMAGE_CONFIG', () => {
    it('has correct defaults', () => {
      expect(DEFAULT_CHATGPT_IMAGE_CONFIG.enabled).toBe(true)
      expect(DEFAULT_CHATGPT_IMAGE_CONFIG.model).toBe('gpt-5.4')
      expect(DEFAULT_CHATGPT_IMAGE_CONFIG.baseUrl).toBe('https://chatgpt.com/backend-api/codex')
      expect(DEFAULT_CHATGPT_IMAGE_CONFIG.timeoutMs).toBe(120_000)
      expect(DEFAULT_CHATGPT_IMAGE_CONFIG.maxRetries).toBe(2)
    })
  })

  describe('Model routing logic', () => {
    it('default (no model) routes to ChatGPT', () => {
      expect(isChatGPTImageModel(undefined)).toBe(true)
      expect(isBedrockImageModel(undefined)).toBe(false)
    })

    it('explicit gpt-image routes to ChatGPT', () => {
      const model = 'gpt-image-2'
      expect(isChatGPTImageModel(model)).toBe(true)
      expect(isBedrockImageModel(model)).toBe(false)
    })

    it('explicit nova-canvas routes to Bedrock', () => {
      const model = 'nova-canvas'
      expect(isChatGPTImageModel(model)).toBe(false)
      expect(isBedrockImageModel(model)).toBe(true)
    })

    it('case insensitive matching', () => {
      expect(isChatGPTImageModel('GPT-IMAGE-2')).toBe(true)
      expect(isChatGPTImageModel('DALL-E-3')).toBe(true)
      expect(isBedrockImageModel('NOVA-CANVAS')).toBe(true)
      expect(isBedrockImageModel('Amazon.Nova-Canvas-v1:0')).toBe(true)
    })
  })
})
