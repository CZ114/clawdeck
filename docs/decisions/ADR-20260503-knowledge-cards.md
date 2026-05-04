# ADR-20260503 Knowledge Cards (Stage 1.5) — Reviewing past Claude Code sessions

## Status

Accepted (2026-05-03). First ADR in this repo.

## Context

Companion finished Stage 1 (Windows desktop bubble for approvals + status). The
original Stage 2 was a desktop-pet personality layer. Two things happened that
changed the priority:

1. The user explicitly deprioritized the desktop-pet ambition in favor of
   "enrich the existing approval surface first."
2. The user proposed a knowledge-card review feature: every day, derive
   review-worthy questions from the past few days of Claude Code sessions so
   they can self-test what they actually decided / learned.

This is squarely in Companion's wheelhouse — the daemon already records every
session event (`packages/daemon/src/index.js`), already parks pending requests,
and the bubble already has expanded modes for approval cards. Adding a "what
did I learn yesterday?" surface reuses all of that infrastructure.

The two design iterations are preserved as static HTML mockups so future
readers can see how the design evolved:

- [docs/knowledge-cards-v0.html](../knowledge-cards-v0.html) — first sketch:
  cards as a section embedded in the existing dashboard mode.
- [docs/knowledge-cards-v1.html](../knowledge-cards-v1.html) — current spec:
  cards as a dedicated mode, generation visualized in the controls strip,
  Duolingo-style mechanics, learning-focus prompt prefix, difficulty tiers,
  strict source attribution, empty-day fallback, markdown rendering + export.

## Decision

Add **Stage 1.5: Knowledge Cards** to `docs/stages.md`, insert before Stage 2.
Stage 2 (desktop pet) becomes **deferred** — re-evaluated only after Stage 1.5
ships and gets a few weeks of real use.

The Stage 1.5 design has eight load-bearing decisions. Each is below with
its rationale.

### 1. Generator: subprocess `claude -p`, not Anthropic API

Spawn the user's already-installed `claude` CLI in headless mode
(`claude -p "<prompt>"`). The session content is piped via stdin; cards JSON
arrives on stdout. **Never** call Anthropic's API directly.

**Why:** zero new credentials to configure, no separate billing surface, the
quality matches whatever model Claude Code is currently using, and Companion
never directly holds the user's API key.

**Tradeoff:** depends on `claude` being on `PATH`. If the user removes it,
generation fails — surface that as a clear error in the bubble's controls
strip, not silent failure.

### 2. Trigger: first-bubble-open OR scheduled, never blocking

Generation runs on either:
- **First open** of the desktop bubble each day (no `cards/<today>.json` yet).
- **Scheduled** time (default 22:00, configurable in Settings).
- **Manual** click on Settings · "Generate now".

The subprocess runs **detached from the bubble's main loop**. Approval
requests, peek behavior, and status updates continue working during
generation. The only UI signal is the controls-strip 📚 button switching to
🎴 + warm pulse (see Decision 3).

### 3. Generation-progress UI: controls strip 📚 button only

The bubble's main status orb keeps reporting real Claude Code state
(`Idle / Thinking / Done / …`). Generation progress is visualized **only** in
the controls-strip cards button:

- Idle, no cards: 📚 in `--ink-1` (faint).
- Has unread cards: 📚 in `--accent-sage` + small mono badge with count.
- Generating: 🎴 in `--accent-warm` + 1.8s pulse animation.

This was a course-correction from v0, where the main status was overwritten
by a `generating_cards` value — that hid real Claude Code state behind a
Companion-internal one, which is wrong.

### 4. Cards as a dedicated bubble mode (not a dashboard section)

Knowledge Cards live in a new `cards` mode (460 × 600), reachable from:

- The 📚 button in the controls strip.
- The 📚 N badge on the compact bubble.

The `cards` mode has three tabs: **Today** / **History** / **Wrong book**.

The legacy `dashboard` mode is **removed entirely** at the same time:

- Pending queue auto-expands to `approval` mode when there's a real request,
  so a separate "list of pending" view is redundant.
- Sessions, audit events, devices, pairing — all moved into Settings as
  expandable sections, default-collapsed.

Modes after this change: `compact / approval / question / cards / settings`.

### 5. Learning focus: user-supplied prompt prefix

Settings · Cards has a multi-line textarea **"What do you want to learn?"**.
Whatever the user types is prepended to every `claude -p` prompt as a
weighting hint:

```text
Learning focus (user's stated goal):
"""
{user_focus or "(not set — pick the most consequential decisions)"}
"""

Weight selection toward this focus when relevant content exists.
If today's sessions don't touch these areas, fall back to picking the
most consequential decisions of the day and report focus_coverage = 0.
```

