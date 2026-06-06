const KIRO_AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev'
const KIRO_VERSION = '0.6.18'
export const BUILDER_ID_STREAMING_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'
export const SOCIAL_SIGN_IN_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'

const KIRO_REST_API_ENDPOINTS: Record<string, string> = {
  'us-east-1': 'https://q.us-east-1.amazonaws.com',
  'eu-central-1': 'https://q.eu-central-1.amazonaws.com'
}

export interface AccountLike {
  id?: string
  email?: string
  idp?: string
  profileArn?: string
  machineId?: string
  credentials?: {
    accessToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    authMethod?: string
    provider?: string
    expiresAt?: number
  }
}

export interface CredentialInput {
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: string
  provider?: string
  profileArn?: string
  machineId?: string
  startUrl?: string
}

interface RefreshResult {
  success: boolean
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  error?: string
}

export function normalizeProfileArn(profileArn?: string): string | undefined {
  let value = profileArn?.trim()
  if (!value || value === BUILDER_ID_STREAMING_PROFILE_ARN) return undefined
  if (!value.startsWith('arn:') && value.includes(':codewhisperer:')) value = `arn:${value}`
  return value
}

function fixedProfileArnForProvider(provider?: string, authMethod?: string, profileArn?: string): string | undefined {
  const providerKey = (provider || '').trim().toLowerCase()
  const authKey = (authMethod || '').trim().toLowerCase()
  const explicit = normalizeProfileArn(profileArn)
  if (authKey === 'social' && explicit) return explicit
  if (providerKey === 'github' || providerKey === 'google') return SOCIAL_SIGN_IN_PROFILE_ARN
  if (providerKey === 'builderid' || providerKey === 'builder_id') return BUILDER_ID_STREAMING_PROFILE_ARN
  return undefined
}

interface UsageBreakdown {
  type?: string
  resourceType?: string
  displayName?: string
  displayNamePlural?: string
  currentUsage?: number
  currentUsageWithPrecision?: number
  usageLimit?: number
  usageLimitWithPrecision?: number
  currency?: string
  unit?: string
  overageRate?: number
  overageCap?: number
  freeTrialUsage?: TrialUsage
  freeTrialInfo?: TrialUsage & { freeTrialExpiry?: number | string }
  bonuses?: BonusUsage[]
}

interface TrialUsage {
  currentUsage?: number
  currentUsageWithPrecision?: number
  usageLimit?: number
  usageLimitWithPrecision?: number
  freeTrialStatus?: string
  freeTrialExpiry?: string
}

interface BonusUsage {
  bonusCode?: string
  displayName?: string
  usageLimit?: number
  usageLimitWithPrecision?: number
  currentUsage?: number
  currentUsageWithPrecision?: number
  expiresAt?: number | string
  status?: string
}

interface UsageLimitsResponse {
  usageBreakdownList?: UsageBreakdown[]
  nextDateReset?: number | string
  subscriptionInfo?: {
    subscriptionName?: string
    subscriptionTitle?: string
    subscriptionType?: string
    type?: string
    status?: string
    subscriptionManagementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  overageSettings?: {
    overageStatus?: string
  }
  overageConfiguration?: {
    overageEnabled?: boolean
    overageStatus?: string
  }
  userInfo?: {
    email?: string
    userId?: string
  }
}

function getRestApiBase(ssoRegion?: string): string {
  if (!ssoRegion) return KIRO_REST_API_ENDPOINTS['us-east-1']
  if (KIRO_REST_API_ENDPOINTS[ssoRegion]) return KIRO_REST_API_ENDPOINTS[ssoRegion]
  if (ssoRegion.startsWith('eu-')) return KIRO_REST_API_ENDPOINTS['eu-central-1']
  return KIRO_REST_API_ENDPOINTS['us-east-1']
}

function getFallbackRestApiBase(ssoRegion?: string): string {
  const primary = getRestApiBase(ssoRegion)
  return primary === KIRO_REST_API_ENDPOINTS['eu-central-1']
    ? KIRO_REST_API_ENDPOINTS['us-east-1']
    : KIRO_REST_API_ENDPOINTS['eu-central-1']
}

function getKiroUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE-${KIRO_VERSION}-${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/1.0.18 ua/2.1 os/linux lang/js md/nodejs#22 api/codewhispererstreaming#1.0.18 m/E ${suffix}`
}

function getKiroAmzUserAgent(machineId?: string): string {
  const suffix = machineId ? `KiroIDE ${KIRO_VERSION} ${machineId}` : `KiroIDE-${KIRO_VERSION}`
  return `aws-sdk-js/1.0.18 ${suffix}`
}

function normalizeDate(value: number | string | undefined): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'number') return new Date(value * 1000).toISOString()
  return value
}

