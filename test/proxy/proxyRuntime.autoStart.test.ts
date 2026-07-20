import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { WebStore } from '../../src/server/store'
import { ProxyRuntime } from '../../src/server/services/proxyRuntime'

const originalEnv = {
  KROUTER_DATA_DIR: process.env.KROUTER_DATA_DIR,
  KROUTER_ADMIN_EMAIL: process.env.KROUTER_ADMIN_EMAIL,
  KROUTER_ADMIN_PASSWORD: process.env.KROUTER_ADMIN_PASSWORD
}

const tempDirs: string[] = []
const runtimes: ProxyRuntime[] = []

function restoreEnv(key: keyof typeof originalEnv): void {
  const value = originalEnv[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => {
        if (typeof address === 'object' && address?.port) resolve(address.port)
        else reject(new Error('Could not allocate a free port'))
      })
    })
  })
}

async function createStore(): Promise<{ store: WebStore; userId: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'krouter-proxy-runtime-'))
  tempDirs.push(dir)
  process.env.KROUTER_DATA_DIR = dir
  process.env.KROUTER_ADMIN_EMAIL = 'admin@krouter.local'
  process.env.KROUTER_ADMIN_PASSWORD = 'admin12345'

  const store = new WebStore()
  await store.load()
  const user = store.getUsers()[0]
  if (!user) throw new Error('Test admin user was not created')
  return { store, userId: user.id }
}

function createRuntime(store: WebStore, userId: string): ProxyRuntime {
  const runtime = new ProxyRuntime(store, userId, () => undefined)
  runtimes.push(runtime)
  return runtime
}

