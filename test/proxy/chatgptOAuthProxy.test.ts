import { describe, expect, it, vi } from 'vitest'
import { ProxyServer } from '../../src/main/proxy/proxyServer'
import type { ChatGPTAccountState } from '../../src/main/proxy/chatgptOAuth'

function oauthAccount(): ChatGPTAccountState {
  const now = Date.now()
  return {
    id: 'chatgpt-account-1',
    accessToken: 'access-token-must-stay-private',
    refreshToken: 'refresh-token-must-stay-private',
    expiresAt: now + 3600_000,
    email: 'owner@example.com',
    plan: 'plus',
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now
  }
}

describe('ProxyServer ChatGPT OAuth account state', () => {
  it('returns useful account metadata without exposing OAuth secrets', () => {
    const server = new ProxyServer({ chatgptAccounts: [oauthAccount()] })
    const serialized = JSON.stringify(server.getChatGPTOAuthStatus())

    expect(serialized).toContain('owner@example.com')
    expect(serialized).not.toContain('access-token-must-stay-private')
    expect(serialized).not.toContain('refresh-token-must-stay-private')
    expect(server.getChatGPTOAuthStatus()).toMatchObject({
      totalAccounts: 1,
      availableForImageGen: 1,
      oauthFlowPending: false
    })
  })

  it('disconnects the selected account and persists the config mutation', () => {
    const onConfigChanged = vi.fn()
    const server = new ProxyServer({ chatgptAccounts: [oauthAccount()] }, { onConfigChanged })

    expect(server.logoutChatGPTAccount('chatgpt-account-1')).toEqual({ success: true, accountId: 'chatgpt-account-1' })
    expect(server.getChatGPTOAuthStatus().totalAccounts).toBe(0)
    expect(onConfigChanged).toHaveBeenCalledTimes(1)
    expect(onConfigChanged.mock.calls[0][0].chatgptAccounts).toEqual([])
  })
})
