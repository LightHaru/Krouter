import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Krouter chạy trên HAI runtime dùng chung một bề mặt API cho renderer:
 *  - Electron: `src/preload/index.ts` -> ipcRenderer.invoke -> ipcMain.handle trong `src/main/index.ts`
 *  - Web/headless: `browserApi` Proxy -> POST /api/ipc -> `handleIpc()` trong `src/server/index.ts`
 *
 * Lệch giữa hai bề mặt này là lớp lỗi đã bị lặp nhiều lần trong repo (git log có commit
 * "MITMPage dùng handler kproxy thay vì mitm", và đợt audit tìm thêm 4 trường hợp nữa cùng
 * hình dạng: một fix chỉ áp vào main/index.ts mà không nhân bản sang src/server/services/*).
 * Proxy `on*` của browserApi tự sinh subscriber cho mọi tên nên khoảng trống này TÀNG HÌNH
 * lúc chạy — phải bắt bằng test tĩnh.
 *
 * Khi thêm method mới: hoặc hiện thực ở CẢ HAI runtime, hoặc thêm vào allowlist bên dưới
 * kèm lý do. Không sửa allowlist chỉ để test xanh.
 */

const repoRoot = resolve(__dirname, '../..')

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8')
}

/** Method của preload có gọi ipcRenderer.invoke (tức có request/response, không phải listener). */
function preloadInvokeMethods(): Set<string> {
  const source = read('src/preload/index.ts')
  // Khoá cấp cao nhất của object `api` được thụt đúng 2 dấu cách; khoá lồng bên trong
  // (ví dụ api.window.minimize) thụt 4 nên không khớp.
  const marks = [...source.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9_]*):/gm)].map((m) => ({
    name: m[1],
    index: m.index ?? 0
  }))
  const methods = new Set<string>()
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].index : source.length
    const body = source.slice(marks[i].index, end)
    if (body.includes('ipcRenderer.invoke(')) methods.add(marks[i].name)
  }
  return methods
}

/** Tên method mà handleIpc() của server xử lý. */
function serverIpcMethods(): Set<string> {
  const source = read('src/server/index.ts')
  const start = source.indexOf('async function handleIpc(')
  expect(start, 'không tìm thấy handleIpc() trong src/server/index.ts').toBeGreaterThan(-1)
  return new Set([...source.slice(start).matchAll(/case '([a-zA-Z0-9_]+)'/g)].map((m) => m[1]))
}

/** Kênh đã đăng ký bằng ipcMain.handle ở phía Electron. */
function electronHandleChannels(): Set<string> {
  const files = ['src/main/index.ts', 'src/main/ipc/proxyPool.ts', 'src/main/registration/ipc-handlers.ts']
  const channels = new Set<string>()
  for (const file of files) {
    for (const match of read(file).matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) {
      channels.add(match[1])
    }
  }
  return channels
}

/**
 * Method chỉ có ở Electron. Mỗi mục PHẢI được browserApi xử lý riêng (override hoặc báo lỗi
 * rõ ràng) — điều đó được khẳng định bằng một test bên dưới, nên allowlist này không thể
 * dùng để lặng lẽ bỏ qua một method web bị thiếu.
 */
const ELECTRON_ONLY: Record<string, string> = {
  exportToFile: 'Web tải file qua Blob + thẻ <a>, không đi qua backend',
  importFromFile: 'Web đọc file bằng <input type=file>, không đi qua backend',
  openSubscriptionWindow: 'Web mở tab mới bằng window.open',
  downloadUpdate: 'Web ánh xạ sang applyKrouterUpdate',
  installUpdate: 'Web ánh xạ sang applyKrouterUpdate',
  getProactiveRenewalEnabled: 'Gia hạn chủ động của Kiro IDE chỉ có ở bản desktop',
  setProactiveRenewalEnabled: 'Gia hạn chủ động của Kiro IDE chỉ có ở bản desktop',
  window: 'Điều khiển cửa sổ (minimize/maximize/close) không có ý nghĩa trên web'
}

/**
 * Method chỉ có ở server. Renderer PHẢI gọi chúng có bảo vệ (`typeof ... === 'function'`
 * hoặc optional call) vì trên Electron chúng là undefined — cũng được khẳng định bằng test.
 */
const SERVER_ONLY: Record<string, string> = {
  accountSyncGetStatus: 'Mật khẩu đồng bộ giữa các máy chỉ có ở bản web',
  accountSyncGeneratePassword: 'Mật khẩu đồng bộ giữa các máy chỉ có ở bản web',
  accountSyncSetPassword: 'Mật khẩu đồng bộ giữa các máy chỉ có ở bản web',
  mergePeerAccounts: 'Điểm nhận đồng bộ từ peer, chỉ có ở bản web',
  syncAccountsToRemote: 'Đẩy account sang Krouter từ xa, chỉ có ở bản web',
  completeIamSsoLogin: 'Web hoàn tất IAM SSO qua trang callback riêng',
  applyKrouterUpdate: 'Cập nhật gói npm; bản desktop dùng electron-updater',
  installKrouterUpdate: 'Cập nhật gói npm; bản desktop dùng electron-updater',
  proxySyncAccountsFromStore: 'Runtime web tự đồng bộ pool từ store',
  proxyGetBedrockStatus: 'Bảng điều khiển chỉ có ở web',
  proxyMaintenanceGetStatus: 'Bảo trì proxy nền chỉ chạy ở bản server',
  proxyMaintenanceRunNow: 'Bảo trì proxy nền chỉ chạy ở bản server',
  dashboardTunnelGetStatus: 'Tunnel công khai chỉ có ở bản server',
  dashboardTunnelStart: 'Tunnel công khai chỉ có ở bản server',
  dashboardTunnelStop: 'Tunnel công khai chỉ có ở bản server',
  fetchSkillsList: 'Danh mục skill do server phục vụ',
  fetchSkillContent: 'Danh mục skill do server phục vụ',
  proxyGetAccountHealth: 'Bảng điều khiển chỉ có ở web',
  proxyGetQuotaPredictions: 'Bảng điều khiển chỉ có ở web',
  proxyGetEndpointMetrics: 'Bảng điều khiển chỉ có ở web',
  proxyResetEndpointMetrics: 'Bảng điều khiển chỉ có ở web'
}

