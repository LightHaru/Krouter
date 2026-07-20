import { describe, expect, it } from 'vitest'
import { ProxyServer } from '../../src/main/proxy/proxyServer'
import type { ProxyAccount, KiroPayload, KiroToolUse, KiroUsage } from '../../src/main/proxy/types'

function createAccount(): ProxyAccount {
  return {
    id: 'acct-tool-stream',
    email: 'tool-stream@test.local',
    accessToken: 'token',
    profileArn: 'arn:aws:codewhisperer:us-east-1:test:profile/test'
  }
}

function createToolPayload(): KiroPayload {
  return {
    conversationState: {
      chatTriggerType: 'MANUAL',
      currentMessage: {
        userInputMessage: {
          content: 'search gamefi',
          userInputMessageContext: {
            tools: [
              {
                toolName: 'browser_navigate',
                description: 'Navigate browser',
                inputSchema: {
                  type: 'object',
                  properties: { url: { type: 'string' } },
                  required: ['url']
                }
              }
            ]
          }
        }
      }
    }
  } as unknown as KiroPayload
}

function createResponseRecorder(): { res: any; output: () => string } {
  const chunks: string[] = []
  const res = {
    writableEnded: false,
    destroyed: false,
    writeHead: () => res,
    write: (chunk: string) => {
      chunks.push(chunk)
      return true
    },
    end: () => {
      res.writableEnded = true
      return res
    }
  }
  return { res, output: () => chunks.join('') }
}

describe('ProxyServer tool stream buffering', () => {
  it('suppresses assistant text that precedes an OpenAI tool_call chunk', async () => {
    const server = new ProxyServer({}) as any
    const account = createAccount()
    const { res, output } = createResponseRecorder()
    const leakedNativeToolText = '<tool_use id="tooluse_1" name="browser_navigate">{"url":"https://example.com"}</tool_use>'

    server.callStreamWithFailover = async (
      usedAccount: ProxyAccount,
      _payload: KiroPayload,
      onTextOrTool: (account: ProxyAccount, text?: string, toolUse?: KiroToolUse, isThinking?: boolean) => void,
      onEnd: (account: ProxyAccount, usage: KiroUsage) => void
    ) => {
      onTextOrTool(usedAccount, leakedNativeToolText, undefined, false)
      onTextOrTool(usedAccount, '', {
        toolUseId: 'tooluse_1',
        name: 'browser_navigate',
        input: { url: 'https://example.com' }
      }, false)
      onEnd(usedAccount, { inputTokens: 10, outputTokens: 2, credits: 0.01 })
    }

    await server.handleOpenAIStream(res, account, createToolPayload(), 'claude-sonnet-4.5', Date.now())

    const raw = output()
    expect(raw).not.toContain('<tool_use')
    expect(raw).not.toContain('</tool_use>')
    expect(raw).toContain('"tool_calls"')
    expect(raw).toContain('"finish_reason":"tool_calls"')
    expect(raw).toContain('data: [DONE]')
  })

  it('flushes buffered OpenAI assistant text when no tool_call arrives', async () => {
    const server = new ProxyServer({}) as any
    const account = createAccount()
    const { res, output } = createResponseRecorder()

    server.callStreamWithFailover = async (
      usedAccount: ProxyAccount,
      _payload: KiroPayload,
      onTextOrTool: (account: ProxyAccount, text?: string, toolUse?: KiroToolUse, isThinking?: boolean) => void,
      onEnd: (account: ProxyAccount, usage: KiroUsage) => void
    ) => {
      onTextOrTool(usedAccount, 'pong', undefined, false)
      onEnd(usedAccount, { inputTokens: 10, outputTokens: 2, credits: 0.01 })
    }

    await server.handleOpenAIStream(res, account, createToolPayload(), 'claude-sonnet-4.5', Date.now())

    const raw = output()
    expect(raw).toContain('"content":"pong"')
    expect(raw).toContain('"finish_reason":"stop"')
    expect(raw).toContain('data: [DONE]')
  })
})
