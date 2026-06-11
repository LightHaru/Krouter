import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { chromium, request as playwrightRequest } from 'playwright'

const baseURL = (process.env.E2E_BASE_URL || 'http://127.0.0.1:4010').replace(/\/$/, '')
const adminEmail = process.env.E2E_ADMIN_EMAIL || 'admin@example.com'
const adminPassword = process.env.E2E_ADMIN_PASSWORD || 'admin'
const reportPath = path.resolve(process.env.E2E_REPORT_PATH || '.web-data-dev/e2e-fullsuite-report.json')
const onlyIndex = process.argv.indexOf('--only')
const onlyRaw = onlyIndex >= 0 ? process.argv[onlyIndex + 1] || process.env.E2E_ONLY || '' : process.env.E2E_ONLY || ''
const onlyGroups = new Set(onlyRaw.split(',').map((item) => item.trim()).filter(Boolean))
const results = []
const startedAt = Date.now()

class RuntimeSkip extends Error {
  constructor(reason) {
    super(reason)
    this.reason = reason
  }
}

function enabled(group) {
  return onlyGroups.size === 0 || onlyGroups.has(group)
}

function printable(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/(access|refresh)[_-]?token["'\s:=]+\S+/gi, '$1Token=***')
}

async function test(group, name, fn) {
  if (!enabled(group)) return
  const started = Date.now()
  try {
    const detail = await fn()
    results.push({ group, name, status: 'passed', durationMs: Date.now() - started, detail })
    console.log(`PASS [${group}] ${name}`)
  } catch (error) {
    if (error instanceof RuntimeSkip) {
      results.push({ group, name, status: 'skipped', durationMs: Date.now() - started, reason: error.reason })
      console.log(`SKIP [${group}] ${name}: ${error.reason}`)
      return
    }
    results.push({ group, name, status: 'failed', durationMs: Date.now() - started, error: printable(error) })
    console.error(`FAIL [${group}] ${name}: ${printable(error)}`)
  }
}

function skipNow(reason) {
  throw new RuntimeSkip(reason)
}

function skip(group, name, reason) {
  if (!enabled(group)) return
  results.push({ group, name, status: 'skipped', durationMs: 0, reason })
  console.log(`SKIP [${group}] ${name}: ${reason}`)
}

async function json(response) {
  const text = await response.text()
  return text ? JSON.parse(text) : null
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close((error) => error ? reject(error) : resolve(port))
    })
  })
}

