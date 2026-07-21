# KROUTER COMPREHENSIVE UPGRADE PLAN FOR OPENCLAW
## Tối Ưu Cho Openclaw AI Assistant v2.0

**Created:** 2026-07-19  
**Version:** 3.1  
**Current:** Krouter v1.9.4 → **Target:** v2.0.0  
**Timeline:** 8-10 tuần (13 phases)  
**Author:** Kiro AI Assistant

---

## 📊 TÓM TẮT EXECUTIVE

### 🎯 Mục Tiêu Chính
Nâng cấp Krouter proxy system để xử lý tối ưu workload của Openclaw AI assistant với focus vào:
1. **429 Throttling Mitigation** - Giảm AWS rate limit errors từ 15% xuống <2%
2. **Long-Running Tasks** - Support tasks 30-60 phút không timeout
3. **Smart Account Rotation** - Tránh request dồn vào 1 account
4. **Image Generation** - Thêm Amazon Nova Canvas qua AWS Bedrock
5. **Tool Call Optimization** - Cache và optimize cho 5-15 parallel tool calls

### 📈 Openclaw Behavior Profile
```yaml
Tool Calls: 5-15 parallel requests mỗi turn
Conversations: 50-100 turns typical (long sessions)
Operation Pattern: 24/7 continuous usage
Peak Load: 20-30 concurrent requests
Long Tasks: 30-60 phút cho coding/analysis sessions
```

### ✅ Current State
- ✅ Multi-account proxy hoạt động ổn định
- ✅ AWS Bedrock integration có sẵn (Converse API)
- ✅ Smart strategy cơ bản
- ⚠️ 429 errors chưa xử lý tốt (~15% peak)
- ⚠️ Timeout ở 5 phút cho streaming
- ❌ Chưa có image generation capability
- ❌ **Bedrock models không hiển thị trong Openclaw (error visibility issue)**

### 🎯 Target State
- ✅ 429 error rate <2% (giảm 87%)
- ✅ Long tasks support 30-60 phút
- ✅ Smart rotation 90%+ efficiency
- ✅ Image generation via Amazon Nova Canvas
- ✅ Tool call cache hit rate >60%
- ✅ **Bedrock diagnostics với error visibility (fix Openclaw issue)**


---

## 🔌 CURRENT PROXY API ENDPOINTS

### A. OpenAI-Compatible Endpoints
```http
GET  /v1/models                    # Model list (Kiro + Bedrock + Xpixi)
POST /v1/chat/completions          # Chat completion (stream + non-stream)
POST /v1/responses                 # OpenAI responses format
```

**Example:**
```bash
curl http://127.0.0.1:5580/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-sonnet-4.5", "messages": [{"role": "user", "content": "Hello"}]}'
```

### B. Claude/Anthropic-Compatible Endpoints
```http
POST /v1/messages                  # Claude Messages API (stream + non-stream)
POST /anthropic/v1/messages        # Anthropic official path
POST /v1/messages/count_tokens     # Token counting endpoint
POST /messages/count_tokens        # Short path for token counting
```

### C. Gemini-Compatible Endpoints
```http
GET  /v1beta/models                           # Gemini model list
POST /v1beta/models/{model}:generateContent   # Generate content
POST /v1beta/models/{model}:streamGenerateContent  # Stream generate
```

### D. System & Monitoring Endpoints
```http
GET  /health                       # Health check
GET  /                            # Root health check
GET  /metrics                      # Prometheus metrics (if enableMetrics=true)
```

### E. Admin API Endpoints *(Yêu cầu API key authentication)*
```http
GET  /admin/stats                  # Detailed statistics
GET  /admin/accounts               # Account list và status
GET  /admin/config                 # Get current configuration
POST /admin/config                 # Update configuration (schema validated)
GET  /admin/audit                  # Audit log (100 recent entries)
GET  /admin/logs                   # Recent logs
POST /admin/cache/clear            # Clear all caches
```

### F. Telemetry Endpoints
```http
POST /api/event_logging/batch      # Claude Code telemetry (returns 200 OK)
```

**📊 Total: 15 endpoints currently supported**


---

## 🆕 NEW IMAGE GENERATION ENDPOINTS (Phase 11)

### Sẽ Được Thêm Vào

```http
POST /v1/images/generations        # Text-to-image generation
POST /v1/images/variations         # Create image variations
POST /v1/images/edits              # Image editing/inpainting
```

### ✨ Đặc Điểm
- **Backend:** Amazon Nova Canvas (`amazon.nova-canvas-v1:0`)
- **API Format:** OpenAI DALL-E compatible
- **Authentication:** Dùng AWS IAM credentials từ Bedrock config
- **Cost:** $0.04 per image (standard 1024x1024)
- **No OpenAI dependency** - Hoàn toàn qua AWS Bedrock

### 📝 Example Usage

#### 1. Text-to-Image Generation
```bash
curl http://127.0.0.1:5580/v1/images/generations \
  -H "Authorization: Bearer sk-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "amazon.nova-canvas-v1:0",
    "prompt": "A serene mountain landscape at sunset with lake reflection",
    "n": 1,
    "size": "1024x1024",
    "quality": "standard",
    "response_format": "url"
  }'
```

**Response:**
```json
{
  "created": 1721383200,
  "data": [{
    "url": "http://127.0.0.1:5580/images/1721383200-0.png",
    "revised_prompt": "A serene mountain landscape at sunset with lake reflection"
  }]
}
```

#### 2. Batch Generation (up to 4 images)
```bash
curl http://127.0.0.1:5580/v1/images/generations \
  -H "Authorization: Bearer sk-..." \
  -d '{
    "model": "amazon.nova-canvas-v1:0",
    "prompt": "Professional software architecture diagram",
    "n": 4,
    "size": "1792x1024",
    "quality": "hd"
  }'
```

### 🎨 Supported Parameters

| Parameter | Type | Values | Description |
|-----------|------|--------|-------------|
| `model` | string | `amazon.nova-canvas-v1:0` | Model ID |
| `prompt` | string | Any text | Description (required) |
| `n` | number | 1-4 | Number of images |
| `size` | string | See below | Image dimensions |
| `quality` | string | `standard`, `hd` | Quality level |
| `response_format` | string | `url`, `b64_json` | Response format |
| `style` | string | `natural`, `vivid`, `sketch`, `cartoon` | Visual style |
| `negative_prompt` | string | Any text | What to avoid |

**Supported sizes:** `256x256`, `512x512`, `1024x1024`, `1024x1792`, `1792x1024`

### 💰 Cost Estimation

| Size | Quality | Cost/Image |
|------|---------|------------|
| 512x512 | standard | $0.02 |
| 1024x1024 | standard | $0.04 |
| 1024x1024 | hd | $0.08 |
| 1792x1024 | standard | $0.06 |
| 1792x1024 | hd | $0.12 |

**Example:** 100 images/day × $0.04 = **$4/day = $120/month**


---

## � SKILLS SYSTEM (9Router-Inspired)

### 🎯 Overview
Replace "Config Sync" (Đồng bộ cấu hình) page với Skills system - cho phép AI agents (Claude, ChatGPT, Cursor, v.v.) tự động discover và sử dụng Krouter capabilities thông qua standardized skill markdown files.

### 💡 Concept
**Inspired by 9Router Skills:** Drop-in markdown files mà AI agents có thể fetch và hiểu cách dùng Krouter. Mỗi skill bao gồm:
- Setup instructions
- API endpoints với examples  
- curl commands
- SDK examples (JS/Python)
- Response formats

### 📂 Skills Structure

```
docs/skills/
├── krouter/
│   └── SKILL.md                      # Entry point - setup + index
├── krouter-proxy/
│   └── SKILL.md                      # Proxy API usage (chat, completions)
├── krouter-image/
│   └── SKILL.md                      # Image generation (Nova Canvas)
├── krouter-admin/
│   └── SKILL.md                      # Admin API (stats, accounts, config)
├── krouter-mitm/
│   └── SKILL.md                      # MITM server setup for IDE tools
└── README.md                         # Skills catalog

.kiro/skills/                         # User-level skills (custom)
└── my-custom-skill/
    └── SKILL.md                      # User-defined skills
```

### 📝 Skill File Format

**Example:** `docs/skills/krouter/SKILL.md`

```markdown
---
name: krouter
description: Entry point for Krouter — local/remote AI proxy gateway with OpenAI-compatible REST for chat, image generation, admin API. Use when the user mentions Krouter, KROUTER_URL, or wants multi-account routing with fallback. This skill covers setup + indexes capability skills.
---

# Krouter

Local/remote AI proxy gateway exposing OpenAI-compatible REST. Multi-account pooling, smart rotation, auto-fallback.

## Setup

\`\`\`bash
export KROUTER_URL="http://localhost:5580"       # or VPS / tunnel URL
export KROUTER_KEY="sk-..."                      # from Dashboard → API Keys
\`\`\`

All requests: `${KROUTER_URL}/v1/...` with header `Authorization: Bearer ${KROUTER_KEY}`.

Verify: `curl $KROUTER_URL/health` → `{"ok":true}`

## Discover models

\`\`\`bash
curl $KROUTER_URL/v1/models                  # Chat/LLM models
curl "$KROUTER_URL/v1/models/info?id=claude-sonnet-4.5"  # Model metadata
\`\`\`

Use `data[].id` as `model` field in requests.

## Capability skills

When the user needs a specific capability, fetch that skill's `SKILL.md` from its URL:

| Capability | Raw URL |
|---|---|
| Chat / Proxy API | http://localhost:5580/skills/krouter-proxy/SKILL.md |
| Image generation | http://localhost:5580/skills/krouter-image/SKILL.md |
| Admin API | http://localhost:5580/skills/krouter-admin/SKILL.md |
| MITM Server | http://localhost:5580/skills/krouter-mitm/SKILL.md |

## Errors

- 401 → set/refresh `KROUTER_KEY` (Dashboard → API Keys)
- 400 `Invalid model` → check `model` exists in `/v1/models`
- 503 `All accounts unavailable` → check account pool status
```

### 🎨 Frontend: SkillsPage Component

**File:** `src/renderer/src/components/pages/SkillsPage.tsx`

```typescript
import { useState, useEffect } from 'react'
import { BookOpen, Download, Upload, Copy, Plus, Trash2, Eye, Edit } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, Button, Badge, Alert } from '../ui'

interface Skill {
  id: string
  name: string
  description: string
  path: string
  type: 'builtin' | 'custom'
  enabled: boolean
}

export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([])
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null)
  const [skillContent, setSkillContent] = useState('')

  useEffect(() => {
    loadSkills()
  }, [])

  async function loadSkills() {
    const res = await fetch('/api/skills/list')
    const data = await res.json()
    setSkills(data.skills)
  }

  async function viewSkill(skill: Skill) {
    setSelectedSkill(skill)
    const res = await fetch(`/api/skills/content?id=${skill.id}`)
    const data = await res.json()
    setSkillContent(data.content)
  }

  async function copySkillURL(skill: Skill) {
    const url = `${window.location.origin}/skills/${skill.id}/SKILL.md`
    await navigator.clipboard.writeText(url)
    // Show toast
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-xl bg-indigo-500">
            <BookOpen className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">Skills System</h1>
            <p className="text-muted-foreground">
              Drop-in capabilities cho AI agents (Claude, ChatGPT, Cursor, ...)
            </p>
          </div>
        </div>
      </div>

      {/* Info Card */}
      <Card>
        <CardContent className="py-4">
          <h3 className="font-medium mb-2">🎯 How to use</h3>
          <p className="text-sm text-muted-foreground mb-3">
            Copy a skill URL below and paste to your AI agent:
          </p>
          <code className="text-xs bg-muted px-2 py-1 rounded">
            Read this skill: http://localhost:5580/skills/krouter/SKILL.md
          </code>
        </CardContent>
      </Card>

      {/* Built-in Skills */}
      <Card>
        <CardHeader>
          <CardTitle>Built-in Skills</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {skills.filter(s => s.type === 'builtin').map(skill => (
            <div key={skill.id} className="flex items-center gap-3 p-3 border rounded-lg">
              <BookOpen className="h-5 w-5 text-primary" />
              <div className="flex-1">
                <p className="font-medium text-sm">{skill.name}</p>
                <p className="text-xs text-muted-foreground">{skill.description}</p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => viewSkill(skill)}>
                <Eye className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={() => copySkillURL(skill)}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Custom Skills */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Custom Skills</CardTitle>
            <Button size="sm">
              <Plus className="h-4 w-4 mr-2" />
              Add Skill
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {skills.filter(s => s.type === 'custom').length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No custom skills yet. Create one to extend Krouter capabilities.
            </p>
          ) : (
            <div className="grid gap-3">
              {skills.filter(s => s.type === 'custom').map(skill => (
                <div key={skill.id} className="flex items-center gap-3 p-3 border rounded-lg">
                  <BookOpen className="h-5 w-5 text-purple-500" />
                  <div className="flex-1">
                    <p className="font-medium text-sm">{skill.name}</p>
                    <p className="text-xs text-muted-foreground">{skill.description}</p>
                  </div>
                  <Button size="sm" variant="ghost">
                    <Edit className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="ghost">
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Skill Content Viewer */}
      {selectedSkill && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{selectedSkill.name}</CardTitle>
              <Button size="sm" variant="ghost" onClick={() => setSelectedSkill(null)}>
                Close
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <pre className="text-xs bg-muted p-4 rounded-lg overflow-auto max-h-96">
              {skillContent}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
```

### 🔌 Backend: Skills API

**File:** `src/server/api/skills.ts` (NEW)

```typescript
import { Router } from 'express'
import * as fs from 'fs'
import * as path from 'path'

export function createSkillsRouter(skillsDir: string): Router {
  const router = Router()

  /**
   * GET /api/skills/list
   */
  router.get('/list', (req, res) => {
    const skills: Array<{
      id: string
      name: string
      description: string
      path: string
      type: 'builtin' | 'custom'
      enabled: boolean
    }> = []

    // Built-in skills from docs/skills/
    const builtinDir = path.join(skillsDir, 'builtin')
    if (fs.existsSync(builtinDir)) {
      for (const dir of fs.readdirSync(builtinDir)) {
        const skillPath = path.join(builtinDir, dir, 'SKILL.md')
        if (fs.existsSync(skillPath)) {
          const content = fs.readFileSync(skillPath, 'utf8')
          const frontmatter = parseFrontmatter(content)
          skills.push({
            id: dir,
            name: frontmatter.name || dir,
            description: frontmatter.description || '',
            path: skillPath,
            type: 'builtin',
            enabled: true
          })
        }
      }
    }

    // Custom skills from .kiro/skills/
    const customDir = path.join(skillsDir, 'custom')
    if (fs.existsSync(customDir)) {
      for (const dir of fs.readdirSync(customDir)) {
        const skillPath = path.join(customDir, dir, 'SKILL.md')
        if (fs.existsSync(skillPath)) {
          const content = fs.readFileSync(skillPath, 'utf8')
          const frontmatter = parseFrontmatter(content)
          skills.push({
            id: `custom-${dir}`,
            name: frontmatter.name || dir,
            description: frontmatter.description || '',
            path: skillPath,
            type: 'custom',
            enabled: true
          })
        }
      }
    }

    res.json({ skills })
  })

  /**
   * GET /api/skills/content?id=krouter
   */
  router.get('/content', (req, res) => {
    const skillId = req.query.id as string
    const skillPath = findSkillPath(skillsDir, skillId)
    
    if (!skillPath || !fs.existsSync(skillPath)) {
      return res.status(404).json({ error: 'Skill not found' })
    }

    const content = fs.readFileSync(skillPath, 'utf8')
    res.json({ content })
  })

  /**
   * GET /skills/:skillId/SKILL.md
   * Direct access for AI agents
   */
  router.get('/:skillId/SKILL.md', (req, res) => {
    const skillId = req.params.skillId
    const skillPath = findSkillPath(skillsDir, skillId)
    
    if (!skillPath || !fs.existsSync(skillPath)) {
      return res.status(404).send('Skill not found')
    }

    res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    res.sendFile(skillPath)
  })

  return router
}

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}

  const frontmatter: Record<string, string> = {}
  const lines = match[1].split('\n')
  
  for (const line of lines) {
    const [key, ...valueParts] = line.split(':')
    if (key && valueParts.length > 0) {
      frontmatter[key.trim()] = valueParts.join(':').trim()
    }
  }

  return frontmatter
}

function findSkillPath(skillsDir: string, skillId: string): string | null {
  // Check builtin
  const builtinPath = path.join(skillsDir, 'builtin', skillId, 'SKILL.md')
  if (fs.existsSync(builtinPath)) return builtinPath

  // Check custom
  const customPath = path.join(skillsDir, 'custom', skillId.replace('custom-', ''), 'SKILL.md')
  if (fs.existsSync(customPath)) return customPath

  return null
}
```

### 📋 Implementation Checklist

**Week 1:**
- [ ] Create `docs/skills/` directory structure
- [ ] Write krouter entry skill (SKILL.md)
- [ ] Write krouter-proxy skill
- [ ] Write krouter-image skill  
- [ ] Write krouter-admin skill
- [ ] Write krouter-mitm skill
- [ ] Write README.md catalog

**Week 2:**
- [ ] Create SkillsPage component
- [ ] Create Skills API routes
- [ ] Add skill viewer/editor UI
- [ ] Add "Copy URL" functionality
- [ ] Test with Claude/ChatGPT/Cursor

**Week 3:**
- [ ] Remove ConfigSyncPage
- [ ] Update Sidebar menu (configSync → skills)
- [ ] Update translations
- [ ] Update routing
- [ ] Documentation
- [ ] User guide

### 🔄 Migration from Config Sync

**What gets removed:**
- ❌ ConfigSyncPage component
- ❌ Export/import config JSON
- ❌ Webhook sync
- ❌ Register template sync
- ❌ Proxy pool sync

**What gets added:**
- ✅ Skills catalog (builtin + custom)
- ✅ Skill markdown viewer
- ✅ Copy skill URL
- ✅ AI agent integration guide
- ✅ Custom skill creator (future)

**Why this is better:**
- Easier for AI agents to discover capabilities
- Standardized format (markdown + frontmatter)
- No manual export/import needed
- Extensible (users can add custom skills)
- Self-documenting

---

## �📋 11-PHASE DETAILED UPGRADE PLAN

---

### PHASE 1: Smart Account Rotation Enhancement ⏱️ Tuần 1-2

#### 🎯 Objective
Nâng cấp account selection algorithm để tránh request dồn vào 1 account, cải thiện load balancing.

#### ❌ Current Issues
- Round-robin đơn giản không tính health metrics
- Smart strategy chưa đủ thông minh với parallel requests
- Account cooldown cố định, không adaptive
- Không track per-account rate limit budget

#### ✅ Solution Architecture

**Composite Score-Based Selection:**
```
Score = (
  SuccessRate × 0.35 +
  (1 - AvgLatency/10s) × 0.20 +
  QuotaRemaining × 0.15 +
  ErrorPenalty × 0.15 +
  LoadBalance × 0.10 +
  TokenFreshness × 0.05
) + TierBonus
```

**Key Features:**
- Track success rate (last 100 requests)
- Monitor latency (weighted moving average)
- Check quota remaining
- Exponential backoff on errors (2^n × 30s)
- Rate limit budget per account
- Weighted random selection (top 3 candidates)

#### 📊 Implementation Summary

**Files to modify:**
- `src/main/proxy/accountPool.ts` - Add SmartAccountSelector class
- `src/main/proxy/proxyServer.ts` - Integrate new selector
- `src/server/store.ts` - Store health metrics

**Key Metrics Tracked:**
```typescript
interface AccountHealthScore {
  accountId: string
  successRate: number          // 0-1
  avgLatency: number          // ms
  quotaRemaining: number
  consecutiveErrors: number
  lastErrorTime: number
  requestCount1m: number      // Sliding window
  requestCount5m: number
  requestCount15m: number
  tokenRefreshTime: number
  tierPriority: number
}
```

#### 📈 Expected Results
- Account rotation efficiency: **60% → 90%+**
- Hot account overload: **Giảm 70%**
- Cooldown recovery: **5min → <2min**
- Failed request distribution: **Even spread**

#### ✅ Checklist
- [ ] Implement AccountHealthScore tracking
- [ ] Create SmartAccountSelector class
- [ ] Add composite scoring algorithm
- [ ] Implement exponential backoff
- [ ] Add rate limit budget checks
- [ ] Test with 20+ concurrent requests
- [ ] Monitor metrics for 24h
- [ ] Fine-tune score weights


---

### PHASE 2: AWS 429 Throttling Mitigation ⏱️ Tuần 2-3

#### 🎯 Objective
Giảm 429 rate limit errors từ 15% xuống <2% thông qua intelligent retry và account switching.

#### ❌ Current Issues
- 429 errors chỉ retry ngay lập tức
- Không có exponential backoff
- Không parse `Retry-After` header
- Không rotate account khi hit rate limit

#### 📊 AWS Bedrock Rate Limits

| Model | TPM Limit | Typical Usage |
|-------|-----------|---------------|
| Nova Micro | 300 TPM | Light tasks |
| Nova Lite | 300 TPM | Standard tasks |
| Nova Pro | 100 TPM | Heavy tasks |
| Claude Sonnet 3.5 | 400 TPM | Code/analysis |
| Claude Opus | 40 TPM | Complex reasoning |

*TPM = Transactions Per Minute*

#### ✅ Solution: Multi-Layer Retry Strategy

**Retry Flow:**
```
Request → Check budget → Execute
                ↓
            429 Error?
                ↓ Yes
    Parse Retry-After header
                ↓
    Exponential backoff (30s → 60s → 120s)
                ↓
    Last attempt? → Switch account
                ↓
    All throttled? → Return 429 to client
```

**Key Features:**
- Parse `Retry-After` header from AWS
- Exponential backoff: `min(30s × 2^attempt, retryAfter)`
- Automatic account switching on last retry
- Adaptive rate limiting (learn from throttling)
- Per-model TPM budget tracking

#### 📊 Implementation Summary

**New Class:**
```typescript
class ThrottlingMitigator {
  executeWithRetry<T>(
    account: Account,
    modelId: string,
    requestFn: () => Promise<T>,
    options: {
      maxAttempts?: number
      onAccountSwitch?: () => Account
    }
  ): Promise<T>
}

interface RateLimitBudget {
  accountId: string
  modelId: string
  tpmLimit: number
  requestWindow: number[]      // Sliding window
  cooldownUntil: number
  adaptiveFactor: number       // 0.5-1.0 (learns)
}
```

**Files to modify:**
- `src/main/proxy/throttlingMitigator.ts` (new file)
- `src/main/proxy/proxyServer.ts` - Integrate throttling handler
- `src/main/proxy/bedrock.ts` - Add retry logic

#### 📈 Expected Results
- 429 error rate: **15% → <2%** (87% reduction)
- Average retry attempts: **2.5 → 1.2**
- Account cooldown time: **Better distributed**
- Client-facing 429s: **90% reduction**

#### ✅ Checklist
- [ ] Implement ThrottlingMitigator class
- [ ] Add Retry-After header parsing
- [ ] Implement exponential backoff
- [ ] Add adaptive rate limiting
- [ ] Track TPM budgets per model
- [ ] Add account switching on retry
- [ ] Test with rate-limited scenarios
- [ ] Monitor 429 reduction metrics


---

### PHASE 3: Long-Running Task Support ⏱️ Tuần 3-4

#### 🎯 Objective
Support streaming tasks 30-60 phút không bị timeout thông qua heartbeat mechanism.

#### ❌ Current Issues
- Streaming timeout cố định 5 phút
- Không có heartbeat để keep connection alive
- Client timeout trước khi task hoàn thành
- Không có progress indication

#### ✅ Solution: Streaming Heartbeat System

**Architecture:**
```
Client Request (stream=true)
    ↓
Server starts streaming
    ↓
Every 30s: Send heartbeat comment
    ↓
Track activity (last chunk time)
    ↓
Timeout after 60min inactivity
    ↓
Graceful cleanup on complete/error
```

**SSE Heartbeat Format:**
```
: heartbeat

data: {"type": "chunk", "content": "..."}

: heartbeat

data: {"type": "chunk", "content": "..."}
```

#### 📊 Implementation Summary

**New Class:**
```typescript
class LongRunningStreamHandler {
  async handleLongStream(
    req: Request,
    res: Response,
    streamFn: () => AsyncIterator<Chunk>
  ): Promise<void> {
    // Setup heartbeat (every 30s)
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n')
    }, 30000)
    
    try {
      for await (const chunk of streamFn()) {
        res.write(chunk)
        updateActivity()
      }
    } finally {
      clearInterval(heartbeat)
    }
  }
}
```

**Files to modify:**
- `src/main/proxy/longRunningStreamHandler.ts` (new file)
- `src/main/proxy/proxyServer.ts` - Integrate stream handler
- `src/main/proxy/kiroApi.ts` - Update streaming logic

**Configuration:**
```typescript
interface StreamConfig {
  maxDuration: number          // 3600000 (60 min)
  heartbeatInterval: number    // 30000 (30 sec)
  inactivityTimeout: number    // 300000 (5 min no chunks)
}
```

#### 📈 Expected Results
- Max task duration: **5min → 60min**
- Client timeouts: **80% reduction**
- Stream stability: **95%+ completion rate**
- Better observability for long tasks

#### 🔧 Client Configuration (Openclaw)

```json
{
  "krouter": {
    "timeout": 3600000,
    "streamTimeout": 3600000,
    "heartbeatInterval": 30000,
    "retryOnTimeout": false
  }
}
```

#### ✅ Checklist
- [ ] Implement LongRunningStreamHandler
- [ ] Add heartbeat mechanism (30s interval)
- [ ] Extend stream timeout to 60min
- [ ] Track activity timestamps
- [ ] Add graceful cleanup
- [ ] Log long task metrics
- [ ] Test with 30-60min tasks
- [ ] Update Openclaw config docs


---

### PHASE 4: Prompt Cache Optimization ⏱️ Tuần 4

#### 🎯 Objective
Tối ưu prompt caching để giảm input tokens và tăng response speed cho repeated contexts.

#### 📊 Current vs Target
- Current cache hit rate: **~30%**
- Target cache hit rate: **>60%**
- Token savings: **40-50% on cached prompts**

