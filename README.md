# Claude Code Companion

Claude Code Companion is a Windows-first companion for Claude Code, with iOS planned after the desktop loop feels good. The first goal is not remote terminal control. The first goal is a reliable, clear, and safe status and approval loop:

```text
Claude Code on Windows
  -> Claude Code hook
  -> Windows local daemon
  -> floating desktop companion
  -> status / waiting state / approval card
  -> approve / deny / reply
  -> Claude Code continues or blocks
```

## Current Product Position

Build an ambient companion and approval layer for Claude Code:

- Windows daemon captures Claude Code hook events and normalizes session state.
- Windows floating companion shows Claude's current state and handles lightweight approvals.
- A future visual personality layer can be explored after the minimal approval overlay is reliable.
- Future iPhone app, Live Activity, and Dynamic Island mirror the same protocol after the PC path is boringly reliable.
- Future relay may allow use outside the same local network.

## Documentation Map

- [Stage Requirements](docs/stages.md): implementation stages from technical MVP to later expansion.
- [Documentation Framework](docs/documentation-framework.md): how to maintain project docs as the product evolves.
- [Protocol](docs/protocol.md): Stage 0 HTTP and hook payloads.
- [Security](docs/security.md): safety defaults, risk classification, and trust boundaries.
- [Development Setup](docs/dev-setup.md): how to run the daemon, hook, and smoke test.
- [User Guide](docs/user-guide.md): day-to-day commands for daemon, hooks, and the floating companion.
- [Desktop Companion](docs/desktop-companion.md): Electron floating window behavior and next steps.

## First Milestone

The first milestone is deliberately small:

1. Run a local daemon on Windows.
2. Register a Claude Code native `PermissionRequest` hook.
3. Send Bash and PowerShell native permission requests from the hook to the daemon.
4. Route `AskUserQuestion` through `PreToolUse` so a remote UI can answer Claude's clarifying questions.
5. Track Claude working states like `thinking`, `running_tool`, `waiting_approval`, `waiting_answer`, `done`, and `failed`.
6. Show the status and request in a Windows floating companion.
7. Return `allow`, `deny`, `always_allow`, or `answers` to Claude Code.

Everything else waits until this approval loop is boringly reliable.

## Stage 0 Quick Start

Requires Node.js 20+.

Install dependencies:

```powershell
npm install
```

```powershell
npm run smoke
```

Install or update hooks in a Claude Code target repo:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15
```

Install only status hooks or only approval hooks:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --status-only
npm run setup-hooks -- D:\Imperial\individual\week15 --approval-only
```

Remove Companion-managed hooks from a target repo:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --disable
```

Runtime switches:

```powershell
$env:CCC_BYPASS_APPROVAL_HOOK = "true"  # Claude Code uses native approval/question UI
$env:CCC_DISABLE_STATUS_HOOK = "true"   # Companion stops recording status hooks
```

Run the daemon:

```powershell
npm run daemon
```

Run the floating desktop companion:

```powershell
npm run desktop
```

Open the local approval page:

```text
http://127.0.0.1:4317/
```

The page uses realtime events from:

```text
ws://127.0.0.1:4317/ws
```

Current session state API:

```text
http://127.0.0.1:4317/sessions
```

Native approval hook:

```powershell
npm run hook:permission-request
```

Non-blocking status hook:

```powershell
npm run hook:event
```

Pairing endpoint for future iPhone clients:

```text
http://127.0.0.1:4317/pairing-token
```

Manual approval commands:

```powershell
npm run approve -- <requestId>
npm run deny -- <requestId> "Reason"
npm run answer -- <requestId> '{"Question text":"Answer label"}'
```
