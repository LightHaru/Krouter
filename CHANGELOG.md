# Changelog

All notable Krouter changes are tracked here.

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