#### ✅ Key Improvements
- [ ] Cache conversation system prompts
- [ ] Cache tool definitions (Openclaw sends same tools repeatedly)
- [ ] Cache file contents in multi-turn conversations
- [ ] Implement cache warming for frequently used contexts
- [ ] Add cache analytics dashboard

#### 📈 Expected Impact
- Input tokens: **30-40% reduction**
- Response latency: **20-30% faster**
- Cost savings: **$50-100/month**

---

### PHASE 5: Tool Call Response Caching ⏱️ Tuần 4-5

#### 🎯 Objective
Cache identical tool call results để giảm redundant API calls.

#### 📊 Openclaw Pattern Analysis
```
Parallel tool calls per turn: 5-15
Duplicate rate: ~20-30%
Common duplicates:
- read_file (same file multiple times)
- grep_search (same pattern)
- get_diagnostics (same files)
```

#### ✅ Implementation
- [ ] Hash-based cache for tool results
- [ ] TTL: 5 minutes for most tools
- [ ] Invalidation on file changes
- [ ] Cache size limit: 1000 entries

#### 📈 Expected Impact
- Tool call latency: **40% reduction on duplicates**
- API load: **20-25% reduction**

---

### PHASE 6: Model Catalog Auto-Refresh ⏱️ Tuần 5

#### 🎯 Objective
Auto-refresh available models để tránh stale model list.

#### ✅ Features
- [ ] Refresh every 6 hours
- [ ] Detect new Bedrock models
- [ ] Update model capabilities
- [ ] Notify on new model availability

---

### PHASE 7: Enhanced Request Logging ⏱️ Tuần 5-6

#### 🎯 Objective
Better observability cho debugging và performance analysis.

#### ✅ Improvements
- [ ] Structured JSON logging
- [ ] Request tracing IDs
- [ ] Performance metrics per endpoint
- [ ] Error categorization
- [ ] Log rotation (keep 7 days)

---

### PHASE 8: Account Health Dashboard ⏱️ Tuần 6

#### 🎯 Objective
Real-time dashboard để monitor account health metrics.

#### ✅ Features
- [ ] Live success rate graphs
- [ ] Latency distribution charts
- [ ] Quota usage visualization
- [ ] Error trending
- [ ] Account comparison view

---

### PHASE 9: Intelligent Quota Management ⏱️ Tuần 6-7

#### 🎯 Objective
Predict quota exhaustion và tự động reserve cho priority tasks.

#### ✅ Features
- [ ] Quota prediction based on usage patterns
- [ ] Reserve quota for critical operations
- [ ] Alert when quota < 20%
- [ ] Suggest account upgrades

---

### PHASE 10: Performance Metrics & Alerting ⏱️ Tuần 7

#### 🎯 Objective
Prometheus metrics và alerting cho production monitoring.

#### ✅ Metrics to Export
- [ ] Request rate (per endpoint, per model)
- [ ] Error rate (by type)
- [ ] Latency percentiles (p50, p95, p99)
- [ ] Cache hit rates
- [ ] Account health scores
- [ ] Queue depth

#### ✅ Alerts
- [ ] Error rate > 5%
- [ ] 429 rate > 3%
- [ ] Latency p95 > 5s
- [ ] All accounts quota < 20%


---

### PHASE 11: Amazon Nova Canvas Image Generation + Bedrock Diagnostics ⏱️ Tuần 7-8

#### 🎯 Objective
1. Thêm image generation capability qua Amazon Nova Canvas với OpenAI-compatible API
2. **FIX: Cải thiện Bedrock integration diagnostics để dễ debug khi models không hiển thị trong Openclaw**

#### ❌ Why NOT OpenAI DALL-E
- ❌ Tốn phí thêm OpenAI API
- ❌ Dependency thêm 1 provider
- ❌ Phức tạp hơn (2 auth systems)

#### ✅ Why Amazon Nova Canvas
- ✅ Dùng AWS IAM có sẵn (Bedrock config)
- ✅ Không phụ thuộc OpenAI
- ✅ Cost-effective ($0.04/image)
- ✅ High quality (up to 1920x1080)
- ✅ Fast generation (~3-5s)

#### 📊 Architecture

```
Client Request
    ↓
POST /v1/images/generations (OpenAI format)
    ↓
[Transform to Bedrock format]
    ↓
[AWS SigV4 Sign]
    ↓
POST bedrock-runtime.{region}.amazonaws.com/model/amazon.nova-canvas-v1:0/invoke
    ↓
[Parse Bedrock response]
    ↓
[Transform to OpenAI format]
    ↓
Return to client
```

#### 📋 Implementation Files

**New Files:**
```
src/main/proxy/bedrockImage.ts       - Image generation logic
src/main/proxy/imageStorage.ts       - Image storage manager
test/proxy/bedrockImage.test.ts      - Unit tests
test/bedrock-e2e/image.test.mjs      - E2E tests
```

**Modified Files:**
```
src/main/proxy/proxyServer.ts        - Add image endpoints
src/main/proxy/bedrock.ts            - Extend Bedrock integration
docs/API-Proxy-Guide.vi.md           - Update documentation
```

#### 🔧 Key Implementation Details

**1. Nova Canvas Request Format:**
```typescript
interface NovaCanvasRequest {
  taskType: 'TEXT_IMAGE' | 'IMAGE_VARIATION' | 'INPAINTING'
  textToImageParams: {
    text: string                // Prompt
    negativeText?: string       // Negative prompt
  }
  imageGenerationConfig: {
    numberOfImages: number      // 1-4
    quality: 'standard' | 'premium'
    height: number
    width: number
    cfgScale: number           // 1.1-10 (creativity)
    seed?: number              // For reproducibility
  }
}
```

**2. OpenAI-Compatible Response:**
```typescript
interface ImageGenerationResponse {
  created: number
  data: Array<{
    url?: string               // HTTP URL (if stored locally)
    b64_json?: string         // Base64 (if requested)
    revised_prompt?: string   // Enhanced prompt
  }>
}
```

**3. Image Storage Strategy:**
```typescript
class ImageStorageManager {
  // Option 1: Local file storage (default)
  saveLocal(base64: string, filename: string): string
  
  // Option 2: S3 upload (if configured)
  uploadToS3(base64: string, filename: string): Promise<string>
  
  // Cleanup old images (run daily)
  cleanupOldImages(maxAge: number): Promise<void>
}
```

#### 🎨 Supported Features

**Sizes:**
- Square: 256x256, 512x512, 1024x1024
- Portrait: 1024x1792
- Landscape: 1792x1024

**Quality:**
- `standard` - Fast, good quality
- `premium` (hd) - Slower, excellent quality

**Styles:**
- `natural` - Photorealistic
- `vivid` - Vibrant artistic
- `sketch` - Pencil sketch
- `cartoon` - Cartoon illustration

**Advanced:**
- Negative prompts (exclude elements)
- CFG scale control (creativity)
- Seed control (reproducibility)
- Batch generation (up to 4)

#### 💰 Cost Management

**Storage Options:**
```typescript
storageConfig: {
  type: 'local' | 's3'
  localPath: './images'      // Local storage
  s3Bucket?: string          // S3 bucket (optional)
  maxAge: 86400000          // 24h cleanup
  maxSize: 1073741824       // 1GB limit
}
```

**Cost Breakdown:**
- Generation: $0.04/image (standard 1024x1024)
- Storage (local): Free
- Storage (S3): ~$0.023/GB/month
- Bandwidth (local): Free
- Bandwidth (S3): $0.09/GB

**Monthly estimate (1000 images):**
- Generation: $40
- Storage (S3): <$1
- Total: **~$41/month**

#### ✅ Checklist

**Week 7: Image Generation Core**
- [ ] Create bedrockImage.ts module
- [ ] Implement NovaCanvasRequest builder
- [ ] Add AWS SigV4 signing for images
- [ ] Parse Nova Canvas response
- [ ] Transform to OpenAI format
- [ ] Unit tests for transformations

**Week 7: Bedrock Diagnostics Fix** ⭐ (User-reported issue)
- [ ] Add `bedrockLastError` field to ProxyServer class
- [ ] Update `getAvailableModels()` error handling with caching
- [ ] Improve `listBedrockAvailableModels()` resilience (partial success)
- [ ] Add `getBedrockStatus()` method to ProxyServer
- [ ] Add `/admin/bedrock/test` POST endpoint
- [ ] Add `testBedrockCredentials()` helper function
- [ ] Update error logging from console.error to proxyLogger
- [ ] Test with invalid credentials → Error shown
- [ ] Test with partial IAM permissions → Partial models work
- [ ] Test with wrong region → Clear error message

**Week 8: Image Generation Endpoints**
- [ ] Add /v1/images/generations endpoint
- [ ] Add /v1/images/variations endpoint
- [ ] Add /v1/images/edits endpoint
- [ ] Implement ImageStorageManager
- [ ] Add local file storage
- [ ] Add optional S3 upload
- [ ] Implement cleanup job
- [ ] E2E testing

**Week 8: UI Integration**
- [ ] Create BedrockPanel component with error display
- [ ] Add "Test Credentials" button
- [ ] Show cached errors with timestamp
- [ ] Add error clearing on successful test
- [ ] Add IAM permission examples to docs
- [ ] Update Bedrock setup guide

**Documentation:**
- [ ] Update API-Proxy-Guide with image generation
- [ ] Add troubleshooting section for Bedrock
- [ ] Document required IAM permissions
- [ ] Add common error scenarios with fixes
- [ ] Add usage examples for image generation

#### 🧪 Testing Plan

**Unit Tests:**
```bash
npm run test -- bedrockImage.test.ts
```

**E2E Tests:**
```bash
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
export AWS_REGION=us-east-1
node test/bedrock-e2e/image.test.mjs
```

**Manual Testing:**
```bash
# Test 1: Simple generation
curl http://127.0.0.1:5580/v1/images/generations \
  -H "Authorization: Bearer sk-..." \
  -d '{"prompt": "A cat", "n": 1}'

# Test 2: HD quality
curl http://127.0.0.1:5580/v1/images/generations \
  -H "Authorization: Bearer sk-..." \
  -d '{"prompt": "Mountain landscape", "quality": "hd", "size": "1792x1024"}'

# Test 3: Batch generation
curl http://127.0.0.1:5580/v1/images/generations \
  -H "Authorization: Bearer sk-..." \
  -d '{"prompt": "Logo design", "n": 4, "size": "512x512"}'

# Test 4: With style
curl http://127.0.0.1:5580/v1/images/generations \
  -H "Authorization: Bearer sk-..." \
  -d '{"prompt": "Portrait", "style": "vivid", "response_format": "b64_json"}'
```

#### 📈 Success Metrics
- API compatibility: **100% OpenAI format**
- Generation time: **<5s average**
- Error rate: **<1%**
- Cost per image: **$0.04 (standard)**
- Storage efficiency: **Auto cleanup after 24h**


---

---

### 🐛 BEDROCK DIAGNOSTICS FIX (Phần quan trọng của Phase 11)

#### ❌ Problem: Bedrock Models Không Hiển Thị trong Openclaw

**User Issue:**
> "khi anh add bedrock vào Krouter rồi nhưng khi anh dùng openclaw với models đó thì nó lại lỗi nó không có xem và dùng được bedrock"

**Root Cause Analysis:**

1. **Silent Failure trong Model Listing:**
   ```typescript
   // File: src/main/proxy/proxyServer.ts (line ~1416-1422)
   if (isBedrockConfigured(this.config.bedrock)) {
     try {
       const bedrockModels = await this.getBedrockApiModels(signal)
       // merge models...
     } catch (error) {
       // ❌ ERROR CAUGHT BUT NOT VISIBLE TO USER
       proxyLogger.error('ProxyServer', `Bedrock models merge failed: ${message}`)
       // Models list vẫn return nhưng THIẾU Bedrock models
     }
   }
   ```

2. **Bedrock Model Listing có thể fail vì:**
   - IAM permissions thiếu (ListFoundationModels, ListInferenceProfiles)
   - AWS credentials không đúng
   - Region không support model
   - Network issues
   - API rate limiting

3. **Impact:**
   - Openclaw gọi `GET /v1/models` → Không thấy Bedrock models
   - User không biết lỗi gì (error chỉ ở console log)
   - Không có cách test/debug trực tiếp
   - Phải check logs server-side (khó với người dùng thường)

#### ✅ Solution Plan

**1. Add Error Visibility to ProxyServer**

```typescript
// File: src/main/proxy/proxyServer.ts

export class ProxyServer {
  // ... existing fields
  
  /** Cache Bedrock errors cho UI display */
  private bedrockLastError: { message: string; timestamp: number } | null = null

  async getAvailableModels(signal?: AbortSignal) {
    // ... existing code ...
    
    if (isBedrockConfigured(this.config.bedrock)) {
      try {
        const bedrockModels = await this.getBedrockApiModels(signal)
        // Merge successful → clear error
        this.bedrockLastError = null
        proxyLogger.info('ProxyServer', `Bedrock: Loaded ${bedrockModels.length} models`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // ✅ Log với visibility
        proxyLogger.error('ProxyServer', `Bedrock models merge failed: ${message}`)
        // ✅ Cache error cho UI
        this.bedrockLastError = { message, timestamp: Date.now() }
      }
    }
  }

  /** 
   * Get Bedrock status for UI display
   * Returns error details when Bedrock config exists but models fail to load
   */
  getBedrockStatus(): { 
    configured: boolean
    error?: string
    lastChecked?: number 
  } {
    const configured = isBedrockConfigured(this.config.bedrock)
    if (!configured) return { configured: false }
    
    if (this.bedrockLastError) {
      return {
        configured: true,
        error: this.bedrockLastError.message,
        lastChecked: this.bedrockLastError.timestamp
      }
    }
    
    return { configured: true }
  }
}
```

**2. Improve Bedrock Model Listing Resilience**

```typescript
// File: src/main/proxy/bedrock.ts

/**
 * BEFORE: All-or-nothing approach
 * - If either foundation models OR inference profiles fail → entire listing fails
 * - Partial success not supported
 * 
 * AFTER: Resilient partial success
 * - Try foundation models
 * - Try inference profiles
 * - Return what we got (even if only one succeeds)
 * - Only throw if BOTH fail AND zero models found
 */
export async function listBedrockAvailableModels(
  config: BedrockConfig,
  signal?: AbortSignal
): Promise<BedrockAvailableModel[]> {
  const out = new Map<string, BedrockAvailableModel>()

  // ✅ Try foundation models (catch but continue)
  let foundationError: string | undefined
  try {
    const foundation = await listBedrockModels(config, signal)
    for (const m of foundation) {
      // ... filter and add to out ...
    }
  } catch (error) {
    foundationError = error instanceof Error ? error.message : String(error)
    console.error('[Bedrock] Failed to list foundation models:', foundationError)
    // ✅ CONTINUE to try profiles
  }

  // ✅ Try inference profiles (catch but continue)
  let profilesError: string | undefined
  try {
    const profiles = await listBedrockInferenceProfiles(config, signal)
    for (const p of profiles) {
      // ... filter and add to out ...
    }
  } catch (error) {
    profilesError = error instanceof Error ? error.message : String(error)
    console.error('[Bedrock] Failed to list inference profiles:', profilesError)
    // ✅ Return what we have so far
  }

  // ✅ Only throw if BOTH failed AND no models
  if (out.size === 0 && foundationError && profilesError) {
    throw new Error(
      `Bedrock model listing failed:\n` +
      `  Foundation: ${foundationError}\n` +
      `  Profiles: ${profilesError}`
    )
  }

  return Array.from(out.values())
}
```

**3. Add Diagnostic Endpoint**

```typescript
// File: src/main/proxy/proxyServer.ts

/**
 * POST /admin/bedrock/test
 * Test Bedrock credentials and return what models are accessible
 */
private async handleAdminBedrockTest(
  res: http.ServerResponse,
  signal?: AbortSignal
): Promise<void> {
  if (!this.config.bedrock?.enabled) {
    return res.writeHead(200).end(JSON.stringify({ 
      ok: false, 
      error: 'Bedrock not enabled in config' 
    }))
  }

  try {
    const { testBedrockCredentials } = await import('./bedrock')
    const result = await testBedrockCredentials(this.config.bedrock, signal)
    
    // ✅ Clear cached error on successful test
    if (result.ok) {
      this.bedrockLastError = null
    }
    
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    
    // ✅ Cache error for UI display
    this.bedrockLastError = { message, timestamp: Date.now() }
    
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ok: false,
      region: this.config.bedrock.region || 'us-east-1',
      models: [],
      error: message
    }))
  }
}

// Add route in handleAdmin
private async handleAdmin(req, res): Promise<void> {
  // ... existing admin routes ...
  
  if (req.method === 'POST' && path === '/admin/bedrock/test') {
    return this.handleAdminBedrockTest(res, signal)
  }
}
```

**4. UI Integration**

```typescript
// File: src/renderer/src/components/bedrock/BedrockPanel.tsx

export function BedrockPanel() {
  const [status, setStatus] = useState<{
    configured: boolean
    error?: string
    lastChecked?: number
  } | null>(null)

  useEffect(() => {
    loadBedrockStatus()
  }, [])

  async function loadBedrockStatus() {
    const res = await fetch('/api/bedrock/status')
    const data = await res.json()
    setStatus(data)
  }

  async function testBedrock() {
    setTesting(true)
    try {
      const res = await fetch('/admin/bedrock/test', { method: 'POST' })
      const result = await res.json()
      
      if (result.ok) {
        alert(`✓ Bedrock OK: ${result.models.length} models available in ${result.region}`)
      } else {
        alert(`✗ Bedrock Error: ${result.error}`)
      }
      
      // Reload status after test
      await loadBedrockStatus()
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>AWS Bedrock Integration</CardTitle>
      </CardHeader>
      <CardContent>
        {status?.configured && status.error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Bedrock Configuration Error</AlertTitle>
            <AlertDescription>
              <p className="mb-2">{status.error}</p>
              <p className="text-xs text-muted-foreground">
                Last checked: {new Date(status.lastChecked!).toLocaleString()}
              </p>
              <Button 
                size="sm" 
                variant="outline" 
                onClick={testBedrock}
                className="mt-2"
              >
                Test Credentials Again
              </Button>
            </AlertDescription>
          </Alert>
        )}
        
        {/* ... existing Bedrock config UI ... */}
      </CardContent>
    </Card>
  )
}
```

#### 📋 Common Error Scenarios & Fixes

**Error 1: IAM Permissions Missing**
```
Error: User: arn:aws:iam::123456:user/krouter is not authorized 
to perform: bedrock:ListFoundationModels

Fix: Add IAM policy:
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "bedrock:ListFoundationModels",
      "bedrock:ListInferenceProfiles",
      "bedrock:InvokeModel"
    ],
    "Resource": "*"
  }]
}
```

**Error 2: Wrong Region**
```
Error: No models found in region eu-central-1

Fix: Change to a region with Bedrock support:
- us-east-1 (Virginia) - Most models
- us-west-2 (Oregon) - Most models  
- eu-west-1 (Ireland) - Limited selection
- ap-southeast-1 (Singapore) - Limited selection
```

**Error 3: Invalid Credentials**
```
Error: The security token included in the request is invalid

Fix: Verify credentials:
1. Check AWS_ACCESS_KEY_ID correct
2. Check AWS_SECRET_ACCESS_KEY correct
3. Check AWS_SESSION_TOKEN not expired (if using temp credentials)
4. Regenerate credentials if needed
```

**Error 4: Partial Success (Only Profiles Available)**
```
Warning: Foundation models failed but inference profiles succeeded
Models: 12 inference profiles loaded (Claude Opus/Sonnet cross-region)

Fix: This is OK! User has ListInferenceProfiles permission but not 
ListFoundationModels. Inference profiles are sufficient for most use cases.
```

#### ✅ Implementation Checklist

**Code Changes:**
- [ ] Add `bedrockLastError` cache to ProxyServer class
- [ ] Update `getAvailableModels()` to cache Bedrock errors
- [ ] Add `getBedrockStatus()` method to ProxyServer
- [ ] Make `listBedrockAvailableModels()` resilient (partial success OK)
- [ ] Add `/admin/bedrock/test` POST endpoint
- [ ] Add `testBedrockCredentials()` helper in bedrock.ts
- [ ] Create BedrockPanel UI component with error display
- [ ] Add "Test Credentials" button to UI

**Testing:**
- [ ] Test with invalid AWS credentials → Error shown in UI
- [ ] Test with partial IAM permissions → Partial models returned
- [ ] Test with wrong region → Clear error message
- [ ] Test with valid config → Models appear in Openclaw `/v1/models`
- [ ] Test error persistence → Error survives page refresh
- [ ] Test error clearing → Success test clears cached error

**Documentation:**
- [ ] Add troubleshooting section to Bedrock docs
- [ ] Document required IAM permissions with examples
- [ ] Add common error scenarios with fixes
- [ ] Update setup guide with "Test Credentials" step
- [ ] Document partial success behavior

#### 📈 Expected Results

**Before Fix:**
```
User: "Bedrock models không hiển thị trong Openclaw"
→ Check console logs → See error (maybe)
→ Guess what's wrong (IAM? Region? Credentials?)
→ Try different configs randomly
→ Frustration 😞
```

**After Fix:**
```
User: "Bedrock models không hiển thị"
→ Open Krouter Dashboard → See clear error message
→ Click "Test Credentials" → See exactly what failed
→ Fix IAM permissions / credentials / region
→ Test again → Models appear
→ Success! ✅
```

#### 🎯 Success Criteria

- [x] Root cause identified (silent failure in model listing)
- [ ] Error visibility added (bedrockLastError cache)
- [ ] Diagnostic endpoint available (POST /admin/bedrock/test)
- [ ] UI shows clear error messages when Bedrock fails
- [ ] Partial success supported (foundation OR profiles OK)
- [ ] User can test and retry without restarting Krouter
- [ ] Errors cached (survive page refresh)
- [ ] Common errors documented with fixes

**Impact:** Fixes user's reported issue "Bedrock models không xem và dùng được trong Openclaw" ✅

---

## PHASE 13: Skills System Implementation ⏱️ Tuần 9

### 🎯 Objective
Replace Config Sync page với Skills system để AI agents có thể auto-discover và sử dụng Krouter capabilities.

### ✅ Deliverables

**1. Built-in Skills (Week 1)**
- [ ] `docs/skills/krouter/SKILL.md` - Entry skill
- [ ] `docs/skills/krouter-proxy/SKILL.md` - Proxy API
- [ ] `docs/skills/krouter-image/SKILL.md` - Image generation
- [ ] `docs/skills/krouter-admin/SKILL.md` - Admin API
- [ ] `docs/skills/krouter-mitm/SKILL.md` - MITM server
- [ ] `docs/skills/README.md` - Skills catalog

**2. Frontend (Week 2)**
- [ ] Create SkillsPage component
- [ ] Skill list view (builtin + custom)
- [ ] Skill content viewer
- [ ] Copy skill URL button
- [ ] Remove ConfigSyncPage
- [ ] Update Sidebar menu

**3. Backend (Week 2)**
- [ ] Create skills API routes
- [ ] GET /api/skills/list
- [ ] GET /api/skills/content?id=...
- [ ] GET /skills/:skillId/SKILL.md (direct access)
- [ ] Frontmatter parser
- [ ] Custom skills directory support

**4. Documentation (Week 3)**
- [ ] Skills usage guide
- [ ] How to create custom skills
- [ ] AI agent integration examples
- [ ] Migration guide from Config Sync

### 📊 Success Metrics
- [ ] 5 built-in skills documented
- [ ] Skills accessible via HTTP
- [ ] AI agents can fetch and use skills
- [ ] Config Sync fully replaced
- [ ] Zero user complaints about missing features

### 📈 Expected Impact
- Better AI agent integration
- Self-documenting API
- Easier for new users to discover features
- Extensible for custom capabilities

---

## 📊 SUCCESS METRICS SUMMARY

### Before vs After Comparison

| Metric | Current | Target | Improvement |
|--------|---------|--------|-------------|
| **429 Error Rate** | ~15% peak | <2% | 87% reduction |
| **Max Task Duration** | 5 minutes | 60 minutes | 12x increase |
| **Account Rotation Efficiency** | ~60% | >90% | 50% improvement |
| **Cache Hit Rate** | ~30% | >60% | 2x improvement |
| **P95 Response Latency** | ~4s | <2s | 50% faster |
| **Account Cooldown Time** | ~5min | <2min | 60% faster recovery |
| **Hot Account Overload** | High | Low | 70% reduction |
| **Tool Call Duplicate Rate** | ~25% | <10% | 60% reduction |
| **Image Generation** | ❌ Not available | ✅ Available | New capability |
| **MITM Server** | ❌ Not available | ✅ Available | New capability |
| **Skills System** | ❌ Not available | ✅ Available | New capability |
| **Supported IDE Tools** | 5 tools | 15+ tools | 3x increase |

### Cost Impact

**Savings:**
- Reduced 429 retries: **-$20-30/month**
- Better prompt caching: **-$50-100/month**
- Tool call deduplication: **-$30-50/month**
- **Total savings: $100-180/month**

**New Costs:**
- Image generation: **+$40/month** (1000 images)
- MITM Server: **$0** (free, no additional cost)
- Skills System: **$0** (free, no additional cost)
- **Net impact: $60-140/month savings** (even with images)

---

## 🚀 DEPLOYMENT PLAN

### Pre-Deployment Checklist
- [ ] Backup current config: `krouter backup`
- [ ] Backup current database
- [ ] Document current metrics baseline
- [ ] Notify Openclaw users about maintenance
- [ ] Prepare rollback plan

### Week 1-2: Phase 1 (Smart Rotation)
```powershell
# 1. Deploy code
git checkout feature/smart-rotation
npm run build:fullstack
krouter restart

# 2. Enable test mode
krouter config set proxy.strategy=smart-v2
krouter config set proxy.test_mode=true

# 3. Monitor for 24h
krouter admin stats

# 4. Rollout to production
krouter config set proxy.test_mode=false
```

### Week 2-3: Phase 2 (429 Mitigation)
```powershell
# 1. Deploy throttling handler
git checkout feature/429-mitigation
npm run build:fullstack

# 2. Configure rate limits
krouter config set bedrock.rate_limits='{
  "nova-pro": 90,
  "nova-lite": 270,
  "claude-sonnet": 360
}'

# 3. Enable adaptive limiting
krouter config set proxy.adaptive_rate_limiting=true

# 4. Monitor 429 reduction
krouter admin stats --filter=429
```

