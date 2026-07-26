// Phase 15 tests: ChatGPT OAuth PKCE flow
import { describe, it, expect } from 'vitest'
import net from 'node:net'
import {
  buildAuthorizationUrl,
  decodeIdToken,
  initiateOAuthFlow,
  isTokenValid,
  parseOAuthCallbackUrl,
  renderOAuthCallbackPage,
  startOAuthCallbackServer,
  DEFAULT_CHATGPT_OAUTH_CONFIG,
  type ChatGPTAccountState
} from '../../src/main/proxy/chatgptOAuth'

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Unable to allocate test port'))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

function account(overrides: Partial<ChatGPTAccountState> = {}): ChatGPTAccountState {
  const now = Date.now()
  return {
    id: 'chatgpt-test',
    accessToken: 'token',
    refreshToken: 'refresh',
    expiresAt: now + 3600_000,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides
  }
}

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
      expect(url).toContain('%2Fauth%2Fcallback')
      expect(url).toContain('response_type=code')
      expect(url).toContain('code_challenge=test-challenge-abc123')
      expect(url).toContain('code_challenge_method=S256')
      expect(url).toContain('state=state-xyz')
      expect(url).toContain('scope=openid+profile+email+offline_access')
      expect(url).toContain('id_token_add_organizations=true')
      expect(url).toContain('codex_cli_simplified_flow=true')
      expect(url).toContain('originator=codex_cli_rs')
    })

    it('uses custom port from config', () => {
      const config = { ...DEFAULT_CHATGPT_OAUTH_CONFIG, redirectPort: 9999 }
      const url = buildAuthorizationUrl(config, 'challenge', 'state')
      expect(url).toContain('localhost%3A9999')
    })
  })

  describe('isTokenValid', () => {
    it('returns true when token is not expired', () => {
      const state = account()
      expect(isTokenValid(state)).toBe(true)
    })

    it('returns false when token is expired', () => {
      const state = account({ expiresAt: Date.now() - 1000 })
      expect(isTokenValid(state)).toBe(false)
    })

    it('returns false when within skew period', () => {
      const state = account({ expiresAt: Date.now() + 200_000 })
      expect(isTokenValid(state)).toBe(false)
    })

    it('respects custom skew', () => {
      const state = account({ expiresAt: Date.now() + 200_000 })
      // With 60s skew, 200s is still valid
      expect(isTokenValid(state, 60_000)).toBe(true)
    })
  })

  describe('decodeIdToken', () => {
    it('reads current Codex identity claims used for backend requests', () => {
      const payload = Buffer.from(JSON.stringify({
        profile: { email: 'profile@example.com' },
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'pro',
          chatgpt_account_id: 'workspace-456',
          chatgpt_account_is_fedramp: true
        }
      })).toString('base64url')

      expect(decodeIdToken(`header.${payload}.signature`)).toEqual({
        email: 'profile@example.com',
        plan: 'pro',
        accountId: 'workspace-456',
        isFedRAMP: true
      })
    })
  })

  describe('OAuth callback lifecycle', () => {
    it('completes a manual VPS callback without opening a localhost listener', async () => {
      const config = { ...DEFAULT_CHATGPT_OAUTH_CONFIG, redirectPort: await getFreePort() }
      const flow = await initiateOAuthFlow(config, {
        mode: 'manual',
        exchange: async (code, verifier) => ({
          accessToken: `${code}-access`,
          refreshToken: `${verifier}-refresh`,
          expiresAt: Date.now() + 3600_000
        })
      })
      const auth = new URL(flow.authUrl)
      const state = auth.searchParams.get('state')

      expect(flow.mode).toBe('manual')
      expect(flow.submitCallbackUrl).toBeTypeOf('function')
      await flow.submitCallbackUrl!(`http://localhost:${config.redirectPort}/auth/callback?code=manual-code&state=${state}`)
      const result = await flow.waitForCallback
      expect(result.tokens.accessToken).toBe('manual-code-access')
    })

    it('rejects mismatched, malformed and reused manual callbacks', async () => {
      const config = { ...DEFAULT_CHATGPT_OAUTH_CONFIG, redirectPort: await getFreePort() }
      const flow = await initiateOAuthFlow(config, { mode: 'manual' })
      const rejected = expect(flow.waitForCallback).rejects.toThrow('OAuth state mismatch')
      await expect(flow.submitCallbackUrl!(
        `http://localhost:${config.redirectPort}/auth/callback?code=secret-code&state=wrong`
      )).rejects.toThrow('OAuth state mismatch')
      await rejected
      await expect(flow.submitCallbackUrl!(
        `http://localhost:${config.redirectPort}/auth/callback?code=secret-code&state=wrong`
      )).rejects.toThrow('no longer active')
    })

    it('requires the callback URL to match the exact session redirect URI', () => {
      expect(() => parseOAuthCallbackUrl(
        'http://127.0.0.1:1455/auth/callback?code=x&state=s',
        'http://localhost:1455/auth/callback',
        's'
      )).toThrow('does not match')
      expect(() => parseOAuthCallbackUrl(
        'http://localhost:1455/wrong?code=x&state=s',
        'http://localhost:1455/auth/callback',
        's'
      )).toThrow('does not match')
    })

    it('exchanges a valid callback and never renders tokens in the browser response', async () => {
      const config = { ...DEFAULT_CHATGPT_OAUTH_CONFIG, redirectPort: await getFreePort() }
      const calls: Array<{ code: string; verifier: string }> = []
      const handle = startOAuthCallbackServer(config, 'verifier-secret', 'state-secret', async (code, verifier) => {
        calls.push({ code, verifier })
        return {
          accessToken: 'access-secret',
          refreshToken: 'refresh-secret',
          expiresAt: Date.now() + 3600_000,
          email: 'owner@example.com',
          plan: 'plus',
          accountId: 'workspace-123'
        }
      })
      await handle.ready

      const response = await fetch(`http://127.0.0.1:${config.redirectPort}/auth/callback?code=valid-code&state=state-secret`)
      const html = await response.text()
      const result = await handle.waitForCallback

      expect(response.status).toBe(200)
      expect(calls).toEqual([{ code: 'valid-code', verifier: 'verifier-secret' }])
      expect(result.tokens.email).toBe('owner@example.com')
      expect(result.tokens.accountId).toBe('workspace-123')
      expect(html).toContain('ChatGPT is connected.')
      expect(html).toContain('CONNECTION SECURED')
      expect(html).toContain("history.replaceState")
      expect(response.headers.get('cache-control')).toContain('no-store')
      expect(response.headers.get('referrer-policy')).toBe('no-referrer')
      expect(html).not.toContain('access-secret')
      expect(html).not.toContain('refresh-secret')
      expect(html).not.toContain('valid-code')
      expect(html).not.toContain('state-secret')
    })

    it('rejects a callback with a mismatched state', async () => {
      const config = { ...DEFAULT_CHATGPT_OAUTH_CONFIG, redirectPort: await getFreePort() }
      const handle = startOAuthCallbackServer(config, 'verifier', 'expected-state')
      const rejected = expect(handle.waitForCallback).rejects.toThrow('OAuth state mismatch')
      await handle.ready

      const response = await fetch(`http://127.0.0.1:${config.redirectPort}/auth/callback?code=code&state=wrong-state`)
      expect(response.status).toBe(400)
      await rejected
    })

    it('keeps waiting after unsupported methods and can be cancelled cleanly', async () => {
      const config = { ...DEFAULT_CHATGPT_OAUTH_CONFIG, redirectPort: await getFreePort() }
      const handle = startOAuthCallbackServer(config, 'verifier', 'state')
      const rejected = expect(handle.waitForCallback).rejects.toThrow('test cancellation')
      await handle.ready

      const response = await fetch(`http://127.0.0.1:${config.redirectPort}/auth/callback`, { method: 'POST' })
      expect(response.status).toBe(405)
      handle.cancel('test cancellation')
      await rejected
    })

    it('falls back to a second callback port when the preferred port is occupied', async () => {
      const preferredPort = await getFreePort()
      const fallbackPort = await getFreePort()
      const blocker = net.createServer()
      await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject)
        blocker.listen(preferredPort, '127.0.0.1', resolve)
      })

      try {
        const flow = await initiateOAuthFlow({ redirectPort: preferredPort, fallbackRedirectPort: fallbackPort })
        const rejected = expect(flow.waitForCallback).rejects.toThrow('test fallback cancellation')
        expect(new URL(flow.authUrl).searchParams.get('redirect_uri')).toBe(`http://localhost:${fallbackPort}/auth/callback`)
        flow.cancel('test fallback cancellation')
        await rejected
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()))
      }
    })
  })

  describe('OAuth callback page', () => {
    it('renders a branded responsive success page without external resources', () => {
      const html = renderOAuthCallbackPage('success')
      expect(html).toContain('KROUTER / CHATGPT')
      expect(html).toContain('@media (max-width: 650px)')
      expect(html).toContain('CLOSE THIS TAB')
      expect(html).not.toContain('http://')
      expect(html).not.toContain('https://')
    })
  })

  describe('DEFAULT_CHATGPT_OAUTH_CONFIG', () => {
    it('has correct default values', () => {
      expect(DEFAULT_CHATGPT_OAUTH_CONFIG.clientId).toBe('app_EMoamEEZ73f0CkXaXp7hrann')
      expect(DEFAULT_CHATGPT_OAUTH_CONFIG.redirectPort).toBe(1455)
      expect(DEFAULT_CHATGPT_OAUTH_CONFIG.fallbackRedirectPort).toBe(1457)
      expect(DEFAULT_CHATGPT_OAUTH_CONFIG.scopes).toContain('openid')
      expect(DEFAULT_CHATGPT_OAUTH_CONFIG.scopes).toContain('offline_access')
      expect(DEFAULT_CHATGPT_OAUTH_CONFIG.tokenRefreshSkewMs).toBe(300_000)
    })
  })
})
