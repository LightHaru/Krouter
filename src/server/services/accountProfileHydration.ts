import {
  normalizeProfileArn,
  refreshTokenByMethod,
  resolveStreamingProfileArn
} from './kiroAccounts'

interface AccountCredentialsShape {
  accessToken?: string
  refreshToken?: string
  kiroApiKey?: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: string
  provider?: string
  expiresAt?: number
  profileArn?: string
}

interface AccountShape {
  id: string
  email?: string
  idp?: string
  status?: string
  profileArn?: string
  machineId?: string
  credentials?: AccountCredentialsShape
}

interface AccountDataShape {
  accounts?: Record<string, AccountShape>
}

function shouldResolveProfileArn(account: AccountShape): boolean {
  const credentials = account.credentials || {}
  const provider = String(credentials.provider || account.idp || '').trim().toLowerCase()
  const authMethod = String(credentials.authMethod || '').trim().toLowerCase()

  if (credentials.kiroApiKey || credentials.accessToken?.trim().startsWith('ksk_') || authMethod === 'api_key' || authMethod === 'apikey' || provider === 'kiroapikey') return true
  if (provider === 'builderid' || provider === 'builder_id') return true
  if (provider === 'github' || provider === 'google') return true
  if (authMethod === 'social') return true
  if (authMethod === 'idc' || authMethod === 'external_idp') return true
  if (provider.includes('enterprise') || provider.includes('iam') || provider.includes('idc') || provider.includes('sso')) {
    return true
  }
  return false
}

async function ensureAccessToken(account: AccountShape): Promise<{ accessToken?: string; changed: boolean }> {
  const credentials = account.credentials || {}
  let accessToken = credentials.kiroApiKey || credentials.accessToken
  let changed = false
  const expiresAt = Number(credentials.expiresAt || 0)
  const needsRefresh = Boolean(credentials.refreshToken) && (!accessToken || expiresAt < Date.now() + 300000)

  if (!needsRefresh) return { accessToken, changed }

  const refresh = await refreshTokenByMethod({
    refreshToken: credentials.refreshToken || '',
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    region: credentials.region || 'us-east-1',
    authMethod: credentials.authMethod,
    provider: credentials.provider || account.idp,
    machineId: account.machineId
  }).catch(() => null)

  if (refresh?.success && refresh.accessToken) {
    accessToken = refresh.accessToken
    credentials.accessToken = refresh.accessToken
    credentials.refreshToken = refresh.refreshToken || credentials.refreshToken
    credentials.expiresAt = Date.now() + (refresh.expiresIn || 3600) * 1000
    changed = true
  }

  return { accessToken, changed }
}

export async function hydrateAccountDataProfileArns<T extends AccountDataShape | Record<string, unknown>>(rawData: T): Promise<{
  data: T
  changed: boolean
  resolvedCount: number
}> {
  const accountData = rawData as AccountDataShape
  const accounts = Object.values(accountData.accounts || {})
  let changed = false
  let resolvedCount = 0

  for (const account of accounts) {
    const normalized = normalizeProfileArn(account.profileArn || account.credentials?.profileArn)
    if (normalized) {
      if (account.profileArn !== normalized) {
        account.profileArn = normalized
        changed = true
      }
      continue
    }

    if (account.status && account.status !== 'active') continue
    if (!account.credentials || !shouldResolveProfileArn(account)) continue

    const token = await ensureAccessToken(account)
    if (token.changed) changed = true
    if (!token.accessToken) continue

    const profileArn = await resolveStreamingProfileArn({
      accessToken: token.accessToken,
      kiroApiKey: account.credentials.kiroApiKey,
      machineId: account.machineId,
      region: account.credentials.region || 'us-east-1',
      authMethod: account.credentials.authMethod,
      provider: account.credentials.provider || account.idp
    }).catch(() => undefined)

    if (!profileArn) continue

    let accountChanged = false
    if (account.profileArn !== profileArn) {
      account.profileArn = profileArn
      accountChanged = true
    }
    if (account.credentials.profileArn !== profileArn) {
      account.credentials.profileArn = profileArn
      accountChanged = true
    }
    if (accountChanged) {
      changed = true
      resolvedCount++
    }
  }

  return { data: rawData, changed, resolvedCount }
}
