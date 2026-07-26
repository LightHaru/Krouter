import { readdirSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * Kiểm tra parity giữa hai bề mặt của cùng một API.
 *
 * Renderer gọi `window.api.X`. Lời gọi đó đi tới ĐÚNG MỘT trong hai nơi:
 *   1. một override trong `src/renderer/src/api/browserApi.ts` (việc chỉ làm được ở trình duyệt:
 *      tải file, mở tab, ...), hoặc
 *   2. Proxy của browserApi chuyển tiếp sang `POST /api/ipc`, nơi `handleIpc()` trong
 *      `src/server/index.ts` phân phối theo tên method.
 *
 * Vì Proxy tự sinh hàm cho BẤT KỲ tên nào, một method gõ sai hoặc chưa hiện thực vẫn biên dịch
 * và vẫn chạy — rồi thất bại lúc runtime với "unsupported method". Repo này đã dính đúng lớp lỗi
 * đó (xem commit "MITMPage dùng handler kproxy thay vì mitm"). Test tĩnh nên bắt trước.
 *
 * Khi thêm method mới: hiện thực ở `handleIpc`, HOẶC override trong browserApi, HOẶC thêm vào
 * allowlist bên dưới kèm lý do. Đừng sửa allowlist chỉ để test xanh.
 */

const repoRoot = resolve(__dirname, '../..')

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), 'utf8')
}

/** Duyệt đệ quy mọi file .ts/.tsx trong renderer. */
function rendererSources(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry)) out.push(readFileSync(full, 'utf8'))
    }
  }
  walk(resolve(repoRoot, 'src/renderer/src'))
  return out
}

/** Mọi tên method mà renderer gọi qua `window.api.X`. */
function rendererCalledMethods(): Set<string> {
  const names = new Set<string>()
  for (const source of rendererSources()) {
    for (const match of source.matchAll(/window\.api\??\.([a-zA-Z][a-zA-Z0-9_]*)/g)) {
      names.add(match[1])
    }
  }
  return names
}

/** Tên method mà handleIpc() của server xử lý. */
function serverIpcMethods(): Set<string> {
  const source = read('src/server/index.ts')
  const start = source.indexOf('async function handleIpc(')
  expect(start, 'không tìm thấy handleIpc() trong src/server/index.ts').toBeGreaterThan(-1)
  return new Set([...source.slice(start).matchAll(/case '([a-zA-Z0-9_]+)'/g)].map((m) => m[1]))
}

/** Method được browserApi xử lý riêng thay vì chuyển tiếp lên backend. */
function browserApiOverrides(): Set<string> {
  const source = read('src/renderer/src/api/browserApi.ts')
  const start = source.indexOf('const browserOverrides')
  expect(start, 'không tìm thấy browserOverrides trong browserApi.ts').toBeGreaterThan(-1)
  const end = source.indexOf('\n}', start)
  const block = source.slice(start, end)
  return new Set([...block.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9_]*)\s*:/gm)].map((m) => m[1]))
}

/** Method khai báo ở cấp cao nhất trong interface `KiroApi` (kiểu của `window.api`). */
function declaredApiMethods(): Set<string> {
  const source = read('src/renderer/src/types/api.d.ts')
  const start = source.indexOf('interface KiroApi {')
  expect(start, 'không tìm thấy interface KiroApi trong api.d.ts').toBeGreaterThan(-1)
  const end = source.indexOf('\n}', start)
  const block = source.slice(start, end)
  // Chỉ lấy khoá thụt đúng 2 dấu cách: khoá lồng sâu hơn thuộc object con, không phải method.
  return new Set([...block.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9_]*)\s*\??\s*:/gm)].map((m) => m[1]))
}

/**
 * Method CỐ Ý không có ở backend lẫn override.
 * Mỗi mục phải nêu rõ vì sao vắng mặt là chấp nhận được.
 */
const ALLOWED_MISSING: Record<string, string> = {
  window: 'namespace lồng cho điều khiển cửa sổ; browserApi override cả object thay vì từng hàm'
}

describe('Parity API giữa renderer và server', () => {
  // Toàn bộ file này dựa trên regex quét mã nguồn. Nếu refactor làm hỏng regex thì các set sẽ
  // rỗng và mọi assert bên dưới xanh một cách vô nghĩa. Chốt chặn dưới để hỏng regex biểu hiện
  // thành test đỏ.
  it('bộ trích xuất thật sự đọc được cả hai bề mặt', () => {
    expect(rendererCalledMethods().size).toBeGreaterThan(50)
    expect(serverIpcMethods().size).toBeGreaterThan(100)
    expect(browserApiOverrides().size).toBeGreaterThan(3)

    for (const method of ['loadAccounts', 'saveAccounts', 'proxyStart', 'proxyGetStatus']) {
      expect(serverIpcMethods(), `server thiếu ${method}`).toContain(method)
    }
  })

  it('mọi method renderer gọi đều có nơi xử lý', () => {
    const handled = new Set([...serverIpcMethods(), ...browserApiOverrides()])
    const missing = [...rendererCalledMethods()]
      // `onX` là listener, đi qua SSE chứ không qua /api/ipc.
      .filter((method) => !/^on[A-Z]/.test(method))
      .filter((method) => !handled.has(method))
      .filter((method) => !(method in ALLOWED_MISSING))
      .sort()

    expect(
      missing,
      'Các method này được renderer gọi nhưng KHÔNG có case trong handleIpc() và KHÔNG có ' +
        'override trong browserApi. Proxy sẽ chuyển tiếp mù lên /api/ipc và người dùng nhận ' +
        'lỗi lúc chạy. Hãy hiện thực ở một trong hai nơi.'
    ).toEqual([])
  })

  it('mọi method đã khai báo trong window.api đều có nơi xử lý', () => {
    // Đây là chiều nguy hiểm hơn chiều trên: method đã nằm trong kiểu thì TypeScript cho gọi
    // thoải mái, IDE gợi ý đầy đủ, nhưng nếu backend không có case và browserApi không override
    // thì nó chỉ chết lúc chạy. Chiều ngược lại (server có case mà kiểu không khai) thì vô hại
    // vì còn CLI và các endpoint HTTP gọi tới.
    const handled = new Set([...serverIpcMethods(), ...browserApiOverrides()])
    const missing = [...declaredApiMethods()]
      .filter((method) => !/^on[A-Z]/.test(method))
      .filter((method) => !handled.has(method))
      .filter((method) => !(method in ALLOWED_MISSING))
      .sort()

    expect(
      missing,
      'Các method này được khai báo trong KiroApi nên renderer gọi được và TypeScript chấp ' +
        'nhận, nhưng không có handler ở server lẫn override ở browserApi — chỉ chết lúc chạy.'
    ).toEqual([])
  })
})
