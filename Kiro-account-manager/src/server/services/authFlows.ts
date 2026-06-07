import crypto from 'crypto'
import type { ServerResponse } from 'http'
import { checkAccountStatus } from './kiroAccounts'

const KIRO_AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev'
const KIRO_SOCIAL_REDIRECT_URI = 'kiro://kiro.kiroAgent/authenticate-success'
const DEFAULT_START_URL = 'https://view.awsapps.com/start'
const PORTAL_BASE = 'https://portal.sso.us-east-1.amazonaws.com'
const SSO_SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
  'codewhisperer:transformations',
  'codewhisperer:taskassist'
]

type LoginType = 'builderid' | 'social' | 'iamsso'

interface LoginState {
  type: LoginType
  clientId?: string
  clientSecret?: string
  deviceCode?: string
  userCode?: string
  verificationUri?: string
  interval?: number
  expiresAt?: number
  startUrl?: string
  redirectUri?: string
  region?: string
  codeVerifier?: string
  codeChallenge?: string
  oauthState?: string
  provider?: 'Google' | 'Github'
}

interface IamSsoResult {
  completed: boolean
  success: boolean
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  expiresIn?: number
  error?: string
}

interface TokenBundle {
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  expiresIn?: number
  authMethod?: string
  provider?: string
}

let currentLoginState: LoginState | null = null
let iamSsoResult: IamSsoResult | null = null

function publicBaseUrl(): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '')
  const host = process.env.HOST && process.env.HOST !== '0.0.0.0' ? process.env.HOST : '127.0.0.1'
  return `http://${host}:${process.env.PORT || 4010}`
}

function oidcBase(region = 'us-east-1'): string {
  return `https://oidc.${region}.amazonaws.com`
}

async function postJson<T>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(url, { method: 'GET', headers })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return response.json() as Promise<T>
}

async function registerOidcClient(region: string, input: {
  grantTypes: string[]
  issuerUrl: string
  redirectUris?: string[]
}): Promise<{ clientId: string; clientSecret: string }> {
  return postJson(`${oidcBase(region)}/client/register`, {
    clientName: 'Krouter',
    clientType: 'public',
    scopes: SSO_SCOPES,
    grantTypes: input.grantTypes,
    issuerUrl: input.issuerUrl,
    redirectUris: input.redirectUris
  })
}

async function enrichTokenData(bundle: TokenBundle): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {
    accessToken: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    clientId: bundle.clientId,
    clientSecret: bundle.clientSecret,
    region: bundle.region || 'us-east-1',
    expiresIn: bundle.expiresIn,
    authMethod: bundle.authMethod,
    provider: bundle.provider,
    idp: bundle.provider
  }
  try {
    const status = await checkAccountStatus({
      id: 'auth-import',
      idp: bundle.provider,
      credentials: {
        accessToken: bundle.accessToken,
        refreshToken: bundle.refreshToken,
        clientId: bundle.clientId,
        clientSecret: bundle.clientSecret,
        region: bundle.region || 'us-east-1',
        authMethod: bundle.authMethod,
        provider: bundle.provider,
        expiresAt: Date.now() + (bundle.expiresIn || 3600) * 1000
      }
    }) as any
    if (status?.success && status.data) Object.assign(data, status.data)
  } catch {
    // Credential verification can still be run by the caller later.
  }
  return data
}

