// ChatGPT/Codex OAuth PKCE flow shared by text and image routes.

import crypto from 'crypto'
import http from 'http'
import { URL } from 'url'
import { fetch as undiciFetch } from 'undici'
import { proxyLogger } from './logger'

export interface ChatGPTOAuthConfig {
  clientId: string
  redirectPort: number
  fallbackRedirectPort?: number
  scopes: string[]
  tokenRefreshSkewMs: number
}

export const DEFAULT_CHATGPT_OAUTH_CONFIG: ChatGPTOAuthConfig = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  redirectPort: 1455,
  fallbackRedirectPort: 1457,
  scopes: [
    'openid',
    'profile',
    'email',
    'offline_access',
    'api.connectors.read',
    'api.connectors.invoke'
  ],
  tokenRefreshSkewMs: 300_000 // 5 minutes before expiry
}

export interface ChatGPTTokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number
  email?: string
  plan?: string
  accountId?: string
  isFedRAMP?: boolean
}

export interface ChatGPTImageQuota {
  used: number
  limit: number
  resetAt: number
}

export interface ChatGPTAccountState {
  id: string
  accessToken: string
  refreshToken: string
  expiresAt: number
  email?: string
  plan?: string
  accountId?: string
  isFedRAMP?: boolean
  imageQuota?: ChatGPTImageQuota
  quotaWindows?: ChatGPTQuotaWindow[]
  quotaSyncedAt?: number
  quotaError?: string
  modelAvailability?: Record<string, 'unverified' | 'available' | 'unavailable'>
  localUsage?: {
    requests: number
    inputTokens: number
    outputTokens: number
    lastRequestAt?: number
  }
  lastRefreshAt?: number
  lastError?: string
  lastImageGenAt?: number
  consecutiveFailures: number
  createdAt: number
  updatedAt: number
}

export interface ChatGPTQuotaWindow {
  key: string
  label: string
  usedPercent?: number
  remainingPercent?: number
  resetAt?: number
  limitWindowSeconds?: number
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
  return crypto.randomBytes(32).toString('base64url')
}

export function decodeIdToken(idToken?: string): {
  email?: string
  plan?: string
  accountId?: string
  isFedRAMP?: boolean
} {
  if (!idToken) return {}
  try {
    const part = idToken.split('.')[1]
    if (!part) return {}
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>
    const auth = payload['https://api.openai.com/auth'] as Record<string, unknown> | undefined
    return {
      email:
        typeof payload.email === 'string'
          ? payload.email
          : typeof (payload.profile as Record<string, unknown> | undefined)?.email === 'string'
            ? ((payload.profile as Record<string, unknown>).email as string)
            : undefined,
      plan:
        typeof auth?.chatgpt_plan_type === 'string'
          ? auth.chatgpt_plan_type
          : typeof payload.plan === 'string'
            ? payload.plan
            : undefined,
      accountId: typeof auth?.chatgpt_account_id === 'string' ? auth.chatgpt_account_id : undefined,
      isFedRAMP: auth?.chatgpt_account_is_fedramp === true
    }
  } catch {
    return {}
  }
}

export function buildAuthorizationUrl(
  config: ChatGPTOAuthConfig,
  codeChallenge: string,
  state: string
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `http://localhost:${config.redirectPort}/auth/callback`,
    response_type: 'code',
    scope: config.scopes.join(' '),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs'
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
    redirect_uri: `http://localhost:${config.redirectPort}/auth/callback`
  })

  const resp = await undiciFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Token exchange failed (${resp.status}): ${errText}`)
  }

  const data = (await resp.json()) as {
    access_token: string
    refresh_token: string
    expires_in: number
    id_token?: string
  }
  if (!data.access_token || !data.refresh_token || !Number.isFinite(data.expires_in)) {
    throw new Error('Token exchange returned an incomplete token set')
  }
  const identity = decodeIdToken(data.id_token)

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    email: identity.email,
    plan: identity.plan,
    accountId: identity.accountId,
    isFedRAMP: identity.isFedRAMP
  }
}

export async function refreshAccessToken(
  refreshToken: string,
  config: ChatGPTOAuthConfig
): Promise<ChatGPTTokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.clientId
  })

  const resp = await undiciFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Token refresh failed (${resp.status}): ${errText}`)
  }

  const data = (await resp.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }
  if (!data.access_token || !Number.isFinite(data.expires_in)) {
    throw new Error('Token refresh returned an incomplete token set')
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000
  }
}

