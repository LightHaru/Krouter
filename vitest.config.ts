import { defineConfig } from 'vitest/config'

// Standalone test configuration kept separate from the web/electron Vite
// configs (vite.web.config.ts / electron.vite.config.ts) so unit and
// property-based tests for the proxy do not interfere with app builds.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/proxy/**/*.test.ts'],
    globals: true
  }
})
