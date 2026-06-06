import { execFileSync } from 'child_process'
import crypto from 'crypto'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { refreshTokenByMethod } from './kiroAccounts'

interface IdeCredentials {
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  startUrl?: string
  machineId?: string
  authMethod?: 'IdC' | 'social'
  provider?: 'BuilderId' | 'Github' | 'Google' | 'Enterprise' | 'IAM_SSO'
  profileArn?: string
}

interface CliCredentials {
  accessToken: string
  refreshToken: string
  clientId?: string
  clientSecret?: string
  region?: string
  authMethod?: string
  profileArn?: string
  provider?: string
  startUrl?: string
  machineId?: string
  scopes?: string[]
}

const SOCIAL_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK'
const LEGACY_BUILDER_ID_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'

function ssoCacheDir(): string {
  return path.resolve(process.env.KIRO_SSO_CACHE_DIR || path.join(os.homedir(), '.aws', 'sso', 'cache'))
}

function tokenPath(): string {
  return path.join(ssoCacheDir(), 'kiro-auth-token.json')
}

function clientIdHashForStartUrl(startUrl = 'https://view.awsapps.com/start'): string {
  return crypto.createHash('sha1').update(JSON.stringify({ startUrl })).digest('hex')
}

function cliDataDir(): string {
  if (process.env.KIRO_CLI_DATA_DIR) return path.resolve(process.env.KIRO_CLI_DATA_DIR)
  return process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Local', 'kiro-cli')
    : path.join(os.homedir(), '.local', 'share', 'kiro-cli')
}

function cliDbPath(): string {
  return process.env.KIRO_CLI_DB_PATH
    ? path.resolve(process.env.KIRO_CLI_DB_PATH)
    : path.join(cliDataDir(), 'data.sqlite3')
}

function sqlEscape(value: unknown): string {
  return JSON.stringify(value).replace(/'/g, "''")
}

function runSqlite(dbPath: string, sql: string): void {
  try {
    execFileSync(process.platform === 'win32' ? 'sqlite3.exe' : 'sqlite3', [dbPath], { input: sql, encoding: 'utf8', timeout: 10000 })
    return
  } catch (cliError) {
    try {
      const sqlite = require('node:sqlite') as {
        DatabaseSync: new (filename: string) => { exec: (sql: string) => void; close: () => void }
      }
      const database = new sqlite.DatabaseSync(dbPath)
      try {
        database.exec(sql)
      } finally {
        database.close()
      }
      return
    } catch (nodeError) {
      throw new Error(`sqlite3 command or Node node:sqlite is required for CLI switching on this VPS. sqlite3: ${cliError instanceof Error ? cliError.message : String(cliError)}; node:sqlite: ${nodeError instanceof Error ? nodeError.message : String(nodeError)}`)
    }
  }
}

function isSocialCredential(credentials: { authMethod?: string; provider?: string }): boolean {
  const authMethod = String(credentials.authMethod || '').toLowerCase()
  const provider = String(credentials.provider || '').toLowerCase()
  return authMethod === 'social' || provider === 'google' || provider === 'github'
}

function normalizeProfileArn(profileArn?: string): string | undefined {
  let value = profileArn?.trim()
  if (!value || value === LEGACY_BUILDER_ID_PROFILE_ARN) return undefined
  if (!value.startsWith('arn:') && value.includes(':codewhisperer:')) value = `arn:${value}`
  return value
}

function resolveCredentialProfileArn(credentials: { authMethod?: string; provider?: string; profileArn?: string }): string | undefined {
  const explicit = normalizeProfileArn(credentials.profileArn)
  if (explicit) return explicit
  if (isSocialCredential(credentials)) return SOCIAL_PROFILE_ARN
  const authMethod = String(credentials.authMethod || '').toLowerCase()
  const provider = String(credentials.provider || '').toLowerCase()
  return provider === 'builderid' || (!provider && (authMethod === 'idc' || authMethod === 'oidc'))
    ? LEGACY_BUILDER_ID_PROFILE_ARN
    : undefined
}

function kiroUserDataDirs(): string[] {
  const dirs = new Set<string>()
  if (process.env.KIRO_USER_DATA_DIR) dirs.add(path.resolve(process.env.KIRO_USER_DATA_DIR))
  if (process.env.KIRO_IDE_USER_DATA_DIR) dirs.add(path.resolve(process.env.KIRO_IDE_USER_DATA_DIR))

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    dirs.add(path.join(appData, 'Kiro'))
  } else if (process.platform === 'darwin') {
    dirs.add(path.join(os.homedir(), 'Library', 'Application Support', 'Kiro'))
  } else {
    dirs.add(path.join(os.homedir(), '.config', 'Kiro'))
  }

  return Array.from(dirs)
}

