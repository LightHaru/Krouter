import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { ChainProxyRelay } from '../../main/registration/chainProxy'
import { callKiroApi, isPlaceholderProfileArn, resolveProfileArn } from '../../main/proxy/kiroApi'
import { getSystemProxy, safeCreateProxyAgent } from '../../main/proxy/systemProxy'
import { openaiToKiro } from '../../main/proxy/translator'
import type { OpenAIChatRequest, ProxyAccount } from '../../main/proxy/types'
import { refreshTokenByMethod, resolveStreamingProfileArn, verifyAccountCredentials } from './kiroAccounts'

function compactErrorMessage(error: unknown, maxLength = 360): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.split('\n')[0].slice(0, maxLength)
}

function isAccountAuthBlocked(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return message.includes('auth error 401')
    || message.includes('auth error 403')
    || message.includes('temporarily_suspended')
    || message.includes('permanently_suspended')
    || message.includes('accountsuspendedexception')
    || message.includes('temporarily suspended')
    || message.includes('account suspended')
    || message.includes('user id is temporarily suspended')
    || message.includes('unusual user activity')
    || message.includes('locked it as a security precaution')
    || message.includes('restricted your ability to use kiro')
}

function isInvalidBearerToken(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return message.includes('bearer token included in the request is invalid')
    || message.includes('invalid bearer')
}

