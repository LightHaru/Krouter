// 代理池相关 IPC：验活 + 代理链分阶段诊断
//
// 这两个 handler 完全独立、没有外部状态依赖，从 main/index.ts 拆出来作为模块化拆分的"种子"。
// 后续可按相同模式继续拆分（machine-id / kproxy / proxy / register / kiro-settings 等）。

import { ipcMain } from 'electron'
import { fetch as undiciFetch, type RequestInit as UndiciRequestInit } from 'undici'
import { getSystemProxy, safeCreateProxyAgent } from '../proxy/systemProxy'
import { ChainProxyRelay } from '../registration/chainProxy'

function extractExternalIp(contentType: string, text: string): string | undefined {
  if (contentType.includes('json') || text.trimStart().startsWith('{')) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>
      const raw = body.ip ?? body.query ?? body.origin ?? body.ipAddress ?? ''
      const match = String(raw).match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)
      if (match) return match[0]
    } catch { /* fall through to text extraction */ }
  }
  return text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/)?.[0]
}

async function validateNetworkRequest(params: {
  testUrl?: string
  timeoutMs?: number
  proxyUrl?: string | null
  route: string
}): Promise<{ success: boolean; latencyMs?: number; externalIp?: string; route: string; error?: string }> {
  const { testUrl = 'https://api.ipify.org?format=json', timeoutMs = 8000, proxyUrl, route } = params
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await undiciFetch(testUrl, {
      method: 'GET',
      dispatcher: safeCreateProxyAgent(proxyUrl) || undefined,
      signal: controller.signal,
      headers: { 'User-Agent': 'KiroAccountManager-NetworkValidator/1.0' }
    } as UndiciRequestInit)
    const latencyMs = Date.now() - started
    if (response.status < 200 || response.status >= 400) {
      return { success: false, latencyMs, route, error: `HTTP ${response.status}` }
    }
    const text = await response.text().catch(() => '')
    const externalIp = extractExternalIp(response.headers.get('content-type') || '', text)
    return externalIp
      ? { success: true, latencyMs, externalIp, route }
      : { success: false, latencyMs, route, error: 'The network check succeeded but no exit IP was returned' }
  } catch (error) {
    return {
      success: false,
      latencyMs: Date.now() - started,
      route,
      error: controller.signal.aborted ? `Request timed out (${timeoutMs}ms)` : error instanceof Error ? error.message : String(error)
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 通过指定代理 URL 请求测试地址，返回延迟与出口 IP。
 * 仅支持 http/https 协议代理（受 undici ProxyAgent 限制；socks 协议会被 safeCreateProxyAgent 静默跳过）。
 * 若给了 upstreamProxy，验活也走代理链（与注册流程一致），避免目标代理因来源 IP 不符被误标 dead。
 */
function registerValidateHandler(): void {
  ipcMain.handle('proxy-pool:validate', async (_event, params: {
    url: string
    testUrl?: string
    timeoutMs?: number
    upstreamProxy?: string
  }) => {
    const { url, testUrl = 'https://api.ipify.org?format=json', timeoutMs = 8000, upstreamProxy } = params || {}
    if (!url) return { success: false, error: 'Missing proxy URL' }

    let chainRelay: ChainProxyRelay | null = null
    let proxyForAgent = url
    if (upstreamProxy && upstreamProxy.trim()) {
      try {
        chainRelay = new ChainProxyRelay(upstreamProxy.trim(), url)
        proxyForAgent = await chainRelay.start()
      } catch (err) {
        return { success: false, error: `代理链启动失败: ${err instanceof Error ? err.message : String(err)}` }
      }
    }

    const agent = safeCreateProxyAgent(proxyForAgent)
    if (!agent) {
      if (chainRelay) await chainRelay.stop()
      return { success: false, error: '代理协议不支持（仅支持 http/https）或 URL 无效' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const start = Date.now()
    try {
      const resp = await undiciFetch(testUrl, {
        method: 'GET',
        dispatcher: agent,
        signal: controller.signal,
        headers: { 'User-Agent': 'KiroAccountManager-ProxyValidator/1.0' }
      } as UndiciRequestInit)
      const latencyMs = Date.now() - start
      if (resp.status >= 200 && resp.status < 400) {
        let externalIp: string | undefined
        try {
          const ct = resp.headers.get('content-type') || ''
          const text = await resp.text()
          externalIp = extractExternalIp(ct, text)
        } catch { /* 出口 IP 提取失败不影响验活成功 */ }
        return { success: true, latencyMs, externalIp }
      }
      return { success: false, latencyMs, error: `HTTP ${resp.status}` }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const isAbort = controller.signal.aborted
      return {
        success: false,
        latencyMs: Date.now() - start,
        error: isAbort ? `请求超时 (${timeoutMs}ms)` : errMsg
      }
    } finally {
      clearTimeout(timer)
      if (chainRelay) await chainRelay.stop()
    }
  })
}

function registerNetworkRouteValidateHandler(): void {
  ipcMain.handle('network-route:validate', async (_event, params?: {
    testUrl?: string
    timeoutMs?: number
  }) => {
    const proxyUrl = getSystemProxy()
    return validateNetworkRequest({
      testUrl: params?.testUrl,
      timeoutMs: params?.timeoutMs,
      proxyUrl,
      route: proxyUrl ? 'system-proxy' : 'direct-or-vpn'
    })
  })
}

/**
 * 代理链分阶段诊断：
 *   A) 上游中转 TCP 可达
 *   B) 经上游 CONNECT 抵达目标代理入口
 *   C) 经完整链路 CONNECT 抵达 testHost:testPort（默认 www.gstatic.com:443）
 * 定位问题精确到哪一层，比 validate 的"成功/失败"二元结果信息量大得多。
 */
function registerDiagnoseChainHandler(): void {
  ipcMain.handle('proxy-pool:diagnose-chain', async (_event, params: {
    targetUrl: string
    upstreamProxy: string
    testHost?: string
    testPort?: number
  }) => {
    const { targetUrl, upstreamProxy, testHost, testPort } = params || {}
    if (!targetUrl) return { success: false, error: 'Missing target proxy URL' }
    if (!upstreamProxy) return { success: false, error: 'Missing upstream proxy URL' }
    try {
      const relay = new ChainProxyRelay(upstreamProxy, targetUrl)
      const diag = await relay.diagnose(testHost, testPort)
      return { success: true, diagnose: diag }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

/** 注册"代理池"模块下的全部 IPC handler */
export function registerProxyPoolIpcHandlers(): void {
  registerValidateHandler()
  registerNetworkRouteValidateHandler()
  registerDiagnoseChainHandler()
}
