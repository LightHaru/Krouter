import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

// Standalone test configuration kept separate from vite.web.config.ts
// so unit/property tests for the proxy do not interfere with web builds.
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['test/proxy/**/*.test.ts', 'test/docs/**/*.test.ts'],
    globals: true,
    // Mặc định 5s là quá chặt cho suite này: khi chạy full suite (collect ~200s) các test
    // có I/O thật như diagnosticsBuilderId bị timeout dù chạy riêng chỉ mất ~0.5s. Test bị
    // timeout vẫn để công việc async chạy tiếp và gọi mock SAU beforeEach của test kế tiếp,
    // làm hỏng số lần gọi của test đó — tức một timeout kéo theo lỗi giả ở test khác.
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
