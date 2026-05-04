# Desktop Companion

The desktop companion is the current Stage 1 + 1.5 client. It is an Electron floating island that connects to the local daemon and renders Claude Code status, approvals, questions, knowledge cards, and a live monitor — without requiring the user to watch the terminal every second.

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

## Window Geometry

There are two parallel size systems:

- **CAPSULE_BOUNDS** — the visible bubble per mode:
  - Resting compact: `124 x 42`
  - Hover compact:   `224 x 42`
  - Approval:        `360 x 238`  (+ 44 px bottom satellite gutter)
  - Question:        `360 x 300`  (+ 44 px bottom satellite gutter)
  - Cards:           `460 x 600`
  - Settings:        `440 x 580`
  - Live:            `380 x 440`
- **MODE_BOUNDS** — the BrowserWindow, which adds `BUBBLE_PADDING = 12 px` on every side around the capsule for a transparent gutter where the soft drop shadow renders. Approval / question modes additionally reserve a `SATELLITE_GUTTER = 44 px` row below the bubble for the floating ✓ / ✕ approve/deny chips.

### Liquid water-droplet morph

Mode → mode transitions use a single synchronized motion: `main.js animateWindowBounds(target, 280, cb, { liquid: true })` interpolates the BrowserWindow size with `easeOutDroplet` (mirrors `cubic-bezier(0.34, 1.56, 0.64, 1)` — overshoots ~6 % then settles) while the renderer's `.island` CSS transitions `border-radius` from `999px` (pill) → `22px` (rounded rect) on the same curve + duration. Result reads as one continuous "stretching droplet" instead of two separate transitions. `.island` is pre-promoted (`will-change: transform, border-radius` + `transform: translateZ(0)`) so the first morph doesn't trigger compositor-layer creation jank.

Snap, peek, and distance math is implemented in CAPSULE coordinates (the user-perceived shape) and translated to BrowserWindow coordinates via `snapInset()` whenever bounds are computed. When snapped to an edge in compact mode, the BrowserWindow overhangs the work area by `BUBBLE_PADDING` so the capsule itself sits flush with the edge.

Desktop placement is persisted in `~/.claude-companion/desktop-state.json`. The main process stores the current BrowserWindow bounds, mode, snapped edge, and peek state, then clamps the restored bounds back into the current screen work area on startup so a monitor or resolution change cannot leave the island unreachable.

The BrowserWindow uses `alwaysOnTop: true`, `fullscreenable: false`, and a recurring priority guard that reapplies `setAlwaysOnTop(true, "screen-saver", 1)`, `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`, and `moveTop()` while the island is visible. This is best-effort Windows topmost behavior for borderless/full-screen apps; exclusive full-screen renderers may still be outside Electron's control.

## Pure Capsule Treatment

The BrowserWindow opts out of every Win11 source that would paint a rectangle around a transparent frameless window:

| Option | Reason |
|---|---|
| `frame: false` | No system chrome |
| `transparent: true` | Window background is transparent |
| `thickFrame: false` | Suppresses `WS_THICKFRAME` (the default 1–2 px DWM frame) |
| `roundedCorners: false` | Disables Win11's auto-rounded corners and the subtle outline they add |
| `backgroundMaterial: "none"` | Disables Mica/Acrylic so no accent border is layered on |
| `hasShadow: false` | Suppresses DWM drop shadow that would bound-trace the rectangle |

The capsule fills the BrowserWindow at `margin: 12px / width: calc(100% - 24px) / height: calc(100% - 24px)`. The 12 px gutter only carries the CSS drop shadow; nothing else paints there.

## Interaction Model

Four states animate between each other:

- Resting compact: status emoji with the context-usage ring + status label.
- Hover compact: also reveals the window controls strip (toggle, capsule color, settings, minimize).
- Request expanded: approval card with command, meta, suggestion buttons, deny / approve, OR question card with answer form.
- Dashboard expanded: full vertical feed of (1) the active request, when one is pending, (2) other pending requests with inline approve / deny, (3) all known Claude sessions with status chips, (4) paired devices with revoke + a button to generate a fresh pairing token, (5) the audit-event drawer (last 30, collapsible), and (6) a health footer that flips between sage "live" and rose "offline" depending on the WebSocket connection. Replaces the legacy browser dashboard at `http://127.0.0.1:4317/` — that URL now serves a small notice page directing users back to the bubble.