async function waitFor(predicate, timeoutMs = 10000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

const anonymous = await playwrightRequest.newContext({ baseURL })
const api = await playwrightRequest.newContext({ baseURL, timeout: 120000 })

async function ipc(method, args = []) {
  const response = await api.post('/api/ipc', { data: { method, args } })
  assert.equal(response.ok(), true, `${method} returned HTTP ${response.status()}: ${await response.text()}`)
  return json(response)
}

let accountData

function isApiKeyAccount(account) {
  const credentials = account?.credentials || {}
  const authMethod = String(credentials.authMethod || '').trim().toLowerCase().replace(/[\s_-]/g, '')
  const provider = String(credentials.provider || account?.idp || '').trim().toLowerCase().replace(/[\s_-]/g, '')
  const accessToken = String(credentials.accessToken || '')
  return accessToken.startsWith('ksk_') || authMethod === 'apikey' || provider === 'kiroapikey' || provider === 'apikey'
}

function isRefreshableAccount(account) {
  if (isApiKeyAccount(account)) return false
  const credentials = account?.credentials || {}
  if (!credentials.refreshToken) return false
  const authMethod = String(credentials.authMethod || '').trim().toLowerCase()
  const provider = String(credentials.provider || account?.idp || '').trim().toLowerCase()
  if (authMethod === 'social' || provider === 'github' || provider === 'google') return true
  return Boolean(credentials.clientId && credentials.clientSecret)
}

async function loadActiveAccount(predicate = () => true, label = 'active account') {
  accountData ||= await ipc('loadAccounts')
  const accounts = Object.values(accountData?.accounts || {})
  const account = accounts.find((item) => item?.status === 'active' && item?.credentials?.accessToken && predicate(item))
  assert.ok(account, `No ${label} with an access token is available`)
  return account
}

function accountArgs(account) {
  return [
    account.credentials.accessToken,
    account.credentials.region,
    account.profileArn,
    account.machineId,
    account.credentials.provider || account.idp,
    account.credentials.authMethod,
    account.id
  ]
}

function livenessAccount(account) {
  return {
    id: account.id,
    email: account.email,
    accessToken: account.credentials.accessToken,
    refreshToken: account.credentials.refreshToken,
    clientId: account.credentials.clientId,
    clientSecret: account.credentials.clientSecret,
    region: account.credentials.region,
    authMethod: account.credentials.authMethod,
    provider: account.credentials.provider || account.idp,
    profileArn: account.profileArn,
    machineId: account.machineId,
    expiresAt: account.credentials.expiresAt
  }
}

async function persistReturnedCredentials(account, data) {
  const next = data?.newCredentials || data
  if (!next?.accessToken && !next?.refreshToken) return account
  account.credentials = {
    ...account.credentials,
    ...(next.accessToken ? { accessToken: next.accessToken } : {}),
    ...(next.refreshToken ? { refreshToken: next.refreshToken } : {}),
    ...(next.expiresAt ? { expiresAt: next.expiresAt } : {}),
    ...(next.expiresIn ? { expiresAt: Date.now() + next.expiresIn * 1000 } : {})
  }
  accountData.accounts[account.id] = account
  await ipc('saveAccounts', [accountData])
  return account
}

await test('auth', 'health endpoint', async () => {
  const response = await anonymous.get('/healthz')
  assert.equal(response.status(), 200)
  const body = await json(response)
  assert.equal(body.ok, true)
  return { version: body.version }
})

await test('auth', 'reject unauthenticated IPC', async () => {
  const response = await anonymous.post('/api/ipc', { data: { method: 'getAppVersion', args: [] } })
  assert.equal(response.status(), 401)
})

await test('auth', 'reject invalid password', async () => {
  const response = await anonymous.post('/api/auth/login', { data: { email: adminEmail, password: `${adminPassword}-invalid` } })
  assert.equal(response.status(), 401)
})

await test('auth', 'login and session', async () => {
  const login = await api.post('/api/auth/login', { data: { email: adminEmail, password: adminPassword } })
  assert.equal(login.ok(), true, await login.text())
  const session = await api.get('/api/auth/session')
  const body = await json(session)
  assert.equal(body.authenticated, true)
  assert.equal(body.user.email, adminEmail)
  return { role: body.user.role }
})

// Selected-group runs may skip the auth group, but every IPC group still needs a session.
const bootstrapLogin = await api.post('/api/auth/login', { data: { email: adminEmail, password: adminPassword } })
assert.equal(bootstrapLogin.ok(), true, `E2E bootstrap login failed: ${await bootstrapLogin.text()}`)

await test('core', 'version, account store and unsupported IPC', async () => {
  const version = await ipc('getAppVersion')
  accountData = await ipc('loadAccounts')
  const unsupported = await ipc('__e2e_unknown_method__')
  assert.match(String(version), /^\d+\.\d+\.\d+/)
  assert.ok(accountData && typeof accountData === 'object')
  assert.equal(unsupported.success, false)
  return { version, accountCount: Object.keys(accountData.accounts || {}).length }
})

await test('core', 'settings read/write/restore', async () => {
  const original = {
    usageApiType: await ipc('getUsageApiType'),
    useKProxyForApi: await ipc('getUseKProxyForApi'),
    shortcut: await ipc('getShowWindowShortcut'),
    tray: await ipc('getTraySettings')
  }
  try {
    assert.equal((await ipc('setUsageApiType', ['rest'])).success, true)
    assert.equal((await ipc('setUseKProxyForApi', [!original.useKProxyForApi])).success, true)
    assert.equal((await ipc('setShowWindowShortcut', ['Ctrl+Alt+Shift+K'])).success, true)
    assert.equal((await ipc('saveTraySettings', [{ showNotifications: !original.tray.showNotifications }])).success, true)
    assert.equal((await ipc('setProxy', [false, ''])).success, true)
  } finally {
    await ipc('setUsageApiType', [original.usageApiType])
    await ipc('setUseKProxyForApi', [original.useKProxyForApi])
    await ipc('setShowWindowShortcut', [original.shortcut])
    await ipc('saveTraySettings', [original.tray])
  }
})

await test('core', 'update check endpoints', async () => {
  const automatic = await ipc('checkForUpdates')
  const manual = await ipc('checkForUpdatesManual')
  assert.equal(typeof automatic.hasUpdate, 'boolean')
  assert.equal(typeof manual.hasUpdate, 'boolean')
  assert.match(automatic.currentVersion, /^\d+\.\d+\.\d+/)
  return { currentVersion: automatic.currentVersion, latestVersion: automatic.latestVersion || null }
})

await test('machine', 'generate, backup, set, read and restore machine ID', async () => {
  const osType = await ipc('machineIdGetOSType')
  const original = await ipc('machineIdGetCurrent')
  const generated = await ipc('machineIdGenerateRandom')
  assert.equal(original.success, true, original.error)
  assert.match(generated, /^[0-9a-f-]{36}$/)
  assert.equal(await ipc('machineIdBackupToFile', [original.machineId]), true)
  let changedMachineId = false
  try {
    const setResult = await ipc('machineIdSet', [generated])
    if (!setResult.success && setResult.requiresAdmin) {
      const invalid = await ipc('machineIdSet', ['not-a-machine-id'])
      assert.equal(invalid.success, false)
      assert.equal(typeof await ipc('machineIdCheckAdmin'), 'boolean')
      assert.equal(await ipc('machineIdRequestAdminRestart'), false)
      return { osType, requiresAdmin: true }
    }
    assert.equal(setResult.success, true, setResult.error)
    changedMachineId = true
    const current = await ipc('machineIdGetCurrent')
    assert.equal(current.machineId, generated)
    const invalid = await ipc('machineIdSet', ['not-a-machine-id'])
    assert.equal(invalid.success, false)
  } finally {
    if (changedMachineId) await ipc('machineIdSet', [original.machineId])
  }
  const restored = await ipc('machineIdRestoreFromFile')
  assert.equal(restored.machineId, original.machineId)
  assert.equal(typeof await ipc('machineIdCheckAdmin'), 'boolean')
  assert.equal(await ipc('machineIdRequestAdminRestart'), false)
  return { osType }
})

await test('kiro-settings', 'settings, steering and MCP CRUD', async () => {
  const original = await ipc('getKiroSettings')
  assert.ok(original.paths)
  const steeringName = 'e2e-fullsuite.md'
  const mcpName = 'e2e-fullsuite'
  const hadDefaultRules = original.steeringFiles?.includes('rules.md')
  try {
    const changed = { ...(original.settings || {}), enableDebugLogs: !original.settings?.enableDebugLogs }
    assert.equal((await ipc('saveKiroSettings', [changed])).success, true)
    assert.equal((await ipc('openKiroSettingsFile')).success, true)
    assert.equal((await ipc('openKiroMcpConfig', ['user'])).success, true)
    assert.equal((await ipc('openKiroSteeringFolder')).success, true)
    assert.equal((await ipc('saveKiroSteeringFile', [steeringName, '# E2E\ncontrolled test'])).success, true)
    const steering = await ipc('readKiroSteeringFile', [steeringName])
    assert.match(steering.content, /controlled test/)
    assert.equal((await ipc('openKiroSteeringFile', [steeringName])).success, true)
    assert.equal((await ipc('saveMcpServer', [mcpName, { command: 'node', args: ['--version'] }])).success, true)
    if (!hadDefaultRules) {
      assert.equal((await ipc('createKiroDefaultRules')).success, true)
      assert.match((await ipc('readKiroSteeringFile', ['rules.md'])).content, /Kiro Rules/)
    }
  } finally {
    await ipc('deleteKiroSteeringFile', [steeringName]).catch(() => undefined)
    if (!hadDefaultRules) await ipc('deleteKiroSteeringFile', ['rules.md']).catch(() => undefined)
    await ipc('deleteMcpServer', [mcpName]).catch(() => undefined)
    await ipc('saveKiroSettings', [original.settings || {}]).catch(() => undefined)
  }
})

await test('accounts', 'account model and subscription APIs', async () => {
  const account = await loadActiveAccount()
  const models = await ipc('accountGetModels', accountArgs(account))
  assert.equal(models.success, true, models.error)
  assert.ok(models.models.length > 0)
  const subscriptions = await ipc('accountGetSubscriptions', [
    account.credentials.accessToken,
    account.credentials.region,
    account.profileArn,
    account.machineId,
    account.credentials.provider || account.idp,
    account.credentials.authMethod,
    account.id
  ])
  assert.equal(typeof subscriptions.success, 'boolean')
  assert.ok(Array.isArray(subscriptions.plans))
  return { provider: account.credentials.provider || account.idp, modelCount: models.models.length, subscriptionsAvailable: subscriptions.success }
})

await test('accounts', 'status, refresh, verification, background check and proxy binding', async () => {
  let account = await loadActiveAccount(isRefreshableAccount, 'refreshable non-API-key account')
  const status = await ipc('checkAccountStatus', [account])
  assert.equal(status.success, true, status.error?.message || status.error)
  account = await persistReturnedCredentials(account, status.data)

  const refreshed = await ipc('refreshAccountToken', [account])
  assert.equal(refreshed.success, true, refreshed.error?.message || refreshed.error)
  account = await persistReturnedCredentials(account, refreshed.data)

  const verified = await ipc('verifyAccountCredentials', [{
    refreshToken: account.credentials.refreshToken,
    clientId: account.credentials.clientId,
    clientSecret: account.credentials.clientSecret,
    region: account.credentials.region,
    authMethod: account.credentials.authMethod,
    provider: account.credentials.provider || account.idp
  }])
  assert.equal(verified.success, true, verified.error)
  account = await persistReturnedCredentials(account, verified.data)

  const background = await ipc('backgroundBatchCheck', [[account], 1, false])
  assert.equal(background.success, true)
  assert.equal(background.completed, 1)
  assert.equal(background.failedCount, 0)

  assert.equal((await ipc('accountSetProxyBinding', [account.id, 'http://127.0.0.1:9'])).success, true)
  assert.equal((await ipc('accountSetProxyBinding', [account.id, undefined])).success, true)
  return { email: account.email, status: status.data.status }
})

await test('accounts', 'switch IDE/CLI account, logout isolated cache and restore', async () => {
  const account = await loadActiveAccount(isRefreshableAccount, 'refreshable non-API-key account')
  const credentials = {
    ...account.credentials,
    provider: account.credentials.provider || account.idp,
    profileArn: account.profileArn
  }
  assert.equal((await ipc('switchAccount', [credentials])).success, true)
  assert.equal((await ipc('getLocalActiveAccount')).success, true)
  assert.equal((await ipc('loadKiroCredentials')).success, true)
  const cli = await ipc('switchAccountCli', [credentials])
  assert.equal(cli.success, true, cli.error)
  try {
    assert.equal((await ipc('logoutAccount')).success, true)
    assert.equal((await ipc('getLocalActiveAccount')).success, false)
  } finally {
    assert.equal((await ipc('switchAccount', [credentials])).success, true)
  }
  assert.equal((await ipc('getLocalActiveAccount')).success, true)
  return { cliDbCreated: Boolean(cli.dbPath) }
})

await test('login-flows', 'GitHub and Google URLs use allowlisted Kiro callback', async () => {
  for (const provider of ['Github', 'Google']) {
    const result = await ipc('startSocialLogin', [provider])
    assert.equal(result.success, true, result.error)
    const url = new URL(result.loginUrl)
    assert.equal(url.searchParams.get('idp'), provider)
    assert.equal(url.searchParams.get('redirect_uri'), 'kiro://kiro.kiroAgent/authenticate-success')
    assert.ok(url.searchParams.get('state'))
    assert.ok(url.searchParams.get('code_challenge'))
    await ipc('cancelSocialLogin')
  }
  const missing = await ipc('exchangeSocialToken', ['', ''])
  assert.equal(missing.success, false)
  const emptyImport = await ipc('importFromSsoToken', ['', 'us-east-1'])
  assert.equal(emptyImport.success, false)
})

await test('login-flows', 'Builder ID and IAM SSO start, poll and cancel', async () => {
  const builder = await ipc('startBuilderIdLogin', ['us-east-1'])
  assert.equal(builder.success, true, builder.error)
  const builderPoll = await ipc('pollBuilderIdAuth', ['us-east-1'])
  assert.equal(builderPoll.success, true, builderPoll.error)
  assert.equal(builderPoll.completed, false)
  assert.equal((await ipc('cancelBuilderIdLogin')).success, true)
  assert.equal((await ipc('pollBuilderIdAuth', ['us-east-1'])).success, false)

  assert.equal((await ipc('startIamSsoLogin', ['invalid', 'us-east-1'])).success, false)
  const iam = await ipc('startIamSsoLogin', ['https://view.awsapps.com/start', 'us-east-1'])
  assert.equal(iam.success, true, iam.error)
  assert.match(iam.verificationUri, /^https:\/\//)
  assert.ok(iam.userCode)
  const iamPoll = await ipc('pollIamSsoAuth')
  assert.equal(iamPoll.completed, false)
  assert.equal((await ipc('cancelIamSsoLogin')).success, true)
  assert.equal((await ipc('completeIamSsoLogin', [''])).success, false)
})

await test('registration', 'registration state, cancellation and manual-flow guards', async () => {
  await ipc('registrationCancel')
  const status = await ipc('registrationStatus')
  assert.equal(status.inProgress, false)
  assert.equal((await ipc('registrationManualPhase2', ['nobody@example.invalid'])).success, false)
  assert.equal((await ipc('registrationManualPhase3', ['000000'])).success, false)
  assert.equal((await ipc('protonLoginStatus')).loggedIn, false)
  assert.equal((await ipc('protonClose')).success, true)
})

await test('registration', 'manual registration initialization and Proton browser lifecycle', async () => {
  const manual = await ipc('registrationManualPhase1', [{}])
  try {
    assert.equal(manual.success, true, manual.error)
    assert.equal((await ipc('registrationStatus')).inProgress, true)
  } finally {
    await ipc('registrationCancel')
  }
  const proton = await ipc('protonOpenLogin')
  try {
    assert.equal(proton.success, true, proton.error)
    assert.equal(proton.loginUrl, '/proton-login')
  } finally {
    await ipc('protonClose')
  }
})

await test('diagnostics', 'HTTP probe, diagnose run and proxy validation guards', async () => {
  const probe = await ipc('diagnoseHttpProbe', [{ url: `${baseURL}/healthz`, timeoutMs: 5000 }])
  assert.equal(probe.success, true, probe.error)
  const run = await ipc('diagnoseRun', [{ targets: [{ id: 'health', label: 'Health', url: `${baseURL}/healthz`, expectStatus: [200] }] }])
  assert.equal(run.results[0].success, true)
  assert.equal((await ipc('proxyPoolValidate', [{ url: '' }])).success, false)
  assert.equal((await ipc('proxyPoolDiagnoseChain', [{ targetUrl: '', upstreamProxy: '' }])).success, false)
})

await test('proxy', 'API key CRUD, logs and reset controls', async () => {
  const beforeLogs = await ipc('proxyLoadLogs')
  assert.equal((await ipc('proxyGetApiKeys')).success, true)
  const created = await ipc('proxyAddApiKey', [{ name: 'e2e-fullsuite', format: 'sk', creditsLimit: 10 }])
  assert.equal(created.success, true, created.error)
  try {
    assert.equal((await ipc('proxyUpdateApiKey', [created.apiKey.id, { name: 'e2e-fullsuite-updated', enabled: true }])).success, true)
    assert.equal((await ipc('proxyResetApiKeyUsage', [created.apiKey.id])).success, true)
    assert.equal((await ipc('proxySaveLogs', [[{ level: 'info', message: 'e2e-fullsuite' }]])).success, true)
    const loaded = await ipc('proxyLoadLogs')
    assert.equal(loaded.logs[0].message, 'e2e-fullsuite')
    assert.equal(typeof await ipc('proxyGetLogsCount'), 'number')
    assert.ok(Array.isArray(await ipc('proxyGetLogs', [5])))
    assert.equal((await ipc('proxyAuditLog')).entries instanceof Array, true)
    assert.equal((await ipc('proxyResetCredits')).success, true)
    assert.equal((await ipc('proxyResetTokens')).success, true)
    assert.equal((await ipc('proxyResetRequestStats')).success, true)
    assert.equal((await ipc('proxyResetPool')).success, true)
    assert.equal((await ipc('proxyClearAccountSuspended', ['missing-e2e-account'])).success, true)
    assert.equal(typeof (await ipc('proxySelfSignedCertInfo')).success, 'boolean')
    assert.equal((await ipc('proxySelfSignedCertRegenerate')).success, true)
    assert.equal((await ipc('proxyClearLogs')).success, true)
  } finally {
    await ipc('proxyDeleteApiKey', [created.apiKey.id]).catch(() => undefined)
    await ipc('proxySaveLogs', [beforeLogs.logs || []]).catch(() => undefined)
  }
})

await test('proxy', 'proxy account pool and model cache operations', async () => {
  const original = await ipc('proxyGetAccounts')
  assert.ok(Array.isArray(original.accounts))
  const synthetic = {
    id: 'e2e-fullsuite-synthetic',
    email: 'e2e@example.invalid',
    accessToken: 'controlled-invalid-token',
    region: 'us-east-1',
    authMethod: 'IdC',
    provider: 'BuilderId'
  }
  try {
    assert.equal((await ipc('proxyAddAccount', [synthetic])).success, true)
    assert.ok((await ipc('proxyGetAccounts')).accounts.some((item) => item.id === synthetic.id))
    assert.equal((await ipc('proxyRefreshModels')).success, true)
    const models = await ipc('proxyGetModels')
    assert.equal(typeof models.success, 'boolean')
    assert.ok(Array.isArray(models.models))
    const available = await ipc('getKiroAvailableModels')
    assert.equal(typeof available.success, 'boolean')
    assert.ok(Array.isArray(available.models))
  } finally {
    await ipc('proxyRemoveAccount', [synthetic.id]).catch(() => undefined)
    await ipc('proxySyncAccounts', [original.accounts]).catch(() => undefined)
  }
})

await test('proxy', 'proxy start/status/stop lifecycle', async () => {
  const before = await ipc('proxyGetStatus')
  assert.equal(typeof before.running, 'boolean')
  if (before.running) return { alreadyRunning: true, port: before.config.port }
  const port = await freePort()
  try {
    const updated = await ipc('proxyUpdateConfig', [{ host: '127.0.0.1', port, enabled: true }])
    assert.equal(updated.success, true, updated.error)
    const started = await ipc('proxyStart', [{ host: '127.0.0.1', port, enabled: true }])
    assert.equal(started.success, true, started.error)
    const status = await ipc('proxyGetStatus')
    assert.equal(status.running, true)
    assert.equal(status.config.port, port)
    assert.equal(typeof (await ipc('proxyNeedsRestart')).needsRestart, 'boolean')
    assert.equal((await ipc('proxyRestart')).success, true)
    assert.equal((await ipc('proxyGetStatus')).running, true)
  } finally {
    await ipc('proxyStop').catch(() => undefined)
    await ipc('proxyUpdateConfig', [{ host: before.config.host, port: before.config.port, enabled: before.config.enabled }]).catch(() => undefined)
  }
  return { port }
})

await test('kproxy', 'K-Proxy identity, certificate and lifecycle', async () => {
  const before = await ipc('kproxyGetStatus')
  const generated = await ipc('kproxyGenerateDeviceId')
  assert.equal(generated.success, true)
  assert.equal((await ipc('kproxySetDeviceId', [generated.deviceId])).success, true)
  assert.equal((await ipc('kproxyAddDeviceMapping', [{ accountId: 'e2e-fullsuite', deviceId: generated.deviceId }])).success, true)
  assert.ok((await ipc('kproxyGetDeviceMappings')).mappings.some((item) => item.accountId === 'e2e-fullsuite'))
  assert.equal((await ipc('kproxySwitchToAccount', ['e2e-fullsuite'])).success, true)
  const init = await ipc('kproxyInit')
  assert.equal(init.success, true, init.error)
  const cert = await ipc('kproxyGetCaCert')
  assert.equal(cert.success, true, cert.error)
  const exported = await ipc('kproxyExportCaCert', [path.resolve('.web-data-dev/e2e-kproxy-ca.crt')])
  assert.equal(exported.success, true, exported.error)
  assert.equal(typeof (await ipc('kproxyCheckCaCertInstalled')).installed, 'boolean')
  assert.equal((await ipc('kproxyResetStats')).success, true)
  if (before.running) return { alreadyRunning: true }
  const port = await freePort()
  try {
    assert.equal((await ipc('kproxyUpdateConfig', [{ host: '127.0.0.1', port }])).success, true)
    const started = await ipc('kproxyStart', [{ host: '127.0.0.1', port }])
    assert.equal(started.success, true, started.error)
    assert.equal((await ipc('kproxyGetStatus')).running, true)
  } finally {
    await ipc('kproxyStop').catch(() => undefined)
    await ipc('kproxyUpdateConfig', [{ host: before.config.host, port: before.config.port }]).catch(() => undefined)
  }
  return { port }
})

async function loginUi(page) {
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' })
  if (await page.locator('nav').first().isVisible().catch(() => false)) return
  const emailField = page.locator('#email')
  if (await emailField.count()) await emailField.fill(adminEmail)
  await page.locator('#password').fill(adminPassword)
  await page.locator('form button[type="submit"]').click()
  await page.locator('nav').waitFor({ timeout: 15000 })
}

const viBatch = {
  title: 'Đăng ký hàng loạt',
  start: 'Bắt đầu hàng loạt',
  stop: 'Dừng hàng loạt',
  pause: 'Tạm dừng',
  resume: 'Tiếp tục',
  autoImport: 'Tự nhập',
  imported: 'Đã nhập',
  importFailed: 'Nhập thất bại',
  count: 'Số lượng',
  interval: 'Khoảng cách (giây)',
  retries: 'Số lần thử lại',
  concurrency: 'Số luồng',
  progress: (done, total) => `Tiến độ: ${done}/${total}`,
  success: (count) => `Thành công: ${count}`,
  failed: (count) => `Thất bại: ${count}`
}

function viBatchLabel(label) {
  return {
    Count: viBatch.count,
    'Interval (s)': viBatch.interval,
    Retries: viBatch.retries,
    Concurrency: viBatch.concurrency
  }[label] || label
}

async function findBatchStartButton(page) {
  const buttons = page.locator('main button')
  const count = await buttons.count()
  for (let index = 0; index < count; index++) {
    const button = buttons.nth(index)
    const text = ((await button.textContent()) || '').trim()
    if (text === viBatch.start) return button
  }
  throw new Error(`Batch start button not found: ${viBatch.start}`)
}

async function clickBatchStart(page) {
  await waitFor(async () => !(await (await findBatchStartButton(page)).isDisabled()), 10000, 100)
  await (await findBatchStartButton(page)).click()
}

async function waitForBatchStartButton(page, timeoutMs = 10000) {
  await waitFor(async () => {
    try {
      return await (await findBatchStartButton(page)).isVisible()
    } catch {
      return false
    }
  }, timeoutMs, 100)
}

await test('ui', 'all application pages render without a page crash', async () => {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(printable(error)))
  try {
    await loginUi(page)
    const navButtons = page.locator('nav button')
    const renderedPages = await navButtons.count()
    assert.ok(renderedPages >= 15, `Expected at least 15 application pages, got ${renderedPages}`)
    for (let index = 0; index < renderedPages; index++) {
      await navButtons.nth(index).click()
      await page.waitForTimeout(500)
      await waitFor(async () => (await page.locator('main').innerText()).trim().length > 5, 5000, 100)
      const text = (await page.locator('main').innerText()).trim()
      assert.ok(text.length > 5, `Page ${index} rendered blank`)
    }
    assert.deepEqual(pageErrors, [])
    return { renderedPages }
  } finally {
    await context.close()
    await browser.close()
  }
})

await test('batch', 'controlled batch retry, concurrency, pause, resume, stop and auto-import', async () => {
  const originalData = JSON.parse(JSON.stringify(await ipc('loadAccounts')))
  const seededData = JSON.parse(JSON.stringify(originalData))
  seededData.proxyPool = {}
  seededData.proxyPoolConfig = { ...(seededData.proxyPoolConfig || {}), enabled: false }
  seededData.proxyPoolCursor = 0
  seededData.autoRefreshEnabled = false
  seededData.autoRefreshSyncInfo = false
  await ipc('saveAccounts', [seededData])
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await context.addInitScript(() => {
    localStorage.setItem('kiro-register-config', JSON.stringify({
      mode: 'tingamefi',
      batchCount: 4,
      batchInterval: 0,
      batchAutoImport: false,
      batchRetries: 1,
      batchConcurrency: 2,
      autoFetchProLink: false,
      tingamefiMailApiUrl: 'https://mail.invalid',
      tingamefiMailAdminPassword: 'controlled-test',
      tingamefiMailDomain: 'example.invalid'
    }))
    localStorage.setItem('kiro-register-ratelimit-enabled', '0')
    localStorage.setItem('kiro-register-dailyquota-limit', '0')
  })
  const page = await context.newPage()
  const state = {
    scenario: 'retry',
    calls: 0,
    active: 0,
    maxActive: 0,
    attempts: new Map(),
    retryTaskId: '',
    cancelCalls: 0,
    verifyCalls: 0,
    livenessCalls: 0,
    blockedSaveCalls: 0
  }
  await page.route('**/api/ipc', async (route) => {
    const body = route.request().postDataJSON?.()
    if (body?.method === 'networkRouteValidate') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, latencyMs: 10, externalIp: '192.0.2.10', route: 'direct-or-vpn' })
      })
      return
    }
    if ((state.scenario === 'autoimport' || state.scenario === 'autoimportBlocked') && body?.method === 'verifyAccountCredentials') {
      state.verifyCalls++
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            accessToken: 'controlled-access-token',
            refreshToken: 'controlled-refresh-token',
            expiresIn: 3600,
            email: 'autoimport@example.invalid',
            userId: 'controlled-user',
            subscriptionType: 'Free',
            subscriptionTitle: 'Free Tier',
            usage: { current: 0, limit: 50 }
          }
        })
      })
      return
    }
    if ((state.scenario === 'autoimport' || state.scenario === 'autoimportBlocked') && body?.method === 'diagnoseAccountLiveness') {
      state.livenessCalls++
      if (state.scenario === 'autoimportBlocked') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            model: 'credential-check',
            content: 'Builder ID model liveness fallback: Kiro did not accept the fixed placeholder profileArn (Auth error 403: {"message":"Your User ID is temporarily suspended","reason":"TEMPORARILY_SUSPENDED"}). Credential and quota check passed for blocked@example.invalid, usage 0/50.'
          })
        })
        return
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          model: 'credential-check',
          content: 'Builder ID model liveness fallback: Kiro did not accept the fixed placeholder profileArn (API error 400: {"message":"profileArn is required for this request.","reason":null}). Credential and quota check passed for autoimport@example.invalid, usage 0/50.'
        })
      })
      return
    }
    if ((state.scenario === 'autoimport' || state.scenario === 'autoimportBlocked') && body?.method === 'saveAccounts') {
      const savedAccountsText = JSON.stringify(body.args?.[0]?.accounts || {})
      if (state.scenario === 'autoimport' || savedAccountsText.includes('blocked@example.invalid')) {
        state.blockedSaveCalls++
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' })
      return
    }
    if (body?.method === 'registrationCancel') {
      state.cancelCalls++
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' })
      return
    }
    if (body?.method !== 'registrationStartAuto') {
      await route.continue()
      return
    }
    const taskId = String(body.args?.[0]?.taskId || `task-${state.calls}`)
    state.calls++
    state.active++
    state.maxActive = Math.max(state.maxActive, state.active)
    const attempt = (state.attempts.get(taskId) || 0) + 1
    state.attempts.set(taskId, attempt)
    if (!state.retryTaskId) state.retryTaskId = taskId
    await new Promise((resolve) => setTimeout(resolve, state.scenario === 'stop' ? 700 : 300))
    state.active--
    const result = state.scenario === 'retry' && taskId === state.retryTaskId && attempt === 1
      ? { success: true, result: { status: 'failed', email: 'retry@example.invalid', error: 'network timeout' } }
      : (state.scenario === 'autoimport' || state.scenario === 'autoimportBlocked')
        ? {
            success: true,
            result: {
              status: 'success',
              email: state.scenario === 'autoimportBlocked' ? 'blocked@example.invalid' : 'autoimport@example.invalid',
              password: 'controlled',
              refreshToken: 'controlled-refresh-token',
              clientId: 'controlled-client-id',
              clientSecret: 'controlled-client-secret',
              accessToken: 'controlled-access-token',
              region: 'us-east-1',
              verify: {
                alive: true,
                email: state.scenario === 'autoimportBlocked' ? 'blocked@example.invalid' : 'autoimport@example.invalid',
                subscription: 'KIRO FREE',
                credit_used: 0,
                credit_limit: 50
              }
            }
          }
        : { success: true, result: { status: 'success', email: `${taskId}@example.invalid`, password: 'controlled' } }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(result) })
  })

  async function setBatchField(label, value) {
    const input = page.getByText(viBatchLabel(label), { exact: true }).locator('..').locator('input')
    await input.fill(String(value))
  }

  try {
    await loginUi(page)
    await page.locator('nav button').nth(7).click()
    await page.getByText(viBatch.title, { exact: true }).waitFor()
    await setBatchField('Count', 4)
    await setBatchField('Interval (s)', 0)
    await setBatchField('Retries', 1)
    await setBatchField('Concurrency', 2)
    await clickBatchStart(page)
    await page.getByText(viBatch.progress(4, 4), { exact: true }).waitFor({ timeout: 25000 })
    assert.equal(state.calls, 5)
    assert.equal(state.attempts.get(state.retryTaskId), 2)
    assert.equal(state.maxActive, 2)
    assert.ok(await page.getByText(viBatch.success(4), { exact: true }).isVisible())
    assert.ok(await page.getByText(viBatch.failed(0), { exact: true }).isVisible())

    state.scenario = 'stop'
    state.calls = 0
    state.active = 0
    state.maxActive = 0
    state.attempts = new Map()
    state.retryTaskId = ''
    await setBatchField('Count', 5)
    await setBatchField('Retries', 0)
    await setBatchField('Concurrency', 1)
    await clickBatchStart(page)
    await waitFor(() => state.calls >= 1)
    const callsAtPause = state.calls
    await page.getByRole('button', { name: viBatch.pause }).click()
    await page.waitForTimeout(1000)
    assert.ok(state.calls <= callsAtPause + 1, `Pause allowed too many tasks to launch: before=${callsAtPause}, after=${state.calls}`)
    assert.ok(state.calls < 5, `Pause did not stop the batch before all tasks launched: ${state.calls}`)
    await page.getByRole('button', { name: viBatch.resume }).click()
    await waitFor(() => state.calls >= Math.min(2, callsAtPause + 1))
    await page.getByRole('button', { name: viBatch.stop }).click()
    await waitForBatchStartButton(page)
    assert.ok(state.calls < 5, `Stop launched all ${state.calls} tasks`)
    assert.ok(state.cancelCalls >= 1)

    state.scenario = 'autoimport'
    state.calls = 0
    state.active = 0
    state.maxActive = 0
    state.attempts = new Map()
    state.retryTaskId = ''
    const autoImportSwitch = page.getByText(viBatch.autoImport, { exact: true }).locator('..').locator('..').locator('button[role="switch"]')
    if ((await autoImportSwitch.getAttribute('data-state')) !== 'checked') await autoImportSwitch.click()
    await setBatchField('Count', 1)
    await setBatchField('Retries', 0)
    await setBatchField('Concurrency', 1)
    await clickBatchStart(page)
    await page.getByText(viBatch.progress(1, 1), { exact: true }).waitFor({ timeout: 10000 })
    await page.getByText(viBatch.imported, { exact: true }).first().waitFor({ timeout: 10000 })
    assert.equal(state.verifyCalls, 0)
    assert.equal(state.livenessCalls, 1)

    state.scenario = 'autoimportBlocked'
    state.calls = 0
    state.active = 0
    state.maxActive = 0
    state.attempts = new Map()
    state.retryTaskId = ''
    state.verifyCalls = 0
    state.livenessCalls = 0
    state.blockedSaveCalls = 0
    await clickBatchStart(page)
    await page.getByText(viBatch.progress(1, 1), { exact: true }).waitFor({ timeout: 10000 })
    await page.getByText(viBatch.importFailed, { exact: true }).first().waitFor({ timeout: 10000 })
    assert.equal(state.verifyCalls, 0)
    assert.equal(state.livenessCalls, 1)
    assert.equal(state.blockedSaveCalls, 0)

    return {
      retryCalls: 5,
      maxConcurrency: 2,
      stopLaunched: 2,
      cancelCalls: state.cancelCalls,
      autoImportVerified: true,
      blockedSuspendedImport: true
    }
  } finally {
    await context.close()
    await browser.close()
    await ipc('saveAccounts', [originalData]).catch(() => undefined)
    accountData = undefined
  }
})

