<div align="center">
  <img src="./src/renderer/src/assets/krouter-logo.svg" alt="Krouter" width="440"/>

  <h1>Krouter</h1>

  <p><strong>One OpenAI-compatible endpoint in front of every AI account you own.</strong></p>

  <p>
    Krouter pools Kiro, ChatGPT/Codex, Amazon Bedrock, and any OpenAI- or Anthropic-compatible
    provider behind a single local API. It rotates accounts, tracks quota, retries around failures,
    and keeps serving while the dashboard is closed.
  </p>

  <p>
    <a href="./package.json"><img src="https://img.shields.io/badge/version-2.0.0-blue" alt="Version"/></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-green" alt="License"/></a>
    <a href="#endpoints"><img src="https://img.shields.io/badge/API-OpenAI%20%7C%20Anthropic%20%7C%20Gemini-orange" alt="API compatibility"/></a>
    <a href="#run-it"><img src="https://img.shields.io/badge/runtime-desktop%20%2B%20server%20%2B%20CLI-black" alt="Runtime"/></a>
  </p>

  <p>
    <a href="#run-it">Run it</a> ·
    <a href="#endpoints">Endpoints</a> ·
    <a href="#connect-a-client">Connect a client</a> ·
    <a href="#features">Features</a> ·
    <a href="#deploy-to-a-server">Deploy</a> ·
    <a href="#security">Security</a> ·
    <a href="./CHANGELOG.md">Changelog</a>
  </p>
</div>

---

## The problem

You have accounts across several AI providers. Each has its own quota, its own auth flow, and its
own way of failing. Your editor points at exactly one of them, so when that one is rate-limited,
out of quota, or suspended, you stop working and go re-configure something.

Krouter puts one endpoint in front of all of them.

```text
  Your tools                        Krouter                       Upstreams
  ─────────────────────────         ─────────────────────         ────────────────────
  OpenClaw                    ┐                                 ┌ Kiro  (many accounts)
  Claude Code / Codex CLI     │     http://localhost:5580        │ ChatGPT / Codex
  Cursor, Copilot, Kiro IDE   ├───▶  ├ auth: your API key   ───▶ ├ Amazon Bedrock
  Anything OpenAI-compatible  │      ├ pick a healthy account    │ Any OpenAI-compatible
  Your own scripts            ┘      ├ map the model            └ Any Anthropic-compatible
                                     ├ retry / fail over
                                     └ record usage
```

When an account is throttled or exhausted, Krouter cools it down and moves to the next one. The
client never sees it.

---

## Run it

```bash
npm install -g @lightharu/krouter
krouter
```

That starts the backend, opens the dashboard, and stores runtime data in `~/.krouter`.

On first run Krouter does **not** create a default login. You pick one of two setup modes: let
Krouter generate a strong admin password (shown once), or set your own.

| Command | What it does |
|---|---|
| `krouter` | Start the backend and open the dashboard |
| `krouter setup` | First-run admin setup from the terminal |
| `krouter status` | Backend, dashboard, and proxy state |
| `krouter start` / `krouter stop` | Control the background service |
| `krouter links` | Print the dashboard and proxy URLs |
| `krouter update` | Update the global npm install (`krouter update check` to only check) |
| `krouter tunnel start\|restart\|stop\|status` | Publish the dashboard through a tunnel |
| `krouter sync-password` | Generate the account-sync password (`sync-password status` to inspect) |

Terminal commands authenticate with a private CLI token in `~/.krouter/.env`, so they never ask
for the dashboard password. The dashboard password is for browser login only.

<details>
<summary><strong>From source</strong></summary>

```bash
npm install
npm run build:fullstack
npm run start:backend      # then open the URL it prints
npm run cli -- setup       # first-run setup
```

</details>

---

## Endpoints

Everything is served from one origin (`http://localhost:5580` by default) behind your API key.

| Endpoint | Protocol |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions |
| `POST /v1/responses` | OpenAI Responses |
| `POST /v1/messages` · `POST /anthropic/v1/messages` | Anthropic Messages |
| `POST /v1/messages/count_tokens` | Anthropic token counting |
| `POST /v1beta/models/:model:generateContent` | Gemini (streaming variant also available) |
| `POST /v1/images/generations` | Image generation |
| `GET /v1/models` | Live model catalog across every configured upstream |
| `/mcp` | Krouter's own account and quota tools over MCP |
| `GET /api/skills/list` · `/skills/:id/SKILL.md` | Skill catalog |

Streaming is supported on every chat endpoint.

---

## Connect a client

Create a key in the dashboard under **API Proxy Service → API Keys**, then point any tool at
Krouter:

```text
Base URL   http://localhost:5580/v1
API Key    sk-...
Model      any id returned by /v1/models
```

**Configure Clients** writes the config file for you. Krouter generates the correct provider
block for Claude Code, OpenCode, Codex, Gemini CLI, Hermes, and OpenClaw — including model
metadata (context window, image support, thinking effort) so the client shows accurate
capabilities instead of guessing.

