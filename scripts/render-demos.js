#!/usr/bin/env node
/*
 * scripts/render-demos.js
 *
 * Headless-renders every sequence in demo/bubble-mockup.html into an APNG
 * under media/. No more manual ScreenToGif. Run with:
 *
 *     npm run render-demos
 *
 * Pipeline per sequence:
 *   1. Playwright launches headless Chromium with video recording enabled.
 *   2. Page loads demo/bubble-mockup.html?seq=<name>&ui=hidden.
 *   3. The demo's autoplay block fires runSeqByName(name); we poll the
 *      window.__seqDone flag the demo flips at the end of every sequence.
 *   4. Page closes → Playwright finalises the .webm.
 *   5. ffmpeg crops to the record-frame's bounding rect captured before
 *      close, scales to a sane width, encodes APNG with infinite loop.
 *   6. Source .webm gets cleaned up.
 *
 * Requires:
 *   - playwright (devDependency, plus `npx playwright install chromium`)
 *   - ffmpeg on PATH (`winget install ffmpeg` on Windows)
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_err) {
  console.error(
    "[render-demos] playwright is not installed.\n" +
    "  → npm install\n" +
    "  → npx playwright install chromium\n"
  );
  process.exit(1);
}

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DEMO_PATH = path.join(PROJECT_ROOT, "demo", "bubble-mockup.html");
const TMP_DIR = path.join(PROJECT_ROOT, ".tmp", "render-demos");
const OUT_DIR = path.join(PROJECT_ROOT, "media");

// Sequences mirror demo/bubble-mockup.html#sequences. `timeout` is the
// upper-bound wait for window.__seqDone (the 200 ms settle delay + the
// sequence's own playtime + a generous tail). `width` is the target APNG
// width — kept tight on simple sequences (status / themes are just the
// bubble) so the file stays small, full record-frame on the spatial
// sequences (edges / morph) so all 4 sides are visible.
// `width` is the encoded APNG width (preserves aspect). `fps` lets us trade
// motion-smoothness for file size on the dense sequences — cards / morph
// have lots of pixel churn (text changes, panel scrolls, cursor + ripple
// + heatmap highlight + button state flicks) so they balloon at 24 fps;
// 18-20 fps + tighter width keeps them under GitHub's 10 MB inline limit.
const SEQUENCES = [
  { name: "status",   output: "hero-status.apng",   timeout: 18000, width: 480, fps: 24 },
  { name: "themes",   output: "themes-cycle.apng",  timeout: 14000, width: 480, fps: 24 },
  { name: "edges",    output: "edges-cycle.apng",   timeout: 22000, width: 640, fps: 24 },
  { name: "approval", output: "approval-flow.apng", timeout: 12000, width: 520, fps: 24 },
  { name: "cards",    output: "cards-review.apng",  timeout: 22000, width: 460, fps: 18 },
  { name: "morph",    output: "hero-morph.apng",    timeout: 26000, width: 480, fps: 15 },
];

const VIEWPORT = { width: 1130, height: 1174 };

function checkFfmpeg() {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  if (r.status !== 0) {
    console.error(
      "[render-demos] ffmpeg not on PATH.\n" +
      "  → winget install ffmpeg   (Windows)\n" +
      "  → brew install ffmpeg     (macOS)\n" +
      "  → apt install ffmpeg      (Linux)\n"
    );
    process.exit(1);
  }
}

async function renderOne(browser, seq) {
  const start = Date.now();
  process.stdout.write(`[${seq.name}] launching… `);

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: {
      dir: TMP_DIR,
      size: VIEWPORT,
    },
  });

  const page = await context.newPage();
  const url = pathToFileURL(DEMO_PATH).toString() + `?seq=${seq.name}&ui=hidden`;
  await page.goto(url, { waitUntil: "load" });

  // Capture the .record-frame's screen-space bounds BEFORE running the
  // sequence — used as ffmpeg crop coords below.
  const cropRect = await page.evaluate(() => {
    const el = document.querySelector(".record-frame");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });
  if (!cropRect) throw new Error("record-frame not found in demo");

  process.stdout.write("recording… ");
  await page.waitForFunction(() => window.__seqDone === true, {
    timeout: seq.timeout,
  });

  // Tail so the final frame settles + Playwright flushes the encoder
  await page.waitForTimeout(400);
  await page.close();
  await context.close();

  // Find the most recently written webm in TMP_DIR (Playwright assigns a
  // random name per recording session)
  const webms = fs
    .readdirSync(TMP_DIR)
    .filter((f) => f.endsWith(".webm"))
    .map((f) => ({ f, t: fs.statSync(path.join(TMP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  if (!webms.length) throw new Error(`[${seq.name}] no webm produced`);
  const webmPath = path.join(TMP_DIR, webms[0].f);

  // The same crop/scale filter chain feeds both encoders below.
  const baseFilter =
    `crop=${cropRect.w}:${cropRect.h}:${cropRect.x}:${cropRect.y},` +
    `fps=${seq.fps},scale=${seq.width}:-1:flags=lanczos`;

  // 1) APNG — full 24-bit colour, infinite loop. -pred mixed keeps colour
  //    transitions smooth without ballooning size.
  const apngPath = path.join(OUT_DIR, seq.output);
  process.stdout.write("apng… ");
  const ffApng = spawnSync(
    "ffmpeg",
    [
      "-y", "-i", webmPath,
      "-vf", baseFilter,
      "-plays", "0",
      "-pred", "mixed",
      apngPath,
    ],
    { stdio: "ignore" }
  );

  // 2) GIF — same dims, palette generated from the clip itself for the
  //    best possible 256-colour approximation. Floyd-Steinberg dither
  //    smooths the OKLCH gradients GIF can't represent natively.
  const gifPath = apngPath.replace(/\.apng$/, ".gif");
  process.stdout.write("gif… ");
  const ffGif = spawnSync(
    "ffmpeg",
    [
      "-y", "-i", webmPath,
      "-vf",
      `${baseFilter},split[s0][s1];` +
      `[s0]palettegen=stats_mode=diff[p];` +
      `[s1][p]paletteuse=dither=floyd_steinberg:diff_mode=rectangle`,
      "-loop", "0",
      gifPath,
    ],
    { stdio: "ignore" }
  );

  fs.unlinkSync(webmPath);

  if (ffApng.status !== 0) {
    console.error(`\n[${seq.name}] apng ffmpeg failed (exit ${ffApng.status})`);
    return null;
  }
  if (ffGif.status !== 0) {
    console.error(`\n[${seq.name}] gif ffmpeg failed (exit ${ffGif.status})`);
  }

  const apngMB = fs.statSync(apngPath).size / 1024 / 1024;
  const gifMB =
    ffGif.status === 0 && fs.existsSync(gifPath)
      ? fs.statSync(gifPath).size / 1024 / 1024
      : 0;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `done · apng ${apngMB.toFixed(2)} MB · gif ${gifMB.toFixed(2)} MB · ${elapsed}s`
  );
  return apngPath;
}

async function main() {
  checkFfmpeg();
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const results = [];

  for (const seq of SEQUENCES) {
    try {
      const out = await renderOne(browser, seq);
      if (out) results.push(out);
    } catch (err) {
      console.error(`\n[${seq.name}] ${err.message}`);
    }
  }

  await browser.close();

  // Best-effort cleanup of any leftover .webm
  for (const f of fs.readdirSync(TMP_DIR)) {
    if (f.endsWith(".webm")) {
      try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch (_) {}
    }
  }

  console.log(`\nDone — ${results.length} / ${SEQUENCES.length} demos rendered.`);
  if (results.length < SEQUENCES.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
