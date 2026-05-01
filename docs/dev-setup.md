# Development Setup

The daemon and hook scripts require Node.js 20 or newer. The Windows floating companion uses Electron as a development dependency.

## Requirements

- Windows 11
- Git
- Node.js 20+
- Claude Code

Check Node:

```powershell
node --version
```

Install dependencies:

```powershell
npm install
```

## Run The Daemon

From the repo root:

```powershell
npm run daemon
```

Default URL:

```text
http://127.0.0.1:4317
```

Local approval page:

```text
http://127.0.0.1:4317/
```

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:4317/health
```

## Run The Smoke Test

In a separate terminal, or with no daemon already running:

```powershell
npm run smoke
```

The smoke test starts a daemon on port `54317`, invokes the status hook, the PreToolUse hook, and the native PermissionRequest hook, approves or answers through the decision endpoint, and verifies Claude Code would receive valid decisions and session states.

## Manual Approval Flow

Terminal 1:

```powershell
npm run daemon
```

Open the local approval page:

```text
http://127.0.0.1:4317/
```

When Claude Code creates a pending request, the page shows the current Claude status, tool, command summary, working directory, risk level, reason, and Approve/Deny buttons.

The page uses WebSocket realtime updates at:

```text
ws://127.0.0.1:4317/ws
```

If the WebSocket disconnects, it falls back to polling `GET /sessions` and `GET /pending-requests`.

## Run The Floating Desktop Companion

Terminal 1:

```powershell
npm run daemon
```

Terminal 2:

```powershell
npm run desktop
```

The desktop companion is a transparent always-on-top Electron island. It connects only to the local daemon at:

```text
ws://127.0.0.1:4317/ws
```

It shows a compact status emoji and state label, then expands into an approval or answer panel when Claude needs input. The controls are:

- `>` opens the local browser dashboard.
- `r` refreshes daemon state.
- `-` minimizes the window.
- `x` closes the desktop companion.

The window does not start or stop Claude Code. It is another local client of the daemon, so the terminal remains the source of truth and Claude Code's native UI still works when the Companion approval hook is bypassed.

The daemon also prints fallback commands:

```powershell
node scripts/decide.js approve req_abc
node scripts/decide.js deny req_abc
```

Fallback CLI approval from Terminal 2:

```powershell
npm run approve -- req_abc
```

or:

```powershell
npm run deny -- req_abc "Not safe"
```

Answer a pending `AskUserQuestion` request from the CLI:

```powershell
npm run answer -- req_abc '{"Which implementation should I use?":"Simple"}'
```

## Configure Claude Code Hooks

For the real approval product path, use Claude Code's native `PermissionRequest` hook plus Companion's non-blocking status hook. Install or update the target repo from the Companion repo:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15
```

The setup command creates or merges:

- `permissions.ask`: `Bash`, `PowerShell`
- `permissions.deny`: `.env` and `secrets/**` reads
- lifecycle status hooks for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, and `Stop`
- native approval hook for `PermissionRequest`
- answer hook for `AskUserQuestion`

It preserves unrelated existing settings and hook entries. To preview the generated settings without writing:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --dry-run
```

Install only one side of Companion:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --status-only
npm run setup-hooks -- D:\Imperial\individual\week15 --approval-only
```

`--status-only` removes Companion-managed approval hooks and leaves Claude Code's native permission UI in charge. `--approval-only` removes Companion-managed lifecycle status hooks but keeps remote approval and `AskUserQuestion` answer support.

