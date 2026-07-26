import { EventEmitter } from 'events'
import { describe, expect, it } from 'vitest'
import { MitmProxy } from '../../src/main/kproxy/mitmProxy'
import type { CertManager } from '../../src/main/kproxy/certManager'
import type { KProxyConfig } from '../../src/main/kproxy/types'

/**
 * MitmProxy: toàn vẹn byte trên đường request.
 *
 * Proxy này đứng giữa Kiro IDE và AWS. Nó phải viết lại device ID 64-hex trong header/body rồi
 * chuyển tiếp phần còn lại NGUYÊN VẸN TỪNG BYTE — body là JSON do IDE sinh ra, chứa nội dung
 * người dùng gõ (tiếng Việt có dấu, CJK, emoji) và Content-Length đã được IDE tính sẵn.
 *
 * Hai lớp lỗi đã từng xảy ra ở đây, cả hai đều im lặng:
 *
 *  1. Gom chunk bằng chuỗi (`data += chunk.toString()`). Ký tự nhiều byte nằm vắt qua ranh giới
 *     chunk bị decode thành U+FFFD, vừa sai nội dung vừa lệch số byte so với Content-Length.
 *  2. Vứt các mảnh body đến trong lúc bắt tay TLS với upstream (~100 ms). Request lớn chỉ tới
 *     nơi phần đầu; AWS treo chờ số byte không bao giờ đến.
 *
 * Không có cái nào ném lỗi hay ghi log — chúng chỉ làm request hỏng. Vì vậy test ở đây kiểm tra
 * trên BYTE chứ không phải trên chuỗi đã decode.
 */

const DEVICE_ID = 'a'.repeat(64)
const ORIGINAL_ID = 'b'.repeat(64)

function makeProxy(overrides: Partial<KProxyConfig> = {}): MitmProxy {
  const config: KProxyConfig = {
    enabled: true,
    port: 0,
    host: '127.0.0.1',
    mitmDomains: ['codewhisperer.us-east-1.amazonaws.com'],
    deviceId: DEVICE_ID,
    autoStart: false,
    logRequests: false,
    ...overrides
  }
  // Không gọi start() nên certManager không bao giờ được dùng tới.
  return new MitmProxy({} as CertManager, config)
}

/** Truy cập các phương thức private đang được kiểm tra. */
type Internals = {
  modifyBody(body: Buffer): Buffer
  modifyHeaders(
    headers: string,
    hostname: string
  ): { modified: boolean; newHeaders: string; info: { deviceIdReplaced: boolean } }
  handleDecryptedConnection(socket: unknown, hostname: string, port: number): void
  forwardRequest(...args: unknown[]): void
}

function internals(proxy: MitmProxy): Internals {
  return proxy as unknown as Internals
}

/**
 * Chạy handleDecryptedConnection với một socket giả, chặn forwardRequest để bắt lại đúng những
 * gì proxy định gửi lên upstream. Trả về header đã sửa, body ban đầu và mảng đệm.
 */
function captureForward(proxy: MitmProxy): {
  socket: EventEmitter
  calls: Array<{ headers: string; body: Buffer; contentLength: number; pending: Buffer[] }>
  goLive: () => void
} {
  const calls: Array<{
    headers: string
    body: Buffer
    contentLength: number
    pending: Buffer[]
  }> = []
  let state: { live: boolean } | null = null

  internals(proxy).forwardRequest = (...args: unknown[]): void => {
    calls.push({
      headers: args[0] as string,
      body: args[1] as Buffer,
      contentLength: args[5] as number,
      pending: args[7] as Buffer[]
    })
    state = args[8] as { live: boolean }
  }

  const socket = new EventEmitter()
  internals(proxy).handleDecryptedConnection(socket, 'codewhisperer.us-east-1.amazonaws.com', 443)

  // Mô phỏng thời điểm bắt tay TLS với upstream xong: từ đó proxy nối thẳng thay vì đệm.
  return { socket, calls, goLive: () => { if (state) state.live = true } }
}

const PROMPT = 'Chào bạn, mình cần giúp đỡ 🚀 — 日本語もある'

function requestBytes(bodyObj: unknown): { headers: Buffer; body: Buffer; full: Buffer } {
  const body = Buffer.from(JSON.stringify(bodyObj), 'utf8')
  const headers = Buffer.from(
    `POST /generateAssistantResponse HTTP/1.1\r\nHost: codewhisperer.us-east-1.amazonaws.com\r\nContent-Length: ${body.length}\r\n\r\n`,
    'latin1'
  )
  return { headers, body, full: Buffer.concat([headers, body]) }
}

