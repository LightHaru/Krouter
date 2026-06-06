<div align="center">
  <img src="./src/renderer/src/assets/krouter-logo.svg" alt="Krouter" width="460"/>

  # Krouter - Kiro Account Router & API Proxy

  **One local web dashboard to manage Kiro accounts, balance quota, expose a compatible API proxy, and connect OpenClaw or other dev tools through one endpoint.**

  **Run the dashboard on localhost, publish it through a tunnel when needed, and let the backend/CLI keep the proxy service alive.**

  [![Version](https://img.shields.io/badge/version-1.8.2-blue)](./package.json)
  [![License](https://img.shields.io/badge/license-AGPL--3.0-green)](./LICENSE)
  [![OpenClaw](https://img.shields.io/badge/OpenClaw-provider%3A%20krouter-purple)](#openclaw-and-client-tools)
  [![Runtime](https://img.shields.io/badge/runtime-web%20%2B%20CLI-black)](#quick-start)

  [Quick Start](#quick-start) - [API Proxy Guide](./docs/API-Proxy-Guide.md) - [How It Works](#how-it-works) - [Features](#key-features) - [OpenClaw](#openclaw-and-client-tools) - [Deploy](#server-deployment) - [Changelog](./CHANGELOG.md)
</div>

---

## Why Krouter?

Krouter is built for a Kiro-heavy workflow where many accounts, quota states, API keys, model choices, and client configs need to stay organized.

Common pain points:

- Kiro accounts are hard to compare when quota, subscription, profile ARN, and liveness are scattered.
- A web dashboard is convenient, but the API proxy should run as a backend/CLI service instead of depending on a browser tab.
- OpenClaw and other clients need one stable OpenAI-compatible endpoint.
- Premium models can fail when an account is suspended, out of quota, rate-limited, or missing a usable streaming profile.
- Manual account switching wastes time and makes failures harder to diagnose.

Krouter solves this with:

- A local-first web dashboard for account operations.
- A backend API proxy that can stay running independently.
- Multi-account routing with round-robin/sticky strategies.
- API key generation for client tools.
- OpenClaw import using the `krouter` provider.
- Diagnostics for quota, credentials, model liveness, request logs, and tunnel status.

---

## How It Works

```text
Developer tools
OpenClaw / Aira / Codex / Claude-compatible clients
        |
        |  http://localhost:5580/v1
        v
Krouter API Proxy
  - validates client API keys
  - maps requested models
  - rotates healthy Kiro accounts
  - retries or skips accounts with bad quota/liveness
  - streams responses back to the client
        |
        v
Kiro accounts
  - Builder ID / social login credentials
  - quota and plan tracking
  - profile ARN hydration
  - account health and request logs
```

The dashboard is the control surface. The backend and `krouter` CLI are the runtime layer.

---

## Key Features

### Dashboard

- Account list, import/export, groups, tags, privacy mode, and quick status cards.
- Registration workflows and diagnostics for email service, Kiro API, proxy, quota, and model liveness.
- API proxy page for service start/stop, model refresh, key management, request logs, and client config import.
- Tunnel controls for localhost-first usage with optional public access.
- Responsive layout for desktop and mobile dashboards.

### API Proxy

- OpenAI-compatible `/v1` endpoint.
- Multi-account mode with round-robin and sticky routing.
- Per-account health checks, quota checks, and request logging.
- Model catalog refresh and model mapping for client tools.
- API keys in `sk-*` format or custom token formats.

### CLI

- `krouter` opens the clean terminal dashboard.
- `krouter setup` performs first-run admin setup.
- `krouter status` checks backend/dashboard/proxy state.
- `krouter tunnel start` exposes the dashboard when remote access is needed.
- `krouter openclaw import` writes the Krouter provider into OpenClaw config.

### First-Run Setup

On a fresh install, Krouter does not create a default `admin/admin` login.

You choose one of two setup modes:

- **Krouter generated password**: Krouter creates a strong password and shows it once.
- **Custom password**: you set your own admin password.

---

## Quick Start

Install or update with one command:

```bash
npm install -g @lightharu/krouter
```

Run Krouter:

```bash
krouter
```

The CLI starts the local backend, opens the dashboard, and stores runtime data in `~/.krouter`.

To update later:

```bash
npm update -g @lightharu/krouter
```

Source/development mode:

```bash
npm install
npm run build:fullstack
npm run start:backend
```

Open the dashboard URL printed by the backend.

For first-run setup from terminal:

```bash
npm run cli -- setup
```

After installing globally or linking the package, use:

```bash
krouter
krouter status
krouter tunnel start
krouter openclaw import
```

---

## OpenClaw And Client Tools

Create a client API key in the dashboard:

```text
Dashboard -> API Proxy Service -> Configure Clients / API Keys
```

Then import Krouter into OpenClaw:

```bash
krouter openclaw import
```

OpenClaw will use provider:

```text
krouter
```

Typical client settings:

```text
Base URL: http://localhost:5580/v1
API Key:  sk-...
Model:    claude-sonnet-4.5 or another model shown by Krouter
```

When `/models` is called, Krouter exposes the model list currently available through the proxy catalog.

---

## Server Deployment

Copy the example environment file:

```bash
cp .env.web.example .env.web
```

Set at least:

```env
SESSION_SECRET=replace-with-a-long-random-secret
```

Then run:

```bash
npm run build:fullstack
npm run start:backend
```

Krouter can run as:

- localhost-only dashboard plus Cloudflare tunnel.
- VPS service behind Nginx.
- Docker service using `docker-compose.web.yml`.

For detailed server notes, see [docs/web-port.md](./docs/web-port.md).

---

## Development

```bash
npm run dev:web
npm run dev:api
npm run build:fullstack
npm run test:e2e
```

---

## Repository

GitHub: [LightHaru/Krouter](https://github.com/LightHaru/Krouter)

---

## License

AGPL-3.0.