Remove all Companion-managed hooks from the target repo:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --disable
```

`--disable` removes hook entries that point to Companion's `event.js`, `pre-tool-use.js`, or `permission-request.js`. It keeps unrelated Claude Code settings and user-managed hooks.

The example asks for Bash and PowerShell commands, forwards Claude's native permission request to Companion, routes `AskUserQuestion` through the answer flow, and sends non-blocking status events to Companion.

The hook groups in the example are:

- `UserPromptSubmit` -> `packages/hooks/event.js` for `thinking`
- `PreToolUse` with matcher `*` -> `packages/hooks/event.js` for `running_tool`
- `PreToolUse` with matcher `AskUserQuestion` -> `packages/hooks/pre-tool-use.js` for `waiting_answer`
- `PermissionRequest` with matcher `Bash|PowerShell` -> `packages/hooks/permission-request.js` for `waiting_approval`
- `PostToolUse` -> `packages/hooks/event.js` for returning to `thinking`
- `PostToolUseFailure` -> `packages/hooks/event.js` for `failed`
- `Notification` -> `packages/hooks/event.js` for waiting hints
- `Stop` -> `packages/hooks/event.js` for `done`

The core approval portion looks like this:

```json
{
  "permissions": {
    "ask": [
      "Bash",
      "PowerShell"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "timeout": 60,
            "statusMessage": "Waiting for Claude Code Companion answer",
            "command": "node \"D:/Imperial/individual/claude-code-companion/packages/hooks/pre-tool-use.js\""
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [
          {
            "type": "command",
            "timeout": 60,
            "statusMessage": "Waiting for Claude Code Companion approval",
            "command": "node \"D:/Imperial/individual/claude-code-companion/packages/hooks/permission-request.js\""
          }
        ]
      }
    ]
  }
}
```

Then run Claude Code from the repo root and ask it to run a harmless command. The daemon should show a pending request.

`PermissionRequest` is the preferred approval path for tool permissions because it fires at Claude Code's native permission dialog. `PreToolUse` is still used for `AskUserQuestion`, where the hook must return `updatedInput.answers`.

`packages/hooks/event.js` is intentionally non-blocking. If the daemon is down, Claude Code should continue; only the approval hooks fail closed.

## Environment Variables

```text
CCC_PORT=4317
CCC_HOST=127.0.0.1
CCC_APPROVAL_TIMEOUT_MS=55000
CCC_HOOK_TIMEOUT_MS=58000
CCC_FAIL_OPEN=false
CCC_BYPASS_APPROVAL_HOOK=false
CCC_DISABLE_STATUS_HOOK=false
CCC_DATA_DIR=.claude-companion
```

Use `CCC_FAIL_OPEN=true` only while debugging. The default is fail-closed.

Runtime switches:

```powershell
$env:CCC_BYPASS_APPROVAL_HOOK = "true"
```

With this set before launching Claude Code, `permission-request.js` and `pre-tool-use.js` return no-op hook JSON. Claude Code keeps its native terminal approval/question behavior, while status hooks can still run.

```powershell
$env:CCC_DISABLE_STATUS_HOOK = "true"
```

With this set before launching Claude Code, `event.js` returns no-op hook JSON and does not update Companion session status.

Aliases:

```text
CCC_REMOTE_APPROVAL=off
CCC_STATUS_HOOK=off
```

## Pairing Token Flow

The daemon now has a pairing model for future iPhone connections. Local browser approval still works without a token on `127.0.0.1`.

Get a one-time pairing token:

```powershell
$pairing = Invoke-RestMethod http://127.0.0.1:4317/pairing-token
$pairing.pairingToken
```

Pair a test device:

```powershell
$body = @{
  pairingToken = $pairing.pairingToken
  deviceName = "Test iPhone"
} | ConvertTo-Json

$device = Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:4317/pair `
  -ContentType "application/json" `
  -Body $body

$device.authToken
```

Use the token for future remote-style connections:

```text
ws://127.0.0.1:4317/ws?token=<authToken>
```

List paired devices:

```powershell
Invoke-RestMethod http://127.0.0.1:4317/devices
```

Revoke a device:

```powershell
$body = @{ deviceId = $device.deviceId } | ConvertTo-Json
Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:4317/devices/revoke `
  -ContentType "application/json" `
  -Body $body
```

## Troubleshooting

If every Bash or PowerShell command is denied:

1. Make sure `npm run daemon` is running.
2. Check that Claude Code started from the repo root.
3. Check `.claude/settings.local.json`.
4. Temporarily set `CCC_FAIL_OPEN=true` if you need Claude Code's normal permission UI while debugging.

If the hook cannot find the script:

- Run `npm run setup-hooks -- <target-repo>` again from the Companion repo.
- Keep quotes around hook script paths if you edit `.claude/settings.local.json` manually.

If port `4317` is busy, the daemon now exits with a `[error] Port 4317 ... is already in use` message instead of an unhandled `EADDRINUSE` stack trace. The most common cause is an older daemon process still running. Stop it on Windows:

```powershell
Get-NetTCPConnection -LocalPort 4317 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Or move the new daemon to a different port and use the same `CCC_PORT` when launching Claude Code so the hook talks to the right daemon:

```powershell
$env:CCC_PORT = "4318"
npm run daemon
```