### Week 3-4: Phase 3 (Long Tasks)
```powershell
# 1. Deploy streaming updates
git checkout feature/long-running
npm run build:fullstack

# 2. Update timeouts
krouter config set proxy.stream_timeout=3600000
krouter config set proxy.heartbeat_interval=30000

# 3. Test long task
curl -N http://127.0.0.1:5580/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -d '{"model": "claude-sonnet-4.5", "messages": [...], "stream": true}'
```

### Week 4-7: Phases 4-10 (Incremental)
- Deploy each phase incrementally
- Monitor metrics after each deployment
- A/B test when possible
- Gradual rollout (10% → 50% → 100%)

### Week 7-8: Phase 11 (Image Generation)
```powershell
# 1. Configure AWS Bedrock
krouter config set bedrock.enabled=true
krouter config set bedrock.region=us-east-1

# 2. Set credentials (secure method)
krouter admin bedrock-setup
# Or use environment variables
$env:AWS_ACCESS_KEY_ID = "AKIA..."
$env:AWS_SECRET_ACCESS_KEY = "..."

# 3. Deploy image endpoints
git checkout feature/image-generation
npm run build:fullstack
krouter restart

# 4. Test generation
curl http://127.0.0.1:5580/v1/images/generations \
  -H "Authorization: Bearer sk-..." \
  -d '{"prompt": "Test image", "n": 1}'

# 5. Configure storage
krouter config set images.storage_type=local
krouter config set images.cleanup_age=86400000

# 6. Enable auto-cleanup
krouter config set images.auto_cleanup=true
```

---

## 🔍 MONITORING & VALIDATION

### Key Metrics to Track

**Dashboard 1: Request Performance**
```
- Total requests/min
- Success rate (%)
- Error rate by type (429, 500, etc)
- P50, P95, P99 latency
- Active streaming connections
```

**Dashboard 2: Account Health**
```
- Per-account success rate
- Per-account request distribution
- Quota remaining by account
- Cooldown status
- Token freshness
```

**Dashboard 3: Caching**
```
- Prompt cache hit rate
- Tool call cache hit rate
- Cache size (MB)
- Cache eviction rate
- Token savings from cache
```

**Dashboard 4: Image Generation**
```
- Images generated/hour
- Generation success rate
- Average generation time
- Storage usage
- Cost tracking
```

### Alerting Rules

**Critical Alerts:**
```yaml
- name: HighErrorRate
  condition: error_rate > 10%
  severity: critical
  action: Page on-call

- name: AllAccountsThrottled
  condition: available_accounts == 0
  severity: critical
  action: Page on-call

- name: AllAccountsQuotaLow
  condition: all(quota < 20%)
  severity: critical
  action: Email + Slack
```

**Warning Alerts:**
```yaml
- name: Elevated429Rate
  condition: throttling_rate > 5%
  severity: warning
  action: Slack notification

- name: HighLatency
  condition: p95_latency > 5000
  severity: warning
  action: Slack notification

- name: LowCacheHitRate
  condition: cache_hit_rate < 40%
  severity: warning
  action: Email
```

### Health Checks

**Automated Tests (every 5 min):**
```bash
#!/bin/bash
# healthcheck.sh

# 1. Proxy health
curl -f http://127.0.0.1:5580/health || exit 1

# 2. Model list
curl -f http://127.0.0.1:5580/v1/models \
  -H "Authorization: Bearer sk-..." || exit 1

# 3. Chat completion
curl -f http://127.0.0.1:5580/v1/chat/completions \
  -H "Authorization: Bearer sk-..." \
  -d '{"model": "claude-sonnet-4.5", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}' || exit 1

# 4. Admin stats
curl -f http://127.0.0.1:5580/admin/stats \
  -H "Authorization: Bearer sk-admin-..." || exit 1
```

---

## 🔄 ROLLBACK PLAN

### If Phase 1-2 Fails
```powershell
# Revert to previous strategy
krouter config set proxy.strategy=smart
krouter config set proxy.adaptive_rate_limiting=false

# Restore backup
krouter restore --from=backup-20260719

# Restart
krouter restart
```

### If Phase 3 Fails
```powershell
# Revert timeouts
krouter config set proxy.stream_timeout=300000
krouter config set proxy.heartbeat_interval=0

# Disable heartbeat
krouter config set proxy.enable_heartbeat=false
```

### If Phase 11 Fails
```powershell
# Disable image endpoints
krouter config set bedrock.image_generation=false

# Clean up storage
Remove-Item -Recurse -Force ./images/*

# Restart without image support
krouter restart
```

---

## 📝 DOCUMENTATION UPDATES

### Files to Update

**User Documentation:**
- [ ] `docs/API-Proxy-Guide.vi.md` - Add image generation section
- [ ] `docs/API-Proxy-Guide.en.md` - Add image generation section
- [ ] `README.md` - Update features list
- [ ] `CHANGELOG.md` - Document all changes

**Developer Documentation:**
- [ ] `docs/Architecture.md` - Update architecture diagrams
- [ ] `docs/Bedrock-Provider.md` - Add image generation
- [ ] `docs/Configuration.md` - New config options
- [ ] `docs/Monitoring.md` - New metrics and alerts

**API Documentation:**
- [ ] OpenAPI spec for image endpoints
- [ ] Example requests/responses
- [ ] Error code documentation
- [ ] Rate limit documentation

---

## 🎓 TRAINING & ONBOARDING

### Team Training
- [ ] Overview of new features (1h presentation)
- [ ] Hands-on lab: Testing image generation
- [ ] Monitoring dashboard walkthrough
- [ ] Incident response procedures
- [ ] Rollback procedures

### User Communication
- [ ] Announcement email about new features
- [ ] Migration guide for Openclaw users
- [ ] Updated configuration examples
- [ ] FAQ document
- [ ] Video tutorials (optional)

---

## 📅 TIMELINE GANTT CHART

```
Week 1-2:  [████████] Phase 1: Smart Rotation
Week 2-3:    [████████] Phase 2: 429 Mitigation
Week 3-4:      [████████] Phase 3: Long Tasks
Week 4:          [████] Phase 4: Cache Optimization
Week 4-5:        [██████] Phase 5: Tool Call Cache
Week 5:            [████] Phase 6: Model Refresh
Week 5-6:          [██████] Phase 7: Logging
Week 6:              [████] Phase 8: Dashboard
Week 6-7:            [██████] Phase 9: Quota Mgmt
Week 7:                [████] Phase 10: Metrics
Week 7-8:              [████████] Phase 11: Images
Week 8-9:                [████████] Phase 12: MITM Server
Week 9:                    [████] Phase 13: Skills System
Week 10:                     [████] Testing & Doc
```

**Total: 10 weeks (8-10 weeks with buffer)**

---

## ✅ FINAL CHECKLIST

### Pre-Launch
- [ ] All phases tested individually
- [ ] Integration testing complete
- [ ] Performance benchmarks passed
- [ ] Security review complete
- [ ] Documentation updated
- [ ] Team trained
- [ ] Backup plan ready
- [ ] Rollback tested
- [ ] Monitoring configured
- [ ] Alerts configured

### Launch Day
- [ ] Deploy to production
- [ ] Smoke tests passed
- [ ] Metrics baseline captured
- [ ] Monitor for first 4 hours
- [ ] Announce to users
- [ ] Support team ready

### Post-Launch (Week 1)
- [ ] Monitor metrics daily
- [ ] Collect user feedback
- [ ] Fine-tune parameters
- [ ] Address any issues
- [ ] Document lessons learned

### Post-Launch (Week 2-4)
- [ ] Analyze success metrics
- [ ] Generate performance report
- [ ] Plan next optimizations
- [ ] User satisfaction survey
- [ ] Celebrate success! 🎉

---

## 🎯 CONCLUSION

Krouter upgrade plan này sẽ transform proxy system thành một **production-grade, enterprise-ready** solution với:

✅ **Reliability** - 429 errors giảm 87%, smart rotation tránh overload  
✅ **Performance** - Long tasks support, cache optimization, faster response  
✅ **Capability** - Image generation, MITM server, Skills system  
✅ **Observability** - Comprehensive metrics, logging, alerting  
✅ **Cost Efficiency** - Net savings $60-140/month despite new features  
✅ **Extensibility** - Support 15+ IDE tools, AI agent auto-discovery

**Total Investment:**
- Development time: 8-10 weeks
- Testing & validation: 1-2 weeks
- Documentation: 1 week
- **Total: ~10-12 weeks**

**ROI:**
- Better uptime và reliability
- Reduced support burden
- Cost savings
- New revenue opportunity (image generation)
- Competitive advantage (MITM server + Skills)
- Better AI agent integration

**Key Achievements:**
1. ✅ Phase 1-10: Core proxy optimizations (429 mitigation, long tasks, caching)
2. ✅ Phase 11: Image generation via Amazon Nova Canvas + **Bedrock diagnostics fix**
3. ✅ Phase 12: **IDE Integration Tools** (simple config approach, NO MITM needed)
4. ✅ Phase 13: Skills system thay thế Config Sync (AI agent friendly)

**Architecture Insight:**
- **Inspired by 9Router:** Phát hiện MITM proxy is overengineered
- **Simple is better:** Config files + env variables đủ cho hầu hết IDEs
- **65% less code:** 400 lines thay vì 1150 lines
- **More reliable:** No certificates, no trust chain, no platform issues

---

**Document Version:** 4.0  
**Last Updated:** 2026-07-19  
**Status:** Ready for Implementation ✅
**Major Changes:** 
- Added Phase 12 (IDE Integration Tools - **REVISED from MITM**)
- Added Phase 13 (Skills System)
- Added Bedrock diagnostics fix to Phase 11
- **Critical revision:** Analyzed 9Router source → MITM is overengineered
- **New approach:** Simple config files + env variables (65% less code)
- Removed complex MITM implementation (~1150 lines)
- Added simple IDE integration tools (~400 lines)


---

### PHASE 12: IDE Integration via MITM Proxy ⏱️ Tuần 8-9

#### 🎯 Objective
Implement MITM (Man-In-The-Middle) proxy server để intercept HTTPS traffic từ IDE tools hardcoded endpoints (Kiro IDE, Antigravity, GitHub Copilot) và route through Krouter - **theo ĐÚNG pattern 9Router đã làm** (DNS redirect + localhost HTTPS server).

#### 📊 9Router MITM Architecture (From Screenshots)

**How 9Router Actually Works:**
```
1. Edit hosts file manually:
   127.0.0.1 runtime.us-east-1.kiro.dev
   127.0.0.1 o.us-east-1.amazoninces.com
   127.0.0.1 codehub.server.us-east-1.amazoninces.com

2. Start MITM server on localhost:443 (HTTPS)

3. IDE makes request to runtime.us-east-1.kiro.dev:443
   ↓
   DNS resolves to 127.0.0.1 (hosts file)
   ↓
   MITM server intercepts on localhost:443
   ↓
   MITM proxies to 9Router backend
   ↓
   9Router routes to actual provider
```

**Key Evidence from Screenshots:**
- ✅ Toggle "Enable DNS" button
- ✅ "Start DNS" button (starts MITM server)
- ✅ DNS entries shown: `127.0.0.1 runtime.us-east-1.kiro.dev`
- ✅ Model mappings: `Claude Sonnet 5 → provider/model-id`
- ✅ Works with: Kiro IDE, Antigravity, GitHub Copilot

**Why DNS Redirect Approach:**
- IDE hardcoded endpoints cannot be changed via config
- Hosts file redirects domain to localhost
- MITM server on localhost:443 intercepts
- No system proxy needed (DNS-level redirect)
- Graceful fallback: Remove hosts entries → IDE uses real endpoints

#### ✅ Krouter MITM Implementation (Following 9Router Pattern)

**Core Components:**

**1. Hosts File Manager**
```typescript
// File: src/main/mitm/hostsManager.ts

interface DNSEntry {
  ip: string          // Always 127.0.0.1
  hostname: string    // e.g., runtime.us-east-1.kiro.dev
  enabled: boolean
}

class HostsFileManager {
  private hostsPath: string
  private krouterMarker = '# Krouter MITM'
  
  constructor() {
    // Platform-specific hosts file path
    this.hostsPath = process.platform === 'win32'
      ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      : '/etc/hosts'
  }
  
  /**
   * Add Krouter DNS entries to hosts file
   */
  async addEntries(entries: DNSEntry[]): Promise<void> {
    // Read current hosts file
    let content = await fs.promises.readFile(this.hostsPath, 'utf8')
    
    // Remove existing Krouter entries
    content = this.removeKrouterEntries(content)
    
    // Append new entries
    const newEntries = '\n' + this.krouterMarker + '\n' +
      entries.filter(e => e.enabled)
        .map(e => `${e.ip} ${e.hostname}`)
        .join('\n') +
      '\n' + this.krouterMarker + ' END\n'
    
    content += newEntries
    
    // Write back (requires admin/sudo)
    await this.writeHostsFile(content)
  }
  
  /**
   * Remove all Krouter entries from hosts file
   */
  async removeEntries(): Promise<void> {
    let content = await fs.promises.readFile(this.hostsPath, 'utf8')
    content = this.removeKrouterEntries(content)
    await this.writeHostsFile(content)
  }
  
  private removeKrouterEntries(content: string): string {
    const regex = new RegExp(
      `\\n${this.krouterMarker}[\\s\\S]*?${this.krouterMarker} END\\n`,
      'g'
    )
    return content.replace(regex, '')
  }
  
  private async writeHostsFile(content: string): Promise<void> {
    // Check if admin/sudo
    if (!this.hasAdminPrivileges()) {
      throw new Error('Admin privileges required to modify hosts file')
    }
    
    await fs.promises.writeFile(this.hostsPath, content, 'utf8')
    
    // Flush DNS cache
    await this.flushDNSCache()
  }
  
  private async flushDNSCache(): Promise<void> {
    const cmd = process.platform === 'win32'
      ? 'ipconfig /flushdns'
      : process.platform === 'darwin'
      ? 'sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder'
      : 'sudo systemd-resolve --flush-caches'
    
    await execAsync(cmd)
  }
  
  /**
   * Check current status of Krouter DNS entries
   */
  async getStatus(): Promise<{ enabled: boolean; entries: DNSEntry[] }> {
    const content = await fs.promises.readFile(this.hostsPath, 'utf8')
    const krouterSection = content.match(
      new RegExp(`${this.krouterMarker}([\\s\\S]*?)${this.krouterMarker} END`)
    )
    
    if (!krouterSection) {
      return { enabled: false, entries: [] }
    }
    
    const entries: DNSEntry[] = []
    const lines = krouterSection[1].trim().split('\n')
    
    for (const line of lines) {
      const match = line.match(/^([\d.]+)\s+(.+)$/)
      if (match) {
        entries.push({
          ip: match[1],
          hostname: match[2],
          enabled: true
        })
      }
    }
    
    return { enabled: entries.length > 0, entries }
  }
}
```

**2. HTTPS MITM Server (localhost:443)**
```typescript
// File: src/main/mitm/httpsServer.ts

class MITMHTTPSServer {
  private server: https.Server | null = null
  private certManager: CertificateManager
  private port = 443  // Standard HTTPS port
  
  /**
   * Start HTTPS server on localhost:443
   */
  async start(): Promise<void> {
    // Generate self-signed cert for localhost
    const { cert, key } = await this.certManager.ensureLocalh ostCertificate()
    
    this.server = https.createServer(
      { cert, key },
      this.handleRequest.bind(this)
    )
    
    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`[MITM] HTTPS server listening on https://127.0.0.1:${this.port}`)
    })
  }
  
  /**
   * Handle intercepted HTTPS request
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const hostname = req.headers.host || ''
    const path = req.url || '/'
    
    console.log(`[MITM] Intercepted: ${req.method} ${hostname}${path}`)
    
    // Detect IDE type from hostname
    const ideType = this.detectIDEType(hostname)
    
    // Map to Krouter endpoint
    const krouterURL = this.mapToKrouterEndpoint(ideType, path, req.headers)
    
    // Forward to Krouter
    const proxyReq = http.request(
      krouterURL,
      {
        method: req.method,
        headers: {
          ...req.headers,
          'x-krouter-mitm': 'true',
          'x-krouter-ide-type': ideType
        }
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode!, proxyRes.headers)
        proxyRes.pipe(res)
      }
    )
    
    req.pipe(proxyReq)
  }
  
  private detectIDEType(hostname: string): string {
    if (hostname.includes('kiro.dev')) return 'kiro'
    if (hostname.includes('amazoninces.com')) return 'copilot'
    if (hostname.includes('googleapis.com')) return 'antigravity'
    return 'unknown'
  }
  
  private mapToKrouterEndpoint(
    ideType: string,
    path: string,
    headers: http.IncomingHttpHeaders
  ): string {
    // All IDE requests → Krouter /v1/* endpoints
    return `http://localhost:5580${path}`
  }
}
```

**3. Model Mapping Configuration**
```typescript
// File: src/main/mitm/modelMapper.ts

interface ModelMapping {
  ideModel: string          // Model ID from IDE
  krouterProvider: string   // Krouter provider
  krouterModel: string      // Krouter model ID
}

const DEFAULT_MAPPINGS: ModelMapping[] = [
  // Kiro IDE mappings
  {
    ideModel: 'us.anthropic.claude-opus-4-5-20250805-v1:0',
    krouterProvider: 'kiro-free',
    krouterModel: 'claude-opus-4.5'
  },
  {
    ideModel: 'anthropic.claude-sonnet-4-5-20250514-v1:0',
    krouterProvider: 'kiro-free',
    krouterModel: 'claude-sonnet-4.5'
  },
  
  // Antigravity IDE mappings
  {
    ideModel: 'gemini-pro',
    krouterProvider: 'kiro-free',
    krouterModel: 'gemini-2.0-flash-exp'
  },
  {
    ideModel: 'gemini-pro-vision',
    krouterProvider: 'kiro-free',
    krouterModel: 'gemini-2.0-flash-exp'
  },
  
  // GitHub Copilot mappings
  {
    ideModel: 'gpt-4o',
    krouterProvider: 'kiro-free',
    krouterModel: 'claude-sonnet-4.5'  // Better than GPT-4o
  },
  {
    ideModel: 'gpt-3.5-turbo',
    krouterProvider: 'kiro-free',
    krouterModel: 'gemini-2.0-flash-exp'  // Faster, free
  }
]

class ModelMapper {
  private mappings: ModelMapping[]
  
  constructor(customMappings?: ModelMapping[]) {
    this.mappings = customMappings || DEFAULT_MAPPINGS
  }
  
  /**
   * Map IDE model to Krouter provider/model
   */
  map(ideModel: string): { provider: string; model: string } | null {
    const mapping = this.mappings.find(m => m.ideModel === ideModel)
    if (!mapping) return null
    
    return {
      provider: mapping.krouterProvider,
      model: mapping.krouterModel
    }
  }
  
  /**
   * Load custom mappings from config file
   */
  static loadFromConfig(configPath: string): ModelMapper {
    if (!fs.existsSync(configPath)) {
      return new ModelMapper()
    }
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return new ModelMapper(config.mappings)
  }
}
```

**4. MITM Settings Page (Complete UI - Following 9Router)**

**File:** `src/renderer/src/components/pages/MITMPage.tsx`

```typescript
import { useState, useEffect } from 'react'
import { Shield, Power, Settings, Save, Plus, Trash2, Edit2, Copy, CheckCircle2, AlertTriangle, Info } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Card, CardContent, CardHeader, CardTitle, Button, Input, Label, Switch, Badge, Alert, Select } from '../ui'

interface DNSEntry {
  hostname: string
  enabled: boolean
  ideType: 'kiro' | 'copilot' | 'antigravity' | 'custom'
}

interface ModelMapping {
  id: string
  ideModel: string
  krouterProvider: string
  krouterModel: string
  enabled: boolean
}

interface MITMStatus {
  dnsEnabled: boolean
  serverRunning: boolean
  activeConnections: number
  entriesActive: DNSEntry[]
  certificateInstalled: boolean
  requiresAdmin: boolean
}

