import { afterEach, describe, expect, it } from 'vitest'
import { buildKiroPayload, setPayloadSizeLimitKB } from '../../src/main/proxy/kiroApi'
import type { KiroHistoryMessage } from '../../src/main/proxy/types'

describe('Kiro payload compaction', () => {
  const originalLimit = process.env.KROUTER_KIRO_CONTENT_CHAR_LIMIT

  afterEach(() => {
    if (originalLimit === undefined) {
      delete process.env.KROUTER_KIRO_CONTENT_CHAR_LIMIT
    } else {
      process.env.KROUTER_KIRO_CONTENT_CHAR_LIMIT = originalLimit
    }
    setPayloadSizeLimitKB(1536)
  })

  it('trims oversized current content while preserving head and tail', () => {
    process.env.KROUTER_KIRO_CONTENT_CHAR_LIMIT = '20000'
    const input = `${'HEAD '.repeat(1000)}${'middle '.repeat(20000)}TAIL_MARKER`

    const payload = buildKiroPayload(input, 'claude-sonnet-4.5', 'AI_EDITOR')
    const content = payload.conversationState.currentMessage.userInputMessage.content

    expect(content.length).toBeLessThanOrEqual(20000)
    expect(content).toContain('HEAD')
    expect(content).toContain('TAIL_MARKER')
    expect(content).toContain('Krouter trimmed')
  })

  it('drops oldest history when text compaction is still over payload size limit', () => {
    process.env.KROUTER_KIRO_CONTENT_CHAR_LIMIT = '20000'
    setPayloadSizeLimitKB(256)
    const history: KiroHistoryMessage[] = []
    for (let i = 0; i < 24; i++) {
      history.push({
        userInputMessage: {
          content: `user-${i}\n${'u'.repeat(50000)}`,
          modelId: 'claude-sonnet-4.5',
          origin: 'AI_EDITOR'
        }
      })
      history.push({
        assistantResponseMessage: {
          content: `assistant-${i}\n${'a'.repeat(50000)}`
        }
      })
    }

    const payload = buildKiroPayload('latest question', 'claude-sonnet-4.5', 'AI_EDITOR', history)

    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(256 * 1024)
    expect((payload.conversationState.history?.length ?? 0)).toBeLessThan(history.length)
  })
})