export async function startBuilderIdLogin(region = 'us-east-1'): Promise<{
  success: boolean
  userCode?: string
  verificationUri?: string
  expiresIn?: number
  interval?: number
  error?: string
}> {
  try {
    const { clientId, clientSecret } = await registerOidcClient(region, {
      grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
      issuerUrl: DEFAULT_START_URL
    })
    const auth = await postJson<{
      deviceCode: string
      userCode: string
      verificationUri: string
      verificationUriComplete?: string
      interval?: number
      expiresIn?: number
    }>(`${oidcBase(region)}/device_authorization`, { clientId, clientSecret, startUrl: DEFAULT_START_URL })

    currentLoginState = {
      type: 'builderid',
      clientId,
      clientSecret,
      deviceCode: auth.deviceCode,
      userCode: auth.userCode,
      verificationUri: auth.verificationUri,
      interval: auth.interval || 5,
      expiresAt: Date.now() + (auth.expiresIn || 600) * 1000,
      region
    }
    return {
      success: true,
      userCode: auth.userCode,
      verificationUri: auth.verificationUriComplete || auth.verificationUri,
      expiresIn: auth.expiresIn || 600,
      interval: auth.interval || 5
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to start Builder ID login' }
  }
}

export async function pollBuilderIdAuth(region = 'us-east-1'): Promise<Record<string, unknown>> {
  if (!currentLoginState || currentLoginState.type !== 'builderid') return { success: false, error: 'No Builder ID login is in progress' }
  if (Date.now() > (currentLoginState.expiresAt || 0)) {
    currentLoginState = null
    return { success: false, error: 'Authorization expired, please start again' }
  }
  try {
    const response = await fetch(`${oidcBase(region)}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: currentLoginState.clientId,
        clientSecret: currentLoginState.clientSecret,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
        deviceCode: currentLoginState.deviceCode
      })
    })
    if (response.status === 200) {
      const token = await response.json() as { accessToken: string; refreshToken: string; expiresIn?: number }
      const result = {
        success: true,
        completed: true,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        clientId: currentLoginState.clientId,
        clientSecret: currentLoginState.clientSecret,
        region,
        expiresIn: token.expiresIn
      }
      currentLoginState = null
      return result
    }
    if (response.status === 400) {
      const error = (await response.json() as { error?: string }).error
      if (error === 'authorization_pending') return { success: true, completed: false, status: 'pending' }
      if (error === 'slow_down') {
        currentLoginState.interval = (currentLoginState.interval || 5) + 5
        return { success: true, completed: false, status: 'slow_down' }
      }
      currentLoginState = null
      return { success: false, error: error || 'Authorization failed' }
    }
    return { success: false, error: `Unexpected response: ${response.status}` }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to poll Builder ID auth' }
  }
}

export function cancelBuilderIdLogin(): { success: true } {
  currentLoginState = null
  return { success: true }
}

export async function startIamSsoLogin(startUrl: string, region = 'us-east-1'): Promise<{
  success: boolean
  authorizeUrl?: string
  userCode?: string
  verificationUri?: string
  expiresIn?: number
  interval?: number
  error?: string
}> {
  if (!startUrl || !startUrl.startsWith('https://')) return { success: false, error: 'SSO Start URL must start with https://' }
  try {
    const { clientId, clientSecret } = await registerOidcClient(region, {
      grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
      issuerUrl: startUrl
    })
    const auth = await postJson<{
      deviceCode: string
      userCode: string
      verificationUri: string
      verificationUriComplete?: string
      interval?: number
      expiresIn?: number
    }>(`${oidcBase(region)}/device_authorization`, { clientId, clientSecret, startUrl })

    iamSsoResult = null
    currentLoginState = {
      type: 'iamsso',
      clientId,
      clientSecret,
      deviceCode: auth.deviceCode,
      userCode: auth.userCode,
      verificationUri: auth.verificationUri,
      interval: auth.interval || 5,
      region,
      startUrl,
      expiresAt: Date.now() + (auth.expiresIn || 600) * 1000
    }
    const verificationUri = auth.verificationUriComplete || auth.verificationUri
    return {
      success: true,
      authorizeUrl: verificationUri,
      userCode: auth.userCode,
      verificationUri,
      expiresIn: auth.expiresIn || 600,
      interval: auth.interval || 5
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to start IAM SSO login' }
  }
}

export async function handleIamSsoCallback(url: URL): Promise<{ title: string; body: string }> {
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')
  if (!currentLoginState || currentLoginState.type !== 'iamsso') {
    iamSsoResult = { completed: true, success: false, error: 'No IAM SSO login is in progress' }
    return { title: 'Xác thực thất bại', body: 'Không có phiên đăng nhập IAM SSO nào đang chạy.' }
  }
  if (error) {
    iamSsoResult = { completed: true, success: false, error }
    return { title: 'Xác thực thất bại', body: error }
  }
  if (!code || state !== currentLoginState.oauthState) {
    iamSsoResult = { completed: true, success: false, error: 'Invalid authorization callback' }
    return { title: 'Xác thực thất bại', body: 'Callback xác thực không hợp lệ.' }
  }
  try {
    const token = await postJson<{ accessToken: string; refreshToken: string; expiresIn?: number }>(`${oidcBase(currentLoginState.region)}/token`, {
      clientId: currentLoginState.clientId,
      clientSecret: currentLoginState.clientSecret,
      grantType: 'authorization_code',
      redirectUri: currentLoginState.redirectUri,
      code,
      codeVerifier: currentLoginState.codeVerifier
    })
    iamSsoResult = {
      completed: true,
      success: true,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      clientId: currentLoginState.clientId,
      clientSecret: currentLoginState.clientSecret,
      region: currentLoginState.region,
      expiresIn: token.expiresIn
    }
    return { title: 'Xác thực hoàn tất', body: 'Anh có thể đóng tab trình duyệt này và quay lại Krouter.' }
  } catch (exchangeError) {
    iamSsoResult = { completed: true, success: false, error: exchangeError instanceof Error ? exchangeError.message : 'Token exchange failed' }
    return { title: 'Xác thực thất bại', body: iamSsoResult.error || 'Đổi token thất bại.' }
  }
}

export async function pollIamSsoAuth(): Promise<Record<string, unknown>> {
  if (!currentLoginState || currentLoginState.type !== 'iamsso') return { success: false, error: 'No IAM SSO login is in progress' }
  if (Date.now() > (currentLoginState.expiresAt || 0)) {
    currentLoginState = null
    iamSsoResult = null
    return { success: false, error: 'Authorization expired, please start again' }
  }
  if (iamSsoResult) {
    const result = { ...iamSsoResult }
    if (result.completed) {
      currentLoginState = null
      iamSsoResult = null
    }
    return result
  }
  if (currentLoginState.deviceCode) {
    try {
      const state = currentLoginState
      const response = await fetch(`${oidcBase(state.region)}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: state.clientId,
          clientSecret: state.clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode: state.deviceCode
        })
      })
      if (response.status === 200) {
        const token = await response.json() as { accessToken: string; refreshToken: string; expiresIn?: number }
        currentLoginState = null
        return {
          success: true,
          completed: true,
          accessToken: token.accessToken,
          refreshToken: token.refreshToken,
          clientId: state.clientId,
          clientSecret: state.clientSecret,
          region: state.region,
          expiresIn: token.expiresIn
        }
      }
      if (response.status === 400) {
        const error = (await response.json() as { error?: string }).error
        if (error === 'authorization_pending') return { success: true, completed: false, status: 'pending' }
        if (error === 'slow_down') {
          state.interval = (state.interval || 5) + 5
          return { success: true, completed: false, status: 'slow_down' }
        }
        currentLoginState = null
        return { success: false, error: error || 'Authorization failed' }
      }
      return { success: false, error: `Unexpected response: ${response.status}` }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to poll IAM SSO auth' }
    }
  }
  return { success: true, completed: false, status: 'pending' }
}

