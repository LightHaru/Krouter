---
name: krouter
description: Kiro Account Router & API Proxy - Overview and capabilities
version: 2.0.0
author: LightHaru
tags: [proxy, api, ai, router]
---

# Krouter - Kiro Account Router & API Proxy

Krouter is a multi-account API proxy that provides OpenAI/Claude/Gemini-compatible endpoints backed by intelligent account rotation, smart rate limiting, and AWS Bedrock integration.

## Base URL

```
http://<host>:5580
```

## Available Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI-compatible chat (streaming supported) |
| `POST /v1/messages` | Anthropic Claude-compatible messages |
| `POST /v1/responses` | OpenAI Responses API |
| `GET /v1/models` | List available models |
| `POST /v1/images/generations` | Generate images via Nova Canvas |
| `GET /health` | Health check |
| `GET /metrics` | Prometheus metrics |

## Authentication

All API endpoints accept `Authorization: Bearer <api-key>` header.

## Related Skills

- [krouter-proxy](/skills/krouter-proxy/SKILL.md) - Detailed proxy API usage
- [krouter-image](/skills/krouter-image/SKILL.md) - Image generation
- [krouter-admin](/skills/krouter-admin/SKILL.md) - Admin API
- [krouter-mitm](/skills/krouter-mitm/SKILL.md) - MITM proxy for IDEs