await test('batch', 'terminal 403 stops batch without retrying or launching remaining items', async () => {
  const originalData = JSON.parse(JSON.stringify(await ipc('loadAccounts')))
  const seededData = JSON.parse(JSON.stringify(originalData))
  seededData.proxyPool = {}
  seededData.proxyPoolConfig = { ...(seededData.proxyPoolConfig || {}), enabled: false }
  seededData.proxyPoolCursor = 0
  seededData.autoRefreshEnabled = false
  seededData.autoRefreshSyncInfo = false
  await ipc('saveAccounts', [seededData])
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await context.addInitScript(() => {
    localStorage.setItem('kiro-register-config', JSON.stringify({
      mode: 'tingamefi',
      batchCount: 4,
      batchInterval: 0,
      batchAutoImport: false,
      batchRetries: 2,
      batchConcurrency: 1,
      autoFetchProLink: false,
      tingamefiMailApiUrl: 'https://mail.invalid',
      tingamefiMailAdminPassword: 'controlled-test',
      tingamefiMailDomain: 'example.invalid'
    }))
    localStorage.setItem('kiro-register-ratelimit-enabled', '0')
    localStorage.setItem('kiro-register-dailyquota-limit', '0')
  })
  const page = await context.newPage()
  const state = { calls: 0, cancelCalls: 0 }
  await page.route('**/api/ipc', async (route) => {
    const body = route.request().postDataJSON?.()
    if (body?.method === 'networkRouteValidate') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, latencyMs: 10, externalIp: '198.51.100.10', route: 'direct-or-vpn' })
      })
      return
    }
    if (body?.method === 'registrationCancel') {
      state.cancelCalls++
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' })
      return
    }
    if (body?.method !== 'registrationStartAuto') {
      await route.continue()
      return
    }
    state.calls++
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        result: {
          status: 'failed',
          email: 'blocked@example.invalid',
          error: 'usage query failed (https://q.us-east-1.amazonaws.com/getUsageLimits -> 403: TEMPORARILY_SUSPENDED)'
        }
      })
    })
  })

  async function setBatchField(label, value) {
    const input = page.getByText(viBatchLabel(label), { exact: true }).locator('..').locator('input')
    await input.fill(String(value))
  }

  try {
    await loginUi(page)
    await page.locator('nav button').nth(7).click()
    await page.getByText(viBatch.title, { exact: true }).waitFor()
    await setBatchField('Count', 4)
    await setBatchField('Interval (s)', 0)
    await setBatchField('Retries', 2)
    await setBatchField('Concurrency', 1)
    await clickBatchStart(page)
    await waitForBatchStartButton(page)
    assert.equal(state.calls, 1)
    assert.ok(state.cancelCalls >= 1)
    assert.ok(await page.getByText(viBatch.failed(1), { exact: true }).isVisible())
    assert.ok(await page.getByText(viBatch.progress(1, 4), { exact: true }).isVisible())
    return { registrationStartAutoCalls: state.calls, cancelCalls: state.cancelCalls }
  } finally {
    await context.close()
    await browser.close()
    await ipc('saveAccounts', [originalData]).catch(() => undefined)
    accountData = undefined
  }
})

