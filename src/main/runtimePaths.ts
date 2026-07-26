import path from 'path'

/** Runtime data directory for the web backend (no desktop app). */
export function getRuntimeUserDataPath(): string {
  return path.resolve(
    process.env.KROUTER_DATA_DIR ||
      process.env.KAM_DATA_DIR ||
      process.env.KIRO_RUNTIME_DATA_DIR ||
      process.env.KIRO_WEB_DATA_DIR ||
      '.web-data'
  )
}