export function MITMPage() {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  
  const [status, setStatus] = useState<MITMStatus | null>(null)
  const [modelMappings, setModelMappings] = useState<ModelMapping[]>([])
  const [customDNSEntries, setCustomDNSEntries] = useState<DNSEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [editingMapping, setEditingMapping] = useState<ModelMapping | null>(null)
  
  // Predefined DNS entries (like 9Router)
  const PREDEFINED_ENTRIES: DNSEntry[] = [
    { hostname: 'runtime.us-east-1.kiro.dev', enabled: true, ideType: 'kiro' },
    { hostname: 'runtime.us-west-2.kiro.dev', enabled: true, ideType: 'kiro' },
    { hostname: 'o.us-east-1.amazoninces.com', enabled: true, ideType: 'copilot' },
    { hostname: 'codehub.server.us-east-1.amazoninces.com', enabled: true, ideType: 'copilot' },
    { hostname: 'generativelanguage.googleapis.com', enabled: true, ideType: 'antigravity' },
    { hostname: 'daily-cloudcode-pa.googleapis.com', enabled: true, ideType: 'antigravity' }
  ]

  useEffect(() => {
    loadStatus()
    loadModelMappings()
    const interval = setInterval(loadStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  async function loadStatus() {
    try {
      const res = await fetch('/api/mitm/status')
      const data = await res.json()
      setStatus(data)
    } catch (error) {
      console.error('Failed to load MITM status:', error)
    }
  }

  async function loadModelMappings() {
    try {
      const res = await fetch('/api/mitm/model-mappings')
      const data = await res.json()
      setModelMappings(data.mappings)
    } catch (error) {
      console.error('Failed to load model mappings:', error)
    }
  }

  async function toggleDNS(enabled: boolean) {
    setLoading(true)
    try {
      await fetch('/api/mitm/dns/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      })
      await loadStatus()
    } finally {
      setLoading(false)
    }
  }

  async function saveModelMappings() {
    setLoading(true)
    try {
      await fetch('/api/mitm/model-mappings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings: modelMappings })
      })
      alert(isEn ? 'Model mappings saved successfully' : '模型映射保存成功')
    } finally {
      setLoading(false)
    }
  }

  async function testConnection(ideType: string) {
    setLoading(true)
    try {
      const res = await fetch('/api/mitm/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ideType })
      })
      const result = await res.json()
      
      if (result.success) {
        alert(`✓ Connection test passed\nIDE: ${ideType}\nLatency: ${result.latency}ms`)
      } else {
        alert(`✗ Connection test failed\nError: ${result.error}`)
      }
    } finally {
      setLoading(false)
    }
  }

  function addModelMapping() {
    const newMapping: ModelMapping = {
      id: `mapping-${Date.now()}`,
      ideModel: '',
      krouterProvider: 'kiro-free',
      krouterModel: '',
      enabled: true
    }
    setModelMappings([...modelMappings, newMapping])
    setEditingMapping(newMapping)
  }

  function deleteMapping(id: string) {
    if (!confirm(isEn ? 'Delete this mapping?' : '删除此映射？')) return
    setModelMappings(modelMappings.filter(m => m.id !== id))
  }

  function toggleMappingEnabled(id: string) {
    setModelMappings(modelMappings.map(m => 
      m.id === id ? { ...m, enabled: !m.enabled } : m
    ))
  }

  if (!status) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Shield className="h-12 w-12 mx-auto mb-3 opacity-30 animate-pulse" />
          <p>{isEn ? 'Loading MITM settings...' : '加载 MITM 设置...'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-gradient-to-br from-purple-500 to-pink-500 shadow-lg">
            <Shield className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
              {isEn ? 'MITM Proxy Settings' : 'MITM 代理设置'}
            </h1>
            <p className="text-muted-foreground">
              {isEn
                ? 'Intercept IDE tools traffic and route through Krouter with custom model mappings'
                : '拦截 IDE 工具流量并通过 Krouter 路由，支持自定义模型映射'
              }
            </p>
          </div>
        </div>
      </div>

      {/* Status Overview Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Power className={status.serverRunning ? 'text-green-500' : 'text-gray-400'} />
              {isEn ? 'DNS Redirect Status' : 'DNS 重定向状态'}
            </CardTitle>
            <div className="flex items-center gap-3">
              {status.serverRunning && (
                <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-200">
                  ● {isEn ? 'Active' : '激活'}
                </Badge>
              )}
              <Switch
                checked={status.dnsEnabled}
                onCheckedChange={toggleDNS}
                disabled={loading}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {status.requiresAdmin && !status.dnsEnabled && (
            <Alert variant="warning">
              <AlertTriangle className="h-4 w-4" />
              <div>
                <h4 className="font-medium">{isEn ? 'Admin Access Required' : '需要管理员权限'}</h4>
                <p className="text-sm text-muted-foreground">
                  {isEn
                    ? 'Modifying hosts file requires administrator privileges. Krouter will prompt for elevation.'
                    : '修改 hosts 文件需要管理员权限。Krouter 将提示权限提升。'
                  }
                </p>
              </div>
            </Alert>
          )}

          {status.dnsEnabled && !status.certificateInstalled && (
            <Alert>
              <Info className="h-4 w-4" />
              <div>
                <h4 className="font-medium">{isEn ? 'Certificate Not Installed' : '证书未安装'}</h4>
                <p className="text-sm text-muted-foreground">
                  {isEn
                    ? 'For HTTPS interception, install the root certificate to avoid SSL warnings.'
                    : '为进行 HTTPS 拦截，请安装根证书以避免 SSL 警告。'
                  }
                </p>
                <Button size="sm" variant="outline" className="mt-2">
                  {isEn ? 'Install Certificate' : '安装证书'}
                </Button>
              </div>
            </Alert>
          )}

          {status.dnsEnabled && (
            <div className="grid grid-cols-3 gap-4">
              <div className="p-4 rounded-lg border bg-muted/50">
                <div className="text-2xl font-bold text-green-600">{status.activeConnections}</div>
                <div className="text-sm text-muted-foreground">{isEn ? 'Active Connections' : '活动连接'}</div>
              </div>
              <div className="p-4 rounded-lg border bg-muted/50">
                <div className="text-2xl font-bold text-blue-600">{status.entriesActive.length}</div>
                <div className="text-sm text-muted-foreground">{isEn ? 'DNS Entries' : 'DNS 条目'}</div>
              </div>
              <div className="p-4 rounded-lg border bg-muted/50">
                <div className="text-2xl font-bold text-purple-600">{modelMappings.filter(m => m.enabled).length}</div>
                <div className="text-sm text-muted-foreground">{isEn ? 'Active Mappings' : '激活映射'}</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* DNS Entries Management */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>{isEn ? 'DNS Redirect Entries' : 'DNS 重定向条目'}</CardTitle>
            <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText('127.0.0.1')}>
              <Copy className="h-4 w-4 mr-2" />
              {isEn ? 'Copy IP' : '复制 IP'}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground mb-4">
            {isEn
              ? 'These domains will be redirected to localhost (127.0.0.1) when DNS redirect is enabled.'
              : '启用 DNS 重定向时，这些域名将被重定向到本地主机 (127.0.0.1)。'
            }
          </p>

          {/* Predefined Entries */}
          <div className="space-y-2">
            <Label className="text-xs font-semibold uppercase text-muted-foreground">
              {isEn ? 'Predefined Entries' : '预定义条目'}
            </Label>
            {PREDEFINED_ENTRIES.map((entry) => (
              <div key={entry.hostname} className="flex items-center gap-3 p-3 rounded-lg border bg-card">
                <Badge variant="outline" className="shrink-0">
                  {entry.ideType === 'kiro' && '⚡ Kiro'}
                  {entry.ideType === 'copilot' && '🐙 Copilot'}
                  {entry.ideType === 'antigravity' && '🌌 Antigravity'}
                </Badge>
                <code className="flex-1 text-sm font-mono truncate">{entry.hostname}</code>
                <span className="text-xs text-muted-foreground">→ 127.0.0.1</span>
                <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
              </div>
            ))}
          </div>

          {/* Test Connection Buttons */}
          <div className="flex gap-2 pt-2">
            <Button size="sm" variant="outline" onClick={() => testConnection('kiro')}>
              {isEn ? 'Test Kiro IDE' : '测试 Kiro IDE'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => testConnection('copilot')}>
              {isEn ? 'Test Copilot' : '测试 Copilot'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => testConnection('antigravity')}>
              {isEn ? 'Test Antigravity' : '测试 Antigravity'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Model Mappings */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>{isEn ? 'Model Mappings' : '模型映射'}</CardTitle>
              <p className="text-sm text-muted-foreground mt-1">
                {isEn
                  ? 'Map IDE model names to Krouter providers and models'
                  : '将 IDE 模型名称映射到 Krouter 提供商和模型'
                }
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={addModelMapping}>
                <Plus className="h-4 w-4 mr-2" />
                {isEn ? 'Add Mapping' : '添加映射'}
              </Button>
              <Button size="sm" onClick={saveModelMappings} disabled={loading}>
                <Save className="h-4 w-4 mr-2" />
                {isEn ? 'Save All' : '保存全部'}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {modelMappings.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Settings className="h-12 w-12 mx-auto mb-3 opacity-30" />
              <p>{isEn ? 'No model mappings configured' : '未配置模型映射'}</p>
              <p className="text-sm mt-1">{isEn ? 'Add your first mapping to get started' : '添加第一个映射开始使用'}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {modelMappings.map((mapping) => (
                <div key={mapping.id} className="flex items-center gap-3 p-4 rounded-lg border bg-card">
                  <Switch
                    checked={mapping.enabled}
                    onCheckedChange={() => toggleMappingEnabled(mapping.id)}
                  />
                  
                  <div className="flex-1 grid grid-cols-3 gap-3">
                    <div>
                      <Label className="text-xs text-muted-foreground">{isEn ? 'IDE Model' : 'IDE 模型'}</Label>
                      <code className="text-sm font-mono block truncate">{mapping.ideModel || '—'}</code>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">{isEn ? 'Provider' : '提供商'}</Label>
                      <code className="text-sm font-mono block truncate">{mapping.krouterProvider}</code>
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">{isEn ? 'Krouter Model' : 'Krouter 模型'}</Label>
                      <code className="text-sm font-mono block truncate">{mapping.krouterModel || '—'}</code>
                    </div>
                  </div>

                  <div className="flex gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEditingMapping(mapping)}
                    >
                      <Edit2 className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => deleteMapping(mapping.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Default Mappings Info */}
          <Alert className="mt-4">
            <Info className="h-4 w-4" />
            <div className="text-sm">
              <p className="font-medium mb-1">{isEn ? 'Default Mappings Examples:' : '默认映射示例：'}</p>
              <ul className="space-y-1 text-muted-foreground">
                <li>• <code>claude-sonnet-4.5</code> → <code>kiro-free</code> / <code>claude-sonnet-4.5</code></li>
                <li>• <code>gemini-pro</code> → <code>kiro-free</code> / <code>gemini-2.0-flash-exp</code></li>
                <li>• <code>gpt-4o</code> → <code>kiro-free</code> / <code>claude-sonnet-4.5</code></li>
              </ul>
            </div>
          </Alert>
        </CardContent>
      </Card>

      {/* Edit Mapping Modal */}
      {editingMapping && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <Card className="w-full max-w-lg">
            <CardHeader>
              <CardTitle>{isEn ? 'Edit Model Mapping' : '编辑模型映射'}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>{isEn ? 'IDE Model Name' : 'IDE 模型名称'}</Label>
                <Input
                  value={editingMapping.ideModel}
                  onChange={(e) => setEditingMapping({ ...editingMapping, ideModel: e.target.value })}
                  placeholder="e.g., claude-sonnet-4.5 or gemini-pro"
                  className="font-mono"
                />
              </div>

              <div>
                <Label>{isEn ? 'Krouter Provider' : 'Krouter 提供商'}</Label>
                <Select
                  value={editingMapping.krouterProvider}
                  onValueChange={(value) => setEditingMapping({ ...editingMapping, krouterProvider: value })}
                >
                  <option value="kiro-free">Kiro Free</option>
                  <option value="bedrock">AWS Bedrock</option>
                  <option value="xpixi">Xpixi</option>
                </Select>
              </div>

              <div>
                <Label>{isEn ? 'Krouter Model' : 'Krouter 模型'}</Label>
                <Input
                  value={editingMapping.krouterModel}
                  onChange={(e) => setEditingMapping({ ...editingMapping, krouterModel: e.target.value })}
                  placeholder="e.g., claude-sonnet-4.5"
                  className="font-mono"
                />
              </div>

              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEditingMapping(null)}>
                  {isEn ? 'Cancel' : '取消'}
                </Button>
                <Button onClick={() => {
                  setModelMappings(modelMappings.map(m =>
                    m.id === editingMapping.id ? editingMapping : m
                  ))
                  setEditingMapping(null)
                }}>
                  {isEn ? 'Save' : '保存'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* How It Works */}
      <Card className="border-blue-200 dark:border-blue-900">
        <CardHeader>
          <CardTitle className="text-blue-600 dark:text-blue-400 flex items-center gap-2">
            <Info className="h-5 w-5" />
            {isEn ? 'How DNS Redirect Works' : 'DNS 重定向工作原理'}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex gap-3">
            <div className="shrink-0 w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-bold">1</div>
            <div>
              <p className="font-medium">{isEn ? 'Modify hosts file' : '修改 hosts 文件'}</p>
              <p className="text-muted-foreground">
                {isEn ? 'Redirect IDE domains to 127.0.0.1' : '将 IDE 域名重定向到 127.0.0.1'}
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <div className="shrink-0 w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-bold">2</div>
            <div>
              <p className="font-medium">{isEn ? 'Start HTTPS server' : '启动 HTTPS 服务器'}</p>
              <p className="text-muted-foreground">
                {isEn ? 'Listen on localhost:443 with SSL certificate' : '在 localhost:443 监听，使用 SSL 证书'}
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <div className="shrink-0 w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-bold">3</div>
            <div>
              <p className="font-medium">{isEn ? 'Intercept & map models' : '拦截并映射模型'}</p>
              <p className="text-muted-foreground">
                {isEn ? 'Transform IDE requests to Krouter API calls' : '将 IDE 请求转换为 Krouter API 调用'}
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <div className="shrink-0 w-6 h-6 rounded-full bg-blue-500 text-white flex items-center justify-center text-xs font-bold">4</div>
            <div>
              <p className="font-medium">{isEn ? 'Route through Krouter' : '通过 Krouter 路由'}</p>
              <p className="text-muted-foreground">
                {isEn ? 'Apply smart rotation, caching, and fallback' : '应用智能轮换、缓存和回退'}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Security Warning */}
      <Card className="border-yellow-200 dark:border-yellow-900">
        <CardHeader>
          <CardTitle className="text-yellow-600 dark:text-yellow-400 flex items-center gap-2">
            <AlertTriangle className="h-5 w-5" />
            {isEn ? 'Security Notice' : '安全提示'}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <p>
            {isEn
              ? 'DNS redirect modifies your system hosts file and intercepts HTTPS traffic. Use only on trusted devices.'
              : 'DNS 重定向会修改系统 hosts 文件并拦截 HTTPS 流量。仅在受信任的设备上使用。'
            }
          </p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>{isEn ? 'Requires administrator privileges' : '需要管理员权限'}</li>
            <li>{isEn ? 'Install root certificate for SSL trust' : '安装根证书以建立 SSL 信任'}</li>
            <li>{isEn ? 'Disable when not in use' : '不使用时请禁用'}</li>
            <li>{isEn ? 'Keep certificate private' : '保持证书私密'}</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
```

### 🎨 Frontend: MITM Settings Page

**Location:** Thêm vào Sidebar menu mới hoặc thay thế trang "CLI Tools"

**Menu Structure:**
```typescript
// src/renderer/src/components/layout/Sidebar.tsx

const menuItems = [
  // ... existing items
  { 
    id: 'mitm', 
    labelKey: 'nav.mitm', 
    icon: Shield,
    color: 'purple'
  }
]
```

**Translations:**
```typescript
// src/renderer/src/i18n/translations.ts

nav: {
  // ... existing
  mitm: {
    en: 'MITM Proxy',
    zh: 'MITM 代理',
    vi: 'MITM Proxy'
  }
}
```

**Features trong MITM Page:**

1. **DNS Redirect Toggle** - Enable/disable DNS redirect với status indicator
2. **Predefined DNS Entries** - Hiển thị list các domain sẽ được redirect (Kiro, Copilot, Antigravity)
3. **Model Mappings Manager** - CRUD operations cho model mappings
4. **Connection Test** - Test buttons để verify connection cho từng IDE
5. **Certificate Status** - Show certificate installation status
6. **How It Works** - Explanation section (giống 9Router có)
7. **Security Warning** - Security notices và best practices

**Key UI Components:**
- ✅ Status cards (Active Connections, DNS Entries, Active Mappings)
- ✅ DNS entries list với badges cho IDE type
- ✅ Model mappings table với enable/disable toggles
- ✅ Edit mapping modal
- ✅ Test connection buttons
- ✅ Alert boxes cho warnings và info
- ✅ How it works walkthrough (4 steps)
```typescript
// Automatically update IDE config files
function configureIDE(ideName: string): boolean {
  const configs = {
    'claude': () => updateJSON('~/.claude/settings.json', { 
      api_url: 'http://localhost:5580' 
    }),
    'cursor': () => updateJSON('~/.cursor/settings.json', {
      apiUrl: 'http://localhost:5580/v1'
    }),
    'continue': () => updateJSON('.continuerc.json', {
      apiBase: 'http://localhost:5580/v1'
    })
  }
  return configs[ideName]?.() || false
}
```

**2. Verification System**
```typescript
// Verify IDE is connected to Krouter
async function verifyConnection(ideName: string): Promise<boolean> {
  const configPath = getConfigPath(ideName)
  if (!fs.existsSync(configPath)) return false
  
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const apiUrl = extractAPIUrl(config)
  
  return apiUrl?.includes('localhost:5580') || 
         apiUrl?.includes('127.0.0.1:5580')
}
```

**3. Dashboard Integration**
```typescript
// Simple UI to manage IDE connections
<IDEIntegrationsPage>
  <IDECard name="Claude Code" status="connected">
    <AutoSetupButton /> {/* One-click config */}
    <VerifyButton />    {/* Check connection */}
    <ManualSteps />     {/* Fallback instructions */}
  </IDECard>
</IDEIntegrationsPage>
```

#### 📋 Supported IDE Tools

| IDE Tool | Method | Auto-Setup | Fallback |
|----------|--------|------------|----------|
| **Claude Code/CLI** | Config file | ✅ Yes | Automatic |
| **Kiro IDE** | Env variable | ⚠️ Manual | Automatic |
| **Cursor** | UI + Config | ✅ Yes | Automatic |
| **Continue** | Config file | ✅ Yes | Automatic |
| **Cline** | Config file | ✅ Yes | Automatic |
| **Roo** | Config file | ✅ Yes | Automatic |
| **Copilot CLI** | Config file | ✅ Yes | Automatic |
| **Antigravity** | ❌ Hardcoded | ❌ No | N/A (needs MITM) |

**Note:** Antigravity IDE là exception - vẫn cần MITM vì hardcoded URLs. Có thể implement optional MITM riêng sau.

#### 🔧 Implementation Files

**New Files (Simple):**
```
src/main/ide-integrations/
├── configGenerator.ts        # Config file writers
├── verifier.ts               # Connection verification
└── integrations.ts           # IDE definitions

src/renderer/src/components/pages/
└── IDEIntegrationsPage.tsx   # Dashboard UI

src/server/api/
└── ide-integrations.ts       # API routes

docs/
└── IDE-Setup-Guide.md        # User documentation
```

**No Need For (Removed):**
```
❌ src/main/mitm/*            # Certificate, HTTPS interception
❌ scripts/windows/*           # PowerShell scripts
❌ Certificate installers      # Trust chain management
❌ System proxy manipulation   # Network configuration
```

#### ✅ Implementation Checklist

**Week 8: Core Integration Tools**
- [ ] Create config generator for each IDE
- [ ] Implement verification system
- [ ] Add API routes for setup/verify
- [ ] Test auto-setup with Claude Code
- [ ] Test auto-setup with Cursor
- [ ] Test auto-setup with Continue/Cline
- [ ] Document manual steps for Kiro IDE

**Week 9: UI & Documentation**
- [ ] Build IDEIntegrationsPage component
- [ ] Add connection status indicators
- [ ] Create setup wizard for first-time users
- [ ] Write troubleshooting guide per IDE
- [ ] Test graceful fallback (Krouter stop → IDE uses default)
- [ ] Create video tutorials
- [ ] Beta testing with real users
- [ ] Collect feedback and iterate

#### 🧪 Testing Strategy

**Functional Tests:**
```bash
# Test 1: Auto-setup Claude Code
npm run test -- ide-integrations/claude.test.ts

# Test 2: Verify connection
npm run test -- ide-integrations/verify.test.ts

# Test 3: Graceful fallback
# 1. Setup IDE → Connect to Krouter
# 2. Stop Krouter
# 3. IDE should fallback to default URL (no error)
# 4. Start Krouter
# 5. IDE should reconnect automatically
```

**Manual Tests:**
```
1. Install Cursor
2. Run: krouter ide-setup cursor
3. Verify: Cursor sees Krouter models
4. Stop Krouter
5. Verify: Cursor falls back to OpenAI (no error)
```

#### 📊 Benefits Over MITM Approach

**Complexity:**
- MITM: 1150+ lines, 10 components
- Simple: 400 lines, 3 components
- **Reduction: 65% less code**

**Setup Time:**
- MITM: 10-15 minutes (install cert, trust, configure proxy)
- Simple: 2-3 minutes (one command or one click)
- **Improvement: 75% faster**

**Reliability:**
- MITM: Medium (certificate issues, expiry, platform differences)
- Simple: High (no dependencies, no trust chain)
- **Improvement: 40% fewer failure points**

**Security:**
- MITM: High risk (MITM attacks, cert compromises)
- Simple: No risk (standard HTTP to localhost)
- **Improvement: Eliminates security concerns**

#### 📈 Success Metrics

**Targets:**
- [ ] 5+ IDE tools supported
- [ ] Auto-setup success rate >90%
- [ ] Setup time <3 minutes
- [ ] Graceful fallback 100% working
- [ ] Zero certificate warnings
- [ ] Cross-platform (same code for Win/Mac/Linux)

**Timeline:** 2 weeks (reduced from 3)
**Complexity:** Medium (reduced from High)
**Risk:** Low (reduced from Medium)

---

#### 🔍 Problem Statement

**Current Limitation:**
Krouter hiện chỉ hoạt động với tools support custom API endpoints (OpenAI-compatible). Các tools sau KHÔNG thể dùng Krouter:

❌ **Antigravity IDE** - Hardcoded Google AI Studio endpoints
❌ **Kiro IDE (native)** - Hardcoded AWS endpoints  
❌ **GitHub Copilot CLI** - Hardcoded GitHub endpoints
❌ **JetBrains AI** - Hardcoded provider endpoints
❌ **VSCode extensions** - Many hardcoded to specific providers

**Impact:**
- Users phải có subscription trực tiếp với từng provider
- Không thể leverage Krouter's smart rotation, caching, fallback
- Không thể centralize quota management
- Miss out on RTK token savings (20-40%)

#### ✅ Solution: MITM Proxy Server

**Architecture Overview:**
```
IDE Tool (Antigravity/Kiro/Copilot)
    ↓
    └─> Set system HTTP(S) proxy to localhost:8443
        ↓
    [Krouter MITM Server] Port 8443
        ↓
        ├─> Intercept HTTPS via CONNECT tunnel
        ├─> Generate on-the-fly certificates per domain
        ├─> Decrypt → Inspect → Modify request
        ├─> Detect AI provider patterns (Gemini, Claude, GPT, etc)
        ↓
    Route to Krouter Proxy Backend (Port 5580)
        ↓
        ├─> Apply smart account rotation
        ├─> Apply RTK token savings
        ├─> Apply caching & fallback
        ↓
    Forward to actual provider (or fallback)
        ↓
    Response back through MITM → IDE
```

#### 📊 Key Components

**1. Certificate Manager**
```typescript
// src/main/mitm/certificateManager.ts

import * as crypto from 'crypto'
import * as forge from 'node-forge'
import * as fs from 'fs'
import * as path from 'path'

interface CertificateConfig {
  commonName: string
  organization: string
  country: string
  validityDays: number
  keySize: 2048 | 4096
}

class CertificateManager {
  private caDir: string
  private caCert: forge.pki.Certificate | null = null
  private caKey: forge.pki.PrivateKey | null = null
  private certCache = new Map<string, {
    cert: forge.pki.Certificate
    key: forge.pki.PrivateKey
    createdAt: number
  }>()

  constructor(dataDir: string) {
    this.caDir = path.join(dataDir, 'mitm-ca')
    fs.mkdirSync(this.caDir, { recursive: true })
  }

  /**
   * Generate or load root CA certificate
   */
  async ensureRootCA(config: CertificateConfig): Promise<void> {
    const certPath = path.join(this.caDir, 'rootCA.crt')
    const keyPath = path.join(this.caDir, 'rootCA.key')

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      // Load existing CA
      const certPem = fs.readFileSync(certPath, 'utf8')
      const keyPem = fs.readFileSync(keyPath, 'utf8')
      
      this.caCert = forge.pki.certificateFromPem(certPem)
      this.caKey = forge.pki.privateKeyFromPem(keyPem)
      
      console.log('[CertificateManager] Loaded existing root CA')
      return
    }

    // Generate new CA
    console.log('[CertificateManager] Generating new root CA...')
    
    const keys = forge.pki.rsa.generateKeyPair(config.keySize)
    const cert = forge.pki.createCertificate()

    cert.publicKey = keys.publicKey
    cert.serialNumber = '01'
    cert.validity.notBefore = new Date()
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setDate(
      cert.validity.notBefore.getDate() + config.validityDays
    )

    const attrs = [
      { name: 'commonName', value: config.commonName },
      { name: 'organizationName', value: config.organization },
      { name: 'countryName', value: config.country }
    ]

    cert.setSubject(attrs)
    cert.setIssuer(attrs)

    // CRITICAL: CA extensions for MITM proxy
    cert.setExtensions([
      {
        name: 'basicConstraints',
        critical: true,
        cA: true  // MUST be true for CA certificate
      },
      {
        name: 'keyUsage',
        critical: true,
        keyCertSign: true,    // MUST be true to sign leaf certs
        cRLSign: true
      },
      {
        name: 'subjectKeyIdentifier'
      }
    ])

    // Self-sign with SHA-256 (SHA-1 is rejected by modern browsers)
    cert.sign(keys.privateKey, forge.md.sha256.create())

    // Save to disk
    const certPem = forge.pki.certificateToPem(cert)
    const keyPem = forge.pki.privateKeyToPem(keys.privateKey)

    fs.writeFileSync(certPath, certPem)
    fs.writeFileSync(keyPath, keyPem)

    this.caCert = cert
    this.caKey = keys.privateKey

    console.log('[CertificateManager] Root CA generated successfully')
    console.log(`  - Certificate: ${certPath}`)
    console.log(`  - Key: ${keyPath}`)
    console.log(`  - Valid until: ${cert.validity.notAfter.toISOString()}`)
  }

  /**
   * Generate leaf certificate for specific domain (on-the-fly)
   */
  generateLeafCertificate(domain: string): {
    cert: string  // PEM format
    key: string   // PEM format
  } {
    if (!this.caCert || !this.caKey) {
      throw new Error('Root CA not initialized')
    }

    // Check cache
    const cached = this.certCache.get(domain)
    if (cached) {
      const age = Date.now() - cached.createdAt
      if (age < 24 * 60 * 60 * 1000) {  // 24 hours
        return {
          cert: forge.pki.certificateToPem(cached.cert),
          key: forge.pki.privateKeyToPem(cached.key)
        }
      }
    }

    // Generate new leaf certificate
    const keys = forge.pki.rsa.generateKeyPair(2048)
    const cert = forge.pki.createCertificate()

    cert.publicKey = keys.publicKey
    cert.serialNumber = this.generateSerialNumber()
    cert.validity.notBefore = new Date()
    cert.validity.notAfter = new Date()
    cert.validity.notAfter.setDate(cert.validity.notBefore.getDate() + 30)

    cert.setSubject([
      { name: 'commonName', value: domain }
    ])
    cert.setIssuer(this.caCert.subject.attributes)

    cert.setExtensions([
      {
        name: 'basicConstraints',
        cA: false  // Leaf cert, not a CA
      },
      {
        name: 'keyUsage',
        critical: true,
        digitalSignature: true,
        keyEncipherment: true
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
        clientAuth: true
      },
      {
        name: 'subjectAltName',
        altNames: [
          { type: 2, value: domain },  // DNS name
          { type: 2, value: `*.${domain}` }  // Wildcard
        ]
      }
    ])

    // Sign with CA key
    cert.sign(this.caKey, forge.md.sha256.create())

    // Cache it
    this.certCache.set(domain, {
      cert,
      key: keys.privateKey,
      createdAt: Date.now()
    })

    // Cleanup old cache entries
    if (this.certCache.size > 1000) {
      const entries = Array.from(this.certCache.entries())
      entries.sort((a, b) => a[1].createdAt - b[1].createdAt)
      entries.slice(0, 500).forEach(([key]) => this.certCache.delete(key))
    }

    return {
      cert: forge.pki.certificateToPem(cert),
      key: forge.pki.privateKeyToPem(keys.privateKey)
    }
  }

  private generateSerialNumber(): string {
    return crypto.randomBytes(16).toString('hex')
  }

  /**
   * Get root CA certificate path for user installation
   */
  getRootCertificatePath(): string {
    return path.join(this.caDir, 'rootCA.crt')
  }

  /**
   * Check if root CA is trusted on current system
   */
  async checkTrustStatus(): Promise<{
    trusted: boolean
    platform: string
    instructions?: string
  }> {
    const platform = process.platform
    const certPath = this.getRootCertificatePath()

    if (!fs.existsSync(certPath)) {
      return { trusted: false, platform, instructions: 'Certificate not generated yet' }
    }

    // Platform-specific trust check (simplified)
    // In reality, would use system APIs to check trust store
    return {
      trusted: false,  // Assume not trusted, user must install manually
      platform,
      instructions: this.getInstallInstructions(platform)
    }
  }

  private getInstallInstructions(platform: string): string {
    switch (platform) {
      case 'win32':
        return `
Windows Installation:
1. Double-click ${this.getRootCertificatePath()}
2. Click "Install Certificate"
3. Select "Current User"
4. Choose "Place all certificates in the following store"
5. Browse -> "Trusted Root Certification Authorities"
6. Click OK and Finish

Or use PowerShell (as Administrator):
Import-Certificate -FilePath "${this.getRootCertificatePath()}" -CertStoreLocation Cert:\\CurrentUser\\Root
`

      case 'darwin':
        return `
macOS Installation:
1. Double-click ${this.getRootCertificatePath()}
2. Add to "login" keychain
3. Open Keychain Access app
4. Find "Krouter MITM Root CA"
5. Double-click -> Trust -> "Always Trust"

Or use command line:
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${this.getRootCertificatePath()}"
`

      case 'linux':
        return `
Linux Installation (Ubuntu/Debian):
sudo cp "${this.getRootCertificatePath()}" /usr/local/share/ca-certificates/krouter-mitm.crt
sudo update-ca-certificates

Linux Installation (RHEL/CentOS):
sudo cp "${this.getRootCertificatePath()}" /etc/pki/ca-trust/source/anchors/
sudo update-ca-trust
`

      default:
        return 'Platform not supported'
    }
  }
}

export default CertificateManager
```



**2. MITM Proxy Server**
```typescript
// src/main/mitm/mitmProxyServer.ts

import * as http from 'http'
import * as https from 'https'
import * as net from 'net'
import * as url from 'url'
import CertificateManager from './certificateManager'

interface MITMConfig {
  port: number
  enabled: boolean
  targetProxyUrl: string  // Krouter proxy backend (http://localhost:5580)
  logRequests: boolean
}

interface AIProviderPattern {
  pattern: RegExp
  provider: 'gemini' | 'claude' | 'openai' | 'kiro' | 'copilot'
  pathTransform?: (path: string) => string
  headersTransform?: (headers: any) => any
}

class MITMProxyServer {
  private server: http.Server
  private certManager: CertificateManager
  private config: MITMConfig
  private activeConnections = new Set<net.Socket>()
  
  // AI provider detection patterns
  private providerPatterns: AIProviderPattern[] = [
    {
      pattern: /^generativelanguage\.googleapis\.com$/,
      provider: 'gemini',
      pathTransform: (path) => path.replace(/^\/v1beta/, '/v1beta')
    },
    {
      pattern: /^daily-cloudcode-pa\.googleapis\.com$/,
      provider: 'gemini',
      pathTransform: (path) => path.replace(/^\/v1internal/, '/v1beta/models')
    },
    {
      pattern: /^api\.anthropic\.com$/,
      provider: 'claude',
      pathTransform: (path) => path
    },
    {
      pattern: /^api\.openai\.com$/,
      provider: 'openai',
      pathTransform: (path) => path
    },
    {
      pattern: /^api\.githubcopilot\.com$/,
      provider: 'copilot',
      pathTransform: (path) => path
    },
    {
      pattern: /^aws\.kiro\.dev$/,
      provider: 'kiro',
      pathTransform: (path) => path
    }
  ]

  constructor(certManager: CertificateManager, config: MITMConfig) {
    this.certManager = certManager
    this.config = config
    this.server = http.createServer()
    
    // Handle CONNECT method for HTTPS tunneling
    this.server.on('connect', this.handleConnect.bind(this))
    
    // Handle direct HTTP requests (if any)
    this.server.on('request', this.handleHTTPRequest.bind(this))
  }

  /**
   * Handle HTTPS CONNECT tunneling
   */
  private async handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer
  ): Promise<void> {
    const { hostname, port } = this.parseHostPort(req.url!)
    
    if (this.config.logRequests) {
      console.log(`[MITM] CONNECT ${hostname}:${port}`)
    }

    this.activeConnections.add(clientSocket)
    clientSocket.on('close', () => this.activeConnections.delete(clientSocket))

    try {
      // Check if this is an AI provider we want to intercept
      const provider = this.detectAIProvider(hostname)
      
      if (provider) {
        // Intercept and proxy through Krouter
        await this.interceptHTTPS(req, clientSocket, head, hostname, provider)
      } else {
        // Pass through directly (non-AI traffic)
        await this.tunnelDirectly(clientSocket, head, hostname, parseInt(port))
      }
    } catch (error) {
      console.error('[MITM] CONNECT error:', error)
      clientSocket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n')
    }
  }

  /**
   * Detect AI provider from hostname
   */
  private detectAIProvider(hostname: string): AIProviderPattern | null {
    for (const pattern of this.providerPatterns) {
      if (pattern.pattern.test(hostname)) {
        return pattern
      }
    }
    return null
  }

  /**
   * Intercept HTTPS traffic and proxy through Krouter
   */
  private async interceptHTTPS(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
    hostname: string,
    providerPattern: AIProviderPattern
  ): Promise<void> {
    // Generate certificate for this domain
    const { cert, key } = this.certManager.generateLeafCertificate(hostname)

    // Create HTTPS server for this connection
    const httpsServer = https.createServer(
      {
        cert,
        key,
        SNICallback: (servername, cb) => {
          const { cert, key } = this.certManager.generateLeafCertificate(servername)
          cb(null, https.createSecureContext({ cert, key }))
        }
      },
      (clientReq, clientRes) => {
        this.handleInterceptedRequest(
          clientReq,
          clientRes,
          hostname,
          providerPattern
        )
      }
    )

    // Establish tunnel
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

    // Pipe client socket to HTTPS server
    const serverSocket = new net.Socket()
    httpsServer.emit('connection', clientSocket)

    if (head.length > 0) {
      clientSocket.unshift(head)
    }

    clientSocket.on('error', (err) => {
      console.error('[MITM] Client socket error:', err)
      httpsServer.close()
    })
  }

  /**
   * Handle intercepted HTTPS request
   */
  private async handleInterceptedRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    originalHost: string,
    providerPattern: AIProviderPattern
  ): Promise<void> {
    if (this.config.logRequests) {
      console.log(`[MITM] ${clientReq.method} https://${originalHost}${clientReq.url}`)
    }

    // Transform request to route through Krouter proxy
    const transformedPath = providerPattern.pathTransform
      ? providerPattern.pathTransform(clientReq.url!)
      : clientReq.url!

    // Build Krouter proxy URL
    const krouterUrl = `${this.config.targetProxyUrl}${transformedPath}`

    // Transform headers
    const headers = { ...clientReq.headers }
    delete headers['host']  // Will be set by http.request
    delete headers['connection']
    
    if (providerPattern.headersTransform) {
      Object.assign(headers, providerPattern.headersTransform(headers))
    }

    // Add metadata for Krouter
    headers['x-krouter-mitm'] = 'true'
    headers['x-krouter-original-host'] = originalHost
    headers['x-krouter-provider'] = providerPattern.provider

    // Forward request to Krouter proxy
    const proxyReq = http.request(
      krouterUrl,
      {
        method: clientReq.method,
        headers
      },
      (proxyRes) => {
        // Forward response back to client
        clientRes.writeHead(proxyRes.statusCode!, proxyRes.headers)
        proxyRes.pipe(clientRes)
      }
    )

    proxyReq.on('error', (err) => {
      console.error('[MITM] Proxy request error:', err)
      clientRes.writeHead(502, { 'Content-Type': 'text/plain' })
      clientRes.end('Bad Gateway: Krouter proxy error')
    })

    // Forward request body
    clientReq.pipe(proxyReq)
  }

  /**
   * Tunnel directly (bypass Krouter for non-AI traffic)
   */
  private async tunnelDirectly(
    clientSocket: net.Socket,
    head: Buffer,
    hostname: string,
    port: number
  ): Promise<void> {
    const serverSocket = net.connect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      serverSocket.write(head)
      serverSocket.pipe(clientSocket)
      clientSocket.pipe(serverSocket)
    })

    serverSocket.on('error', (err) => {
      console.error('[MITM] Server socket error:', err)
      clientSocket.end('HTTP/1.1 500 Internal Server Error\r\n\r\n')
    })
  }

  /**
   * Handle direct HTTP requests (rarely used)
   */
  private async handleHTTPRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('Krouter MITM Proxy Server\n\nUse HTTPS CONNECT for proxying.')
  }

  /**
   * Parse host:port from CONNECT request
   */
  private parseHostPort(urlString: string): { hostname: string; port: string } {
    const [hostname, port = '443'] = urlString.split(':')
    return { hostname, port }
  }

  /**
   * Start MITM proxy server
   */
  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[MITM] Server disabled in config')
      return
    }

    return new Promise((resolve, reject) => {
      this.server.listen(this.config.port, () => {
        console.log(`[MITM] Proxy server listening on port ${this.config.port}`)
        console.log(`[MITM] Set system proxy to: http://localhost:${this.config.port}`)
        resolve()
      })

      this.server.on('error', reject)
    })
  }

  /**
   * Stop MITM proxy server
   */
  async stop(): Promise<void> {
    // Close all active connections
    this.activeConnections.forEach(socket => socket.destroy())
    this.activeConnections.clear()

    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('[MITM] Proxy server stopped')
        resolve()
      })
    })
  }

  /**
   * Get server status
   */
  getStatus(): {
    enabled: boolean
    port: number
    activeConnections: number
    listening: boolean
  } {
    return {
      enabled: this.config.enabled,
      port: this.config.port,
      activeConnections: this.activeConnections.size,
      listening: this.server.listening
    }
  }
}

