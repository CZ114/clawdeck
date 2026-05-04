# Stage Requirements

This document defines the staged path from a minimal approval spike to a desktop-first companion, then to iOS and remote use. Each stage should have a clear demo, exit criteria, and docs updated before moving on.

## Product Principle

Do not build a full remote terminal first. Build the smallest safe loop where Claude needs the user and a companion surface helps the user answer. The PC companion comes before phone pairing so the core interaction can be tuned locally.

## Stage 0: Technical Approval Spike

Goal: Prove that Companion can approve, deny, or answer Claude Code requests running on Windows.

Scope:

- Windows local daemon with HTTP server.
- Claude Code native `PermissionRequest` hook for Bash and PowerShell approval.
- Claude Code `PreToolUse` hook for `AskUserQuestion` answer handoff.
- Non-blocking lifecycle status hook for prompt, tool, notification, failure, and stop events.
- Hooks send request JSON to daemon and wait for a decision.
- Temporary web or CLI test client can approve, deny, always-allow, or answer before richer clients exist.
- Local web page shows current Claude session status.
- Setup CLI installs, updates, partially enables, or disables target repo hook configuration.
- User-level setup CLI installs, refreshes, dry-runs, or uninstalls Companion-managed global hooks without overwriting unrelated Claude Code settings.
- Doctor CLI checks global hook coverage, hook paths, daemon health, disabled flag state, and global/project double-hook risk.
- Runtime switches can bypass remote approval or status capture without editing settings JSON.
- Basic risk label for commands: `low`, `medium`, `high`.

Required APIs:

- `GET /health`
- `POST /hook/pre-tool-use`
- `POST /hook/permission-request`
- `POST /hook/event`
- `GET /sessions`
- `GET /pending-requests`
- `POST /permission-decisions`
- `GET /ws`

Exit criteria:

- A harmless Bash command can be approved remotely.
- A PowerShell command can be approved through the native `PermissionRequest` hook.
- `AskUserQuestion` can be answered remotely with `updatedInput.answers`.
- Session status changes can be observed as `thinking`, `running_tool`, `waiting`, `waiting_approval`, `waiting_answer`, `done`, `failed`, or `blocked`.
- A target repo can be configured idempotently without hand-editing JSON.
- User-level hooks can be installed idempotently with `npm run setup-user-hooks`.
- `npm run doctor` reports missing global hooks, bad paths, daemon status, disabled flag state, and double-hook risk.
- `CCC_BYPASS_APPROVAL_HOOK=true` hands approval/question control back to Claude Code's native UI.
- `CCC_DISABLE_STATUS_HOOK=true` stops Companion status capture.
- `npm run setup-hooks -- <target-repo> --disable` removes Companion-managed hooks while preserving unrelated settings.
- Hook timeout behavior is defined.
- Logs show request id, session id, tool summary, and decision.

Docs to update:

- `docs/protocol.md`
- `docs/security.md`
- `docs/dev-setup.md`

## Stage 1: Windows Floating Companion

Goal: Make Claude Code status and approvals visible from a tiny always-on-top desktop surface.

Scope:

