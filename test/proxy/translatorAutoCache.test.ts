import { describe, expect, it } from 'vitest'
import { openaiToKiro } from '../../src/main/proxy/translator'
import type { KiroPayload, KiroHistoryMessage, KiroToolWrapper } from '../../src/main/proxy/types'

// Đếm tổng số cachePoint trong payload (tools + system + history + currentMessage)
function countCachePoints(payload: KiroPayload): {
  total: number
  onCurrent: boolean
  onTools: number
  onHistory: number
} {
  const tools = (payload.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools || []) as KiroToolWrapper[]
  const onTools = tools.filter(t => 'cachePoint' in t).length
  const history = (payload.conversationState.history || []) as KiroHistoryMessage[]
  const onHistory = history.filter(h => h.userInputMessage?.cachePoint).length
  const onCurrent = Boolean(payload.conversationState.currentMessage.userInputMessage.cachePoint)
  return { total: onTools + onHistory + (onCurrent ? 1 : 0), onCurrent, onTools, onHistory }
}

// Tạo system prompt / message đủ lớn để vượt ngưỡng AUTO_CACHE_MIN_CHARS (~4096 chars)
const BIG = 'x'.repeat(5000)

const ON = { autoCachePoint: true, maxPoints: 4 }

describe('auto cachePoint injection (OpenAI path)', () => {
  it('injects cachePoints on stable prefix when enabled and client sent none', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.5',
      messages: [
        { role: 'system', content: `You are a helpful assistant. ${BIG}` },
        { role: 'user', content: `first question ${BIG}` },
        { role: 'assistant', content: 'first answer' },
        { role: 'user', content: 'second question' }
      ]
    } as any, undefined, undefined, ON)

    const c = countCachePoints(payload)
    expect(c.total).toBeGreaterThan(0)
    expect(c.total).toBeLessThanOrEqual(4)
    // Không bao giờ đánh dấu current turn
    expect(c.onCurrent).toBe(false)
  })

  it('does NOT inject when disabled', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.5',
      messages: [
        { role: 'system', content: `sys ${BIG}` },
        { role: 'user', content: 'hi' }
      ]
    } as any, undefined, undefined, { autoCachePoint: false, maxPoints: 4 })
    expect(countCachePoints(payload).total).toBe(0)
  })

  it('respects maxPoints cap', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.5',
      messages: [
        { role: 'system', content: `sys ${BIG}` },
        { role: 'user', content: `q1 ${BIG}` },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: `q2 ${BIG}` },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: `q3 ${BIG}` },
        { role: 'assistant', content: 'a3' },
        { role: 'user', content: 'now' }
      ],
      tools: [{ type: 'function', function: { name: 'f', description: BIG, parameters: { type: 'object', properties: {} } } }]
    } as any, undefined, undefined, { autoCachePoint: true, maxPoints: 2 })
    expect(countCachePoints(payload).total).toBeLessThanOrEqual(2)
  })

  it('does not inject for short prefixes (not worth caching)', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.5',
      messages: [
        { role: 'system', content: 'short' },
        { role: 'user', content: 'hi' }
      ]
    } as any, undefined, undefined, ON)
    expect(countCachePoints(payload).total).toBe(0)
  })

  it('respects client-supplied cache_control (does not double-inject)', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.5',
      messages: [
        { role: 'system', content: `sys ${BIG}`, cache_control: { type: 'ephemeral' } },
        { role: 'user', content: `q ${BIG}` }
      ]
    } as any, undefined, undefined, ON)
    // Client đã đánh dấu → auto KHÔNG chạy; chỉ có cachePoint của client (system)
    const c = countCachePoints(payload)
    expect(c.onHistory).toBe(1) // system message giữ cachePoint client gửi
  })

  it('injects a cachePoint after large tool definitions', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'use the tool' }],
      tools: [{ type: 'function', function: { name: 'bigtool', description: BIG, parameters: { type: 'object', properties: {} } } }]
    } as any, undefined, undefined, ON)
    expect(countCachePoints(payload).onTools).toBe(1)
  })
})
