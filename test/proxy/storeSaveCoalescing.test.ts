import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { WebStore } from '../../src/server/store'

/**
 * Đường ghi của WebStore.
 *
 * `recordApiKeyUsage()` bắn onConfigChanged ở cuối MỖI request được proxy, và consumer của nó
 * không chờ kết quả. Nếu lần nào cũng ghi ngay thì mỗi request tốn một lần stringify toàn bộ
 * tài liệu + ghi cả file — đo được ~17 ms trên store 593 KB, nối tiếp qua một hàng đợi duy
 * nhất. `scheduleSave()` gom chúng lại; `save()` giữ nguyên ngữ nghĩa ghi-ngay cho những nơi
 * người dùng đang chờ kết quả.
 */

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'krouter-store-'))
  process.env.KROUTER_DATA_DIR = dir
})

afterEach(() => {
  delete process.env.KROUTER_DATA_DIR
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
})

async function freshStore(): Promise<WebStore> {
  const mod = await import('../../src/server/store')
  const store = new mod.WebStore()
  await store.load()
  return store
}

function readSettings(userId: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')) as {
    settingsByUser: Record<string, Record<string, unknown>>
  }
  return raw.settingsByUser[userId] || {}
}

async function admin(store: WebStore, email: string): Promise<string> {
  const user = await store.createInitialAdmin({ email, password: 'password123' })
  return user.id
}

describe('WebStore: đường ghi', () => {
  it('save() ghi ngay — chuỗi ghi tuần tự không bị cộng thêm độ trễ gom', async () => {
    const store = await freshStore()
    const userId = await admin(store, 'a@test')

    // 10 lần ghi tuần tự có await. Nếu save() bị gom thì mỗi lần phải chờ hết cửa sổ 250 ms,
    // tức tổng ~2500 ms — chính là hồi quy mà thiết kế này tránh.
    const started = Date.now()
    for (let i = 0; i < 10; i++) {
      await store.setUserSetting(userId, 'counter', i)
    }
    const elapsed = Date.now() - started

    expect(readSettings(userId).counter).toBe(9)
    expect(
      elapsed,
      `10 lần setUserSetting mất ${elapsed}ms; nếu save() bị gom thì con số sẽ ~2500ms`
    ).toBeLessThan(1500)
  })

  it('setUserSettingDeferred() gom nhiều lần ghi thành một lần chạm đĩa', async () => {
    const store = await freshStore()
    const userId = await admin(store, 'b@test')
    await store.flush()

    // Đếm số lần thật sự ghi xuống đĩa bằng cách bọc save().
    let writes = 0
    const realSave = store.save.bind(store)
    store.save = async (): Promise<void> => {
      writes++
      return await realSave()
    }

    // 200 lần ghi dồn dập — mô phỏng một chuỗi request proxy.
    for (let i = 0; i < 200; i++) {
      store.setUserSettingDeferred(userId, 'hot', i)
    }
    expect(writes, 'chưa được ghi ngay: phải đợi hết cửa sổ gom').toBe(0)

    // Chờ qua cửa sổ gom rồi kiểm tra: 200 lần ghi chỉ tốn ĐÚNG một lần chạm đĩa.
    await new Promise((r) => setTimeout(r, 400))
    expect(writes, '200 lần ghi phải gom thành 1').toBe(1)
    expect(readSettings(userId).hot).toBe(199)
  })

  it('flush() huỷ lần ghi đang chờ và ghi ngay', async () => {
    const store = await freshStore()
    const userId = await admin(store, 'c@test')

    store.setUserSettingDeferred(userId, 'pending', 'value')
    // Chưa qua cửa sổ gom, nhưng flush() phải đưa dữ liệu xuống đĩa ngay.
    await store.flush()

    expect(readSettings(userId).pending).toBe('value')
  })

  it('save() vẫn bảo đảm dữ liệu đã nằm trên đĩa khi await xong', async () => {
    const store = await freshStore()
    const userId = await admin(store, 'd@test')

    await store.setUserSetting(userId, 'durable', 'yes')

    expect(readSettings(userId).durable).toBe('yes')
  })
})
