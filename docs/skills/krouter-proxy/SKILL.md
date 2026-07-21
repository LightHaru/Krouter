---
name: krouter-proxy
description: Proxy API usage - chat completions, streaming, model selection
version: 2.0.0
tags: [proxy, api, openai, claude, streaming]
---

# Krouter Proxy API

## Chat Completions (OpenAI-compatible)

```bash
curl http://localhost:5580/v1/chat/completions \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4.5",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": true
  }'
```

## Claude Messages API

```bash
curl http://localhost:5580/v1/messages \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4.5",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

## Available Models

```bash
curl http://localhost:5580/v1/models \
  -H "Authorization: Bearer YOUR_KEY"
```

## Features

- **Smart Account Rotation**: Weighted scoring across success rate, latency, quota
- **Prompt Caching**: Automatic cache breakpoints for Anthropic models
- **Streaming**: Full SSE streaming with heartbeat keepalive
- **Rate Limiting**: Adaptive rate limiting with exponential backoff
- **Tier Routing**: Free/Pro/Enterprise account tier selection
- **Bedrock Fallback**: AWS Bedrock as alternative upstream

## Streaming Tips

- Set `stream: true` for real-time token output
- Heartbeat pings (`:ping`) keep connection alive during long operations
- Idle timeout: 300s, First-byte timeout: 120s
