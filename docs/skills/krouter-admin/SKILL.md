---
name: krouter-admin
description: Admin API for monitoring, configuration, and diagnostics
version: 2.0.0
tags: [admin, monitoring, metrics, health]
---

# Krouter Admin API

## Endpoints

### GET /admin/stats
Overall proxy statistics (requests, tokens, credits, accounts).

### GET /admin/account-health
Real-time health scores for all accounts.

```json
{
  "accounts": [{
    "id": "...",
    "email": "user@example.com",
    "health": {
      "successRate": 0.95,
      "avgLatency": 1200,
      "overallScore": 0.87,
      "isHealthy": true
    }
  }]
}
```

### GET /admin/quota-predictions
Quota usage predictions with estimated exhaustion time.

### GET /admin/endpoint-metrics
Per-endpoint performance metrics (avg/p95 latency, error rates).

### POST /admin/endpoint-metrics/reset
Reset endpoint metrics counters.

### GET /admin/logs
Recent proxy logs (last 100 entries).

### POST /admin/bedrock/test
Test AWS Bedrock credentials and list accessible models.

### GET /admin/config
Current proxy configuration.

### POST /admin/config
Update proxy configuration (partial update supported).

### POST /admin/cache/clear
Clear all in-memory caches (model list, prompt cache, etc.).

### GET /admin/audit
Recent audit log entries.

## Prometheus Metrics

```bash
curl http://localhost:5580/metrics
```

Exposed metrics:
- `kiro_proxy_requests_total` - Total requests
- `kiro_proxy_tokens_total{type="input|output|cache_read"}` - Token counts
- `kiro_proxy_endpoint_latency_p95{path="..."}` - P95 latency per endpoint
- `kiro_proxy_account_health{account="..."}` - Account health scores
- `kiro_proxy_cache_hit_rate` - Prompt cache effectiveness