export function isTokenValid(state: ChatGPTAccountState, skewMs?: number): boolean {
  const skew = skewMs ?? DEFAULT_CHATGPT_OAUTH_CONFIG.tokenRefreshSkewMs
  return state.expiresAt > Date.now() + skew
}

export interface OAuthFlowResult {
  tokens: ChatGPTTokenSet
}

export interface OAuthCallbackHandle {
  ready: Promise<void>
  waitForCallback: Promise<OAuthFlowResult>
  cancel: (reason?: string) => void
}

export type OAuthFlowMode = 'local' | 'manual'

export interface OAuthFlow {
  flowId: string
  mode: OAuthFlowMode
  authUrl: string
  redirectUri: string
  expiresAt: number
  waitForCallback: Promise<OAuthFlowResult>
  submitCallbackUrl?: (callbackUrl: string) => Promise<OAuthFlowResult>
  cancel: (reason?: string) => void
}

type TokenExchange = typeof exchangeCodeForTokens

const OAUTH_FLOW_TTL_MS = 5 * 60_000

export function parseOAuthCallbackUrl(
  callbackUrl: string,
  redirectUri: string,
  expectedState: string
): { code: string } {
  let parsed: URL
  let expected: URL
  try {
    parsed = new URL(callbackUrl.trim())
    expected = new URL(redirectUri)
  } catch {
    throw new Error('Callback URL is invalid')
  }

  if (
    parsed.protocol !== expected.protocol ||
    parsed.hostname !== expected.hostname ||
    parsed.port !== expected.port ||
    parsed.pathname !== expected.pathname
  ) {
    throw new Error('Callback URL does not match this OAuth session')
  }

  const upstreamError = parsed.searchParams.get('error')
  if (upstreamError) throw new Error(`OAuth error: ${upstreamError}`)
  if (parsed.searchParams.get('state') !== expectedState) throw new Error('OAuth state mismatch')

  const code = parsed.searchParams.get('code')
  if (!code) throw new Error('No authorization code received')
  return { code }
}

type OAuthCallbackPage = 'success' | 'denied' | 'invalid' | 'missing' | 'exchange'

const CALLBACK_PAGE_COPY: Record<
  OAuthCallbackPage,
  { eyebrow: string; title: string; message: string; detail: string }
> = {
  success: {
    eyebrow: 'CONNECTION SECURED',
    title: 'ChatGPT is connected.',
    message: 'Your image gateway is ready inside Krouter.',
    detail:
      'The authorization was exchanged locally. Your access token was never rendered in this browser page.'
  },
  denied: {
    eyebrow: 'AUTHORIZATION CANCELLED',
    title: 'Connection was not approved.',
    message: 'Nothing was changed in Krouter.',
    detail: 'You can close this tab and start the ChatGPT connection again whenever you are ready.'
  },
  invalid: {
    eyebrow: 'SECURITY CHECK FAILED',
    title: 'This callback is not valid.',
    message: 'Krouter stopped the sign-in to protect your session.',
    detail: 'Close this tab, return to Krouter, and begin a fresh authorization request.'
  },
  missing: {
    eyebrow: 'INCOMPLETE CALLBACK',
    title: 'Authorization code missing.',
    message: 'ChatGPT did not return the information Krouter needs.',
    detail: 'Close this tab and retry the connection from the Krouter dashboard.'
  },
  exchange: {
    eyebrow: 'CONNECTION INTERRUPTED',
    title: 'ChatGPT could not be connected.',
    message: 'Krouter could not finish the secure token exchange.',
    detail: 'Return to Krouter for the diagnostic details, then retry the connection.'
  }
}

