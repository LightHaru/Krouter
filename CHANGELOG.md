# Changelog

All notable Krouter changes are tracked here.

## Unreleased

### Added

- **CI on GitHub Actions.** Three jobs on every push and pull request to `main`: typecheck +
  lint, unit tests on both Ubuntu and Windows, and a full `build:fullstack` that asserts the
  dashboard and backend artifacts were actually produced. Krouter has platform-specific paths
  for the hosts file, certificate store, and data directory, so both operating systems are
  tested rather than just the development machine.
- **MitmProxy request tests** (10 tests, previously zero). The MITM path rewrites a 64-hex
  device ID and must forward everything else byte-for-byte, since request bodies carry
  user-typed text and a `Content-Length` the IDE already computed. The tests pin byte integrity
  across chunk boundaries, non-UTF-8 payloads, `\r\n\r\n` appearing inside a body, and the
  buffering of body fragments that arrive during the upstream TLS handshake. Each one was
  checked against a deliberately reintroduced bug to confirm it fails when the behaviour breaks.
- **Store write-path tests** covering coalescing, immediate-write semantics, and `flush()`.

### Changed

- **Store writes are coalesced on the hot path.** `onConfigChanged` fires at the end of
  `recordApiKeyUsage()` — that is, on every proxied request — and nothing awaits it. Each event
  previously triggered a full serialize + file write + backup copy of the entire store: measured
  at ~17 ms for a 593 KB store, all of it serialized through a single queue, or roughly a 17%
  duty cycle at 10 req/s and growing linearly with store size. Fire-and-forget writes now pass
  through `scheduleSave()`, which collapses a burst into one disk write per 250 ms window, and
  the `.bak` copy is taken at most once a minute instead of once per write. Callers that await
  `save()` still get the old guarantee: when the promise resolves, the data is on disk.
- **Shutdown flushes instead of saving**, so a write pending inside the coalescing window is
  written out rather than lost.
- **ESLint no longer scans runtime data directories.** `.web-data` and friends are in
  `.gitignore`, but ESLint 9's flat config does not read `.gitignore`; the vendored Chromium
  bundles inside them accounted for 437 of 450 reported errors and buried the real ones. CommonJS
  scripts are also exempt from `no-require-imports`, which does not apply to them.

### Removed

- **Dead `login()` in the CLI**, left over from before the backend granted access to localhost
  requests. It read an admin password from the environment or `.env` and was never called.

### Known limitations

- In MITM mode, a device ID appearing in the request *body* is rewritten only within the portion
  that arrives in the same chunk as the request headers; anything past that is forwarded
  untouched. A TLS record holds up to ~16 KB, so ordinary Kiro requests are unaffected, but a
  request larger than one record can reach upstream with its original ID in the body. Headers are
  always rewritten. This is pinned by a test so the behaviour cannot change silently.

## 2.0.0 - 2026-07-26

Krouter is no longer a Kiro-only router. This release adds three more upstream families
(ChatGPT/Codex, Bedrock images, and arbitrary OpenAI/Anthropic-compatible providers), an
optional MITM mode that redirects IDE traffic without touching the IDE's own configuration,
and per-request usage analytics. It also lands a full-codebase audit: 25 defects fixed,
`no-explicit-any` eliminated from `src/`, and the lint baseline taken to zero errors.

### Added

