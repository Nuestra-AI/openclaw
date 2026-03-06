# MagicForm Integration

## Overview

MagicForm integrates with OpenClaw to run agents on behalf of per-account/per-stack customers. MagicForm's backend holds LLM provider API keys per account and per stack. OpenClaw supports this through **per-stack config directories** that contain an `openclaw.json` overlay with provider credentials, model settings, and agent configuration.

Two integration modes are available:

1. **CLI mode** (`openclaw agent`) — synchronous, single-shot agent execution. See [CLI reference](/cli/agent) for the full flag reference, config overlay details, and tool profiles.
2. **Gateway mode** (webhook dispatcher) — async webhook-driven via the MagicForm channel plugin (documented below).

Both modes accept the same `--config-dir` / `config_dir` parameter pointing to a per-stack directory on disk.

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
      "backend_url": "${MAGICFORM_BACKEND_URL}",
      "api_token": "${MAGICFORM_API_TOKEN}",
      "callback_path": "/claw-agent/callback",
      "webhookPath": "/webhook/magicform",
      "dmPolicy": "open",
      "allow_from": [],
      "rateLimitPerMinute": 60
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable channel |
| `backend_url` | string | — | MagicForm backend URL for callbacks |
| `api_token` | string | — | Bearer token for webhook authentication |
| `callback_path` | string | `"/claw-agent/callback"` | Callback endpoint path appended to `backend_url` |
| `webhookPath` | string | `"/webhook/magicform"` | Inbound webhook endpoint path on the gateway |
| `dmPolicy` | string | `"open"` | Direct message policy: `open`, `allowlist`, or `disabled` |
| `allow_from` | string[] | `[]` | Stack ID allowlist (empty = allow all) |
| `rateLimitPerMinute` | number | `60` | Rate limit per `stack_id:conversation_id` |
| `accounts` | object | — | Per-account config overrides (see [Multi-Account Support](#multi-account-support)) |

### Environment Variable Fallbacks

When a field is not set in config, these environment variables are checked:

| Variable | Config field |
|----------|-------------|
| `MAGICFORM_API_TOKEN` | `api_token` |
| `MAGICFORM_BACKEND_URL` | `backend_url` |
| `MAGICFORM_RATE_LIMIT` | `rateLimitPerMinute` |

### Target Format

Session keys: `magicform:<stack_id>:<conversation_id>`

Target fields: `<stack_id>:<conversation_id>[:<user_id>]`

### Security Warnings

The plugin logs warnings when:
- `api_token` not configured — webhook will reject all requests
- `backend_url` not configured — bot cannot send callback responses
- `dmPolicy="open"` with empty `allow_from` — allows any stack to message the bot

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

### Inbound Webhook Payload

```json
{
  "message": "user prompt text",
  "stack_id": "acme-corp",
  "conversation_id": "conv-123",
  "user_id": "user-456",
  "user_name": "Jane Doe",

  "config_dir": "/data/configs/acme-corp",
  "workspace": "/data/workspaces/acme-corp",

  "tools_profile": "coding",
  "tools_allow": ["read", "write", "exec"],
  "tools_deny": ["cron"],

  "metadata": {}
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | User message body (max 4000 chars after sanitization) |
| `stack_id` | string | Yes | MagicForm stack identifier |
| `conversation_id` | string | Yes | Conversation identifier |
| `user_id` | string | No | User identifier |
| `user_name` | string | No | Display name (falls back to `user_id` or "unknown") |
| `config_dir` | string | No | Per-stack config directory path (see [Config Overlay](/cli/agent#config-overlay---config-dir)) |
| `workspace` | string | No | Per-stack workspace directory path |
| `tools_profile` | string | No | Tool profile override (see [Tool Profiles](/cli/agent#tool-profiles)) |
| `tools_allow` | string[] | No | Tool allowlist (supports glob patterns and groups) |
| `tools_deny` | string[] | No | Tool denylist (supports glob patterns and groups) |
| `metadata` | object | No | Pass-through metadata (echoed in callback) |

**Request limits:**

- Max body size: 1 MB (1,048,576 bytes)
- Read timeout: 30 seconds
- All string fields are trimmed; empty required fields are rejected

### Authentication

```
Authorization: Bearer <api_token>
```

The `api_token` must match `channels.magicform.api_token` (or the per-account override). Token validation uses constant-time HMAC-SHA256 comparison to prevent timing attacks.

### Response

The webhook returns **HTTP 202 Accepted** immediately with `{ "ok": true }`. The agent response is delivered asynchronously via callback.

### Callback Payload (OpenClaw to MagicForm)

```
POST <backend_url><callback_path>
Authorization: Bearer <api_token>
Content-Type: application/json
```

**Success:**

```json
{
  "stack_id": "acme-corp",
  "conversation_id": "conv-123",
  "user_id": "user-456",
  "response": "Agent response text...",
  "status": "success",
  "metadata": {}
}
```

**Error:**

```json
{
  "stack_id": "acme-corp",
  "conversation_id": "conv-123",
  "user_id": "user-456",
  "response": "",
  "status": "error",
  "error": "Error description",
  "metadata": {}
}
```

`user_id` and `metadata` are only included when present in the original webhook request.

**Retry strategy:** Up to 3 attempts with exponential backoff (300ms, 600ms, 1200ms). Succeeds on any 2xx status code. Callback request timeout: 30 seconds.

### Webhook Execution Flow

1. Validate HTTP method (POST only; 405 otherwise)
2. Read request body (up to 1 MB, 30s timeout)
3. Validate Bearer token (constant-time HMAC-SHA256; 401 on failure)
4. Parse JSON payload, extract required fields (400 if missing)
5. Check `stack_id` against `allow_from` list (403 if not authorized)
6. Rate-limit check by `stack_id:conversation_id` key (429 if exceeded)
7. Sanitize input (filter prompt injection patterns, truncate > 4000 chars)
8. Return **HTTP 202** immediately
9. Asynchronously (with 300-second timeout):
   a. Build message context (`SessionKey: magicform:<stack_id>:<conversation_id>`)
   b. Apply per-request overrides (workspace, config-dir, tools)
   c. Load config overlay from `config_dir`, deep-merge over base
   d. Copy bootstrap `.md` files from config dir to workspace
   e. Apply tool profile/allow/deny overrides
   f. Run agent
   g. POST callback to MagicForm backend (with retry)
   h. On error, POST error callback

---

## Security

### workspaceBaseDir Boundary

When `agents.defaults.workspaceBaseDir` is set, both `config_dir` and `workspace` must resolve under it. This prevents directory traversal attacks via webhook payloads.

```json5
{
  "agents": {
    "defaults": {
      "workspaceBaseDir": "/data"
    }
  }
}
```

The boundary is enforced from the **base** config before the overlay is loaded — an overlay cannot weaken its own sandbox. Both the CLI (`--config-dir`, `--workspace`) and webhook (`config_dir`, `workspace` fields) are subject to this check.

### Stack ID Allowlist

```json5
{
  "channels": {
    "magicform": {
      "allow_from": ["acme-corp", "beta-inc"]
    }
  }
}
```

Empty `allow_from` allows all stack IDs (use with caution).

### Rate Limiting

Fixed-window rate limiter per `stack_id:conversation_id`, configurable via `rateLimitPerMinute` (default: 60 requests/minute). Each account gets an independent rate limiter. Memory is bounded at 10,000 tracked keys.

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
      "backend_url": "https://api.magicform.ai",
      "api_token": "${MAGICFORM_DEFAULT_TOKEN}",
      "accounts": {
        "enterprise": {
          "backend_url": "https://enterprise.magicform.ai",
          "api_token": "${MAGICFORM_ENTERPRISE_TOKEN}",
          "rateLimitPerMinute": 120,
          "allow_from": ["ent-stack-1", "ent-stack-2"]
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

Each MagicForm stack/account needs a **config directory** and a **workspace directory** under `workspaceBaseDir`.

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
openclaw config set agents.defaults.workspaceBaseDir /data
openclaw config set channels.magicform.enabled true
openclaw config set channels.magicform.backend_url "https://api.magicform.ai"
openclaw config set channels.magicform.api_token "$MAGICFORM_API_TOKEN"
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
  --config-dir /data/configs/acme-corp \
  --workspace /data/workspaces/acme-corp
```

See [CLI reference](/cli/agent) for all available flags.

### 4. Test via webhook

```bash
curl -X POST http://localhost:18789/webhook/magicform \
  -H "Authorization: Bearer $MAGICFORM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello from MagicForm",
    "stack_id": "acme-corp",
    "conversation_id": "conv1",
    "user_id": "user1",
    "config_dir": "/data/configs/acme-corp",
    "workspace": "/data/workspaces/acme-corp"
  }'
```

Expected: HTTP 202, then async callback to MagicForm backend.

### 5. Start gateway for production

```bash
openclaw gateway start
```
