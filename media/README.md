# media/

Image and GIF assets referenced by the project README.

Recording is driven from [`demo/bubble-mockup.html`](../demo/bubble-mockup.html)
— open it in a browser, press `H` to hide the controls bar, then trigger a
sequence with the keyboard shortcut.

## Files the README expects

The two **core** demos are split for cleaner recording:

| Filename | Trigger | What it shows | Suggested crop |
|---|---|---|---|
| `hero-status.gif` | `S` | **The orb in action.** Bubble stays in place, status cycles through every Claude state — Idle → Thinking (halo breathes) → Running tool (ring spins) → Awaiting approval (attention pulse) → Awaiting answer → Done (emoji bobs) → Idle. ~13 s. | **~380×72 tight** — only the bubble (it grows to ~330 px wide on long labels) |
| `edges-cycle.gif` | `E` | **Lives at your screen edge AND tucks away when not in use.** At each side (Right → Top → Left → Bottom): bubble glides in → briefly visible → physically slides off-screen leaving only a 12 px peek of capsule + the 4 px context slit → glides back out → next edge. Mirrors the real `compactPeekBounds` behavior 1:1. ~14 s. | **720×620 full frame** — match the dashed record-frame exactly |

Supporting demos:

| Filename | Trigger | What it shows | Suggested crop |
|---|---|---|---|
| `hero-morph.apng` | `M` | Cards-generation story: ⚙ Settings → drag-select 5 days in heatmap picker → ⤢ Live → click Generate → 📚 fresh deck. ~16 s. APNG (24 fps, full colour) — smoother than GIF on the morph + cursor moves. | 720×620 |
| `approval-flow.gif` | `A` | Bubble auto-morphs to Approval card on a Bash request, user clicks Approve, returns to compact + done flash. ~5 s. | 720×500 |
| `cards-review.gif` | `C` | 📚 → Start review → correct answer → wrong answer → reveal correct → close. ~13 s. | 720×620 |
| `themes-cycle.gif` | `T` | Compact bubble cycling through Midnight Teal → Amber Hearth → Paper Light → Aurora Indigo. ~8 s. | 540×140 |

> The whole demo page now fits within **1130 × 1174 px** so it lives in a single browser viewport — no scrolling needed even when ScreenToGif's selector is on top of the window.

GitHub renders ≤10 MB inline; keep each clip ≤8 MB to be safe.

## Auto-render (recommended)

One command rebuilds every APNG in this folder from `demo/bubble-mockup.html`
— no manual ScreenToGif clicking, deterministic timing, drives the same
sequences the keyboard shortcuts trigger.

**One-time setup**

```powershell
winget install ffmpeg            # ffmpeg on PATH
npm install                      # pulls playwright
npx playwright install chromium  # the headless browser playwright drives
```

**Render**

```powershell
npm run render-demos
```

About 1–2 minutes. Output goes straight into this folder
(`hero-status.apng`, `edges-cycle.apng`, `hero-morph.apng`,
`approval-flow.apng`, `cards-review.apng`, `themes-cycle.apng`).

The script ([../scripts/render-demos.js](../scripts/render-demos.js))
launches headless Chromium, navigates to each
`demo/bubble-mockup.html?seq=<name>&ui=hidden`, polls
`window.__seqDone` to know when the sequence finishes, then ffmpeg-crops
the video to the record-frame and encodes it as an infinite-loop APNG.

After every demo HTML change, just `npm run render-demos` again.

## Manual record (fallback)

1. Install [ScreenToGif](https://www.screentogif.com/) (free) — `winget install ScreenToGif` works.
2. Open [`demo/bubble-mockup.html`](../demo/bubble-mockup.html) in Chrome / Edge.
3. Press <kbd>R</kbd> to reset state.
4. Press <kbd>H</kbd> to hide the controls bar + dashed record-frame border. Page now shows just the bubble on a dark backdrop.
5. ScreenToGif → New Recorder → drag a 720×680 (or per the table) box centred on the bubble.
6. Hit record, immediately press the sequence shortcut (<kbd>S</kbd> / <kbd>M</kbd> / <kbd>A</kbd> / <kbd>C</kbd> / <kbd>T</kbd>).
7. Wait for the sequence to complete + return to idle, stop recording.
8. In the editor: **Image → Reduce Frame Count** (keep 1/2 frames, halves file size) → **Edit → Crop** if needed → **File → Save as → GIF** with the filename from the table.
9. Drop into this `media/` directory.

The bubble's liquid morph is 280 ms — record at 30+ fps so the bouncy curve reads smoothly even after the post-export frame reduction.

## Tips

- The cursor SVG is white-with-black-outline so it stays visible on every theme.
- For `themes-cycle.gif`, use a fresh open of the demo (theme starts on Midnight Teal) so the cycle ends back at the default.
- For `hero-status.gif`, the bubble docks to the right side of the record-frame — leave the recording box wide enough to capture the bubble at its rightmost position.