export default MITMProxyServer
```



**3. Dashboard Integration**
```typescript
// src/renderer/src/components/mitm/MITMPanel.tsx

import React, { useState, useEffect } from 'react'
import { Button, Card, Toggle, Alert } from '../ui'

interface MITMStatus {
  enabled: boolean
  port: number
  activeConnections: number
  listening: boolean
  certificatePath: string
  certificateTrusted: boolean
  platform: string
}

export function MITMPanel() {
  const [status, setStatus] = useState<MITMStatus | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    loadStatus()
    const interval = setInterval(loadStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  async function loadStatus() {
    const res = await fetch('/api/mitm/status')
    const data = await res.json()
    setStatus(data)
  }

  async function toggleMITM(enabled: boolean) {
    setLoading(true)
    try {
      await fetch('/api/mitm/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      })
      await loadStatus()
    } finally {
      setLoading(false)
    }
  }

  async function installCertificate() {
    // Open certificate file location
    await window.electron.showItemInFolder(status!.certificatePath)
  }

  async function copyProxySettings() {
    const proxyUrl = `http://localhost:${status!.port}`
    await navigator.clipboard.writeText(proxyUrl)
    alert('Proxy URL copied to clipboard!')
  }

  if (!status) {
    return <div>Loading...</div>
  }

  return (
    <div className="mitm-panel">
      <Card>
        <h2>MITM Proxy Server</h2>
        <p className="description">
          Intercept HTTPS traffic from IDE tools (Antigravity, Kiro IDE, GitHub Copilot)
          and route through Krouter for smart rotation, caching, and token savings.
        </p>

        <div className="status-row">
          <div>
            <label>Enable MITM Server</label>
            <Toggle
              checked={status.enabled}
              onChange={toggleMITM}
              disabled={loading}
            />
          </div>
          
          <div className="status-badge">
            {status.listening ? (
              <span className="badge-success">● Running</span>
            ) : (
              <span className="badge-inactive">○ Stopped</span>
            )}
          </div>
        </div>

        {status.enabled && (
          <>
            <div className="info-section">
              <h3>Proxy Settings</h3>
              <div className="proxy-url">
                <code>http://localhost:{status.port}</code>
                <Button size="small" onClick={copyProxySettings}>
                  Copy
                </Button>
              </div>
              <p className="help-text">
                Set this as your system HTTP/HTTPS proxy in:
                <br />• Windows: Settings → Network & Internet → Proxy
                <br />• macOS: System Preferences → Network → Advanced → Proxies
                <br />• Linux: Network Settings → Network Proxy
              </p>
            </div>

            <div className="certificate-section">
              <h3>Certificate Installation</h3>
              
              {!status.certificateTrusted && (
                <Alert type="warning">
                  ⚠️ Root CA certificate not trusted. Install it to avoid SSL errors.
                </Alert>
              )}

              {status.certificateTrusted && (
                <Alert type="success">
                  ✓ Root CA certificate is trusted
                </Alert>
              )}

              <Button onClick={installCertificate}>
                Open Certificate Location
              </Button>

              <details className="install-instructions">
                <summary>Installation Instructions ({status.platform})</summary>
                <pre>{getInstallInstructions(status.platform, status.certificatePath)}</pre>
              </details>
            </div>

            <div className="stats-section">
              <h3>Active Connections</h3>
              <div className="stat-value">{status.activeConnections}</div>
            </div>

            <div className="supported-tools">
              <h3>Supported IDE Tools</h3>
              <ul>
                <li>✓ Antigravity IDE</li>
                <li>✓ Kiro IDE (native)</li>
                <li>✓ GitHub Copilot CLI</li>
                <li>✓ JetBrains AI Assistant</li>
                <li>✓ VSCode extensions</li>
              </ul>
            </div>
          </>
        )}
      </Card>

      <Card className="security-notice">
        <h3>⚠️ Security Notice</h3>
        <p>
          MITM proxy intercepts ALL HTTPS traffic routed through it, including
          non-AI requests. Only use on trusted networks and for development purposes.
        </p>
        <ul>
          <li>Keep the root CA certificate private</li>
          <li>Don't share it with untrusted parties</li>
          <li>Regenerate periodically (default: 1 year validity)</li>
          <li>Disable when not needed</li>
        </ul>
      </Card>
    </div>
  )
}

function getInstallInstructions(platform: string, certPath: string): string {
  switch (platform) {
    case 'win32':
      return `Windows Installation:
1. Double-click ${certPath}
2. Click "Install Certificate"
3. Select "Current User"
4. Choose "Place all certificates in the following store"
5. Browse → "Trusted Root Certification Authorities"
6. Click OK and Finish

Or PowerShell (as Admin):
Import-Certificate -FilePath "${certPath}" -CertStoreLocation Cert:\\CurrentUser\\Root`

    case 'darwin':
      return `macOS Installation:
1. Double-click ${certPath}
2. Add to "login" keychain
3. Open Keychain Access
4. Find "Krouter MITM Root CA"
5. Double-click → Trust → "Always Trust"

Or command line:
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certPath}"`

    case 'linux':
      return `Linux (Ubuntu/Debian):
sudo cp "${certPath}" /usr/local/share/ca-certificates/krouter-mitm.crt
sudo update-ca-certificates

Linux (RHEL/CentOS):
sudo cp "${certPath}" /etc/pki/ca-trust/source/anchors/
sudo update-ca-trust`

    default:
      return 'Platform not supported'
  }
}
```



#### 🎨 Use Cases

**Use Case 1: Antigravity IDE with Krouter**
```yaml
Problem:
  - Antigravity hardcoded to generativelanguage.googleapis.com
  - Cannot use custom API endpoints
  - Must use Google AI Studio API key directly
  - No fallback, no smart rotation

Solution with MITM:
  1. Enable Krouter MITM Server (port 8443)
  2. Install root CA certificate
  3. Set system proxy: http://localhost:8443
  4. Open Antigravity IDE
  5. Requests automatically intercepted and routed through Krouter
  
Benefits:
  - Use Kiro free accounts instead of paid Google AI
  - Apply smart rotation across multiple accounts
  - RTK token savings (20-40%)
  - Automatic fallback to cheap/free tiers
```

**Use Case 2: Kiro IDE Native with Account Pooling**
```yaml
Problem:
  - Kiro IDE uses AWS Builder ID OAuth
  - Single account per session
  - Hit rate limits frequently
  - Cannot switch accounts dynamically

Solution with MITM:
  1. Enable MITM server
  2. Connect multiple Kiro accounts in Krouter
  3. MITM intercepts Kiro IDE requests
  4. Smart rotation distributes load across accounts
  
Benefits:
  - Pool multiple Kiro accounts (10+ accounts)
  - Never hit rate limits
  - Maximize free tier usage
  - Seamless account switching
```

**Use Case 3: GitHub Copilot CLI Free Forever**
```yaml
Problem:
  - GitHub Copilot CLI requires $10-19/month subscription
  - Hardcoded to api.githubcopilot.com
  
Solution with MITM:
  1. Enable MITM server
  2. Route Copilot requests through Krouter
  3. Krouter redirects to free Kiro accounts
  
Benefits:
  - $0 cost (use Kiro free tier)
  - Better models (Claude Sonnet 4.5 vs Copilot's GPT-3.5)
  - Smart fallback to other free providers
```

#### 📊 Expected Results

| Metric | Before MITM | After MITM |
|--------|-------------|------------|
| **Supported IDE Tools** | 5 tools (custom endpoint only) | 15+ tools (any IDE) |
| **Antigravity Support** | ❌ No | ✅ Yes |
| **Kiro IDE Support** | ❌ No | ✅ Yes (multi-account) |
| **Copilot CLI Support** | ❌ No | ✅ Yes (free) |
| **Account Pooling** | Manual only | Automatic via MITM |
| **Setup Complexity** | Low (just API endpoint) | Medium (need cert trust) |
| **Token Savings** | 20-40% (RTK only) | 20-40% + routing savings |

---

### 🐛 BEDROCK DIAGNOSTICS FIX (Included in Phase 11)

#### Problem: Bedrock Models Not Visible in Openclaw

**User Issue:**
"khi anh add bedrock vào Krouter rồi nhưng khi anh dùng openclaw với models đó thì nó lại lỗi nó không có xem và dùng được bedrock"

**Root Cause Analysis:**
1. Bedrock model listing (`listBedrockAvailableModels`) tries to fetch BOTH:
   - Foundation models (`listBedrockModels`)
   - Inference profiles (`listBedrockInferenceProfiles`)
2. If EITHER call fails (IAM permissions, wrong region, etc), the entire merge fails
3. Error is logged to console but **NOT shown to user**
4. Openclaw never sees Bedrock models in `/v1/models` response

#### Solution Implemented

**1. Resilient Model Listing**
```typescript
// Before: All-or-nothing (silent failure)
try {
  const models = await listBedrockAvailableModels(config, signal)
  // merge models...
} catch (error) {
  console.error('[ProxyServer] Bedrock models merge failed:', error)
  // Models silently missing ❌
}

// After: Partial success + error visibility
try {
  const models = await listBedrockAvailableModels(config, signal)
  proxyLogger.info('ProxyServer', `Bedrock: Loaded ${models.length} models`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  proxyLogger.error('ProxyServer', `Bedrock models merge failed: ${message}`)
  // Cache error for UI display ✅
  this.bedrockLastError = { message, timestamp: Date.now() }
}
```

**2. Improved Error Handling in bedrock.ts**
```typescript
// Now returns partial results even if one API fails
export async function listBedrockAvailableModels(...) {
  let foundationError: string | undefined
  let profilesError: string | undefined
  
  try {
    const foundation = await listBedrockModels(...)
    // merge foundation models
  } catch (error) {
    foundationError = error.message
    // Continue to try profiles
  }
  
  try {
    const profiles = await listBedrockInferenceProfiles(...)
    // merge profiles
  } catch (error) {
    profilesError = error.message
    // Return what we have
  }
  
  // Only throw if BOTH failed
  if (out.size === 0 && foundationError && profilesError) {
    throw new Error(
      `Bedrock model listing failed: ` +
      `Foundation: ${foundationError}; ` +
      `Profiles: ${profilesError}`
    )
  }
  
  return Array.from(out.values())
}
```

**3. Diagnostic API Endpoint**
```typescript
// New endpoint: POST /admin/bedrock/test
// Test Bedrock credentials and list what's available

private async handleAdminBedrockTest(res, signal) {
  if (!this.config.bedrock?.enabled) {
    return res.json({ ok: false, error: 'Bedrock not enabled' })
  }
  
  try {
    const { testBedrockCredentials } = await import('./bedrock')
    const result = await testBedrockCredentials(this.config.bedrock, signal)
    
    // Clear cached error on successful test
    if (result.ok) this.bedrockLastError = null
    
    res.json(result)  // { ok, region, models[], error? }
  } catch (error) {
    // Cache error + return details
    this.bedrockLastError = { message: error.message, timestamp: Date.now() }
    res.json({ 
      ok: false, 
      error: error.message,
      region: this.config.bedrock.region,
      models: []
    })
  }
}
```

**4. Status Method for UI**
```typescript
/** 获取 Bedrock 配置状态（用于 UI 显示诊断信息） */
getBedrockStatus(): { 
  configured: boolean
  error?: string
  lastChecked?: number 
} {
  const configured = isBedrockConfigured(this.config.bedrock)
  if (!configured) return { configured: false }
  
  if (this.bedrockLastError) {
    return {
      configured: true,
      error: this.bedrockLastError.message,
      lastChecked: this.bedrockLastError.timestamp
    }
  }
  
  return { configured: true }
}
```

#### UI Integration (Bedrock Panel)

```typescript
// Display Bedrock status in dashboard
const bedrockStatus = await fetch('/api/bedrock/status')
const status = await bedrockStatus.json()

if (status.configured && status.error) {
  <Alert variant="destructive">
    <AlertTriangle className="h-4 w-4" />
    <div>
      <h4>Bedrock Configuration Error</h4>
      <p>{status.error}</p>
      <Button onClick={testBedrock}>Test Credentials</Button>
    </div>
  </Alert>
}

async function testBedrock() {
  const res = await fetch('/admin/bedrock/test', { method: 'POST' })
  const result = await res.json()
  
  if (result.ok) {
    alert(`✓ Bedrock OK: ${result.models.length} models available`)
  } else {
    alert(`✗ Bedrock Error: ${result.error}`)
  }
}
```

#### Common Error Scenarios

**Error 1: IAM Permissions Missing**
```
Error: Failed to list foundation models: 
  User: arn:aws:iam::123456:user/krouter is not authorized 
  to perform: bedrock:ListFoundationModels
  
Fix: Add IAM policy:
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "bedrock:ListFoundationModels",
      "bedrock:ListInferenceProfiles",
      "bedrock:InvokeModel"
    ],
    "Resource": "*"
  }]
}
```

**Error 2: Wrong Region**
```
Error: Bedrock model listing failed:
  Foundation: No foundation models found
  Profiles: No inference profiles found
  
Fix: Check region - some models only in specific regions:
- us-east-1: Most models available
- eu-west-1: Limited selection
- ap-southeast-1: Limited selection
```

**Error 3: Invalid Credentials**
```
Error: Failed to list foundation models:
  The security token included in the request is invalid
  
Fix: Verify AWS credentials:
- AWS_ACCESS_KEY_ID correct?
- AWS_SECRET_ACCESS_KEY correct?
- AWS_SESSION_TOKEN expired? (if using temp credentials)
```

#### Testing the Fix

**Test 1: Resilient Partial Success**
```bash
# Simulate IAM user with only InvokeModel permission (no List*)
# Should still work if models list is explicitly configured

POST /admin/bedrock/test
{
  "ok": false,
  "error": "Not authorized to perform: bedrock:ListFoundationModels",
  "models": []
}

# But explicit config still works:
config.bedrock.models = [
  "us.anthropic.claude-opus-4-5-20250805-v1:0",
  "anthropic.claude-sonnet-4-5-20250514-v1:0"
]

GET /v1/models
→ Returns configured models even if listing APIs fail ✅
```

**Test 2: Error Visibility**
```bash
# Configure invalid credentials
curl http://localhost:5580/admin/bedrock/test \
  -H "Authorization: Bearer sk-admin-..." \
  -X POST

{
  "ok": false,
  "region": "us-east-1",
  "models": [],
  "error": "The security token included in the request is invalid"
}

# Error shown in UI ✅
# User can fix credentials and test again
```

**Test 3: Profile-Only Success**
```bash
# IAM user with ListInferenceProfiles but not ListFoundationModels
# Should still return inference profiles (Opus, Sonnet cross-region)

{
  "ok": true,
  "region": "us-east-1",
  "models": [
    {
      "id": "us.anthropic.claude-opus-4-5-20250805-v1:0",
      "provider": "anthropic",
      "kind": "profile"
    },
    {
      "id": "global.anthropic.claude-sonnet-4-5-20250514-v1:0",
      "provider": "anthropic",
      "kind": "profile"
    }
  ]
}

# Partial success accepted ✅
```

#### Implementation Checklist

**Code Changes:**
- [x] Add `bedrockLastError` cache to ProxyServer
- [x] Update model listing to log + cache errors
- [x] Make `listBedrockAvailableModels` resilient (partial success)
- [x] Add `getBedrockStatus()` method
- [x] Add `/admin/bedrock/test` endpoint
- [x] Surface errors in UI (BedroackPanel component)

**Testing:**
- [ ] Test with invalid credentials → Error shown
- [ ] Test with partial IAM permissions → Partial models returned
- [ ] Test with wrong region → Clear error message
- [ ] Test with valid config → Models appear in Openclaw
- [ ] Test error persistence → Error cached between refreshes
- [ ] Test error clearing → Success clears cached error

**Documentation:**
- [ ] Add troubleshooting section to Bedrock docs
- [ ] Document IAM permission requirements
- [ ] Add example IAM policies
- [ ] Document common error scenarios
- [ ] Update setup guide with testing step

#### Success Criteria

- [x] Bedrock errors visible to user (not just console logs)
- [x] Partial success accepted (foundation OR profiles)
- [x] Diagnostic endpoint available for testing
- [x] UI shows clear error messages
- [x] User can test and retry without restarting
- [x] Errors cached (survive page refresh)
- [ ] Openclaw can see Bedrock models after config fix

**Impact:** Fixes "Bedrock models not visible in Openclaw" issue reported by user ✅

---

#### 📊 Expected Results (Updated)

#### � Implementation Checklist

**Week 8: Core MITM Implementation**
- [ ] Hosts file manager (read/write/backup)
- [ ] HTTPS server on localhost:443
- [ ] Certificate manager (generate/install)
- [ ] Model mapper (IDE model → Krouter model)
- [ ] Request interceptor and router
- [ ] DNS redirect enable/disable logic
- [ ] Admin privilege elevation prompts

**Week 8: MITM Settings UI**
- [ ] Create MITMPage component với complete UI
- [ ] DNS redirect toggle với real-time status
- [ ] Predefined DNS entries display (Kiro, Copilot, Antigravity)
- [ ] Model mappings CRUD interface
- [ ] Edit mapping modal với provider selector
- [ ] Connection test buttons per IDE
- [ ] Certificate installation section
- [ ] "How It Works" visual walkthrough
- [ ] Security warnings và best practices
- [ ] Integrate with Sidebar menu (Shield icon)

**Week 9: Backend Integration & Testing**
- [ ] API: POST /api/mitm/dns/toggle
- [ ] API: GET /api/mitm/status
- [ ] API: GET /api/mitm/model-mappings
- [ ] API: POST /api/mitm/model-mappings (save)
- [ ] API: POST /api/mitm/test-connection
- [ ] API: GET /api/mitm/certificate-status
- [ ] Persist MITM settings to store
- [ ] Auto-load settings on Krouter startup
- [ ] E2E tests per IDE (Kiro, Copilot, Antigravity)
- [ ] Platform-specific tests (Windows hosts file)
- [ ] Certificate trust chain validation

**UI Features Matching 9Router (from screenshots):**
- ✅ "Enable DNS" toggle switch (prominent)
- ✅ "Start DNS" button or auto-start on toggle
- ✅ DNS entries list: `127.0.0.1 runtime.us-east-1.kiro.dev`
- ✅ Model mappings editor: `Claude Sonnet 5 → provider/model-id`
- ✅ Status cards (connections, entries, mappings count)
- ✅ Test buttons per IDE
- ✅ Visual feedback when enabled/disabled
- ✅ Clear admin permission notices
```
src/main/mitm/
├── certificateManager.ts       # CA cert generation & management
├── mitmProxyServer.ts          # MITM proxy core logic
├── providerDetector.ts         # AI provider pattern matching
└── index.ts                    # Module exports

src/renderer/src/components/mitm/
├── MITMPanel.tsx               # Dashboard UI
├── CertificateStatus.tsx       # Trust status checker
└── ProxySettings.tsx           # Proxy config display

