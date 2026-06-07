# Web Port Notes

This branch starts the Electron-to-web port for the `v1.7.2` codebase.

## Current Architecture

- `vite.web.config.ts` builds the existing React renderer as a browser app.
- `src/renderer/src/api/browserApi.ts` installs a browser `window.api` shim compatible with the Electron preload surface.
- `src/server/index.ts` provides the CLI backend entry point:
  - admin login/session cookies
  - encrypted account data persistence
  - generic `/api/ipc` bridge for renderer calls
  - `/api/events` server-sent events bridge for realtime IPC-style events
- `src/server/services/proxyRuntime.ts` runs the upstream reverse proxy on the VPS backend and wires proxy IPC handlers to the real `ProxyServer`.
- `src/server/services/kproxyRuntime.ts` runs the upstream K-Proxy service on the VPS backend, including CA generation/export and device ID mapping.
- `src/server/services/machineIdRuntime.ts` maps the Electron machine ID feature to the VPS host or to a configured machine-id file override.
- `src/server/services/localKiroCredentials.ts` maps local Kiro IDE/CLI credential import, switch, and logout to VPS filesystem targets.
- `src/server/services/protonBrowserRuntime.ts` maps the Electron Proton `BrowserWindow` flow to a server-side Chromium profile controlled through Chrome DevTools Protocol.

## Deploy

1. Copy `.env.web.example` to `.env.web`.
2. Set strong values for `APP_ENCRYPTION_KEY` and `SESSION_SECRET`.
   Leave `KROUTER_ADMIN_PASSWORD` unset to use the first-run setup screen, or set `KROUTER_ADMIN_EMAIL` and `KROUTER_ADMIN_PASSWORD` for unattended installs.
3. Review the VPS filesystem targets:
   - `KIRO_CONFIG_HOME` controls the Kiro settings/MCP/Steering directory.
   - `KIRO_SSO_CACHE_DIR` controls the Kiro IDE SSO cache target.
   - `KIRO_CLI_DB_PATH` controls the Kiro CLI SQLite database target.
   - `KIRO_MACHINE_ID_FILE` is optional. Leave it unset to read/write the host OS machine ID; set it for Docker/test deployments where machine ID writes should stay isolated.
   - `PUBLIC_BASE_URL` is used by legacy/manual OAuth callback helpers. Web IAM SSO uses the AWS device authorization flow because public OIDC clients only allow loopback redirect URIs.
   - `PROTON_BROWSER_PATH` must point to Chrome/Chromium for the Proton OTP source. Dockerfile.web installs `/usr/bin/chromium`.
   - `PROTON_BROWSER_HEADLESS=true` runs the server browser in headless mode and exposes `/proton-login` for remote login/captcha/2FA interaction.
   - `PROTON_BROWSER_NO_SANDBOX=true` can be set when Chrome cannot start under a container or constrained desktop session. Docker/root deployments enable this automatically.
4. Build and run the backend CLI:

```bash
npm run build:fullstack
npm run start:backend
```

`start:backend` runs `node out-server/server/index.js --api-only`. In this mode the backend serves `/api/*`, `/api/events`, `/healthz`, and `/proton-login`, but it does not serve frontend assets. Put nginx or another static web server in front of it:

```nginx
root /path/to/Krouter/dist-web;

location /api/ { proxy_pass http://127.0.0.1:4010; }
location = /healthz { proxy_pass http://127.0.0.1:4010; }
location = /proton-login { proxy_pass http://127.0.0.1:4010; }
location / { try_files $uri /index.html; }
```

The old fullstack mode is still available with `node out-server/server/index.js --serve-static` or `SERVE_STATIC=true`.

5. Docker fullstack deployment is still supported:

```bash
docker compose -f docker-compose.web.yml up -d --build
```

When deploying in Docker, filesystem-targeted features operate inside the container unless the matching host paths are bind-mounted. For example, host Kiro IDE/CLI switching requires mounting the host SSO cache or CLI database path into the container and pointing the env vars at the mounted paths.

## Porting Queue

The web foundation intentionally preserves the renderer API names, so Electron handlers can be ported one by one from `src/main/index.ts` and the split modules under `src/main`.

Ported backend runtime areas:

- Admin login/session and encrypted account store.
- Account token refresh/check/verify via the VPS backend.
- Kiro settings/MCP/Steering file management against `KIRO_CONFIG_HOME` or VPS `~/.kiro`.
- Reverse proxy runtime, API keys, account pool sync, logs, models, metrics/status, TLS cert info.
- K-Proxy runtime, CA generation/export, device ID mappings, status/start/stop.
- Machine ID read/write, backup/restore, random generation, admin/root permission checks, and optional file override.
- VPS-local Kiro IDE credential import/switch/logout against `KIRO_SSO_CACHE_DIR`.
- VPS-local Kiro CLI credential switch against `KIRO_CLI_DB_PATH`, using `sqlite3` when installed or Node `node:sqlite` as fallback.
- Account model list, subscription list, subscription URL, and overage preference handlers.
- Builder ID, IAM SSO, social login, and SSO-token import handlers with web callback routes under `/api/auth/*/callback`.
- Registration auto/manual handlers are wired to the upstream `Registrar` and emit logs/steps/completion through SSE.
- Tingamefi temp mail can be used as an auto-registration source. It creates addresses through the Cloudflare Email Worker admin API (`/admin/new_address`) and reads verification mail through `/admin/mails`.
- Proton mailbox login/OTP is wired to a VPS-side Chromium profile. Use the registration page's "Login Proton" action to open `/proton-login`, complete Proton login/captcha/2FA there, then run Proton or mixed-source registration. The remote login page supports screenshot refresh, click, scroll, text input, and basic keys against the server browser.
- Background batch refresh/check and diagnostics/proxy-pool/account-liveness handlers.

High-priority handlers still requiring full backend parity:

- Production PostgreSQL migration from the current encrypted file store.