export function cancelIamSsoLogin(): { success: true } {
  currentLoginState = null
  iamSsoResult = null
  return { success: true }
}

export async function completeIamSsoLogin(code: string): Promise<Record<string, unknown>> {
  const state = currentLoginState?.oauthState || ''
  await handleIamSsoCallback(new URL(`${publicBaseUrl()}/api/auth/iam-sso/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`))
  return pollIamSsoAuth()
}

export function startSocialLogin(provider: 'Google' | 'Github'): {
  success: boolean
  loginUrl?: string
  state?: string
  error?: string
} {
  if (provider !== 'Google' && provider !== 'Github') return { success: false, error: 'Unsupported social provider' }
  const codeVerifier = crypto.randomBytes(64).toString('base64url').substring(0, 128)
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
  const oauthState = crypto.randomBytes(32).toString('base64url')
  // Kiro's hosted Cognito client only allowlists the desktop custom-scheme
  // callback. HTTP callbacks such as the web server URL produce
  // `redirect_mismatch` before the user reaches GitHub/Google.
  const redirectUri = KIRO_SOCIAL_REDIRECT_URI
  const loginUrl = new URL(`${KIRO_AUTH_ENDPOINT}/login`)
  loginUrl.searchParams.set('idp', provider)
  loginUrl.searchParams.set('redirect_uri', redirectUri)
  loginUrl.searchParams.set('code_challenge', codeChallenge)
  loginUrl.searchParams.set('code_challenge_method', 'S256')
  loginUrl.searchParams.set('state', oauthState)
  currentLoginState = { type: 'social', codeVerifier, codeChallenge, oauthState, provider, redirectUri, expiresAt: Date.now() + 600000 }
  return { success: true, loginUrl: loginUrl.toString(), state: oauthState }
}

export function handleSocialCallback(url: URL, emit: (channel: string, ...args: unknown[]) => void): { title: string; body: string } {
  const error = url.searchParams.get('error')
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (error) {
    emit('social-auth-callback', { error })
    return { title: 'Xác thực thất bại', body: error }
  }
  if (!code || !state) {
    emit('social-auth-callback', { error: 'Missing code or state' })
    return { title: 'Xác thực thất bại', body: 'Thiếu code hoặc state.' }
  }
  emit('social-auth-callback', { code, state })
  return { title: 'Xác thực hoàn tất', body: 'Anh có thể đóng tab trình duyệt này và quay lại Krouter.' }
}