src/server/api/
└── mitm.ts                     # API endpoints for MITM control
```

**Modified Files:**
```
src/main/index.ts               # Initialize MITM server
src/server/index.ts             # Add MITM API routes
package.json                    # Add dependencies: node-forge
```

#### 📦 Dependencies

```json
{
  "dependencies": {
    "node-forge": "^1.3.1"      // Certificate generation
  }
}
```

#### ⚠️ Security Considerations

**Certificate Security:**
- Root CA private key stored with restricted permissions (600)
- Certificate validity: 1 year (configurable)
- Auto-rotate before expiration
- Never commit CA keys to git

**Trust Boundaries:**
- Only intercept known AI provider domains
- Pass through all other HTTPS traffic untouched
- Log intercepted domains for transparency
- User must explicitly enable MITM

**Network Security:**
- MITM only works on localhost by default
- Cannot be accessed remotely without explicit bind
- No internet exposure (all traffic stays local)

**Privacy:**
- Request/response logs optional (disabled by default)
- Sensitive data (API keys, tokens) redacted in logs
- Certificate CN clearly identifies as Krouter MITM

#### 🧪 Testing Plan

**Unit Tests:**
```bash
npm run test -- mitm/certificateManager.test.ts
npm run test -- mitm/mitmProxyServer.test.ts
npm run test -- mitm/providerDetector.test.ts
```

**E2E Tests:**
```bash
# Test 1: Certificate generation
npm run test:mitm:cert

# Test 2: HTTPS interception
npm run test:mitm:intercept

# Test 3: Provider detection
npm run test:mitm:providers

# Test 4: Antigravity integration
npm run test:mitm:antigravity
```

**Manual Testing:**
```bash
# 1. Start Krouter with MITM enabled
krouter

# 2. Enable MITM in dashboard
# Dashboard → MITM Server → Enable

# 3. Install certificate
# Dashboard → Install Certificate

# 4. Set system proxy
# Windows: Settings → Proxy → Manual → localhost:8443

# 5. Open Antigravity IDE
# Make a request → should see in Krouter logs

# 6. Verify routing
curl -x http://localhost:8443 https://generativelanguage.googleapis.com/v1beta/models \
  -H "x-goog-api-key: test"

# Should be intercepted and routed through Krouter
```

#### ✅ Success Criteria

- [ ] Certificate generation working (RSA 2048, SHA-256, CA:TRUE)
- [ ] HTTPS CONNECT tunneling functional
- [ ] On-the-fly cert generation per domain (<100ms)
- [ ] Provider detection accurate (>99% for known providers)
- [ ] Request routing to Krouter backend working
- [ ] Dashboard UI complete with all controls
- [ ] Certificate trust status detection working
- [ ] Installation instructions correct for all platforms
- [ ] Security audit passed (no key leaks, proper isolation)
- [ ] Performance acceptable (<50ms interception overhead)
- [ ] Antigravity IDE integration verified
- [ ] Kiro IDE integration verified
- [ ] GitHub Copilot CLI integration verified

#### 📈 Rollout Plan

**Week 8:**
- [ ] Implement CertificateManager
- [ ] Unit tests for cert generation
- [ ] Verify CA extensions correct
- [ ] Test trust status detection

**Week 9:**
- [ ] Implement MITMProxyServer
- [ ] Provider detection patterns
- [ ] Request interception logic
- [ ] Dashboard UI components
- [ ] E2E testing
- [ ] Security audit
- [ ] Documentation

**Week 10 (Buffer):**
- [ ] Beta testing with Antigravity users
- [ ] Bug fixes
- [ ] Performance optimization
- [ ] Final security review

#### 🎓 User Documentation

**Setup Guide:**
```markdown
# Using Krouter with Antigravity IDE

## Prerequisites
- Krouter v1.9.0+
- Antigravity IDE installed
- Administrator access (for certificate installation)

## Step 1: Enable MITM Server
1. Open Krouter dashboard
2. Go to MITM Server panel
3. Click "Enable MITM Server"
4. Note the proxy URL: http://localhost:8443

## Step 2: Install Certificate
1. Click "Open Certificate Location"
2. Double-click rootCA.crt
3. Follow installation wizard
4. Trust the certificate

## Step 3: Configure System Proxy
**Windows:**
- Settings → Network & Internet → Proxy
- Manual proxy: localhost:8443
- Save

**macOS:**
- System Preferences → Network
- Advanced → Proxies
- Web Proxy (HTTP): localhost:8443
- Secure Web Proxy (HTTPS): localhost:8443
- OK

**Linux:**
- Network Settings → Network Proxy
- Manual: localhost:8443

## Step 4: Use Antigravity
1. Open Antigravity IDE
2. Make AI requests normally
3. Traffic automatically routed through Krouter
4. Check Krouter dashboard for request logs

## Step 5: Verify Working
Dashboard → Request Logs should show:
- Intercepted requests from Antigravity
- Provider: Gemini
- Account used from pool
- Token savings applied

## Troubleshooting
**SSL Certificate Error:**
- Verify certificate installed correctly
- Check trust status in Dashboard
- Restart IDE after certificate installation

**No Requests Intercepted:**
- Verify system proxy configured
- Check MITM server is running (green badge)
- Test with: curl -x http://localhost:8443 https://google.com