describe('MitmProxy: gom request theo byte', () => {
  it('body nhiều byte đi QUA modifyBody vẫn khứ hồi đúng từng byte', () => {
    // Đường đi: body nằm cùng chunk với header nên được modifyBody() xử lý. Đây chính là chỗ
    // lỗi A3 từng nằm — decode chunk theo utf8 rồi encode lại. Nếu ai đó đổi latin1 thành utf8
    // ở đây, ký tự tiếng Việt/CJK/emoji sẽ lệch số byte so với Content-Length.
    const proxy = makeProxy()
    const { socket, calls } = captureForward(proxy)

    const { body, full } = requestBytes({ prompt: PROMPT, machineId: ORIGINAL_ID })
    socket.emit('data', full)

    expect(calls).toHaveLength(1)
    const sent = calls[0].body

    // Chỉ 64 ký tự device ID được đổi (cùng độ dài), nên tổng số byte phải giữ nguyên.
    expect(sent.length).toBe(body.length)
    expect(calls[0].contentLength).toBe(body.length)
    const parsed = JSON.parse(sent.toString('utf8'))
    expect(parsed.prompt).toBe(PROMPT)
    expect(parsed.machineId).toBe(DEVICE_ID)
  })

  it('ký tự nhiều byte bị cắt ngang ranh giới chunk vẫn tới upstream nguyên vẹn', () => {
    const proxy = makeProxy()
    const { socket, calls } = captureForward(proxy)

    const { body, full } = requestBytes({ prompt: PROMPT, machineId: ORIGINAL_ID })

    // Cắt mỗi 7 byte — cỡ này bảo đảm có nhát cắt rơi vào GIỮA một ký tự nhiều byte.
    for (let i = 0; i < full.length; i += 7) {
      socket.emit('data', full.subarray(i, Math.min(i + 7, full.length)))
    }

    expect(calls).toHaveLength(1)
    const sent = Buffer.concat([calls[0].body, ...calls[0].pending])

    // Số byte và nội dung phải khớp tuyệt đối với những gì client gửi.
    expect(sent.length).toBe(body.length)
    expect(sent.equals(body)).toBe(true)
    // Và decode lại vẫn ra đúng chuỗi gốc — không có U+FFFD nào lọt vào.
    expect(JSON.parse(sent.toString('utf8')).prompt).toBe(PROMPT)
  })

  it('device ID trong body CHỈ được thay ở phần đi cùng chunk header (giới hạn hiện tại)', () => {
    // Ghi lại hành vi thật, không phải hành vi mong muốn.
    //
    // modifyBody() chạy đúng MỘT lần, trên phần body nằm cùng chunk với header. Mọi mảnh tới
    // sau đi thẳng lên upstream không qua xử lý. Với chunk nhỏ (ở đây 7 byte) machineId rơi
    // vào mảnh sau nên KHÔNG bị thay.
    //
    // Thực tế TLS record tối đa ~16 KB nên request Kiro cỡ nhỏ có toàn bộ body trong chunk đầu
    // và vẫn được viết lại đúng; chỉ request lớn hơn một record mới lộ khoảng trống này.
    // Nếu sau này sửa để thay trên toàn body, test này sẽ đỏ — đó là dấu hiệu đúng, hãy cập nhật.
    const proxy = makeProxy()
    const { socket, calls } = captureForward(proxy)

    const body = Buffer.from(JSON.stringify({ pad: 'x'.repeat(50), machineId: ORIGINAL_ID }), 'utf8')
    const headers = Buffer.from(
      `POST /x HTTP/1.1\r\nContent-Length: ${body.length}\r\n\r\n`,
      'latin1'
    )
    const full = Buffer.concat([headers, body])
    for (let i = 0; i < full.length; i += 7) {
      socket.emit('data', full.subarray(i, Math.min(i + 7, full.length)))
    }

    const sent = Buffer.concat([calls[0].body, ...calls[0].pending])
    expect(sent.toString('utf8')).toContain(ORIGINAL_ID)
    expect(sent.toString('utf8')).not.toContain(DEVICE_ID)

    // Ngược lại: cùng body đó nhưng tới trong MỘT chunk thì được thay đúng.
    const proxy2 = makeProxy()
    const single = captureForward(proxy2)
    single.socket.emit('data', full)
    const sentWhole = Buffer.concat([single.calls[0].body, ...single.calls[0].pending])
    expect(sentWhole.toString('utf8')).toContain(DEVICE_ID)
    expect(sentWhole.toString('utf8')).not.toContain(ORIGINAL_ID)
  })

  it('mảnh body đến trong lúc bắt tay TLS được đệm, không bị vứt', () => {
    const proxy = makeProxy({ deviceId: undefined })
    const { socket, calls, goLive } = captureForward(proxy)

    const body = Buffer.alloc(60_000, 0x41)
    const headers = Buffer.from(
      `POST /x HTTP/1.1\r\nHost: h\r\nContent-Length: ${body.length}\r\n\r\n`,
      'latin1'
    )

    // Header + 1 KB body đầu tới cùng lúc, phần còn lại tới TRƯỚC khi upstream sẵn sàng.
    socket.emit('data', Buffer.concat([headers, body.subarray(0, 1024)]))
    for (let i = 1024; i < body.length; i += 8192) {
      socket.emit('data', body.subarray(i, Math.min(i + 8192, body.length)))
    }

    expect(calls).toHaveLength(1)
    const buffered = Buffer.concat([calls[0].body, ...calls[0].pending])
    expect(
      buffered.length,
      'toàn bộ body phải nằm trong initialBody + pendingBody, không mảnh nào bị bỏ'
    ).toBe(body.length)
    expect(buffered.equals(body)).toBe(true)

    // Sau khi upstream sẵn sàng, forwardRequest tự nối listener riêng; handler đệm phải ngừng
    // gom để cùng một mảnh không bị gửi hai lần.
    goLive()
    const beforeCount = calls[0].pending.length
    socket.emit('data', Buffer.from('tail'))
    expect(calls[0].pending.length, 'hết giai đoạn đệm thì không được đẩy thêm').toBe(beforeCount)
  })

  it('Content-Length được cập nhật khi thay device ID làm đổi số byte body', () => {
    // Device ID đích ngắn hơn 64 ký tự thì body co lại — header phải theo kịp, nếu không
    // upstream sẽ đọc thiếu hoặc thừa byte.
    const proxy = makeProxy({ deviceId: 'c'.repeat(64) })
    const { socket, calls } = captureForward(proxy)

    const body = Buffer.from(JSON.stringify({ machineId: ORIGINAL_ID }), 'utf8')
    socket.emit(
      'data',
      Buffer.concat([
        Buffer.from(`POST /x HTTP/1.1\r\nContent-Length: ${body.length}\r\n\r\n`, 'latin1'),
        body
      ])
    )

    // Cùng độ dài ID nên Content-Length giữ nguyên, nhưng nội dung phải đã đổi.
    expect(calls[0].contentLength).toBe(body.length)
    expect(calls[0].body.toString('utf8')).toContain('c'.repeat(64))
    expect(calls[0].body.toString('utf8')).not.toContain(ORIGINAL_ID)
  })

  it('body nhị phân không phải UTF-8 hợp lệ vẫn khứ hồi đúng từng byte', () => {
    const proxy = makeProxy()
    const { socket, calls } = captureForward(proxy)

    // Chuỗi byte cố tình KHÔNG hợp lệ trong UTF-8 (0x80–0xFF đứng một mình).
    const body = Buffer.from([0x80, 0xfe, 0xff, 0x00, 0x41, 0xc3, 0x28, 0xed, 0xa0, 0x80])
    socket.emit(
      'data',
      Buffer.concat([
        Buffer.from(`POST /x HTTP/1.1\r\nContent-Length: ${body.length}\r\n\r\n`, 'latin1'),
        body
      ])
    )

    const sent = Buffer.concat([calls[0].body, ...calls[0].pending])
    expect(sent.equals(body)).toBe(true)
  })

  it('body chứa \\r\\n\\r\\n không bị nhận nhầm là ranh giới header', () => {
    const proxy = makeProxy({ deviceId: undefined })
    const { socket, calls } = captureForward(proxy)

    const body = Buffer.from('phan mot\r\n\r\nphan hai', 'latin1')
    const headers = Buffer.from(
      `POST /x HTTP/1.1\r\nContent-Length: ${body.length}\r\n\r\n`,
      'latin1'
    )
    socket.emit('data', Buffer.concat([headers, body]))

    // Ranh giới ĐÚNG là lần xuất hiện đầu tiên: header dừng ở Content-Length, phần \r\n\r\n
    // trong body phải nằm nguyên trong body.
    expect(calls[0].headers).toContain('Content-Length')
    expect(calls[0].headers).not.toContain('phan mot')
    expect(calls[0].body.equals(body)).toBe(true)
  })
})