export async function exchangeSocialToken(code: string, state: string): Promise<Record<string, unknown>> {
  if (!currentLoginState || currentLoginState.type !== 'social') return { success: false, error: 'No social login is in progress' }
  if (Date.now() > (currentLoginState.expiresAt || 0)) {
    currentLoginState = null
    return { success: false, error: 'Authorization expired, please start again' }
  }
  if (state !== currentLoginState.oauthState) {
    currentLoginState = null
    return { success: false, error: 'State parameter does not match' }
  }
  try {
    const token = await postJson<{
      accessToken: string
      refreshToken: string
      profileArn?: string
      expiresIn?: number
    }>(`${KIRO_AUTH_ENDPOINT}/oauth/token`, {
      code,
      code_verifier: currentLoginState.codeVerifier,
      redirect_uri: currentLoginState.redirectUri
    })
    const result = {
      success: true,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      profileArn: token.profileArn,
      expiresIn: token.expiresIn,
      authMethod: 'social',
      provider: currentLoginState.provider
    }
    currentLoginState = null
    return result
  } catch (error) {
    currentLoginState = null
    return { success: false, error: error instanceof Error ? error.message : 'Token exchange failed' }
  }
}

export function cancelSocialLogin(): { success: true } {
  currentLoginState = null
  return { success: true }
}

export async function importFromSsoToken(bearerToken: string, region = 'us-east-1'): Promise<{
  success: boolean
  data?: Record<string, unknown>
  error?: { message: string }
}> {
  if (!bearerToken) return { success: false, error: { message: 'Missing SSO bearer token' } }
  try {
    const ssoResult = await ssoDeviceAuth(bearerToken, region)
    if (!ssoResult.success || !ssoResult.accessToken || !ssoResult.refreshToken) {
      return { success: false, error: { message: ssoResult.error || 'SSO authorization failed' } }
    }
    return {
      success: true,
      data: await enrichTokenData({
        accessToken: ssoResult.accessToken,
        refreshToken: ssoResult.refreshToken,
        clientId: ssoResult.clientId,
        clientSecret: ssoResult.clientSecret,
        region: ssoResult.region || region,
        expiresIn: ssoResult.expiresIn,
        authMethod: 'IdC',
        provider: 'BuilderId'
      })
    }
  } catch (error) {
    return { success: false, error: { message: error instanceof Error ? error.message : 'Unknown error' } }
  }
}

async function ssoDeviceAuth(bearerToken: string, region = 'us-east-1'): Promise<{
  success: boolean
  accessToken?: string
  refreshToken?: string
  clientId?: string
  clientSecret?: string
  region?: string
  expiresIn?: number
  error?: string
}> {
  try {
    const { clientId, clientSecret } = await registerOidcClient(region, {
      grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
      issuerUrl: DEFAULT_START_URL
    })
    const device = await postJson<{ deviceCode: string; userCode: string; interval?: number }>(`${oidcBase(region)}/device_authorization`, {
      clientId,
      clientSecret,
      startUrl: DEFAULT_START_URL
    })
    await getJson(`${PORTAL_BASE}/token/whoAmI`, { Authorization: `Bearer ${bearerToken}`, Accept: 'application/json' })
    const session = await postJson<{ token: string }>(`${PORTAL_BASE}/session/device`, {}, { Authorization: `Bearer ${bearerToken}` })
    const accepted = await postJson<{ deviceContext?: { deviceContextId?: string; clientId?: string; clientType?: string } }>(
      `${oidcBase(region)}/device_authorization/accept_user_code`,
      { userCode: device.userCode, userSessionId: session.token },
      { Referer: DEFAULT_START_URL }
    )
    const deviceContext = accepted.deviceContext
    if (deviceContext?.deviceContextId) {
      await postJson(`${oidcBase(region)}/device_authorization/associate_token`, {
        deviceContext: {
          deviceContextId: deviceContext.deviceContextId,
          clientId: deviceContext.clientId || clientId,
          clientType: deviceContext.clientType || 'public'
        },
        userSessionId: session.token
      }, { Referer: DEFAULT_START_URL })
    }

    let interval = device.interval || 1
    const started = Date.now()
    while (Date.now() - started < 120000) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000))
      const response = await fetch(`${oidcBase(region)}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode: device.deviceCode
        })
      })
      if (response.ok) {
        const token = await response.json() as { accessToken: string; refreshToken: string; expiresIn?: number }
        return { success: true, accessToken: token.accessToken, refreshToken: token.refreshToken, clientId, clientSecret, region, expiresIn: token.expiresIn }
      }
      if (response.status === 400) {
        const error = (await response.json() as { error?: string }).error
        if (error === 'authorization_pending') continue
        if (error === 'slow_down') {
          interval += 5
          continue
        }
        return { success: false, error: error || 'Token polling failed' }
      }
    }
    return { success: false, error: 'Authorization timed out' }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'SSO device auth failed' }
  }
}

export function sendAuthHtml(response: ServerResponse, title: string, body: string): void {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  response.end(`<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body>`)
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char] || char))
}
