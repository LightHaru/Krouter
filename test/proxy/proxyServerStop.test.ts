import { afterEach, describe, expect, it } from 'vitest'
import net from 'net'
import http from 'http'
import { ProxyServer } from '../../src/main/proxy/proxyServer'

/**
 * Bao phủ đường tắt của ProxyServer — trước đây hoàn toàn không có test nào.
 *
 * `stop()` phải: nhả cổng thật, không resolve trước khi listener đóng, không bao giờ treo, và
 * không bị kết nối keep-alive kéo dài tới hết gracefulMs.
 *
 * Lưu ý cho người sửa sau: trong stop(), fallback.close() được gọi HAI lần một cách có chủ đích
 * (xem chú thích tại chỗ) — mỗi lần close() là một lượt closeIdleConnections(). Đừng gộp lại.
 */

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      const port = typeof address === 'object' && address ? address.port : 0
      srv.close(() => resolve(port))
    })
  })
}

const running: ProxyServer[] = []

afterEach(async () => {
  while (running.length) {
    const server = running.pop()
    try {
      await server?.stop(0)
    } catch {
      /* đã dừng rồi */
    }
  }
})

describe('ProxyServer.stop()', () => {
  it('resolve được khi chỉ có listener HTTP', async () => {
    const port = await freePort()
    const server = new ProxyServer({ port, host: '127.0.0.1', apiKey: 'sk-test' })
    running.push(server)

    await server.start()
    expect(server.isRunning()).toBe(true)

    await server.stop(0)
    expect(server.isRunning()).toBe(false)
  })

  it('gọi stop() hai lần không ném lỗi và không treo', async () => {
    const port = await freePort()
    const server = new ProxyServer({ port, host: '127.0.0.1', apiKey: 'sk-test' })
    running.push(server)

    await server.start()
    await server.stop(0)
    // Lần hai: server đã null, phải trả về ngay chứ không treo.
    await expect(server.stop(0)).resolves.toBeUndefined()
  })

  it('cổng được giải phóng sau khi stop(), tức listener thật sự đã đóng', async () => {
    const port = await freePort()
    const server = new ProxyServer({ port, host: '127.0.0.1', apiKey: 'sk-test' })
    running.push(server)

    await server.start()
    await server.stop(0)

    // Bind lại đúng cổng đó: chỉ thành công nếu listener cũ đã nhả thật.
    await expect(
      new Promise<void>((resolve, reject) => {
        const probe = net.createServer()
        probe.once('error', reject)
        probe.listen(port, '127.0.0.1', () => probe.close(() => resolve()))
      })
    ).resolves.toBeUndefined()
  })

  it('kết nối keep-alive không kéo dài stop() tới hết gracefulMs', async () => {
    const port = await freePort()
    const server = new ProxyServer({ port, host: '127.0.0.1', apiKey: 'sk-test' })
    running.push(server)
    await server.start()

    // Client keep-alive giữ socket mở sau khi request xong. Nếu socket đó không được thu hồi,
    // server không phát 'close' và stop() phải đợi hết gracefulMs rồi mới destroy cưỡng bức.
    const agent = new http.Agent({ keepAlive: true })
    await new Promise<void>((resolve) => {
      const req = http.get({ port, host: '127.0.0.1', agent, path: '/health' }, (res) => {
        res.resume()
        res.once('end', () => resolve())
      })
      req.once('error', () => resolve())
    })

    const GRACEFUL_MS = 4000
    const started = Date.now()
    await server.stop(GRACEFUL_MS)
    const elapsed = Date.now() - started
    agent.destroy()

    expect(
      elapsed,
      `stop() mất ${elapsed}ms; sát ${GRACEFUL_MS}ms nghĩa là socket keep-alive không được thu hồi`
    ).toBeLessThan(GRACEFUL_MS / 2)
  })

  it('stop() vẫn kết thúc khi còn kết nối đang mở (không chờ vô hạn)', async () => {
    const port = await freePort()
    const server = new ProxyServer({ port, host: '127.0.0.1', apiKey: 'sk-test' })
    running.push(server)

    await server.start()

    // Mở một kết nối TCP thô và giữ nguyên: nếu stop() chờ nó đóng mới resolve thì sẽ treo.
    // gracefulMs nhỏ để bộ đếm cưỡng bức phá socket.
    const socket = net.connect(port, '127.0.0.1')
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()))

    await expect(server.stop(50)).resolves.toBeUndefined()
    expect(server.isRunning()).toBe(false)
    socket.destroy()
  })
})