The model returns `focus_coverage: 0..100` in the JSON, surfacable in the
Today tab as "Focus coverage X%". A focus snapshot is stored alongside each
day's cards (so the History tab can show "what focus was active when these
cards were generated").

Empty focus is fine — model picks generic "consequential decisions over
trivia."

### 6. Difficulty tiers: easy / medium / hard with explicit definitions

Every card carries a `difficulty` field with a strict definition the prompt
enforces:

| Tier | Definition | Bias |
|---|---|---|
| `easy` | Conceptual ("what is X / why does X exist") | choice questions |
| `medium` | Mechanism ("X works this way because Y" / "X's formula is Z") | choice + cloze |
| `hard` | Foundation ("the math/OS-level reason X behaves this way") | cloze + future short-answer |

User chooses a preference in Settings via segmented control:
**Casual** (≈70/25/5), **Balanced** (50/35/15), **Deep** (25/40/35).

Cards display a difficulty chip everywhere they appear (Today tab, review
mode, wrong book, history rows).

### 7. Strict source mode (hard-coded, not user-configurable)

Every card's JSON **must** carry `source.snippet` containing a verbatim quote
from the original session content. Cards without verifiable source are
discarded by the daemon before they ever reach the bubble.

In the UI:
- Each card's source is an expandable block; click → reveals the original
  multi-speaker session excerpt (user / assistant / edit, each a different
  accent color).
- Wrong feedback shows `From session: <verbatim quote>` instead of an AI-
  generated explanation.

We deliberately **do not expose a toggle** for this. Earlier mockups had a
"Strict source mode" toggle defaulting ON; we removed it because allowing
users to turn off source verification would let the model hallucinate
plausible-but-fake review questions about their own work — defeating the
entire point of "review what I actually did."

### 8. Empty-day fallback: replay from past N days + wrong book

When today has zero new sessions, the Today tab automatically switches to a
review-only state:

- Banner: "No new sessions today · pulling from past 7 days + wrong book"
- Cards drawn from: **wrong book first** (oldest first, until daily goal is
  filled or wrong book exhausted), then **past N days** (default 7,
  configurable 3 / 7 / 14 / 30, can be turned off entirely).
- CTA changes from "Start review" to "Start replay".
- Streak gets a `🛡 protected` shield — counts as a non-break day.

**Streak protection rules** (Duolingo-inspired):
- 1 consecutive empty day → `🛡 protected`, streak preserved.
- 2nd consecutive empty day → streak resets to 0.

The 1-day grace prevents one busy or sick day from killing a multi-week
streak, while keeping the streak itself meaningful.

### 9. Wrong book: per-difficulty mastery counts

Cards stay in the wrong book until the user answers them correctly N times
in a row, where N depends on difficulty:

- `easy`: 2 consecutive correct → removed.
- `medium`: 2 consecutive correct → removed.
- `hard`: 3 consecutive correct → removed.

Hard cards demand more reps because their material is more
foundation-level — getting it once might be lucky; getting it three times in
a row signals real grasp.

### 10. Markdown rendering + export

All daily abstracts are stored and rendered as markdown (h2/h3/lists/inline
code/blockquote — full theming in the existing dark color palette). Three
export targets, each producing a `.md` file with YAML frontmatter:

- `companion-YYYY-MM-DD.md` — single day's abstract + that day's cards.
- `companion-history.md` — all stored abstracts joined with `---` separators.
- `companion-wrong-book.md` — current wrong book contents.

Each file's frontmatter records the focus that was active at generation
time, the difficulty mix, and accuracy stats. Card Q/A pairs use a
`**Q**` / `**A**` two-line shape that's trivially convertible to Anki .csv.

### 11. Privacy: opt-in transcript exposure with deterministic redaction

Knowledge Cards is the **first feature in this repo that intentionally feeds
session content to a model**. All prior features (approvals / status / peek)
exchanged only summaries between hooks and the daemon.

To stay aligned with `docs/security.md` "Phone-visible data policy":

- The feature is **opt-in** by default. First time the user clicks
  "Generate now" or sees the auto-trigger, a one-shot consent dialog
  explains: "Companion will pipe the past 24h of session transcript to the
  local `claude` CLI. Estimated tokens: ~3k. Continue?"
- Before piping, the daemon runs a redaction pass:
  - Strip lines mentioning `.env`, `.envrc`, `secrets/`.
  - Replace anything matching common secret patterns (40+ char hex, JWT
    shape, GitHub PAT prefix `ghp_*`, AWS key prefix, bearer tokens).
  - Replace the user's home dir (`%USERPROFILE%` / `$HOME`) with `~` so
    user names don't leak in absolute paths.
- The opt-in state lives in `~/.claude-companion/cards-disabled` — same
  pattern as the existing `disabled` flag for the whole companion.

