import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import http from 'http'
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
const upstreams: http.Server[] = []

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'krouter-custom-models-'))
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
  for (const upstream of upstreams.splice(0)) {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
  restoreEnv('KROUTER_DATA_DIR')
  restoreEnv('KROUTER_ADMIN_EMAIL')
  restoreEnv('KROUTER_ADMIN_PASSWORD')
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('ProxyRuntime custom models persistence', () => {
  it('persists customModels through updateConfig and reloads them in a fresh runtime', async () => {
    const { store, userId } = await createStore()
    const runtime = createRuntime(store, userId)

    // Use a free port so updateConfig's auto-start doesn't collide with a live
    // server on the default 5580 — the persistence guarantee is independent of it.
    const port = await getFreePort()
    const customModels = [
      { id: 'my-custom-opus', name: 'My Custom Opus', inputTypes: ['TEXT', 'IMAGE'] },
      { id: 'team-internal-model', name: 'Team Internal' }
    ]
    const result = await runtime.updateConfig({ port, customModels } as never)
    expect(result.success).toBe(true)

    // Same runtime reflects the value immediately.
    const status = await runtime.getStatus()
    expect((status.config as { customModels?: unknown[] }).customModels).toEqual(customModels)

    // A brand-new runtime backed by the same store reloads it from disk — this is
    // the "persist vĩnh viễn" guarantee: custom models survive an app restart.
    await runtime.stop().catch(() => undefined)
    const reloaded = createRuntime(store, userId)
    const reloadedStatus = await reloaded.getStatus()
    expect((reloadedStatus.config as { customModels?: unknown[] }).customModels).toEqual(customModels)
  })

  it('defaults customModels to an empty array when never configured', async () => {
    const { store, userId } = await createStore()
    const runtime = createRuntime(store, userId)
    const status = await runtime.getStatus()
    expect((status.config as { customModels?: unknown[] }).customModels).toEqual([])
  })

  it('automatically imports and persists Custom API models during provider creation', async () => {
    const upstreamPort = await getFreePort()
    const upstream = http.createServer((request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/models') {
        response.end(JSON.stringify({ data: [{ id: 'gpt-auto' }, { id: 'reasoner-auto' }] }))
        return
      }
      response.end(JSON.stringify({ error: 'unexpected route' }))
    })
    await new Promise<void>((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve))
    upstreams.push(upstream)

    const { store, userId } = await createStore()
    const runtime = createRuntime(store, userId)
    const proxyPort = await getFreePort()
    const result = await runtime.updateConfig({
      port: proxyPort,
      customApiProviders: [{
        id: 'auto-provider',
        name: 'Auto Provider',
        enabled: true,
        protocol: 'openai',
        apiKey: 'sk-auto',
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        routePrefix: 'auto',
        models: []
      }]
    } as never)

    expect(result.success).toBe(true)
    const status = await runtime.getStatus()
    const providers = (status.config as {
      customApiProviders?: Array<{ models?: string[]; keys?: unknown[]; modelsSyncedAt?: number }>
    }).customApiProviders || []
    expect(providers[0]).toMatchObject({
      models: ['gpt-auto', 'reasoner-auto'],
      keys: [expect.objectContaining({ name: 'Key 1', enabled: true })]
    })
    expect(providers[0].modelsSyncedAt).toEqual(expect.any(Number))

    const catalog = await runtime.getModels()
    expect(catalog.success).toBe(true)
    expect(catalog.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'auto/gpt-auto', supportsThinking: true }),
      expect.objectContaining({ id: 'auto/reasoner-auto', supportsThinking: true })
    ]))

    await runtime.stop()
    const reloaded = createRuntime(store, userId)
    const reloadedStatus = await reloaded.getStatus()
    expect((reloadedStatus.config as {
      customApiProviders?: Array<{ models?: string[] }>
    }).customApiProviders?.[0].models).toEqual(['gpt-auto', 'reasoner-auto'])
  })
})
