---
name: krouter-image
description: Generate and verify images through Krouter using ChatGPT OAuth or an explicitly configured Amazon Bedrock image model
version: 3.1.0
tags: [image, generation, chatgpt, oauth, nova-canvas, openai-compatible]
metadata: {"openclaw":{"requires":{"bins":["node"]},"category":"media"}}
---

# Krouter Image

Use Krouter's authenticated image helper. It automatically reads the Krouter provider already used by OpenClaw, calls the OpenAI-compatible image endpoint, downloads the result, verifies real image bytes, and prints a safe JSON result without exposing the API key.

## OpenClaw

When the user asks to generate an image, run:

```bash
node "{baseDir}/scripts/generate-image.cjs" --prompt "IMAGE DESCRIPTION" --output "./generated-images/result.png"
```

Optional flags are `--model`, `--size`, `--quality`, `--prompt-file`, and `--output`. Use `--prompt-file` when the prompt contains complex quoting. After success, return the absolute `path` from the JSON result as media or an attachment. Do not manually read, print, or pass the Krouter API key.

If the current agent already uses a `krouter/*` model, do not ask the user for an endpoint or API key. The helper discovers them from `OPENCLAW_CONFIG_PATH`, `~/.openclaw/openclaw.json`, and every `~/.openclaw/agents/*/agent/models.json` profile. `KROUTER_BASE_URL` and `KROUTER_API_KEY` are optional diagnostic overrides, not normal requirements.

## Preconditions

1. Keep Krouter Proxy API running. The fallback base URL is `http://127.0.0.1:5580`.
2. Keep the existing OpenClaw `krouter` provider enabled. The helper reuses its base URL and API key automatically.
3. Configure one image backend:
   - ChatGPT OAuth: open **Routing Control Room > ChatGPT OAuth** and select **Connect ChatGPT**. The HTTP endpoint below is available for headless use.
   - Amazon Bedrock: enable Bedrock credentials and request an explicit Bedrock image model. Nova Canvas currently requires a supported Bedrock region such as `ap-northeast-1`, `eu-west-1`, or `us-east-1`; verify AWS's current model-region table before use.
4. Check `GET /health` before generating.

ChatGPT product limits and availability are controlled by the upstream account and may change. Do not promise that a request is free or that a fixed daily quota is available.

## ChatGPT OAuth Setup

```bash
curl -sS -X POST http://127.0.0.1:5580/auth/chatgpt/login \
  -H "Authorization: Bearer YOUR_KROUTER_KEY"
```

Open the returned `authUrl`, finish sign-in, then check:

```bash
curl -sS http://127.0.0.1:5580/auth/chatgpt/status \
  -H "Authorization: Bearer YOUR_KROUTER_KEY"
```

This route uses the ChatGPT/Codex sign-in flow and an upstream ChatGPT backend; it is not the public OpenAI Images API. Availability and usage limits depend on the connected plan and can change. Never print OAuth access or refresh tokens into agent output, logs, or prompts.

## Generate

```bash
curl -sS http://127.0.0.1:5580/v1/images/generations \
  -H "Authorization: Bearer YOUR_KROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-image",
    "prompt": "A quiet Vietnamese mountain pass at sunrise, editorial ink and watercolor",
    "size": "1024x1024",
    "quality": "high",
    "response_format": "url"
  }'
```

If `model` is omitted, Krouter prefers an available ChatGPT OAuth account and may fall back to configured Bedrock. Use `nova-canvas` or an `amazon.*` model only when Bedrock is enabled. Krouter does not silently change the configured AWS region because that could violate data-residency expectations.

## Required Verification

A successful HTTP status is not enough.

1. Confirm `data` contains at least one item.
2. For `response_format: "url"`, download `data[0].url`.
3. Require an `image/*` Content-Type and a non-empty body.
4. Decode the image and confirm width and height are greater than zero.
5. Report the backend/model requested and the saved artifact path.

Example URL verification:

```bash
curl -fSL -D image.headers -o generated.png "URL_FROM_RESPONSE"
file generated.png
```

For `response_format: "b64_json"`, base64-decode `data[0].b64_json` and perform the same image decode check.

## Parameters

| Parameter | Type | Default | Notes |
|---|---:|---|---|
| `prompt` | string | required | Non-empty image instruction |
| `model` | string | auto | `gpt-image`, `gpt-image-2`, `chatgpt`, `nova-canvas`, or configured `amazon.*` / `stability.*` |
| `n` | number | 1 | Upstream may return fewer images |
| `size` | string | `1024x1024` | Also supports 256/512 square, portrait and landscape mappings |
| `quality` | string | standard | `high` and `hd` add a quality instruction on ChatGPT |
| `response_format` | string | url | `url` or `b64_json` |
| `negative_prompt` | string | none | Bedrock path only |
| `cfg_scale` | number | backend default | Bedrock path only |
| `seed` | number | random | Bedrock path only |

## Response Shape

```json
{
  "created": 1719000000,
  "data": [
    {
      "url": "http://127.0.0.1:5580/v1/images/generated-id.png",
      "revised_prompt": "..."
    }
  ]
}
```

## Failure Handling

| Status or message | Action |
|---|---|
| `401` / `403` from Krouter | Check the Krouter API key |
| `No ChatGPT accounts available` | Complete ChatGPT OAuth login or enable Bedrock |
| `Authentication failed` | Re-login to ChatGPT; do not retry with the same stale token |
| `429` / quota exhausted | Stop retrying that account and wait for its upstream limit to reset |
| Bedrock credential/model error | Verify region, credentials, model access and explicit model ID; `ap-southeast-1` does not currently host Nova Canvas |
| URL returns non-image bytes | Treat the run as failed and keep the response/log for diagnosis |

Retries must be bounded. Never rotate identities or attempt to bypass upstream access controls.
