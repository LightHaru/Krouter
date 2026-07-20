import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { WebStore } from '../../src/server/store'
import {
  IPLOCATE_PROXY_SOURCE,
  ProxyMaintenanceRuntime,
  parseIplocateProxyList
} from '../../src/server/services/proxyMaintenance'

const originalEnv = {
  KROUTER_DATA_DIR: process.env.KROUTER_DATA_DIR,
  KROUTER_ADMIN_EMAIL: process.env.KROUTER_ADMIN_EMAIL,
  KROUTER_ADMIN_PASSWORD: process.env.KROUTER_ADMIN_PASSWORD
}

const tempDirs: string[] = []

function restoreEnv(key: keyof typeof originalEnv): void {
  const value = originalEnv[key]
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

async function createStore(): Promise<{ store: WebStore; userId: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'krouter-proxy-maintenance-'))
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

afterEach(async () => {
  restoreEnv('KROUTER_DATA_DIR')
  restoreEnv('KROUTER_ADMIN_EMAIL')
  restoreEnv('KROUTER_ADMIN_PASSWORD')

  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('proxy maintenance backend service', () => {
  it('parses and deduplicates IPLocate all-proxies.txt lines', () => {
    const proxies = parseIplocateProxyList(`
      socks5://127.0.0.1:1080
      socks5://127.0.0.1:1080
      http://user:pass@10.0.0.1:8080
      ftp://10.0.0.1:21
      invalid
    `)

    expect(proxies.map((proxy) => proxy.url)).toEqual([
      'socks5://127.0.0.1:1080',
      'http://user:pass@10.0.0.1:8080'
    ])
  })

  it('adds live proxies, retains blocked accounts, and removes only terminal credential failures', async () => {
    const { store, userId } = await createStore()
    await store.setAccountData(userId, {
      accounts: {
        ok: {
          id: 'ok',
          email: 'ok@example.com',
          credentials: { accessToken: 'ok-token', refreshToken: 'ok-refresh', expiresAt: Date.now() + 3600000 },
          maintenanceFailureCount: 1
        },
        suspended: {
          id: 'suspended',
          email: 'suspended@example.com',
          credentials: { accessToken: 'suspended-token', refreshToken: 'suspended-refresh', expiresAt: Date.now() + 3600000 }
        },
        blockedSuccess: {
          id: 'blockedSuccess',
          email: 'blocked-success@example.com',
          status: 'blocked',
          usage: { suspendedAt: Date.now(), suspendReason: 'TEMPORARILY_SUSPENDED' },
          credentials: { accessToken: 'blocked-token', refreshToken: 'blocked-refresh', expiresAt: Date.now() + 3600000 }
        },
        invalid: {
          id: 'invalid',
          email: 'invalid@example.com',
          credentials: { accessToken: 'invalid-token', refreshToken: 'invalid-refresh', expiresAt: Date.now() + 3600000 },
          maintenanceFailureCount: 1
        },
        rateLimited: {
          id: 'rateLimited',
          email: 'rate@example.com',
          credentials: { accessToken: 'rate-token', refreshToken: 'rate-refresh', expiresAt: Date.now() + 3600000 }
        }
      },
      activeAccountId: 'suspended',
      proxyPool: {
        staleSource: {
          id: 'staleSource',
          url: 'http://9.9.9.9:9000',
          protocol: 'http',
          host: '9.9.9.9',
          port: 9000,
          source: IPLOCATE_PROXY_SOURCE,
          status: 'alive',
          usedCount: 0,
          failCount: 0,
          enabled: true,
          createdAt: Date.now()
        },
        deadSource: {
          id: 'deadSource',
          url: 'http://3.3.3.3:8000',
          protocol: 'http',
          host: '3.3.3.3',
          port: 8000,
          source: IPLOCATE_PROXY_SOURCE,
          status: 'alive',
          usedCount: 0,
          failCount: 0,
          enabled: true,
          createdAt: Date.now()
        },
        manual: {
          id: 'manual',
          url: 'http://8.8.8.8:8080',
          protocol: 'http',
          host: '8.8.8.8',
          port: 8080,
          source: 'manual',
          status: 'alive',
          latencyMs: 250,
          usedCount: 0,
          failCount: 0,
          enabled: true,
          createdAt: Date.now()
        }
      },
      accountProxyBindings: {
        ok: 'staleSource',
        suspended: 'deadSource',
        rateLimited: 'manual'
      },
      proxyPoolConfig: {
        backendMaintenanceEnabled: true,
        backendMaintenanceIntervalMin: 30,
        sourceSyncEnabled: true,
        sourceUrl: 'memory://iplocate',
        sourceValidateConcurrency: 2,
        sourceRemoveDead: true,
        maxUsableLatencyMs: 1000,
        accountHealthCheckEnabled: true,
        accountDeleteDead: true,
        accountFailureThreshold: 2,
        accountCheckConcurrency: 2,
        testUrl: 'https://example.test/ip',
        testTimeoutMs: 1000
      }
    })

    const validateCalls: Array<Record<string, unknown>> = []
    const runtime = new ProxyMaintenanceRuntime(store, userId, () => undefined, {
      fetchSourceText: async () => [
        'http://1.1.1.1:8080',
        'socks5://2.2.2.2:1080',
        'http://3.3.3.3:8000',
        'http://4.4.4.4:8080'
      ].join('\n'),
      validateProxy: async (params) => {
        validateCalls.push(params as unknown as Record<string, unknown>)
        const { url } = params
        return url === 'http://3.3.3.3:8000'
          ? { success: false, error: 'connect timeout' }
          : {
              success: true,
              latencyMs: url.includes('4.4.4.4') ? 1600 : url.includes('2.2.2.2') ? 450 : 120,
              externalIp: '1.1.1.1'
            }
      },
      checkAccount: async (account) => {
        if (account.id === 'suspended') return { success: false, error: { message: 'User ID is temporarily suspended' } }
        if (account.id === 'invalid') return { success: false, error: { message: 'invalid_grant' } }
        if (account.id === 'rateLimited') return { success: false, error: { message: 'Endpoint rate limited on AmazonQ (429)' } }
        return {
          success: true,
          data: {
            status: 'active',
            newCredentials: {
              accessToken: 'ok-token-new',
              expiresAt: Date.now() + 7200000
            }
          }
        }
      }
    })

    const status = await runtime.runNow('test')
    const data = store.getAccountData(userId) as Record<string, any>

    expect(status.proxiesChecked).toBe(4)
    expect(validateCalls).toHaveLength(4)
    expect(validateCalls.every((call) => call.requireAwsSigninRoute === true)).toBe(true)
    expect(status.proxiesAlive).toBe(2)
    expect(status.proxiesAdded).toBe(2)
    expect(status.proxiesRemoved).toBe(2)
    expect(status.accountsChecked).toBe(5)
    expect(status.accountsRemoved).toBe(1)
    expect(Object.keys(data.proxyPool).sort()).toEqual(expect.arrayContaining(['manual']))
    expect(Object.values(data.proxyPool).filter((proxy: any) => proxy.source === IPLOCATE_PROXY_SOURCE)).toHaveLength(2)
    expect(data.proxyPool.staleSource).toBeUndefined()
    expect(data.proxyPool.deadSource).toBeUndefined()
    expect(data.proxyPoolConfig.maxUsableLatencyMs).toBe(1000)
    expect(data.proxyPoolConfig.sourceRemoveDead).toBe(true)
    expect(data.accounts.suspended.status).toBe('blocked')
    expect(data.accounts.suspended.usage.suspendedAt).toBeTypeOf('number')
    expect(data.accounts.suspended.lastError).toContain('temporarily suspended')
    expect(data.accounts.blockedSuccess.status).toBe('blocked')
    expect(data.accounts.blockedSuccess.usage.suspendedAt).toBeTypeOf('number')
    expect(data.accounts.invalid).toBeUndefined()
    expect(data.accounts.rateLimited).toBeTruthy()
    expect(data.accounts.ok.credentials.accessToken).toBe('ok-token-new')
    expect(data.accountProxyBindings.ok).toBeUndefined()
    expect(data.accountProxyBindings.suspended).toBeUndefined()
    expect(data.accountProxyBindings.rateLimited).toBe('manual')
    expect(data.activeAccountId).toBeNull()
    expect(data._deletedAccountIds).toEqual(expect.arrayContaining(['invalid']))
    expect(data._deletedAccountIds).not.toContain('suspended')
    expect(data._deletedProxyIds).toEqual(expect.arrayContaining(['staleSource', 'deadSource']))
  })
})
