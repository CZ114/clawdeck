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

Returns a small static notice page directing users to the desktop bubble.
Stage 0 originally served an inline 1,200-line approval dashboard here, but
that legacy surface has been retired — its content (pending queue, sessions,
devices, pairing token, audit events, health) now lives inside the bubble's
dashboard mode. Other clients should use `GET /ws` plus the JSON endpoints
listed below; nothing in the daemon depends on this HTML response.

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
        "modelFamily": "sonnet",
        "windowSource": "model-default",
        "windowRule": "sonnet",
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
- `waiting`
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
  "reason": "Approved from desktop companion"
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
  "reason": "Approved from desktop companion"
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
        "modelFamily": "sonnet",
        "windowSource": "model-default",
        "windowRule": "sonnet",
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
2. The `CCC_CONTEXT_WINDOW_TOKENS` env override, when local testing needs to force a single value.
3. The `CCC_MODEL_CONTEXT_WINDOWS` env override, parsed as a JSON map whose keys are exact model ids or model-id substrings.
4. A learned per-family window in `~/.claude-companion/learned-context.json`, see [Learned Context Windows](#learned-context-windows) below.
5. The `message.model` recorded for the same transcript line. Models whose id or alias contains `[1m]` / `1m` report a 1,000,000-token window.
6. Claude Code's own 1M default for Opus 4.6, Opus 4.7, and Sonnet 4.6, mirrored locally. Disabled when `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (Claude Code's own escape hatch) or `CCC_DISABLE_1M_CONTEXT=true` is set in the daemon's environment.
7. Built-in model-family defaults, currently 200,000 for Claude model families.
8. Built-in default of 200,000.

If the observed `usedTokens` value already exceeds the resolved `maxTokens`, the daemon promotes the window to 1,000,000 and reports `windowSource: "observed-overrun"`. This catches cases where the transcript records a bare model id (e.g. `claude-opus-4-7`) but the live session is running with the extended window.

#### Learned Context Windows

The daemon scans every transcript pass for two signals and persists what it learns to `~/.claude-companion/learned-context.json` (per-user, shared across projects):

- **peak-overrun**: any single transcript line whose `usedTokens > 200,000` proves the model is on a window larger than 200k. The daemon writes `window: 1000000`, `confirmedBy: "peak-overrun"` for that family.
- **compact-observed**: when a line's `usedTokens` drops below 30% of the prior running peak, and that peak is at least 50,000 tokens, the daemon treats the drop as a `/compact` event and snaps the pre-compact peak to the nearest known bucket (200,000 or 1,000,000), recording `confirmedBy: "compact-observed"`.

Keys are model families (`opus-4-7`, `sonnet-4-6`, `haiku-3-5`), so a fresh build like `claude-opus-4-7-20251115` inherits a previously learned window without needing to re-observe.

Entries are append-only / promote-only — a learned 1M is never demoted by a later weaker signal. Delete the file to reset. Explicit env overrides (priority 2 / 3) still win above the learned table when the user wants to force a value.

The model id used to derive the window is returned as `contextUsage.model`. Clients also receive `contextUsage.modelFamily`, `contextUsage.windowSource`, and `contextUsage.windowRule` so they can explain whether the value came from transcript metadata, an env override, a 1M model marker, the Claude Code 1M default, an observed overrun, or a fallback.

Example model-specific override:

```powershell
$env:CCC_MODEL_CONTEXT_WINDOWS = '{"claude-opus-4-7":1000000,"sonnet":200000}'
```

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
      "message": "Denied from desktop companion"
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
- `always_allow` -> for native `PermissionRequest`, allow and apply one entry from Claude's `permission_suggestions[]`. The desktop bubble passes `suggestionIndex` (number) so a specific suggestion is used; CLI clients that omit it fall back to the first `behavior: "allow"` suggestion.

Optional fields:

- `suggestionIndex` (number, with `always_allow` only) — index into the request's `permissionSuggestions[]`. Each suggestion is rendered as its own button in the bubble (e.g. `Always allow Read /tmp/**`); the index identifies which one the user picked.
- `answers` (object, with `answer` only) — `{ "Question text": "Selected answer" }` map.

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

## Knowledge Cards Endpoints (Stage 1.5)

All `/cards/*` and the new `/sessions/*` endpoints are loopback-only (require local request) and respond with `application/json`. Decision rationale is in [ADR-20260503-knowledge-cards](decisions/ADR-20260503-knowledge-cards.md).

### `GET /cards/today`

Returns today's deck plus the live generation status. When today has no real sessions, the daemon engages **empty-day fallback** — pulls from the wrong book + past N days. The replay metadata travels in the `replay` field.

Response:

```json
{
  "payload": {
    "schemaVersion": 1,
    "date": "2026-05-04",
    "state": "ready",
    "abstract": "## Today's title\n\nMarkdown body…",
    "focusSnapshot": "OKLCH derivations",
    "focusCoverage": 70,
    "difficultyPreference": "balanced",
    "sourceSessionIds": ["sess_a", "sess_b"],
    "sourceCounts": { "session": 4, "web": 1 },
    "stats": { "sessions": 2, "durationMin": 0 },
    "cards": [ /* see card schema below */ ],
    "generationRecord": { /* see below */ },
    "replay": null
  },
  "generation": {
    "state": "idle",
    "stage": null,
    "message": null,
    "scanned": []
  }
}
```

When the deck is replayed:

```json
"replay": {
  "engaged": true,
  "fromWrongBook": 3,
  "fromPastDays": 2,
  "lookbackDays": 7,
  "shieldUsed": false
}
```

### `GET /cards/history?limit=N`

List of past decks (default 30). Each entry is a `summarize()` of a stored `<date>.json` (or `<date>-HHMMSS.json` archive). Most-recent first.

```json
{
  "history": [
    {
      "date": "2026-05-03",
      "state": "ready",
      "abstract": "## …",
      "focusSnapshot": "…",
      "cardCount": 5,
      "answeredCount": 3,
      "correctCount": 2,
      "updatedAt": "2026-05-03T22:14:00Z",
      "isArchive": false,
      "archivedAt": null,
      "archivedFile": null,
      "generationRecord": { /* see below */ }
    }
  ]
}
```

Same-day re-generation archives the prior file as `<date>-HHMMSS.json`; archive entries have `isArchive: true` and `archivedAt: "HH:MM:SS"`.

### `GET /cards/wrong-book`

Aggregate across all dates. Cards stay until the user answers them correctly N times in a row (`easy`/`medium`: 2, `hard`: 3 — see ADR §"Decision 9").

```json
{
  "wrongBook": [
    { /* full card object incl. attempts[] + sourceDate */ }
  ],
  "count": 7
}
```

### `POST /cards/answer`

Records one attempt. Body:

```json
{
  "cardId": "card_abc",
  "picked": 2,           // index for choice cards, string for cloze
  "durationMs": 4200,    // optional
  "historyDate": "2026-04-28",   // optional — replay against an old deck
  "historyArchiveId": null
}
```

Response:

```json
{
  "ok": true,
  "correct": false,
  "replay": false,
  "answer": 1,
  "explanation": { "fromSession": true, "snippet": "…" },
  "attempts": [ { "ts": "…", "picked": 2, "correct": false } ]
}
```

### `POST /cards/generate`

Manual trigger. Body fields (all optional):

```json
{
  "focus": "OKLCH derivations",
  "difficulty": "balanced",        // "casual" | "balanced" | "deep"
  "windowDays": 1,
  "targetDate": "2026-04-28",      // backfill into a specific date file
  "cardCount": 5,                  // 1..20
  "webFallback": true,
  "transcriptBudget": 60000,       // 10k..1M chars total fed to claude -p
  "selectedSessionIds": ["sess_a"], // empty/missing = scan window; non-empty = restrict to these
  "locale": "en"                   // "en" | "zh" — selects bilingual prompt template
}
```

Returns the same shape as `/cards/today` once generation completes. First-ever call returns `403 { error: "consent_required", consentVersion: 1 }` — see `/cards/consent`.

### `GET /cards/generation-status`

Polled by the bubble's controls-strip 📚 icon to render the live progress pulse. Same shape as the `generation` field in `/cards/today`.

### `GET /cards/consent` · `POST /cards/consent`

GET returns `{ given: bool, givenAt: iso|null, consentVersion: 1 }`. POST body `{ given: true|false }` sets the flag. The first generation requires `given=true` (see ADR §"Decision 11").

### `GET /cards/streak`

Stateless walk over `cards/<date>.json` files. Returns:

```json
{
  "asOf": "2026-05-04",
  "count": 12,
  "todayState": "completed",          // "completed" | "empty" | "missing" | "in-progress"
  "todayProtected": false,            // true when today is using the 1-day shield
  "lastCompletedDate": "2026-05-04"
}
```

A "completed" day = every card has `attempts.length >= 1`. The chain allows ONE empty/missing day as a shield; a second consecutive empty day resets the streak (per ADR §"Decision 8").

### `GET /cards/export?scope=today|history|wrong-book[&date=…&archive=…]`

Returns a `.md` file with `content-disposition: attachment`. Frontmatter carries `date`, `focusSnapshot`, `difficulty mix`, `accuracy`, `streak`. Card Q/A pairs use `**Q**` / `**A**` so they convert to Anki .csv with one regex.

