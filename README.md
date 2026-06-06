# Krouter

Krouter is a web dashboard and CLI router for managing Kiro accounts, syncing credentials, and serving an OpenAI/Claude compatible API proxy with multi-account rotation.

## Features

- Web dashboard for accounts, groups, tags, device IDs, registration, diagnostics, proxy pools, and API proxy settings.
- Backend service that runs separately from the frontend so the API proxy can stay alive behind a local port or public tunnel.
- `krouter` CLI for status, dashboard tunnel controls, model listing, OpenClaw import, and first-run setup.
- Kiro API proxy with multi-account round-robin/sticky routing, model catalog refresh, request logs, and API key management.
- OpenClaw provider import using the `krouter` provider name.
- First-run admin setup with either a generated password or a custom password.

## Quick Start

```bash
npm install
npm run build:fullstack
npm run start:backend
```

Open the dashboard URL printed by the backend. On first launch, create the admin password in the browser or run:

```bash
npm run cli -- setup
```

After setup, use the CLI:

```bash
krouter
krouter status
krouter tunnel start
krouter openclaw import
```

For server deployment, copy `.env.web.example` to `.env.web`, set `SESSION_SECRET`, then run the backend behind Nginx, Docker, or a tunnel.

## Development

```bash
npm run dev:web
npm run dev:api
npm run build:fullstack
npm run test:e2e
```

## License

AGPL-3.0.
