import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Account } from '../../src/renderer/src/types/account'
import { isPlaceholderProfileArn, useAccountsStore } from '../../src/renderer/src/store/accounts'
import { DEFAULT_PROXY_POOL_CONFIG, type ProxyEntry } from '../../src/renderer/src/types/proxy'

const PLACEHOLDER_PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX'

function accountData(
  email: string,
  refreshToken: string,
  profileArn = PLACEHOLDER_PROFILE_ARN
): Omit<Account, 'id' | 'createdAt' | 'isActive'> {
  return {
    email,
    idp: 'BuilderId',
    profileArn,
    credentials: {
      provider: 'BuilderId',
      accessToken: `at-${refreshToken}`,
      csrfToken: '',
      refreshToken,
      expiresAt: Date.now() + 3600000
    },
    subscription: { type: 'Free' },
    usage: { current: 0, limit: 50, percentUsed: 0, lastUpdated: Date.now() },
    tags: [],
    status: 'active',
    lastUsedAt: Date.now()
  }
}

describe('account duplicate detection', () => {
  beforeEach(() => {
    useAccountsStore.setState({
      accounts: new Map(),
      groups: new Map(),
      tags: new Map(),
      activeAccountId: null,
      saveToStorage: vi.fn(async () => {})
    })
  })

  it('does not treat the fixed placeholder profileArn as a duplicate identity', () => {
    const firstId = useAccountsStore.getState().addAccount(
      accountData('existing@example.com', 'rt-existing')
    )
    const secondId = useAccountsStore.getState().addAccount(
      accountData('new@example.com', 'rt-new')
    )

    expect(secondId).not.toBe(firstId)
    expect(useAccountsStore.getState().accounts.size).toBe(2)
    expect(Array.from(useAccountsStore.getState().accounts.values()).map((account) => account.email).sort()).toEqual([
      'existing@example.com',
      'new@example.com'
    ])
  })

  it('still skips real duplicates by email/provider and refresh token', () => {
    const firstId = useAccountsStore.getState().addAccount(
      accountData('existing@example.com', 'rt-existing')
    )
    const duplicateEmailId = useAccountsStore.getState().addAccount(
      accountData('existing@example.com', 'rt-other')
    )
    const duplicateRefreshId = useAccountsStore.getState().addAccount(
      accountData('other@example.com', 'rt-existing')
    )

    expect(duplicateEmailId).toBe(firstId)
    expect(duplicateRefreshId).toBe(firstId)
    expect(useAccountsStore.getState().accounts.size).toBe(1)
  })

  it('recognizes empty and placeholder profileArn values as non-identities', () => {
    expect(isPlaceholderProfileArn('')).toBe(true)
    expect(isPlaceholderProfileArn(PLACEHOLDER_PROFILE_ARN)).toBe(true)
    expect(isPlaceholderProfileArn('placeholder-profile')).toBe(true)
    expect(isPlaceholderProfileArn('arn:aws:codewhisperer:us-east-1:123456789012:profile/real')).toBe(false)
  })
})