await test('batch', 'TES/BLOCKED SendOTP error stops batch without retrying or launching remaining items', async () => {
  const originalData = JSON.parse(JSON.stringify(await ipc('loadAccounts')))
  const seededData = JSON.parse(JSON.stringify(originalData))
  seededData.proxyPool = {}
  seededData.proxyPoolConfig = { ...(seededData.proxyPoolConfig || {}), enabled: false }
  seededData.proxyPoolCursor = 0
  seededData.autoRefreshEnabled = false
  seededData.autoRefreshSyncInfo = false
  await ipc('saveAccounts', [seededData])
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await context.addInitScript(() => {
    localStorage.setItem('kiro-register-config', JSON.stringify({
      mode: 'tingamefi',
      batchCount: 4,
      batchInterval: 0,
      batchAutoImport: false,
      batchRetries: 2,
      batchConcurrency: 1,
      autoFetchProLink: false,
      tingamefiMailApiUrl: 'https://mail.invalid',
      tingamefiMailAdminPassword: 'controlled-test',
      tingamefiMailDomain: 'example.invalid'
    }))
    localStorage.setItem('kiro-register-ratelimit-enabled', '0')
    localStorage.setItem('kiro-register-dailyquota-limit', '0')
  })
  const page = await context.newPage()
  const state = { calls: 0, cancelCalls: 0 }
  await page.route('**/api/ipc', async (route) => {
    const body = route.request().postDataJSON?.()
    if (body?.method === 'networkRouteValidate') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, latencyMs: 10, externalIp: '198.51.100.20', route: 'direct-or-vpn' })
      })
      return
    }
    if (body?.method === 'registrationCancel') {
      state.cancelCalls++
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' })
      return
    }
    if (body?.method !== 'registrationStartAuto') {
      await route.continue()
      return
    }
    state.calls++
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        result: {
          status: 'failed',
          email: 'tes-blocked@example.invalid',
          error: '[SendOTP] Gửi mã xác minh thất bại (400), body: {"errorCode":"BLOCKED","message":"Request was blocked by TES."}'
        }
      })
    })
  })

  async function setBatchField(label, value) {
    const input = page.getByText(viBatchLabel(label), { exact: true }).locator('..').locator('input')
    await input.fill(String(value))
  }

  try {
    await loginUi(page)
    await page.locator('nav button').nth(7).click()
    await page.getByText(viBatch.title, { exact: true }).waitFor()
    await setBatchField('Count', 4)
    await setBatchField('Interval (s)', 0)
    await setBatchField('Retries', 2)
    await setBatchField('Concurrency', 1)
    await clickBatchStart(page)
    await waitForBatchStartButton(page)
    assert.equal(state.calls, 1)
    assert.ok(state.cancelCalls >= 1)
    assert.ok(await page.getByText(viBatch.failed(1), { exact: true }).isVisible())
    assert.ok(await page.getByText(viBatch.progress(1, 4), { exact: true }).isVisible())
    await page.getByText('AWS/Kiro da chan yeu cau dang ky').waitFor({ timeout: 10000 })
    await page.getByText('Request was blocked by TES').first().waitFor({ timeout: 10000 })
    return { registrationStartAutoCalls: state.calls, cancelCalls: state.cancelCalls, diagnosisVisible: true }
  } finally {
    await context.close()
    await browser.close()
    await ipc('saveAccounts', [originalData]).catch(() => undefined)
    accountData = undefined
  }
})