beforeEach(() => {
  runtimes.length = 0
})

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.stop().catch(() => undefined)
  }

  restoreEnv('KROUTER_DATA_DIR')
  restoreEnv('KROUTER_ADMIN_EMAIL')
  restoreEnv('KROUTER_ADMIN_PASSWORD')

  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('ProxyRuntime persisted running state', () => {
  it('auto-starts on backend boot when legacy dashboard state was previously running', async () => {
    const { store, userId } = await createStore()
    const port = await getFreePort()

    await store.setUserSetting(userId, 'proxyConfig', {
      enabled: true,
      autoStart: false,
      host: '127.0.0.1',
      port,
      enableMultiAccount: true,
      logRequests: true
    })
    await store.setUserSetting(userId, 'proxyRunning', true)

    const runtime = createRuntime(store, userId)
    const result = await runtime.ensureAutoStarted('test-boot')
    const status = await runtime.getStatus()

    expect(result.success).toBe(true)
    expect(status.running).toBe(true)
    expect(status.config.port).toBe(port)
  })

  it('always auto-starts on backend boot even if the old dashboard state was stopped', async () => {
    const { store, userId } = await createStore()
    const port = await getFreePort()

    await store.setUserSetting(userId, 'proxyConfig', {
      enabled: false,
      autoStart: false,
      host: '127.0.0.1',
      port,
      enableMultiAccount: true,
      logRequests: true
    })
    await store.setUserSetting(userId, 'proxyRunning', false)

    const runtime = createRuntime(store, userId)
    const result = await runtime.ensureAutoStarted('test-boot')
    const status = await runtime.getStatus()

    expect(result.success).toBe(true)
    expect(status.running).toBe(true)
    expect(store.getUserSetting(userId, 'proxyRunning', false)).toBe(true)
  })

  it('normalizes dashboard config updates to the always-on proxy service contract', async () => {
    const { store, userId } = await createStore()
    const port = await getFreePort()
    const runtime = createRuntime(store, userId)

    const result = await runtime.updateConfig({
      host: '127.0.0.1',
      port,
      autoStart: false,
      enabled: false
    })
    const status = await runtime.getStatus()

    expect(result.success).toBe(true)
    expect(status.running).toBe(true)
    expect(store.getUserSetting(userId, 'proxyRunning', false)).toBe(true)
    expect(store.getUserSetting<Record<string, unknown>>(userId, 'proxyConfig', {}).enabled).toBe(true)
    expect(store.getUserSetting<Record<string, unknown>>(userId, 'proxyConfig', {}).autoStart).toBe(true)
  })

  it('keeps direct proxy URL bindings when syncing accounts from the web store', async () => {
    const { store, userId } = await createStore()
    const proxyUrl = 'socks5://127.0.0.1:1080'

    await store.setAccountData(userId, {
      accounts: {
        acc_api_key: {
          id: 'acc_api_key',
          email: 'api-key@example.test',
          status: 'active',
          credentials: {
            accessToken: 'ksk_test_account_key',
            authMethod: 'api_key',
            provider: 'KiroApiKey',
            region: 'us-east-1'
          }
        }
      },
      accountProxyBindings: {
        acc_api_key: proxyUrl
      },
      proxyPool: {}
    })

    const runtime = createRuntime(store, userId)
    const syncResult = runtime.syncAccountsFromStore()
    const synced = runtime.getAccounts().accounts.find((account) => account.id === 'acc_api_key')

    expect(syncResult.accountCount).toBe(1)
    expect(synced?.proxyUrl).toBe(proxyUrl)
  })

  it('does not forward account traffic through a slow or unmeasured pool proxy', async () => {
    const { store, userId } = await createStore()
    const proxyUrl = 'socks5://127.0.0.1:1080'

    await store.setAccountData(userId, {
      accounts: {
        acc_api_key: {
          id: 'acc_api_key',
          email: 'api-key@example.test',
          status: 'active',
          credentials: {
            accessToken: 'ksk_test_account_key',
            authMethod: 'api_key',
            provider: 'KiroApiKey'
          }
        }
      },
      accountProxyBindings: { acc_api_key: 'slow-proxy' },
      proxyPoolConfig: { maxUsableLatencyMs: 1000 },
      proxyPool: {
        'slow-proxy': {
          url: proxyUrl,
          enabled: true,
          status: 'alive',
          latencyMs: 1001
        }
      }
    })

    const runtime = createRuntime(store, userId)
    runtime.syncAccountsFromStore()
    const synced = runtime.getAccounts().accounts.find((account) => account.id === 'acc_api_key')

    expect(synced?.proxyUrl).toBeUndefined()
  })

  it('does not sync blocked or quota-exhausted accounts into the API proxy pool', async () => {
    const { store, userId } = await createStore()
    const futureReset = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    await store.setAccountData(userId, {
      accounts: {
        active: {
          id: 'active',
          email: 'active@example.test',
          status: 'active',
          credentials: { accessToken: 'ksk_active', authMethod: 'api_key', provider: 'KiroApiKey' }
        },
        blocked: {
          id: 'blocked',
          email: 'blocked@example.test',
          status: 'blocked',
          usage: { suspendedAt: Date.now(), suspendReason: 'TEMPORARILY_SUSPENDED' },
          credentials: { accessToken: 'ksk_blocked', authMethod: 'api_key', provider: 'KiroApiKey' }
        },
        quota: {
          id: 'quota',
          email: 'quota@example.test',
          status: 'quota_exhausted',
          usage: { current: 50, limit: 50, quotaExhaustedAt: Date.now(), nextResetDate: futureReset },
          credentials: { accessToken: 'ksk_quota', authMethod: 'api_key', provider: 'KiroApiKey' }
        }
      }
    })

    const runtime = createRuntime(store, userId)
    const syncResult = runtime.syncAccountsFromStore()
    const syncedIds = runtime.getAccounts().accounts.map((account) => account.id)

    expect(syncResult.accountCount).toBe(1)
    expect(syncedIds).toEqual(['active'])
  })

  it('persists legacy suspended-error accounts as blocked and excludes them from the API proxy pool', async () => {
    const { store, userId } = await createStore()

    await store.setAccountData(userId, {
      accounts: {
        active: {
          id: 'active',
          email: 'active@example.test',
          status: 'active',
          credentials: { accessToken: 'ksk_active', authMethod: 'api_key', provider: 'KiroApiKey' }
        },
        legacyBlocked: {
          id: 'legacyBlocked',
          email: 'legacy-blocked@example.test',
          status: 'active',
          lastError: 'Auth error 403: {"message":"Your User ID is temporarily suspended","reason":"TEMPORARILY_SUSPENDED"}',
          credentials: { accessToken: 'ksk_blocked', authMethod: 'api_key', provider: 'KiroApiKey' }
        }
      }
    })

    const runtime = createRuntime(store, userId)
    const syncResult = await runtime.syncAccountsFromStoreAsync()
    const syncedIds = runtime.getAccounts().accounts.map((account) => account.id)
    const data = store.getAccountData(userId) as { accounts?: Record<string, { status?: string; usage?: { suspendedAt?: number } }> }
    const persisted = data.accounts?.legacyBlocked

    expect(syncResult.accountCount).toBe(1)
    expect(syncedIds).toEqual(['active'])
    expect(persisted?.status).toBe('blocked')
    expect(persisted?.usage?.suspendedAt).toBeTypeOf('number')
  })

  it('returns quota-exhausted accounts to the pool after the stored reset date passes', async () => {
    const { store, userId } = await createStore()
    const pastReset = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    await store.setAccountData(userId, {
      accounts: {
        quota: {
          id: 'quota',
          email: 'quota@example.test',
          status: 'quota_exhausted',
          usage: { current: 50, limit: 50, quotaExhaustedAt: Date.now() - 1000, nextResetDate: pastReset },
          credentials: { accessToken: 'ksk_quota', authMethod: 'api_key', provider: 'KiroApiKey' }
        }
      }
    })

    const runtime = createRuntime(store, userId)
    const syncResult = runtime.syncAccountsFromStore()
    const synced = runtime.getAccounts().accounts[0]

    expect(syncResult.accountCount).toBe(1)
    expect(synced?.id).toBe('quota')
    expect(synced?.quotaExhaustedAt).toBeUndefined()
  })
})
