# Security

The project is an approval layer for local Claude Code actions. Security defaults should be conservative because the app can affect whether commands run on the user's development machine.

## Stage 0 Security Model

Trust boundary:

```text
Claude Code hook
  -> local Node hook script
  -> Windows daemon on 127.0.0.1
  -> desktop bubble (or future paired phone)
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
- The on-disk surface area is intentionally small: `.claude-companion/devices.json` (paired devices, hashed tokens) and `~/.claude-companion/learned-context.json` (per-family context window heuristics — model id + integer + timestamp, no transcript content).
- The user-visible on/off switch is `~/.claude-companion/disabled` (zero-byte sentinel). Each hook script checks for it at startup and returns noop. The bubble's Power button writes / removes it.
- Do not allow non-loopback approval connections unless they present a paired device token.
- Do not use wildcard CORS for the local approval API.
- Use `PermissionRequest` as the primary remote approval path. Matcher `""` covers every tool whose permission Claude Code would normally gate (Read/Edit/Write/Glob/Grep/WebFetch/MCP servers/Bash/PowerShell when not pre-approved).
- Cross-platform tool surface: `setup-hooks.js` and `setup-user-hooks.js` register `Bash` plus `PowerShell` only on Windows (`process.platform === "win32"`). On macOS / Linux they register `Bash` alone — listing `PowerShell` in `permissions.ask` or in a `PermissionRequest` matcher on a non-Windows host makes Claude Code refuse to start (no such tool registered), which would brick the entire CLI.
- Keep `PreToolUse` for preflight validation, emergency deny behavior, and the `ExitPlanMode` / `AskUserQuestion` flows where `PermissionRequest` does not fire.
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

`AskUserQuestion` and `ExitPlanMode` are exceptions. They are tool calls rather than permission dialogs, so Companion handles them with a `PreToolUse` matcher of `ExitPlanMode|AskUserQuestion`. For `AskUserQuestion`, the hook must return `permissionDecision: "allow"` together with `updatedInput.questions` and `updatedInput.answers`. For `ExitPlanMode`, the hook can `deny` from the bubble to cancel the plan, but `allow` only forwards the call — Claude Code still surfaces its native 1/2/3/4 mode picker in the terminal because Anthropic has not exposed those modes via hook ([anthropics/claude-code#14259](https://github.com/anthropics/claude-code/issues/14259)).

When the hook returns `always_allow` for `PermissionRequest`, the desktop renderer also passes `suggestionIndex` so the daemon can pick the exact `permission_suggestions[i]` the user chose; that suggestion becomes `decision.updatedPermissions`. CLI clients without a UI fall back to the first `behavior: "allow"` suggestion.

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

Runtime global toggle (without restarting Claude Code):

```powershell
type nul > %USERPROFILE%\.claude-companion\disabled    # disable
del %USERPROFILE%\.claude-companion\disabled           # re-enable
```

The desktop bubble's Power button writes / removes this sentinel; manual touch is equivalent. Each hook script reads it at startup via `isCompanionDisabled()` from `packages/shared/protocol.js` and returns noop when present.

Global hook install / uninstall:

```powershell
npm run setup-user-hooks
npm run setup-user-hooks -- --dry-run
npm run setup-user-hooks -- --uninstall
```

The installer only removes and rewrites Companion-managed hook entries. It keeps unrelated user settings intact and writes a backup before saving. `npm run doctor` checks that the installed hook commands point at existing scripts and warns when global and project-level Companion hooks are both present.

Persistent uninstall (per-project):

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --disable
```

Persistent uninstall (global): drop the `hooks` block from `~/.claude/settings.json`. Both leave unrelated Claude Code settings, plugins, and user hooks alone.

## Status Model

The status hook `packages/hooks/event.js` sends lifecycle events to `POST /hook/event` and then returns a no-op JSON response. It is allowed to fail open because it only updates display state.

Current statuses:

- `idle`
- `thinking`
- `running_tool`
- `waiting`
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

