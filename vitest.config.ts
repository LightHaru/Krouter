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
    globals: true
  }
})
