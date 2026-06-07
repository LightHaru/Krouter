# Krouter API Proxy Guide

Krouter API Proxy exposes one OpenAI, Claude and Gemini compatible endpoint for AI clients. The backend selects a usable Kiro account, refreshes tokens, checks model capability, logs requests, and rotates accounts according to your strategy.

![API Proxy flow](./images/api-proxy-overview.svg)

## 1. Install And Open The Dashboard

Install or update Krouter:

```bash
npm install -g @lightharu/krouter
```

Open the CLI:

```bash
krouter
```

The CLI starts the backend, opens the local dashboard, and prints the access URL. Defaults:

```text
Dashboard: http://127.0.0.1:4010
API Proxy: http://127.0.0.1:5580/v1
```

On a VPS, prefer a dashboard tunnel instead of exposing raw HTTP:

```bash
krouter tunnel start
```

## 2. Prepare Kiro Accounts

Open **Accounts** and import valid Kiro accounts. Then run **refresh/check** so the backend can load quota, subscription, tokens, and profile ARN data.

ARN notes:

- Enterprise/Power accounts can have a real account-specific ARN.
- GitHub/Google social accounts usually use the shared social ARN expected by Kiro.
- Builder ID accounts can use a compatibility placeholder ARN. If a model rejects that account, multi-account mode can fail over to another account.

## 3. Start API Proxy

Open **API Proxy Service**.

![API Proxy settings](./images/api-proxy-dashboard.svg)

Recommended settings:

| Setting | Recommended value |
| --- | --- |
| Host | `127.0.0.1` for local-only use |
| Port | `5580` |
| Auto Start | On if the service should restart automatically |
| Multi-Account | On |
| Strategy | `Smart` |
| Log Requests | On while testing, optional later |
| Max Retries | `3` or higher on unstable networks |
| Disable Tools | Off when agent/dev tasks need tool calls |

The **Smart** strategy scores accounts by remaining quota, recent errors, request count, latency, and token freshness. When an account hits quota, rate limit, or suspension errors, Krouter marks it and selects a better account.

## 4. Create A Client API Key

In **API Proxy Service**, open **Configure Clients** or **Configure API Keys**, then create an `sk-...` key.

![Create key and connect clients](./images/api-proxy-client-setup.svg)

Clients should send:

```text
Authorization: Bearer sk-...
```

Never expose the proxy publicly without API keys and access rules.

## 5. Client Endpoints

### OpenAI Compatible

```text
Base URL: http://127.0.0.1:5580/v1
Chat:     POST /v1/chat/completions
Models:   GET  /v1/models
```

Example:

```bash
curl http://127.0.0.1:5580/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [{"role": "user", "content": "Reply pong"}],
    "stream": false
  }'
```

### Claude Compatible

```text
Base URL: http://127.0.0.1:5580
Messages: POST /v1/messages
```

Example:

```bash
curl http://127.0.0.1:5580/v1/messages \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "max_tokens": 256,
    "messages": [{"role": "user", "content": "Reply pong"}],
    "stream": false
  }'
```

### Gemini Compatible

```text
Base URL: http://127.0.0.1:5580
Models:   GET  /v1beta/models
Generate: POST /v1beta/models/{model}:generateContent
```

## 6. Connect OpenClaw

Fast path:

```bash
krouter openclaw import
```

Or from the dashboard:

```text
API Proxy Service -> Configure Clients -> select OpenClaw -> Import
```

After import, select the `krouter` provider in OpenClaw and run `/models` to list the models exposed by Krouter.

## 7. Connect Other AI Tools

Use this generic setup:

```text
Provider: OpenAI Compatible
Base URL: http://127.0.0.1:5580/v1
API Key:  sk-...
Model:    claude-sonnet-4.5
```

This works for OpenClaw, Codex-compatible clients, Continue, Cline, Cursor, OpenCode, or custom clients.

## 8. Verify The Service

Backend health:

```bash
curl http://127.0.0.1:4010/healthz
```

Proxy health:

```bash
curl http://127.0.0.1:5580/health
```

Model list:

```bash
curl http://127.0.0.1:5580/v1/models \
  -H "Authorization: Bearer sk-..."
```

If `/v1/models` returns `401`, the API key is missing or incorrect.

## 9. Safe Operations Checklist

- Bind `127.0.0.1` for local use.
- On a VPS, use a dashboard tunnel and keep API proxy auth enabled.
- Enable Auto Start if the proxy should survive backend restarts.
- Use `Smart` as the default multi-account strategy.
- Watch request logs while testing a new model.
- Do not route model traffic through suspended accounts; let Krouter skip them or remove them from the pool.

## 10. Troubleshooting

### `401 Unauthorized`

The API key is missing or invalid. Check:

```text
Authorization: Bearer sk-...
```

### `profileArn is required`

The selected account does not have a usable ARN for that endpoint/model. Run **Sync Accounts**, **Refresh Models**, or use **Smart** strategy so Krouter can select a better account.

### `All models are temporarily rate-limited`

Many accounts are rate-limited or cooling down. Wait for cooldown, reduce request rate, or inspect request logs.

### `All accounts quota exhausted`

All accounts in the selected scope are out of quota or cooling down. Check account quota, group scope, and API key bindings.

