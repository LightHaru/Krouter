// Phase 15 tests: ChatGPT OAuth PKCE flow
import { describe, it, expect } from 'vitest'
import {
  buildAuthorizationUrl,
  isTokenValid,
  DEFAULT_CHATGPT_OAUTH_CONFIG,
  type ChatGPTAccountState
} from '../../src/main/proxy/chatgptOAuth'

describe('Phase 15: ChatGPT OAuth', () => {
  describe('buildAuthorizationUrl', () => {
    it('builds correct URL with all parameters', () => {
      const url = buildAuthorizationUrl(
        DEFAULT_CHATGPT_OAUTH_CONFIG,
        'test-challenge-abc123',
        'state-xyz'
      )

      expect(url).toContain('https://auth.openai.com/oauth/authorize')
      expect(url).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann')
      expect(url).toContain('redirect_uri=')
      expect(url).toContain(`localhost%3A${DEFAULT_CHATGPT_OAUTH_CONFIG.redirectPort}`)
      expect(url).toContain('response_type=code')
      expect(url).toContain('code_challenge=test-challenge-abc123')
      expect(url).toContain('code_challenge_method=S256')
      expect(url).toContain('state=state-xyz')
      expect(url).toContain('scope=openid+profile+email+offline_access')
    })

    it('uses custom port from config', () => {
      const config = { ...DEFAULT_CHATGPT_OAUTH_CONFIG, redirectPort: 9999 }
      const url = buildAuthorizationUrl(config, 'challenge', 'state')
      expect(url).toContain('localhost%3A9999')
    })
  })

  describe('isTokenValid', () => {
    it('returns true when token is not expired', () => {
      const state: ChatGPTAccountState = {
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 3600_000, // 1 hour from now
        consecutiveFailures: 0,
      }
      expect(isTokenValid(state)).toBe(true)
    })

    it('returns false when token is expired', () => {
      const state: ChatGPTAccountState = {
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresAt: Date.now() - 1000, // 1 second ago
        consecutiveFailures: 0,
      }
      expect(isTokenValid(state)).toBe(false)
    })

    it('returns false when within skew period', () => {
      const state: ChatGPTAccountState = {
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 200_000, // 200s from now (within 300s skew)
        consecutiveFailures: 0,
      }
      expect(isTokenValid(state)).toBe(false)
    })

    it('respects custom skew', () => {
      const state: ChatGPTAccountState = {
        accessToken: 'token',
        refreshToken: 'refresh',
        expiresAt: Date.now() + 200_000, // 200s from now
        consecutiveFailures: 0,
      }
      // With 60s skew, 200s is still valid
      expect(isTokenValid(state, 60_000)).toBe(true)
    })
  })

  describe('DEFAULT_CHATGPT_OAUTH_CONFIG', () => {
    it('has correct default values', () => {
      expect(DEFAULT_CHATGPT_OAUTH_CONFIG.clientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
      expect(DEFAULT_CHATGPT_OAUTH_CONFIG.redirectPort).toBe(19836)
      expect(DEFAULT_CHATGPT_OAUTH_CONFIG.scopes).toContain('openid')
      expect(DEFAULT_CHATGPT_OAUTH_CONFIG.scopes).toContain('offline_access')
      expect(DEFAULT_CHATGPT_OAUTH_CONFIG.tokenRefreshSkewMs).toBe(300_000)
    })
  })
})