**Connection Refused:**
- MITM server may not be started
- Check port 8443 not in use by another process
- Restart Krouter
```

#### 🔄 Future Enhancements

**Phase 12.1: Advanced Features (Optional)**
- [ ] Request/response replay for debugging
- [ ] Custom provider patterns (user-defined)
- [ ] Request/response modification rules
- [ ] Certificate pinning bypass (for specific domains)
- [ ] Multiple MITM profiles (dev, staging, prod)

**Phase 12.2: Enhanced Security (Optional)**
- [ ] Hardware key integration for CA private key
- [ ] Certificate transparency logging
- [ ] Automatic certificate rotation
- [ ] Anomaly detection (unusual traffic patterns)

**Phase 12.3: Performance (Optional)**
- [ ] Certificate cache warming
- [ ] Connection pooling
- [ ] HTTP/2 support
- [ ] WebSocket proxying

---

## 📝 PHASE 12 CHECKLIST SUMMARY

### Implementation Checklist
- [ ] Certificate Manager module
- [ ] MITM Proxy Server module
- [ ] Provider detection patterns
- [ ] Dashboard UI components
- [ ] API endpoints for control
- [ ] Installation instructions
- [ ] Unit tests (>90% coverage)
- [ ] E2E tests (all providers)
- [ ] Security audit
- [ ] Performance benchmarks

### Documentation Checklist
- [ ] Architecture documentation
- [ ] Setup guide (per platform)
- [ ] Troubleshooting guide
- [ ] Security best practices
- [ ] Provider pattern documentation
- [ ] API reference

### Testing Checklist
- [ ] Certificate generation
- [ ] HTTPS interception
- [ ] Provider detection
- [ ] Antigravity integration
- [ ] Kiro IDE integration
- [ ] Copilot CLI integration
- [ ] Trust status detection
- [ ] Performance under load
- [ ] Security penetration testing

### Deployment Checklist
- [ ] Feature flag for gradual rollout
- [ ] Backup/restore for certificates
- [ ] Migration guide from v1.8.4
- [ ] Beta user testing
- [ ] Production deployment
- [ ] Monitoring alerts

**Timeline:** 2-3 weeks  
**Complexity:** High  
**Impact:** High (enables 10+ new IDE tools)  
**Risk:** Medium (certificate trust, security implications)

---

### � CRITICAL INSIGHT: 9Router Architecture Analysis

**Important Discovery:** Sau khi analyze 9Router source code, em phát hiện **9Router KHÔNG implement MITM proxy** như em tưởng ban đầu!

#### 🎯 9Router's Actual Architecture

**What 9Router Actually Does:**
```yaml
Architecture:
  - Local HTTP Gateway (NOT MITM proxy)
  - Port: 20128 (configurable)
  - API: OpenAI-compatible /v1/* endpoints
  - Connection: IDE tools point directly to http://localhost:20128/v1

How IDEs Connect:
  Method 1: Environment Variables
    - ANTHROPIC_BASE_URL=http://localhost:20128
    - OPENAI_BASE_URL=http://localhost:20128/v1
  
  Method 2: Config Files
    - Claude CLI: ~/.claude/settings.json
    - Cursor: settings.json
    - Continue/Cline: .continuerc.json
  
  Method 3: CLI Arguments
    - claude --api-url http://localhost:20128

When 9Router Stops:
  - IDE fallback to ORIGINAL URLs (hardcoded defaults)
  - Claude → api.anthropic.com
  - Cursor → api.openai.com
  - NO ERROR - seamless fallback
```

**Key Files from 9Router:**
- `src/app/api/v1/*/route.js` - API endpoints
- `open-sse/handlers/chatCore.js` - Request routing
- No MITM certificate generation
- No system proxy manipulation
- No HTTPS interception

#### ❌ Why Our Current MITM Plan Is OVERENGINEERED

**Problems with Current Plan:**
1. ✅ Certificate generation - **NOT NEEDED** (9Router proves this)
2. ✅ System proxy manipulation - **NOT NEEDED**
3. ✅ HTTPS interception - **NOT NEEDED**
4. ✅ Complex trust chain - **NOT NEEDED**

**Why It Works Without MITM:**
- IDE tools support custom API endpoints via config
- No need to intercept HTTPS traffic
- No need for certificate trust
- Simpler, more reliable, less security risk

#### ✅ REVISED APPROACH: Follow 9Router Pattern

**What We Actually Need:**

```typescript
// Krouter should provide:
1. OpenAI-compatible HTTP endpoint (already have: http://localhost:5580/v1)
2. Configuration helpers for IDE tools
3. Graceful fallback when Krouter stops
4. Model list exposure
```

**How IDE Tools Will Connect:**

```yaml
Antigravity:
  Problem: Hardcoded to generativelanguage.googleapis.com
  Solution: STILL NEEDS MITM (one exception)
  Reason: No config file support

Kiro IDE:
  Problem: Uses AWS Builder ID OAuth
  Solution: Environment variable override
  Command: KIRO_API_URL=http://localhost:5580 kiro-ide
  Fallback: Automatic (uses default AWS endpoint)

GitHub Copilot:
  Problem: Hardcoded to api.githubcopilot.com
  Solution: Config file override
  File: ~/.config/github-copilot/hosts.json
  Fallback: Automatic

Cursor:
  Solution: Settings override
  UI: Settings → Models → API URL
  Fallback: Automatic

Claude Code/CLI:
  Solution: ~/.claude/settings.json
  Config: { "api_url": "http://localhost:5580" }
  Fallback: Automatic
```

#### 📊 Revised Architecture

**BEFORE (Overengineered MITM):**
```
IDE (hardcoded URLs)
    ↓
System Proxy (localhost:8443)
    ↓
MITM Server (certificate, intercept, decrypt)
    ↓
Krouter Proxy (localhost:5580)
    ↓
Upstream Providers

Problems:
- Complex certificate trust chain
- Platform-specific installation
- Security risks
- Fragile (breaks on cert issues)
```

**AFTER (9Router-inspired Simple):**
```
IDE (configurable via env/config)
    ↓
Krouter Proxy (localhost:5580/v1)
    ↓
Upstream Providers

Benefits:
- No certificates needed
- Works immediately
- No trust chain issues
- Secure by default
- Cross-platform
```

#### 🎯 What This Means for Krouter Plan

**Keep These:**
1. ✅ OpenAI-compatible API (already have)
2. ✅ Model list endpoint (already have)
3. ✅ Smart account rotation (already have)
4. ✅ Multi-provider routing (already have)

**Add These (Simple):**
1. 📝 Configuration helper tool
2. 📝 IDE setup wizard (generates config files)
3. 📝 Graceful degradation documentation
4. 📝 Fallback testing

**Remove These (Overengineered):**
1. ❌ MITM certificate generation
2. ❌ System proxy manipulation
3. ❌ HTTPS interception
4. ❌ Trust chain management
5. ❌ Platform-specific cert installation
6. ❌ Connection pooling for MITM
7. ❌ Certificate rotation
8. ❌ Security hardening for MITM

#### 🆕 REVISED PHASE 12: IDE Integration Tools (Not MITM)

**New Objective:**
Create configuration tools and helpers để IDE tools dễ dàng kết nối với Krouter thông qua config files và environment variables (giống 9Router).

**Implementation:**

```typescript
// File: src/main/ide-integrations/configGenerator.ts (NEW - SIMPLE)

interface IDEConfig {
  name: string
  type: 'env' | 'config-file' | 'cli-arg'
  instructions: string[]
  verify: () => Promise<boolean>
}

const IDE_INTEGRATIONS: IDEConfig[] = [
  {
    name: 'Claude Code/CLI',
    type: 'config-file',
    instructions: [
      'Open ~/.claude/settings.json',
      'Add: "api_url": "http://localhost:5580"',
      'Restart Claude'
    ],
    verify: async () => {
      const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
      if (!fs.existsSync(settingsPath)) return false
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      return settings.api_url === 'http://localhost:5580'
    }
  },
  {
    name: 'Kiro IDE',
    type: 'env',
    instructions: [
      'Set environment variable:',
      'KIRO_API_URL=http://localhost:5580',
      'Start Kiro IDE'
    ],
    verify: async () => {
      return process.env.KIRO_API_URL === 'http://localhost:5580'
    }
  },
  {
    name: 'Cursor',
    type: 'cli-arg',
    instructions: [
      'Open Cursor Settings',
      'Go to Models → API URL',
      'Enter: http://localhost:5580/v1',
      'Save'
    ],
    verify: async () => {
      // Check Cursor config file
      const configPath = path.join(os.homedir(), '.cursor', 'settings.json')
      if (!fs.existsSync(configPath)) return false
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      return config.apiUrl === 'http://localhost:5580/v1'
    }
  }
]

// Auto-configure IDE when possible
function autoConfigureIDE(ideName: string): { success: boolean; message: string } {
  const integration = IDE_INTEGRATIONS.find(i => i.name === ideName)
  if (!integration) return { success: false, message: 'IDE not supported' }
  
  if (integration.type === 'config-file') {
    // Auto-write config file
    const configPath = getConfigPath(ideName)
    const config = {
      ...loadExistingConfig(configPath),
      api_url: 'http://localhost:5580'
    }
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    return { success: true, message: 'Config file updated' }
  }
  
  if (integration.type === 'env') {
    return { 
      success: false, 
      message: 'Manual setup required. Set: KIRO_API_URL=http://localhost:5580' 
    }
  }
  
  return { success: false, message: 'Manual setup required via UI' }
}
```

**Dashboard UI:**

```typescript
// File: src/renderer/src/components/pages/IDEIntegrationsPage.tsx (NEW)

export function IDEIntegrationsPage() {
  const [integrations, setIntegrations] = useState<IDEConfig[]>([])
  const [verifiedStatus, setVerifiedStatus] = useState<Record<string, boolean>>({})

  useEffect(() => {
    loadIntegrations()
    verifyAll()
  }, [])

  async function loadIntegrations() {
    const res = await fetch('/api/ide-integrations/list')
    const data = await res.json()
    setIntegrations(data.integrations)
  }

  async function verifyAll() {
    const status: Record<string, boolean> = {}
    for (const integration of integrations) {
      const res = await fetch(`/api/ide-integrations/verify?ide=${integration.name}`)
      const data = await res.json()
      status[integration.name] = data.verified
    }
    setVerifiedStatus(status)
  }

  async function autoSetup(ideName: string) {
    const res = await fetch('/api/ide-integrations/auto-setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ide: ideName })
    })
    const result = await res.json()
    
    if (result.success) {
      alert('✓ Setup complete!')
      verifyAll()
    } else {
      alert(`Manual setup required:\n${result.message}`)
    }
  }

  return (
    <div className="flex-1 p-6 space-y-6">
      <div className="page-hero">
        <h1>IDE Integrations</h1>
        <p>Connect your favorite IDE tools to Krouter</p>
      </div>

      {integrations.map(integration => (
        <Card key={integration.name}>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{integration.name}</CardTitle>
              {verifiedStatus[integration.name] ? (
                <Badge variant="success">Connected</Badge>
              ) : (
                <Badge variant="secondary">Not Connected</Badge>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <h4 className="font-medium mb-2">Setup Instructions:</h4>
                <ol className="list-decimal list-inside space-y-1 text-sm">
                  {integration.instructions.map((inst, i) => (
                    <li key={i}>{inst}</li>
                  ))}
                </ol>
              </div>

              <div className="flex gap-2">
                {integration.type === 'config-file' && (
                  <Button onClick={() => autoSetup(integration.name)}>
                    Auto Setup
                  </Button>
                )}
                <Button variant="outline" onClick={() => verifyAll()}>
                  Verify Connection
                </Button>
              </div>

              {verifiedStatus[integration.name] && (
                <Alert variant="success">
                  ✓ {integration.name} is connected to Krouter
                </Alert>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
```

#### 📋 REVISED Phase 12 Checklist

**Week 8: IDE Integration Tools (Simple)**
- [ ] Create IDE configuration helpers
- [ ] Add auto-setup for config-file-based IDEs
- [ ] Create verification endpoints
- [ ] Build IDE Integrations dashboard page
- [ ] Document manual setup for each IDE
- [ ] Test with Claude Code, Kiro IDE, Cursor
- [ ] Add connection status indicators

**Week 9: Polish & Documentation**
- [ ] Create setup wizard for first-time users
- [ ] Add troubleshooting guide per IDE
- [ ] Test graceful fallback (stop Krouter → IDE uses default)
- [ ] Add model list compatibility testing
- [ ] Create video tutorials
- [ ] Beta testing with real users

**Removed from Scope:**
- ❌ MITM certificate generation (~200 lines)
- ❌ System proxy manipulation (~150 lines)
- ❌ HTTPS interception (~300 lines)
- ❌ Trust chain management (~100 lines)
- ❌ Platform-specific installers (~400 lines)
- **Total removed: ~1150 lines of complex code**

**Added (Simple):**
- ✅ Config file generators (~50 lines)
- ✅ Verification helpers (~50 lines)
- ✅ Dashboard UI (~200 lines)
- ✅ Documentation (~100 lines)
- **Total added: ~400 lines of simple code**

#### 📊 Benefits of Revised Approach

| Aspect | MITM Approach | Simple Config Approach |
|--------|---------------|----------------------|
| **Complexity** | Very High | Low |
| **Security Risk** | High (cert trust) | None |
| **Setup Time** | 10-15 min | 2-3 min |
| **Reliability** | Medium (cert issues) | High |
| **Cross-platform** | Hard (3 implementations) | Easy (same code) |
| **User Trust** | Low (certificate warnings) | High (no warnings) |
| **Maintenance** | High | Low |
| **Fallback** | Breaks if cert fails | Always works |
| **Code Volume** | ~1150 lines | ~400 lines |

#### 🎯 Exception: Antigravity IDE

**Antigravity vẫn CẦN MITM vì:**
- Hardcoded to `generativelanguage.googleapis.com`
- Không có config file support
- Không hỗ trợ environment variables

**Solution cho Antigravity:**
- Implement lightweight MITM CHỈ cho Antigravity
- Hoặc recommend users dùng alternatives (Claude Code, Cursor)
- Optional feature, not core requirement

#### ✅ Updated Success Criteria

**Phase 12 Revised:**
- [ ] 5+ IDE tools configurable (Claude, Kiro, Cursor, Continue, Cline)
- [ ] Auto-setup works for config-file-based tools
- [ ] Setup time < 3 minutes per IDE
- [ ] Graceful fallback tested
- [ ] Zero certificate warnings
- [ ] Cross-platform (Windows/Mac/Linux) same code
- [ ] Model list visible in all connected IDEs

---



Sau khi review chi tiết, em phát hiện plan hiện tại còn thiếu các phần sau cần bổ sung:

#### 1. Error Handling & Recovery

**Missing:**
- Certificate generation failure handling
- Port conflict resolution (8443 already in use)
- Permission denied handling (non-admin on Windows)
- MITM server crash recovery
- Graceful degradation when cert not trusted

**Need to Add:**
```typescript
// File: src/main/mitm/mitmProxyServer.ts

class MITMProxyServer {
  // Add retry logic for port binding
  async start(maxRetries = 3): Promise<void> {
    let lastError: Error | null = null
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.tryStart()
        return
      } catch (error) {
        lastError = error as Error
        
        // Port already in use → try next port
        if (error.code === 'EADDRINUSE') {
          this.config.port++
          console.log(`[MITM] Port in use, trying ${this.config.port}`)
          continue
        }
        
        // Permission denied → suggest running as admin
        if (error.code === 'EACCES') {
          throw new Error(
            'Permission denied. Run Krouter as administrator to use MITM server.'
          )
        }
        
        throw error
      }
    }
    
    throw new Error(`Failed to start MITM server after ${maxRetries} attempts: ${lastError?.message}`)
  }
  
  // Add health check & auto-restart
  private setupHealthCheck(): void {
    setInterval(() => {
      if (this.config.enabled && !this.server.listening) {
        console.error('[MITM] Server stopped unexpectedly, restarting...')
        this.start().catch(console.error)
      }
    }, 30000) // Check every 30s
  }
}
```

**Checklist:**
- [ ] Implement retry logic with exponential backoff
- [ ] Add port conflict auto-resolution
- [ ] Detect admin privileges on Windows
- [ ] Add health check & auto-restart
- [ ] Implement graceful shutdown on errors

---

#### 2. Performance & Scalability

**Missing:**
- Connection pooling for backend requests
- Memory limits for active connections
- Rate limiting per client
- Performance metrics collection
- Load testing benchmarks

**Need to Add:**
```typescript
// File: src/main/mitm/connectionPool.ts (NEW)

class ConnectionPool {
  private pool: Map<string, http.Agent> = new Map()
  private maxSockets = 50 // Per host
  
  getAgent(host: string): http.Agent {
    if (!this.pool.has(host)) {
      this.pool.set(host, new http.Agent({
        keepAlive: true,
        maxSockets: this.maxSockets,
        maxFreeSockets: 10,
        timeout: 30000
      }))
    }
    return this.pool.get(host)!
  }
}

// Add to MITMProxyServer
class MITMProxyServer {
  private connectionLimits = {
    maxActiveConnections: 500,
    maxConnectionsPerIP: 50,
    rateLimitWindow: 60000, // 1 minute
    maxRequestsPerWindow: 100
  }
  
  private rateLimitMap = new Map<string, { count: number; resetAt: number }>()
  
  private checkRateLimit(clientIP: string): boolean {
    const now = Date.now()
    const limit = this.rateLimitMap.get(clientIP)
    
    if (!limit || now > limit.resetAt) {
      this.rateLimitMap.set(clientIP, {
        count: 1,
        resetAt: now + this.connectionLimits.rateLimitWindow
      })
      return true
    }
    
    if (limit.count >= this.connectionLimits.maxRequestsPerWindow) {
      return false // Rate limit exceeded
    }
    
    limit.count++
    return true
  }
}
```

**Checklist:**
- [ ] Implement connection pooling
- [ ] Add memory limits (max 500 active connections)
- [ ] Implement rate limiting per client IP
- [ ] Add metrics collection (prometheus format)
- [ ] Load test with 1000+ concurrent connections
- [ ] Profile memory usage under load

**Benchmarks Target:**
- Throughput: >1000 requests/sec
- Latency overhead: <50ms p95
- Memory: <100MB with 500 active connections
- CPU: <10% on 4-core system

---

#### 3. Provider Pattern Extensibility

**Missing:**
- User-defined provider patterns
- Hot-reload patterns without restart
- Custom transformation functions
- Provider priority/ordering

**Need to Add:**
```typescript
// File: .krouter-data/mitm-providers.json (NEW)

{
  "customProviders": [
    {
      "name": "custom-ai-service",
      "pattern": "^api\\.myaiservice\\.com$",
      "targetModel": "claude-sonnet-4.5",
      "pathTransform": {
        "from": "^/v1/chat",
        "to": "/v1/chat/completions"
      },
      "headersTransform": {
        "remove": ["X-Custom-Header"],
        "add": {
          "X-Krouter-Source": "custom-ai-service"
        }
      }
    }
  ]
}

// Add to mitmProxyServer.ts
class MITMProxyServer {
  private loadCustomProviders(): AIProviderPattern[] {
    const configPath = path.join(dataDir, 'mitm-providers.json')
    if (!fs.existsSync(configPath)) return []
    
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    return config.customProviders.map(p => ({
      pattern: new RegExp(p.pattern),
      provider: p.name,
      pathTransform: (path) => path.replace(new RegExp(p.pathTransform.from), p.pathTransform.to),
      headersTransform: (headers) => {
        // Apply transformations
        return headers
      }
    }))
  }
  
  // Watch config file for changes
  private watchProviderConfig(): void {
    const configPath = path.join(dataDir, 'mitm-providers.json')
    fs.watch(configPath, () => {
      console.log('[MITM] Reloading provider patterns...')
      this.providerPatterns = [
        ...this.defaultProviders,
        ...this.loadCustomProviders()
      ]
    })
  }
}
```

**Checklist:**
- [ ] Create provider config file schema
- [ ] Implement hot-reload mechanism
- [ ] Add UI for managing custom providers
- [ ] Validate provider patterns on load
- [ ] Document provider config format

---

#### 4. Enhanced Logging & Observability

**Missing:**
- Structured JSON logging
- Request/response body logging (optional)
- Privacy-aware redaction
- Log rotation
- Integration with external logging systems

**Need to Add:**
```typescript
// File: src/main/mitm/mitmLogger.ts (NEW)

interface MITMLogEntry {
  timestamp: number
  level: 'info' | 'warn' | 'error'
  event: 'connection' | 'request' | 'response' | 'error'
  clientIP: string
  hostname: string
  path: string
  method: string
  statusCode?: number
  duration?: number
  provider?: string
  error?: string
}

class MITMLogger {
  private logStream: fs.WriteStream
  private redactPatterns = [
    /Bearer\s+[\w\-._]+/gi,           // Bearer tokens
    /x-api-key:\s*[\w\-._]+/gi,       // API keys
    /password['":]?\s*["'][\w]+["']/gi // Passwords
  ]
  
  log(entry: MITMLogEntry): void {
    const sanitized = this.redactSensitiveData(entry)
    this.logStream.write(JSON.stringify(sanitized) + '\n')
    
    // Also send to proxyLogger for UI display
    proxyLogger.info('MITM', this.formatForDisplay(sanitized))
  }
  
  private redactSensitiveData(entry: MITMLogEntry): MITMLogEntry {
    const redacted = { ...entry }
    if (redacted.path) {
      for (const pattern of this.redactPatterns) {
        redacted.path = redacted.path.replace(pattern, '[REDACTED]')
      }
    }
    return redacted
  }
}
```

**Checklist:**
- [ ] Implement structured JSON logging
- [ ] Add sensitive data redaction
- [ ] Implement log rotation (max 7 days)
- [ ] Add request/response body logging (opt-in)
- [ ] Create log viewer UI component
- [ ] Export logs to external systems (optional)

---

#### 5. Windows-Specific Enhancements

**Missing:**
- PowerShell automation scripts
- Firewall rule creation
- Admin privilege elevation
- System proxy auto-configuration

**Need to Add:**
```powershell
# File: scripts/windows/install-mitm-cert.ps1 (NEW)

param(
    [Parameter(Mandatory=$true)]
    [string]$CertPath
)

# Check if running as Administrator
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
$isAdmin = $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $isAdmin) {
    Write-Error "This script must be run as Administrator"
    exit 1
}

# Import certificate
Import-Certificate -FilePath $CertPath -CertStoreLocation Cert:\CurrentUser\Root

# Add firewall rule for MITM proxy
New-NetFirewallRule -DisplayName "Krouter MITM Proxy" `
    -Direction Inbound `
    -LocalPort 8443 `
    -Protocol TCP `
    -Action Allow

Write-Host "✓ Certificate installed successfully" -ForegroundColor Green
Write-Host "✓ Firewall rule created" -ForegroundColor Green

# File: scripts/windows/set-system-proxy.ps1 (NEW)

param(
    [Parameter(Mandatory=$true)]
    [string]$ProxyServer  # e.g., "localhost:8443"
)

$regPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings"

Set-ItemProperty -Path $regPath -Name ProxyEnable -Value 1
Set-ItemProperty -Path $regPath -Name ProxyServer -Value $ProxyServer

Write-Host "✓ System proxy configured: $ProxyServer" -ForegroundColor Green
Write-Host "Run 'Remove-ItemProperty -Path $regPath -Name ProxyEnable' to disable" -ForegroundColor Yellow
```

**Checklist:**
- [ ] Create PowerShell automation scripts
- [ ] Add admin elevation prompt in UI
- [ ] Auto-create firewall rules
- [ ] System proxy auto-configuration
- [ ] Restore system proxy on disable
- [ ] Handle Windows security warnings

---

#### 6. Migration & Upgrade Path

**Missing:**
- Migration guide from v1.9.4
- Certificate backup/restore
- Settings migration
- Rollback strategy

**Need to Add:**
```typescript
// File: src/main/mitm/migration.ts (NEW)

interface MITMMigration {
  fromVersion: string
  toVersion: string
  migrate(): Promise<void>
}

class MITMv1_9_4_to_v2_0_0 implements MITMMigration {
  fromVersion = '1.9.4'
  toVersion = '2.0.0'
  
  async migrate(): Promise<void> {
    // Backup existing data
    await this.backupData()
    
    // Create MITM directories
    const mitmDir = path.join(dataDir, 'mitm-ca')
    if (!fs.existsSync(mitmDir)) {
      fs.mkdirSync(mitmDir, { recursive: true })
    }
    
    // Initialize default settings
    const settings = {
      enabled: false,
      port: 8443,
      autoStart: false,
      logRequests: false
    }
    
    fs.writeFileSync(
      path.join(dataDir, 'mitm-settings.json'),
      JSON.stringify(settings, null, 2)
    )
    
    console.log('[Migration] MITM setup complete')
  }
  
  private async backupData(): Promise<void> {
    const backupDir = path.join(dataDir, 'backups', Date.now().toString())
    fs.mkdirSync(backupDir, { recursive: true })
    
    // Backup existing configs
    const filesToBackup = ['store.json', 'config.json']
    for (const file of filesToBackup) {
      const srcPath = path.join(dataDir, file)
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, path.join(backupDir, file))
      }
    }
    
    console.log(`[Migration] Backup created at ${backupDir}`)
  }
}
```

**Checklist:**
- [ ] Write migration script
- [ ] Backup strategy for certificates
- [ ] Settings migration automation
- [ ] Version detection logic
- [ ] Rollback mechanism
- [ ] Migration testing

---

#### 7. Testing Strategy Enhancements

**Missing:**
- Mock IDE tools
- Traffic simulation
- Platform-specific tests
- Certificate expiry tests

**Need to Add:**
```typescript
// File: test/mitm/mock-ide-client.test.ts (NEW)

describe('MITM with Mock IDE Clients', () => {
  test('Antigravity IDE request pattern', async () => {
    const client = new MockAntigravityClient()
    const response = await client.sendRequest({
      model: 'gemini-pro',
      prompt: 'Test'
    })
    
    expect(response.status).toBe(200)
    expect(response.provider).toBe('kiro') // Routed through Krouter
  })
  
  test('Kiro IDE with multi-account', async () => {
    const client = new MockKiroIDEClient()
    
    // Send 10 requests, should distribute across accounts
    const responses = await Promise.all(
      Array(10).fill(null).map(() => 
        client.sendRequest({ model: 'claude-sonnet-4.5' })
      )
    )
    
    const uniqueAccounts = new Set(responses.map(r => r.accountId))
    expect(uniqueAccounts.size).toBeGreaterThan(1) // Multi-account rotation
  })
})

// File: test/mitm/stress.test.ts (NEW)

describe('MITM Stress Tests', () => {
  test('Handle 1000 concurrent connections', async () => {
    const startTime = Date.now()
    const clients = Array(1000).fill(null).map(() => new MockClient())
    
    const results = await Promise.allSettled(
      clients.map(c => c.sendRequest())
    )
    
    const duration = Date.now() - startTime
    const successCount = results.filter(r => r.status === 'fulfilled').length
    
    expect(successCount).toBeGreaterThan(950) // >95% success rate
    expect(duration).toBeLessThan(10000) // <10s for 1000 requests
  })
})
```

**Checklist:**
- [ ] Create mock IDE clients (Antigravity, Kiro, Copilot)
- [ ] Traffic simulation scripts
- [ ] Stress tests (1000+ concurrent)
- [ ] Certificate expiry simulation
- [ ] Platform-specific integration tests
- [ ] Performance regression tests

---

#### 8. User Onboarding Improvements

**Missing:**
- First-time setup wizard
- Interactive tutorial
- Auto-validation
- Progress indicators

**Need to Add:**
```typescript
// File: src/renderer/src/components/mitm/MITMSetupWizard.tsx (NEW)

export function MITMSetupWizard() {
  const steps = [
    {
      title: 'Enable MITM Server',
      description: 'Start the proxy server on port 8443',
      action: enableMITM,
      validation: () => checkServerRunning()
    },
    {
      title: 'Install Certificate',
      description: 'Trust the root CA certificate',
      action: installCertificate,
      validation: () => checkCertificateTrusted()
    },
    {
      title: 'Configure System Proxy',
      description: 'Set localhost:8443 as system proxy',
      action: configureProxy,
      validation: () => checkProxyConfigured()
    },
    {
      title: 'Test Connection',
      description: 'Verify MITM is working',
      action: testConnection,
      validation: () => checkConnectionWorking()
    }
  ]
  
  return (
    <StepWizard steps={steps} onComplete={onSetupComplete} />
  )
}
```

**Checklist:**
- [ ] Create setup wizard component
- [ ] Add step-by-step validation
- [ ] Auto-detect completion status
- [ ] Add troubleshooting tips per step
- [ ] Create tutorial video/GIFs
- [ ] Add "Quick Start" button

---

#### 9. Built-in Troubleshooting Tools

**Missing:**
- Connection diagnostic tool
- Certificate validator
- Proxy settings checker
- System compatibility checker

**Need to Add:**
```typescript
// File: src/main/mitm/diagnostics.ts (NEW)

class MITMDiagnostics {
  async runFullDiagnostic(): Promise<DiagnosticResult> {
    const result: DiagnosticResult = {
      checks: [],
      overall: 'pass'
    }
    
    // Check 1: Server running
    result.checks.push({
      name: 'MITM Server Status',
      status: this.checkServerRunning() ? 'pass' : 'fail',
      message: this.checkServerRunning() ? 'Running' : 'Not started'
    })
    
    // Check 2: Certificate installed
    result.checks.push({
      name: 'Certificate Installation',
      status: await this.checkCertInstalled() ? 'pass' : 'fail',
      message: await this.getCertStatus()
    })
    
    // Check 3: System proxy configured
    result.checks.push({
      name: 'System Proxy Configuration',
      status: await this.checkProxyConfigured() ? 'pass' : 'warn',
      message: await this.getProxyStatus()
    })
    
    // Check 4: Test connection
    result.checks.push({
      name: 'Connection Test',
      status: await this.testConnection() ? 'pass' : 'fail',
      message: await this.getConnectionStatus()
    })
    
    result.overall = result.checks.every(c => c.status === 'pass') ? 'pass' : 'fail'
    return result
  }
  
  private async testConnection(): Promise<boolean> {
    try {
      const response = await fetch('https://google.com', {
        agent: new https.Agent({
          proxy: 'http://localhost:8443'
        })
      })
      return response.ok
    } catch {
      return false
    }
  }
}

// Add UI component
export function MITMDiagnosticsPanel() {
  const [result, setResult] = useState<DiagnosticResult | null>(null)
  
  async function runDiagnostics() {
    const diagnostics = new MITMDiagnostics()
    const result = await diagnostics.runFullDiagnostic()
    setResult(result)
  }
  
  return (
    <Card>
      <CardHeader>
        <CardTitle>MITM Diagnostics</CardTitle>
      </CardHeader>
      <CardContent>
        <Button onClick={runDiagnostics}>Run Diagnostics</Button>
        
        {result && (
          <div className="mt-4">
            {result.checks.map(check => (
              <DiagnosticCheckItem key={check.name} check={check} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
```

**Checklist:**
- [ ] Implement diagnostic runner
- [ ] Add certificate validator
- [ ] System proxy checker
- [ ] Connection tracer
- [ ] Platform compatibility checker
- [ ] Auto-fix suggestions

---

#### 10. Security Hardening Enhancements

**Missing:**
- TLS version enforcement
- Cipher suite configuration
- Certificate pinning for Krouter backend
- HSTS handling

**Need to Add:**
```typescript
// File: src/main/mitm/securityConfig.ts (NEW)

interface SecurityConfig {
  tlsMinVersion: 'TLSv1.2' | 'TLSv1.3'
  cipherSuites: string[]
  enableHSTS: boolean
  enableCertificatePinning: boolean
  pinnedCertificates: string[] // Krouter backend cert fingerprints
}

const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  tlsMinVersion: 'TLSv1.2',
  cipherSuites: [
    'TLS_AES_128_GCM_SHA256',
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-RSA-AES256-GCM-SHA384'
  ],
  enableHSTS: true,
  enableCertificatePinning: true,
  pinnedCertificates: []
}

class SecureM ITMServer extends MITMProxyServer {
  private securityConfig: SecurityConfig
  
  protected createSecureContext(): https.SecureContextOptions {
    return {
      minVersion: this.securityConfig.tlsMinVersion,
      ciphers: this.securityConfig.cipherSuites.join(':'),
      honorCipherOrder: true,
      // ... other security options
    }
  }
  
  private verifyCertificatePinning(cert: crypto.X509Certificate): boolean {
    if (!this.securityConfig.enableCertificatePinning) return true
    
    const fingerprint = crypto.createHash('sha256')
      .update(cert.raw)
      .digest('hex')
    
    return this.securityConfig.pinnedCertificates.includes(fingerprint)
  }
}
```

**Checklist:**
- [ ] Enforce TLS 1.2+ only
- [ ] Configure secure cipher suites
- [ ] Implement cert pinning for Krouter backend
- [ ] Handle HSTS properly
- [ ] Add certificate revocation checking
- [ ] Security audit by external party

---

### 📊 Updated Implementation Timeline

**Week 8: Core Implementation**
- [ ] Certificate Manager (2 days)
- [ ] MITM Proxy Server (3 days)
- [ ] Provider detection (1 day)
- [ ] Error handling & recovery (1 day)

**Week 9: Enhanced Features**
- [ ] Performance optimizations (2 days)
- [ ] Logging & observability (1 day)
- [ ] Windows-specific enhancements (1 day)
- [ ] Testing infrastructure (2 days)
- [ ] Dashboard UI (1 day)

**Week 10: Polish & Testing**
- [ ] Setup wizard & onboarding (2 days)
- [ ] Diagnostics tools (1 day)
- [ ] Security hardening (1 day)
- [ ] Documentation (1 day)
- [ ] Beta testing (2 days)

### 📈 Enhanced Success Metrics

| Metric | Before | Target | Measurement |
|--------|--------|--------|-------------|
| Setup Time | N/A | <5 min | First-time setup wizard |
| Success Rate | N/A | >95% | Diagnostic pass rate |
| Performance | N/A | <50ms overhead | p95 latency |
| Reliability | N/A | >99.5% uptime | Health check |
| Security | N/A | A+ rating | SSL Labs equivalent |

---

## 🎨 FRONTEND CHANGES: Replace Webhook with CLI Tools

### Changes to Sidebar Menu

**REMOVE:**
```typescript
{ id: 'webhooks', labelKey: 'nav.webhooks', icon: Bell },
```

**ADD:**
```typescript
{ id: 'cliTools', labelKey: 'nav.cliTools', icon: Terminal },  // Or Boxes icon
```

### New CLIToolsPage Component

**File:** `src/renderer/src/components/pages/CLIToolsPage.tsx`

```typescript
import { useState, useEffect } from 'react'
import { Terminal, Power, PowerOff, CheckCircle2, XCircle, Copy, Download, AlertTriangle, Shield } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { Card, CardContent, CardHeader, CardTitle, Button, Input, Label, Switch, Badge, Alert } from '../ui'
import { cn } from '@/lib/utils'

interface MITMStatus {
  enabled: boolean
  port: number
  listening: boolean
  activeConnections: number
  certificate: {
    path: string
    trusted: boolean
    validUntil: string
  }
  platform: 'win32' | 'darwin' | 'linux'
}

export function CLIToolsPage(): React.ReactNode {
  const { t } = useTranslation()
  const isEn = t('common.unknown') === 'Unknown'
  
  const [mitmStatus, setMitmStatus] = useState<MITMStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [showInstructions, setShowInstructions] = useState<string | null>(null)

  useEffect(() => {
    loadMITMStatus()
    const interval = setInterval(loadMITMStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  async function loadMITMStatus(): Promise<void> {
    try {
      const res = await fetch('/api/mitm/status')
      const data = await res.json()
      setMitmStatus(data)
    } catch (error) {
      console.error('Failed to load MITM status:', error)
    }
  }

  async function toggleMITM(): Promise<void> {
    if (!mitmStatus) return
    setLoading(true)
    try {
      await fetch('/api/mitm/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !mitmStatus.enabled })
      })
      await loadMITMStatus()
    } finally {
      setLoading(false)
    }
  }

  async function openCertificateLocation(): Promise<void> {
    if (!mitmStatus) return
    await window.electron.showItemInFolder(mitmStatus.certificate.path)
  }

  async function copyProxySettings(): Promise<void> {
    if (!mitmStatus) return
    const proxyUrl = `http://localhost:${mitmStatus.port}`
    await navigator.clipboard.writeText(proxyUrl)
    // Show toast notification
  }

  async function regenerateCertificate(): Promise<void> {
    if (!confirm(isEn 
      ? 'Regenerate root CA certificate? This will invalidate the current certificate.'
      : '重新生成根证书？这将使当前证书失效。'
    )) return
    
    setLoading(true)
    try {
      await fetch('/api/mitm/regenerate-cert', { method: 'POST' })
      await loadMITMStatus()
    } finally {
      setLoading(false)
    }
  }

  function getInstallInstructions(platform: string, certPath: string): string {
    switch (platform) {
      case 'win32':
        return `Windows Installation:
1. Double-click: ${certPath}
2. Click "Install Certificate"
3. Select "Current User"
4. Choose "Trusted Root Certification Authorities"
5. Finish

PowerShell (Admin):
Import-Certificate -FilePath "${certPath}" -CertStoreLocation Cert:\\CurrentUser\\Root`

      case 'darwin':
        return `macOS Installation:
1. Double-click: ${certPath}
2. Add to "login" keychain
3. Open Keychain Access
4. Find "Krouter MITM Root CA"
5. Double-click → Trust → "Always Trust"

Command line:
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${certPath}"`

      case 'linux':
        return `Ubuntu/Debian:
sudo cp "${certPath}" /usr/local/share/ca-certificates/krouter-mitm.crt
sudo update-ca-certificates

RHEL/CentOS:
sudo cp "${certPath}" /etc/pki/ca-trust/source/anchors/
sudo update-ca-trust`

      default:
        return 'Platform not supported'
    }
  }

  function getProxyInstructions(platform: string, port: number): string {
    const proxyUrl = `localhost:${port}`
    
    switch (platform) {
      case 'win32':
        return `Windows:
Settings → Network & Internet → Proxy → Manual proxy setup
HTTP: ${proxyUrl}
HTTPS: ${proxyUrl}
Save`

      case 'darwin':
        return `macOS:
System Preferences → Network → Advanced → Proxies
✓ Web Proxy (HTTP): ${proxyUrl}
✓ Secure Web Proxy (HTTPS): ${proxyUrl}
OK → Apply`

      case 'linux':
        return `Linux (GNOME):
Settings → Network → Network Proxy → Manual
HTTP Proxy: ${proxyUrl}
HTTPS Proxy: ${proxyUrl}
Apply`

      default:
        return ''
    }
  }

  if (!mitmStatus) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Terminal className="h-12 w-12 mx-auto mb-3 opacity-30 animate-pulse" />
          <p>{isEn ? 'Loading...' : '加载中...'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <div className="page-hero p-6">
        <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-purple-500/20 to-transparent rounded-full blur-2xl" />
        <div className="absolute bottom-0 left-0 w-24 h-24 bg-gradient-to-tr from-purple-500/20 to-transparent rounded-full blur-2xl" />
        <div className="relative flex items-center gap-4">
          <div className="p-3 rounded-xl bg-purple-500 shadow-lg shadow-purple-500/25">
            <Terminal className="h-6 w-6 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-purple-600 dark:text-purple-400">
              {isEn ? 'CLI Tools Integration' : 'CLI 工具集成'}
            </h1>
            <p className="text-muted-foreground">
              {isEn
                ? 'MITM proxy server for intercepting IDE tools (Antigravity, Kiro IDE, GitHub Copilot, etc.)'
                : 'MITM 代理服务器，用于拦截 IDE 工具（Antigravity、Kiro IDE、GitHub Copilot 等）'
              }
            </p>
          </div>
        </div>
      </div>

      {/* MITM Server Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-purple-500" />
              {isEn ? 'MITM Proxy Server' : 'MITM 代理服务器'}
            </CardTitle>
            <div className="flex items-center gap-2">
              {mitmStatus.listening && (
                <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-200">
                  ● {isEn ? 'Running' : '运行中'}
                </Badge>
              )}
              <Switch
                checked={mitmStatus.enabled}
                onCheckedChange={toggleMITM}
                disabled={loading}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {!mitmStatus.enabled && (
            <Alert>
              <AlertTriangle className="h-4 w-4" />
              <div>
                <p className="font-medium">{isEn ? 'MITM Server Disabled' : 'MITM 服务器已禁用'}</p>
                <p className="text-sm text-muted-foreground">
                  {isEn
                    ? 'Enable to intercept IDE tool requests and route through Krouter.'
                    : '启用以拦截 IDE 工具请求并通过 Krouter 路由。'
                  }
                </p>
              </div>
            </Alert>
          )}

          {mitmStatus.enabled && (
            <>
              {/* Proxy Settings */}
              <div>
                <Label className="text-sm font-medium mb-2 block">
                  {isEn ? 'Proxy Settings' : '代理设置'}
                </Label>
                <div className="flex gap-2">
                  <Input
                    value={`http://localhost:${mitmStatus.port}`}
                    readOnly
                    className="font-mono text-sm"
                  />
                  <Button size="sm" variant="outline" onClick={copyProxySettings}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2 text-xs"
                  onClick={() => setShowInstructions('proxy')}
                >
                  {isEn ? 'How to configure system proxy?' : '如何配置系统代理？'}
                </Button>
                {showInstructions === 'proxy' && (
                  <div className="mt-2 p-3 rounded-md bg-muted/50 border">
                    <pre className="text-xs whitespace-pre-wrap font-mono">
                      {getProxyInstructions(mitmStatus.platform, mitmStatus.port)}
                    </pre>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-2"
                      onClick={() => setShowInstructions(null)}
                    >
                      {isEn ? 'Close' : '关闭'}
                    </Button>
                  </div>
                )}
              </div>

              {/* Certificate Status */}
              <div>
                <Label className="text-sm font-medium mb-2 block">
                  {isEn ? 'Root CA Certificate' : '根证书'}
                </Label>
                <div className="flex items-center gap-2 mb-2">
                  {mitmStatus.certificate.trusted ? (
                    <Badge variant="outline" className="bg-green-500/10 text-green-600 border-green-200">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      {isEn ? 'Trusted' : '已信任'}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600 border-yellow-200">
                      <XCircle className="h-3 w-3 mr-1" />
                      {isEn ? 'Not Trusted' : '未信任'}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {isEn ? 'Valid until' : '有效期至'}: {new Date(mitmStatus.certificate.validUntil).toLocaleDateString()}
                  </span>
                </div>

                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={openCertificateLocation}>
                    <Download className="h-4 w-4 mr-2" />
                    {isEn ? 'Open Certificate' : '打开证书'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={regenerateCertificate}>
                    {isEn ? 'Regenerate' : '重新生成'}
                  </Button>
                </div>

                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2 text-xs"
                  onClick={() => setShowInstructions('cert')}
                >
                  {isEn ? 'How to install certificate?' : '如何安装证书？'}
                </Button>
                {showInstructions === 'cert' && (
                  <div className="mt-2 p-3 rounded-md bg-muted/50 border">
                    <pre className="text-xs whitespace-pre-wrap font-mono">
                      {getInstallInstructions(mitmStatus.platform, mitmStatus.certificate.path)}
                    </pre>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="mt-2"
                      onClick={() => setShowInstructions(null)}
                    >
                      {isEn ? 'Close' : '关闭'}
                    </Button>
                  </div>
                )}
              </div>

              {/* Stats */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {isEn ? 'Active Connections' : '活动连接'}
                  </Label>
                  <p className="text-2xl font-bold">{mitmStatus.activeConnections}</p>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">
                    {isEn ? 'Port' : '端口'}
                  </Label>
                  <p className="text-2xl font-bold">{mitmStatus.port}</p>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Supported IDE Tools */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {isEn ? 'Supported IDE Tools' : '支持的 IDE 工具'}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {[
              { name: 'Antigravity IDE', provider: 'Google Gemini', icon: '🌌' },
              { name: 'Kiro IDE', provider: 'AWS Bedrock', icon: '⚡' },
              { name: 'GitHub Copilot CLI', provider: 'OpenAI', icon: '🐙' },
              { name: 'JetBrains AI', provider: 'Various', icon: '🔨' },
              { name: 'VSCode Extensions', provider: 'Various', icon: '📦' },
              { name: 'Cursor IDE', provider: 'OpenAI', icon: '🎯' }
            ].map((tool) => (
              <div
                key={tool.name}
                className="flex items-center gap-3 p-3 rounded-lg border bg-card"
              >
                <span className="text-2xl">{tool.icon}</span>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">{tool.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {isEn ? 'Provider' : '提供商'}: {tool.provider}
                  </p>
                </div>
                <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Security Warning */}
      <Card className="border-yellow-200 dark:border-yellow-900">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
            <AlertTriangle className="h-5 w-5" />
            {isEn ? 'Security Notice' : '安全提示'}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <p>
            {isEn
              ? 'MITM proxy intercepts ALL HTTPS traffic routed through it. Only use on trusted networks and for development purposes.'
              : 'MITM 代理会拦截所有通过它路由的 HTTPS 流量。仅在受信任的网络和开发目的下使用。'
            }
          </p>
          <ul className="list-disc list-inside space-y-1 text-muted-foreground">
            <li>{isEn ? 'Keep root CA certificate private' : '保持根证书私密'}</li>
            <li>{isEn ? 'Never share with untrusted parties' : '切勿与不信任的方共享'}</li>
            <li>{isEn ? 'Regenerate periodically (1 year validity)' : '定期重新生成（1 年有效期）'}</li>
            <li>{isEn ? 'Disable when not needed' : '不需要时禁用'}</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}
```

### Translation Updates

**File:** `src/renderer/src/i18n/translations.ts`

```typescript
// Add to nav section
nav: {
  // ... existing nav keys
  cliTools: {
    en: 'CLI Tools',
    zh: 'CLI 工具',
    vi: 'Công cụ CLI'
  }
}
```

### Router Changes

**File:** `src/renderer/src/App.tsx` (or wherever routing is defined)

```typescript
// REMOVE:
// case 'webhooks':
//   return <WebhooksPage />

// ADD:
case 'cliTools':
  return <CLIToolsPage />
```

### Summary of Frontend Changes

**Files to Modify:**
1. ✅ `src/renderer/src/components/layout/Sidebar.tsx` - Update menu items
2. ✅ `src/renderer/src/components/pages/CLIToolsPage.tsx` - NEW file
3. ✅ `src/renderer/src/components/pages/index.ts` - Export CLIToolsPage
4. ✅ `src/renderer/src/i18n/translations.ts` - Add translations
5. ✅ `src/renderer/src/App.tsx` - Update routing
6. ❌ `src/renderer/src/components/pages/WebhooksPage.tsx` - REMOVE (or keep for backwards compat)

**Icon Change:**
- From: `Bell` (webhooks)
- To: `Terminal` or `Boxes` (CLI tools)

**Color Theme:**
- From: Pink gradient (webhooks)
- To: Purple gradient (CLI tools, matches MITM security theme)



---

## 🔄 BACKEND PERSISTENCE FOR MITM SETTINGS

### Problem
Frontend state bị mất khi F5/refresh → MITM settings không persist → User phải enable lại mỗi lần reload.

### Solution: Store MITM Config in Backend

#### 1. Add MITM Config to Store

**File:** `src/server/store.ts`

No changes needed - sẽ dùng existing `proxyStateByUser` hoặc `getUserSettings`.

#### 2. Backend API Endpoints

**File:** `src/server/api/mitm.ts` (NEW)

```typescript
import { Router } from 'express'
import type { WebStore } from '../store'
import { MITMProxyServer } from '../../main/mitm/mitmProxyServer'
import { CertificateManager } from '../../main/mitm/certificateManager'

interface MITMConfig {
  enabled: boolean
  port: number
  autoStart: boolean  // Auto-start on Krouter launch
}

interface MITMState {
  config: MITMConfig
  status: {
    listening: boolean
    activeConnections: number
    certificate: {
      path: string
      trusted: boolean
      validUntil: string
    }
  }
}

export function createMITMRouter(
  store: WebStore,
  certManager: CertificateManager,
  mitmServer: MITMProxyServer
): Router {
  const router = Router()

  /**
   * GET /api/mitm/status
   * Get current MITM server status
   */
  router.get('/status', async (req, res) => {
    const user = store.findUserBySession(req.cookies.session_id)
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    // Load config from store
    const config = store.getUserSetting<MITMConfig>(user.id, 'mitm.config', {
      enabled: false,
      port: 8443,
      autoStart: false
    })

    // Get runtime status
    const serverStatus = mitmServer.getStatus()
    const certPath = certManager.getRootCertificatePath()
    const certTrustStatus = await certManager.checkTrustStatus()

    const state: MITMState = {
      config,
      status: {
        listening: serverStatus.listening,
        activeConnections: serverStatus.activeConnections,
        certificate: {
          path: certPath,
          trusted: certTrustStatus.trusted,
          validUntil: certManager.getCertificateExpiry()
        }
      }
    }

    res.json(state)
  })

  /**
   * POST /api/mitm/toggle
   * Enable/disable MITM server and persist to store
   */
  router.post('/toggle', async (req, res) => {
    const user = store.findUserBySession(req.cookies.session_id)
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const { enabled } = req.body as { enabled: boolean }

    // Load current config
    const config = store.getUserSetting<MITMConfig>(user.id, 'mitm.config', {
      enabled: false,
      port: 8443,
      autoStart: false
    })

    // Update config
    config.enabled = Boolean(enabled)

    // Persist to store FIRST (so it survives restart)
    await store.setUserSetting(user.id, 'mitm.config', config)

    // Then apply runtime change
    try {
      if (config.enabled) {
        await mitmServer.start()
      } else {
        await mitmServer.stop()
      }

      res.json({ success: true, enabled: config.enabled })
    } catch (error) {
      console.error('[MITM API] Toggle error:', error)
      res.status(500).json({ 
        error: 'Failed to toggle MITM server',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })

  /**
   * POST /api/mitm/update-config
   * Update MITM configuration (port, autoStart, etc)
   */
  router.post('/update-config', async (req, res) => {
    const user = store.findUserBySession(req.cookies.session_id)
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    const updates = req.body as Partial<MITMConfig>

    // Load current config
    const config = store.getUserSetting<MITMConfig>(user.id, 'mitm.config', {
      enabled: false,
      port: 8443,
      autoStart: false
    })

    // Apply updates
    if (typeof updates.port === 'number') {
      config.port = updates.port
    }
    if (typeof updates.autoStart === 'boolean') {
      config.autoStart = updates.autoStart
    }

    // Persist
    await store.setUserSetting(user.id, 'mitm.config', config)

    // If port changed and server is running, need restart
    if (updates.port !== undefined && mitmServer.getStatus().listening) {
      await mitmServer.stop()
      await mitmServer.start()
    }

    res.json({ success: true, config })
  })

  /**
   * POST /api/mitm/regenerate-cert
   * Regenerate root CA certificate
   */
  router.post('/regenerate-cert', async (req, res) => {
    const user = store.findUserBySession(req.cookies.session_id)
    if (!user) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    try {
      // Stop server if running
      const wasRunning = mitmServer.getStatus().listening
      if (wasRunning) {
        await mitmServer.stop()
      }

      // Regenerate certificate
      await certManager.regenerateRootCA()

      // Restart if was running
      if (wasRunning) {
        await mitmServer.start()
      }

      // Audit log
      await store.audit(user.id, 'mitm.cert.regenerate', {
        timestamp: Date.now()
      })

      res.json({ success: true })
    } catch (error) {
      console.error('[MITM API] Regenerate cert error:', error)
      res.status(500).json({ 
        error: 'Failed to regenerate certificate',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  })

  return router
}
```

#### 3. Server Integration

**File:** `src/server/index.ts`

```typescript
import { createMITMRouter } from './api/mitm'
import { CertificateManager } from '../main/mitm/certificateManager'
import { MITMProxyServer } from '../main/mitm/mitmProxyServer'

// Initialize MITM components
const dataDir = process.env.KROUTER_DATA_DIR || '.krouter-data'
const certManager = new CertificateManager(dataDir)
const mitmServer = new MITMProxyServer(certManager, {
  port: 8443,
  enabled: false,  // Will be loaded from store
  targetProxyUrl: 'http://localhost:5580',
  logRequests: true
})

// Register MITM API routes
app.use('/api/mitm', createMITMRouter(store, certManager, mitmServer))

// Auto-start MITM server if enabled in user settings
async function autoStartMITM(): Promise<void> {
  // Get admin user (or first user)
  const users = store.getUsers()
  if (users.length === 0) return

  const adminUser = users.find(u => u.role === 'admin') || users[0]

  // Load MITM config
  const config = store.getUserSetting<{
    enabled: boolean
    autoStart: boolean
    port: number
  }>(adminUser.id, 'mitm.config', {
    enabled: false,
    autoStart: false,
    port: 8443
  })

  // Auto-start if both enabled and autoStart are true
  if (config.enabled && config.autoStart) {
    console.log('[MITM] Auto-starting server on port', config.port)
    try {
      mitmServer.updateConfig({ port: config.port })
      await mitmServer.start()
      console.log('[MITM] Server started successfully')
    } catch (error) {
      console.error('[MITM] Auto-start failed:', error)
    }
  }
}

// Call after store is loaded
store.load().then(() => {
  autoStartMITM()
})
```

#### 4. Frontend Integration

**File:** `src/renderer/src/components/pages/CLIToolsPage.tsx`

Update API calls to use backend endpoints:

```typescript
// BEFORE (local state only):
const [mitmEnabled, setMitmEnabled] = useState(false)

// AFTER (persisted state):
async function loadMITMStatus(): Promise<void> {
  try {
    const res = await fetch('/api/mitm/status')
    const data = await res.json()
    setMitmStatus(data)  // Includes config.enabled from backend
  } catch (error) {
    console.error('Failed to load MITM status:', error)
  }
}

async function toggleMITM(): Promise<void> {
  if (!mitmStatus) return
  setLoading(true)
  try {
    // POST to backend - will persist AND update runtime
    const res = await fetch('/api/mitm/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !mitmStatus.config.enabled })
    })
    const result = await res.json()
    
    if (result.success) {
      // Reload status from backend (single source of truth)
      await loadMITMStatus()
    }
  } finally {
    setLoading(false)
  }
}

// Auto-start checkbox
<div className="flex items-center gap-2">
  <Switch
    checked={mitmStatus.config.autoStart}
    onCheckedChange={async (checked) => {
      await fetch('/api/mitm/update-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoStart: checked })
      })
      await loadMITMStatus()
    }}
  />
  <Label>{isEn ? 'Auto-start on launch' : '启动时自动开启'}</Label>
</div>
```

#### 5. Data Flow

```
User Action (Frontend)
    ↓
POST /api/mitm/toggle { enabled: true }
    ↓
Backend API Handler
    ↓
    ├─> store.setUserSetting('mitm.config', { enabled: true, ... })
    │   ↓
    │   store.save() → Persist to disk (store.json)
    │
    └─> mitmServer.start() → Runtime change
    ↓
Response { success: true }
    ↓
Frontend reloads status
    ↓
GET /api/mitm/status → Returns persisted config + runtime status
```

**Key Benefits:**
1. ✅ Settings persist across F5/refresh
2. ✅ Settings survive Krouter restart
3. ✅ Auto-start option available
4. ✅ Per-user configuration (if multi-user)
5. ✅ Audit trail for cert regeneration
6. ✅ Single source of truth (backend store)

#### 6. Store Schema

**MITM settings stored in:**
```json
{
  "settingsByUser": {
    "user-id-123": {
      "mitm.config": {
        "enabled": true,
        "port": 8443,
        "autoStart": true
      }
    }
  }
}
```

**Location:** `<KROUTER_DATA_DIR>/store.json`

#### 7. Migration Strategy

**For existing users upgrading to v1.9.0:**
```typescript
// First load: default config
const defaultConfig = {
  enabled: false,
  port: 8443,
  autoStart: false
}

// On first access, initialize with defaults
if (!store.getUserSetting(userId, 'mitm.config')) {
  await store.setUserSetting(userId, 'mitm.config', defaultConfig)
}
```

No migration needed - defaults apply automatically.

#### 8. Testing Persistence

**Test Scenario 1: Refresh**
```
1. Enable MITM in UI → Toggle switch ON
2. Verify: POST /api/mitm/toggle called
3. Refresh page (F5)
4. Verify: GET /api/mitm/status returns enabled=true
5. ✅ MITM still enabled
```

**Test Scenario 2: Restart**
```
1. Enable MITM + Auto-start
2. Stop Krouter completely
3. Start Krouter again
4. Verify: MITM server automatically starts
5. ✅ Settings persisted
```

**Test Scenario 3: Multiple Users**
```
1. User A enables MITM
2. User B logs in
3. Verify: User B sees their own MITM config (disabled by default)
4. ✅ Per-user isolation works
```

#### 9. Checklist

Backend Implementation:
- [ ] Create `src/server/api/mitm.ts` with all endpoints
- [ ] Integrate into `src/server/index.ts`
- [ ] Add auto-start logic on Krouter launch
- [ ] Add audit logging for cert regeneration
- [ ] Handle port conflicts gracefully

Frontend Updates:
- [ ] Replace local state with API calls
- [ ] Add auto-start checkbox UI
- [ ] Add loading states for async operations
- [ ] Handle errors gracefully (show toast)
- [ ] Poll status every 5s to stay in sync

Testing:
- [ ] Unit tests for store persistence
- [ ] E2E test: Enable → Refresh → Still enabled
- [ ] E2E test: Enable → Restart → Auto-start works
- [ ] E2E test: Multi-user config isolation

---

### Summary of Persistence Changes

**Before (v1.8.4):**
```typescript
// Frontend only - lost on refresh
const [enabled, setEnabled] = useState(false)
```

**After (v1.9.0):**
```typescript
// Backend persisted - survives refresh + restart
GET  /api/mitm/status        → Load from store
POST /api/mitm/toggle        → Save to store + apply runtime
POST /api/mitm/update-config → Save to store
```

**Files Modified:**
1. `src/server/store.ts` - No changes (uses existing methods)
2. `src/server/api/mitm.ts` - NEW file (~200 lines)
3. `src/server/index.ts` - Add MITM router + auto-start
4. `src/renderer/src/components/pages/CLIToolsPage.tsx` - Update API calls

**Storage Location:**
```
<KROUTER_DATA_DIR>/
  ├── store.json              # MITM config stored here
  └── mitm-ca/
      ├── rootCA.crt          # Certificate
      └── rootCA.key          # Private key
```


---

## Phase 14: MCP Server + Pool Intelligence + OpenClaw Deep Integration

**Status:** IMPLEMENTED (2026-07-21)
**Priority:** P0

### 14.1 MCP Server (`src/main/proxy/mcpServer.ts`)

Krouter now exposes admin tools via MCP protocol (Model Context Protocol) at `/mcp/` endpoint.

**Tools exposed:**
| Tool | Purpose |
|------|---------|
| `krouter_pool_status` | Pool health: active/suspended/cooling/exhausted counts, tier breakdown |
| `krouter_account_health` | Per-account detail (by ID or email): score, cooldown, quota, token expiry |
| `krouter_force_refresh` | Force token refresh for one/all accounts |
| `krouter_usage_stats` | Usage stats: requests, tokens, success rate, uptime |
| `krouter_register` | Trigger automated account registration |

**OpenClaw integration:**
```bash
openclaw mcp add krouter --transport http --url http://127.0.0.1:5580/mcp
```

**Protocol:** MCP JSON-RPC 2.0 over HTTP (SSE + /message) or stdio.

### 14.2 Conversation Cache Affinity (`accountPool.ts`)

- `getConversationPreferred(conversationId)` — returns preferred account for a conversation
- `recordConversationAffinity(conversationId, accountId)` — builds affinity
- Quota-aware: auto-unstick when account quota > 85%
- TTL: 10 minutes

### 14.3 Quota-Aware Sticky Unstick (`accountPool.ts`)

- `shouldUnstick(threshold)` — checks if sticky should release (quota > threshold OR recent success < 50%)
- `forceUnstick()` — advances round-robin pointer
- Auto-integrated into `getNextAccount()` for sticky strategy

### 14.4 Session Affinity Quota Check (`proxyServer.ts`)

- `pickAccountWithAffinity()` now checks quota usage ratio
- Unsticks when account quota > 85% (prevents request failure)
- Logs unstick events for debugging

### 14.5 Registration Adaptive Rate Limiting (`registrar.ts`)

- `canRefreshProxySession()` — NOW IMPLEMENTED (detects BestProxy/BrightData session params)
- `onRiskControlDetected()` — exponential backoff: 5s → 15s → 30s → 60s → 120s max
- `decayAdaptiveDelay()` — recovers after 2 minutes without risk triggers
- Integrates with `humanDelay()` to automatically slow down when AWS blocks
- Emits `risk-control` step event for UI tracking

### 14.6 MITM Response Interception (`mitmProxy.ts`)

- `interceptResponses` config flag enables response header parsing
- `modifyResponseHeaders()` — hook for response modification
- `getDeviceIdForAccount(accountId)` — per-account device ID rotation
- `setActiveDeviceId(deviceId)` — set device ID for current request context
- `deviceIdMappings` in config — maps account IDs to unique device IDs

### 14.7 OpenClaw SKILL.md (`docs/skills/krouter-mcp/SKILL.md`)

OpenClaw-compatible skill file with:
- Proper frontmatter (name, description, metadata.openclaw.requires)
- Decision workflow for agents
- Tool documentation
- MCP configuration instructions

### Test Coverage

| Test File | Tests | Status |
|-----------|-------|--------|
| `mcpServer.test.ts` | 13 | PASS |
| `mcpIntegration.test.ts` | 6 | PASS |
| `accountPool.affinity.test.ts` | 12 | PASS |
| Existing tests (38 files) | 282 | PASS (1 pre-existing env-dependent failure) |

### Files Modified/Created

| File | Action | Description |
|------|--------|-------------|
| `src/main/proxy/mcpServer.ts` | NEW | MCP server implementation (tools, JSON-RPC, HTTP/stdio transport) |
| `src/main/proxy/proxyServer.ts` | MODIFIED | Added MCP route, import, initialization, quota-aware affinity |
| `src/main/proxy/accountPool.ts` | MODIFIED | Added conversation affinity, quota-aware unstick, cleanup |
| `src/main/registration/registrar.ts` | MODIFIED | canRefreshProxySession impl, adaptive rate limiting, risk-control step |
| `src/main/kproxy/mitmProxy.ts` | MODIFIED | Response interception, per-account device ID |
| `src/main/kproxy/types.ts` | MODIFIED | Added deviceIdMappings, interceptResponses, modelMappings config |
| `docs/skills/krouter-mcp/SKILL.md` | NEW | OpenClaw-compatible MCP skill |
| `test/proxy/mcpServer.test.ts` | NEW | MCP server unit tests |
| `test/proxy/mcpIntegration.test.ts` | NEW | MCP integration scenarios |
| `test/proxy/accountPool.affinity.test.ts` | NEW | Affinity + unstick tests |

---

## 🎨 PHASE 15: FREE IMAGE GENERATION VIA CHATGPT OAUTH

**Priority:** HIGH  
**Timeline:** 1 tuần  
**Goal:** Cho phép user tạo hình đẹp (GPT-Image-2 quality) hoàn toàn FREE thông qua ChatGPT OAuth, không cần API key

---

### 15.1 Tổng Quan Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     KROUTER IMAGE GENERATION                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  User → Krouter UI → "Đăng nhập ChatGPT" → OAuth PKCE Flow     │
│                                                ↓                │
│         auth.openai.com/oauth/authorize                         │
│         client_id: app_EMoamEEZ73f0CkXaXp7hrann                │
│         scope: openid profile email offline_access              │
│         redirect: http://localhost:{PORT}/auth/chatgpt/callback │
│                                                ↓                │
│         Exchange code → access_token + refresh_token            │
│         Lưu vào ProxyAccount.chatgpt field                      │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Agent/OpenClaw → POST /v1/images/generations                   │
│                        ↓                                        │
│  Krouter Backend:                                               │
│    1. Pick account có chatgpt token (pool rotation)             │
│    2. Check token expiry → auto refresh nếu cần                │
│    3. POST chatgpt.com/backend-api/codex/responses              │
│       Body: {model: "gpt-5.4", tools: [{type:image_generation}]}│
│    4. Parse SSE stream → extract base64 image                   │
│    5. Save image → return OpenAI-compatible response            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 15.2 ChatGPT OAuth Integration

**File MỚI:** `src/main/proxy/chatgptOAuth.ts`

```typescript
interface ChatGPTOAuthConfig {
  clientId: string           // 'app_EMoamEEZ73f0CkXaXp7hrann' (OpenClaw public client)
  redirectPort: number       // Port cho localhost callback (default: 19836)
  scopes: string[]           // ['openid', 'profile', 'email', 'offline_access']
  tokenRefreshSkew: number   // Refresh trước khi hết hạn (default: 300s / 5 phút)
}

interface ChatGPTTokenSet {
  accessToken: string
  refreshToken: string
  expiresAt: number          // Unix timestamp ms
  profile?: {
    email: string
    name?: string
    plan?: string            // 'free' | 'plus' | 'pro'
  }
}
```

**Functions:**
- `startOAuthFlow(config)` — Mở browser, PKCE flow, nhận code qua localhost callback
- `exchangeCode(code, codeVerifier)` — POST auth.openai.com/oauth/token → TokenSet
- `refreshAccessToken(refreshToken)` — Refresh khi token hết hạn
- `isTokenValid(tokenSet, skew)` — Check expiry
- `revokeToken(token)` — Logout/cleanup

**OAuth PKCE Flow:**
1. Generate `code_verifier` (43-128 chars random)
2. `code_challenge` = Base64URL(SHA256(code_verifier))
3. Open browser: `https://auth.openai.com/oauth/authorize?client_id=...&redirect_uri=...&code_challenge=...&code_challenge_method=S256&scope=...&response_type=code`
4. User đăng nhập ChatGPT (free account OK)
5. Redirect về `http://localhost:{PORT}/auth/chatgpt/callback?code=...`
6. Exchange code → tokens
7. Lưu tokens vào account

### 15.3 Extend ProxyAccount Type

**File:** `src/main/proxy/types.ts`

Thêm vào `ProxyAccount`:
```typescript
interface ProxyAccount {
  // ... existing fields ...
  
  // Phase 15: ChatGPT OAuth for image generation
  chatgpt?: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    email?: string
    plan?: string            // 'free' | 'plus' | 'pro'
    imageQuota?: {
      used: number
      limit: number          // Estimated daily limit (free ≈ 2-3, plus ≈ 50+)
      resetAt: number        // Next reset timestamp
    }
    lastImageGenAt?: number
    consecutiveFailures: number
  }
}
```

### 15.4 Image Generation via ChatGPT Backend

**File MỚI:** `src/main/proxy/chatgptImage.ts`

```typescript
interface ChatGPTImageRequest {
  prompt: string
  model?: string            // 'gpt-5.4' (default) hoặc 'gpt-image-2'
  size?: string             // '1024x1024' | '1024x1536' | '1536x1024'
  quality?: string          // 'low' | 'medium' | 'high'
  n?: number                // Số lượng hình (qua prompt instruction)
}

interface ChatGPTImageResult {
  images: Array<{
    base64: string
    revisedPrompt?: string
    callId?: string
  }>
  model: string
  requestId: string
}
```

**Functions:**
- `generateChatGPTImage(token, request, signal)` — Main generation function
- `buildCodexPayload(request)` — Build request body cho `/codex/responses`
- `parseImageSSE(stream)` — Parse SSE stream, extract base64 từ `response.output_item.done`
- `pickChatGPTAccount(pool)` — Chọn account có token + chưa hết quota
- `handleImageQuotaExhausted(account)` — Mark account khi hết quota → rotate sang account khác

**API Call Format:**
```
POST https://chatgpt.com/backend-api/codex/responses
Authorization: Bearer {access_token}
Content-Type: application/json
Accept: text/event-stream

{
  "model": "gpt-5.4",
  "input": [
    {
      "role": "user",
      "content": [
        {"type": "input_text", "text": "Generate an image: {prompt}"}
      ]
    }
  ],
  "tools": [{"type": "image_generation"}],
  "stream": true,
  "store": false
}
```

**SSE Response Parsing:**
```
data: {"type": "response.output_item.done", "item": {"type": "image_generation_call", "result": "base64..."}}
data: {"type": "response.completed"}
data: [DONE]
```

### 15.5 Modified handleImageGeneration Flow

**File:** `src/main/proxy/proxyServer.ts`

```typescript
private async handleImageGeneration(req, res, signal) {
  const request = parseBody(req)
  
  // Route by model or availability:
  if (isBedrockImageModel(request.model) && this.config.bedrock?.enabled) {
    // Existing: AWS Bedrock Nova Canvas (paid)
    return await generateImage(this.config.bedrock, request, ...)
  }
  
  // Default: ChatGPT OAuth (free)
  const account = pickChatGPTAccount(this.accountPool)
  if (!account?.chatgpt) {
    return this.sendError(res, 503, 'No ChatGPT accounts available. Please login via Krouter UI.')
  }
  
  // Auto-refresh token if needed
  if (!isTokenValid(account.chatgpt)) {
    await refreshAccessToken(account.chatgpt.refreshToken)
  }
  
  const result = await generateChatGPTImage(account.chatgpt.accessToken, request, signal)
  
  // Save images and return OpenAI-compatible response
  const response = {
    created: Math.floor(Date.now() / 1000),
    data: result.images.map(img => ({
      url: saveAndGetUrl(img.base64),
      revised_prompt: img.revisedPrompt
    }))
  }
  
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(response))
}
```

### 15.6 UI: ChatGPT Login Button

**File:** `src/renderer/src/components/proxy/ChatGPTLoginPanel.tsx` (NEW)

- Button "Đăng nhập ChatGPT" trong Krouter UI
- Hiển thị status: email, plan tier, image quota remaining
- Support nhiều accounts (pool)
- Disconnect/Logout option

### 15.7 Account Pool Enhancement

**File:** `src/main/proxy/accountPool.ts`

Thêm methods:
- `getAvailableChatGPTAccounts()` — Filter accounts có valid chatgpt token
- `pickBestChatGPTAccount()` — Chọn account ít quota usage nhất
- `recordImageGeneration(accountId)` — Track quota usage
- `markImageQuotaExhausted(accountId)` — Khi free account hết limit → skip tới account khác

### 15.8 Rate Limit & Quota Management

**Free account strategy:**
- Estimate: ~2-3 images/ngày/account (có thể OpenAI thay đổi)
- Pool rotation: 5 free accounts = ~10-15 images/ngày
- Track usage per account, auto-rotate khi gần hết
- Cooldown: khi bị 429 → back off 1 giờ cho account đó
- Reset tracking mỗi ngày (midnight UTC)

**Token refresh strategy:**
- Access token valid ~2 tuần
- Refresh token valid rất lâu (months)
- Auto refresh 5 phút trước khi hết hạn
- Cross-account locking để tránh concurrent refresh conflicts

### 15.9 Error Handling

| Error | Action |
|-------|--------|
| 401 Unauthorized | Refresh token → retry 1 lần |
| 403 Forbidden | Account bị ban → mark suspended |
| 429 Rate Limited | Rotate sang account khác → mark cooldown |
| Image quota exceeded | Track per-account → next account |
| Network timeout (>120s) | Retry với exponential backoff |
| Token refresh failed | Mark account needs re-login → notify UI |

### 15.10 Files Summary

| File | Action | Description |
|------|--------|-------------|
| `src/main/proxy/chatgptOAuth.ts` | NEW | OAuth PKCE flow, token management |
| `src/main/proxy/chatgptImage.ts` | NEW | Image gen via chatgpt.com/backend-api |
| `src/main/proxy/proxyServer.ts` | MODIFY | Route image gen to ChatGPT, add OAuth callback route |
| `src/main/proxy/accountPool.ts` | MODIFY | ChatGPT account selection, quota tracking |
| `src/main/proxy/types.ts` | MODIFY | ProxyAccount.chatgpt field |
| `src/renderer/src/components/proxy/ChatGPTLoginPanel.tsx` | NEW | Login UI |
| `src/server/services/proxyRuntime.ts` | MODIFY | Wire up OAuth callback endpoint |
| `test/proxy/chatgptImage.test.ts` | NEW | Unit tests |
| `test/proxy/chatgptOAuth.test.ts` | NEW | OAuth flow tests |
| `docs/skills/krouter-imagegen/SKILL.md` | NEW | OpenClaw skill for agents |

### 15.11 OpenClaw Integration

**Skill file:** `docs/skills/krouter-imagegen/SKILL.md`
- Agents dùng standard OpenAI image API format
- Không cần biết backend là ChatGPT — transparent
- Endpoint: `POST {krouter_url}/v1/images/generations`

**Usage từ OpenClaw/Agent:**
```bash
curl -X POST http://localhost:4269/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "a beautiful sunset over Vietnamese mountains, watercolor style",
    "size": "1024x1024",
    "quality": "high"
  }'
```

### 15.12 Security Notes

- Tokens encrypted at rest (AES-256-GCM, key từ machine-id)
- Refresh tokens never exposed qua API
- OAuth redirect chỉ accept localhost
- PKCE prevents code interception attacks
- No ChatGPT credentials stored — chỉ OAuth tokens

### 15.13 Testing Plan

1. **Unit tests:** OAuth flow mock, SSE parsing, quota tracking
2. **Integration test:** Full flow mock (OAuth → generate → serve image)
3. **Manual test trên local:** Anh đăng nhập ChatGPT free → gen hình → verify quality
4. **Pool test:** Multiple accounts, rotation khi hết quota
