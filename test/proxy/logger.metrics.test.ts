// Phase 7, 8, 9, 10 tests: Logger enhancements, endpoint metrics, health, quota
import { describe, it, expect, beforeEach } from 'vitest'
import { endpointMetrics, generateTraceId, categorizeError } from '../../src/main/proxy/logger'

describe('Phase 7: Enhanced Logging', () => {
  describe('generateTraceId', () => {
    it('generates unique trace IDs', () => {
      const id1 = generateTraceId()
      const id2 = generateTraceId()
      expect(id1).not.toBe(id2)
      expect(id1).toMatch(/^kr-/)
    })

    it('generates IDs with expected format', () => {
      const id = generateTraceId()
      const parts = id.split('-')
      expect(parts[0]).toBe('kr')
      expect(parts.length).toBe(4)
    })
  })

  describe('categorizeError', () => {
    it('categorizes rate limit errors', () => {
      expect(categorizeError(429)).toBe('rate_limit')
    })

    it('categorizes auth errors', () => {
      expect(categorizeError(401)).toBe('auth')
      expect(categorizeError(403)).toBe('auth')
    })

    it('categorizes not found', () => {
      expect(categorizeError(404)).toBe('not_found')
    })

    it('categorizes timeout', () => {
      expect(categorizeError(408)).toBe('timeout')
      expect(categorizeError(500, 'Connection timeout')).toBe('timeout')
    })

    it('categorizes server errors', () => {
      expect(categorizeError(500)).toBe('server_error')
      expect(categorizeError(502)).toBe('server_error')
      expect(categorizeError(503)).toBe('server_error')
    })

    it('categorizes network errors', () => {
      expect(categorizeError(0, 'ECONNREFUSED')).toBe('network')
      expect(categorizeError(0, 'ECONNRESET')).toBe('network')
    })

    it('categorizes client errors', () => {
      expect(categorizeError(400)).toBe('client_error')
      expect(categorizeError(422)).toBe('client_error')
    })
  })

  describe('endpointMetrics', () => {
    beforeEach(() => {
      endpointMetrics.reset()
    })

    it('records request metrics', () => {
      endpointMetrics.record({ path: '/v1/chat/completions', status: 200, responseTime: 1500 })
      endpointMetrics.record({ path: '/v1/chat/completions', status: 200, responseTime: 2000 })
      endpointMetrics.record({ path: '/v1/chat/completions', status: 500, responseTime: 100, errorCategory: 'server_error' })

      const all = endpointMetrics.getAll()
      expect(all.length).toBe(1)

      const ep = all[0]
      expect(ep.path).toBe('/v1/chat/completions')
      expect(ep.totalRequests).toBe(3)
      expect(ep.successCount).toBe(2)
      expect(ep.errorCount).toBe(1)
      expect(ep.avgResponseTime).toBeCloseTo(1200, -1)
      expect(ep.errorCategories['server_error']).toBe(1)
    })

    it('tracks per-endpoint separately', () => {
      endpointMetrics.record({ path: '/v1/chat/completions', status: 200, responseTime: 1000 })
      endpointMetrics.record({ path: '/v1/messages', status: 200, responseTime: 2000 })

      const all = endpointMetrics.getAll()
      expect(all.length).toBe(2)
    })

    it('calculates p95 latency', () => {
      for (let i = 0; i < 100; i++) {
        endpointMetrics.record({ path: '/test', status: 200, responseTime: i * 10 })
      }
      const ep = endpointMetrics.getByPath('/test')
      expect(ep!.p95ResponseTime).toBeGreaterThan(900)
      expect(ep!.p95ResponseTime).toBeLessThanOrEqual(990)
    })

    it('tracks token counts', () => {
      endpointMetrics.record({ path: '/v1/chat/completions', status: 200, inputTokens: 100, outputTokens: 50, cacheReadTokens: 30 })
      endpointMetrics.record({ path: '/v1/chat/completions', status: 200, inputTokens: 200, outputTokens: 80, cacheReadTokens: 60 })

      const ep = endpointMetrics.getByPath('/v1/chat/completions')
      expect(ep!.totalInputTokens).toBe(300)
      expect(ep!.totalOutputTokens).toBe(130)
      expect(ep!.totalCacheReadTokens).toBe(90)
    })

    it('resets metrics', () => {
      endpointMetrics.record({ path: '/test', status: 200 })
      endpointMetrics.reset()
      expect(endpointMetrics.getAll()).toHaveLength(0)
    })
  })
})
