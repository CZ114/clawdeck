# User Guide

Day-to-day use on Windows.

## One-Time Setup

Install dependencies and verify:

```powershell
cd D:\Imperial\individual\claude-code-companion
npm install
npm run smoke
```

Install Claude Code hooks **globally**, so the bubble works in every project:

```powershell
npm run setup-user-hooks
npm run doctor
```

The installer merges only Companion-managed hooks into `%USERPROFILE%\.claude\settings.json`, keeps your existing Claude Code settings, and writes a backup. Preview first with:

```powershell
npm run setup-user-hooks -- --dry-run
```

Restart Claude Code after installing or changing hooks.

The global hook set covers:

- **PreToolUse** matcher `ExitPlanMode|AskUserQuestion` → bubble shows the plan / question.
- **PreToolUse** matcher `""` → status updates (running tool).
- **PermissionRequest** matcher `""` → every tool's permission gate, including MCP servers (`chrome-devtools`, etc.), `WebFetch`, `Read` / `Edit` / `Write` for paths outside the project, and any Bash / PowerShell command not in your `permissions.allow` list.
- **PostToolUse / PostToolUseFailure / UserPromptSubmit / Notification / Stop / SessionEnd** → status updates.

Per-project hooks via `npm run setup-hooks -- <repo>` are still supported for repo-specific overrides; if you use them, drop the `hooks` block from `~/.claude/settings.json` for that machine to avoid double-firing. See [docs/dev-setup.md](dev-setup.md) for the trade-offs.

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

Terminal 3 (any project):

```powershell
cd D:\Imperial\individual\week15
claude
```

## What You'll See

| Claude Code action | Bubble behavior |
|---|---|
| Bash / PowerShell command not pre-approved | Approval card with the command, risk pill, and `Approve` / per-suggestion `Always allow` / `Deny` buttons. The "always allow" buttons mirror Claude Code's own `1. Yes / 2. Yes, allow X` options — pick the one you want and the matching rule is applied. Each button is a single line with the first rule and a `+N` hint when the suggestion bundles multiple rules; hover the button to see the full rule list as a tooltip. |
| Read / Edit / Write outside cwd, WebFetch new domain, MCP tool call | Same approval card, with `permission_suggestions` rendered as buttons. |
| `AskUserQuestion` | Question card with option pills and a free-text "Other answer" input. |
| `ExitPlanMode` (plan submission) | Approval card showing the plan content. **Approve only forwards to Claude Code's terminal mode picker** (1/2/3/4) — you still have to pick auto / manual / refine in the terminal. **Deny** cancels the plan from the bubble. |
| MCP `Elicitation` form | Status changes to `waiting`; answer in the terminal (form rendering not in the bubble yet). |
| Plain `Notification` (e.g. terminal asks for input) | Status orb shows `Waiting`. No actionable bubble. |
| `Stop` while tucked at an edge | Capsule slides out with a sage→warm sweep, stays expanded for 10 minutes (`DONE_ATTENTION_MS`). After it re-tucks, the slit keeps pulsing until you move the pointer over it. |

## Controls

Hover the compact bubble to reveal the controls strip (left → right):