- Electron floating island for Windows development.
- Transparent, frameless, movable, always-on-top window. All Win11 rectangle sources opted out (`thickFrame: false`, `roundedCorners: false`, `backgroundMaterial: "none"`, `hasShadow: false`) so the visible surface is a pure capsule.
- Two-tier sizing: CAPSULE_BOUNDS for the visible bubble, MODE_BOUNDS = capsule + `BUBBLE_PADDING` (12 px gutter) for the BrowserWindow. Snap and peek math operates in capsule coords.
- Resting compact state shows the status emoji + conic context-usage ring + status label.
- Hover compact state reveals the controls strip (toggle / capsule color / settings / minimize). The strip is gated on a `window:hover-expanded-changed` IPC so it only paints once the bubble has actually animated to the wider hover size — preventing the brief overlap with the status during the 170 ms expand. The strip itself is transparent (no pill chip) so it always blends with the bubble's current background color.
- A single gear button toggles dashboard mode for "settings" and "expand"; pending requests auto-expand to approval / question without a separate button.
- Native window bounds animation expands from compact capsule to approval / question panel, or to **dashboard mode** (`420 × 540`) — a vertical feed of pending queue, sessions, devices, pairing token, audit events, and health footer that replaces the legacy browser dashboard at `http://127.0.0.1:4317/` (now a small notice page).
- Single-axis screen-edge snapping with a context-only peek slit on drag-to-edge — the closest edge wins, so dragging to top preserves the user's X and dragging to right preserves the user's Y instead of pinning the bubble into a corner.
- `window:set-hold` IPC pins the bubble open while system-modal pickers are showing (currently the macOS color picker), so the modal can't trigger the auto-collapse + controls-hide timers out from under the user.
- Slit hover detection via main-process cursor polling (browser hover state is stale after the BrowserWindow slides off-screen).
- Done-state attention cue: capsule slides out for `DONE_ATTENTION_MS = 10 min` with a sage→warm sweep; after re-tucking, the slit pulses with sage glow until acknowledged.
- Desktop placement persistence in `~/.claude-companion/desktop-state.json` for bounds, mode, snapped edge, and tucked state, with startup clamping for monitor/resolution changes.
- Higher-priority always-on-top guard so the island reasserts topmost behavior while visible.
- Status summary for `idle`, `thinking`, `running_tool`, `waiting`, `waiting_approval`, `waiting_answer`, `done`, `failed`, `blocked`.
- Approval card covers every event Claude Code can hook for user input: `PreToolUse(Bash|PowerShell|ExitPlanMode|AskUserQuestion)`, `PermissionRequest` matcher `""` (Read / Edit / Write / Glob / Grep / WebFetch / MCP tools).
- `permission_suggestions[]` rendered as one button per "always allow X"; the picked index round-trips to the daemon as `decision.updatedPermissions`.
- Answer form for `AskUserQuestion` (option pills + free-text fallback).
- Pluggable on/off via `~/.claude-companion/disabled` flag file (Power button on the bubble + manual `type nul`).
- Per-family learned context window in `~/.claude-companion/learned-context.json` (peak-overrun + compact-observed signals; never auto-demotes).
- Design tokens, motion library, and component recipes codified in [docs/design-language.md](design-language.md) with a v0 visual preview at [docs/design-language-v0.html](design-language-v0.html).
- WebSocket first, HTTP polling fallback.

Non-goals:

- Do not control the terminal process directly.
- Do not read Claude Code memory, terminal buffers, or transcript files directly.
- Do not replace Claude Code's native approval UI when `CCC_BYPASS_APPROVAL_HOOK=true`.
- Do not add LAN or iPhone pairing in this stage.

Exit criteria:

- `npm run desktop` opens the compact companion island.
- With the daemon running, the window connects to `ws://127.0.0.1:4317/ws`.
- A real pending Bash or PowerShell request can be approved or denied from the floating window.
- A real `AskUserQuestion` request can be answered from the floating window.
- The user can glance at the window and know whether Claude is running, blocked, waiting, failed, or done.
- The window stays compact by default and expands only when action is needed.
- A tucked edge bubble visibly announces a fresh `done` transition and clears that reminder only after pointer acknowledgement.
- Window position, edge tuck, and mode survive desktop restart, and restored bounds stay reachable after display changes.

Docs to update:

- `README.md`
- `docs/dev-setup.md`
- `docs/user-guide.md`
- `docs/desktop-companion.md`
- `docs/security.md`

## Stage 1.5: Knowledge Cards

Goal: Turn each day's Claude Code work into a small set of review cards the user can self-test, so Companion has daily-use value even on days with no approval activity. Decided in [ADR-20260503-knowledge-cards](decisions/ADR-20260503-knowledge-cards.md).

Scope:

