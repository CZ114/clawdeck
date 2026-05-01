# Protocol

This document describes the Stage 0 local protocol between Claude Code hooks, the Windows daemon, and temporary manual approval tools. The iOS protocol will build on these event shapes.

There are three hook roles:

- `PreToolUse`: preflight validation before a tool runs. This can deny, ask, or allow before Claude Code's normal permission flow.
- `PermissionRequest`: native Claude Code permission handoff. This fires when Claude Code is about to show its own permission dialog, and is the primary path for remote phone approval.
- `event`: non-blocking status capture for lifecycle hooks such as `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, and `Stop`.

## Versioning

Current protocol version: `1`

Every durable event should include:

- `protocolVersion`
- `type`
- `createdAt`
- `requestId` or `eventId` where applicable
- `sessionId` where applicable

## Claude Code Hook Input

Claude Code sends hook JSON to hook scripts on stdin. The scripts forward the JSON to the local daemon.

Example:

```json
{
  "session_id": "sess_abc",
  "transcript_path": "C:/Users/example/.claude/projects/session.jsonl",
  "cwd": "C:/project/frontend",
  "permission_mode": "default",
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test"
  }
}
```

Native permission request example:

```json
{
  "session_id": "sess_abc",
  "transcript_path": "C:/Users/example/.claude/projects/session.jsonl",
  "cwd": "C:/project/frontend",
  "permission_mode": "default",
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test",
    "description": "Run tests"
  },
  "permission_suggestions": [
    {
      "type": "addRules",
      "rules": [{ "toolName": "Bash", "ruleContent": "npm test" }],
      "behavior": "allow",
      "destination": "localSettings"
    }
  ]
}
```

Windows PowerShell native permission requests use the same shape with `tool_name: "PowerShell"`:

```json
{
  "hook_event_name": "PermissionRequest",
  "tool_name": "PowerShell",
  "tool_input": {
    "command": "New-Item -ItemType Directory -Path \"D:\\Imperial\\individual\\week14\\test\" -Force",
    "description": "Create test folder"
  }
}
```

`AskUserQuestion` uses `PreToolUse` because it is a tool call that needs user input before execution:

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "AskUserQuestion",
  "tool_input": {
    "questions": [
      {
        "question": "Which implementation should I use?",
        "header": "Impl",
        "options": [
          { "label": "Simple", "description": "Use the smallest working path" },
          { "label": "Robust", "description": "Build extra validation now" }
        ],
        "multiSelect": false
      }
    ]
  }
}
```

## Daemon Endpoints

### `GET /`

Returns the Stage 0 local approval web page. The page connects to `GET /ws` for realtime events and falls back to polling `GET /pending-requests` when the socket is disconnected.

This page is a local developer approval surface only. It is not a replacement for the future iPhone app.

### `GET /ws`

Upgrades to a WebSocket connection for realtime local events. This is the first version of the event stream that the future iPhone app can use.

Auth:

- Loopback connections from the same machine are allowed for local development.
- Non-loopback connections must pass a paired device token as `ws://host:port/ws?token=...` or an `Authorization: Bearer ...` header.

Server -> client `hello`:

```json
{
  "protocolVersion": 1,
  "type": "hello",
  "eventId": "evt_abc",
  "createdAt": "2026-05-01T10:00:00.000Z",
  "service": "claude-code-companion-daemon",
  "device": {
    "deviceId": "local",
    "deviceName": "Local browser"
  },
  "sessions": [],
  "requests": []
}
```

Server -> client `permission_request`:

```json
{
  "protocolVersion": 1,
  "type": "permission_request",
  "eventId": "evt_abc",
  "createdAt": "2026-05-01T10:00:00.000Z",
  "request": {
    "protocolVersion": 1,
    "type": "permission_request",
    "requestId": "req_abc",
    "sessionId": "sess_abc",
    "tool": "Bash",
    "summary": "npm test",
    "risk": "low",
    "reason": "No high-risk rule matched"
  }
}
```

Server -> client `pending_requests_snapshot`:

```json
{
  "protocolVersion": 1,
  "type": "pending_requests_snapshot",
  "eventId": "evt_abc",
  "createdAt": "2026-05-01T10:00:00.000Z",
  "requests": []
}
```

