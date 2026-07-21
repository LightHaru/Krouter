// Phase 15: ChatGPT OAuth PKCE Flow for Free Image Generation
// Allows users to login with their ChatGPT account (free or paid) to access
// image generation via chatgpt.com/backend-api/codex/responses endpoint.

import crypto from 'crypto'
import http from 'http'
import { URL } from 'url'
import { fetch as undiciFetch } from 'undici'
import { proxyLogger } from './logger'

export interface ChatGPTOAuthConfig {
  clientId: string
  redirectPort: number
  scopes: string[]
  tokenRefreshSkewMs: number
}

export const DEFAULT_CHATGPT_OAUTH_CONFIG: ChatGPTOAuthConfig = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  redirectPort: 19836,
  scopes: ['openid', 'profile', 'email', 'offline_access'],
  tokenRefreshSkewMs: 300_000, // 5 minutes before expiry
}

export interface ChatGPTTokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
  email?: string
  plan?: string
}

export interface ChatGPTImageQuota {
  used: number
  limit: number
  resetAt: number
}

export interface ChatGPTAccountState {
  accessToken: string
  refreshToken: string
  expiresAt: number
  email?: string
  plan?: string
  imageQuota?: ChatGPTImageQuota
  lastImageGenAt?: number
  consecutiveFailures: number
}

const AUTH_BASE = 'https://auth.openai.com'
const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize`
const TOKEN_URL = `${AUTH_BASE}/oauth/token`

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url')
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url')
}

function generateState(): string {
  return crypto.randomBytes(16).toString('hex')
}

export function buildAuthorizationUrl(config: ChatGPTOAuthConfig, codeChallenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `http://localhost:${config.redirectPort}/auth/chatgpt/callback`,
    response_type: 'code',
    scope: config.scopes.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  config: ChatGPTOAuthConfig
): Promise<ChatGPTTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: config.clientId,
    redirect_uri: `http://localhost:${config.redirectPort}/auth/chatgpt/callback`,
  })

  const resp = await undiciFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Token exchange failed (${resp.status}): ${errText}`)
  }

  const data = await resp.json() as {
    access_token: string
    refresh_token: string
    expires_in: number
    id_token?: string
  }

  let email: string | undefined
  if (data.id_token) {
    try {
      const payload = JSON.parse(Buffer.from(data.id_token.split('.')[1], 'base64url').toString())
      email = payload.email
    } catch { /* ignore */ }
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    email,
  }
}

export async function refreshAccessToken(
  refreshToken: string,
  config: ChatGPTOAuthConfig
): Promise<ChatGPTTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId,
  })

  const resp = await undiciFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Token refresh failed (${resp.status}): ${errText}`)
  }

  const data = await resp.json() as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
}

export function isTokenValid(state: ChatGPTAccountState, skewMs?: number): boolean {
  const skew = skewMs ?? DEFAULT_CHATGPT_OAUTH_CONFIG.tokenRefreshSkewMs
  return state.expiresAt > Date.now() + skew
}

export interface OAuthFlowResult {
  tokens: ChatGPTTokenSet
  cleanup: () => void
}

export function startOAuthCallbackServer(
  config: ChatGPTOAuthConfig,
  codeVerifier: string,
  state: string
): Promise<OAuthFlowResult> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://localhost:${config.redirectPort}`)

      if (url.pathname !== '/auth/chatgpt/callback') {
        res.writeHead(404)
        res.end('Not Found')
        return
      }

      const receivedState = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      const error = url.searchParams.get('error')

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Login Failed</h2><p>You can close this window.</p></body></html>')
        server.close()
        reject(new Error(`OAuth error: ${error}`))
        return
      }

      if (receivedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Invalid State</h2></body></html>')
        server.close()
        reject(new Error('OAuth state mismatch'))
        return
      }

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Missing Code</h2></body></html>')
        server.close()
        reject(new Error('No authorization code received'))
        return
      }

      try {
        const tokens = await exchangeCodeForTokens(code, codeVerifier, config)
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<html><body><h2>Login Successful!</h2><p>You can close this window and return to Krouter.</p></body></html>')
        server.close()
        resolve({ tokens, cleanup: () => server.close() })
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' })
        res.end(`<html><body><h2>Error</h2><p>${(err as Error).message}</p></body></html>`)
        server.close()
        reject(err)
      }
    })

    server.listen(config.redirectPort, '127.0.0.1', () => {
      proxyLogger.info('ChatGPTOAuth', `Callback server listening on port ${config.redirectPort}`)
    })

    server.on('error', (err) => {
      reject(new Error(`Failed to start OAuth callback server: ${err.message}`))
    })

    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('OAuth flow timed out (5 minutes)'))
    }, 300_000)

    server.on('close', () => clearTimeout(timeout))
  })
}

export async function initiateOAuthFlow(config?: Partial<ChatGPTOAuthConfig>): Promise<{
  authUrl: string
  waitForCallback: Promise<OAuthFlowResult>
}> {
  const fullConfig = { ...DEFAULT_CHATGPT_OAUTH_CONFIG, ...config }
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState()

  const authUrl = buildAuthorizationUrl(fullConfig, codeChallenge, state)
  const waitForCallback = startOAuthCallbackServer(fullConfig, codeVerifier, state)

  return { authUrl, waitForCallback }
}