export function renderOAuthCallbackPage(page: OAuthCallbackPage): string {
  const copy = CALLBACK_PAGE_COPY[page]
  const successful = page === 'success'
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${successful ? 'ChatGPT connected' : 'ChatGPT connection interrupted'} | Krouter</title>
  <style>
    :root { color-scheme: dark; --ink: #f4f1e8; --muted: #a9b5ac; --panel: rgba(9, 24, 20, .82); --line: rgba(194, 225, 205, .15); --accent: ${successful ? '#7de2a5' : '#ff9b75'}; --accent2: ${successful ? '#c8f56d' : '#ffd276'}; }
    * { box-sizing: border-box; }
    html, body { min-height: 100%; }
    body { margin: 0; display: grid; place-items: center; overflow: hidden; background: #07120f; color: var(--ink); font-family: "Trebuchet MS", "Segoe UI", sans-serif; }
    body::before { content: ""; position: fixed; inset: -20%; background: radial-gradient(circle at 25% 20%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 30%), radial-gradient(circle at 75% 80%, color-mix(in srgb, var(--accent2) 14%, transparent), transparent 32%), repeating-linear-gradient(115deg, transparent 0 42px, rgba(255,255,255,.025) 43px 44px); animation: drift 14s ease-in-out infinite alternate; }
    .shell { position: relative; width: min(92vw, 840px); padding: 1px; border-radius: 30px; background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 65%, transparent), rgba(255,255,255,.06) 45%, color-mix(in srgb, var(--accent2) 35%, transparent)); box-shadow: 0 35px 100px rgba(0,0,0,.55); animation: arrive .7s cubic-bezier(.2,.8,.2,1) both; }
    .card { position: relative; overflow: hidden; min-height: 480px; padding: 42px 48px 38px; border-radius: 29px; background: linear-gradient(145deg, rgba(17,39,32,.96), var(--panel)); backdrop-filter: blur(22px); }
    .card::after { content: "KR"; position: absolute; right: -20px; bottom: -76px; font: 700 220px/1 Georgia, serif; color: rgba(255,255,255,.025); letter-spacing: -.12em; pointer-events: none; }
    .brand { display: flex; align-items: center; gap: 12px; color: #dce8df; font-size: 13px; font-weight: 800; letter-spacing: .18em; }
    .mark { display: grid; place-items: center; width: 34px; height: 34px; border: 1px solid var(--line); border-radius: 10px; background: rgba(255,255,255,.05); color: var(--accent); font: 800 17px/1 Georgia, serif; }
    .status { display: grid; grid-template-columns: 118px 1fr; gap: 34px; align-items: center; margin-top: 74px; }
    .seal { position: relative; display: grid; place-items: center; width: 118px; height: 118px; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--accent) 38%, transparent); background: radial-gradient(circle, color-mix(in srgb, var(--accent) 20%, transparent), rgba(255,255,255,.025) 65%); box-shadow: 0 0 50px color-mix(in srgb, var(--accent) 14%, transparent); }
    .seal::before, .seal::after { content: ""; position: absolute; border-radius: 50%; border: 1px dashed color-mix(in srgb, var(--accent) 35%, transparent); animation: spin 16s linear infinite; }
    .seal::before { inset: -10px; } .seal::after { inset: 12px; animation-direction: reverse; animation-duration: 11s; }
    .icon { position: relative; z-index: 1; width: 42px; height: 42px; fill: none; stroke: var(--accent); stroke-width: 2.25; stroke-linecap: round; stroke-linejoin: round; }
    .eyebrow { margin: 0 0 13px; color: var(--accent); font-size: 12px; font-weight: 800; letter-spacing: .2em; }
    h1 { max-width: 560px; margin: 0; font: 500 clamp(38px, 6vw, 64px)/.98 Georgia, "Times New Roman", serif; letter-spacing: -.045em; }
    .lead { margin: 22px 0 0; color: #d6ded7; font-size: 17px; line-height: 1.5; }
    .divider { height: 1px; margin: 54px 0 24px; background: linear-gradient(90deg, var(--line), transparent); }
    .footer { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
    .fine { max-width: 510px; margin: 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
    button { flex: none; border: 1px solid color-mix(in srgb, var(--accent) 42%, transparent); border-radius: 999px; padding: 12px 19px; background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--ink); font: 700 12px/1 "Trebuchet MS", sans-serif; letter-spacing: .08em; cursor: pointer; transition: transform .18s ease, background .18s ease; }
    button:hover { transform: translateY(-2px); background: color-mix(in srgb, var(--accent) 18%, transparent); }
    @keyframes arrive { from { opacity: 0; transform: translateY(18px) scale(.985); } }
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes drift { to { transform: translate3d(2%, -2%, 0) rotate(1deg); } }
    @media (max-width: 650px) { .card { min-height: 0; padding: 28px 25px; } .status { grid-template-columns: 1fr; margin-top: 48px; gap: 28px; } .seal { width: 92px; height: 92px; } .footer { align-items: flex-start; flex-direction: column; } .divider { margin-top: 40px; } button { width: 100%; } }
    @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }
  </style>
</head>
<body>
  <main class="shell"><section class="card">
    <div class="brand"><span class="mark">K</span><span>KROUTER / CHATGPT</span></div>
    <div class="status">
      <div class="seal" aria-hidden="true">${
        successful
          ? '<svg class="icon" viewBox="0 0 48 48"><path d="M12 25l8 8 17-19"/></svg>'
          : '<svg class="icon" viewBox="0 0 48 48"><path d="M24 7l18 33H6L24 7z"/><path d="M24 18v10M24 34h.01"/></svg>'
      }</div>
      <div><p class="eyebrow">${copy.eyebrow}</p><h1>${copy.title}</h1><p class="lead">${copy.message}</p></div>
    </div>
    <div class="divider"></div>
    <div class="footer"><p class="fine">${copy.detail}</p><button type="button" id="close">CLOSE THIS TAB</button></div>
  </section></main>
  <script>history.replaceState({}, document.title, '/auth/callback/completed');document.getElementById('close').addEventListener('click',function(){window.close()});</script>
</body>
</html>`
}

function callbackHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  }
}

export function startOAuthCallbackServer(
  config: ChatGPTOAuthConfig,
  codeVerifier: string,
  state: string,
  exchange: TokenExchange = exchangeCodeForTokens
): OAuthCallbackHandle {
  const lifecycle: { server?: http.Server; timeout?: ReturnType<typeof setTimeout> } = {}
  let settled = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  let resolveFlow!: (result: OAuthFlowResult) => void
  let rejectFlow!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const waitForCallback = new Promise<OAuthFlowResult>((resolve, reject) => {
    resolveFlow = resolve
    rejectFlow = reject
  })

  const finish = (error?: Error, result?: OAuthFlowResult): void => {
    if (settled) return
    settled = true
    if (lifecycle.timeout) clearTimeout(lifecycle.timeout)
    lifecycle.server?.close()
    if (error) rejectFlow(error)
    else if (result) resolveFlow(result)
  }

  lifecycle.server = http.createServer(async (req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' })
      res.end('Method Not Allowed')
      return
    }
    const url = new URL(req.url || '/', `http://localhost:${config.redirectPort}`)

    if (url.pathname !== '/auth/callback') {
      res.writeHead(404)
      res.end('Not Found')
      return
    }

    const receivedState = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    const error = url.searchParams.get('error')

    if (error) {
      res.writeHead(200, callbackHeaders())
      res.end(renderOAuthCallbackPage('denied'))
      finish(new Error(`OAuth error: ${error}`))
      return
    }

    if (receivedState !== state) {
      res.writeHead(400, callbackHeaders())
      res.end(renderOAuthCallbackPage('invalid'))
      finish(new Error('OAuth state mismatch'))
      return
    }

    if (!code) {
      res.writeHead(400, callbackHeaders())
      res.end(renderOAuthCallbackPage('missing'))
      finish(new Error('No authorization code received'))
      return
    }

    try {
      const tokens = await exchange(code, codeVerifier, config)
      res.writeHead(200, callbackHeaders())
      res.end(renderOAuthCallbackPage('success'))
      finish(undefined, { tokens })
    } catch (err) {
      res.writeHead(502, callbackHeaders())
      res.end(renderOAuthCallbackPage('exchange'))
      finish(err instanceof Error ? err : new Error(String(err)))
    }
  })

  lifecycle.server.listen(config.redirectPort, '127.0.0.1', () => {
    proxyLogger.info('ChatGPTOAuth', `Callback server listening on port ${config.redirectPort}`)
    resolveReady()
  })

  lifecycle.server.on('error', (err) => {
    const error = new Error(`Failed to start OAuth callback server: ${err.message}`)
    rejectReady(error)
    finish(error)
  })

  lifecycle.timeout = setTimeout(() => {
    finish(new Error('OAuth flow timed out (5 minutes)'))
  }, OAUTH_FLOW_TTL_MS)
  lifecycle.timeout.unref?.()

  return {
    ready,
    waitForCallback,
    cancel: (reason = 'OAuth flow cancelled') => finish(new Error(reason))
  }
}

