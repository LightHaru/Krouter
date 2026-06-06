# Changelog

All notable Krouter changes are tracked here.

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
