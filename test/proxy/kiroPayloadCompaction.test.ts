import { afterEach, describe, expect, it } from 'vitest'
import { buildKiroPayload, setPayloadSizeLimitKB } from '../../src/main/proxy/kiroApi'
import type { KiroHistoryMessage, KiroToolWrapper } from '../../src/main/proxy/types'

function expectValidToolPairs(messages: KiroHistoryMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const toolUses = messages[i].assistantResponseMessage?.toolUses ?? []
    if (toolUses.length === 0) continue
    const nextToolResults = messages[i + 1]?.userInputMessage?.userInputMessageContext?.toolResults ?? []
    expect(nextToolResults.map(result => result.toolUseId).sort()).toEqual(toolUses.map(toolUse => toolUse.toolUseId).sort())
  }

  for (let i = 0; i < messages.length; i++) {
    const toolResults = messages[i].userInputMessage?.userInputMessageContext?.toolResults ?? []
    if (toolResults.length === 0) continue
    const previousToolUses = messages[i - 1]?.assistantResponseMessage?.toolUses ?? []
    expect(toolResults.map(result => result.toolUseId).sort()).toEqual(previousToolUses.map(toolUse => toolUse.toolUseId).sort())
  }
}

describe('Kiro payload compaction', () => {
  const originalLimit = process.env.KROUTER_KIRO_CONTENT_CHAR_LIMIT
  const originalToolHistoryKeep = process.env.KROUTER_KIRO_TOOL_RESULT_HISTORY_KEEP
  const originalOldToolLimit = process.env.KROUTER_KIRO_OLD_TOOL_RESULT_CHAR_LIMIT

  afterEach(() => {
    if (originalLimit === undefined) {
      delete process.env.KROUTER_KIRO_CONTENT_CHAR_LIMIT
    } else {
      process.env.KROUTER_KIRO_CONTENT_CHAR_LIMIT = originalLimit
    }
    if (originalToolHistoryKeep === undefined) {
      delete process.env.KROUTER_KIRO_TOOL_RESULT_HISTORY_KEEP
    } else {
      process.env.KROUTER_KIRO_TOOL_RESULT_HISTORY_KEEP = originalToolHistoryKeep
    }
    if (originalOldToolLimit === undefined) {
      delete process.env.KROUTER_KIRO_OLD_TOOL_RESULT_CHAR_LIMIT
    } else {
      process.env.KROUTER_KIRO_OLD_TOOL_RESULT_CHAR_LIMIT = originalOldToolLimit
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

  it('aggressively compacts older tool results while preserving recent tool results', () => {
    process.env.KROUTER_KIRO_TOOL_RESULT_HISTORY_KEEP = '2'
    process.env.KROUTER_KIRO_OLD_TOOL_RESULT_CHAR_LIMIT = '120'
    const history: KiroHistoryMessage[] = []
    const tools: KiroToolWrapper[] = [{
      toolSpecification: {
        name: 'shell',
        description: 'Run a shell command',
        inputSchema: { json: { type: 'object', properties: { command: { type: 'string' } } } }
      }
    }]

    for (let i = 0; i < 8; i++) {
      history.push({
        assistantResponseMessage: {
          content: ' ',
          toolUses: [{ toolUseId: `call-${i}`, name: 'shell', input: { command: `command-${i}` } }]
        }
      })
      history.push({
        userInputMessage: {
          content: 'Tool results provided.',
          modelId: 'claude-sonnet-4.5',
          origin: 'AI_EDITOR',
          userInputMessageContext: {
            toolResults: [{
              toolUseId: `call-${i}`,
              content: [{ text: `tool-${i}\n${'x'.repeat(5000)}` }],
              status: 'success'
            }]
          }
        }
      })
    }

    const payload = buildKiroPayload('continue', 'claude-sonnet-4.5', 'AI_EDITOR', history, tools)
    const toolResultMessages = (payload.conversationState.history ?? [])
      .filter(message => message.userInputMessage?.userInputMessageContext?.toolResults?.length)
    const firstToolText = toolResultMessages[0].userInputMessage!.userInputMessageContext!.toolResults![0].content[0].text!
    const recentToolText = toolResultMessages.at(-1)!.userInputMessage!.userInputMessageContext!.toolResults![0].content[0].text!

    expect(toolResultMessages).toHaveLength(8)
    expect(firstToolText.length).toBeLessThanOrEqual(120)
    expect(recentToolText.length).toBeGreaterThan(1000)
  })

  it('repairs tool-use pairs after dropping old oversized history', () => {
    process.env.KROUTER_KIRO_CONTENT_CHAR_LIMIT = '50000'
    setPayloadSizeLimitKB(256)
    const tools: KiroToolWrapper[] = [{
      toolSpecification: {
        name: 'shell',
        description: 'Run a shell command',
        inputSchema: { json: { type: 'object', properties: { command: { type: 'string' } } } }
      }
    }]
    const history: KiroHistoryMessage[] = []

    for (let i = 0; i < 20; i++) {
      history.push({
        userInputMessage: {
          content: `user-${i}\n${'u'.repeat(8000)}`,
          modelId: 'claude-sonnet-4.5',
          origin: 'AI_EDITOR'
        }
      })
      history.push({
        assistantResponseMessage: {
          content: ' ',
          toolUses: [{ toolUseId: `call-${i}`, name: 'shell', input: { command: `echo ${i}` } }]
        }
      })
      history.push({
        userInputMessage: {
          content: 'Tool results provided.',
          modelId: 'claude-sonnet-4.5',
          origin: 'AI_EDITOR',
          userInputMessageContext: {
            toolResults: [{
              toolUseId: `call-${i}`,
              content: [{ text: `ok-${i}\n${'x'.repeat(8000)}` }],
              status: 'success'
            }]
          }
        }
      })
    }

    const payload = buildKiroPayload('latest question', 'claude-sonnet-4.5', 'AI_EDITOR', history, tools)
    const messages = [
      ...(payload.conversationState.history ?? []),
      payload.conversationState.currentMessage
    ]

    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(256 * 1024)
    expectValidToolPairs(messages)
  })
})