- New bubble mode `cards` (460 × 600) reachable from a 📚 button in the controls strip and from a sage badge on the compact bubble. Three tabs: **Today** / **History** / **Wrong book**.
- Daily abstract: a markdown-rendered summary (h2 / h3 / lists / inline code / blockquote) of what the user worked on, generated together with the cards.
- Card generator: spawns the user's local `claude -p` CLI as a subprocess; pipes a redacted session transcript to stdin, parses cards JSON from stdout. **No direct Anthropic API call**, no new API key for the user to configure.
- Trigger: first bubble open of the day, OR a configurable scheduled time (default 22:00), OR manual "Generate now" button in Settings. Generation runs detached from the bubble's main loop — approvals continue to work during generation.
- Generation-progress UI: **only** the controls-strip 📚 button reflects generation. Idle = faint icon; has-cards = sage + count badge; generating = 🎴 + warm pulse. The bubble's main status orb keeps reporting real Claude Code state.
- Learning focus: Settings · Cards has a multi-line "What do you want to learn?" textarea. Whatever the user types is prepended to every generation prompt as a weighting hint. Empty focus = generic "consequential decisions over trivia." Each day's focus snapshot is stored alongside the cards for History.
- Difficulty tiers: every card carries `easy` (conceptual), `medium` (mechanism / implementation), or `hard` (foundation / math / OS-level). User picks Casual / Balanced / Deep preference in Settings; each card displays a difficulty chip; Today tab shows the day's distribution.
- Strict source attribution (hard-coded, not user-configurable): every card MUST carry a `source.snippet` containing a verbatim quote from the original session. Cards without verifiable source are discarded by the daemon before reaching the bubble. Source is rendered as an expandable quote block (user / assistant / edit each in a different accent color). Wrong feedback shows `From session: <verbatim quote>` instead of an AI explanation.
- Wrong book (Duolingo-inspired): missed cards return to a separate tab. Mastery thresholds: easy needs 2 consecutive correct, medium 2, hard 3. Auto-add toggle in Settings (default ON).
- Empty-day fallback: when today has zero new sessions, Today tab switches to a replay state — pull cards from the wrong book first, then from the past N days (default 7, configurable 3 / 7 / 14 / 30 / off). All replay cards still come from real historical sessions; never fabricated.
- Streak: daily completion of the daily-goal increments a 🔥 counter visible on Today + Daily-complete screens. **Streak protection rules**: 1st consecutive empty day = `🛡 protected` (streak preserved); 2nd consecutive empty day = streak resets.
- Markdown export: three buttons in Settings · Export — `Today.md`, `All abstracts.md`, `Wrong book.md`. Each `.md` includes YAML frontmatter (date, focus snapshot, difficulty mix, accuracy, streak). Card Q/A pairs use `**Q**` / `**A**` two-line shape so they're trivially convertible to Anki .csv.
- Privacy / opt-in: this is the first feature in the repo that intentionally feeds session transcript to a model. First time the user triggers it (auto or manual), a one-shot consent dialog explains what's piped and the estimated token count. State persists in `~/.claude-companion/cards-disabled` (same pattern as the global `disabled` flag).
- Redaction pass before piping: strip `.env` / `.envrc` / `secrets/` mentions, replace token-shaped strings (40+ char hex, JWT, `ghp_*`, AWS prefix, bearer), replace `%USERPROFILE%` / `$HOME` with `~`.
- `dashboard` mode is **removed** in this stage. Pending queue auto-expands to `approval` mode; sessions, audit events, devices, and pairing all migrate into Settings as expandable sections (default-collapsed).

Non-goals:

- Do not call the Anthropic API directly (use the user's installed `claude` CLI).
- Do not let cards exist without a verbatim source snippet (no hallucination, hard rule).
- Do not ship a full SM-2 / FSRS spaced-repetition scheduler in v0 — wrong-book + per-difficulty mastery counts is the v0 model.
- Do not auto-trigger generation more than once per day without user action.
- Do not surface card content on the future iPhone app's lock screen — Stage 5 (Live Activity) is for status only, not transcript-derived content.
- Do not block the bubble's main loop during generation; approvals must continue to work.

Required APIs:

- `GET /cards/today` — today's abstract + cards array, plus replay metadata when empty-day fallback is active.
- `GET /cards/history` — list of stored daily abstracts (paginated).
- `GET /cards/streak` — current streak count, today's classification (`completed` / `empty` / `missing` / `in-progress`), and whether today is using the 1-day shield. Stateless — re-derived from `cards/<date>.json` files on each request.
- `GET /cards/wrong-book` — current wrong-book contents.
- `POST /cards/answer` — record an attempt (card id + picked / typed answer + correct boolean + timestamp).
- `POST /cards/generate` — manual trigger from Settings · "Generate now" or controls strip. Returns 202 + status; subsequent `GET /cards/generation-status` polls progress for the controls strip pulse.
- `GET /cards/export?scope=today|history|wrong-book` — returns a `.md` file with the agreed frontmatter shape.

Required daemon capabilities:

- Subprocess management: spawn `claude -p`, time out cleanly, surface "claude not on PATH" as a structured error.
- Redaction pass: regex-based replacements before piping to the subprocess.
- Per-day storage in `~/.claude-companion/cards/<YYYY-MM-DD>.json` plus a wrong-book aggregate.
- Cron-like daily trigger (configurable time, default 22:00) without external dependencies.
- Strict source verification: drop any card whose `source.snippet` does not appear verbatim in the piped transcript.

Exit criteria (all shipped 2026-05-04):

- ✅ A real day of Claude Code work produces at least one card with a verifiable source snippet that the user can answer correctly.
- ✅ The same flow works on a day with zero new sessions (empty-day fallback engages, replay cards appear, streak shield is shown).
- ✅ Generating cards does not block a concurrent approval flow — verified by triggering generation while a Bash approval is pending.
- ✅ Each of the three markdown exports produces a valid file that opens cleanly in Obsidian.
- ✅ The first generation triggers a consent dialog; declining preserves prior behavior (no cards, bubble unchanged).
- ✅ A card with no verifiable source is rejected by the daemon and never appears in the bubble.
- ✅ The wrong book correctly removes a card after the per-difficulty mastery threshold is met (2 / 2 / 3 consecutive correct).
- ✅ Streak survives one empty day with `🛡 protected`, resets on the second consecutive empty day.

Docs status:

- ✅ `docs/protocol.md` — cards endpoints + `cards/<date>.json` schema + `/sessions/scan-candidates` + `/sessions/delete` + `/cards/streak` + persisted file shapes.
- ✅ `docs/security.md` — Knowledge Cards Data Policy section: consent gate, redaction, strict-source rule, web fallback policy, session trash, locale + bilingual prompt, cards storage relocation.
- ✅ `docs/dev-setup.md` — `CCC_CARDS_*` env vars, stub mode, generation troubleshooting (timeouts, empty deck, claude not on PATH, picker priming, trash recovery).
- ✅ `docs/desktop-companion.md` — Stage 1.5 modes (Cards / Settings / Live + satellite gutter), liquid water-droplet morph, themes, bilingual UI.
- ✅ `docs/user-guide.md` — controls strip update (theme cycle / cards / live / minimize semantics), Knowledge Cards section (daily flow / generation scope picker / themes + language / export).
- ✅ `docs/stages.md` — this section.
- ✅ `README.md` — Stage 1.5 status block with 5 modes + liquid morph note.

Items that landed beyond the original ADR scope (delivered in Stage 1.5 but not in the original Decision list):

- 4 theme presets (Midnight Teal / Amber Hearth / Paper Light / Aurora Indigo) with token-based switching and a controls-strip cycle button.
- en / 中文 bilingual UI driven by `data-i18n` DOM walker + cards-generator prompt template branching on locale.
- Liquid water-droplet morph for mode → mode transitions (synchronised OS window resize + renderer border-radius animation, both on `cubic-bezier(0.34, 1.56, 0.64, 1)`).
- Satellite ✓ / ✕ approve/deny chips floating below the bubble in approval / question modes.
- Dedicated **Live monitor** mode (⤢ controls-strip button) — separate from settings, hosts the breathing-window with sessions + today's deck + cards entry.
- Settings rail-nav (replaces wall-of-expanders) with a collapsible left rail.
- Generator auto-trash for its own `claude -p` session noise; user-facing 🗑 manual session deletion gated by an `Allow session deletion` toggle.

## Stage 2: Desktop Personality Layer (deferred)

> **Status (2026-05-03):** Deferred. Stage 1.5 (Knowledge Cards) takes the slot Stage 2 originally held. After Stage 1.5 has shipped and seen a few weeks of real use, re-evaluate whether the personality layer is still worth pursuing or whether Stage 3 (iOS local-network MVP) takes priority. Rationale recorded in [ADR-20260503-knowledge-cards](decisions/ADR-20260503-knowledge-cards.md) §"Consequences → Stage 2 deferral."

Goal (when revisited): Add optional personality after the minimal approval loop feels right.

Scope:

- Optional visual identity or pet mode.
- More animation states: idle, working, waiting, happy, failed, sleeping.
- Optional icon-only mode.
- Click or hover expands into the approval/status panel.
- Local notification or attention cue when Claude needs the user.
- Basic positioning persistence.
- Tray menu, approval history, and stronger high-risk confirmation are captured as later product hardening work, not blockers for the first pet mode.

Non-goals:

- Do not ship copied proprietary mascot assets.
- Do not commit to a specific mascot before the minimal interaction is validated.
- Do not let decorative animation obscure approval details.
- Do not add gamification that slows down approvals.

Exit criteria:

- The pet can sit on the desktop without blocking normal work.
- The pet clearly signals waiting approval or waiting answer.
- The full approval controls remain one interaction away.
- Window position and compact/pet mode survive restart.

Docs to update:

- `docs/desktop-companion.md`
- `docs/security.md`
- `docs/user-guide.md`

## Stage 3: Local Network iOS MVP

Goal: Make the same approval loop usable from a real iPhone on the same Wi-Fi or hotspot.

Scope:

- SwiftUI iOS app.
- Manual IP connection first, then QR pairing.
- WebSocket from iPhone to Windows daemon.
- Pending permission request UI.
- Approve / deny / answer actions.
- Basic current state view.
- Token-based pairing.
- Local-only mode, no cloud account.

Required daemon capabilities:

- HTTP API for pairing and hook ingestion.
- WebSocket broadcast for state and permission requests.
- Pending request queue.
- Device token storage.
- Simple local config file.

Required iOS capabilities:

- Connection screen.
- Pairing screen.
- Session status screen.
- Permission request detail screen.
- Decision submission.
- Local notification when app is foreground/background-capable enough for MVP testing.

Exit criteria:

- A new tester can install daemon, run setup, connect iPhone, and approve a request.
- App shows tool, command or question, working directory, risk, reason, and session.
- If the phone disconnects, hook behavior remains safe.
- No full source code or large logs are sent to the phone by default.

Docs to update:

- `docs/protocol.md`
- `docs/security.md`
- `docs/troubleshooting.md`
- `docs/user-testing.md`

## Stage 4: iOS Alpha Hardening

Goal: Make the local iOS MVP reliable enough for a small open-source tester group.

Scope:

- Bonjour / mDNS discovery where available.
- QR fallback remains available.
- Improved reconnect behavior.
- Approval history.
- Better command risk classification.
- Always-allow rules for safe repeated commands.
- TestFlight or source-build instructions for iOS testers.

Exit criteria:

- 3-5 testers can complete setup with documented steps.
- Common Windows firewall issues are documented.
- Connection recovery is predictable.
- High-risk actions require a stronger confirmation in the iOS app.
- Approval history can be inspected locally.

Docs to update:

- `docs/dev-setup.md`
- `docs/testflight.md`
- `docs/security.md`
- `docs/release-checklist.md`

## Stage 5: Live Activity / Dynamic Island

Goal: Add glanceable iPhone status after leaving the app.

Scope:

- ActivityKit + WidgetKit extension.
- Local Live Activity updates while app is active enough to update state.
- Lock Screen and Dynamic Island status summary.
- Tap opens the relevant request or session screen.

Non-goals:

- Do not put sensitive approval details directly in the Dynamic Island.
- Do not rely on Live Activity as the only approval notification path.

Exit criteria:

- Running command, waiting approval, failed, and done states display correctly.
- Live Activity can be started and ended from the app.
- Sensitive command details remain inside the app detail screen.

Docs to update:

- `docs/ios-live-activity.md`
- `docs/security.md`

## Stage 6: Remote Relay

Goal: Allow use outside the same local network while preserving trust boundaries.

Scope:

- Cloud relay prototype.
- Device binding.
- End-to-end or relay-minimized encryption design.
- APNs for notifications and Live Activity remote updates.
- Token rotation.
- Lost-device unlink flow.

Exit criteria:

- Remote approval works without exposing Windows daemon directly to the internet.
- Relay does not store source code or full command output by default.
- Threat model is documented.

Docs to update:

- `docs/relay.md`
- `docs/security.md`
- `docs/privacy.md`

## Stage 7: Community Release

Goal: Make the project understandable and usable for open-source users.

Scope:

- Public GitHub README.
- Windows installer or clear package command.
- iOS source-build guide and/or TestFlight public link.
- Demo video or GIF.
- Issue templates.
- Contribution guide.
- Stable protocol version.

Exit criteria:

- A developer who did not build the project can run the daemon and connect the desktop companion by following docs.
- iOS setup is documented when that stage exists.
- Security limitations are visible before installation.
- Protocol compatibility is versioned.
- Release checklist is repeatable.

Docs to update:

- `README.md`
- `docs/dev-setup.md`
- `docs/release-checklist.md`
- `docs/contributing.md`

## Stage Gate Rule

Before moving to the next stage:

1. Update the stage status.
2. Add or update at least one demo note.
3. Record any architectural decision that changed the plan.
4. Update security notes if permissions, networking, storage, or phone-visible data changed.
