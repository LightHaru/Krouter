import { describe, expect, it } from 'vitest'
import { claudeToKiro, openaiToKiro, responsesToOpenAIChat } from '../../src/main/proxy/translator'
import { kiroProxyModelSupportsThinking } from '../../src/main/proxy/modelCatalog'

describe('translator thinking / reasoning mapping', () => {
  it('maps OpenAI reasoning_effort to Kiro adaptive thinking effort for Opus 4+', () => {
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

  it('detects thinking support for public and internal Claude 4+ model ids only', () => {
    expect(kiroProxyModelSupportsThinking('claude-opus-4.8')).toBe(true)
    expect(kiroProxyModelSupportsThinking('CLAUDE_HAIKU_4_5_20251001_V1_0')).toBe(true)
    expect(kiroProxyModelSupportsThinking('claude-3.7-sonnet')).toBe(false)
    expect(kiroProxyModelSupportsThinking('CLAUDE_3_7_SONNET_20250219_V1_0')).toBe(false)
    expect(kiroProxyModelSupportsThinking('deepseek-v3.1')).toBe(false)
  })
})
