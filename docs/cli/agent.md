---
summary: "CLI reference for `openclaw agent` (send one agent turn via the Gateway)"
read_when:
  - You want to run one agent turn from scripts (optionally deliver reply)
  - You want to use per-stack config overlays for multi-tenant setups
  - You want to control tool availability via profiles or allow/deny lists
title: "agent"
---

# `openclaw agent`

Run a single agent turn via the Gateway (use `--local` for embedded).

Related:

- Agent send tool: [Agent send](/tools/agent-send)
- MagicForm webhook integration: [MagicForm](/magicform-integration)

## Flags

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `-m, --message <text>` | Yes | — | Message body for the agent |
| `-t, --to <number>` | No* | — | Recipient number in E.164 used to derive the session key |
| `--session-id <id>` | No* | — | Use an explicit session id |
| `--agent <id>` | No | — | Agent id (overrides routing bindings) |
| `--config-dir <dir>` | No | — | Directory containing `openclaw.json` overlay + bootstrap `.md` files (relative to `workspaceRoot` when set) |
| `--workspace <dir>` | No | — | Override agent workspace directory (relative to `workspaceRoot` when set) |
| `--tools-profile <profile>` | No | — | Tool profile: `minimal`, `coding`, `messaging`, `full` |
| `--tools-allow <tools>` | No | — | Comma-separated tool allowlist (applied after profile) |
| `--tools-deny <tools>` | No | — | Comma-separated tool denylist |
| `--timeout <seconds>` | No | `600` | Override timeout in seconds (0 = no timeout) |
| `--thinking <level>` | No | — | Thinking level: `off`, `minimal`, `low`, `medium`, `high` |
| `--verbose <on\|off>` | No | — | Persist agent verbose level for the session |
| `--channel <channel>` | No | — | Delivery channel (omit to use the main session channel) |
| `--reply-to <target>` | No | — | Delivery target override (separate from session routing) |
| `--reply-channel <channel>` | No | — | Delivery channel override (separate from routing) |
| `--reply-account <id>` | No | — | Delivery account id override |
| `--local` | No | `false` | Run embedded agent locally (requires model provider API keys in shell) |
| `--deliver` | No | `false` | Send the agent's reply back to the selected channel |
| `--json` | No | `false` | Output result as JSON |

*At least one of `--to`, `--session-id`, or `--agent` is required to identify the session.

## Examples

```bash
# Start a new session by phone number
openclaw agent --to +15555550123 --message "status update"

# Use a specific agent
openclaw agent --agent ops --message "Summarize logs"

# Target a session with explicit thinking level
openclaw agent --session-id 1234 --message "Summarize inbox" --thinking medium

# Enable verbose logging and JSON output
openclaw agent --to +15555550123 --message "Trace logs" --verbose on --json

# Deliver reply to the session channel
openclaw agent --to +15555550123 --message "Summon reply" --deliver

# Send reply to a different channel/target
openclaw agent --agent ops --message "Generate report" \
  --deliver --reply-channel slack --reply-to "#reports"

# Run locally (no gateway required, needs API keys in env)
openclaw agent --agent ops --message "Quick test" --local

# Per-stack config overlay (multi-tenant)
openclaw agent \
  --to magicform:acme-corp:conv1:user1 \
  --message "Hello" \
  --config-dir configs/acme-corp \
  --workspace workspaces/acme-corp

# Restrict tools for a specific run
openclaw agent --agent ops --message "Audit" \
  --tools-profile minimal --tools-allow read,memory_search
```

## Config Overlay (`--config-dir`)

When `--config-dir` is provided, the agent command loads an `openclaw.json` overlay from that directory and deep-merges it over the base config. This enables per-customer or per-stack configuration for multi-tenant deployments.

### How it works

1. **Security check** — when `workspaceRoot` is set in base config, both `--config-dir` and `--workspace` must be **relative** paths (e.g. `stacks/acme-corp`). They are resolved under `workspaceRoot`. Absolute paths, `..` traversal, and bare `.` are rejected. The boundary is snapshotted from the base config *before* the overlay is loaded, so an overlay cannot weaken its own sandbox.
2. **Read overlay** — reads `openclaw.json` from the directory (JSON5 format; supports comments and trailing commas).
3. **Resolve env vars** — substitutes `${VAR}` references from environment variables. Only `[A-Z_][A-Z0-9_]*` patterns are recognized. Missing vars throw an error. Escape with `$${VAR}` to output a literal.
4. **Deep-merge** — applies RFC 7396 merge-patch over base config. Objects merge recursively (overlay wins). Arrays of objects with `id` fields merge by ID. `null` deletes a key. Scalars replace.
5. **Copy bootstrap files** — copies well-known `.md` files from the directory into the workspace, overwriting existing files.

### Bootstrap files

These files are copied from `--config-dir` to `--workspace` when present:

| File | Purpose |
|------|---------|
| `AGENTS.md` | Agent instructions and behavior |
| `IDENTITY.md` | Agent name, personality |
| `SOUL.md` | Agent values, boundaries, behavioral guidelines |
| `TOOLS.md` | Available tools reference |
| `USER.md` | User profile and preferences |
| `HEARTBEAT.md` | Periodic task instructions |
| `BOOTSTRAP.md` | First-run onboarding |

### Example overlay (`openclaw.json`)

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

## Tool Profiles

| Profile | Tools |
|---------|-------|
| `minimal` | `session_status` |
| `coding` | `read`, `write`, `edit`, `apply_patch`, `exec`, `process`, `memory_search`, `memory_get`, `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `subagents`, `session_status`, `cron`, `image` |
| `messaging` | `sessions_list`, `sessions_history`, `sessions_send`, `session_status`, `message` |
| `full` | All tools (no restrictions) |

**Always available** regardless of profile: `web_search`, `web_fetch`, `browser`, `canvas`, `gateway`, `nodes`, `agents_list`, `tts`

`--tools-allow` and `--tools-deny` are applied **after** the profile and after the overlay's `tools` config. Supports glob patterns (`exec*`) and groups (`group:fs`, `group:runtime`, `group:memory`, `group:sessions`, `group:ui`, `group:messaging`, `group:automation`, `group:nodes`, `group:agents`, `group:media`, `group:web`, `group:openclaw`).

## Execution Flow

1. Parse and validate `--message` (trim, reject if empty)
2. Load base `openclaw.json`, resolve secrets via gateway
3. Snapshot `workspaceRoot` from base config (security boundary)
4. Load and merge config overlay from `--config-dir` (if provided)
5. Resolve agent ID, thinking level, verbose level, timeout
6. Resolve session (load/create session entry from session store)
7. Ensure workspace directory exists, copy bootstrap files from `--config-dir`
8. Apply `--tools-*` overrides to agent entry in config
9. Build workspace skills snapshot (tool catalog filtered by profile)
10. Persist session state (skills snapshot, overrides)
11. Run agent with model fallback (tries primary model, then fallbacks)
12. Update session store with token counts
13. Deliver result (stdout, JSON, or channel delivery via `--deliver`)
