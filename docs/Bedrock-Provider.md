# AWS Bedrock Provider

Krouter can route requests to **AWS Bedrock** in parallel to the existing Kiro
account pool. When a request targets a Bedrock model, Krouter signs it with AWS
SigV4 and calls the Bedrock Runtime **Converse** / **ConverseStream** API instead
of routing through Kiro accounts. Converse gives one uniform request/response
shape across Anthropic, Amazon Nova, Meta Llama, Mistral, Cohere, and others.

## Configuration

Bedrock config lives on `ProxyConfig.bedrock`:

```ts
bedrock: {
  enabled: true,
  accessKeyId: 'AKIA...',        // optional; falls back to AWS_ACCESS_KEY_ID
  secretAccessKey: '...',        // optional; falls back to AWS_SECRET_ACCESS_KEY
  sessionToken: '...',           // optional; falls back to AWS_SESSION_TOKEN
  region: 'us-east-1',           // optional; falls back to AWS_REGION
  models: []                     // optional allow-list of model ids to expose
}
```

Credentials are **never hard-coded**. They are read from the persisted proxy
config first, then from the standard `AWS_*` environment variables. The
`secretAccessKey` and `sessionToken` are encrypted at rest by the web store.

### Environment variables

```env
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
# AWS_SESSION_TOKEN=...   # only for temporary credentials
```

## Model routing

A requested model is routed to Bedrock when any of these hold (and `enabled`):

- The id has an explicit `bedrock/` prefix (e.g. `bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0`).
- The id is listed in `bedrock.models`.
- The id starts with a known Bedrock provider prefix: `anthropic.`, `amazon.`,
  `meta.`, `mistral.`, `cohere.`, `ai21.`, `deepseek.`, `stability.`, or a
  cross-region inference-profile prefix (`us.`, `eu.`, `apac.`, `us-gov.`).

Plain Kiro ids like `claude-sonnet-4.5` are **not** routed to Bedrock.

## Endpoints

Bedrock models work through the same OpenAI/Anthropic-compatible endpoints:

- `POST /v1/chat/completions` (stream + non-stream)
- `POST /v1/messages` (Anthropic Messages, stream + non-stream)
- `GET /v1/models` merges Bedrock foundation models (text-capable) into the list.

## E2E probe

`test/bedrock-e2e/run.mjs` boots the real compiled `ProxyServer` with a Bedrock
config, lists foundation models, and exercises each text model through the proxy
to report which ones actually respond.

```bash
npm run build:api
$env:AWS_ACCESS_KEY_ID = 'AKIA...'
$env:AWS_SECRET_ACCESS_KEY = '...'
$env:AWS_REGION = 'us-east-1'
npm run test:bedrock            # or: node test/bedrock-e2e/run.mjs --max 10
```

Options:

- `--models id1,id2` — test only these model ids.
- `--max N` — cap the number of ON_DEMAND models tested.

The probe prints a `WORKS`/`FAIL` line per model and a final summary of working
models. Models that require a provisioned throughput or an inference profile
(no `ON_DEMAND` inference type) are skipped by default because they cannot be
invoked on-demand.


## E2E results (us-east-1, 2026-07-12)

Ran `npm run test:bedrock` against a live account (IAM user `aira-bedrock`).
Foundation models: 121; text models: 90; ON_DEMAND text: 53 tested.

**Working: 43 / 53** across chat (non-stream), chat (stream), and Anthropic messages.

Notable working ids: `amazon.nova-pro-v1:0`, `amazon.nova-lite-v1:0`,
`amazon.nova-micro-v1:0`, `meta.llama3-8b/70b-instruct-v1:0`,
`mistral.mistral-large-2402-v1:0`, `mistral.mixtral-8x7b-instruct-v0:1`,
`deepseek.v3.2`, `qwen.qwen3-*`, `zai.glm-4.7/glm-5`, `google.gemma-3-*`,
`openai.gpt-oss-20b/120b-1:0`, `moonshot.kimi-k2-thinking`, `minimax.minimax-m2*`,
`nvidia.nemotron-*`, `writer.palmyra-vision-7b`.

**Not working: 10 / 53 ? all AWS-side, not integration issues:**

- `twelvelabs.pegasus-1-2-v1:0`, `amazon.nova-sonic-v1:0`, `amazon.nova-2-sonic-v1:0`,
  `cohere.rerank-v3-5:0` ? HTTP 400 "This action doesn't support the model": these
  are speech / rerank / video models the Converse API does not serve.
- `ai21.jamba-1-5-large/mini-v1:0`, `anthropic.claude-3-sonnet-20240229-v1:0`,
  `anthropic.claude-3-haiku-20240307-v1:0`, `cohere.command-r-v1:0`,
  `cohere.command-r-plus-v1:0` ? HTTP 404 "Access denied. This Model is marked by
  provider as Legacy": the account lacks legacy-model access grants.

Reasoning models (gpt-oss, minimax, kimi-thinking, nemotron) spend their token
budget on hidden reasoning, so give them a larger `max_tokens` (the probe uses
1024). Their reasoning text is surfaced as `reasoning_content` on the response.

Newer Anthropic Claude ids (Sonnet 4 / 3.5 / 3.7) require an inference profile
(cross-region `us.anthropic.*` id) rather than the bare on-demand id; use the
`us.` prefixed id for those.