The renderer picks the mode from daemon state; the main process animates native bounds. `:root` has a registered `@property --context-angle` so the conic ring fill morphs over `720ms` instead of jumping when ctx percentage updates.

**Hover-expand gating.** The 124 px resting capsule is too narrow to hold the controls strip alongside the orb + label, so showing the strip during the 170 ms hover-expand animation made it overlap the status. The main process now broadcasts a `window:hover-expanded-changed` IPC once the bubble has actually settled at the wider hover size; the renderer mirrors this on `body[data-hover-expanded]`, and CSS gates the controls-strip visibility on it. The strip itself uses a transparent background (no pill chip), so it always blends with whatever color the bubble currently has — the user's chosen island color in compact, the default dark surface in expanded modes.

When the user drags near a screen edge, the main process snaps and stays anchored through subsequent expand / collapse. Snap is debounced about 160 ms after the last move event. Programmatic moves from animations are skipped via the `boundsAnimation` guard.

**Single-axis snap.** Snapping picks the nearest edge only — even at a corner drag, just one of `{left, right, top, bottom}` wins. Pinning both axes at once forced the bubble into the corner and made every off-corner drag look like it "centered itself" at the other axis. With single-axis snap, drag-to-top preserves the user's X and drag-to-right preserves the user's Y.

Compact edge snap auto-enters a peek state: the BrowserWindow slides mostly past the edge, leaving a 12 px capsule strip + the gutter visible. In that strip, the normal status UI is hidden and only a sage / warm context fill bar shows. Pulling the slit away from the edge past `SNAP_DETACH_DISTANCE` clears snap and re-floats.

**Slit hover detection.** Browsers don't synthesize `pointerleave` / `pointerenter` when a window slides out from under a stationary cursor — so a later cursor entry into the slit never refires `pointerenter` and the slit feels dead. The main process polls `screen.getCursorScreenPoint()` every 80 ms while peeking; entering the BrowserWindow bounds triggers `setCompactHover(true)` directly, bypassing the web hover state machine entirely.