## Consequences

### Positive

- Companion gets a daily-use loop independent of "did I happen to need an
  approval today" — gives the bubble persistent value during long passive
  watching periods.
- The feature is a wholly local extension; no new external dependencies, no
  new credentials, no new network surface.
- `claude -p` reuse means the user's existing model access automatically
  carries through (Opus / Sonnet / Haiku, whichever they configured).
- The strict-source guarantee makes Companion a trustworthy review tool —
  every card maps back to something the user actually did.

### Negative / risks

- **Depends on `claude` being on PATH.** If the user uninstalls Claude Code
  but keeps Companion running, generation breaks. Mitigation: surface a
  clear error in the controls strip + Settings, not silent failure.
- **Token cost.** Each generation run is ~3-5k input tokens
  (24h of session content) + ~2k output. Daily auto-runs amortize to under
  $0.50/month at Opus rates — small but non-zero. The Settings consent
  dialog and the visible "last gen 22:14 · 3k tokens" footer keep this in
  user view.
- **First feature crossing the transcript-to-model line.** Documented as
  opt-in exception in `docs/security.md` (to be updated with the
  implementation).
- **More UI surface.** Adds a new mode (`cards`), reorganizes Settings,
  removes `dashboard` mode entirely. The mode count net stays the same
  (compact / approval / question / dashboard → compact / approval /
  question / cards / settings), but the migration needs careful rollout.

### Stage 2 deferral

The desktop-pet personality layer (original Stage 2) is **deferred**. The
intent isn't to cancel it forever — it just doesn't compete for the next
stage's attention. After Stage 1.5 has shipped and we've used it for a few
weeks, we re-evaluate whether the pet still feels worth pursuing or whether
Stage 3 (iOS local-network MVP) takes priority.

## Alternatives Considered

### Direct Anthropic API call (rejected)

Calling Anthropic's API directly with a separate `CCC_REVIEW_API_KEY` was the
first instinct. Rejected because:

- Adds setup friction (user has to find their key, copy it into a config).
- Splits Companion's billing surface from Claude Code's.
- Requires Companion to handle auth lifecycle (rotation, revocation,
  rate-limit retry).

The `claude -p` subprocess sidesteps all of this.

### Cards embedded in dashboard mode (v0 design, rejected)

The first mockup put a "Today's review" section inside the existing
dashboard. Rejected because:

- Dashboard was already too dense (pending queue + sessions + devices +
  audit + pairing).
- The cards feature deserves first-class navigation, not a buried section.
- The bubble's badge (📚 N) needs a one-click destination — a section nested
  in dashboard requires a two-step open.

The v1 redesign promotes cards to a dedicated mode and removes dashboard
entirely (its content migrates to Settings).

### `generating_cards` as a Claude Code status (v0 design, rejected)

The first mockup overloaded the bubble's main status orb to show
`generating_cards`. Rejected because the orb is supposed to report real
Claude Code state (idle / thinking / running / done) — overwriting it with a
Companion-internal state hides real activity. The v1 design moves
generation feedback into the controls strip, leaving the main status
untouched.

### Optional source mode (v1 mid-design, rejected)

A mid-iteration v1 had a "Strict source mode" toggle defaulting ON, leaving
users the option to disable it. Removed because:

- The whole point of "review what I actually did" requires verifiable
  source.
- A user who turned it off (intentionally or accidentally) would see
  hallucinated review questions and not know they were fake.
- Easy to undo later if a real use case for relaxed mode emerges; harder to
  retract a guarantee once given.

### Spaced-repetition algorithm at v0 (rejected, deferred)

A full Anki-style SM-2 / FSRS scheduler was tempting. Deferred because:

- Adds a non-trivial implementation surface for v0.
- Hard to tune without real usage data.
- Wrong-book-with-per-difficulty-mastery (Decision 9) gives 80% of the
  value with 10% of the complexity.

If the wrong-book flow ends up feeling too crude after a few weeks, revisit
in a follow-up ADR.

### Per-day learning focus (rejected)

Considered prompting the user every day for "this week's focus" or "today's
focus". Rejected for being too pestering — single persistent focus that the
user edits as needed (recorded as a snapshot per day for History) gets the
benefit without the friction.

## References

- Mockup v0: [docs/knowledge-cards-v0.html](../knowledge-cards-v0.html)
- Mockup v1: [docs/knowledge-cards-v1.html](../knowledge-cards-v1.html)
- Stage definition: [docs/stages.md](../stages.md) §"Stage 1.5"
- Security policy reference: [docs/security.md](../security.md) §"Surface
  Data Policy"
- Documentation framework: [docs/documentation-framework.md](../documentation-framework.md)