- **ChatGPT / Codex upstream.** OAuth device-code sign-in with token rotation, a multi-account
  pool with automatic failover, and per-account quota windows. Serves the `gpt-5.6-sol`,
  `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, and
  `gpt-5.3-codex-spark` models with configurable reasoning effort.
- **Custom API providers.** Register any OpenAI- or Anthropic-compatible endpoint as an upstream,
  with per-provider base URL, credentials, model allow-list, and a connection test action.
- **Usage analytics.** Per-request accounting persisted across restarts, aggregated over
  `today` / `24h` / `7d` / `30d` / `60d` / `all`, broken down by model, account, API key, and
  endpoint, with a dedicated dashboard page.
- **MITM HTTPS mode (K-Proxy Phase 12).** A local HTTPS listener plus optional hosts-file
  redirection that routes Kiro, Copilot, Antigravity, and Cursor traffic through Krouter
  without editing each IDE's settings. Includes its own root CA, per-host certificate
  generation, a model-mapping table, and startup diagnostics.
- **Image generation.** Free image generation over the ChatGPT OAuth session and an Amazon
  Bedrock image path, exposed at `/v1/images/generations` with a `krouter-image` skill.
- **MCP server.** Krouter exposes its own account/quota tools over MCP at `/mcp`.
- **Endpoint catalog in the dashboard.** Every served route is now listed in one place:
  `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/anthropic/v1/messages`,
  `/v1/messages/count_tokens`, `/v1beta/models/:model:generateContent` (+ streaming),
  `/v1/images/generations`, `/v1/models`, `/mcp`, and the skills routes.
- **Dashboard tunnel.** Publish the local dashboard through a tunnel and read its status from
  the Proxy page.
- **Manual token injection** for accounts whose credentials are obtained outside Krouter, plus
  a VPS helper script.
- **IPC parity test.** A static test that compares the Electron `ipcMain` surface, the preload
  API, and the standalone server's `handleIpc` dispatch, so a handler added to one runtime and
  forgotten in the other now fails CI instead of failing silently at runtime.

### Fixed

Findings from a full-codebase audit. Each was reproduced against the source before the fix.

- **ChatGPT account state was silently discarded.** `persistChatGPTAccounts()` replaced the live
  account array with a fresh copy on every save, so the account object already returned to the
  caller was detached. Per-request usage counters were lost on every successful Codex request,
  and a refresh token rotated for the second or later account in a failover chain was overwritten
  by the next save — bricking that account after a restart.
- **Peer-synced accounts were dropped while the API reported success.** The merge step only
  re-keyed on a collision with a *live* account, never with a deletion tombstone, so
  `enforceDeletionTombstones` deleted the account immediately after it was written. The response
  was built from the pre-filter data, so `added` and `addedAccountIds` reported accounts the
  store had discarded. Tombstones are also produced by automatic proxy maintenance, so this
  triggered without any user action.
- **MITM corrupted non-ASCII request bodies.** The TLS-plaintext stream was accumulated as a
  JavaScript string, so a multi-byte character split across two TCP reads became U+FFFD and the
  byte count no longer matched `Content-Length`. Any Vietnamese, CJK, or emoji prompt passing
  through K-Proxy could reach AWS malformed. Header/body splitting is now done on `Buffer`.
- **Backend schedulers were starved by dashboard autosave.** `saveAccounts` unconditionally
  re-armed the token-refresh and proxy-maintenance timers, and the dashboard autosaves every
  30 seconds, so a 5-minute or 30-minute interval never elapsed while a dashboard tab was open.
  On a headless VPS, tokens expired with nothing refreshing them.
- **Expired tokens were marked as fresh.** The sanitized SSE payload dropped `accessToken` but
  kept `expiresIn`; the renderer fell back to the *old* token and gave it the *new* expiry,
  overwriting the server's correct write-back. Nothing refreshed the account afterwards.
- **Accounts failing 401/403 were never cooled down.** Unlike the 429, billing, and 5xx branches,
  the auth-failure branch rotated away without recording the failure, so the dead account stayed
  fully available and was re-selected on the next request — spending a real SSO refresh each time.
- **"Reset pool" could leave the pool unusable.** `reset()` cleared account state but not the
  rate-limit budgets or sliding windows, so under the `smart` strategy every account was still
  skipped and the next request returned `503 no_eligible_account`.
- **Requests could hang with no response.** In the MITM HTTPS server, six `return this.passthrough(...)`
  sites inside `try/catch` returned the promise without awaiting it, so a rejection was adopted
  after the `try` frame had popped and never reached the `catch` that writes the error response.
  The same class of bug was fixed in the MCP HTTP handler and stdio transport.
- **K-Proxy could report "running" with nothing listening.** A failed `listen()` (for example
  `EADDRINUSE`) left the server object in place, and `isRunning()` was derived from that object,
  so status reported running, the start guard short-circuited every retry as successful, and the
  UI toggle flipped back on.
- **Rotating proxies without credentials had their URL corrupted.** The session-token splice
  assumed a `user:pass@` segment; without one it inserted the token before the final character,
  producing an unusable URL that could not be recovered because the original was cleared.
- **Abandoned registration steps destroyed the next attempt's TLS session.** `withTimeout()`
  rejected without cancelling the wrapped work, which then called `rebuildTlsClient()` on shared
  state belonging to the retry. Attempts now carry a generation counter and stale work stops
  before mutating shared state.
- **A transient mail-server error hid the OTP permanently.** TempMail.Plus marked a message as
  checked *before* fetching it, so one failed read removed that message from consideration for
  the rest of the polling window.
- Fixed the webhook trigger never being wired in the web/headless runtime, so
  `proxy-account-suspended`, `proxy-all-exhausted`, and `proxy-pool-low` produced no alert.
- Fixed MITM being impossible to start from the web dashboard whenever the proxy ran on a port
  other than 5580, because the server runtime never injected the configured router port.
- Fixed the Kiro Settings model dropdown listing the aggregated proxy catalog (Bedrock, custom
  API, ChatGPT) instead of Kiro models, so users saved model ids Kiro IDE cannot resolve.
- Fixed steering filenames containing Vietnamese, CJK, or accented characters being rejected by
  every steering handler while still being listed in the UI.
- Fixed image content being dropped from Codex chat requests, so the model answered as if no
  image had been attached while the request still returned `200`.
- Fixed `/v1/responses` returning `502` for OpenAI-compatible providers that omit `usage`.
- Fixed Gemini streaming skipping usage accounting when the client disconnected, so exhausted
  accounts still looked like they had quota.
- Fixed whitespace-only stream deltas being discarded, which diverged from the non-streaming and
  Gemini paths and could drop indentation inside code blocks.
- Fixed the clipboard failing silently on the HTTP dashboard (`navigator.clipboard` is
  secure-context only) — all 26 copy actions now share one helper with an `execCommand` fallback.
- Fixed an expired session leaving the dashboard in a broken state: `/api/ipc` 401s are now
  surfaced, the SSE reconnect uses exponential backoff instead of a flat 2-second loop, and the
  login screen reappears.
- Fixed the web file picker hanging forever when the user cancelled the dialog, which left the
  Import button stuck.
- Fixed the proxy gateway API key being generated with `Math.random()` instead of a CSPRNG.
- **The backend now restores the hosts file when it shuts down.** K-Proxy points `kiro.dev`,
  `amazonaws.com`, `githubcopilot.com`, and `cursor.com` at `127.0.0.1` system-wide. Nothing
  undid that on process exit, so `Ctrl-C`, `systemctl stop`, a deploy restart, or an OOM kill
  left those domains resolving to a port with no listener — breaking Kiro IDE, Copilot, and
  Cursor until the user edited the hosts file by hand. `SIGINT`/`SIGTERM` now remove the entries
  under a dedicated 8-second budget (the elevation prompt on Windows can block), and print a
  loud, actionable message if removal fails. Only Krouter's own marked block is touched; entries
  the user added themselves are never modified.
- Fixed unbounded growth in per-model statistics, API-key usage maps, proxy deletion tombstones,
  and per-account sliding windows and rate-limit budgets.
- Fixed a tunnel socket leak in the registration chain proxy when the client disconnected during
  dial, and a missing overall timeout on the OTP wait step.
- Fixed `save-mcp-server` throwing an opaque error when `mcp.json` lacked an `mcpServers` key.

### Changed

- **Krouter is now web-only.** The Electron desktop app is gone: no `src/main/index.ts`, no
  preload bridge, no tray, no electron-builder. What remains is the backend, the dashboard SPA,
  and the CLI. The proxy core, K-Proxy, and registration automation are unchanged and still live
  under `src/main/`.
- Type-checked the previously untyped boundaries: the CodeWhisperer ↔ OpenAI conversion, the
  Chrome DevTools Protocol client, and the schemaless account store now have declared shapes.
  This surfaced five latent null-safety defects that `any` had been hiding.
- Removed `any` from `src/` entirely and took the lint baseline to zero errors.
- Enabled type-aware `no-floating-promises` and `return-await` for `src/main`, where an unhandled
  rejection can take down the process.
- Raised the Vitest timeout to 30s. The previous 5s default caused a test to time out under
  full-suite load and leak async work into the next test's assertions.

### Removed

- Removed a write-only string accumulator from both streaming paths that grew for the lifetime of
  every request without ever being read.

## 1.9.0 - 2026-06-23

### Added

- Added backend-owned proxy maintenance that continues while the dashboard is closed. It can periodically download the IPLocate free proxy list, validate candidates, add live routes, remove dead managed routes, check saved accounts, and remove terminally dead accounts after a configurable threshold.
- Added proxy-maintenance controls and live status to the Proxy Pool page, including interval, source URL, validation concurrency, account-health settings, run-now action, counters, next-run time, and recent error reporting.
- Added direct proxy URL account bindings so accounts imported from registration or history keep the exact route used during registration even when the route is not a permanent proxy-pool entry.
- Added account-bound proxy support to token refresh, quota reads, profile discovery, liveness checks, background refresh, backend maintenance, and API proxy requests.
- Added registration proxy rotation per task, proxy cooldown/exclusion tracking, route verification, exit-IP reporting, and strict client-proxy routing.
- Added a registration safety circuit breaker. It stops after repeated network preflight failures, repeated AWS/Kiro service rejections, repeated proxy-gateway HTML `403` responses, TES/risk-control blocks, or newly suspended accounts.
- Added Kiro payload compaction for oversized messages, history, and tool results while preserving the beginning and latest context.
- Added a second compact-and-retry pass for `CONTENT_LENGTH_EXCEEDS_THRESHOLD` responses.
- Added environment controls for Kiro content limits through `KROUTER_KIRO_CONTENT_CHAR_LIMIT` and `KIRO_CONTENT_CHAR_LIMIT`.
- Added periodic frontend-to-backend account synchronization while the dashboard is visible, plus refreshes after background token and account checks.
- Added Windows `start-krouter.cmd` and `stop-krouter.cmd` helpers.
- Added unit and E2E coverage for round-robin distribution, payload compaction, Builder ID liveness, proxy maintenance, persisted proxy startup, direct proxy bindings, registration route failures, and safety-circuit behavior.

### Changed

- Changed the default API proxy account strategy from Smart to strict per-request Round-Robin with session affinity disabled, distributing sequential requests across available accounts.
- Changed registration batches using the proxy pool to one concurrent registration at a time to reduce repeated security and gateway failures.
- Changed registration ordering so AWS portal and workflow initialization must succeed before Krouter creates a temporary mailbox.
- Changed `Continue on task error` to skip ordinary task failures only. Security blocks, suspended accounts, repeated `403` responses, and safety-circuit failures still stop the batch.
- Changed account import liveness to require a real model `pong` response. Credential/quota-only fallbacks no longer appear as successful model checks.
- Changed Builder ID placeholder `profileArn` handling to try model liveness, preserve the original authorization failure when fallback fails, and report rate limits or missing streaming capability as failures instead of green success.
- Changed account health-state merging so transient network errors, `429` responses, and profileArn-only limitations do not overwrite a previously live account as dead.
- Changed prompt thinking/reasoning fields to opt-in through `KROUTER_ENABLE_KIRO_THINKING_FIELDS=1` or `KIRO_ENABLE_THINKING_FIELDS=1`, preventing unsupported request fields from breaking otherwise compatible models.
- Changed account-bound proxy failures to fail closed instead of silently falling back to the system IP.
- Changed proxy-pool persistence to preserve backend-managed IPLocate entries and deletion tombstones across frontend synchronization.
- Changed proxy maintenance and account synchronization to refresh the active API proxy pool after stored data changes.

### Fixed

- Fixed long Claude/OpenAI-compatible conversations failing with `400 CONTENT_LENGTH_EXCEEDS_THRESHOLD` during compaction or large tool-result workflows.
- Fixed content-length request errors incorrectly penalizing account health or rotating away from otherwise healthy accounts.
- Fixed large histories repeatedly using one account instead of distributing requests across the live account pool.
- Fixed account proxy bindings being lost when stored as direct URLs instead of proxy-pool IDs.
- Fixed newly registered accounts reverting to the system IP during quota verification, liveness checks, token refresh, or later API proxy usage.
- Fixed proxy pool preflight accepting routes that could reach an IP-check service but returned an HTML `403 Forbidden` page for AWS sign-in.
- Fixed `WorkflowInit` and `WorkflowStart` ignoring non-`200` HTTP responses and continuing until `SubmitEmail`, which unnecessarily created mailboxes before reporting a route failure.
- Fixed `SubmitEmail`, `SetPassword`, and SSO token failures returning ambiguous or non-JSON errors.
- Fixed repeated proxy-gateway `403` failures being reset by a successful IP preflight, allowing a batch to continue through every task.
- Fixed batch progress and error classification for proxy timeouts, route failures, TES blocks, service rejections, and suspended accounts.
- Fixed dead or rate-limited proxy routes being immediately selected again during the same batch.
- Fixed backend account refreshes and liveness checks omitting the account's bound proxy.
- Fixed dashboard account state lagging behind backend maintenance, refresh, and deletion changes.
- Fixed API proxy defaults and saved runtime settings disagreeing after backend restart.

### Removed

- Removed the deprecated `scripts/kiro-manager-cli.cjs` compatibility entry from the npm package. The supported command remains `krouter`.

## 1.8.11 - 2026-06-11

### Fixed

- Fixed remote account sync verification so the local dashboard only marks accounts as synced after the remote backend confirms the accounts are present.
- Added remote sync response fields for accepted, skipped, and summarized remote accounts, preventing false success when the VPS skips or deduplicates accounts.

## 1.8.10 - 2026-06-11

### Fixed

- Fixed VPS account sync skipping distinct local accounts when both accounts only had the fixed placeholder `profile/AAAACCCCXXXX` ARN. The sync duplicate check now ignores placeholder profile ARNs and still deduplicates by real email/provider, user ID, refresh token, and API key.

## 1.8.9 - 2026-06-11

### Added

- Added VPS account sync passwords for local-to-VPS account transfer through changing tunnel URLs without using the dashboard admin password.
- Added `krouter sync-password` and `krouter sync-password status` to create and inspect the account sync password from the terminal.
- Added a local registration-page sync panel that accepts the current Krouter tunnel URL plus sync password and tags synced local accounts as `Da dong bo`.

### Changed

- Remote account sync now uses a dedicated `/api/account-sync/merge` endpoint with duplicate detection and returns the local account IDs that were accepted or already present.

### Fixed

- Fixed remote sync failures returning unclear TypeError messages when sync input is missing or malformed.

## 1.8.8 - 2026-06-09

### Added

- Added Claude 4+ thinking/reasoning metadata for Krouter model lists, including Opus 4.5/4.7/4.8, Sonnet 4/4.5, and Haiku 4.5.
- Added OpenAI-compatible `reasoning_effort` and Claude-compatible `output_config.effort` forwarding into Kiro model request fields.
- Added regression tests for thinking effort, thinking budget, Responses API reasoning effort, and Claude 3.x exclusion.

### Changed

- Tuned AmazonQ/Kiro 429 retry pacing to a shorter bounded 5-10 second cooldown so the proxy can continue rotating accounts without hanging for long throttle windows.
- Improved Kiro Settings and global responsive safeguards so narrow screens no longer crush headers, dialogs, and endpoint rows.
- Improved Kiro settings JSONC parsing so comments and trailing commas are handled before saving.

### Fixed

- Fixed TES/BLOCKED SendOTP errors being shown as raw 400 bodies instead of classified AWS risk-control failures.
- Fixed E2E coverage to skip non-refreshable API-key accounts for refresh-only flows and to cover TES/BLOCKED registration stopping behavior.

## 1.8.7 - 2026-06-08

### Added

- Added API-key account import/login support for `ksk_...` keys so headless Kiro API accounts can be added from the dashboard and used by the API proxy.
- Added responsive shell coverage for Android, iOS, tablet, and desktop layouts with the sidebar kept as a left rail on narrow screens.

### Changed

- Reworked the web app shell to use `100dvh`, safe-area insets, a persistent left sidebar rail, and responsive wrapping for account, proxy, register, logs, and machine-id controls.
- Updated dashboard login, setup, update, about, sidebar, and K-Proxy copy to use Vietnamese with proper diacritics.
- Improved API proxy account handling so stored `ksk_...` API-key accounts are treated as API-key credentials even when older saved records do not have explicit `authMethod` metadata.

### Fixed

- Fixed API-key account liveness checks being skipped with a missing `profileArn` message.
- Fixed narrow-screen toolbar and filter rows causing horizontal overflow inside the dashboard.

## 1.8.6 - 2026-06-07

### Added

- Added `krouter update` and `krouter update check` so the terminal CLI can update the global npm package without requiring dashboard login.
- Added a local-only CLI authorization token generated in `~/.krouter/.env`, allowing SSH/admin terminal commands to call the backend without the dashboard password.

### Changed

- `krouter` now opens the dashboard/menu without requiring `KROUTER_ADMIN_PASSWORD`; the dashboard password remains only for browser login.
- The CLI restarts a local backend when it detects the running backend version is older than the installed package version.

## 1.8.5 - 2026-06-07

### Added

- Added realtime API proxy quota updates from backend request handling to the web dashboard, so account usage can move immediately after successful proxy calls.
- Added unit-test tooling with Vitest and property-based coverage support for future proxy/runtime regressions.

### Changed

- Improved Opus/power-model routing with model capability checks, per-model pacing, and cooldown-aware retries so temporary AmazonQ/Kiro throttling can wait and continue instead of failing the whole request too early.
- Improved backend/frontend usage merging so background refreshes and reset-date format differences do not roll quota usage backward within the same billing window.
- Updated API proxy account rotation defaults toward smart balancing and stricter model-tier routing for power-only models.

### Fixed

- Fixed streaming proxy success paths to persist account usage and emit account update events for both OpenAI-compatible and Claude-compatible streaming calls.
- Fixed stale web sessions restoring deleted accounts by tracking delete tombstones during storage sync.

## 1.8.4 - 2026-06-07

### Changed

- Increased account cooldown for AmazonQ/Kiro `429` throttling from a short 2 second retry window to a 60 second exponential cooldown capped at 15 minutes, so power accounts are not retried immediately while rate-limited.
- Reordered the VPS OpenClaw default fallback chain to prefer stable Kiro Sonnet/Haiku models before retrying Opus models when a selected model is unavailable.

## 1.8.3 - 2026-06-07

### Added

- Added dashboard update popup for npm/web installs with update, dismiss, and one-day snooze actions.
- Added backend self-update support through `@lightharu/krouter@latest`, with optional restart via `KROUTER_RESTART_COMMAND`.
- Added K-Proxy MITM roadmap documentation.

### Changed

- K-Proxy MITM now auto-starts on web backend restart when its saved `autoStart` setting is enabled.
- K-Proxy dashboard now shows daemon state, auto-start state, API routing state, and CA trust state in one place.
- Web update checks now prefer npm package metadata and only fall back to GitHub releases.

## 1.8.2 - 2026-06-06

### Added

- Added the `Smart` API proxy account rotation strategy. It scores accounts by quota headroom, recent errors, request count, latency, idle time, and token freshness before selecting an account.
- Added a complete API Proxy setup guide in Vietnamese and English.
- Added API Proxy guide images for the request flow, dashboard settings, and client API key setup.

### Changed

- New proxy defaults now prefer `Smart` multi-account rotation instead of plain round-robin.
- Included `docs/` in the npm package so installed users can read the API Proxy guide.

## 1.8.1 - 2026-06-06

### Fixed

- Fixed account usage cards showing inflated quota percentages such as `300%` or `690%` while the raw quota was still low, for example `1/50` or `3/50`.
- Normalized `percentUsed` to the internal `0..1` ratio across backend refresh, frontend storage load, direct account updates, and registration/import flows.
- Existing saved accounts with stale percentage values are corrected automatically when the dashboard loads or when backend auto refresh updates account quota.

### Changed

- Added this changelog and included it in the npm package so every git/version update has an audit trail.

## 1.8.0 - 2026-06-06

### Added

- Published Krouter as the public npm package `@lightharu/krouter`.
- Added the `krouter` CLI entry for dashboard startup, service status, tunnel management, and OpenClaw import.
- Added backend auto refresh for logged-in accounts so tokens and quota can be refreshed while the web dashboard is not open.
- Updated README and project metadata for the Krouter web dashboard, CLI, tunnel, API proxy, and OpenClaw workflow.