---

## Features

### Routing

Four strategies — `round-robin`, `sticky`, `smart`, and `least-used`. Smart routing is
tier-aware: it will not send a premium model to a Free-tier account, and it only treats an
account as capable of a premium model once that capability has actually been confirmed.

Every account carries health state: consecutive errors, exponential cooldown, quota exhaustion,
and suspension. Failures are classified — a `429` cools the account down briefly, a billing error
marks it exhausted, an auth failure triggers one token refresh before rotation.

### Upstreams

- **Kiro** — Builder ID, IAM Identity Center, and social login. Quota, plan, and profile ARN are
  tracked per account.
- **ChatGPT / Codex** — OAuth device-code sign-in with token rotation and a multi-account pool.
- **Amazon Bedrock** — SigV4-signed requests, including image models.
- **Custom providers** — register any OpenAI- or Anthropic-compatible endpoint with its own base
  URL, credentials, and model allow-list.

### MITM mode (optional)

Some IDEs won't let you change their API endpoint. Krouter can run a local HTTPS listener with
its own root CA and redirect Kiro, Copilot, Antigravity, and Cursor traffic through itself —
without editing the IDE's configuration. It rewrites the model per a mapping table you control.

This installs a root certificate and edits your hosts file. Read [Security](#security) before
enabling it.

### Observability

Per-request usage is recorded and survives restarts, aggregated over `today` / `24h` / `7d` /
`30d` / `60d` / `all` and broken down by model, account, API key, and endpoint. The dashboard also
carries request logs, live model probing ("does this account actually serve this model?"), and
diagnostics for credentials, quota, proxy routes, and model liveness.

### Runs without the dashboard

The dashboard is a control surface, not a dependency. Token refresh, proxy-pool maintenance, and
the API proxy all run in the backend and keep working with every browser tab closed.

---

## Deploy to a server

```bash
cp .env.web.example .env.web
```

Set at minimum:

```env
SESSION_SECRET=<long random string>
APP_ENCRYPTION_KEY=<long random string>
```

Both have development defaults that **must** be overridden in production — see
[Security](#security). Then:

```bash
npm run build:fullstack
npm run start:backend
```

Krouter runs as a localhost dashboard behind a tunnel, as a VPS service behind Nginx, or as a
Docker service via `docker-compose.web.yml`. Server notes: [docs/web-port.md](./docs/web-port.md).

---

## Security

Krouter holds live credentials for every account you add. A few things are worth knowing before
you expose it.

**Set the production secrets.** `APP_ENCRYPTION_KEY` and `SESSION_SECRET` ship with development
defaults. Anything left at the default means stored credentials are encrypted with a key that is
public in this repository. Override both.

**The proxy refuses to bind externally without a key.** If you bind to a non-loopback address,
Krouter requires an API key to be configured. Do not disable that check unless the port is
already protected by something else.

**MITM mode is a real MITM.** Enabling it installs a root CA into your trust store and points
several vendor domains at `127.0.0.1` in your hosts file. That is exactly the capability it
sounds like. Only enable it if you understand the trade-off, and turn it off when you are done —
Krouter restores the hosts file on exit and warns you if it cannot.

**Registration automation is rate-limited on purpose.** It has a circuit breaker that stops on
repeated provider rejections or security blocks. Do not raise the limits to work around a block.

Found something? Open an issue at
[LightHaru/Krouter/issues](https://github.com/LightHaru/Krouter/issues).

---

## Development

```bash
npm run dev:web           # dashboard with HMR
npm run dev:api           # backend in watch mode
npm run typecheck         # node + web projects
npm run test:unit         # unit and property tests
npm run test:e2e          # end-to-end suite
npm run build:fullstack   # production build
```

Krouter runs on three targets that share the proxy core in `src/main/proxy/`:

| Target | Entry | Notes |
|---|---|---|
| Electron desktop | `src/main/index.ts` | IPC to the renderer via `src/preload/` |
| Standalone server | `src/server/index.ts` | Headless; `handleIpc()` mirrors the Electron IPC surface |
| CLI | `scripts/krouter-cli.cjs` | Wraps the server |

Because two runtimes expose the same API to the renderer, they can drift.
`test/proxy/ipcParity.test.ts` compares all three surfaces and fails if a method exists in one and
not the other — add a handler to one runtime and forget the other, and the test tells you.

---

## Documentation

- API Proxy Guide — [default](./docs/API-Proxy-Guide.md) · [English](./docs/API-Proxy-Guide.en.md) · [Tiếng Việt](./docs/API-Proxy-Guide.vi.md)
- [Server deployment notes](./docs/web-port.md)
- [K-Proxy / MITM design](./docs/K-Proxy-MITM-Plan.md)
- [Changelog](./CHANGELOG.md)

---

<div align="center">
  <sub>
    AGPL-3.0 · <a href="https://github.com/LightHaru/Krouter">github.com/LightHaru/Krouter</a>
  </sub>
</div>