Server -> client `session_states_snapshot`:

```json
{
  "protocolVersion": 1,
  "type": "session_states_snapshot",
  "eventId": "evt_abc",
  "createdAt": "2026-05-01T10:00:00.000Z",
  "sessions": [
    {
      "protocolVersion": 1,
      "type": "session_state",
      "sessionId": "sess_abc",
      "status": "waiting_approval",
      "cwd": "C:/project/frontend",
      "transcriptPath": "C:/Users/example/.claude/projects/session.jsonl",
      "permissionMode": "default",
      "hookEventName": "PermissionRequest",
      "tool": "Bash",
      "summary": "npm test",
      "requestId": "req_abc",
      "risk": "low",
      "reason": "No high-risk rule matched",
      "decision": null,
      "contextUsage": {
        "usedTokens": 31574,
        "maxTokens": 200000,
        "percent": 16,
        "label": "31.6k / 200k",
        "model": "claude-sonnet-4-6",
        "source": "transcript"
      },
      "sequence": 12,
      "createdAt": "2026-05-01T09:59:58.000Z",
      "updatedAt": "2026-05-01T10:00:00.000Z"
    }
  ]
}
```

Current status values:

- `idle`
- `thinking`
- `running_tool`
- `waiting_approval`
- `waiting_answer`
- `done`
- `failed`
- `blocked`

Client -> server `permission_decision`:

```json
{
  "type": "permission_decision",
  "requestId": "req_abc",
  "decision": "allow",
  "reason": "Approved from local web UI"
}
```

Client -> server answer for `AskUserQuestion`:

```json
{
  "type": "permission_decision",
  "requestId": "req_abc",
  "decision": "answer",
  "reason": "Answered from iPhone",
  "answers": {
    "Which implementation should I use?": "Simple"
  }
}
```

Server -> client `permission_decision_result`:

```json
{
  "protocolVersion": 1,
  "type": "permission_decision_result",
  "eventId": "evt_abc",
  "createdAt": "2026-05-01T10:00:00.000Z",
  "ok": true,
  "requestId": "req_abc",
  "decision": "allow",
  "reason": "Approved from local web UI"
}
```

Server -> client `error`:

```json
{
  "protocolVersion": 1,
  "type": "error",
  "eventId": "evt_abc",
  "createdAt": "2026-05-01T10:00:00.000Z",
  "error": "No pending request found for req_abc"
}
```

### `GET /health`

Returns daemon status.

```json
{
  "ok": true,
  "protocolVersion": 1,
  "service": "claude-code-companion-daemon",
  "pendingRequests": 0,
  "sessions": 1,
  "port": 4317,
  "host": "127.0.0.1",
  "localAddresses": ["192.168.1.23"]
}
```

### `GET /sessions`

Returns the latest known status for each Claude Code session. This endpoint uses the same auth rules as `GET /pending-requests`.

```json
{
  "sessions": [
    {
      "protocolVersion": 1,
      "type": "session_state",
      "sessionId": "sess_abc",
      "status": "thinking",
      "cwd": "C:/project/frontend",
      "transcriptPath": "C:/Users/example/.claude/projects/session.jsonl",
      "permissionMode": "default",
      "hookEventName": "PostToolUse",
      "tool": "Read",
      "summary": "Read: C:/project/frontend/README.md",
      "requestId": null,
      "risk": null,
      "reason": null,
      "decision": null,
      "contextUsage": {
        "usedTokens": 31574,
        "maxTokens": 200000,
        "percent": 16,
        "label": "31.6k / 200k",
        "model": "claude-sonnet-4-6",
        "source": "transcript"
      },
      "sequence": 8,
      "createdAt": "2026-05-01T10:00:00.000Z",
      "updatedAt": "2026-05-01T10:00:10.000Z"
    }
  ]
}
```

`contextUsage` is best-effort. The daemon reads the latest assistant `usage` block from `transcriptPath`, or reconstructs the transcript path from `cwd` and `sessionId` when Windows shell encoding damages a non-ASCII user path. The current estimate uses:

```text
input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens
```

`maxTokens` is resolved in this order:

