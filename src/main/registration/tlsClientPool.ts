// TLS 客户端进程级共享池
//
// 背景：tlsclientwrapper 的 ModuleClient 内部是 piscina worker pool + 加载 DLL，
// 每次新建 + open() 大约要 1-3 秒，批量注册时累计可达数十秒。
// 由于 DLL 路径 / customLibraryPath 在整个应用生命周期内是稳定的，所有 Registrar 完全可以共用同一个 ModuleClient
// （SessionClient 才是真正"按注册"独立的 TLS 会话/指纹层）。
//
// 设计：
//   - 首次 acquireModuleClient() 时 open，之后所有调用直接拿同一个实例
//   - 用 openPromise 防止并发首调导致重复 open
//   - 主进程退出前统一 shutdownTlsClientPool() 释放 worker pool

import { ModuleClient } from 'tlsclientwrapper'

interface AcquireOpts {
  /** 已存在的完整 DLL 文件路径（首次 open 时使用） */
  customLibraryPath?: string
  /** 没有 customLibraryPath 时，由 tlsclientwrapper 自动下载到此目录 */
  customLibraryDownloadPath?: string
}

let shared: ModuleClient | null = null
let openPromise: Promise<ModuleClient> | null = null

/**
 * 获取共享 ModuleClient。首次调用 open()，之后所有调用都拿同一个实例。
 * 注意：传入的 opts 仅在首次有效；后续调用会忽略 opts 直接复用。
 */
export async function acquireModuleClient(opts: AcquireOpts): Promise<ModuleClient> {
  if (shared) return shared
  if (openPromise) return openPromise
  openPromise = (async () => {
    const mc = new ModuleClient(opts)
    await mc.open()
    shared = mc
    openPromise = null
    return mc
  })()
  try {
    return await openPromise
  } catch (err) {
    openPromise = null
    throw err
  }
}

/** 是否已经开启了共享池（用于诊断 / 日志） */
export function isModuleClientReady(): boolean {
  return shared !== null
}

/** 调试用：拿到 piscina 池统计 */
export function getModuleClientPoolStats(): unknown {
  return shared ? shared.getPoolStats() : null
}

/**
 * 应用退出前统一清理：terminate 共享 ModuleClient。
 * 带超时保护（5s），避免 DLL 内残留请求把退出卡住。
 */
export async function shutdownTlsClientPool(): Promise<void> {
  const mc = shared
  shared = null
  openPromise = null
  if (!mc) return
  try {
    await Promise.race([
      mc.terminate(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('terminate timeout')), 5000))
    ])
  } catch { /* 超时 / piscina 终止错误均忽略 */ }
}