describe('registration proxy pool feedback', () => {
  beforeEach(() => {
    useAccountsStore.setState({
      proxyPool: new Map(),
      proxyPoolConfig: { ...DEFAULT_PROXY_POOL_CONFIG, enabled: true, autoDisableDead: true, failureThreshold: 1 },
      proxyPoolCursor: 0,
      accountProxyBindings: {},
      saveToStorage: vi.fn(async () => {})
    })
  })

  it('counts WorkflowInit HTML 403 as a proxy route failure', () => {
    const proxy: ProxyEntry = {
      id: 'proxy-1',
      url: 'http://127.0.0.1:8080',
      protocol: 'http',
      host: '127.0.0.1',
      port: 8080,
      status: 'alive',
      latencyMs: 250,
      usedCount: 0,
      failCount: 0,
      enabled: true,
      createdAt: Date.now()
    }
    const spareProxy: ProxyEntry = {
      ...proxy,
      id: 'proxy-2',
      url: 'http://127.0.0.1:8081',
      port: 8081
    }

    useAccountsStore.setState({ proxyPool: new Map([[proxy.id, proxy], [spareProxy.id, spareProxy]]) })

    useAccountsStore.getState().reportProxyResult(
      proxy.id,
      false,
      undefined,
      'WorkflowInit Kiro failed: status=403 proxy gateway returned an HTML Forbidden page before Kiro produced an API response'
    )

    const updated = useAccountsStore.getState().proxyPool.get(proxy.id)
    expect(updated?.failCount).toBe(1)
    expect(updated?.status).toBe('dead')
    expect(updated?.enabled).toBe(false)
  })

  it('disables AWS sign-in gateway failures immediately even before the generic failure threshold', () => {
    useAccountsStore.setState({
      proxyPoolConfig: { ...DEFAULT_PROXY_POOL_CONFIG, enabled: true, autoDisableDead: true, failureThreshold: 3 }
    })
    const proxy: ProxyEntry = {
      id: 'proxy-aws-blocked',
      url: 'http://47.84.204.82:443',
      protocol: 'http',
      host: '47.84.204.82',
      port: 443,
      status: 'alive',
      latencyMs: 357,
      usedCount: 0,
      failCount: 0,
      enabled: true,
      createdAt: Date.now()
    }

    useAccountsStore.setState({ proxyPool: new Map([[proxy.id, proxy]]) })

    useAccountsStore.getState().reportProxyResult(
      proxy.id,
      false,
      undefined,
      'AWS sign-in route failed: proxy gateway returned an HTML 403 page before Kiro produced an API response'
    )

    const updated = useAccountsStore.getState().proxyPool.get(proxy.id)
    expect(updated?.failCount).toBe(1)
    expect(updated?.status).toBe('dead')
    expect(updated?.enabled).toBe(false)
  })

  it('counts localized WorkflowInit timeout as a proxy route failure', () => {
    const proxy: ProxyEntry = {
      id: 'proxy-1',
      url: 'socks5://41.216.188.132:9050',
      protocol: 'socks5',
      host: '41.216.188.132',
      port: 9050,
      status: 'slow',
      latencyMs: 1800,
      usedCount: 0,
      failCount: 0,
      enabled: true,
      createdAt: Date.now()
    }
    const spareProxy: ProxyEntry = {
      ...proxy,
      id: 'proxy-2',
      url: 'http://127.0.0.1:8081',
      protocol: 'http',
      host: '127.0.0.1',
      port: 8081
    }

    useAccountsStore.setState({ proxyPool: new Map([[proxy.id, proxy], [spareProxy.id, spareProxy]]) })

    useAccountsStore.getState().reportProxyResult(
      proxy.id,
      false,
      undefined,
      '[WorkflowInit] WorkflowInit h\u1ebft th\u1eddi gian ch\u1edd t\u1ed5ng th\u1ec3 35 gi\u00e2y'
    )

    const updated = useAccountsStore.getState().proxyPool.get(proxy.id)
    expect(updated?.failCount).toBe(1)
    expect(updated?.status).toBe('dead')
    expect(updated?.enabled).toBe(false)
  })

  it('selects only measured fast proxies and never falls back to slow proxies', () => {
    const slowProxy: ProxyEntry = {
      id: 'proxy-slow',
      url: 'socks5://41.216.188.132:9050',
      protocol: 'socks5',
      host: '41.216.188.132',
      port: 9050,
      status: 'slow',
      latencyMs: 1800,
      usedCount: 0,
      failCount: 0,
      enabled: true,
      createdAt: Date.now()
    }
    const aliveProxy: ProxyEntry = {
      ...slowProxy,
      id: 'proxy-alive',
      url: 'http://127.0.0.1:8081',
      protocol: 'http',
      host: '127.0.0.1',
      port: 8081,
      status: 'alive',
      latencyMs: 250
    }

    useAccountsStore.setState({
      proxyPool: new Map([[slowProxy.id, slowProxy], [aliveProxy.id, aliveProxy]]),
      proxyPoolCursor: 0
    })

    expect(useAccountsStore.getState().pickNextProxy()?.id).toBe(aliveProxy.id)

    useAccountsStore.setState({ proxyPool: new Map([[slowProxy.id, slowProxy]]) })
    expect(useAccountsStore.getState().pickNextProxy()).toBeNull()

    useAccountsStore.setState({
      proxyPool: new Map([[
        aliveProxy.id,
        { ...aliveProxy, latencyMs: DEFAULT_PROXY_POOL_CONFIG.maxUsableLatencyMs + 1 }
      ]])
    })
    expect(useAccountsStore.getState().pickNextProxy()).toBeNull()
  })
})
