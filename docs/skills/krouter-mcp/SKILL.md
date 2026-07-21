---
name: krouter-mcp
description: "Manage Krouter account pool, health monitoring, and auto-healing via MCP tools."
version: 2.0.0
tags: [mcp, pool-management, auto-healing, monitoring]
metadata:
  {
    "openclaw": {
      "requires": { "config": ["models.providers.krouter"] },
      "emoji": "🔧"
    }
  }
---

# Krouter MCP Tools

Use these tools to monitor and manage the Krouter proxy pool. Available when Krouter MCP server is configured.

## Available Tools

### krouter_pool_status
Get pool health: active/suspended/cooling/exhausted account counts and tier breakdown.

Use when: checking if the proxy is healthy before heavy workloads, diagnosing slow responses, or reporting system status.

### krouter_account_health
Get detailed health for one account (by ID or email): score, cooldown, quota, token expiry.

Use when: investigating why a specific account is failing or checking quota remaining.

### krouter_force_refresh
Force token refresh for one or all accounts.

Use when: detecting repeated 403/401 errors that suggest stale tokens.

### krouter_usage_stats
Get usage statistics: request counts, token consumption, success rates, uptime.

Use when: generating usage reports or checking if the proxy is being over-utilized.

### krouter_register
Trigger new account registration to expand the pool.

Use when: pool_status shows too few active accounts relative to demand.

## Decision Workflow

1. If requests are failing → call `krouter_pool_status`
2. If health_score < 50% → call `krouter_force_refresh` (fixes token issues)
3. If many accounts exhausted → report to user, suggest waiting for quota reset
4. If many accounts suspended → report to user (needs manual intervention)
5. If active accounts < 3 and registration available → call `krouter_register`

## MCP Configuration

Add to OpenClaw:
```bash
openclaw mcp add krouter --transport http --url http://127.0.0.1:5580/mcp
```
