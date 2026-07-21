---
name: krouter-image
description: Image generation via Amazon Nova Canvas (OpenAI-compatible)
version: 2.0.0
tags: [image, generation, nova-canvas, bedrock]
---

# Krouter Image Generation

Generate images using Amazon Nova Canvas through an OpenAI-compatible API.

## Generate Image

```bash
curl http://localhost:5580/v1/images/generations \
  -H "Authorization: Bearer YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "A serene mountain landscape at sunset",
    "n": 1,
    "size": "1024x1024",
    "quality": "standard"
  }'
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `prompt` | string | required | Image description |
| `n` | number | 1 | Number of images (1-4) |
| `size` | string | "1024x1024" | Image size |
| `quality` | string | "standard" | "standard" or "hd" |
| `response_format` | string | "url" | "url" or "b64_json" |
| `negative_prompt` | string | - | What to exclude |
| `cfg_scale` | number | 7.0 | Creativity (1.1-10) |
| `seed` | number | - | For reproducibility |

## Supported Sizes

- `512x512` - Square small
- `1024x1024` - Square standard
- `1024x1792` - Portrait
- `1792x1024` - Landscape

## Response

```json
{
  "created": 1719000000,
  "data": [
    {
      "url": "http://localhost:5580/v1/images/abc123.png",
      "revised_prompt": "A serene mountain landscape at sunset"
    }
  ]
}
```

## Requirements

- AWS Bedrock must be enabled and configured
- Region must support Nova Canvas (us-east-1, us-west-2)
- IAM needs `bedrock:InvokeModel` permission for `amazon.nova-canvas-v1:0`
