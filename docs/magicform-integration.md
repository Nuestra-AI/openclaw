# MagicForm Integration

## Overview

MagicForm integrates with OpenClaw to run agents on behalf of per-account/per-stack customers. MagicForm's backend holds LLM provider API keys per account and per stack. OpenClaw supports this through **per-stack config directories** that contain an `openclaw.json` overlay with provider credentials, model settings, and agent configuration.

Two integration modes are available:

1. **CLI mode** (`openclaw agent`) — synchronous, single-shot agent execution. See [CLI reference](/cli/agent) for the full flag reference, config overlay details, and tool profiles.
2. **Gateway mode** (webhook dispatcher) — async webhook-driven via the MagicForm channel plugin (documented below).

Both modes accept the same `--config-dir` / `configDir` parameter pointing to a per-stack directory on disk.

---

## Channel Plugin

### Plugin Metadata

| Property | Value |
|----------|-------|
| Plugin ID | `magicform` |
| Channel type | Direct messaging (webhook-based, stateless) |
| Delivery mode | Gateway (HTTP callback outbound) |
| Chat types | Direct only |
| Media support | None |
| Text chunk limit | 4000 characters |
| Streaming | Not supported |

### Channel Configuration

Configure in the base `openclaw.json` under `channels.magicform`:

```json5
{
  "channels": {
    "magicform": {
      "enabled": true,
      "backendUrl": "${MAGICFORM_BACKEND_URL}",
      "apiToken": "${MAGICFORM_API_TOKEN}",
      "callbackPath": "/claw-agent/callback",
      "callbackUrl": "",
      "webhookPath": "/webhook/magicform",
      "dmPolicy": "open",
      "allowFrom": [],
      "rateLimitPerMinute": 60
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable channel |
| `backendUrl` | string | — | MagicForm backend URL (used to compose callback URL when `callbackUrl` is not set) |
| `apiToken` | string | — | Bearer token for webhook authentication |
| `callbackPath` | string | `"/claw-agent/callback"` | Callback endpoint path appended to `backendUrl` |
| `callbackUrl` | string | — | Full callback URL (overrides `backendUrl` + `callbackPath` composition) |
| `webhookPath` | string | `"/webhook/magicform"` | Inbound webhook endpoint path on the gateway |
| `dmPolicy` | string | `"open"` | Direct message policy: `open`, `allowlist`, or `disabled` |
| `allowFrom` | string[] | `[]` | Stack ID allowlist (empty = allow all) |
| `rateLimitPerMinute` | number | `60` | Rate limit per `stackId:conversationId` |
| `accounts` | object | — | Per-account config overrides (see [Multi-Account Support](#multi-account-support)) |

### Callback URL Resolution

The callback URL is resolved in this order:

1. Per-request `callbackUrl` in the webhook payload (highest priority)
2. Config `callbackUrl` field (if set)
3. Composed from `backendUrl` + `callbackPath` (fallback)

### Environment Variable Fallbacks

When a field is not set in config, these environment variables are checked:

| Variable | Config field |
|----------|-------------|
| `MAGICFORM_API_TOKEN` | `apiToken` |
| `MAGICFORM_BACKEND_URL` | `backendUrl` |
| `MAGICFORM_RATE_LIMIT` | `rateLimitPerMinute` |

### Target Format

Session keys: `magicform:<stackId>:<conversationId>`

Target fields: `<stackId>:<conversationId>[:<userId>]`

### Security Warnings

The plugin logs warnings when:
- `apiToken` not configured — webhook will reject all requests
- `backendUrl` not configured — bot cannot send callback responses
- `dmPolicy="open"` with empty `allowFrom` — allows any stack to message the bot

---

## Gateway Mode (Webhook)

### Starting the Gateway

```bash
openclaw gateway start
# or: openclaw gateway:dev (development mode)
```

The gateway listens on port 18789 (configurable via `gateway.port`).

### Webhook Endpoint

```
POST http://<gateway-host>:18789/webhook/magicform
```

The path is configurable via `channels.magicform.webhookPath`.

### Inbound Webhook Payload (SendTaskRequest)

```json
{
  "stackId": "acme-corp",
  "conversationId": "conv-123",
  "userId": "user-456",
  "message": "Summarize the report",
  "workspace": "workspaces/acme-corp",
  "configDir": "configs/acme-corp",
  "callbackUrl": "https://api.example.com/claw-agent/callback",
  "allowedTools": ["read", "write", "exec"],
  "allowedSkills": ["summarize"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | User message body (max 4000 chars after sanitization) |
| `stackId` | string | Yes | MagicForm stack identifier |
| `conversationId` | string | Yes | Conversation identifier |
| `userId` | string | No | User identifier |
| `workspace` | string | No | Per-stack workspace directory (relative to `workspaceRoot` when set) |
| `configDir` | string | No | Per-stack config directory (relative to `workspaceRoot` when set; see [Config Overlay](/cli/agent#config-overlay---config-dir)) |
| `callbackUrl` | string | No | Full callback URL (overrides config default) |
| `allowedTools` | string[] | No | Tool allowlist (supports glob patterns and groups) |
| `allowedSkills` | string[] | No | Skill filter (only load these skills for this session) |

**Request limits:**

- Max body size: 1 MB (1,048,576 bytes)
- Read timeout: 30 seconds
- All string fields are trimmed; empty required fields are rejected

### Authentication

```
Authorization: Bearer <apiToken>
```

The `apiToken` must match `channels.magicform.apiToken` (or the per-account override). Token validation uses constant-time HMAC-SHA256 comparison to prevent timing attacks.

### Response

The webhook returns **HTTP 202 Accepted** immediately with `{ "ok": true }`. The agent response is delivered asynchronously via callback.

### Callback Payload (OpenClaw → MagicForm)

```
POST <callbackUrl>
Authorization: Bearer <apiToken>
Content-Type: application/json
```

**Success (`type: "final"`, `status: "success"`):**

```json
{
  "stackId": "acme-corp",
  "conversationId": "conv-123",
  "taskId": "magicform:acme-corp:conv-123",
  "type": "final",
  "status": "success",
  "response": "Here is the summary...",
  "error": null,
  "runtime": "openclaw",
  "durationMs": 4200,
  "tokenUsage": null,
  "toolCalls": null,
  "progress": null,
  "escalation": null
}
```

**Error (`type: "final"`, `status: "error"`):**

```json
{
  "stackId": "acme-corp",
  "conversationId": "conv-123",
  "taskId": "magicform:acme-corp:conv-123",
  "type": "final",
  "status": "error",
  "response": null,
  "error": "Error description",
  "runtime": "openclaw",
  "durationMs": null,
  "tokenUsage": null,
  "toolCalls": null,
  "progress": null,
  "escalation": null
}
```

| Field | Type | Description |
|-------|------|-------------|
| `stackId` | string | Stack identifier (echoed from request) |
| `conversationId` | string | Conversation identifier (echoed from request) |
| `taskId` | string | Unique task/run identifier |
| `type` | string | `"final"`, `"progress"`, or `"escalation"` |
| `status` | string | `"success"` or `"error"` |
| `response` | string \| null | Agent response text (`null` on error) |
| `error` | string \| null | Error description (`null` on success) |
| `runtime` | string | Always `"openclaw"` |
| `durationMs` | number \| null | Agent execution time in milliseconds |
| `tokenUsage` | object \| null | Token usage breakdown (see below; null for now) |
| `toolCalls` | number \| null | Number of tool calls made (null for now) |
| `progress` | object \| null | Progress details (for `type: "progress"` callbacks) |
| `escalation` | object \| null | Escalation details (for `type: "escalation"` callbacks) |

**`tokenUsage` object** (when populated):

```json
{
  "promptTokens": 100,
  "completionTokens": 50,
  "totalTokens": 150,
  "model": "openai/gpt-4o-mini",
  "provider": "openai"
}
```

**`progress` object** (for `type: "progress"`):

```json
{ "status": "thinking", "toolName": "web_fetch", "stepNumber": 2, "message": "Searching..." }
```

**`escalation` object** (for `type: "escalation"`):

```json
{ "reason": "needs human approval", "notes": "..." }
```

**Retry strategy:** Up to 3 attempts with exponential backoff (300ms, 600ms, 1200ms). Succeeds on any 2xx status code. Callback request timeout: 30 seconds.

### Webhook Execution Flow

1. Validate HTTP method (POST only; 405 otherwise)
2. Read request body (up to 1 MB, 30s timeout)
3. Validate Bearer token (constant-time HMAC-SHA256; 401 on failure)
4. Parse JSON payload, extract required fields (400 if missing)
5. Check `stackId` against `allowFrom` list (403 if not authorized)
6. Rate-limit check by `stackId:conversationId` key (429 if exceeded)
7. Sanitize input (filter prompt injection patterns, truncate > 4000 chars)
8. Return **HTTP 202** immediately
9. Asynchronously (with 300-second timeout):
   a. Build message context (`SessionKey: magicform:<stackId>:<conversationId>`)
   b. Apply per-request overrides (workspace, configDir, allowedTools, allowedSkills)
   c. Load config overlay from `configDir`, deep-merge over base
   d. Copy bootstrap `.md` files from config dir to workspace
   e. Apply tool allowlist override
   f. Run agent
   g. POST callback to MagicForm backend (with retry)
   h. On error, POST error callback

---

## Security

### workspaceRoot Boundary

When `agents.defaults.workspaceRoot` is set, both `configDir` and `workspace` must be **relative** paths (e.g. `configs/acme-corp`, `workspaces/acme-corp`). They are resolved under `workspaceRoot`. Absolute paths, `..` traversal, and bare `.` are rejected. This prevents directory traversal attacks via webhook payloads.

```json5
{
  "agents": {
    "defaults": {
      "workspaceRoot": "/data"
    }
  }
}
```

The boundary is enforced from the **base** config before the overlay is loaded — an overlay cannot weaken its own sandbox. Both the CLI (`--config-dir`, `--workspace`) and webhook (`configDir`, `workspace` fields) are subject to this check.

### Stack ID Allowlist

```json5
{
  "channels": {
    "magicform": {
      "allowFrom": ["acme-corp", "beta-inc"]
    }
  }
}
```

Empty `allowFrom` allows all stack IDs (use with caution).

### Rate Limiting

Fixed-window rate limiter per `stackId:conversationId`, configurable via `rateLimitPerMinute` (default: 60 requests/minute). Each account gets an independent rate limiter. Memory is bounded at 10,000 tracked keys.

### Input Sanitization

The webhook handler filters known prompt injection patterns before delivery to the agent:

- `ignore [all] (previous|prior|above) (instructions|prompts)` → `[FILTERED]`
- `you are now` → `[FILTERED]`
- `system:` → `[FILTERED]`
- Special token patterns (`<|...|>`) → `[FILTERED]`
- Messages exceeding 4000 characters are truncated with `... [truncated]`

### API Key Isolation

Per-stack API keys live in isolated config directories. The base config never contains customer keys. Keys are resolved at runtime from `${VAR}` env references or secret providers.

---

## Multi-Account Support

The MagicForm channel supports multiple accounts within a single OpenClaw instance. Each account gets its own webhook route, rate limiter, and token validation.

```json5
{
  "channels": {
    "magicform": {
      "enabled": true,
      "backendUrl": "https://api.magicform.ai",
      "apiToken": "${MAGICFORM_DEFAULT_TOKEN}",
      "accounts": {
        "enterprise": {
          "backendUrl": "https://enterprise.magicform.ai",
          "apiToken": "${MAGICFORM_ENTERPRISE_TOKEN}",
          "rateLimitPerMinute": 120,
          "allowFrom": ["ent-stack-1", "ent-stack-2"]
        }
      }
    }
  }
}
```

Per-account config supports the same fields as the base channel config (except `accounts`).

**Account resolution priority:**

1. Per-account config (`channels.magicform.accounts.<id>`)
2. Base channel config (`channels.magicform`)
3. Environment variables (`MAGICFORM_API_TOKEN`, `MAGICFORM_BACKEND_URL`, `MAGICFORM_RATE_LIMIT`)
4. Hardcoded defaults

---

## Per-Stack Setup

Each MagicForm stack/account needs a **config directory** and a **workspace directory** under `workspaceRoot`.

### Directory Layout

```
/data/
  configs/
    acme-corp/
      openclaw.json       # Config overlay (provider keys, model, timeout)
      AGENTS.md           # Agent instructions
      IDENTITY.md         # Agent name/personality
      SOUL.md             # Agent values/boundaries
    beta-inc/
      openclaw.json
      AGENTS.md
  workspaces/
    acme-corp/            # Auto-provisioned; bootstrap files copied here
    beta-inc/
```

For the full list of bootstrap files and how config overlays work, see [Config Overlay](/cli/agent#config-overlay---config-dir) in the CLI reference.

### Example Per-Stack Overlay

```json5
{
  "models": {
    "providers": {
      "anthropic": { "apiKey": "${ACME_ANTHROPIC_KEY}" }
    }
  },
  "agents": {
    "defaults": {
      "model": "anthropic/claude-sonnet-4-6",
      "timeoutSeconds": 300
    }
  }
}
```

### Environment Variables

```bash
# Per-stack keys (referenced as ${ACME_OPENAI_KEY} in overlay)
export ACME_OPENAI_KEY="sk-..."
export ACME_ANTHROPIC_KEY="sk-ant-..."
```

---

## Quick Start

### 1. Set up base config

```bash
openclaw config set agents.defaults.workspaceRoot /data
openclaw config set channels.magicform.enabled true
openclaw config set channels.magicform.backendUrl "https://api.magicform.ai"
openclaw config set channels.magicform.apiToken "$MAGICFORM_API_TOKEN"
```

### 2. Create per-stack directories

```bash
mkdir -p /data/configs/acme-corp
mkdir -p /data/workspaces/acme-corp
```

Write `/data/configs/acme-corp/openclaw.json` with provider keys and model settings (see example above).

Optionally add `AGENTS.md`, `IDENTITY.md`, `SOUL.md`, etc. for per-stack agent behavior.

### 3. Test via CLI

```bash
export ACME_ANTHROPIC_KEY="sk-ant-..."

openclaw agent \
  --to magicform:acme-corp:conv1:user1 \
  --message "Hello from MagicForm" \
  --config-dir configs/acme-corp \
  --workspace workspaces/acme-corp
```

See [CLI reference](/cli/agent) for all available flags.

### 4. Test via webhook

```bash
curl -X POST http://localhost:18789/webhook/magicform \
  -H "Authorization: Bearer $MAGICFORM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello from MagicForm",
    "stackId": "acme-corp",
    "conversationId": "conv1",
    "userId": "user1",
    "configDir": "configs/acme-corp",
    "workspace": "workspaces/acme-corp"
  }'
```

Expected: HTTP 202, then async callback to MagicForm backend.

### 5. Start gateway for production

```bash
openclaw gateway start
```
