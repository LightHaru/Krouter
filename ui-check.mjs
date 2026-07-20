import { chromium } from 'playwright'
const base = 'http://127.0.0.1:4011'
const b = await chromium.launch({ headless: true })
const ctx = await b.newContext({ viewport: { width: 1440, height: 1100 } })
const p = await ctx.newPage()
const errs = []
p.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })
p.on('pageerror', e => errs.push('PAGEERR: ' + e.message))

// Mock proxyGetStatus so the running dashboard + cache card render with realistic data.
const fakeStats = {
  totalRequests: 42, successRequests: 40, failedRequests: 2,
  totalTokens: 120000, totalCredits: 3.14,
  inputTokens: 30000, outputTokens: 20000,
  cacheReadTokens: 70000, cacheWriteTokens: 8000,
  reasoningTokens: 5000,
  startTime: Date.now() - 3600_000,
  accountStats: {}, endpointStats: {}, modelStats: {}, recentRequests: []
}
const fakeConfig = {
  enabled: true, autoStart: true, port: 5580, host: '127.0.0.1',
  enableMultiAccount: true, accountSelectionStrategy: 'smart', multiAccountSelectionMode: 'all'
}
await p.route('**/api/ipc', async (route) => {
  const body = route.request().postDataJSON?.()
  if (body?.method === 'proxyGetStatus') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      running: true, config: fakeConfig, stats: fakeStats,
      sessionStats: { requests: 5, success: 5, failed: 0, startTime: Date.now() - 60000 }
    }) })
    return
  }
  if (body?.method === 'proxyLoadLogs') {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      success: true, logs: [
        { time: '10:01:22', path: '/v1/messages', model: 'anthropic.claude-sonnet-4', status: 200, inputTokens: 1200, outputTokens: 800, cacheReadTokens: 45000, cacheWriteTokens: 3000, reasoningTokens: 400, credits: 0.12, responseTime: 2300 },
        { time: '10:00:58', path: '/v1/messages', model: 'anthropic.claude-sonnet-4', status: 200, inputTokens: 5000, outputTokens: 300, cacheWriteTokens: 12000, credits: 0.08, responseTime: 1800 },
        { time: '10:00:31', path: '/v1/chat/completions', model: 'anthropic.claude-opus-4', status: 503, inputTokens: 900, outputTokens: 0, error: 'upstream', responseTime: 500 }
      ]
    }) })
    return
  }
  await route.continue()
})

await p.goto(base, { waitUntil: 'networkidle' })
try {
  await p.fill('input[type=password]', 'admin1234', { timeout: 5000 })
  await p.keyboard.press('Enter')
  await p.waitForTimeout(2500)
} catch (e) { console.log('login note:', e.message) }

// Navigate to Proxy page via sidebar. Server icon (Database) is the proxy nav.
try {
  await p.evaluate(() => {
    const btns = [...document.querySelectorAll('button, a, [role=button]')]
    const hit = btns.find(el => /proxy|dịch vụ api/i.test(el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || ''))
    if (hit) hit.click()
  })
  await p.waitForTimeout(1500)
} catch (e) { console.log('nav note:', e.message) }

// Inject recent logs with cache hits directly into the module cache used by the table.
await p.evaluate(() => {
  // trigger a status refresh so stats card renders, then screenshot handled outside
})
await p.waitForTimeout(1200)
// Scroll the cache-hit stat card into view and clip a tight screenshot around the stat row.
const found = await p.evaluate(() => {
  const el = [...document.querySelectorAll('span')].find(s => /^Cache hit$/i.test(s.textContent?.trim() || ''))
  if (!el) return false
  const card = el.closest('.grid') || el.closest('div')
  card?.scrollIntoView({ block: 'center' })
  return true
})
console.log('cache card found:', found)
await p.waitForTimeout(500)
await p.screenshot({ path: 'ui-3-proxy-page.png' })
// Scroll to the recent-requests table and clip it for Part C verification.
const tableFound = await p.evaluate(() => {
  const el = [...document.querySelectorAll('*')].find(s => /Request gần đây|Recent Requests/i.test(s.textContent?.trim() || '') && s.children.length < 6)
  el?.scrollIntoView({ block: 'center' })
  return !!el
})
console.log('recent table found:', tableFound)
// Verify the table actually rendered rows with the cache-hit badge, then clip just the card.
const tableInfo = await p.evaluate(() => {
  const title = [...document.querySelectorAll('*')].find(s => /Request gần đây|Recent Requests/i.test(s.textContent?.trim() || '') && s.children.length < 3)
  const card = title?.closest('[class*="rounded"]') || title?.parentElement?.parentElement?.parentElement
  if (card) card.scrollIntoView({ block: 'start' })
  const badges = [...document.querySelectorAll('span')].filter(s => /^✓[\d,]+$/.test(s.textContent?.trim() || ''))
  const writeBadges = [...document.querySelectorAll('span')].filter(s => /^\+[\d,]+$/.test(s.textContent?.trim() || ''))
  return { hasTitle: !!title, cacheHitBadges: badges.map(b => b.textContent), writeBadges: writeBadges.map(b => b.textContent) }
})
console.log('table info:', JSON.stringify(tableInfo))
await p.waitForTimeout(500)
await p.screenshot({ path: 'ui-4-recent-table.png' })
console.log('URL:', p.url())
console.log('CONSOLE ERRORS:', errs.length ? errs.slice(0, 10).join(' | ') : 'none')
await b.close()
