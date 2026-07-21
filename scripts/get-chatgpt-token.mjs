#!/usr/bin/env node
// Phase 15: Get ChatGPT OAuth token via PKCE flow (headless-friendly)
// Usage: node scripts/get-chatgpt-token.mjs
//
// This script starts the OAuth flow and prints the authorization URL.
// Copy the URL, open it in ANY browser (phone, laptop, etc), login,
// and the script will capture the callback token automatically.
//
// For VPS: make sure port 19836 is accessible (or use SSH tunnel)

import crypto from 'crypto'
import http from 'http'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const PORT = 19836
const AUTH_BASE = 'https://auth.openai.com'

const codeVerifier = crypto.randomBytes(32).toString('base64url')
const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
const state = crypto.randomBytes(16).toString('hex')

const params = new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: `http://localhost:${PORT}/auth/chatgpt/callback`,
  response_type: 'code',
  scope: 'openid profile email offline_access',
  code_challenge: codeChallenge,
  code_challenge_method: 'S256',
  state,
})

const authUrl = `${AUTH_BASE}/oauth/authorize?${params.toString()}`

console.log('\n=== ChatGPT OAuth Token Helper ===\n')
console.log('1. Open this URL in your browser:\n')
console.log(`   ${authUrl}\n`)
console.log('2. Login with your ChatGPT account (free works!)')
console.log(`3. After login, it will redirect to localhost:${PORT}`)
console.log('   (If on VPS, use SSH tunnel: ssh -L 19836:localhost:19836 user@vps)\n')
console.log('Waiting for callback...\n')

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  if (!url.pathname.includes('callback')) {
    res.writeHead(404)
    res.end()
    return
  }

  const code = url.searchParams.get('code')
  const receivedState = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    console.error(`\n❌ OAuth error: ${error}`)
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<h2>Login Failed</h2><p>Close this window.</p>')
    process.exit(1)
  }

  if (receivedState !== state) {
    console.error('\n❌ State mismatch — possible CSRF')
    res.writeHead(400)
    res.end('State mismatch')
    process.exit(1)
  }

  if (!code) {
    res.writeHead(400)
    res.end('No code')
    return
  }

  // Exchange code for tokens
  try {
    const tokenResp = await fetch(`${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: codeVerifier,
        client_id: CLIENT_ID,
        redirect_uri: `http://localhost:${PORT}/auth/chatgpt/callback`,
      }).toString()
    })

    if (!tokenResp.ok) {
      const err = await tokenResp.text()
      throw new Error(`Token exchange failed: ${err}`)
    }

    const tokens = await tokenResp.json()

    let email = ''
    if (tokens.id_token) {
      try {
        const payload = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString())
        email = payload.email || ''
      } catch {}
    }

    console.log('\n✅ Success! Tokens received:\n')
    console.log(`   Email: ${email || '(unknown)'}`)
    console.log(`   Access Token: ${tokens.access_token.slice(0, 20)}...`)
    console.log(`   Refresh Token: ${tokens.refresh_token.slice(0, 20)}...`)
    console.log(`   Expires In: ${tokens.expires_in}s`)

    console.log('\n📋 To inject into Krouter, run:\n')
    console.log(`curl -X POST http://localhost:5580/auth/chatgpt/token \\`)
    console.log(`  -H "Content-Type: application/json" \\`)
    console.log(`  -d '${JSON.stringify({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      email: email || undefined
    })}'`)

    console.log('\n')

    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<h2>✅ Success!</h2><p>Token captured. Return to terminal. You can close this window.</p>')

    setTimeout(() => process.exit(0), 1000)
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`)
    res.writeHead(500, { 'Content-Type': 'text/html' })
    res.end(`<h2>Error</h2><p>${err.message}</p>`)
    process.exit(1)
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Callback server listening on 0.0.0.0:${PORT}`)
})

// Timeout after 5 minutes
setTimeout(() => {
  console.log('\n⏰ Timed out (5 minutes). Try again.')
  process.exit(1)
}, 300_000)