await test('batch', 'empty enabled proxy pool blocks batch before launching items', async () => {
  const originalData = JSON.parse(JSON.stringify(await ipc('loadAccounts')))
  const seededData = JSON.parse(JSON.stringify(originalData))
  seededData.proxyPool = {}
  seededData.proxyPoolConfig = {
    ...(seededData.proxyPoolConfig || {}),
    enabled: true,
    strategy: 'round_robin',
    validateOnStartup: false,
    autoDisableDead: true,
    failureThreshold: 3,
    testUrl: 'https://api.ipify.org?format=json',
    testTimeoutMs: 8000,
    autoValidateIntervalMin: 0,
    autoValidateConcurrency: 5,
    upstreamProxy: ''
  }
  seededData.proxyPoolCursor = 0
  seededData.autoRefreshEnabled = false
  seededData.autoRefreshSyncInfo = false
  await ipc('saveAccounts', [seededData])

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await context.addInitScript(() => {
    localStorage.setItem('kiro-register-config', JSON.stringify({
      mode: 'tingamefi',
      batchCount: 5,
      batchInterval: 0,
      batchAutoImport: false,
      batchRetries: 0,
      batchConcurrency: 1,
      autoFetchProLink: false,
      tingamefiMailApiUrl: 'https://mail.invalid',
      tingamefiMailAdminPassword: 'controlled-test',
      tingamefiMailDomain: 'example.invalid'
    }))
    localStorage.setItem('kiro-register-ratelimit-enabled', '0')
    localStorage.setItem('kiro-register-dailyquota-limit', '0')
  })
  const page = await context.newPage()
  const state = { calls: 0 }
  await page.route('**/api/ipc', async (route) => {
    const body = route.request().postDataJSON?.()
    if (body?.method === 'registrationStartAuto') {
      state.calls++
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: false, error: 'should not launch' }) })
      return
    }
    await route.continue()
  })

  try {
    await loginUi(page)
    await page.locator('nav button').nth(7).click()
    await page.getByText(viBatch.title, { exact: true }).waitFor()
    await clickBatchStart(page)
    await page.waitForTimeout(500)
    assert.equal(state.calls, 0)
    await waitForBatchStartButton(page)
    assert.equal(await page.getByText(/Tiến độ:/).count(), 0)
    return { registrationStartAutoCalls: state.calls }
  } finally {
    await context.close()
    await browser.close()
    await ipc('saveAccounts', [originalData]).catch(() => undefined)
    accountData = undefined
  }
})