- **⏻ Power** — toggle Companion approvals globally. Sand-gold tint when off; the orb desaturates as a passive cue. Same effect as creating `~/.claude-companion/disabled` by hand.
- **● Theme** — cycle through the 4 theme presets (Midnight Teal · Amber Hearth · Paper Light · Aurora Indigo). For a full preview list with descriptions, open Settings → Companion → Theme. Choice persists in `localStorage`.
- **📚 Cards** — open Knowledge Cards mode (Today / History / Wrong-book / Record tabs). The icon shows a sage-green `count` badge when there are cards to review and pulses warm-yellow during generation.
- **⚙ Settings** — open Settings (left rail nav: Knowledge cards / Storage / Export / Companion).
- **⤢ Live monitor** — open the Live overlay (always opens, never collapses). Floating semi-transparent window with breathing pulse: Today's-deck mini-summary + 📚 Open Knowledge Cards entry + active Claude sessions.
- **− Minimize** — collapse any expanded mode back to the compact island. (Doesn't minimize to the OS taskbar.)

When a permission request lands, the bubble auto-jumps to the approval mode regardless of where you are. Two satellite ✓ / ✕ chips appear in the gutter below so you can decide without scrolling. Question requests show the same shell with a typed-answer form.

The bubble remembers its last position, compact/expanded mode, edge snap, and tucked slit state in `~/.claude-companion/desktop-state.json`. If your monitor layout changes, startup clamps the saved position back into the visible work area.

Drag the capsule near a screen edge to snap; once snapped, it auto-tucks into a 12 px slit. The bubble snaps to a single edge — the closest one wins — so dragging to the top preserves your X position and dragging to the right preserves your Y. Pull the slit away from the edge to detach.

## Temporary Switches

These take effect in the **next** Claude Code session you start in the same shell:

```powershell
$env:CCC_BYPASS_APPROVAL_HOOK = "true"   # approval hooks return noop, native terminal prompts
$env:CCC_DISABLE_STATUS_HOOK  = "true"   # bubble stops updating status
$env:CCC_FAIL_OPEN            = "true"   # debug only — fail open instead of fail closed when daemon is down
```

For runtime toggling (without restarting Claude Code), use the **⏻** button on the bubble — it writes the global flag file each hook script reads at startup.

## Permanent Disable

Run `npm run setup-user-hooks -- --uninstall` to remove only Companion-managed global hooks. Use `npm run setup-hooks -- <repo> --disable` if you installed hooks per-project.

## Safety Notes

- The daemon binds to `127.0.0.1` only.
- Approval hooks fail closed by default — if the daemon isn't running, the hook returns `deny` so Claude Code can't proceed without explicit approval. Use `CCC_FAIL_OPEN=true` only while debugging.
- Status hooks are display-only and fail open.
- The desktop companion only consumes daemon summaries; it doesn't read the terminal directly.

## Troubleshooting

**Bubble says `daemon offline`** — start it: `npm run daemon`.

**Bubble disappears behind a full-screen window** — restart `npm run desktop` first. The desktop app now runs a high-priority always-on-top guard, but some exclusive full-screen apps can still win at the OS compositor level.

**Claude Code still shows its native approval UI** — run `npm run doctor`, confirm global hooks are installed, then restart Claude Code. Or check `npm run setup-hooks -- <repo> --dry-run` if you're using the per-project install.

**`PermissionRequest` doesn't fire for some tool** — Claude Code only fires it when permission gating actually triggers. Tools / paths in `~/.claude/settings.json` `permissions.allow` skip it entirely. Check that the path / tool isn't already pre-approved.

**Plan mode (`ExitPlanMode`) bubble doesn't show the 4 mode options** — Claude Code doesn't expose them via hook ([anthropics/claude-code#14259](https://github.com/anthropics/claude-code/issues/14259)). Approve in the bubble, then pick the mode in the terminal.

**Port `4317` is busy** — usually an old daemon process. On Windows:

```powershell
Get-NetTCPConnection -LocalPort 4317 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

Or run on a different port:

```powershell
$env:CCC_PORT = "4318"
npm run daemon
```

Launch Claude Code with the same `CCC_PORT` so hooks contact the same daemon.

**Approval bubble auto-denied before I could click** — daemon's approval timeout is `CCC_APPROVAL_TIMEOUT_MS = 55_000` (55 s). For longer pauses:

```powershell
$env:CCC_APPROVAL_TIMEOUT_MS = "300000"   # 5 minutes
$env:CCC_HOOK_TIMEOUT_MS     = "303000"   # must be > APPROVAL_TIMEOUT
```

## Knowledge Cards (Stage 1.5)

Opt-in feature that turns each day's Claude Code work into review cards. First time you click `Generate now` (Settings → Live → Today's deck, or the empty-state button on the Cards tab), the bubble shows a one-time consent dialog explaining what content gets piped to your local `claude -p` subprocess and what gets redacted. Decline = no cards generated, no transcripts read.

### Daily flow

1. **Generate** — open Live (⤢) or Cards (📚) and click `Generate now`. Daemon scans `~/.claude/projects/<encoded-cwd>/` per the picker's date selection, runs them through redaction, pipes to `claude -p`, validates each card has a verbatim source quote, persists the deck.
2. **Review** — Cards → Today → `Start review`. Multiple-choice or cloze. Wrong answers go to the wrong-book; right ones increment your streak.
3. **Wrong book** — missed cards return until you answer them right N times in a row (`easy`/`medium`: 2, `hard`: 3).
4. **Streak** — `🔥 N days` in the abstract header counts consecutive completed days. The chain allows ONE empty/missing day as a 🛡 shield; a second resets.

### Generation scope

Settings → Knowledge cards → Generation scope. The single horizontal heatmap is the scope control:

- **Click a day** → focuses it; the day-detail panel below shows that day's sessions
- **Drag across days** → multi-select a range
- **`Auto top-3`** → pick the 3 most-recent sessions (across all dates)
- **`All`** / **`None`** → bulk select / clear
- **`↻`** → re-scan `~/.claude/projects/`
- Per-row checkbox in the day-detail panel → fine-tune which sessions in the focused range actually feed the prompt
- **Confirm** → commits the picker draft to the actual `selectedSessionIds` sent to the next generation

If `Allow session deletion` is on (Settings → Knowledge cards → Behavior), each row gets a 🗑 button that moves that session JSONL into `~/.claude-companion/trash/manual/` (recoverable until prune).

### Themes + language

Settings → Companion has the full theme grid and the en / 中文 language toggle. The language setting also controls the cards generator's prompt language: zh prompts get zh card text + zh abstract; en stays English. JSON keys are always English so structure is locale-invariant.

### Export

Settings → Export → three buttons download `Today.md`, `All abstracts.md`, `Wrong book.md`. Each `.md` has YAML frontmatter (date, focus snapshot, difficulty mix, accuracy, streak) and `**Q**` / `**A**` two-line card pairs that import cleanly into Obsidian / Notion / Anki (one regex to .csv).