**Hold-open during modal pickers.** Opening the system color picker (especially on macOS, where it's a separate window) moves the cursor off the bubble and would otherwise fire the auto-collapse + controls-hide timers before the user finishes picking. The renderer calls `companionDesktop.setHold(true)` on color-button click and releases on the input's `change` / `blur`; while held, both the main-process compact-collapse timer and the renderer-side controls-hide timer bail out. A 30 s safety fallback releases the hold even if neither event fires.

## Context Usage

The daemon adds `contextUsage` to session and pending-request payloads when it can read the Claude transcript. It reads the latest assistant `usage` block and estimates current context occupancy from:

```text
input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens
```

The context window is derived from the `message.model` recorded on the same transcript line and from any explicit usage metadata Claude provides. Resolution order:

1. Explicit `usage.context_window_tokens` / `usage.max_context_tokens`.
2. `CCC_CONTEXT_WINDOW_TOKENS`, when you need to force one value for local testing.
3. `CCC_MODEL_CONTEXT_WINDOWS`, a JSON map for model-specific overrides.
4. A learned window for the model family, persisted in `~/.claude-companion/learned-context.json`. The daemon writes here whenever it observes a per-line peak above 200k (a 200k model can't physically hold that much) or a sharp drop characteristic of `/compact`. See `docs/protocol.md` for the file shape and detection thresholds.
5. Model ids or aliases containing `[1m]` / `1m` use a 1,000,000-token window.
6. Claude Code's own 1M default for Opus 4.6, Opus 4.7, and Sonnet 4.6, mirrored locally. The transcript records bare model ids (e.g. `claude-opus-4-7`) without the `[1m]` marker, so the daemon recognizes the family directly. `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` (the same flag Claude Code itself honors) or `CCC_DISABLE_1M_CONTEXT=true` falls these models back to 200,000.
7. Other current Claude model families fall back to 200,000.

If the observed `usedTokens` count for a transcript line already exceeds the resolved window, the daemon promotes the window to 1,000,000 and tags it `windowSource: "observed-overrun"`, so the ring never reports above 100% just because the resolution layer guessed too low. The same observation also writes through to the learned-context file so subsequent sessions of that model family start at the right value.

```powershell
$env:CCC_CONTEXT_WINDOW_TOKENS = "200000"
$env:CCC_MODEL_CONTEXT_WINDOWS = '{"claude-opus-4-7":1000000,"sonnet":200000}'
$env:CLAUDE_CODE_DISABLE_1M_CONTEXT = "1"
```

Context occupancy renders as the conic ring around the status orb in compact/expanded modes, and as the fill bar in the edge peek slit. When a session transitions from active work into `done` while tucked, the main process slides the capsule back out for `DONE_ATTENTION_MS` (10 minutes) with a sage→warm sweep across the bubble and a sage glow on the status text. After that window expires, the capsule re-tucks but the slit keeps pulsing — sage background + box-shadow halo + a 1→1.08 transform scale at 1.2 s — until the user moves the pointer over it (`acknowledgeAttentionFromPointer`).

## Status Mapping

- `idle`: sleeping emoji, no pending request.
- `thinking`: thinking emoji, Claude is reasoning after a prompt or tool.
- `running_tool`: gear emoji, Claude is about to run or has just run a tool.
- `waiting`: hourglass emoji, Claude Code sent a notification that it is waiting for user input or terminal attention, but there is no Companion answer form.
- `waiting_approval`: yellow indicator and approval card.
- `waiting_answer`: question emoji and answer form for a real `AskUserQuestion` request.
- `done`: check emoji.
- `failed`: warning emoji.
- `blocked`: blocked emoji.

## Controls

Compact controls live in a transparent strip that fades in on hover (left to right). The strip itself has no pill background — buttons sit directly on the bubble so the strip always reads as part of whatever color the bubble currently has:

- **Power (⏻)** — toggles the Companion approval / status hooks globally. Sand-gold tint when off; the orb desaturates as a passive cue. Backed by `~/.claude-companion/disabled` flag file (see [Pluggable on/off](#pluggable-onoff)).
- **Color swatch** — opens the system color picker for the compact capsule surface. The selected color is stored locally in the renderer via `localStorage`; light colors switch compact status/control text to a darker contrast color while expanded approval/question panels keep the standard dark surface. The bubble pins itself open while the picker is showing (`setHold` IPC) so the picker can't auto-collapse the compact bubble out from under the user, especially on macOS where the picker is a separate window.
- **Gear (⚙)** — single entry point for both "settings" and "expand": toggles the bubble's dashboard mode (`420 × 540`). Pending requests auto-expand to the approval / question card on their own, so a separate Expand button is no longer wired up. Click the gear again from inside the dashboard to collapse back to compact. The legacy browser dashboard at `http://127.0.0.1:4317/` is gone — its content lives here now.
- **Minus (−)** — minimizes the window.

Expanded panel actions:

- **Approve** — single-shot allow.
- **Suggestion buttons** — for `PermissionRequest` events, every `permission_suggestions[i]` with `behavior: "allow"` renders as a single-line pill (e.g. `Always allow Bash node --check d:\…\main.js +2`). The label uses the first rule's tool + content; if the suggestion bundles multiple rules, a `+N` hint is appended. Long content is truncated with CSS ellipsis, and the full multi-line rule list is exposed via the button's `title` (hover tooltip). Clicking sends `decide(..., "always_allow", ..., { suggestionIndex: i })` which the daemon packs into `decision.updatedPermissions` for Claude Code.
- **Deny** — blocks the request with `Denied from desktop companion`.
- **Answer** — submits `AskUserQuestion` responses (text input or option pill selection).

## Pluggable on/off

Two equivalent ways to disable Companion approvals across every project on the machine:

- **Power button** in the controls strip. One click writes `~/.claude-companion/disabled`; another click removes it.
- **Flag file** directly: `type nul > %USERPROFILE%\.claude-companion\disabled` to disable, `del %USERPROFILE%\.claude-companion\disabled` to re-enable. Each hook script (`pre-tool-use.js`, `permission-request.js`, `event.js`) checks `isCompanionDisabled()` from `packages/shared/protocol.js` at startup and returns a noop if present, so Claude Code falls back to its native terminal prompts.

Env vars `CCC_BYPASS_APPROVAL_HOOK=true` (approval) and `CCC_DISABLE_STATUS_HOOK=true` (status) remain as session-scoped equivalents for shell-level overrides.

Global hook installation is handled by `npm run setup-user-hooks`, which merges only Companion-managed hooks into `%USERPROFILE%\.claude\settings.json` and backs up the prior file. `npm run doctor` verifies hook coverage, paths, daemon health, disabled-flag state, and possible global/project double-firing.

## Stage 1.5 Modes

The five non-compact modes the controls strip can open:

- **Approval** — auto-entered when a `permission_request` lands. Tool name + risk pill + command preview + 2-row meta + horizontal Approve/Suggest/Deny row. Floating ✓ / ✕ satellite chips appear in the bottom gutter so the user can decide without scrolling. Auto-jumps to this mode from any other mode when a request arrives.
- **Question** — same chrome, swaps the action row for an answer-form (multiple-choice options or "other answer" text input).
- **Cards** (📚) — Today / History / Wrong-book / Record tabs. See [Knowledge Cards mode](#knowledge-cards-mode-stage-15) below.
- **Settings** (⚙) — left rail nav + right panel; rail items: Knowledge cards / Storage / Export / Companion. The rail itself is collapsible (chevron at top); state persists.
- **Live** (⤢) — dedicated monitor surface: floating semi-transparent window with slow breathing pulse. Holds Today's-deck mini-summary + 📚 "Open Knowledge Cards" entry + active Claude sessions list. The ⤢ button is open-only (use − to collapse back to compact).

### Knowledge Cards mode (Stage 1.5)

Daily review surface — see [ADR-20260503-knowledge-cards](decisions/ADR-20260503-knowledge-cards.md) for the full design rationale. Tabs:

- **Today** — markdown abstract + progress bar + Start review CTA. Streak badge (🔥 N days / 🛡 protected) sits in the abstract header.
- **History** — list of past decks (most recent first). Same-day re-generation archives the prior file as `<date>-HHMMSS.json` and shows it as an `is-archive` row beneath today's.
- **Wrong book** — missed cards return here until mastered (`easy`/`medium`: 2 consecutive correct; `hard`: 3).
- **Record** — every generation run with what got scanned / dropped, scrollable per-session list inside each row's expanded detail.

### Themes

4 presets in [packages/shared/themes.js](../packages/shared/themes.js): Midnight Teal · Amber Hearth · Paper Light · Aurora Indigo. Theming is mechanical — each theme is a flat bag of CSS custom properties applied to `:root`. The bubble's color button cycles through them; full preview list lives in Settings → Companion → Theme. Stored at `localStorage["claude-code-companion.theme.v1"]`.

### Bilingual UI (en / zh)

[packages/shared/i18n.js](../packages/shared/i18n.js) holds 148+ translation keys × 2 locales. Static HTML is tagged with `data-i18n` / `data-i18n-title` / `data-i18n-aria-label` / `data-i18n-placeholder`; the loader walks the tree on locale change. The cards-generator prompt template also branches on locale (`PROMPT_TEMPLATES.en` / `.zh`) so model output language follows the user's UI choice. JSON keys stay English so parsing is locale-invariant. Stored at `localStorage["claude-code-companion.locale.v1"]`. Initial value detected from `navigator.language`.

## Visual Identity Policy

Tokens, motion, and component recipes are codified in [docs/design-language.md](design-language.md). A standalone v0 preview lives at [docs/design-language-v0.html](design-language-v0.html) — open it in a browser to inspect every state side-by-side.

Three Stage-1.5 redesign explorations live at [docs/ui-redesign-A-liquid-capsule.html](ui-redesign-A-liquid-capsule.html), [docs/ui-redesign-B-layered-cards.html](ui-redesign-B-layered-cards.html), [docs/ui-redesign-C-spatial-tabs.html](ui-redesign-C-spatial-tabs.html) — direction B + the liquid morph from A is what shipped.

The current stage intentionally avoids a concrete mascot. Status emoji are product iconography (they encode state); they're not used as filler. Future personality work should use original, generated, or clearly licensed assets.

## Next Desktop Work

- Add tray menu for dashboard, compact mode, and quit.
- Truly content-driven dynamic resize (ResizeObserver → IPC → `setBounds`), so compact width fits text instead of staying at 124 px.
- Render MCP `Elicitation` form fields directly in the bubble (currently surfaces only as `waiting` status).
- Wire `ExitPlanMode` mode picker (1/2/3/4) into the bubble once Claude Code ships [PrePlanMode hooks](https://github.com/anthropics/claude-code/issues/14259).
- Add visual screenshots or GIFs to the README after the UI stabilizes.