1. Explicit `usage.context_window_tokens` / `usage.max_context_tokens` field if Claude ever supplies one.
2. The `message.model` recorded for the same transcript line. Models whose id contains the `[1m]` suffix (e.g. `claude-opus-4-7[1m]`) report a 1,000,000-token window. All other current Claude 3.x / 4.x models report 200,000.
3. The `CCC_CONTEXT_WINDOW_TOKENS` env override.
4. Built-in default of 200,000.

The model id used to derive the window is also returned as `contextUsage.model` so clients can display it.

### `GET /pairing-token`

Returns the current one-time pairing token. This endpoint is local-only.

```json
{
  "protocolVersion": 1,
  "type": "pairing_token",
  "pairingToken": "pair_...",
  "expiresAt": "2026-05-01T10:10:00.000Z",
  "createdAt": "2026-05-01T10:00:00.000Z",
  "service": "claude-code-companion-daemon",
  "connect": {
    "host": "127.0.0.1",
    "port": 4317,
    "localAddresses": ["192.168.1.23"],
    "websocketPath": "/ws"
  }
}
```

### `POST /pair`

Exchanges a one-time pairing token for a long-lived device token.

Request:

```json
{
  "pairingToken": "pair_...",
  "deviceName": "Isaac's iPhone"
}
```

Response:

```json
{
  "protocolVersion": 1,
  "type": "paired_device",
  "deviceId": "dev_...",
  "deviceName": "Isaac's iPhone",
  "authToken": "devtok_..."
}
```

Store `authToken` securely on the client. The daemon stores only a hash of the token.

### `GET /devices`

Lists paired devices. This endpoint is local-only.

```json
{
  "devices": [
    {
      "deviceId": "dev_...",
      "deviceName": "Isaac's iPhone",
      "createdAt": "2026-05-01T10:00:00.000Z",
      "lastSeenAt": "2026-05-01T10:05:00.000Z",
      "revokedAt": null
    }
  ]
}
```

### `POST /devices/revoke`

Revokes a paired device. This endpoint is local-only.

Request:

```json
{
  "deviceId": "dev_..."
}
```

### `POST /hook/pre-tool-use`

Called by the hook script. The request body is the raw Claude Code hook input.

The daemon creates a pending approval request, waits for a decision, then responds with Claude Code `PreToolUse` hook JSON.

Allow response:

```json
{
  "protocolVersion": 1,
  "suppressOutput": true,
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Smoke test approved"
  }
}
```

Deny response:

```json
{
  "protocolVersion": 1,
  "suppressOutput": true,
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Timed out waiting for Claude Code Companion approval."
  }
}
```

`AskUserQuestion` answer response:

```json
{
  "protocolVersion": 1,
  "suppressOutput": true,
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow",
    "permissionDecisionReason": "Answered from iPhone",
    "updatedInput": {
      "questions": [
        {
          "question": "Which implementation should I use?",
          "header": "Impl",
          "options": [
            { "label": "Simple", "description": "Use the smallest working path" },
            { "label": "Robust", "description": "Build extra validation now" }
          ],
          "multiSelect": false
        }
      ],
      "answers": {
        "Which implementation should I use?": "Simple"
      }
    }
  }
}
```

### `POST /hook/permission-request`

Called by `packages/hooks/permission-request.js`. The request body is the raw Claude Code `PermissionRequest` hook input.

The daemon creates a pending native permission request, waits for a decision, then responds with Claude Code `PermissionRequest` hook JSON.

Allow response:

```json
{
  "protocolVersion": 1,
  "suppressOutput": true,
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow"
    }
  }
}
```

Always-allow response, when the UI decision is `always_allow` and Claude supplied an allow suggestion:

```json
{
  "protocolVersion": 1,
  "suppressOutput": true,
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "allow",
      "updatedPermissions": [
        {
          "type": "addRules",
          "rules": [{ "toolName": "Bash", "ruleContent": "npm test" }],
          "behavior": "allow",
          "destination": "localSettings"
        }
      ]
    }
  }
}
```

Deny response:

```json
{
  "protocolVersion": 1,
  "suppressOutput": true,
  "hookSpecificOutput": {
    "hookEventName": "PermissionRequest",
    "decision": {
      "behavior": "deny",
      "message": "Denied from local web UI"
    }
  }
}
```

### `POST /hook/event`