function subscriptionTypeFromTitle(title: string): string {
  const upper = title.toUpperCase()
  if (upper.includes('PRO+') || upper.includes('PRO_PLUS') || upper.includes('PROPLUS')) return 'Pro_Plus'
  if (upper.includes('POWER')) return 'Enterprise'
  if (upper.includes('PRO')) return 'Pro'
  if (upper.includes('ENTERPRISE')) return 'Enterprise'
  if (upper.includes('TEAMS')) return 'Teams'
  return 'Free'
}

async function refreshOidcToken(input: Required<Pick<CredentialInput, 'refreshToken' | 'clientId' | 'clientSecret'>> & { region: string }): Promise<RefreshResult> {
  const response = await fetch(`https://oidc.${input.region}.amazonaws.com/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      refreshToken: input.refreshToken,
      grantType: 'refresh_token'
    })
  })
  if (!response.ok) return { success: false, error: `HTTP ${response.status}: ${await response.text()}` }
  const data = await response.json() as { accessToken?: string; refreshToken?: string; expiresIn?: number }
  return {
    success: Boolean(data.accessToken),
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || input.refreshToken,
    expiresIn: data.expiresIn || 3600
  }
}

async function refreshSocialToken(refreshToken: string, machineId?: string): Promise<RefreshResult> {
  const response = await fetch(`${KIRO_AUTH_ENDPOINT}/refreshToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': getKiroUserAgent(machineId)
    },
    body: JSON.stringify({ refreshToken })
  })
  if (!response.ok) return { success: false, error: `HTTP ${response.status}: ${await response.text()}` }
  const data = await response.json() as { accessToken?: string; refreshToken?: string; expiresIn?: number }
  return {
    success: Boolean(data.accessToken),
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || refreshToken,
    expiresIn: data.expiresIn || 3600
  }
}

export async function refreshTokenByMethod(input: CredentialInput & { machineId?: string }): Promise<RefreshResult> {
  const region = input.region || 'us-east-1'
  if (!input.refreshToken) return { success: false, error: 'Missing refresh token' }
  if (input.authMethod === 'social') return refreshSocialToken(input.refreshToken, input.machineId)
  if (!input.clientId || !input.clientSecret) return { success: false, error: 'Missing OIDC clientId/clientSecret' }
  return refreshOidcToken({
    refreshToken: input.refreshToken,
    clientId: input.clientId,
    clientSecret: input.clientSecret,
    region
  })
}

