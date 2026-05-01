# User Guide

This guide is for day-to-day local development use on Windows.

## One-Time Setup

From the Companion repo:

```powershell
cd D:\Imperial\individual\claude-code-companion
npm install
npm run smoke
```

Install or update Claude Code hooks in a target repo:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15
```

This installs:

- status hooks for Claude working state
- native `PermissionRequest` approval for Bash and PowerShell
- `AskUserQuestion` answer support
- conservative deny rules for `.env`, `.env.*`, and `secrets/**`

## Normal Run

Terminal 1:

```powershell
cd D:\Imperial\individual\claude-code-companion
npm run daemon
```

Terminal 2:

```powershell
cd D:\Imperial\individual\claude-code-companion
npm run desktop
```

Terminal 3:

```powershell
cd D:\Imperial\individual\week15
claude
```

When Claude Code asks to run a Bash or PowerShell command, the floating companion shows an approval card. Use `Approve`, `Deny`, or `Always Allow` when Claude supplies a native permission suggestion.

When Claude asks a clarifying question through `AskUserQuestion`, the floating companion shows answer options or a text field.

## Local Browser Dashboard

The daemon also serves a local web dashboard:

```text
http://127.0.0.1:4317/
```

The desktop companion's `>` control opens this dashboard.

## Temporary Switches

Return approval and questions to Claude Code's native terminal UI before launching Claude Code:

```powershell
$env:CCC_BYPASS_APPROVAL_HOOK = "true"
```

Disable only Companion status capture before launching Claude Code:

```powershell
$env:CCC_DISABLE_STATUS_HOOK = "true"
```

Both switches are runtime-only. They do not edit `.claude/settings.local.json`.

## Persistent Disable

Remove all Companion-managed hooks from a target repo:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --disable
```

This preserves unrelated Claude Code settings and user-managed hooks.

## Partial Modes

Status only:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --status-only
```

Approval only:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --approval-only
```

## Safety Notes

- The daemon binds to `127.0.0.1` by default.
- Approval hooks fail closed unless `CCC_FAIL_OPEN=true` is set for debugging.
- Status hooks are display-only and fail open.
- The desktop companion is only a local client of the daemon. It does not capture the terminal process directly.

## Troubleshooting

If the desktop window says `daemon offline`, start the daemon:

```powershell
npm run daemon
```

If Claude Code still shows its native approval UI, confirm the target repo was configured:

```powershell
npm run setup-hooks -- D:\Imperial\individual\week15 --dry-run
```

If you want native approval temporarily, set:

```powershell
$env:CCC_BYPASS_APPROVAL_HOOK = "true"
```

If port `4317` is busy:

```powershell
$env:CCC_PORT = "4318"
npm run daemon
```

Launch Claude Code with the same `CCC_PORT` so hooks contact the same daemon.
