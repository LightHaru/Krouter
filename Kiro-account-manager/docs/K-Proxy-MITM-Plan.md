# K-Proxy MITM Plan

K-Proxy is a local HTTP CONNECT proxy used by Krouter to inspect selected Kiro/AWS HTTPS requests and replace the device ID sent by the client. It is separate from the main API Proxy on port `5580`.

## Current Behavior

- K-Proxy creates a local CA certificate and per-host certificates for MITM traffic.
- Only domains in the allowlist are MITM-inspected: `amazonaws.com`, `amazon.com`, and `kiro.dev`.
- Requests outside the allowlist are passed through without decryption.
- When K-Proxy is running and API routing is enabled, Krouter API calls can use `http://host:port` as the network route.
- When API Proxy selects an account, Krouter can switch K-Proxy to that account's bound device ID. If no mapping exists, it can create a new device ID mapping automatically.

## Runtime Status Rules

- `initialized` means the CA/service object exists.
- `running` means the proxy port is listening and can receive traffic.
- `autoStart` means the web backend should start K-Proxy again after backend restart.
- `useKProxyForApi` means model/API traffic is routed through K-Proxy when K-Proxy is running.

## Upgrade Roadmap

1. Auto-start on web backend restart.
   - Done in v1.8.3: the server reads each user's `kproxyConfig.autoStart` and starts K-Proxy on boot.

2. Clear dashboard state.
   - Done in v1.8.3: K-Proxy page shows daemon state, auto-start state, API routing state, and CA trust state.

3. Safer account routing.
   - Keep per-account device ID mappings visible in the dashboard.
   - Warn when API routing is enabled but K-Proxy is stopped.
   - Add an audit row whenever the API proxy switches the active device ID.

4. CA and client setup checks.
   - Add a one-click diagnostic that verifies the CA cert, local proxy port, and a test HTTPS MITM request.
   - Show platform-specific trust instructions when automatic CA install is not available.

5. E2E coverage.
   - Test K-Proxy start/stop, auto-start after backend restart, CA export, API routing toggle, and account device ID switching.
   - Add a request fixture that proves a 64-character device ID is replaced in headers/body.

## Notes

K-Proxy should not be treated as an account ban bypass. It only normalizes device ID data in local requests. Account health still depends on valid credentials, usable profile ARN, quota, and normal account behavior.