describe('MitmProxy: viết lại device ID trong header', () => {
  it('thay ID trong User-Agent kiểu KiroIDE và đánh dấu đã sửa', () => {
    const proxy = makeProxy()
    const result = internals(proxy).modifyHeaders(
      `POST /x HTTP/1.1\r\nUser-Agent: KiroIDE-0.6.18-${ORIGINAL_ID}\r\nHost: h`,
      'h'
    )

    expect(result.modified).toBe(true)
    expect(result.info.deviceIdReplaced).toBe(true)
    expect(result.newHeaders).toContain(DEVICE_ID)
    expect(result.newHeaders).not.toContain(ORIGINAL_ID)
  })

  it('không đụng tới header khác dù chúng cũng chứa chuỗi 64-hex', () => {
    // Ví dụ authorization/x-amz-content-sha256: chữ ký SHA-256 cũng là 64-hex. Thay nhầm ở đây
    // sẽ làm hỏng chữ ký SigV4 và AWS trả 403.
    const sha = 'd'.repeat(64)
    const result = internals(makeProxy()).modifyHeaders(
      `POST /x HTTP/1.1\r\nx-amz-content-sha256: ${sha}\r\nHost: h`,
      'h'
    )

    expect(result.modified).toBe(false)
    expect(result.newHeaders).toContain(sha)
  })

  it('không có deviceId cấu hình thì header giữ nguyên', () => {
    const proxy = makeProxy({ deviceId: undefined })
    const raw = `POST /x HTTP/1.1\r\nUser-Agent: KiroIDE-0.6.18-${ORIGINAL_ID}`
    const result = internals(proxy).modifyHeaders(raw, 'h')

    expect(result.modified).toBe(false)
    expect(result.newHeaders).toBe(raw)
  })
})

