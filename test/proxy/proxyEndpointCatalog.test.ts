import { describe, expect, it } from 'vitest'
import { PROXY_ENDPOINT_GROUPS } from '../../src/renderer/src/components/proxy/proxyEndpointCatalog'

describe('proxy endpoint catalog', () => {
  it('lists every critical public capability, including image generation', () => {
    const routes = new Set(PROXY_ENDPOINT_GROUPS.flatMap(group => group.endpoints.map(endpoint => `${endpoint.method} ${endpoint.path}`)))

    expect(routes.has('POST /v1/chat/completions')).toBe(true)
    expect(routes.has('POST /v1/responses')).toBe(true)
    expect(routes.has('POST /anthropic/v1/messages')).toBe(true)
    expect(routes.has('POST /v1beta/models/:model:streamGenerateContent')).toBe(true)
    expect(routes.has('POST /v1/images/generations')).toBe(true)
    expect(routes.has('GET /v1/images/:filename')).toBe(true)
    expect(routes.has('POST /mcp')).toBe(true)
    expect(routes.has('GET /health')).toBe(true)
  })

  it('does not contain duplicate method and path pairs', () => {
    const routes = PROXY_ENDPOINT_GROUPS.flatMap(group => group.endpoints.map(endpoint => `${endpoint.method} ${endpoint.path}`))
    expect(new Set(routes).size).toBe(routes.length)
  })
})