await test('batch', 'controlled proxy pool is passed to auto registration', async () => {
  const originalData = JSON.parse(JSON.stringify(await ipc('loadAccounts')))
  const proxyUrl = 'http://user-{session}:pass@proxy.example.invalid:18080'
  const seededData = JSON.parse(JSON.stringify(originalData))
  seededData.proxyPool = {
    'e2e-proxy-session': {
      id: 'e2e-proxy-session',
      url: proxyUrl,
      protocol: 'http',
      host: 'proxy.example.invalid',
      port: 18080,
      username: 'user-{session}',
      password: 'pass',
      label: 'e2e session proxy',
      source: 'e2e',
      status: 'alive',
      usedCount: 0,
      failCount: 0,
      enabled: true,
      createdAt: Date.now()
    }
  }
  seededData.proxyPoolConfig = {
    enabled: true,
    strategy: 'round_robin',
    validateOnStartup: false,
    autoDisableDead: true,
    failureThreshold: 3,
    testUrl: 'https://api.ipify.org?format=json',
    testTimeoutMs: 8000,
    autoValidateIntervalMin: 0,
    autoValidateConcurrency: 5,
    upstreamProxy: ''
  }
  seededData.proxyPoolCursor = 0
  seededData.autoRefreshEnabled = false
  seededData.autoRefreshSyncInfo = false
  await ipc('saveAccounts', [seededData])

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await context.addInitScript(() => {
    localStorage.setItem('kiro-register-config', JSON.stringify({
      mode: 'tingamefi',
      batchCount: 1,
      batchInterval: 0,
      batchAutoImport: false,
      batchRetries: 0,
      batchConcurrency: 1,
      autoFetchProLink: false,
      tingamefiMailApiUrl: 'https://mail.invalid',
      tingamefiMailAdminPassword: 'controlled-test',
      tingamefiMailDomain: 'example.invalid'
    }))
    localStorage.setItem('kiro-register-ratelimit-enabled', '0')
    localStorage.setItem('kiro-register-dailyquota-limit', '0')
  })
  const page = await context.newPage()
  const state = { calls: 0, registrationConfig: null }
  await page.route('**/api/ipc', async (route) => {
    const body = route.request().postDataJSON?.()
    if (body?.method === 'proxyPoolValidate') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, latencyMs: 12, externalIp: '203.0.113.10' })
      })
      return
    }
    if (body?.method === 'networkRouteValidate') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, latencyMs: 10, externalIp: '203.0.113.10', route: 'direct-or-vpn' })
      })
      return
    }
    if (body?.method !== 'registrationStartAuto') {
      await route.continue()
      return
    }
    state.calls++
    state.registrationConfig = body.args?.[0] || null
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        result: {
          status: 'success',
          email: 'proxy-auto@example.invalid',
          password: 'controlled'
        }
      })
    })
  })

  try {
    await loginUi(page)
    await page.locator('nav button').nth(7).click()
    await page.getByText(viBatch.title, { exact: true }).waitFor()
    await clickBatchStart(page)
    await page.getByText(viBatch.progress(1, 1), { exact: true }).waitFor({ timeout: 10000 })
    assert.equal(state.calls, 1)
    assert.equal(state.registrationConfig?.strictProxy, true)
    assert.equal(state.registrationConfig?.useTingamefiMail, true)
    assert.match(String(state.registrationConfig?.proxy || ''), /^http:\/\/user-[A-Za-z0-9]{8}:pass@proxy\.example\.invalid:18080$/)
    assert.doesNotMatch(String(state.registrationConfig?.proxy || ''), /\{session\}/)
    return {
      strictProxy: state.registrationConfig.strictProxy,
      proxy: String(state.registrationConfig.proxy).replace(/:([^:@/]+)@/, ':***@')
    }
  } finally {
    await context.close()
    await browser.close()
    await ipc('saveAccounts', [originalData]).catch(() => undefined)
    accountData = undefined
  }
})

