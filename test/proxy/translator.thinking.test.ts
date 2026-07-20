import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeToKiro, openaiToKiro, responsesToOpenAIChat } from '../../src/main/proxy/translator'
import { kiroProxyModelSupportsThinking } from '../../src/main/proxy/modelCatalog'

describe('translator thinking / reasoning mapping', () => {
  const originalKrouterThinking = process.env.KROUTER_ENABLE_KIRO_THINKING_FIELDS
  const originalKiroThinking = process.env.KIRO_ENABLE_THINKING_FIELDS

  beforeEach(() => {
    delete process.env.KROUTER_ENABLE_KIRO_THINKING_FIELDS
    delete process.env.KIRO_ENABLE_THINKING_FIELDS
  })

  afterEach(() => {
    if (originalKrouterThinking === undefined) {
      delete process.env.KROUTER_ENABLE_KIRO_THINKING_FIELDS
    } else {
      process.env.KROUTER_ENABLE_KIRO_THINKING_FIELDS = originalKrouterThinking
    }
    if (originalKiroThinking === undefined) {
      delete process.env.KIRO_ENABLE_THINKING_FIELDS
    } else {
      process.env.KIRO_ENABLE_THINKING_FIELDS = originalKiroThinking
    }
  })

  it('does not send Kiro thinking fields by default', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'ping' }],
      thinking: { type: 'enabled', budget_tokens: 4096 }
    })

    expect(payload.additionalModelRequestFields).toBeUndefined()
  })

  it('maps OpenAI reasoning_effort to Kiro adaptive thinking effort for Opus 4+', () => {
    process.env.KROUTER_ENABLE_KIRO_THINKING_FIELDS = '1'

    const payload = openaiToKiro({
      model: 'claude-opus-4.8',
      messages: [{ role: 'user', content: 'ping' }],
      reasoning_effort: 'high'
    })

    expect(payload.additionalModelRequestFields).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' }
    })
  })

  it('maps OpenAI thinking budget to Kiro adaptive task budget for Claude 4+', () => {
    process.env.KROUTER_ENABLE_KIRO_THINKING_FIELDS = '1'

    const payload = openaiToKiro({
      model: 'claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'ping' }],
      thinking: { type: 'enabled', budget_tokens: 4096 }
    })

    expect(payload.additionalModelRequestFields).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { task_budget: { type: 'tokens', total: 4096 } }
    })
  })

  it('maps Claude thinking effort and task budget to Kiro fields', () => {
    process.env.KROUTER_ENABLE_KIRO_THINKING_FIELDS = '1'

    const payload = claudeToKiro({
      model: 'claude-opus-4.8',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'ping' }],
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'max',
        task_budget: { type: 'tokens', total: 8192, remaining: 2048 }
      }
    })

    expect(payload.additionalModelRequestFields).toEqual({
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'max',
        task_budget: { type: 'tokens', total: 8192, remaining: 2048 }
      }
    })
  })

  it('does not send thinking fields to Claude 3.x models', () => {
    const payload = openaiToKiro({
      model: 'CLAUDE_3_7_SONNET_20250219_V1_0',
      messages: [{ role: 'user', content: 'ping' }],
      reasoning_effort: 'high',
      thinking: { type: 'adaptive' }
    })

    expect(payload.additionalModelRequestFields).toBeUndefined()
  })

  it('forwards Responses API reasoning.effort into chat reasoning_effort', () => {
    const chat = responsesToOpenAIChat({
      model: 'claude-opus-4.8',
      input: 'ping',
      reasoning: { effort: 'HIGH' }
    })

    expect(chat.reasoning_effort).toBe('high')
  })

  it('converts Responses API function tools to Chat Completions tool shape', () => {
    const chat = responsesToOpenAIChat({
      model: 'claude-sonnet-4.5',
      input: 'ping',
      tools: [{
        type: 'function',
        name: 'shell',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } }
      } as any]
    })

    expect(chat.tools?.[0]).toEqual({
      type: 'function',
      function: {
        name: 'shell',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } }
      }
    })
  })

  it('preserves current Responses function_call_output for stateful Kiro tool continuation', () => {
    const chat = responsesToOpenAIChat({
      model: 'claude-sonnet-4.5',
      previous_response_id: 'resp_previous',
      instructions: 'Follow tool outputs.',
      tools: [{
        type: 'function',
        name: 'shell',
        description: 'Run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } }
      } as any],
      input: [{
        type: 'function_call_output',
        call_id: 'tooluse_stateful_1',
        output: 'COMMAND_OK'
      }]
    })

    const payload = openaiToKiro(chat)
    const currentContext = payload.conversationState.currentMessage.userInputMessage.userInputMessageContext

    // Timestamp giờ được prepend vào current turn (để system prefix ổn định cho cache),
    // nên content = "[Context: Current time ...]\n\nTool results provided."
    expect(payload.conversationState.currentMessage.userInputMessage.content).toContain('Tool results provided.')
    expect(currentContext?.toolResults).toEqual([{
      toolUseId: 'tooluse_stateful_1',
      content: [{ text: 'COMMAND_OK' }],
      status: 'success'
    }])
  })

  it('does not inject literal I understand for empty assistant history messages', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.5',
      messages: [
        { role: 'user', content: 'First turn' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'Continue' }
      ]
    })

    expect(JSON.stringify(payload)).not.toContain('I understand.')
  })

  it('flattens tool blocks when no current tool schema is provided', () => {
    const payload = openaiToKiro(responsesToOpenAIChat({
      model: 'claude-sonnet-4.5',
      previous_response_id: 'resp_previous',
      input: [
        {
          type: 'function_call',
          call_id: 'tooluse_stateful_1',
          name: 'shell',
          arguments: '{"command":"echo ok"}'
        },
        {
          type: 'function_call_output',
          call_id: 'tooluse_stateful_1',
          output: 'COMMAND_OK'
        },
        {
          type: 'message',
          role: 'user',
          content: 'What happened?'
        }
      ]
    }))

    const serialized = JSON.stringify(payload)
    expect(serialized).toContain('<tool_use')
    expect(serialized).toContain('tooluse_stateful_1')
    expect(serialized).toContain('<tool_result')
    expect(serialized).toContain('COMMAND_OK')
    expect(serialized).not.toContain('"toolUses"')
    expect(serialized).not.toContain('"toolResults"')
  })

  it('rejects malformed JSON in tool-call history instead of replacing it with an empty object', () => {
    expect(() => openaiToKiro({
      model: 'claude-sonnet-4.5',
      messages: [
        { role: 'user', content: 'Write the file' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_write_1',
            type: 'function',
            function: {
              name: 'write',
              arguments: '{"path":"index.html"'
            }
          }]
        },
        { role: 'user', content: 'Continue' }
      ]
    })).toThrow('Invalid JSON arguments in tool-call history')
  })

  it('preserves an explicit empty object for no-argument tool-call history', () => {
    const payload = openaiToKiro({
      model: 'claude-sonnet-4.5',
      tools: [{
        type: 'function',
        function: {
          name: 'status',
          description: 'Check status',
          parameters: { type: 'object', properties: {}, required: [] }
        }
      }],
      messages: [
        { role: 'user', content: 'Check status' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_status_1',
            type: 'function',
            function: {
              name: 'status',
              arguments: '{}'
            }
          }]
        },
        { role: 'user', content: 'Continue' }
      ]
    })

    const toolUse = payload.conversationState.history
      ?.flatMap(message => message.assistantResponseMessage?.toolUses ?? [])
      .find(item => item.toolUseId === 'call_status_1')

    expect(toolUse?.input).toEqual({})
  })

  it('detects thinking support for public and internal Claude 4+ model ids only', () => {
    expect(kiroProxyModelSupportsThinking('claude-opus-4.8')).toBe(true)
    expect(kiroProxyModelSupportsThinking('CLAUDE_HAIKU_4_5_20251001_V1_0')).toBe(true)
    expect(kiroProxyModelSupportsThinking('claude-3.7-sonnet')).toBe(false)
    expect(kiroProxyModelSupportsThinking('CLAUDE_3_7_SONNET_20250219_V1_0')).toBe(false)
    expect(kiroProxyModelSupportsThinking('deepseek-v3.1')).toBe(false)
  })
})