### `GET /sessions/scan-candidates?limit=N[&windowDays=N]`

Enumerates every Claude Code session JSONL under `~/.claude/projects/`, peeks the first ~64 KB of each for the real `cwd` + the first user message uuid (`firstUserMsgId`), and groups `claude --resume` forks by that uuid. Newest-first, capped at `limit` (clamped to `[1, 10000]`, default 20).

Each item:

```json
{
  "sessionId": "uuid",
  "cwd": "/Users/x/projects/foo",
  "lastSeenAt": "2026-05-04T10:30:00Z",
  "groupSize": 3,
  "sizeBytes": 18234,
  "preview": "fix the layout bug in main.css"
}
```

### `POST /sessions/delete`

Body `{ sessionIds: [string, ...] }`. Each matching JSONL is moved (not unlinked) into `<DATA_DIR>/trash/manual/<ts>-<id>.jsonl` so the user can recover. The bubble gates this behind the `Allow session deletion` setting; the daemon itself is loopback-only and will accept any local POST.

Response:

```json
{
  "requested": 2,
  "trashed": 2,
  "results": [
    { "sessionId": "uuid", "ok": true, "trashedPath": "C:\\…\\trash\\manual\\…jsonl" }
  ]
}
```

The generator separately auto-trashes the JSONL its own `claude -p` subprocess creates each run, into `<DATA_DIR>/trash/generator/`. Each trash category is auto-pruned to the last 50 entries.

## Persistent File Schemas (Stage 1.5)

### `<DATA_DIR>/cards/<YYYY-MM-DD>.json`

```json
{
  "schemaVersion": 1,
  "date": "2026-05-04",
  "state": "ready",                  // "ready" | "empty" | "generating"
  "abstract": "## Markdown title\n\n…",
  "focusSnapshot": "OKLCH derivations",
  "focusCoverage": 70,
  "difficultyPreference": "balanced",
  "sourceSessionIds": ["uuid1"],
  "sourceCounts": { "session": 4, "web": 1 },
  "stats": { "sessions": 2, "durationMin": 0 },
  "cards": [
    {
      "id": "card_abc",
      "type": "choice",              // "choice" | "cloze"
      "difficulty": "medium",        // "easy" | "medium" | "hard"
      "question": "…",
      "options": ["A","B","C","D"],   // choice only
      "answer": 1,                   // index for choice, string for cloze
      "source": {
        "kind": "session",           // "session" | "web"
        "sessionId": "uuid",         // or "web"
        "snippet": "verbatim quote, ≥10 chars",
        "fileRef": "src/foo.js:42",   // or full https URL for web cards
        "webTitle": "Page title"     // web only
      },
      "explanation": { "fromSession": true, "snippet": "…" },
      "attempts": [
        { "ts": "2026-05-04T11:00:00Z", "picked": 1, "correct": true, "durationMs": 3200 }
      ]
    }
  ],
  "generationRecord": {
    "generatedAt": "2026-05-04T08:00:00Z",
    "finishedAt": "2026-05-04T08:01:24Z",
    "durationMs": 84000,
    "windowDays": 1,
    "targetDate": null,
    "cardCount": 5,
    "difficulty": "balanced",
    "webFallback": true,
    "transcriptBudget": 60000,
    "selectedSessionIds": null,      // null = scan-by-window; array = explicit allowlist
    "stub": false,
    "scannedSessions": [
      { "sessionId": "uuid", "cwd": "…", "source": "indexed", "status": "included", "chars": 8200 }
    ],
    "totalCharsInPrompt": 42000,
    "cardsAccepted": 5,
    "cardsDropped": 0
  },
  "updatedAt": "2026-05-04T11:00:00Z"
}
```

Same-day overwrites archive the prior file as `<date>-HHMMSS.json` (or `<date>-HHMMSS-N.json` if multiple within the same second). All other shapes are identical.

### `<DATA_DIR>/wrong-book.json`

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "card": { /* card object */ },
      "sourceDate": "2026-05-02",
      "consecutiveCorrect": 1,
      "addedAt": "2026-05-02T22:00:00Z"
    }
  ]
}
```

A card is removed when `consecutiveCorrect` hits the per-difficulty threshold (`easy`/`medium`: 2, `hard`: 3).

### `<DATA_DIR>/cards-consent.json`

```json
{ "given": true, "givenAt": "2026-05-03T14:00:00Z", "consentVersion": 1 }
```

### `<DATA_DIR>/cards-storage-config.json`

```json
{ "schemaVersion": 1, "cardsDir": "C:\\Users\\me\\Vault\\cards", "configuredAt": "2026-05-03T14:00:00Z" }
```

User-relocated cards directory. `cardsDir` is an absolute path; daemon ignores the override if it can't write there at startup.

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
