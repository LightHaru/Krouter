# Web Runtime Notes

Krouter is a **web dashboard + Node backend/CLI** product. There is no desktop app runtime.

## Architecture

- `vite.web.config.ts` builds the React dashboard as a browser app (`dist-web/`).
- `src/renderer/src/api/browserApi.ts` installs `window.api` over HTTP:
  - `POST /api/ipc` for RPC-style calls
  - `GET /api/events` SSE for realtime updates
- `src/server/index.ts` is the backend entry:
  - admin login / session cookies
  - encrypted account data persistence (`WebStore`)
  - proxy / kproxy / registration / diagnostics services
- Shared engine code lives under `src/main/` (proxy, kproxy, registration) — **not** a desktop main process.
- `src/server/services/proxyRuntime.ts` runs the OpenAI/Claude-compatible API proxy.
- `src/server/services/kproxyRuntime.ts` runs K-Proxy MITM (device ID rewrite).
- `src/server/services/machineIdRuntime.ts` reads/writes host or file-backed machine IDs.
- `src/server/services/localKiroCredentials.ts` maps Kiro IDE/CLI credential files on the host.
- `src/server/services/protonBrowserRuntime.ts` drives Chromium via CDP for Proton OTP.

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
4. Build and run:

```bash
npm run build:fullstack
npm run start:fullstack   # dashboard + API
# or
npm run start:backend     # API only
```

Default dashboard/API port is `4010`. The API proxy defaults to `5580`.
