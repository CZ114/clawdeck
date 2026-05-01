# Desktop Companion

The desktop companion is the current Stage 1 client. It is an Electron floating island that connects to the local daemon and renders Claude Code status, approvals, and questions without requiring the user to watch the terminal every second.

## Current Shape

Run it from the repo root:

```powershell
npm run desktop
```

It expects the daemon to be running:

```powershell
npm run daemon
```

Runtime files:

- `packages/desktop/main.js`: Electron window creation and desktop IPC.
- `packages/desktop/preload.js`: narrow renderer bridge.
- `packages/desktop/renderer/index.html`: static UI shell.
- `packages/desktop/renderer/styles.css`: compact island, expanded approval panel, and state animations.
- `packages/desktop/renderer/app.js`: WebSocket, polling fallback, rendering, and decisions.

## Data Flow

```text
Claude Code hook
  -> local daemon
  -> ws://127.0.0.1:4317/ws
  -> Electron renderer
  -> approval or answer decision
  -> POST /permission-decisions or websocket permission_decision
  -> daemon wakes hook
  -> Claude Code continues or blocks
```

The window does not inspect Claude Code directly. It only consumes daemon summaries.

## Current Interaction Model

The window has two visual modes:

- Compact: `176 x 44`, showing only a state label and a context-usage progress bar.
- Expanded: `360 x 238` for approvals or `360 x 300` for questions.

The renderer chooses the mode from daemon state. The main process animates the native window bounds, keeping the window centered around its current position. CSS transitions handle the capsule-to-card shape change and content fade-in.

This mimics the Dynamic Island idea without using iOS APIs: compact/minimal at rest, expanded only when action is needed.

When the user drags the island near a screen edge, the main process snaps it to that edge and preserves that edge alignment while expanding or collapsing. Edge snap is debounced ~160 ms after the last `moved` event so it only triggers once the drag actually stops, instead of fighting the cursor while the user is still moving the window. Programmatic moves from the expand/collapse animation are skipped via the `boundsAnimation` guard.

## Context Usage

The daemon now adds `contextUsage` to session and pending-request payloads when it can read the Claude transcript. It reads the latest assistant `usage` block and estimates current context occupancy from:

```text
input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens
```

The context window is derived from the `message.model` recorded on the same transcript line. Model ids whose suffix is `[1m]` (e.g. `claude-opus-4-7[1m]`) use a 1,000,000-token window; everything else falls back to 200,000. The override still works when you need to force a value:

```powershell
$env:CCC_CONTEXT_WINDOW_TOKENS = "200000"
```

In compact mode, context occupancy appears as the thin progress bar under the status label. In expanded approval/question mode, the same value appears as the circular ring around the status emoji.

## Status Mapping

- `idle`: sleeping emoji, no pending request.
- `thinking`: thinking emoji, Claude is reasoning after a prompt or tool.
- `running_tool`: gear emoji, Claude is about to run or has just run a tool.
- `waiting_approval`: yellow indicator and approval card.
- `waiting_answer`: question emoji and answer form.
- `done`: check emoji.
- `failed`: warning emoji.
- `blocked`: blocked emoji.

## Controls

- `>` opens the local browser dashboard.
- `r` refreshes daemon state.
- `-` minimizes the window.
- `x` closes the window.
- `Approve` allows the current request.
- `Always Allow` applies Claude's native allow suggestion when available.
- `Deny` blocks the current request with a reason.
- `Answer` submits `AskUserQuestion` answers.

## Visual Identity Policy

The current stage intentionally avoids a concrete mascot. Keep the surface minimal until the state and approval interaction feels right. Future visual personality work should use original, generated, or clearly licensed assets.

## Next Desktop Work

- Persist window position and compact mode.
- Add tray menu for dashboard, compact mode, and quit.
- Tune compact and expanded sizes after real use.
- Add optional click-to-expand details when no approval is pending.
- Improve attention cues for waiting approval without becoming distracting.
- Add visual screenshots or GIFs to the README after the UI stabilizes.