export async function initiateOAuthFlow(
  config?: Partial<ChatGPTOAuthConfig>,
  options: { mode?: OAuthFlowMode; exchange?: TokenExchange } = {}
): Promise<OAuthFlow> {
  let fullConfig = { ...DEFAULT_CHATGPT_OAUTH_CONFIG, ...config }
  const codeVerifier = generateCodeVerifier()
  const codeChallenge = generateCodeChallenge(codeVerifier)
  const state = generateState()
  const mode = options.mode || 'local'
  const expiresAt = Date.now() + OAUTH_FLOW_TTL_MS
  const flowId = crypto.randomUUID()

  if (mode === 'manual') {
    const redirectUri = `http://localhost:${fullConfig.redirectPort}/auth/callback`
    let settled = false
    let resolveFlow!: (result: OAuthFlowResult) => void
    let rejectFlow!: (error: Error) => void
    const waitForCallback = new Promise<OAuthFlowResult>((resolve, reject) => {
      resolveFlow = resolve
      rejectFlow = reject
    })
    // `timeout` khai báo sau `finish` nhưng finish chỉ CHẠY sau khi timer đã được gán,
    // nên const là an toàn (không vướng TDZ).
    const finish = (error?: Error, result?: OAuthFlowResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) rejectFlow(error)
      else if (result) resolveFlow(result)
    }
    const timeout = setTimeout(
      () => finish(new Error('OAuth flow timed out (5 minutes)')),
      OAUTH_FLOW_TTL_MS
    )
    timeout.unref?.()

    const submitCallbackUrl = async (callbackUrl: string): Promise<OAuthFlowResult> => {
      if (settled || Date.now() > expiresAt) throw new Error('OAuth session is no longer active')
      let code: string
      try {
        code = parseOAuthCallbackUrl(callbackUrl, redirectUri, state).code
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
        throw error
      }
      try {
        const tokens = await (options.exchange || exchangeCodeForTokens)(
          code,
          codeVerifier,
          fullConfig
        )
        const result = { tokens }
        finish(undefined, result)
        return result
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error))
        finish(normalized)
        throw normalized
      }
    }

    return {
      flowId,
      mode,
      authUrl: buildAuthorizationUrl(fullConfig, codeChallenge, state),
      redirectUri,
      expiresAt,
      waitForCallback,
      submitCallbackUrl,
      cancel: (reason = 'OAuth flow cancelled') => finish(new Error(reason))
    }
  }

  let callback = startOAuthCallbackServer(fullConfig, codeVerifier, state, options.exchange)
  try {
    await callback.ready
  } catch (error) {
    void callback.waitForCallback.catch(() => undefined)
    const canUseCodexFallback =
      Boolean(fullConfig.fallbackRedirectPort) &&
      fullConfig.fallbackRedirectPort !== fullConfig.redirectPort &&
      (error instanceof Error ? error.message : String(error)).includes('EADDRINUSE')
    if (!canUseCodexFallback) throw error

    fullConfig = { ...fullConfig, redirectPort: fullConfig.fallbackRedirectPort! }
    callback = startOAuthCallbackServer(fullConfig, codeVerifier, state, options.exchange)
    await callback.ready
  }

  const authUrl = buildAuthorizationUrl(fullConfig, codeChallenge, state)
  return {
    flowId,
    mode,
    authUrl,
    redirectUri: `http://localhost:${fullConfig.redirectPort}/auth/callback`,
    expiresAt,
    waitForCallback: callback.waitForCallback,
    cancel: callback.cancel
  }
}