async function getUsageLimitsRest(input: {
  accessToken: string
  profileArn?: string
  machineId?: string
  region?: string
}): Promise<UsageLimitsResponse> {
  const params = new URLSearchParams({
    origin: 'AI_EDITOR',
    resourceType: 'AGENTIC_REQUEST',
    isEmailRequired: 'true'
  })
  const profileArn = normalizeProfileArn(input.profileArn)
  if (profileArn) params.set('profileArn', profileArn)
  const path = `/getUsageLimits?${params.toString()}`
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${input.accessToken}`,
    'User-Agent': getKiroUserAgent(input.machineId),
    'x-amz-user-agent': getKiroAmzUserAgent(input.machineId)
  }

  let response = await fetch(`${getRestApiBase(input.region)}${path}`, { method: 'GET', headers })
  if (response.status === 403) {
    response = await fetch(`${getFallbackRestApiBase(input.region)}${path}`, { method: 'GET', headers })
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return response.json() as Promise<UsageLimitsResponse>
}

function uniqueEndpoints(region?: string): string[] {
  return Array.from(new Set([
    getRestApiBase(region),
    getFallbackRestApiBase(region)
  ]))
}

async function postListAvailableProfiles(input: {
  endpoint: string
  accessToken: string
  machineId?: string
  nextToken?: string
  timeoutMs?: number
}): Promise<ListAvailableProfilesResponse> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs || 10000)
  try {
    const response = await fetch(`${input.endpoint}/ListAvailableProfiles`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${input.accessToken}`,
        'User-Agent': getKiroUserAgent(input.machineId),
        'x-amz-user-agent': getKiroAmzUserAgent(input.machineId)
      },
      body: JSON.stringify(input.nextToken ? { nextToken: input.nextToken } : {})
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`)
    return text ? JSON.parse(text) as ListAvailableProfilesResponse : {}
  } finally {
    clearTimeout(timeout)
  }
}

export async function listAvailableProfilesRest(input: {
  accessToken: string
  machineId?: string
  region?: string
  timeoutMs?: number
}): Promise<KiroAvailableProfile[]> {
  let lastError: Error | undefined

  for (const endpoint of uniqueEndpoints(input.region || 'us-east-1')) {
    try {
      const profiles: KiroAvailableProfile[] = []
      let nextToken: string | undefined
      let page = 0
      do {
        const data = await postListAvailableProfiles({
          endpoint,
          accessToken: input.accessToken,
          machineId: input.machineId,
          nextToken,
          timeoutMs: input.timeoutMs
        })
        profiles.push(...(Array.isArray(data.profiles) ? data.profiles : []))
        nextToken = data.nextToken
        page++
      } while (nextToken && page < 20)

      if (profiles.length > 0) return profiles
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  if (lastError) throw lastError
  return []
}

function getProfileArn(profile: KiroAvailableProfile): string | undefined {
  return normalizeProfileArn(profile.arn || profile.profileArn || profile.profile_arn)
}

function chooseStreamingProfileArn(profiles: KiroAvailableProfile[]): string | undefined {
  const candidates = profiles
    .map((profile) => ({
      arn: getProfileArn(profile),
      name: String(profile.profileName || profile.name || '').toLowerCase(),
      status: String(profile.status || '').toLowerCase()
    }))
    .filter((profile): profile is { arn: string; name: string; status: string } => Boolean(profile.arn))

  if (candidates.length === 0) return undefined
  return (
    candidates.find((profile) => profile.status === 'active' && profile.name.includes('kiroprofile') && profile.arn.includes(':us-east-1:')) ||
    candidates.find((profile) => profile.name.includes('kiroprofile') && profile.arn.includes(':us-east-1:')) ||
    candidates.find((profile) => profile.status === 'active' && profile.arn.includes(':us-east-1:')) ||
    candidates.find((profile) => profile.arn.includes(':us-east-1:')) ||
    candidates.find((profile) => profile.status === 'active') ||
    candidates[0]
  ).arn
}

export async function resolveStreamingProfileArn(input: {
  accessToken?: string
  profileArn?: string
  machineId?: string
  region?: string
  authMethod?: string
  provider?: string
}): Promise<string | undefined> {
  const explicit = normalizeProfileArn(input.profileArn)
  if (explicit) return explicit

  const fixedProfileArn = fixedProfileArnForProvider(input.provider, input.authMethod, input.profileArn)
  if (fixedProfileArn) return fixedProfileArn
  if (!input.accessToken) return undefined

  const providerKey = (input.provider || '').trim().toLowerCase()
  if (providerKey === 'builderid') return undefined

  const profiles = await listAvailableProfilesRest({
    accessToken: input.accessToken,
    machineId: input.machineId,
    region: input.region || 'us-east-1'
  })
  return chooseStreamingProfileArn(profiles)
}

function normalizeUsage(usage: UsageLimitsResponse): {
  email: string
  userId: string
  subscriptionType: string
  subscriptionTitle: string
  subscription: Record<string, unknown>
  usage: Record<string, unknown>
  daysRemaining?: number
  expiresAt?: number
} {
  const subscriptionTitle = usage.subscriptionInfo?.subscriptionTitle || usage.subscriptionInfo?.subscriptionName || 'Free'
  const creditUsage = usage.usageBreakdownList?.find((item) => item.resourceType === 'CREDIT' || item.type === 'CREDIT')
  const baseLimit = creditUsage?.usageLimitWithPrecision ?? creditUsage?.usageLimit ?? 0
  const baseCurrent = creditUsage?.currentUsageWithPrecision ?? creditUsage?.currentUsage ?? 0
  const trial = creditUsage?.freeTrialInfo || creditUsage?.freeTrialUsage
  const freeTrialActive = trial?.freeTrialStatus === 'ACTIVE'
  const freeTrialLimit = freeTrialActive ? trial?.usageLimitWithPrecision ?? trial?.usageLimit ?? 0 : 0
  const freeTrialCurrent = freeTrialActive ? trial?.currentUsageWithPrecision ?? trial?.currentUsage ?? 0 : 0
  const bonuses = (creditUsage?.bonuses || [])
    .filter((bonus) => !bonus.status || bonus.status === 'ACTIVE')
    .map((bonus) => ({
      code: bonus.bonusCode || '',
      name: bonus.displayName || '',
      current: bonus.currentUsageWithPrecision ?? bonus.currentUsage ?? 0,
      limit: bonus.usageLimitWithPrecision ?? bonus.usageLimit ?? 0,
      expiresAt: normalizeDate(bonus.expiresAt)
    }))
  const totalLimit = baseLimit + freeTrialLimit + bonuses.reduce((sum, bonus) => sum + bonus.limit, 0)
  const totalCurrent = baseCurrent + freeTrialCurrent + bonuses.reduce((sum, bonus) => sum + bonus.current, 0)
  const nextResetDate = normalizeDate(usage.nextDateReset)
  const expiresAt = nextResetDate ? new Date(nextResetDate).getTime() : undefined

  return {
    email: usage.userInfo?.email || '',
    userId: usage.userInfo?.userId || '',
    subscriptionType: subscriptionTypeFromTitle(subscriptionTitle),
    subscriptionTitle,
    subscription: {
      rawType: usage.subscriptionInfo?.type || usage.subscriptionInfo?.subscriptionType,
      managementTarget: usage.subscriptionInfo?.subscriptionManagementTarget,
      upgradeCapability: usage.subscriptionInfo?.upgradeCapability,
      overageCapability: usage.subscriptionInfo?.overageCapability
    },
    usage: {
      current: totalCurrent,
      limit: totalLimit,
      baseLimit,
      baseCurrent,
      freeTrialLimit,
      freeTrialCurrent,
      freeTrialExpiry: normalizeDate(trial?.freeTrialExpiry),
      bonuses,
      nextResetDate,
      resourceDetail: creditUsage ? {
        displayName: creditUsage.displayName,
        displayNamePlural: creditUsage.displayNamePlural,
        resourceType: creditUsage.resourceType || creditUsage.type,
        currency: creditUsage.currency,
        unit: creditUsage.unit,
        overageRate: creditUsage.overageRate,
        overageCap: creditUsage.overageCap,
        overageEnabled: usage.overageConfiguration?.overageStatus === 'ENABLED' || usage.overageConfiguration?.overageEnabled === true || usage.overageSettings?.overageStatus === 'ENABLED'
      } : undefined
    },
    daysRemaining: expiresAt ? Math.max(0, Math.ceil((expiresAt - Date.now()) / 86400000)) : undefined,
    expiresAt
  }
}

export async function refreshAccountToken(account: AccountLike): Promise<{
  success: boolean
  data?: { accessToken: string; refreshToken?: string; expiresIn: number }
  error?: { message: string }
}> {
  const credentials = account.credentials || {}
  const result = await refreshTokenByMethod({
    refreshToken: credentials.refreshToken || '',
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    region: credentials.region,
    authMethod: credentials.authMethod,
    machineId: account.machineId
  })
  if (!result.success || !result.accessToken) {
    return { success: false, error: { message: result.error || 'Token refresh failed' } }
  }
  return {
    success: true,
    data: {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken || credentials.refreshToken,
      expiresIn: result.expiresIn || 3600
    }
  }
}

export async function verifyAccountCredentials(credentials: CredentialInput): Promise<unknown> {
  const refresh = await refreshTokenByMethod(credentials)
  if (!refresh.success || !refresh.accessToken) {
    return { success: false, error: `Token refresh failed: ${refresh.error || 'unknown error'}` }
  }
  const profileArn = normalizeProfileArn(credentials.profileArn)
  const usage = await getUsageLimitsRest({
    accessToken: refresh.accessToken,
    profileArn,
    machineId: credentials.machineId,
    region: credentials.region || 'us-east-1'
  })
  const resolvedProfileArn = profileArn || await resolveStreamingProfileArn({
    accessToken: refresh.accessToken,
    machineId: credentials.machineId,
    region: credentials.region || 'us-east-1',
    authMethod: credentials.authMethod,
    provider: credentials.provider
  }).catch(() => undefined)
  return {
    success: true,
    data: {
      ...normalizeUsage(usage),
      accessToken: refresh.accessToken,
      refreshToken: refresh.refreshToken || credentials.refreshToken,
      expiresIn: refresh.expiresIn || 3600,
      profileArn: resolvedProfileArn
    }
  }
}

export interface KiroAvailableProfile {
  arn?: string
  profileArn?: string
  profile_arn?: string
  name?: string
  profileName?: string
  status?: string
  type?: string
}

interface ListAvailableProfilesResponse {
  profiles?: KiroAvailableProfile[]
  nextToken?: string
}

export async function checkAccountStatus(account: AccountLike): Promise<unknown> {
  const credentials = account.credentials || {}
  let accessToken = credentials.accessToken
  let refreshResult: Awaited<ReturnType<typeof refreshAccountToken>> | undefined
  const expiresAt = credentials.expiresAt || 0
  if ((!accessToken || expiresAt < Date.now() + 300000) && credentials.refreshToken) {
    refreshResult = await refreshAccountToken(account)
    if (!refreshResult.success || !refreshResult.data?.accessToken) return refreshResult
    accessToken = refreshResult.data.accessToken
  }
  if (!accessToken) return { success: false, error: { message: 'Missing access token' } }
  const usage = await getUsageLimitsRest({
    accessToken,
    profileArn: account.profileArn,
    machineId: account.machineId,
    region: credentials.region || 'us-east-1'
  })
  const normalized = normalizeUsage(usage)
  const resolvedProfileArn = await resolveStreamingProfileArn({
    accessToken,
    profileArn: account.profileArn,
    machineId: account.machineId,
    region: credentials.region || 'us-east-1',
    authMethod: credentials.authMethod,
    provider: credentials.provider || account.idp
  }).catch(() => normalizeProfileArn(account.profileArn))
  return {
    success: true,
    data: {
      status: 'active',
      email: normalized.email || account.email,
      userId: normalized.userId,
      idp: credentials.provider || account.idp,
      subscriptionType: normalized.subscriptionType,
      subscriptionTitle: normalized.subscriptionTitle,
      subscription: {
        ...normalized.subscription,
        type: normalized.subscriptionType,
        title: normalized.subscriptionTitle,
        daysRemaining: normalized.daysRemaining,
        expiresAt: normalized.expiresAt
      },
      daysRemaining: normalized.daysRemaining,
      expiresAt: normalized.expiresAt,
      profileArn: resolvedProfileArn,
      usage: {
        ...(normalized.usage as Record<string, unknown>),
        percentUsed: normalized.usage.limit ? ((normalized.usage.current as number) / (normalized.usage.limit as number)) * 100 : 0,
        lastUpdated: Date.now()
      },
      newCredentials: refreshResult?.data ? {
        accessToken: refreshResult.data.accessToken,
        refreshToken: refreshResult.data.refreshToken,
        expiresAt: Date.now() + refreshResult.data.expiresIn * 1000
      } : undefined
    }
  }
}