## Knowledge Cards Data Policy (Stage 1.5)

Knowledge Cards is the **first feature in this repo that intentionally feeds session transcript content to a model**. Everything below is an exception to the broader "do not surface transcripts" rule, scoped to this feature only.

### Opt-in consent

The first time a user triggers `POST /cards/generate`, the daemon returns `403 { error: "consent_required", consentVersion: 1 }`. The bubble shows a one-time modal that explains exactly what is piped + where it goes. State persists in `<DATA_DIR>/cards-consent.json`. Declining preserves prior behavior — no cards are generated, transcripts are never read.

### What is piped

The generator reads the user's `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` files. Per-session content is capped (default 12k chars, configurable via `CCC_CARDS_TRANSCRIPT_PER_SESSION`); total prompt budget is also capped (default 60k chars, configurable per-run via `transcriptBudget` body field, daemon-side clamp `[10k, 1M]`). The capped + redacted text is piped over stdin to a local `claude -p` subprocess.

### Redaction

Every transcript chunk passes through `redact()` in [packages/daemon/src/transcript-reader.js](../packages/daemon/src/transcript-reader.js) before reaching the prompt:

- Lines mentioning `.env`, `.envrc`, `secrets/`, `credentials/` paths are replaced with `(redacted: …)`
- Token-shaped strings are replaced with `(redacted: token)`:
  - `sk-ant-…` (Anthropic), `sk-…` (OpenAI), `ghp_…` / `gho_…` (GitHub), `AKIA…` (AWS), `Bearer …`
- The user's home directory + `%USERPROFILE%` + `$HOME` get replaced with `~`

### Strict-source rule (no hallucination)

Every card the model generates MUST carry a `source.snippet` containing a verbatim quote (≥10 chars) from either the piped transcript or — if `webFallback: true` and the user set a `focus` with no transcript match — a fetched web page (in which case `source.kind = "web"` + `source.fileRef = <URL>`). Cards without a verifiable source are dropped by [packages/shared/cards.js validateCard](../packages/shared/cards.js) before the deck is persisted. There is **no user toggle** for this — disabling it would let the model invent plausible-looking review questions about the user's own work, defeating the entire feature.

### Web fallback

When enabled, the generator launches `claude -p --allowedTools WebSearch,WebFetch …`. Web cards are tagged `source.kind="web"` and the question is prefixed with `(no matching session content — sourced from web)` so the user knows exactly which cards left the local transcript boundary. Disabling `Allow web fallback` in Settings → Behavior means a focus with no matching transcript content yields an empty deck rather than an external lookup.

### Session trash

Every `claude -p` run creates its own JSONL session under `~/.claude/projects/`. The daemon snapshots the projects dir before/after each run and **moves new files** into `<DATA_DIR>/trash/generator/<ts>-<id>.jsonl` so the generator's own meta-noise never feeds the next run. Manual session deletion (Settings → Behavior → "Allow session deletion" + 🗑 in Live mode) moves files into `<DATA_DIR>/trash/manual/`. Both categories are auto-pruned to the last 50 files; deletion is recoverable until prune.

### Locale + bilingual prompt

The renderer's selected locale (en/zh) is passed in the `/cards/generate` body and selects the prompt template in [packages/shared/i18n.js PROMPT_TEMPLATES](../packages/shared/i18n.js). Output natural-language card text follows the locale; **JSON keys stay English** so parsing is locale-invariant.

### Cards storage

By default `<DATA_DIR>/cards/<YYYY-MM-DD>.json`. The user can relocate via Settings → Storage → Change…; the override lives in `<DATA_DIR>/cards-storage-config.json` (NOT inside the cards dir, so changing the cards dir doesn't orphan its own pointer). The daemon validates writability at startup and silently falls back to the default if the override is broken.

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

Loopback requests from the same machine are still allowed without a token so the desktop bubble (and the manual `scripts/decide.js` CLI) remains frictionless during development.

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