export async function proxyPoolValidate(params: {
  url: string
  testUrl?: string
  timeoutMs?: number
  upstreamProxy?: string
}): Promise<{ success: boolean; latencyMs?: number; externalIp?: string; error?: string }> {
  const { url, testUrl = 'https://api.ipify.org?format=json', timeoutMs = 8000, upstreamProxy } = params || {}
  if (!url) return { success: false, error: 'Missing proxy URL' }

  let chainRelay: ChainProxyRelay | null = null
  let proxyForAgent = url
  if (upstreamProxy?.trim()) {
    try {
      chainRelay = new ChainProxyRelay(upstreamProxy.trim(), url)
      proxyForAgent = await chainRelay.start()
    } catch (error) {
      return { success: false, error: `Proxy chain failed to start: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const agent = safeCreateProxyAgent(proxyForAgent)
  if (!agent) {
    if (chainRelay) await chainRelay.stop()
    return { success: false, error: 'Unsupported proxy protocol or invalid proxy URL' }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await undiciFetch(testUrl, {
      method: 'GET',
      dispatcher: agent,
      signal: controller.signal,
      headers: { 'User-Agent': 'KiroAccountManager-ProxyValidator/1.0' }
    } as UndiciRequestInit)
    const latencyMs = Date.now() - started
    if (response.status < 200 || response.status >= 400) return { success: false, latencyMs, error: `HTTP ${response.status}` }

    const text = await response.text().catch(() => '')
    return { success: true, latencyMs, externalIp: extractIp(response.headers.get('content-type') || '', text) }
  } catch (error) {
    return {
      success: false,
      latencyMs: Date.now() - started,
      error: controller.signal.aborted ? `Request timed out (${timeoutMs}ms)` : error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
    if (chainRelay) await chainRelay.stop()
  }
}

export async function networkRouteValidate(params?: {
  testUrl?: string
  timeoutMs?: number
}): Promise<{ success: boolean; latencyMs?: number; externalIp?: string; route: string; error?: string }> {
  const testUrl = params?.testUrl || 'https://api.ipify.org?format=json'
  const timeoutMs = params?.timeoutMs || 8000
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || getSystemProxy()
  const route = proxyUrl ? 'system-proxy' : 'direct-or-vpn'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()

  try {
    const response = await undiciFetch(testUrl, {
      method: 'GET',
      dispatcher: safeCreateProxyAgent(proxyUrl) || undefined,
      signal: controller.signal,
      headers: { 'User-Agent': 'KiroAccountManager-NetworkValidator/1.0' }
    } as UndiciRequestInit)
    const latencyMs = Date.now() - started
    if (response.status < 200 || response.status >= 400) {
      return { success: false, latencyMs, route, error: `HTTP ${response.status}` }
    }

    const text = await response.text().catch(() => '')
    const externalIp = extractIp(response.headers.get('content-type') || '', text)
    return externalIp
      ? { success: true, latencyMs, externalIp, route }
      : { success: false, latencyMs, route, error: 'The network check succeeded but no exit IP was returned' }
  } catch (error) {
    return {
      success: false,
      latencyMs: Date.now() - started,
      route,
      error: controller.signal.aborted ? `Request timed out (${timeoutMs}ms)` : error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function proxyPoolDiagnoseChain(params: {
  targetUrl: string
  upstreamProxy: string
  testHost?: string
  testPort?: number
}): Promise<{ success: boolean; diagnose?: unknown; error?: string }> {
  const { targetUrl, upstreamProxy, testHost, testPort } = params || {}
  if (!targetUrl) return { success: false, error: 'Missing target proxy URL' }
  if (!upstreamProxy) return { success: false, error: 'Missing upstream proxy URL' }
  try {
    const relay = new ChainProxyRelay(upstreamProxy, targetUrl)
    return { success: true, diagnose: await relay.diagnose(testHost, testPort) }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function diagnoseAccountLiveness(params: {
  account: {
    id?: string
    email?: string
    accessToken?: string
    kiroApiKey?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    authMethod?: 'social' | 'idc' | 'IdC' | 'external_idp' | 'api_key' | 'apikey'
    provider?: string
    profileArn?: string
    machineId?: string
    expiresAt?: number
    proxyUrl?: string
  }
  model?: string
  message?: string
  timeoutMs?: number
}): Promise<{
  success: boolean
  latencyMs: number
  model?: string
  content?: string
  profileArn?: string
  usage?: { inputTokens: number; outputTokens: number; credits: number }
  error?: string
}> {
  const account = params?.account
  const model = (params?.model || 'claude-sonnet-4.5').trim()
  const message = (params?.message || 'Hi, reply with "pong" only.').trim()
  const timeoutMs = params?.timeoutMs ?? 45000
  const started = Date.now()

  if (!account?.accessToken) return { success: false, latencyMs: 0, model, error: 'Account is missing accessToken' }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let resolvedProfileArn: string | undefined
  let runCredentialCheck: ((fallbackReason?: string, options?: { success?: boolean }) => Promise<{
    success: boolean
    latencyMs: number
    model?: string
    content?: string
    profileArn?: string
    error?: string
  }>) | undefined
  try {
    let accessToken = account.accessToken
    const authMethodKey = String(account.authMethod || '').trim().toLowerCase()
    const providerKey = String(account.provider || '').trim().toLowerCase().replace(/[\s_-]/g, '')
    const accessTokenLooksLikeApiKey = account.accessToken?.trim().startsWith('ksk_') ?? false
    const isApiKeyAccount = Boolean(account.kiroApiKey) || accessTokenLooksLikeApiKey || authMethodKey === 'api_key' || authMethodKey === 'apikey' || providerKey === 'kiroapikey' || providerKey === 'apikey'
    const apiKey = account.kiroApiKey || (isApiKeyAccount ? account.accessToken : undefined)
    const refreshAccessToken = async (): Promise<string | null> => {
      if (apiKey) return apiKey
      if (!account.refreshToken) return null
      const refreshed = await refreshTokenByMethod({
        refreshToken: account.refreshToken,
        clientId: account.clientId,
        clientSecret: account.clientSecret,
        region: account.region || 'us-east-1',
        authMethod: account.authMethod,
        provider: account.provider,
        machineId: account.machineId
      }).catch(() => null)
      return refreshed?.success && refreshed.accessToken ? refreshed.accessToken : null
    }

    const needsRefresh = account.refreshToken && (!account.expiresAt || account.expiresAt - Date.now() < 60000)
    if (needsRefresh) {
      const refreshedAccessToken = await refreshAccessToken()
      if (refreshedAccessToken) accessToken = refreshedAccessToken
    }

    const proxyAccount: ProxyAccount = {
      id: account.id || 'diagnose',
      email: account.email,
      accessToken,
      kiroApiKey: apiKey,
      refreshToken: account.refreshToken,
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      region: account.region || 'us-east-1',
      authMethod: account.authMethod,
      provider: account.provider,
      profileArn: account.profileArn,
      machineId: account.machineId,
      proxyUrl: account.proxyUrl,
      expiresAt: account.expiresAt
    }
    resolvedProfileArn = await resolveStreamingProfileArn({
      accessToken,
      kiroApiKey: apiKey,
      profileArn: account.profileArn,
      machineId: account.machineId,
      region: account.region || 'us-east-1',
      authMethod: account.authMethod,
      provider: account.provider
    }).catch(() => undefined)
    resolvedProfileArn = resolvedProfileArn || resolveProfileArn(proxyAccount)

    runCredentialCheck = async (fallbackReason?: string, options?: { success?: boolean }): Promise<{
      success: boolean
      latencyMs: number
      model?: string
      content?: string
      profileArn?: string
      error?: string
    }> => {
      if (account.refreshToken || apiKey) {
        const verified = await verifyAccountCredentials({
          refreshToken: account.refreshToken,
          accessToken,
          kiroApiKey: apiKey,
          clientId: account.clientId,
          clientSecret: account.clientSecret,
          region: account.region || 'us-east-1',
          authMethod: account.authMethod,
          provider: account.provider,
          profileArn: account.profileArn,
          machineId: account.machineId
        }) as {
          success?: boolean
          data?: { email?: string; subscriptionTitle?: string; profileArn?: string; usage?: { current?: number; limit?: number } }
          error?: string | { message?: string }
        }
        if (!verified.success) {
          const errorMessage = typeof verified.error === 'string' ? verified.error : verified.error?.message
          return {
            success: false,
            latencyMs: Date.now() - started,
            model: 'credential-check',
            error: errorMessage || 'Credential check failed'
          }
        }
        const usage = verified.data?.usage
        const email = verified.data?.email || account.email || 'unknown'
        const quota = usage ? `, usage ${usage.current ?? 0}/${usage.limit ?? 0}` : ''
        const message = `${fallbackReason ? `${fallbackReason} ` : ''}Credential and quota check passed for ${email}${quota}.`
        return {
          success: options?.success ?? true,
          latencyMs: Date.now() - started,
          model: 'credential-check',
          profileArn: verified.data?.profileArn,
          ...(options?.success === false ? { error: message } : { content: message })
        }
      }

      const message = `${fallbackReason ? `${fallbackReason} ` : ''}The account has an access token, but no refresh token was available for quota verification.`
      return {
        success: options?.success ?? true,
        latencyMs: Date.now() - started,
        model: 'credential-check',
        profileArn: resolvedProfileArn,
        ...(options?.success === false ? { error: message } : { content: message })
      }
    }

    if (!resolvedProfileArn && !isApiKeyAccount) {
      return await runCredentialCheck('No usable streaming profileArn is available for this account, so model chat was skipped.', { success: false })
    }

    proxyAccount.profileArn = resolvedProfileArn
    const request: OpenAIChatRequest = {
      model,
      messages: [{ role: 'user', content: message }],
      stream: false,
      max_tokens: 64
    }

    let result: Awaited<ReturnType<typeof callKiroApi>> | null = null
    try {
      result = await callKiroApi(proxyAccount, openaiToKiro(request, resolvedProfileArn), controller.signal)
    } catch (error) {
      if (!controller.signal.aborted && account.refreshToken && isInvalidBearerToken(error)) {
        const refreshedAccessToken = await refreshAccessToken()
        if (refreshedAccessToken) {
          proxyAccount.accessToken = refreshedAccessToken
          result = await callKiroApi(proxyAccount, openaiToKiro(request, resolvedProfileArn), controller.signal)
        } else {
          throw error
        }
      } else {
        throw error
      }
    }

    if (!result) {
      throw new Error('Model liveness did not return a result')
    }

    return {
      success: true,
      latencyMs: Date.now() - started,
      model,
      profileArn: resolvedProfileArn,
      content: result.content.trim().slice(0, 500),
      usage: {
        inputTokens: result.usage.inputTokens || 0,
        outputTokens: result.usage.outputTokens || 0,
        credits: result.usage.credits || 0
      }
    }
  } catch (error) {
    try {
      if (!controller.signal.aborted && runCredentialCheck && isPlaceholderProfileArn(resolvedProfileArn)) {
        const detail = compactErrorMessage(error)
        if (isAccountAuthBlocked(error)) {
          return {
            success: false,
            latencyMs: Date.now() - started,
            model,
            error: `Model liveness failed: ${detail}`
          }
        }
        return await runCredentialCheck(`Builder ID model liveness fallback: Kiro did not accept the fixed placeholder profileArn (${detail}).`, { success: false })
      }
      throw error
    } catch (fallbackError) {
      return {
        success: false,
        latencyMs: Date.now() - started,
        model,
        error: controller.signal.aborted ? `Timed out (${timeoutMs}ms)` : fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

function extractIp(contentType: string, text: string): string | undefined {
  if (contentType.includes('json') || text.trimStart().startsWith('{')) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>
      const raw = body.ip ?? body.query ?? body.origin ?? body.ipAddress ?? ''
      const match = String(raw).match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
      if (match) return match[0]
    } catch {
      // Fall back to text extraction below.
    }
  }
  return text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0]
}
