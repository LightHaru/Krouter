import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { WebStore } from '../../src/server/store'

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'krouter-store-tombstone-'))
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

function accountsOf(store: WebStore, userId: string): Record<string, unknown> {
  const data = store.getAccountData(userId) as { accounts?: Record<string, unknown> } | null
  return data?.accounts || {}
}

afterEach(async () => {
  restoreEnv('KROUTER_DATA_DIR')
  restoreEnv('KROUTER_ADMIN_EMAIL')
  restoreEnv('KROUTER_ADMIN_PASSWORD')

  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('WebStore deletion tombstone enforcement', () => {
  it('drops a tombstoned account even when a stale writer tries to re-add it', async () => {
    const { store, userId } = await createStore()

    // 1. Seed two accounts.
    await store.setAccountData(userId, {
      accounts: {
        a: { id: 'a', email: 'a@example.com' },
        b: { id: 'b', email: 'b@example.com' }
      }
    })
    expect(Object.keys(accountsOf(store, userId)).sort()).toEqual(['a', 'b'])

    // 2. Delete "b" with a tombstone (what saveAccounts persists on removeAccount).
    await store.setAccountData(userId, {
      accounts: { a: { id: 'a', email: 'a@example.com' } },
      _deletedAccountIds: ['b']
    })
    expect(Object.keys(accountsOf(store, userId))).toEqual(['a'])

    // 3. A stale writer (auto-refresh / proxy sync captured a pre-delete snapshot)
    //    writes back BOTH accounts and carries NO tombstone. The disk tombstone must
    //    still win, so "b" stays deleted.
    await store.setAccountData(userId, {
      accounts: {
        a: { id: 'a', email: 'a@example.com' },
        b: { id: 'b', email: 'b@example.com', usage: { current: 191 } }
      }
    })

    expect(Object.keys(accountsOf(store, userId))).toEqual(['a'])
    const data = store.getAccountData(userId) as { _deletedAccountIds?: string[] }
    expect(data._deletedAccountIds).toContain('b')
  })

  it('keeps a duplicate-email account whose id is NOT tombstoned', async () => {
    const { store, userId } = await createStore()

    // Two accounts sharing an email but distinct ids (the real duplicate scenario).
    await store.setAccountData(userId, {
      accounts: {
        dupA: { id: 'dupA', email: 'dup@example.com', usage: { current: 149 } },
        dupB: { id: 'dupB', email: 'dup@example.com', usage: { current: 191 } }
      }
    })

    // Delete only dupB.
    await store.setAccountData(userId, {
      accounts: { dupA: { id: 'dupA', email: 'dup@example.com', usage: { current: 149 } } },
      _deletedAccountIds: ['dupB']
    })

    const remaining = accountsOf(store, userId)
    expect(Object.keys(remaining)).toEqual(['dupA'])
    // dupA (the surviving duplicate) must NOT be dropped by the guard.
    expect(remaining.dupA).toBeTruthy()
  })

  it('unions incoming and on-disk tombstones and caps the list at 5000', async () => {
    const { store, userId } = await createStore()

    // Prime the disk with one tombstone.
    await store.setAccountData(userId, { accounts: {}, _deletedAccountIds: ['old-1'] })

    // A large batch of new tombstones arrives; union must include the old one and
    // stay bounded.
    const many = Array.from({ length: 6000 }, (_, i) => `del-${i}`)
    await store.setAccountData(userId, { accounts: {}, _deletedAccountIds: many })

    const data = store.getAccountData(userId) as { _deletedAccountIds?: string[] }
    const list = data._deletedAccountIds || []
    expect(list.length).toBeLessThanOrEqual(5000)
    // The most recent ids are retained (slice(-5000)).
    expect(list).toContain('del-5999')
  })

  it('is a no-op when there are no tombstones', async () => {
    const { store, userId } = await createStore()
    await store.setAccountData(userId, {
      accounts: { a: { id: 'a', email: 'a@example.com' } }
    })
    expect(Object.keys(accountsOf(store, userId))).toEqual(['a'])
    const data = store.getAccountData(userId) as { _deletedAccountIds?: string[] }
    expect(data._deletedAccountIds ?? []).toEqual([])
  })
})
