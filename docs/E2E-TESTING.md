# E2E 测试套件

针对 Kiro 反代 (`Kiro-account-manager`) 的端到端兼容性测试，覆盖 Claude Code / OpenCode 真实抓包请求。

## 测试范围

16 个用例分两组：

### Anthropic 端点 (`/v1/messages`)
| ID  | 主题 |
|-----|------|
| 01  | Claude Code probe 请求 (max_tokens=1) |
| 02  | 流式简单对话 SSE 完整事件 |
| 03  | 非流式 JSON 响应 |
| 04  | system=array (Claude Code 多 block + cache_control) |
| 05  | 工具声明 + schema 元字段 (`$schema`/`additionalProperties`) |
| 06  | 强制工具调用 + PascalCase 工具名反向映射 |
| 07  | **多轮 user 含 tool_result + text** (回归 502 invalid_argument) |
| 08  | thinking + signature 多轮 |
| 09  | **Claude Code Skill 工具完整复刻** (回归 502) |
| 10  | MCP 风格嵌套 schema (`$ref`/`definitions`) |
| 11  | 12KB 大 description (触发截断) |

### OpenAI 端点 (`/v1/chat/completions`)
| ID  | 主题 |
|-----|------|
| 12  | 流式简单对话 |
| 13  | 工具调用 + 多轮 tool message |
| 14  | opencode `providerOptions.openaiCompatible.reasoningEffort` + `delta.reasoning_text` 双发 |
| 15  | opencode 多轮 `assistant.providerOptions.openaiCompatible` 不报 schema 错 |
| 16  | opencode `promptCacheKey` session 粘性 |

## 前置条件

1. 启动 Kiro Account Manager 开发模式: `npm run dev`
2. 反代默认监听 `http://127.0.0.1:8787` (在应用 UI 反代面板可改)
3. 至少有一个可用账号 (订阅未超额)

## 运行

```bash
# 全跑
npm run test:e2e

# 指定 ID 或 tag (逗号分隔)
node test/e2e-fullsuite/run.mjs --only CASE-07
node test/e2e-fullsuite/run.mjs --only anthropic,tool
node test/e2e-fullsuite/run.mjs --only regression

# 自定义反代地址
node test/e2e-fullsuite/run.mjs --base http://127.0.0.1:9000

# 带鉴权 (反代配置了 API Key 时)
node test/e2e-fullsuite/run.mjs --token sk-xxx
ZS_TOKEN=sk-xxx npm run test:e2e
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `ZS_BASE` | `http://127.0.0.1:8787` | 反代地址 |
| `ZS_TOKEN` | (空) | 鉴权 token (Bearer / x-api-key) |
| `ZS_ONLY` | (空) | case 过滤, 等价 `--only` |
| `ZS_VERBOSE` | `0` | `1` 时打印通过 case 的 log |
| `NO_COLOR` | `0` | `1` 时禁用彩色输出 |

## 退出码

- `0` 全部通过
- `1` 有 case 失败/错误
- `2` 启动参数错误 / 反代不在线

## 报告

每次运行后生成 `test/e2e-fullsuite/last-report.json`，含每个 case 的状态、断言失败路径、stack 等细节。

## 适配自 ZephyrSail

本套件复刻自 ZephyrSail E2E 套件 (`F:\Trace\analysis\ZephyrSail\test\e2e-fullsuite`)，针对 Kiro 反代做以下调整：

1. **默认模型**: `claude-opus-4-7-max` → `claude-sonnet-4.5` (Kiro 官方支持)
2. **CASE 01 probe**: 移除 < 2s 本地拦截硬性断言 (Kiro 反代未实现 probe-intercept，请求会真实打上游)
3. **鉴权**: 同时支持 `Authorization: Bearer xxx` 和 `x-api-key: xxx`

## 关键回归用例

下列用例对应历史已修复的 bug，CI 中应作为强制门控:

- **CASE-07** (`anthropic,tool,multi-turn,regression`): user 同时含 tool_result + text，曾导致 502 invalid_argument
- **CASE-09** (`anthropic,skill,multi-turn,regression`): Claude Code Skill 真实结构，同上根因

跑过滤示例: `node test/e2e-fullsuite/run.mjs --only regression`