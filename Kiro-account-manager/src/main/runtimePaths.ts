import path from 'path'

export function getRuntimeUserDataPath(): string {
  try {
    const electron = require('electron') as { app?: { getPath?: (name: string) => string } }
    const electronPath = electron.app?.getPath?.('userData')
    if (electronPath) return electronPath
  } catch {
    // Running as the VPS web backend without Electron installed.
  }

  return path.resolve(process.env.KROUTER_DATA_DIR || process.env.KAM_DATA_DIR || process.env.KIRO_RUNTIME_DATA_DIR || process.env.KIRO_WEB_DATA_DIR || '.web-data')
}
