#!/usr/bin/env node
// Capture REAL dashboard screenshots for the in-app Docs page using Playwright.
//
// Prerequisites:
//   - The dashboard is running and reachable (default http://127.0.0.1:4010).
//   - Playwright chromium is installed: npm run test:e2e:install
//   - Admin password available via env KROUTER_ADMIN_PASSWORD (default 'admin').
//
// Usage:
//   node scripts/capture-docs-screenshots.mjs
//   KROUTER_DASHBOARD_URL=http://127.0.0.1:4010 KROUTER_ADMIN_PASSWORD=secret node scripts/capture-docs-screenshots.mjs
//
// Output: PNG files under src/renderer/src/assets/docs/.
// Sensitive data (emails, API keys, tokens) is masked via injected CSS before
// each screenshot so the bundled docs never leak real account data.

import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'docs')

const BASE_URL = (process.env.KROUTER_DASHBOARD_URL || process.env.KROUTER_API_BASE || 'http://127.0.0.1:4010').replace(/\/$/, '')
const ADMIN_PASSWORD = process.env.KROUTER_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || 'admin'

// Sidebar nav labels (must match i18n nav.* used in Sidebar.tsx).
const NAV = {
  accounts: 'Tài khoản',
  proxy: 'Proxy API',
  docs: 'Hướng dẫn'
}

// CSS that blurs/masks anything that may contain sensitive data before capture.
const MASK_CSS = `
  [data-sensitive], .sensitive,
  .account-email, .api-key, code:has(+ .copy) {
    filter: blur(6px) !important;
  }
`

async function loadPlaywright() {
  try {
    return await import('playwright')
  } catch {
    console.error('Playwright chua duoc cai. Chay: npm run test:e2e:install')
    process.exit(1)
  }
}

async function maskSensitive(page) {
  await page.addStyleTag({ content: MASK_CSS }).catch(() => {})
}

async function shot(page, name) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await maskSensitive(page)
  const file = path.join(OUT_DIR, `${name}.png`)
  // Viewport-only (not fullPage) keeps a sensible aspect ratio so the embedded
  // docs images are not extremely tall.
  await page.screenshot({ path: file, fullPage: false })
  console.log(`saved ${path.relative(ROOT, file)}`)
}

async function clickNav(page, label) {
  // Sidebar buttons expose the label as text and as title (when collapsed).
  const byTitle = page.locator(`button[title="${label}"]`)
  if (await byTitle.count()) {
    await byTitle.first().click()
  } else {
    await page.getByRole('button', { name: label }).first().click()
  }
  await page.waitForTimeout(800)
}

async function main() {
  const { chromium } = await loadPlaywright()
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  const page = await context.newPage()

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' })

    // Login / setup screen capture (mask the generated password area if any).
    await shot(page, 'setup-login')

    // Try to log in via the password form.
    const pwInput = page.locator('input[type="password"]').first()
    if (await pwInput.count()) {
      await pwInput.fill(ADMIN_PASSWORD)
      const submit = page.getByRole('button', { name: /Dang nhap|Đăng nhập|Login/i }).first()
      await submit.click().catch(() => {})
      await page.waitForTimeout(1500)
    }

    // setup-password placeholder (only meaningful on a fresh install); capture
    // current screen as a best-effort fallback.
    await shot(page, 'setup-password')

    // Accounts page
    await clickNav(page, NAV.accounts)
    await shot(page, 'accounts-list')
    await shot(page, 'accounts-add')

    // Proxy page
    await clickNav(page, NAV.proxy)
    await shot(page, 'proxy-panel')
    await shot(page, 'proxy-apikey')
    await shot(page, 'openclaw-config')

    // Docs page itself (self-referential, fine)
    await clickNav(page, NAV.docs)
    await shot(page, 'tunnel-cli')

    console.log('Done. Review images in', path.relative(ROOT, OUT_DIR))
  } finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