describe('Parity bề mặt IPC giữa Electron và server', () => {
  // Toàn bộ file này dựa trên regex quét mã nguồn. Nếu một lần refactor làm hỏng regex thì
  // các set sẽ rỗng và MỌI assert bên dưới đều xanh một cách vô nghĩa. Chốt chặn dưới ở đây
  // để hỏng regex biểu hiện thành test đỏ chứ không phải im lặng mất tác dụng.
  it('bộ trích xuất thật sự đọc được cả ba bề mặt', () => {
    expect(preloadInvokeMethods().size).toBeGreaterThan(100)
    expect(serverIpcMethods().size).toBeGreaterThan(100)
    expect(electronHandleChannels().size).toBeGreaterThan(100)
    // Vài tên chắc chắn phải có mặt ở cả hai phía.
    for (const method of ['loadAccounts', 'saveAccounts', 'proxyStart', 'proxyGetStatus']) {
      expect(preloadInvokeMethods(), `preload thiếu ${method}`).toContain(method)
      expect(serverIpcMethods(), `server thiếu ${method}`).toContain(method)
    }
  })

  it('mọi method invoke của preload đều có handler ở server (hoặc nằm trong allowlist)', () => {
    const missing = [...preloadInvokeMethods()]
      .filter((method) => !serverIpcMethods().has(method))
      .filter((method) => !(method in ELECTRON_ONLY))
      .sort()

    expect(
      missing,
      `Các method này gọi được từ renderer nhưng handleIpc() của server không xử lý, nên ` +
        `người dùng bản web sẽ nhận lỗi lúc chạy. Hãy hiện thực chúng trong src/server/index.ts, ` +
        `hoặc thêm vào ELECTRON_ONLY kèm lý do và bổ sung override trong browserApi.`
    ).toEqual([])
  })

  it('mọi method của server đều có ở preload (hoặc nằm trong allowlist)', () => {
    const missing = [...serverIpcMethods()]
      .filter((method) => !preloadInvokeMethods().has(method))
      .filter((method) => !(method in SERVER_ONLY))
      .sort()

    expect(
      missing,
      `Các method này chỉ có ở bản web nên tính năng tương ứng biến mất lặng lẽ trên desktop. ` +
        `Hãy thêm handler Electron + method preload, hoặc thêm vào SERVER_ONLY kèm lý do.`
    ).toEqual([])
  })

  it('mọi method trong ELECTRON_ONLY đều được browserApi xử lý riêng', () => {
    const browserApi = read('src/renderer/src/api/browserApi.ts')
    const unhandled = Object.keys(ELECTRON_ONLY)
      .filter((method) => !new RegExp(`\\b${method}\\s*:`).test(browserApi))
      .sort()

    expect(
      unhandled,
      'browserApi phải override những method này, nếu không Proxy sẽ chuyển tiếp mù sang ' +
        '/api/ipc và server trả về unsupported.'
    ).toEqual([])
  })

  it('renderer phải bảo vệ mọi lời gọi tới method chỉ có ở server', () => {
    const rendererSources = [
      'src/renderer/src/components/proxy/ProxyPanel.tsx',
      'src/renderer/src/components/pages/ProxyPoolPage.tsx',
      'src/renderer/src/components/pages/RegisterPage.tsx',
      'src/renderer/src/components/pages/ProxyPage.tsx',
      'src/renderer/src/components/pages/SkillsPage.tsx'
    ]
      .map((file) => read(file))
      .join('\n')

    const unguarded: string[] = []
    for (const method of Object.keys(SERVER_ONLY)) {
      // Không bảo vệ = gọi thẳng `window.api.method(` mà không có `?.` và không có
      // kiểm tra `typeof ... !== 'function'` ở đâu đó trong cùng nhóm file.
      const directCall = new RegExp(`window\\.api\\.${method}\\s*\\(`).test(rendererSources)
      if (!directCall) continue
      const guarded = new RegExp(`typeof\\s+window\\.api[?.]*\\.?${method}\\s*!==\\s*'function'`).test(rendererSources)
      if (!guarded) unguarded.push(method)
    }

    expect(
      unguarded.sort(),
      'Trên Electron những method này là undefined, nên gọi thẳng sẽ ném TypeError. ' +
        "Hãy bọc bằng `typeof window.api.X !== 'function'` hoặc dùng optional call."
    ).toEqual([])
  })

  it('mọi kênh ipcMain.handle đều được preload phơi ra (không có handler chết)', () => {
    const preload = read('src/preload/index.ts')
    const orphaned = [...electronHandleChannels()]
      .filter((channel) => !preload.includes(`'${channel}'`))
      .sort()

    expect(
      orphaned,
      'Các kênh này được đăng ký ở main nhưng không method preload nào gọi tới — ' +
        'hoặc là code chết, hoặc renderer đang gọi một tên khác.'
    ).toEqual([])
  })
})