Called by `packages/hooks/event.js`. This endpoint records non-blocking Claude Code lifecycle events and updates the session state model. It returns only a small acknowledgement for the hook script; the hook script itself prints a no-op JSON response so Claude Code continues normally.

Example input:

```json
{
  "session_id": "sess_abc",
  "transcript_path": "C:/Users/example/.claude/projects/session.jsonl",
  "cwd": "C:/project/frontend",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "Run the test suite"
}
```

Example response:

```json
{
  "ok": true,
  "state": {
    "protocolVersion": 1,
    "type": "session_state",
    "sessionId": "sess_abc",
    "status": "thinking",
    "summary": "Run the test suite"
  }
}
```

### `GET /pending-requests`

Temporary Stage 0 endpoint for manual approval tools and smoke tests.

Auth:

- Loopback requests are allowed for local development.
- Non-loopback requests must send `Authorization: Bearer <authToken>` or `?token=<authToken>`.

```json
{
  "requests": [
    {
      "protocolVersion": 1,
      "type": "permission_request",
      "requestId": "req_abc",
      "sessionId": "sess_abc",
      "transcriptPath": "C:/Users/example/.claude/projects/session.jsonl",
      "cwd": "C:/project/frontend",
      "permissionMode": "default",
      "tool": "Bash",
      "toolInput": {
        "command": "npm test"
      },
      "questions": [],
      "summary": "npm test",
      "risk": "low",
      "reason": "No high-risk rule matched",
      "createdAt": "2026-04-29T10:00:00.000Z",
      "timeoutMs": 55000
    }
  ]
}
```

### `POST /permission-decisions`

Temporary Stage 0 endpoint for submitting approval decisions.

Auth:

- Loopback requests are allowed for local development.
- Non-loopback requests must send `Authorization: Bearer <authToken>` or `?token=<authToken>`.

Request:

```json
{
  "requestId": "req_abc",
  "decision": "allow",
  "reason": "Approved from manual CLI"
}
```

Supported decision aliases:

- `approve` or `allow` -> Claude Code `allow`
- `deny` or `block` -> Claude Code `deny`
- `ask` -> Claude Code `ask`
- `answer` -> for `AskUserQuestion`, return `allow` with `updatedInput.questions` and `updatedInput.answers`
- `always_allow` -> for native `PermissionRequest`, allow and apply Claude's first allow suggestion when available

Response:

```json
{
  "ok": true,
  "requestId": "req_abc",
  "decision": "allow",
  "reason": "Approved from manual CLI"
}
```

### `GET /events`

Returns the last 100 local audit events. This is only a developer aid in Stage 0.

## Hook Failure Behavior

The command hooks are fail-closed by default.

If the `PreToolUse` hook cannot reach the daemon, it returns:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Companion daemon unavailable..."
  }
}
```

For local experimentation only, set:

```powershell
$env:CCC_FAIL_OPEN = "true"
```

In that mode, approval hooks return no-op JSON when the daemon is unavailable, falling back to Claude Code's own approval or question UI.

To bypass remote approval even while the daemon is running:

```powershell
$env:CCC_BYPASS_APPROVAL_HOOK = "true"
```

The alias `CCC_REMOTE_APPROVAL=off` has the same effect.

If the `PermissionRequest` hook cannot reach the daemon and fail-open/bypass is not enabled, it returns a native deny decision. There is no remote approval handoff without the daemon.

The status hook is always display-only. To disable status capture:

```powershell
$env:CCC_DISABLE_STATUS_HOOK = "true"
```

## Future iOS Event Mapping

The iOS app should connect to `/ws`, listen for `session_states_snapshot`, `permission_request`, and `pending_requests_snapshot`, and reply with `permission_decision`.

The permission request payload can reuse the pending request object directly:

```json
{
  "protocolVersion": 1,
  "type": "permission_request",
  "requestId": "req_abc",
  "sessionId": "sess_abc",
  "tool": "Bash",
  "summary": "npm test",
  "risk": "low",
  "reason": "No high-risk rule matched"
}
```

The iOS app should reply with the same decision payload used by `POST /permission-decisions`. For `AskUserQuestion`, it must send `decision: "answer"` and an `answers` object keyed by the original question text.
