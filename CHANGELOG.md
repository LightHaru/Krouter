# Changelog

All notable Krouter changes are tracked here.

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
