import { describe, expect, it } from 'vitest'
import { MitmHttpsServer } from '../../src/main/kproxy/mitmHttpsServer'

/**
 * Khoá lại hành vi của bộ dịch stream OpenAI -> khung AWS event-stream.
 *
 * Các hàm này là private (private của TS chỉ có hiệu lực lúc biên dịch) và trước đây được
 * viết bằng `any`; sau khi gõ kiểu, cần test hành vi để chắc chắn không có gì đổi.
 */

type FrameState = {
  modelId: string
  toolCallInit: Record<number, { id: string; name: string }>
  hasToolCalls: boolean
  finishSent: boolean
}

type StreamChunk = {
  choices?: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{
        index?: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string
  }>
}

/** Truy cập hai method private để test đơn vị phần dịch khung. */
type FrameConverter = {
  convertOpenAIToKiroFrames(chunk: StreamChunk, state: FrameState): Buffer[] | null
}

function makeConverter(): { converter: FrameConverter; state: FrameState } {
  const server = new MitmHttpsServer() as unknown as FrameConverter
  return {
    converter: server,
    state: { modelId: 'claude-sonnet-4.5', toolCallInit: {}, hasToolCalls: false, finishSent: false }
  }
}

/** Đọc payload JSON ra khỏi một khung event-stream để kiểm tra nội dung. */
function framePayload(frame: Buffer): Record<string, unknown> {
  const totalLen = frame.readUInt32BE(0)
  const headersLen = frame.readUInt32BE(4)
  const payload = frame.subarray(12 + headersLen, totalLen - 4)
  return JSON.parse(payload.toString('utf8')) as Record<string, unknown>
}

/** Lấy tên loại sự kiện (:event-type) từ phần header của khung. */
function frameEventType(frame: Buffer): string {
  const headersLen = frame.readUInt32BE(4)
  const headers = frame.subarray(12, 12 + headersLen).toString('latin1')
  const match = headers.match(/:event-type.(.*?)(?=:content-type)/s)
  return match ? match[1].replace(/[^\x20-\x7e]/g, '') : ''
}

describe('MITM: dịch stream OpenAI sang khung Kiro event-stream', () => {
  it('phát assistantResponseEvent cho delta văn bản', () => {
    const { converter, state } = makeConverter()

    const frames = converter.convertOpenAIToKiroFrames({ choices: [{ delta: { content: 'xin chào' } }] }, state)

    expect(frames).toHaveLength(1)
    expect(framePayload(frames![0])).toEqual({ content: 'xin chào', modelId: 'claude-sonnet-4.5' })
    expect(frameEventType(frames![0])).toContain('assistantResponseEvent')
  })

  it('không phát khung nào cho chunk rỗng', () => {
    const { converter, state } = makeConverter()

    expect(converter.convertOpenAIToKiroFrames({ choices: [{ delta: {} }] }, state)).toBeNull()
  })

  it('ghi nhớ id/name của tool call rồi gắn đúng cho các chunk arguments sau đó', () => {
    const { converter, state } = makeConverter()

    converter.convertOpenAIToKiroFrames(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file' } }] } }] },
      state
    )
    const argFrames = converter.convertOpenAIToKiroFrames(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
      state
    )

    expect(state.hasToolCalls).toBe(true)
    // Chunk arguments không mang id/name, phải lấy lại từ lần khởi tạo.
    expect(framePayload(argFrames![0])).toEqual({
      input: '{"path":',
      name: 'read_file',
      toolUseId: 'call_1'
    })
  })

  it('khung kết thúc tool call ra theo thứ tự SỐ, không phải thứ tự chuỗi', () => {
    const { converter, state } = makeConverter()

    // 12 tool call song song: sort() theo chuỗi sẽ cho "10","11" đứng trước "2".
    for (let i = 0; i < 12; i++) {
      converter.convertOpenAIToKiroFrames(
        { choices: [{ delta: { tool_calls: [{ index: i, id: `call_${i}`, function: { name: `tool_${i}` } }] } }] },
        state
      )
    }

    const finishFrames = converter.convertOpenAIToKiroFrames({ choices: [{ finish_reason: 'tool_calls' }] }, state)!
    const stopIds = finishFrames
      .map(framePayload)
      .filter((p) => p.stop === true)
      .map((p) => p.toolUseId)

    expect(stopIds).toEqual(Array.from({ length: 12 }, (_, i) => `call_${i}`))
  })

  it('ánh xạ finish_reason sang stopReason của Kiro', () => {
    for (const [finish, expected] of [
      ['stop', 'END_TURN'],
      ['length', 'MAX_TOKENS']
    ] as const) {
      const { converter, state } = makeConverter()
      const frames = converter.convertOpenAIToKiroFrames({ choices: [{ finish_reason: finish }] }, state)!
      expect(framePayload(frames[frames.length - 1])).toEqual({ stopReason: expected })
      expect(state.finishSent).toBe(true)
    }
  })

  it('có tool call thì stopReason là TOOL_USE', () => {
    const { converter, state } = makeConverter()
    converter.convertOpenAIToKiroFrames(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 't' } }] } }] },
      state
    )

    const frames = converter.convertOpenAIToKiroFrames({ choices: [{ finish_reason: 'tool_calls' }] }, state)!

    expect(framePayload(frames[frames.length - 1])).toEqual({ stopReason: 'TOOL_USE' })
  })
})
