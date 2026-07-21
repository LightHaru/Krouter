---
name: krouter-mitm
description: MITM proxy for IDE integration (Kiro IDE, Copilot, Antigravity)
version: 2.0.0
tags: [mitm, proxy, ide, kiro, copilot]
---

# Krouter MITM Proxy

Intercept and reroute IDE traffic through Krouter for tools that have hardcoded API endpoints.

## How It Works

1. Hosts file redirects IDE domains to localhost
2. MITM proxy intercepts HTTPS traffic on local port
3. Requests are routed through Krouter's account pool
4. Model IDs are mapped from IDE-specific to Krouter models

## Supported IDEs

| IDE | Domains |
|-----|---------|
| Kiro IDE | `runtime.us-east-1.kiro.dev`, `runtime.us-west-2.kiro.dev` |
| GitHub Copilot | `o.us-east-1.amazoninces.com`, `codehub.server.us-east-1.amazoninces.com` |
| Antigravity | `generativelanguage.googleapis.com`, `daily-cloudcode-pa.googleapis.com` |

## Setup

### 1. Enable DNS Redirect

Add to `/etc/hosts` (Linux/Mac) or `C:\Windows\System32\drivers\etc\hosts` (Windows):

```
# Krouter MITM - START
127.0.0.1 runtime.us-east-1.kiro.dev
127.0.0.1 runtime.us-west-2.kiro.dev
127.0.0.1 o.us-east-1.amazoninces.com
# Krouter MITM - END
```

### 2. Install CA Certificate

The MITM proxy generates a self-signed CA certificate. Install it:
- **macOS**: Add to Keychain → Always Trust
- **Linux**: Copy to `/usr/local/share/ca-certificates/` → `update-ca-certificates`
- **Windows**: Import to Trusted Root Certification Authorities

### 3. Start MITM Proxy

Enable in Krouter settings or via API:
```bash
curl -X POST http://localhost:5580/admin/config \
  -H "Content-Type: application/json" \
  -d '{"kproxy": {"enabled": true, "port": 8899}}'
```

## Model Mappings

IDE-specific model IDs are mapped to Krouter models:

| IDE Model | Krouter Model |
|-----------|---------------|
| `us.anthropic.claude-opus-4-5-*` | `claude-opus-4.5` |
| `anthropic.claude-sonnet-4-5-*` | `claude-sonnet-4.5` |
| `gpt-4o` | `claude-sonnet-4.5` |
| `gemini-pro` | `gemini-2.0-flash-exp` |

Custom mappings can be configured via the admin API.

## Device ID Management

Each account can have its own device ID to avoid conflicts. The MITM proxy automatically replaces device IDs in requests based on the selected account.
