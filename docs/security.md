# Security

The project is an approval layer for local Claude Code actions. Security defaults should be conservative because the app can affect whether commands run on the user's development machine.

## Stage 0 Security Model

Trust boundary:

```text
Claude Code hook
  -> local Node hook script
  -> Windows daemon on 127.0.0.1
  -> local approval page or future paired phone
  -> Claude Code hook decision
```

There is no cloud service and no iPhone app yet.

The Electron desktop companion is a loopback-only local client of the same daemon. It does not inspect Claude Code processes, terminal memory, or transcript files directly. It only receives the session and pending-request summaries that hooks already send to the daemon.

## Defaults

- Bind the daemon to `127.0.0.1` by default.
- Fail closed when the daemon is unavailable.
- Deny pending requests after timeout.
- Do not send full command output through the protocol.
- Keep audit events local and in memory for Stage 0.
- Do not store approval history on disk yet.
- Store paired devices locally in `.claude-companion/devices.json`.
- Store only hashes of device auth tokens, not raw tokens.
- Do not allow non-loopback approval connections unless they present a paired device token.
- Do not use wildcard CORS for the local approval API.
- Use `PermissionRequest` as the primary remote approval path.
- Keep `PreToolUse` for preflight validation, emergency deny behavior, and `AskUserQuestion` answer handoff.
- Keep lifecycle status hooks non-blocking; status capture must not decide whether Claude Code may continue.
- Allow explicit local bypass switches for returning to Claude Code's native UI.
- Keep the desktop companion on `127.0.0.1` unless the daemon's paired-device LAN mode is explicitly enabled later.

## Native Permission Model

Claude Code has its own permission system with `allow`, `ask`, and `deny` rules. The companion should cooperate with that system rather than replace it.

Preferred flow:

```text
Claude Code permission rule asks for approval
  -> PermissionRequest hook fires
  -> companion shows the native request
  -> user approves, denies, or chooses always allow
  -> hook returns PermissionRequest decision.behavior
```

`PreToolUse` is useful for preflight scanning. Returning `allow` from `PreToolUse` can skip Claude Code's interactive permission prompt, so do not use it as the default remote approval surface.

`AskUserQuestion` is the exception. It is a tool call rather than a permission dialog, so Companion handles it with a targeted `PreToolUse` hook. The hook must return `permissionDecision: "allow"` together with `updatedInput.questions` and `updatedInput.answers`; returning `allow` without answers is not enough.

## Runtime Switches

Approval bypass:

```powershell
$env:CCC_BYPASS_APPROVAL_HOOK = "true"
```

When set before launching Claude Code, approval hooks return no-op JSON instead of contacting the daemon. This hands control back to Claude Code's native terminal permission/question UI. The alias `CCC_REMOTE_APPROVAL=off` has the same effect.

Status bypass:

```powershell
$env:CCC_DISABLE_STATUS_HOOK = "true"
```

When set before launching Claude Code, lifecycle status hooks return no-op JSON and do not contact the daemon. The alias `CCC_STATUS_HOOK=off` has the same effect.

These are local environment switches. They do not modify `.claude/settings.local.json`.

Persistent disable:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --disable
```

This removes Companion-managed hook entries from the target repo. It does not remove unrelated user hooks or permission rules.

## Status Model

The status hook `packages/hooks/event.js` sends lifecycle events to `POST /hook/event` and then returns a no-op JSON response. It is allowed to fail open because it only updates display state.

Current statuses:

- `idle`
- `thinking`
- `running_tool`
- `waiting_approval`
- `waiting_answer`
- `done`
- `failed`
- `blocked`

Status events should contain concise summaries only. They should not include full command output, full source files, environment variables, or transcript contents.

## Timeout Behavior

The daemon waits up to `CCC_APPROVAL_TIMEOUT_MS`, default `55000ms`.

The hook waits up to `CCC_HOOK_TIMEOUT_MS`, default `58000ms`.

The hook timeout is longer than the daemon approval timeout so the daemon can return a clean deny decision before Claude Code's hook timeout expires.

On timeout:

```text
permissionDecision = deny
reason = Timed out waiting for Claude Code Companion approval.
```

## Fail-Closed Behavior

If the daemon is not running, `packages/hooks/pre-tool-use.js` and `packages/hooks/permission-request.js` return `deny` by default.

This prevents a broken companion from silently allowing a tool call that the user expected to review.

Development override:

```powershell
$env:CCC_FAIL_OPEN = "true"
```

With this override, approval hooks return no-op JSON on daemon connection failure, allowing Claude Code's built-in approval UI to handle the request.

## Current Risk Classifier

Risk classification is intentionally simple in Stage 0. It is a UI and prioritization hint, not a complete security engine.

High-risk examples:

- `rm -rf`
- `Remove-Item -Recurse -Force`
- `sudo`
- `curl ... | sh`
- `Invoke-WebRequest ... | iex`
- `git push --force`
- recursive broad permission or ownership changes
- references to `.env` or SSH key locations
- disk/system commands like `format`, `diskpart`, `bcdedit`

Medium-risk examples:

- dependency changes like `npm install`, `pnpm add`, `pip install`
- `git push`
- raw network commands like `curl` or `wget`
- PowerShell file mutation commands

Low risk:

- No rule matched.

## Surface Data Policy

The same minimization policy applies to the local desktop companion and future phone app. The desktop surface can show more detail than a lock screen, but it still should not render full command output, source files, transcripts, environment variables, or secret contents by default.

When the iOS app arrives, show enough data to make approval meaningful:

- Tool name
- Command or concise summary
- Clarifying question text and option labels for `AskUserQuestion`
- Current status such as `thinking`, `running_tool`, or `waiting_approval`
- Working directory
- Risk level
- Risk reason
- Session id or session label
- Requested time

Do not show by default:

- Full command output
- Full source files
- Full transcript
- Environment variables
- Secret file contents

## Local Network Stage

When the daemon later binds to LAN interfaces for iPhone access:

- Require pairing before accepting decisions.
- Use a one-time pairing token. Current pairing tokens rotate after use or after roughly 10 minutes.
- Store long-lived device tokens locally.
- Allow revoking devices.
- Keep manual IP and QR pairing as fallback.
- Document Windows firewall prompts clearly.

## Current Pairing Model

Local admin flow:

```text
GET /pairing-token
  -> one-time pairingToken
POST /pair
  -> deviceId + authToken
ws://host:port/ws?token=authToken
  -> authenticated realtime connection
```

Loopback requests from the same machine are still allowed without a token so the local browser approval page remains frictionless during development.

Non-loopback requests must use a valid device token for:

- `GET /pending-requests`
- `POST /permission-decisions`
- `GET /sessions`
- `GET /events`
- `GET /ws`

`POST /hook/pre-tool-use`, `POST /hook/permission-request`, and `POST /hook/event` are local-only. Remote machines should not be able to inject fake Claude hook requests.

Paired devices can be listed with `GET /devices` and revoked with `POST /devices/revoke`; both are local-only.

## Open Questions

- Which additional tools beyond Bash, PowerShell, and AskUserQuestion should require phone interaction in Stage 1?
- Should high-risk decisions require Face ID / Touch ID on iOS?
- Should always-allow rules be scoped by workspace, command pattern, or tool?
- How much command detail is safe for Lock Screen and Live Activity views?
- Should free-text `AskUserQuestion` answers be hidden from notifications and audit history by default?