function kiroProfilePaths(): string[] {
  const paths = new Set<string>()
  if (process.env.KIRO_IDE_PROFILE_PATH) paths.add(path.resolve(process.env.KIRO_IDE_PROFILE_PATH))
  for (const userDataDir of kiroUserDataDirs()) {
    for (const extensionId of ['kiro.kiroagent', 'kiro.kiro-agent']) {
      paths.add(path.join(userDataDir, 'User', 'globalStorage', extensionId, 'profile.json'))
    }
  }
  return Array.from(paths)
}

async function readKiroIdeProfile(): Promise<{ profileArn?: string; name?: string; path?: string } | null> {
  for (const profilePath of kiroProfilePaths()) {
    try {
      const data = JSON.parse(await fs.readFile(profilePath, 'utf8')) as {
        arn?: string
        profileArn?: string
        profile_arn?: string
        name?: string
      }
      const profileArn = normalizeProfileArn(data.profileArn || data.profile_arn || data.arn)
      if (profileArn) return { profileArn, name: data.name, path: profilePath }
    } catch {
      // Try the next known Kiro profile location.
    }
  }
  return null
}

async function findClientRegistration(clientIdHash?: string): Promise<{ clientId?: string; clientSecret?: string } | null> {
  if (clientIdHash) {
    try {
      return JSON.parse(await fs.readFile(path.join(ssoCacheDir(), `${clientIdHash}.json`), 'utf8'))
    } catch {
      // Search below.
    }
  }

  try {
    for (const file of await fs.readdir(ssoCacheDir())) {
      if (!file.endsWith('.json') || file === 'kiro-auth-token.json') continue
      try {
        const data = JSON.parse(await fs.readFile(path.join(ssoCacheDir(), file), 'utf8'))
        if (data.clientId && data.clientSecret) return data
      } catch {
        // Ignore unrelated cache files.
      }
    }
  } catch {
    // Cache directory does not exist.
  }
  return null
}

