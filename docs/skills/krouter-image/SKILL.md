---
name: krouter-image
description: Free image generation via ChatGPT OAuth + Amazon Nova Canvas fallback (OpenAI-compatible)
version: 2.1.0
tags: [image, generation, chatgpt, gpt-image-2, nova-canvas, free]
metadata:
  openclaw:
    requires: [krouter-proxy]
    category: media
---

# Krouter Image Generation

Generate high-quality images for FREE using ChatGPT OAuth (GPT-Image-2) or Amazon Nova Canvas.

## Quick Start

```bash
curl http://localhost:5580/v1/images/generations \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A beautiful sunset over Vietnamese mountains, watercolor style",
    "size": "1024x1024",
    "quality": "high"
  }'
```

## Model Routing

| Model | Backend | Cost | Quality |
|-------|---------|------|---------|
| *(default)* | ChatGPT OAuth | FREE | GPT-Image-2 quality |
| `gpt-image` / `gpt-image-2` | ChatGPT OAuth | FREE | High |
| `dall-e-3` / `dall-e` | ChatGPT OAuth | FREE | High |
| `chatgpt` | ChatGPT OAuth | FREE | High |
| `nova-canvas` | AWS Bedrock | Paid | Amazon Nova |
| `amazon.*` / `stability.*` | AWS Bedrock | Paid | Various |

## Setup (ChatGPT Free — No API Key Needed)

1. Start Krouter proxy
2. Call login endpoint:
```bash
curl -X POST http://localhost:5580/auth/chatgpt/login
```
3. Open the returned `authUrl` in your browser
4. Login with your ChatGPT account (free account works!)
5. Done — Krouter handles token refresh automatically

## Check Status

```bash
curl http://localhost:5580/auth/chatgpt/status
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | required | Image description |
| `model` | string | *(auto)* | Model to use (see routing table) |
| `n` | number | 1 | Number of images |
| `size` | string | "1024x1024" | Image dimensions |
| `quality` | string | "standard" | "standard", "high", or "hd" |
| `response_format` | string | "url" | "url" or "b64_json" |
| `negative_prompt` | string | — | What to avoid (Bedrock only) |
| `cfg_scale` | number | 7.0 | Creativity scale (Bedrock only) |
| `seed` | number | — | For reproducibility |

## Supported Sizes

- `1024x1024` — Square (default)
- `1024x1536` — Portrait
- `1536x1024` — Landscape
- `1024x1792` — Tall portrait
- `1792x1024` — Wide landscape

## Response

```json
{
  "created": 1719000000,
  "data": [
    {
      "url": "http://localhost:5580/v1/images/abc123.png",
      "revised_prompt": "A beautiful sunset over Vietnamese mountains..."
    }
  ]
}
```

## Free Tier Limits

- Free ChatGPT accounts: ~2-3 images/day/account
- Plus/Pro accounts: ~50+ images/day/account
- Krouter pool rotation: multiple accounts = higher throughput
- Auto-rotates when an account hits its limit

## For OpenClaw Agents

Agents can use this endpoint directly — it's OpenAI-compatible:
```yaml
# In agent config
image_provider:
  base_url: http://localhost:5580
  endpoint: /v1/images/generations
```
