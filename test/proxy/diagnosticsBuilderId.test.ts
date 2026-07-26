import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  placeholderProfileArn: 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX',
  callKiroApi: vi.fn(),
  fetchKiroModels: vi.fn(),
  verifyAccountCredentials: vi.fn(),
  resolveStreamingProfileArn: vi.fn()
}))
const PLACEHOLDER_PROFILE_ARN = mocks.placeholderProfileArn

vi.mock('../../src/main/proxy/kiroApi', () => ({
  callKiroApi: mocks.callKiroApi,
  fetchKiroModels: mocks.fetchKiroModels,
  isPlaceholderProfileArn: (arn?: string | null) => arn === mocks.placeholderProfileArn,
  resolveProfileArn: () => mocks.placeholderProfileArn
}))

vi.mock('../../src/main/proxy/translator', () => ({
  openaiToKiro: vi.fn((request, profileArn) => ({ request, profileArn }))
}))

vi.mock('../../src/server/services/kiroAccounts', () => ({
  refreshTokenByMethod: vi.fn(async () => ({ success: true, accessToken: 'access-refreshed' })),
  resolveStreamingProfileArn: mocks.resolveStreamingProfileArn,
  verifyAccountCredentials: mocks.verifyAccountCredentials
}))

describe('diagnoseAccountLiveness Builder ID profileArn handling', () => {
  beforeEach(() => {
    mocks.callKiroApi.mockReset()
    mocks.callKiroApi.mockResolvedValue({
      content: 'pong',
      usage: { inputTokens: 1, outputTokens: 1, credits: 0.01 }
    })
    mocks.fetchKiroModels.mockReset()
    mocks.fetchKiroModels.mockResolvedValue([
      { modelId: 'claude-sonnet-4.5', modelName: 'Claude Sonnet 4.5' },
      { modelId: 'auto', modelName: 'Auto' }
    ])
    mocks.resolveStreamingProfileArn.mockReset()
    mocks.resolveStreamingProfileArn.mockResolvedValue(undefined)
    mocks.verifyAccountCredentials.mockReset()
    mocks.verifyAccountCredentials.mockResolvedValue({
      success: true,
      data: {
        email: 'builder@example.com',
        usage: { current: 0, limit: 50 }
      }
    })
  })

  it('tries model liveness with the Builder ID placeholder profileArn and passes on pong', async () => {
    const { diagnoseAccountLiveness } = await import('../../src/server/services/diagnostics')

    const result = await diagnoseAccountLiveness({
      account: {
        id: 'builder@example.com',
        email: 'builder@example.com',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        authMethod: 'IdC',
        provider: 'BuilderId',
        profileArn: PLACEHOLDER_PROFILE_ARN,
        region: 'us-east-1'
      }
    })

    expect(mocks.callKiroApi).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.model).toBe('claude-sonnet-4.5')
    expect(result.content).toContain('pong')
  })

  it('fails model liveness on placeholder profileArn rate limit even when credential and quota check passes', async () => {
    mocks.callKiroApi.mockRejectedValueOnce(new Error('Endpoint rate limited on AmazonQ (429): {"message":"Too many requests"}'))
    const { diagnoseAccountLiveness } = await import('../../src/server/services/diagnostics')

    const result = await diagnoseAccountLiveness({
      account: {
        id: 'builder@example.com',
        email: 'builder@example.com',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        authMethod: 'IdC',
        provider: 'BuilderId',
        profileArn: PLACEHOLDER_PROFILE_ARN,
        region: 'us-east-1'
      }
    })

    expect(mocks.callKiroApi).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(false)
    expect(result.model).toBe('credential-check')
    expect(result.error).toContain('Endpoint rate limited on AmazonQ (429)')
    expect(result.error).toContain('Credential and quota check passed')
    expect(result.error).not.toContain('profileArn')
  })

  it('retries an unavailable requested model with a model available to the account', async () => {
    mocks.callKiroApi
      .mockRejectedValueOnce(new Error('API error 400: {"reason":"INVALID_MODEL_ID"}'))
      .mockResolvedValueOnce({
        content: 'pong',
        usage: { inputTokens: 1, outputTokens: 1, credits: 0.01 }
      })
    const { diagnoseAccountLiveness } = await import('../../src/server/services/diagnostics')

    const result = await diagnoseAccountLiveness({
      account: {
        id: 'builder@example.com',
        email: 'builder@example.com',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        authMethod: 'IdC',
        provider: 'BuilderId',
        profileArn: PLACEHOLDER_PROFILE_ARN,
        region: 'us-east-1'
      },
      model: 'claude-opus-4.8'
    })

    expect(mocks.callKiroApi).toHaveBeenCalledTimes(2)
    expect(mocks.fetchKiroModels).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.model).toBe('claude-sonnet-4.5')
    expect(result.content).toContain('claude-opus-4.8')
    expect(result.content).toContain('claude-sonnet-4.5')
    expect(result.content).toContain('pong')
    expect(result.content).not.toContain('profileArn')
  })
})
