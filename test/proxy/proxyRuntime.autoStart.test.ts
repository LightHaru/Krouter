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
  it('auto-starts on backend boot when the web Start Service state was previously running', async () => {
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

  it('does not auto-start after the web Stop Service action persisted the stopped state', async () => {
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
    expect(status.running).toBe(false)
  })

  it('starts immediately when Auto Start is enabled from the web dashboard', async () => {
    const { store, userId } = await createStore()
    const port = await getFreePort()
    const runtime = createRuntime(store, userId)

    const result = await runtime.updateConfig({
      host: '127.0.0.1',
      port,
      autoStart: true,
      enabled: true
    })
    const status = await runtime.getStatus()

    expect(result.success).toBe(true)
    expect(status.running).toBe(true)
    expect(store.getUserSetting(userId, 'proxyRunning', false)).toBe(true)
    expect(store.getUserSetting<Record<string, unknown>>(userId, 'proxyConfig', {}).autoStart).toBe(true)
  })
})