await test('batch', 'client proxy source is passed to auto registration in strict mode', async () => {
  const originalData = JSON.parse(JSON.stringify(await ipc('loadAccounts')))
  const seededData = JSON.parse(JSON.stringify(originalData))
  seededData.proxyPool = {}
  seededData.proxyPoolConfig = { ...(seededData.proxyPoolConfig || {}), enabled: false }
  seededData.proxyPoolCursor = 0
  seededData.autoRefreshEnabled = false
  seededData.autoRefreshSyncInfo = false
  await ipc('saveAccounts', [seededData])

  const clientProxyUrl = 'http://client-{session}:pass@127.0.0.1:19090'
  const clientUpstream = 'http://upstream.example.invalid:18080'
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await context.addInitScript(({ clientProxyUrl, clientUpstream }) => {
    localStorage.setItem('kiro-register-config', JSON.stringify({
      mode: 'tingamefi',
      networkSource: 'client-proxy',
      clientProxyUrl,
      clientProxyUpstream: clientUpstream,
      batchCount: 1,
      batchInterval: 0,
      batchAutoImport: false,
      batchRetries: 0,
      batchConcurrency: 1,
      autoFetchProLink: false,
      tingamefiMailApiUrl: 'https://mail.invalid',
      tingamefiMailAdminPassword: 'client-route-test',
      tingamefiMailDomain: 'example.invalid'
    }))
    localStorage.setItem('kiro-register-ratelimit-enabled', '0')
    localStorage.setItem('kiro-register-dailyquota-limit', '0')
  }, { clientProxyUrl, clientUpstream })
  const page = await context.newPage()
  const state = { calls: 0, registrationConfig: null, validatedProxy: null, validatedUpstream: null }
  await page.route('**/api/ipc', async (route) => {
    const body = route.request().postDataJSON?.()
    if (body?.method === 'proxyPoolValidate') {
      state.validatedProxy = body.args?.[0]?.url || null
      state.validatedUpstream = body.args?.[0]?.upstreamProxy || null
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, latencyMs: 12, externalIp: '198.51.100.77', route: 'client-proxy' })
      })
      return
    }
    if (body?.method === 'networkRouteValidate') {
      throw new Error('client proxy mode must not use direct network validation')
    }
    if (body?.method !== 'registrationStartAuto') {
      await route.continue()
      return
    }
    state.calls++
    state.registrationConfig = body.args?.[0] || null
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        result: {
          status: 'success',
          email: 'client-proxy-auto@example.invalid',
          password: 'controlled'
        }
      })
    })
  })

  try {
    await loginUi(page)
    await page.locator('nav button').nth(7).click()
    await page.getByText(viBatch.title, { exact: true }).waitFor()
    await clickBatchStart(page)
    await page.getByText(viBatch.progress(1, 1), { exact: true }).waitFor({ timeout: 10000 })
    assert.equal(state.calls, 1)
    assert.equal(state.registrationConfig?.strictProxy, true)
    assert.equal(state.registrationConfig?.upstreamProxy, clientUpstream)
    assert.match(String(state.registrationConfig?.proxy || ''), /^http:\/\/client-[A-Za-z0-9]{8}:pass@127\.0\.0\.1:19090$/)
    assert.equal(state.validatedUpstream, clientUpstream)
    assert.match(String(state.validatedProxy || ''), /^http:\/\/client-[A-Za-z0-9]{8}:pass@127\.0\.0\.1:19090$/)
    return {
      strictProxy: state.registrationConfig.strictProxy,
      proxy: String(state.registrationConfig.proxy).replace(/:([^:@/]+)@/, ':***@')
    }
  } finally {
    await context.close()
    await browser.close()
    await ipc('saveAccounts', [originalData]).catch(() => undefined)
    accountData = undefined
  }
})