export async function getLocalActiveAccount(): Promise<{
  success: boolean
  data?: { refreshToken: string; accessToken?: string; authMethod?: string; provider?: string }
  error?: string
}> {
  try {
    const tokenData = JSON.parse(await fs.readFile(tokenPath(), 'utf8'))
    if (!tokenData.refreshToken) return { success: false, error: 'No refreshToken found in VPS SSO cache' }
    return {
      success: true,
      data: {
        refreshToken: tokenData.refreshToken,
        accessToken: tokenData.accessToken,
        authMethod: tokenData.authMethod,
        provider: tokenData.provider
      }
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to read VPS SSO cache' }
  }
}

export async function loadKiroCredentials(): Promise<{
  success: boolean
  data?: {
    accessToken: string
    refreshToken: string
    clientId: string
    clientSecret: string
    region: string
    authMethod: string
    provider: string
    profileArn?: string
    startUrl?: string
    machineId?: string
  }
  error?: string
}> {
  try {
    const tokenData = JSON.parse(await fs.readFile(tokenPath(), 'utf8')) as {
      accessToken?: string
      refreshToken?: string
      clientIdHash?: string
      region?: string
      authMethod?: string
      provider?: string
      profileArn?: string
      profile_arn?: string
      startUrl?: string
      start_url?: string
      machineId?: string
      machine_id?: string
    }
    if (!tokenData.refreshToken) return { success: false, error: 'kiro-auth-token.json is missing refreshToken' }

    const clientIdHash = tokenData.clientIdHash || clientIdHashForStartUrl()
    const clientData = await findClientRegistration(clientIdHash)
    const isSocial = tokenData.authMethod === 'social'
    if (!isSocial && (!clientData?.clientId || !clientData.clientSecret)) {
      return { success: false, error: 'Client registration file was not found in VPS SSO cache' }
    }

    const ideProfile = await readKiroIdeProfile()
    const profileArn = resolveCredentialProfileArn({
      authMethod: tokenData.authMethod,
      provider: tokenData.provider,
      profileArn: tokenData.profileArn || tokenData.profile_arn || ideProfile?.profileArn
    })

    return {
      success: true,
      data: {
        accessToken: tokenData.accessToken || '',
        refreshToken: tokenData.refreshToken,
        clientId: clientData?.clientId || '',
        clientSecret: clientData?.clientSecret || '',
        region: tokenData.region || 'us-east-1',
        authMethod: tokenData.authMethod || 'IdC',
        provider: tokenData.provider || 'BuilderId',
        profileArn,
        startUrl: tokenData.startUrl || tokenData.start_url,
        machineId: tokenData.machineId || tokenData.machine_id
      }
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unable to load VPS Kiro credentials' }
  }
}

export async function switchAccount(credentials: IdeCredentials): Promise<{ success: boolean; error?: string }> {
  try {
    const region = credentials.region || 'us-east-1'
    const authMethod = isSocialCredential(credentials) ? 'social' : 'IdC'
    const provider = credentials.provider || 'BuilderId'
    let accessToken = credentials.accessToken

    if (credentials.refreshToken) {
      const refreshed = await refreshTokenByMethod({
        refreshToken: credentials.refreshToken,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        region,
        authMethod
      })
      if (refreshed.success && refreshed.accessToken) accessToken = refreshed.accessToken
    }

    const startUrl = credentials.startUrl || 'https://view.awsapps.com/start'
    const clientIdHash = clientIdHashForStartUrl(startUrl)
    const profileArn = resolveCredentialProfileArn({ ...credentials, authMethod, provider })
    await fs.mkdir(ssoCacheDir(), { recursive: true })

    const tokenData = authMethod === 'social'
      ? { accessToken, refreshToken: credentials.refreshToken, profileArn, expiresAt: new Date(Date.now() + 3600000).toISOString(), authMethod, provider }
      : { accessToken, refreshToken: credentials.refreshToken, expiresAt: new Date(Date.now() + 3600000).toISOString(), clientIdHash, authMethod, provider, region, profileArn }
    await fs.writeFile(tokenPath(), JSON.stringify(tokenData, null, 2), 'utf8')

    if (authMethod !== 'social' && credentials.clientId && credentials.clientSecret) {
      await fs.writeFile(path.join(ssoCacheDir(), `${clientIdHash}.json`), JSON.stringify({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        expiresAt: new Date(Date.now() + 90 * 86400000).toISOString().replace('Z', ''),
        scopes: [
          'codewhisperer:completions',
          'codewhisperer:analysis',
          'codewhisperer:conversations',
          'codewhisperer:transformations',
          'codewhisperer:taskassist'
        ]
      }, null, 2), 'utf8')
    }

    return { success: true }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to switch VPS Kiro account' }
  }
}

export async function switchAccountCli(credentials: CliCredentials): Promise<{ success: boolean; error?: string; dbPath?: string }> {
  try {
    const region = credentials.region || 'us-east-1'
    const isSocial = isSocialCredential(credentials)
    let accessToken = credentials.accessToken
    if (credentials.refreshToken) {
      const refreshed = await refreshTokenByMethod({
        refreshToken: credentials.refreshToken,
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        region,
        authMethod: isSocial ? 'social' : undefined
      })
      if (refreshed.success && refreshed.accessToken) accessToken = refreshed.accessToken
    }

    const dbPath = cliDbPath()
    await fs.mkdir(path.dirname(dbPath), { recursive: true })
    const tokenKey = isSocial ? 'kirocli:social:token' : 'kirocli:odic:token'
    const profileArn = resolveCredentialProfileArn(credentials)
    const tokenData: Record<string, unknown> = {
      access_token: accessToken,
      refresh_token: credentials.refreshToken,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      region,
      profile_arn: profileArn
    }
    if (credentials.scopes) tokenData.scopes = credentials.scopes

    const sql = [
      'CREATE TABLE IF NOT EXISTS auth_kv (key TEXT PRIMARY KEY, value TEXT);',
      `INSERT OR REPLACE INTO auth_kv (key, value) VALUES ('${tokenKey}', '${sqlEscape(tokenData)}');`,
      ...(credentials.clientId && credentials.clientSecret && !isSocial
        ? [`INSERT OR REPLACE INTO auth_kv (key, value) VALUES ('kirocli:odic:device-registration', '${sqlEscape({ client_id: credentials.clientId, client_secret: credentials.clientSecret, region })}');`]
        : []),
      ...['kirocli:social:token', 'kirocli:odic:token', 'codewhisperer:odic:token']
        .filter((key) => key !== tokenKey)
        .map((key) => `DELETE FROM auth_kv WHERE key = '${key}';`)
    ].join('\n')

    runSqlite(dbPath, sql)

    return { success: true, dbPath }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to switch VPS Kiro CLI account' }
  }
}

export async function logoutAccount(): Promise<{ success: boolean; deletedCount?: number; error?: string }> {
  try {
    const files = await fs.readdir(ssoCacheDir()).catch(() => [])
    let deletedCount = 0
    for (const file of files) {
      await fs.unlink(path.join(ssoCacheDir(), file)).then(() => { deletedCount++ }).catch(() => undefined)
    }
    return { success: true, deletedCount }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to clear VPS SSO cache' }
  }
}
