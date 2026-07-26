import { describe, expect, it } from 'vitest'
import { mergePeerAccountData } from '../../src/server/services/accountSync'
import { openAIChatToResponsesResponse } from '../../src/main/proxy/translator'
import { buildCodexPayloadFromChat } from '../../src/main/proxy/chatgptCodex'
import { AccountPool, ErrorType } from '../../src/main/proxy/accountPool'
import type { OpenAIChatRequest, OpenAIChatResponse } from '../../src/main/proxy/types'

/**
 * Regression cho các lỗi tìm được trong đợt audit toàn dự án.
 * Mỗi test dưới đây fail trên code trước khi sửa.
 */

describe('A2 — merge peer account không được đụng deletion tombstone', () => {
  const incoming = {
    accounts: {
      'acct-1': { id: 'acct-1', email: 'a@example.com', provider: 'kiro' }
    }
  }

  it('cấp id mới khi id nguồn trùng một tombstone', () => {
    const current = {
      accounts: {},
      _deletedAccountIds: ['acct-1']
    }

    const merged = mergePeerAccountData(current, incoming)

    expect(merged.added).toBe(1)
    // Id đã ghi phải KHÁC id nguồn, nếu không enforceDeletionTombstones sẽ xoá nó ngay sau đó.
    const writtenIds = Object.keys(merged.data.accounts as Record<string, unknown>)
    expect(writtenIds).toHaveLength(1)
    expect(writtenIds[0]).not.toBe('acct-1')

    // Mapping phải cho caller biết id nguồn tương ứng với id nào trong store.
    expect(merged.addedAccountTargets).toEqual([
      { sourceId: 'acct-1', targetId: writtenIds[0] }
    ])
  })

  it('giữ nguyên id khi không có tombstone nào', () => {
    const merged = mergePeerAccountData({ accounts: {} }, incoming)

    expect(Object.keys(merged.data.accounts as Record<string, unknown>)).toEqual(['acct-1'])
    expect(merged.addedAccountTargets).toEqual([{ sourceId: 'acct-1', targetId: 'acct-1' }])
  })

  it('vẫn cấp id mới khi trùng account đang sống', () => {
    const current = { accounts: { 'acct-1': { id: 'acct-1', email: 'khac@example.com', provider: 'kiro' } } }

    const merged = mergePeerAccountData(current, incoming)
    const target = merged.addedAccountTargets[0]

    expect(target?.sourceId).toBe('acct-1')
    expect(target?.targetId).not.toBe('acct-1')
  })
})

describe('B6 — reset()/clear() phải xoá ngân sách rate-limit', () => {
  function poolWithThrottledAccounts(): AccountPool {
    const pool = new AccountPool()
    pool.setStrategy('smart')
    pool.addAccount({ id: 'a', email: 'a@test', accessToken: 'tok', errorCount: 0 })
    pool.addAccount({ id: 'b', email: 'b@test', accessToken: 'tok', errorCount: 0 })
    // 429 trên cả hai account -> ngân sách rate-limit bị đánh dấu cạn.
    pool.recordError('a', ErrorType.RECOVERABLE, 429)
    pool.recordError('b', ErrorType.RECOVERABLE, 429)
    return pool
  }

  it('sau reset(), chiến lược smart lại chọn được account', () => {
    const pool = poolWithThrottledAccounts()

    // Tiền đề: đang bị chặn thật (nếu không thì test này vô nghĩa).
    expect(pool.getNextAccount()).toBeNull()

    pool.reset()

    // Trước khi sửa: rateLimitBudgets còn nguyên lastThrottleAt nên getSmartBalancedAccount
    // bỏ qua cứng mọi account và trả null -> UI báo reset thành công rồi 503 ngay sau đó.
    expect(pool.getNextAccount()).not.toBeNull()
  })

  it('removeAccount() rồi thêm lại cùng id thì không kế thừa throttle cũ', () => {
    const pool = poolWithThrottledAccounts()
    pool.removeAccount('a')
    pool.addAccount({ id: 'a', email: 'a@test', accessToken: 'tok2', errorCount: 0 })

    const account = pool.getAccount('a')
    expect(account?.errorCount).toBe(0)
    expect(account?.cooldownUntil).toBeUndefined()
    expect(pool.getNextAccount()).not.toBeNull()
  })
})

describe('C4 — /v1/responses không được sập khi provider bỏ qua usage', () => {
  const baseResponse = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'llama-3',
    choices: [
      { index: 0, message: { role: 'assistant' as const, content: 'xin chào' }, finish_reason: 'stop' }
    ]
  }

  it('thiếu usage thì trả token = 0 thay vì ném TypeError', () => {
    const response = baseResponse as unknown as OpenAIChatResponse

    const result = openAIChatToResponsesResponse(response)

    expect(result.usage).toEqual({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })
    expect(result.output).toHaveLength(1)
  })

  it('thiếu choices thì trả output rỗng thay vì ném TypeError', () => {
    const response = { ...baseResponse, choices: undefined } as unknown as OpenAIChatResponse

    const result = openAIChatToResponsesResponse(response)

    expect(result.output).toEqual([])
  })

  it('có usage thì vẫn giữ nguyên số liệu', () => {
    const response = {
      ...baseResponse,
      usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 }
    } as unknown as OpenAIChatResponse

    const result = openAIChatToResponsesResponse(response)

    expect(result.usage).toEqual({ input_tokens: 12, output_tokens: 34, total_tokens: 46 })
  })
})

describe('C5 — Codex chat phải giữ lại ảnh', () => {
  it('chuyển image_url thành input_image thay vì vứt đi', () => {
    const request: OpenAIChatRequest = {
      model: 'gpt-5.6-sol',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Ảnh này là gì?' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
          ]
        }
      ]
    }

    const payload = buildCodexPayloadFromChat(request)
    const userItem = payload.input.find((item) => item.type === 'message' && item.role === 'user')
    const content = Array.isArray(userItem?.content) ? userItem.content : []

    expect(content.some((part) => part.type === 'input_text' && part.text === 'Ảnh này là gì?')).toBe(true)
    expect(content.some((part) => part.type === 'input_image' && part.image_url === 'data:image/png;base64,AAAA')).toBe(true)
  })

  it('tin nhắn chỉ có ảnh vẫn gửi được ảnh lên', () => {
    const request: OpenAIChatRequest = {
      model: 'gpt-5.6-sol',
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }]
        }
      ]
    }

    const payload = buildCodexPayloadFromChat(request)
    const userItem = payload.input.find((item) => item.type === 'message' && item.role === 'user')
    const content = Array.isArray(userItem?.content) ? userItem.content : []

    expect(content.some((part) => part.type === 'input_image' && part.image_url === 'https://example.com/a.png')).toBe(true)
  })

  it('tin nhắn chỉ có chữ vẫn giữ nguyên hình dạng cũ', () => {
    const request: OpenAIChatRequest = {
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'chỉ có chữ' }]
    }

    const payload = buildCodexPayloadFromChat(request)
    const userItem = payload.input.find((item) => item.type === 'message' && item.role === 'user')

    expect(userItem?.content).toEqual([{ type: 'input_text', text: 'chỉ có chữ' }])
  })
})