await test('model', 'meaningful model response through account liveness API', async () => {
  const account = await loadActiveAccount()
  const prompt = "Trả lời bằng đúng hai câu tiếng Việt giải thích sự khác nhau giữa HTTP 401 và HTTP 403. Câu thứ hai phải chứa cụm 'authorization policy'."
  const result = await ipc('diagnoseAccountLiveness', [{
    account: livenessAccount(account),
    model: 'claude-sonnet-4.5',
    message: prompt,
    timeoutMs: 60000
  }])
  if (!result.success && /429|too many requests|rate[- ]?limited/i.test(String(result.error || result.content || ''))) {
    skipNow(`External AmazonQ rate limited this live model call: ${String(result.error || '').slice(0, 180)}`)
  }
  assert.equal(result.success, true, result.error)
  assert.ok(result.content.length > 60, 'Model response is too short to be meaningful')
  assert.match(result.content, /401/)
  assert.match(result.content, /403/)
  assert.match(result.content, /authorization policy/i)
  return { model: result.model, latencyMs: result.latencyMs, content: result.content.slice(0, 500), usage: result.usage }
})

skip('registration', 'registrationStartAuto / live mass account creation', 'Not run: it would create third-party AWS/Kiro accounts and can trigger account restrictions.')
skip('accounts', 'backgroundBatchRefresh', 'Not run: may rotate multiple live refresh tokens without returning each new token to this test runner.')
skip('subscription', 'accountGetSubscriptionUrl and accountSetOverage', 'Not run: changes or prepares paid account state.')
skip('kproxy', 'install/uninstall system CA certificate', 'Not run: modifies the host trust store.')
skip('proxy', 'configure external client applications', 'Not run: rewrites user client configuration files.')

await anonymous.dispose()
await api.dispose()

const summary = {
  passed: results.filter((item) => item.status === 'passed').length,
  failed: results.filter((item) => item.status === 'failed').length,
  skipped: results.filter((item) => item.status === 'skipped').length,
  durationMs: Date.now() - startedAt
}
await fs.mkdir(path.dirname(reportPath), { recursive: true })
await fs.writeFile(reportPath, JSON.stringify({ baseURL, startedAt: new Date(startedAt).toISOString(), summary, results }, null, 2))
console.log(`\nSummary: ${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`)
console.log(`Report: ${reportPath}`)
process.exitCode = summary.failed > 0 ? 1 : 0
