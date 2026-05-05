#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// File-based debug log — packaged Electron eats stdout/stderr, so we
// route key events to ~/.claude-companion/clawdeck-debug.log. Cheap
// and self-rotating: truncated to last 200 lines on each launch.
const DEBUG_LOG = path.join(os.homedir(), ".claude-companion", "clawdeck-debug.log");
function debugLog(msg) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
  } catch (_e) {}
}
debugLog(`main.js boot — argv=${JSON.stringify(process.argv)}`);

// Crash forensics — without these, the bubble silently disappears
// after 10-30 minutes (Node 22's default for unhandledRejection is to
// crash the process, but we never logged the stack). Catching all
// four channels here means the next time the app dies we have a
// breadcrumb in clawdeck-debug.log instead of dead silence.
//
// IMPORTANT: we LOG and KEEP RUNNING for unhandled rejections /
// uncaught exceptions in steady state. Pre-Electron-load failures
// (DPR=2 webm garbage, missing modules) still process.exit normally.
process.on("uncaughtException", (err, origin) => {
  debugLog(`uncaughtException at ${origin}: ${err && err.stack || err}`);
});
process.on("unhandledRejection", (reason) => {
  debugLog(`unhandledRejection: ${reason && reason.stack || reason}`);
});
process.on("warning", (w) => {
  // Node sometimes turns memory leaks into MaxListenersExceededWarning
  // — capturing them here lets us spot leaks BEFORE they OOM the app.
  debugLog(`warning: ${w.name}: ${w.message}`);
});
process.on("exit", (code) => {
  debugLog(`process exit code=${code}`);
});

// CLI hook-management modes — handled BEFORE we touch Electron's app
// shell, so the .exe can act as a tiny utility for the NSIS installer +
// uninstaller without flashing a window. Each branch exits the process.
const argv = process.argv.slice(1);
function hasFlag(name) {
  return argv.includes(`--${name}`);
}

function runHookCli({ uninstall }) {
  const {
    USER_SETTINGS_PATH,
    mergeManagedHooks,
    readSettings
  } = require("../../scripts/lib/claude-settings");

  let settings;
  try {
    settings = readSettings(USER_SETTINGS_PATH);
  } catch (error) {
    console.error(`[clawdeck] failed to read ${USER_SETTINGS_PATH}: ${error.message}`);
    process.exit(1);
  }

  const before = JSON.stringify(settings, null, 2) + "\n";
  const report = mergeManagedHooks(settings, { uninstall });
  const after = JSON.stringify(settings, null, 2) + "\n";

  if (before !== after) {
    try {
      fs.mkdirSync(path.dirname(USER_SETTINGS_PATH), { recursive: true });
      // Atomic write via tmp + rename so we never leave a half-written
      // settings.json that breaks Claude Code on the user's next launch.
      const tmp = `${USER_SETTINGS_PATH}.clawdeck.tmp`;
      fs.writeFileSync(tmp, after, "utf8");
      fs.renameSync(tmp, USER_SETTINGS_PATH);
    } catch (error) {
      console.error(`[clawdeck] failed to write ${USER_SETTINGS_PATH}: ${error.message}`);
      process.exit(1);
    }
  }

  console.log(
    `[clawdeck] hooks ${uninstall ? "uninstalled" : "installed"} · removed ${report.removedManagedHookEntries} · added ${report.addedHookEntries}`
  );
  process.exit(0);
}

if (hasFlag("install-hooks")) {
  runHookCli({ uninstall: false });
}
if (hasFlag("uninstall-hooks")) {
  runHookCli({ uninstall: true });
}

const { app, BrowserWindow, dialog, ipcMain, shell, Tray, Menu, nativeImage } = require("electron");

// Electron-side crash forensics — companion to the Node-level handlers
// above. These cover surfaces Node's process events miss: GPU process,
// renderer process, utility / extension processes, generic child procs.
app.on("render-process-gone", (_event, webContents, details) => {
  debugLog(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
});
app.on("child-process-gone", (_event, details) => {
  debugLog(`child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode} name=${details.name || ""}`);
});
app.on("gpu-process-crashed", (_event, killed) => {
  debugLog(`gpu-process-crashed killed=${killed}`);
});

// Same path the hook scripts check via shared/protocol.js#isCompanionDisabled.
const COMPANION_DIR = path.join(os.homedir(), ".claude-companion");
const COMPANION_DISABLED_FLAG = path.join(COMPANION_DIR, "disabled");
const DESKTOP_STATE_FILE = path.join(COMPANION_DIR, "desktop-state.json");
const DESKTOP_STATE_VERSION = 1;
const DESKTOP_STATE_WRITE_DELAY_MS = 220;
const WINDOW_PRIORITY_REAPPLY_MS = 2500;

function readCompanionEnabled() {
  try {
    return !fs.existsSync(COMPANION_DISABLED_FLAG);
  } catch (_error) {
    return true;
  }
}

function setCompanionEnabled(enabled) {
  try {
    if (enabled) {
      if (fs.existsSync(COMPANION_DISABLED_FLAG)) {
        fs.unlinkSync(COMPANION_DISABLED_FLAG);
      }
    } else {
      fs.mkdirSync(COMPANION_DIR, { recursive: true });
      fs.writeFileSync(COMPANION_DISABLED_FLAG, "1", "utf8");
    }
  } catch (error) {
    console.warn(`[warn] Failed to flip companion-disabled flag: ${error.message}`);
  }
  if (mainWindow) {
    mainWindow.webContents.send("companion:enabled-changed", enabled);
  }
  return enabled;
}

// CAPSULE_BOUNDS = the visible bubble (what the user perceives as the
// island). MODE_BOUNDS adds BUBBLE_PADDING on every side so the soft drop
// shadow has somewhere to render — Win11 won't paint a rectangle in the
// gutter as long as the BrowserWindow opts out of thickFrame, mica, and
// roundedCorners (see createWindow).
const BUBBLE_PADDING = 12;
const CAPSULE_BOUNDS = {
  compact: { width: 124, height: 42 },
  // 280 (was 238) — at the old height the request-summary box and the
  // Approve/Deny row were both clipped by .island's overflow:hidden when
  // cwd / reason ran more than one line. 280 leaves comfortable room.
  approval: { width: 360, height: 280 },
  question: { width: 360, height: 300 },
  // cards: knowledge-cards mode (Stage 1.5). Today / History / Wrong-book
  // tabs, daily abstract, active-review flow.
  cards: { width: 460, height: 600 },
  // settings: replaces the old dashboard mode. Knowledge Cards config plus
  // collapsible sections for sessions / activity / devices / pairing.
  settings: { width: 440, height: 580 },
  // live: dedicated "monitor" surface — active Claude sessions + today's
  // deck + Knowledge Cards entry. Lives outside settings so the user can
  // open it with one click from the controls strip.
  live: { width: 380, height: 440 }
};
const COMPACT_HOVER_CAPSULE = { width: 224, height: 42 };
// Compact bubble layout constants — mirror the CSS measurements in
// styles.css (.status-bar padding, .drag-region gap, .status-orb size,
// .window-actions strip dimensions). Used by compactCapsule() below to
// resize the OS window so the status text always fits without being
// clipped by the absolute-positioned controls strip on hover.
const COMPACT_PAD_L = 9;          // .status-bar padding-left in compact
const COMPACT_PAD_R = 14;         // breathing room on the right when no controls
const COMPACT_ORB_W = 26;         // .status-orb width in compact
const COMPACT_GAP   = 9;          // .drag-region gap between orb and text
const COMPACT_TEXT_GAP_BEFORE_CONTROLS = 12; // safety gap before controls strip
const COMPACT_CONTROLS_W = 140;   // 6×20 buttons + 5×3 gaps + 2.5×2 padding
const COMPACT_CONTROLS_R = 7;     // .window-actions right offset
const COMPACT_TEXT_W_MIN = 32;    // baseline width (~"Idle")
const COMPACT_TEXT_W_MAX = 220;   // safety cap so a runaway label can't widen indefinitely
let compactTextWidth = COMPACT_TEXT_W_MIN; // updated by renderer via IPC

function paddedBounds(b) {
  return { width: b.width + 2 * BUBBLE_PADDING, height: b.height + 2 * BUBBLE_PADDING };
}

// Dynamic compact capsule. The OS BrowserWindow is rectangular and clicks
// through the transparent gutter bind to its bounds, so the bubble must
// physically resize to accommodate the visible status text. Renderer reports
// the rendered .status-text pixel width via window:set-status-width; main
// recomputes the capsule and animates to the new bounds.
function compactCapsule(expanded) {
  const textW = clamp(compactTextWidth, COMPACT_TEXT_W_MIN, COMPACT_TEXT_W_MAX);
  const baseW = COMPACT_PAD_L + COMPACT_ORB_W + COMPACT_GAP + textW + COMPACT_PAD_R;
  if (!expanded) {
    return { width: Math.max(CAPSULE_BOUNDS.compact.width, baseW), height: 42 };
  }
  const expandedW = COMPACT_PAD_L + COMPACT_ORB_W + COMPACT_GAP + textW
    + COMPACT_TEXT_GAP_BEFORE_CONTROLS + COMPACT_CONTROLS_W + COMPACT_CONTROLS_R;
  return { width: Math.max(COMPACT_HOVER_CAPSULE.width, expandedW), height: 42 };
}
function compactBounds(expanded) {
  return paddedBounds(compactCapsule(expanded));
}

const MODE_BOUNDS = {
  compact: paddedBounds(CAPSULE_BOUNDS.compact),
  approval: paddedBounds(CAPSULE_BOUNDS.approval),
  question: paddedBounds(CAPSULE_BOUNDS.question),
  cards: paddedBounds(CAPSULE_BOUNDS.cards),
  settings: paddedBounds(CAPSULE_BOUNDS.settings),
  live: paddedBounds(CAPSULE_BOUNDS.live)
};
const MAX_MODE_BOUNDS = Object.values(MODE_BOUNDS).reduce((acc, b) => ({
  width: Math.max(acc.width, b.width),
  height: Math.max(acc.height, b.height)
}), { width: 0, height: 0 });
const COMPACT_HOVER_BOUNDS = paddedBounds(COMPACT_HOVER_CAPSULE);
const EDGE_PADDING = 8;
const SNAP_DISTANCE = 48;
const SNAP_DETACH_DISTANCE = 24;
const SNAP_REATTACH_COOLDOWN_MS = 650;
const MOVE_DEBOUNCE_MS = 160;
const PEEK_VISIBLE_PX = 12;
const AUTO_PEEK_ON_EDGE = true;
const HOVER_COLLAPSE_DELAY_MS = 280;
const HOVER_MIN_VISIBLE_MS = 700;
const HOVER_HYSTERESIS_PX = 18;
// How long the bubble stays expanded after a session reaches `done` while
// snapped at an edge. After this it tucks back into a peek slit, but the
// peek slit keeps pulsing (see styles.css peekDoneGlow) until the user
// actually moves the pointer over it.
const DONE_ATTENTION_MS = 10 * 60 * 1000;
// How long the bubble pops out for non-`done` status changes (thinking,
// running_tool, waiting, etc.) while snapped. Brief glance, then auto-tucks
// back so the user isn't permanently distracted by transient state. A new
// status arriving cancels the running timer and starts a fresh cycle —
// including new-status-after-done, which retracts a stuck done bubble.
const STATUS_POPOUT_MS = Math.max(1000, Number(process.env.CCC_STATUS_POPOUT_MS) || 2000);

let mainWindow = null;
let tray = null;
// True only while we're running app.quit() — lets the close-on-Alt+F4
// path know the difference between a user closing the bubble (just hide
// to tray, keep daemon running) and an explicit Quit from the tray menu.
let isQuitting = false;
let currentMode = "compact";
let boundsAnimation = null;
let snappedEdges = { horizontal: null, vertical: null };
let snapDebounceTimer = null;
let isPeeking = false;
let compactHoverExpanded = false;
let lastSentHoverExpanded = false;
let snapSuppressedUntil = 0;
let compactCollapseTimer = null;
let compactHoverVisibleSince = 0;
let attentionState = null;
let statusPopoutTimer = null;
let peekHoverPollTimer = null;
let desktopStateWriteTimer = null;
let windowPriorityTimer = null;
let initialDesktopState = null;
// holdOpen is set while a system-modal control on the bubble (currently the
// macOS color picker) is open. The picker steals pointer focus, which would
// otherwise auto-collapse the compact bubble and dismiss the controls strip
// before the user can pick a color. While held, both the compact-collapse
// timer and the peek-unhover transition are suppressed.
let holdOpen = false;
const HOLD_OPEN_FALLBACK_MS = 30_000;
let holdOpenFallbackTimer = null;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}

// Liquid water-droplet easing — overshoots the target ~6% then settles.
// Mirrors the rubber-band physics of iOS/macOS dynamic island morphs.
// Curve mimics cubic-bezier(0.34, 1.56, 0.64, 1) when sampled at the
// fixed points the renderer's CSS transition uses, so the OS window
// resize and the renderer's border-radius / scale animation read as
// one continuous "droplet stretch" instead of two separate transitions.
function easeOutDroplet(t) {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function normalizeEdge(value, allowed) {
  return allowed.includes(value) ? value : null;
}

function normalizeSnappedEdges(value) {
  const edges = value && typeof value === "object" ? value : {};
  return {
    horizontal: normalizeEdge(edges.horizontal, ["left", "right"]),
    vertical: normalizeEdge(edges.vertical, ["top", "bottom"])
  };
}

function normalizeMode(value) {
  return MODE_BOUNDS[value] ? value : "compact";
}

function isPlainBounds(value) {
  return value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.width) &&
    Number.isFinite(value.height);
}

function readDesktopState() {
  const state = readJsonFile(DESKTOP_STATE_FILE);
  if (!state || state.version !== DESKTOP_STATE_VERSION) {
    return null;
  }

  const mode = normalizeMode(state.mode);
  const edges = normalizeSnappedEdges(state.snappedEdges);
  const bounds = isPlainBounds(state.bounds) ? state.bounds : null;
  return {
    mode,
    bounds,
    snappedEdges: edges,
    isPeeking: Boolean(state.isPeeking && mode === "compact" && (edges.horizontal || edges.vertical))
  };
}

function displayForBounds(bounds) {
  const { screen } = require("electron");
  if (bounds) {
    return screen.getDisplayMatching(bounds);
  }
  return screen.getPrimaryDisplay();
}

function clampBoundsToWorkArea(bounds) {
  const display = displayForBounds(bounds);
  const workArea = display.workArea;
  const maxX = workArea.x + workArea.width - bounds.width + BUBBLE_PADDING;
  const maxY = workArea.y + workArea.height - bounds.height + BUBBLE_PADDING;
  return {
    ...bounds,
    x: clamp(bounds.x, workArea.x - BUBBLE_PADDING, maxX),
    y: clamp(bounds.y, workArea.y - BUBBLE_PADDING, maxY)
  };
}

function defaultInitialBounds() {
  const { screen } = require("electron");
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const initial = MODE_BOUNDS.compact;
  return {
    width: initial.width,
    height: initial.height,
    x: workArea.x + Math.round((workArea.width - initial.width) / 2),
    y: workArea.y + 18
  };
}

function initialBoundsFromDesktopState(state) {
  if (!state || !state.bounds) {
    return defaultInitialBounds();
  }

  const mode = normalizeMode(state.mode);
  const size = MODE_BOUNDS[mode] || MODE_BOUNDS.compact;
  return clampBoundsToWorkArea({
    x: Math.round(state.bounds.x),
    y: Math.round(state.bounds.y),
    width: size.width,
    height: size.height
  });
}

function desktopStateSnapshot() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return null;
  }
  const { screen } = require("electron");
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  return {
    version: DESKTOP_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    mode: currentMode,
    bounds,
    snappedEdges,
    isPeeking,
    displayId: display.id
  };
}

function writeDesktopStateNow() {
  const snapshot = desktopStateSnapshot();
  if (!snapshot) {
    return;
  }
  try {
    fs.mkdirSync(COMPANION_DIR, { recursive: true });
    fs.writeFileSync(DESKTOP_STATE_FILE, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  } catch (error) {
    console.warn(`[warn] Failed to persist desktop state: ${error.message}`);
  }
}

function scheduleDesktopStateSave() {
  if (desktopStateWriteTimer) {
    clearTimeout(desktopStateWriteTimer);
  }
  desktopStateWriteTimer = setTimeout(() => {
    desktopStateWriteTimer = null;
    writeDesktopStateNow();
  }, DESKTOP_STATE_WRITE_DELAY_MS);
}

function compactSize() {
  // Dynamic — width grows to fit the current status-text label so long
  // statuses ("Awaiting approval", "Running tool · Bash") never get clipped
  // by the controls strip on the right.
  return compactBounds(compactHoverExpanded);
}

// All snap math operates on the BrowserWindow size, but the user perceives
// the CAPSULE (BrowserWindow minus BUBBLE_PADDING gutter on every side).
// Helper to translate desired capsule-edge offsets into BrowserWindow ones.
function snapInset(mode) {
  const edgeGap = mode === "compact" ? 0 : EDGE_PADDING;
  return edgeGap - BUBBLE_PADDING;
}

function targetBoundsForMode(mode) {
  const { screen } = require("electron");
  const size = mode === "compact" ? compactSize() : MODE_BOUNDS[mode] || MODE_BOUNDS.compact;
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const workArea = display.workArea;
  const inset = snapInset(mode);
  const centeredX = current.x + Math.round((current.width - size.width) / 2);
  let x = clamp(centeredX, workArea.x + inset, workArea.x + workArea.width - size.width - inset);
  let y = clamp(current.y, workArea.y + inset, workArea.y + workArea.height - size.height - inset);

  if (snappedEdges.horizontal === "left") {
    x = workArea.x + inset;
  } else if (snappedEdges.horizontal === "right") {
    x = workArea.x + workArea.width - size.width - inset;
  }

  if (snappedEdges.vertical === "top") {
    y = workArea.y + inset;
  } else if (snappedEdges.vertical === "bottom") {
    y = workArea.y + workArea.height - size.height - inset;
  }

  return { x, y, width: size.width, height: size.height };
}

function animateWindowBounds(target, durationMs = 190, onComplete, opts) {
  if (!mainWindow) {
    return;
  }

  if (boundsAnimation) {
    clearInterval(boundsAnimation);
    boundsAnimation = null;
  }

  // Liquid morph mode: bouncy overshoot easing so the bubble stretches
  // toward the target like a water droplet under tension. Used for
  // mode→mode transitions; small adjustments (peek / hover) stay on the
  // gentle easeOutCubic so they don't feel jittery.
  const easing = (opts && opts.liquid) ? easeOutDroplet : easeOutCubic;
  const start = mainWindow.getBounds();
  const startedAt = Date.now();

  boundsAnimation = setInterval(() => {
    if (!mainWindow) {
      clearInterval(boundsAnimation);
      boundsAnimation = null;
      return;
    }

    const progress = clamp((Date.now() - startedAt) / durationMs, 0, 1);
    const eased = easing(progress);
    const next = {
      x: Math.round(start.x + (target.x - start.x) * eased),
      y: Math.round(start.y + (target.y - start.y) * eased),
      width: Math.round(start.width + (target.width - start.width) * eased),
      height: Math.round(start.height + (target.height - start.height) * eased)
    };

    mainWindow.setBounds(next);

    if (progress >= 1) {
      clearInterval(boundsAnimation);
      boundsAnimation = null;
      mainWindow.setBounds(target);
      if (typeof onComplete === "function") {
        onComplete();
      }
    }
  }, 16);
}

function compactSnappedBounds(expanded = compactHoverExpanded) {
  // For compact + snapped, the CAPSULE is flush with the work area edge.
  // The BrowserWindow extends BUBBLE_PADDING past the edge so the gutter
  // (where the shadow renders) overhangs into the screen bezel area.
  const { screen } = require("electron");
  const size = compactBounds(expanded);
  const current = mainWindow.getBounds();
  const display = screen.getDisplayMatching(current);
  const workArea = display.workArea;
  const inset = -BUBBLE_PADDING; // capsule-flush in compact mode
  const centeredX = current.x + Math.round((current.width - size.width) / 2);
  let x = clamp(centeredX, workArea.x + inset, workArea.x + workArea.width - size.width - inset);
  let y = clamp(current.y, workArea.y + inset, workArea.y + workArea.height - size.height - inset);

  if (snappedEdges.horizontal === "left") {
    x = workArea.x + inset;
  } else if (snappedEdges.horizontal === "right") {
    x = workArea.x + workArea.width - size.width - inset;
  }

  if (snappedEdges.vertical === "top") {
    y = workArea.y + inset;
  } else if (snappedEdges.vertical === "bottom") {
    y = workArea.y + workArea.height - size.height - inset;
  }

  return { x, y, width: size.width, height: size.height };
}

function compactPeekBounds() {
  const full = compactSnappedBounds();
  const result = { ...full };

  // Show PEEK_VISIBLE_PX of the CAPSULE past the snapped edge. We have to
  // subtract 2*BUBBLE_PADDING because the BrowserWindow already overhangs
  // the work area by BUBBLE_PADDING in compactSnappedBounds AND the shift
  // needs to expose only the capsule (not the gutter) in the visible PEEK.
  const capsuleSpan = (axis) => axis === "x"
    ? full.width - 2 * BUBBLE_PADDING - PEEK_VISIBLE_PX
    : full.height - 2 * BUBBLE_PADDING - PEEK_VISIBLE_PX;

  if (snappedEdges.horizontal === "left") {
    result.x = full.x - capsuleSpan("x");
  } else if (snappedEdges.horizontal === "right") {
    result.x = full.x + capsuleSpan("x");
  } else if (snappedEdges.vertical === "top") {
    result.y = full.y - capsuleSpan("y");
  } else if (snappedEdges.vertical === "bottom") {
    result.y = full.y + capsuleSpan("y");
  }

  return result;
}

function isSnapped() {
  return Boolean(snappedEdges.horizontal || snappedEdges.vertical);
}

function sendSnapChanged() {
  if (!mainWindow) {
    return;
  }
  mainWindow.webContents.send("window:snap-changed", snappedEdges);
}

function sendAttentionChanged() {
  if (!mainWindow) {
    return;
  }
  mainWindow.webContents.send("window:attention-changed", attentionState);
}

function sendHoverExpandedChanged() {
  if (!mainWindow) {
    return;
  }
  // Compact mode's resting capsule is too narrow to hold the controls strip
  // alongside the orb + label. The renderer uses this signal to gate
  // window-actions visibility on whether the bubble has actually expanded
  // (avoiding the brief overlap during the 170ms hover-expand animation).
  const expanded = currentMode !== "compact" || compactHoverExpanded;
  if (expanded === lastSentHoverExpanded) {
    return;
  }
  lastSentHoverExpanded = expanded;
  mainWindow.webContents.send("window:hover-expanded-changed", expanded);
}

function clearHoldOpenFallback() {
  if (holdOpenFallbackTimer) {
    clearTimeout(holdOpenFallbackTimer);
    holdOpenFallbackTimer = null;
  }
}

function setHoldOpen(value) {
  const next = Boolean(value);
  if (next === holdOpen) {
    return;
  }
  holdOpen = next;
  if (holdOpen) {
    clearCompactCollapseTimer();
    clearHoldOpenFallback();
    holdOpenFallbackTimer = setTimeout(() => {
      holdOpenFallbackTimer = null;
      holdOpen = false;
      // After the fallback fires, fall back to the normal collapse path so
      // we don't get stuck pinned open if the picker never reports closed.
      if (mainWindow && currentMode === "compact" && compactHoverExpanded) {
        scheduleCompactCollapse();
      }
    }, HOLD_OPEN_FALLBACK_MS);
    return;
  }
  clearHoldOpenFallback();
  // When the user finishes with the picker, re-enter the normal collapse
  // schedule so the bubble eventually tucks back even if the cursor is still
  // off the bubble.
  if (mainWindow && currentMode === "compact" && compactHoverExpanded) {
    scheduleCompactCollapse();
  }
}

function reinforceWindowPriority() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  try {
    mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (!mainWindow.isMinimized() && mainWindow.isVisible()) {
      mainWindow.moveTop();
    }
  } catch (error) {
    console.warn(`[warn] Failed to reinforce desktop window priority: ${error.message}`);
  }
}

function startWindowPriorityGuard() {
  reinforceWindowPriority();
  if (windowPriorityTimer) {
    clearInterval(windowPriorityTimer);
  }
  windowPriorityTimer = setInterval(reinforceWindowPriority, WINDOW_PRIORITY_REAPPLY_MS);
}

function stopWindowPriorityGuard() {
  if (windowPriorityTimer) {
    clearInterval(windowPriorityTimer);
    windowPriorityTimer = null;
  }
}

function setAttentionState(nextState) {
  const normalized = nextState || null;
  if (attentionState === normalized) {
    return;
  }
  attentionState = normalized;
  sendAttentionChanged();
}

function clearCompactCollapseTimer() {
  if (compactCollapseTimer) {
    clearTimeout(compactCollapseTimer);
    compactCollapseTimer = null;
  }
}

function clearStatusPopoutTimer() {
  if (statusPopoutTimer) {
    clearTimeout(statusPopoutTimer);
    statusPopoutTimer = null;
  }
}

function clearDoneAttention() {
  clearStatusPopoutTimer();
  setAttentionState(null);
}

function pointInBounds(point, bounds, padding = 0) {
  return point.x >= bounds.x - padding &&
    point.x <= bounds.x + bounds.width + padding &&
    point.y >= bounds.y - padding &&
    point.y <= bounds.y + bounds.height + padding;
}

function distanceFromSnappedEdge(bounds) {
  if (!isSnapped()) {
    return 0;
  }

  const { screen } = require("electron");
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const values = [];

  // Reference values are in CAPSULE coords; subtract BUBBLE_PADDING to bring
  // them back to BrowserWindow coords (since `bounds` is the BrowserWindow
  // and is offset by the gutter).
  if (snappedEdges.horizontal === "left") {
    const reference = isPeeking
      ? workArea.x - (bounds.width - BUBBLE_PADDING - PEEK_VISIBLE_PX)
      : workArea.x - BUBBLE_PADDING;
    values.push(bounds.x - reference);
  } else if (snappedEdges.horizontal === "right") {
    const reference = isPeeking
      ? workArea.x + workArea.width - PEEK_VISIBLE_PX - BUBBLE_PADDING
      : workArea.x + workArea.width - bounds.width + BUBBLE_PADDING;
    values.push(reference - bounds.x);
  }

  if (snappedEdges.vertical === "top") {
    const reference = isPeeking
      ? workArea.y - (bounds.height - BUBBLE_PADDING - PEEK_VISIBLE_PX)
      : workArea.y - BUBBLE_PADDING;
    values.push(bounds.y - reference);
  } else if (snappedEdges.vertical === "bottom") {
    const reference = isPeeking
      ? workArea.y + workArea.height - PEEK_VISIBLE_PX - BUBBLE_PADDING
      : workArea.y + workArea.height - bounds.height + BUBBLE_PADDING;
    values.push(reference - bounds.y);
  }

  return Math.max(...values.map((value) => Math.max(0, value)), 0);
}

function detachFromEdge() {
  if (!mainWindow || !isSnapped()) {
    return;
  }

  snappedEdges = { horizontal: null, vertical: null };
  isPeeking = false;
  compactHoverExpanded = false;
  clearCompactCollapseTimer();
  clearDoneAttention();
  snapSuppressedUntil = Date.now() + SNAP_REATTACH_COOLDOWN_MS;
  mainWindow.webContents.send("window:peek-changed", false);
  sendSnapChanged();
  sendHoverExpandedChanged();
  scheduleDesktopStateSave();
}

function enterPeek() {
  if (!mainWindow || isPeeking) {
    return;
  }
  if (!AUTO_PEEK_ON_EDGE) {
    return;
  }
  if (currentMode !== "compact" || !isSnapped()) {
    return;
  }
  if (holdOpen) {
    return;
  }
  clearCompactCollapseTimer();
  compactHoverExpanded = false;
  sendHoverExpandedChanged();
  isPeeking = true;
  animateWindowBounds(compactPeekBounds(), 180, scheduleDesktopStateSave);
  mainWindow.webContents.send("window:peek-changed", true);
  startPeekHoverPolling();
}

function exitPeek() {
  if (!mainWindow || !isPeeking) {
    return;
  }
  isPeeking = false;
  stopPeekHoverPolling();
  if (currentMode === "compact" && isSnapped()) {
    compactHoverExpanded = true;
    compactHoverVisibleSince = Date.now();
    sendHoverExpandedChanged();
    animateWindowBounds(compactSnappedBounds(true), 170, scheduleDesktopStateSave);
  }
  mainWindow.webContents.send("window:peek-changed", false);
}

// The renderer's pointerenter/pointerleave fire stale signals after the
// window slides off-screen for peek — Chromium doesn't synthesize an enter
// event when the bounds shift out from under a stationary cursor. Polling
// the OS cursor directly here bypasses the whole web hover state machine.
function startPeekHoverPolling() {
  if (peekHoverPollTimer || !mainWindow) {
    return;
  }
  peekHoverPollTimer = setInterval(() => {
    if (!mainWindow || !isPeeking) {
      stopPeekHoverPolling();
      return;
    }
    const { screen } = require("electron");
    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();
    if (pointInBounds(cursor, bounds)) {
      stopPeekHoverPolling();
      setCompactHover(true);
    }
  }, 80);
}

function stopPeekHoverPolling() {
  if (peekHoverPollTimer) {
    clearInterval(peekHoverPollTimer);
    peekHoverPollTimer = null;
  }
}

function collapseCompactHoverNow() {
  if (!mainWindow || currentMode !== "compact") {
    return;
  }

  compactHoverExpanded = false;
  sendHoverExpandedChanged();
  if (isSnapped()) {
    enterPeek();
    return;
  }

  animateWindowBounds(targetBoundsForMode("compact"), 150);
}

function scheduleCompactCollapse() {
  if (!mainWindow || currentMode !== "compact") {
    return;
  }
  if (holdOpen) {
    return;
  }

  clearCompactCollapseTimer();
  const visibleFor = Date.now() - compactHoverVisibleSince;
  const delay = Math.max(HOVER_COLLAPSE_DELAY_MS, HOVER_MIN_VISIBLE_MS - visibleFor);

  compactCollapseTimer = setTimeout(() => {
    compactCollapseTimer = null;

    if (!mainWindow || currentMode !== "compact") {
      return;
    }
    if (holdOpen) {
      return;
    }

    const { screen } = require("electron");
    const cursor = screen.getCursorScreenPoint();
    if (pointInBounds(cursor, mainWindow.getBounds(), HOVER_HYSTERESIS_PX)) {
      scheduleCompactCollapse();
      return;
    }

    collapseCompactHoverNow();
  }, delay);
}

function setCompactHover(expanded) {
  if (!mainWindow || currentMode !== "compact") {
    return;
  }

  if (expanded) {
    clearCompactCollapseTimer();
    clearDoneAttention();
    if (compactHoverExpanded && !isPeeking) {
      return;
    }
    compactHoverExpanded = true;
    compactHoverVisibleSince = Date.now();
    if (isPeeking) {
      exitPeek();
      return;
    }
    const target = isSnapped() ? compactSnappedBounds(true) : targetBoundsForMode("compact");
    animateWindowBounds(target, 170, sendHoverExpandedChanged);
    return;
  }

  scheduleCompactCollapse();
}

function setIslandMode(mode) {
  if (!mainWindow) {
    return { mode: currentMode };
  }

  // Switching mode invalidates any prior peek state; leaving compact takes
  // the window to a different size/position; entering compact may want to
  // re-engage peek after the animation settles.
  isPeeking = false;
  compactHoverExpanded = false;
  clearCompactCollapseTimer();
  clearDoneAttention();
  currentMode = MODE_BOUNDS[mode] ? mode : "compact";
  const target = currentMode === "compact" && isSnapped()
    ? compactSnappedBounds()
    : targetBoundsForMode(currentMode);
  // Liquid morph: bouncy 280 ms transition gives the bubble its
  // water-droplet stretch feel for mode→mode changes (compact ⇄ approval ⇄
  // cards ⇄ settings). Renderer's CSS .island border-radius transition
  // shares the same timing budget so the OS resize and the visual
  // shape change read as one continuous motion.
  animateWindowBounds(target, 280, () => {
    if (currentMode === "compact" && isSnapped()) {
      enterPeek();
    } else {
      scheduleDesktopStateSave();
    }
  }, { liquid: true });
  mainWindow.webContents.send("window:mode-changed", currentMode);
  mainWindow.webContents.send("window:peek-changed", false);
  sendSnapChanged();
  sendHoverExpandedChanged();
  return { mode: currentMode };
}

// Unified popout — bubble glides out from peek to its full snapped capsule,
// holds for a status-dependent window, then tucks back if the cursor is
// elsewhere. Replaces the old triggerDoneAttention which only fired for the
// `done` status; now any status change can flash the bubble briefly.
//   - status === "done"  → DONE_ATTENTION_MS (10 min) + sets attention="done"
//                           so the peek slit keeps pulsing until acked.
//   - any other status   → STATUS_POPOUT_MS (4 s) brief auto-retract.
// New status arriving while a popout is in flight cancels the prior timer
// and restarts the cycle — including new-status-after-done, which clears a
// stuck done attention so a fresh work cycle isn't masked by stale UI.
function popoutForStatus(status) {
  if (!mainWindow || currentMode !== "compact" || !isSnapped()) {
    return { shown: false };
  }

  clearStatusPopoutTimer();
  // A non-done status superseding a held done attention: reset attention so
  // the peek slit's done-glow doesn't bleed into the next cycle.
  if (status !== "done" && attentionState === "done") {
    setAttentionState(null);
  }

  clearCompactCollapseTimer();
  isPeeking = false;
  compactHoverExpanded = true;
  compactHoverVisibleSince = Date.now();
  if (status === "done") {
    setAttentionState("done");
  }
  animateWindowBounds(compactSnappedBounds(true), 190, sendHoverExpandedChanged);
  mainWindow.webContents.send("window:peek-changed", false);

  const tuckDelayMs = status === "done" ? DONE_ATTENTION_MS : STATUS_POPOUT_MS;
  statusPopoutTimer = setTimeout(() => {
    statusPopoutTimer = null;

    if (!mainWindow || currentMode !== "compact") {
      return;
    }

    const { screen } = require("electron");
    const cursor = screen.getCursorScreenPoint();
    if (pointInBounds(cursor, mainWindow.getBounds(), HOVER_HYSTERESIS_PX)) {
      compactHoverVisibleSince = Date.now();
      scheduleCompactCollapse();
      return;
    }

    if (status === "done") {
      // Done timed out without acknowledgement — drop the attention glow so
      // the next status arrival starts from a clean slate.
      setAttentionState(null);
    }
    compactHoverExpanded = false;
    sendHoverExpandedChanged();
    if (isSnapped()) {
      enterPeek();
      return;
    }
    animateWindowBounds(targetBoundsForMode("compact"), 150);
  }, tuckDelayMs);

  return { shown: true };
}

function scheduleSnapAfterMove() {
  // On Windows, "moved" fires continuously during a drag and also during our
  // own animateWindowBounds setBounds calls. Snap only after the user has
  // actually stopped moving, and never during a programmatic animation.
  if (boundsAnimation) {
    return;
  }

  if (isSnapped() && distanceFromSnappedEdge(mainWindow.getBounds()) > SNAP_DETACH_DISTANCE) {
    detachFromEdge();
  }

  // The user is moving the window themselves; drop any peek state without
  // animating, otherwise a programmatic slide would fight the cursor.
  if (isPeeking) {
    isPeeking = false;
    mainWindow.webContents.send("window:peek-changed", false);
  }
  if (snapDebounceTimer) {
    clearTimeout(snapDebounceTimer);
  }
  snapDebounceTimer = setTimeout(() => {
    snapDebounceTimer = null;
    snapWindowToNearbyEdge();
  }, MOVE_DEBOUNCE_MS);
  scheduleDesktopStateSave();
}

function snapWindowToNearbyEdge() {
  if (!mainWindow || boundsAnimation) {
    return;
  }
  if (attentionState === "done") {
    return;
  }
  if (Date.now() < snapSuppressedUntil) {
    return;
  }

  const { screen } = require("electron");
  const bounds = mainWindow.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const workArea = display.workArea;
  const distances = {
    left: Math.abs(bounds.x - workArea.x),
    right: Math.abs(workArea.x + workArea.width - (bounds.x + bounds.width)),
    top: Math.abs(bounds.y - workArea.y),
    bottom: Math.abs(workArea.y + workArea.height - (bounds.y + bounds.height))
  };

  // Single-axis snap: pick whichever edge the user is closest to. Snapping
  // to two edges at once forced the bubble into a corner, which made every
  // off-corner drag look like it "centered" itself because the other axis
  // got pinned to the screen edge instead of staying where the user dropped
  // it. With single-axis snap, drag-to-top preserves the user's X and
  // drag-to-right preserves the user's Y.
  const closest = Object.entries(distances).reduce((best, entry) => {
    return entry[1] < best[1] ? entry : best;
  });
  let horizontal = null;
  let vertical = null;
  if (closest[1] <= SNAP_DISTANCE) {
    if (closest[0] === "left" || closest[0] === "right") {
      horizontal = closest[0];
    } else {
      vertical = closest[0];
    }
  }

  snappedEdges = { horizontal, vertical };
  sendSnapChanged();

  if (!horizontal && !vertical) {
    scheduleDesktopStateSave();
    return;
  }

  // The capsule should sit flush in compact mode, with EDGE_PADDING gap in
  // expanded modes. snapInset() returns the BrowserWindow inset (negative
  // because the gutter overhangs past the work area edge).
  const inset = snapInset(currentMode);
  const target = {
    x: horizontal === "left"
      ? workArea.x + inset
      : horizontal === "right"
        ? workArea.x + workArea.width - bounds.width - inset
        : clamp(bounds.x, workArea.x + inset, workArea.x + workArea.width - bounds.width - inset),
    y: vertical === "top"
      ? workArea.y + inset
      : vertical === "bottom"
        ? workArea.y + workArea.height - bounds.height - inset
        : clamp(bounds.y, workArea.y + inset, workArea.y + workArea.height - bounds.height - inset),
    width: bounds.width,
    height: bounds.height
  };

  animateWindowBounds(target, 120, () => {
    if (currentMode === "compact") {
      enterPeek();
    } else {
      scheduleDesktopStateSave();
    }
  });
}

// ============================================================
// System tray — gives users a way to fully quit the app, since the
// bubble has no close button and the window stays out of the taskbar.
// Right-click for the menu (Show / Settings / toggles / Quit), single-
// click brings the bubble to the front. Without this, users would only
// know to minimise the bubble — the daemon would keep running with no
// visible way to stop it.
// ============================================================

function rebuildTrayMenu() {
  if (!tray) return;
  const enabled = readCompanionEnabled();
  const autoStart = app.getLoginItemSettings().openAtLogin;

  const menu = Menu.buildFromTemplate([
    {
      label: "Show Vibedog-for-agents",
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.moveTop();
      },
    },
    {
      label: "Settings…",
      click: () => {
        if (!mainWindow) return;
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        setIslandMode("settings");
        mainWindow.moveTop();
      },
    },
    { type: "separator" },
    {
      label: "Vibedog-for-agents enabled",
      type: "checkbox",
      checked: enabled,
      click: (item) => {
        setCompanionEnabled(item.checked);
        rebuildTrayMenu();
      },
    },
    {
      label: "Start with Windows",
      type: "checkbox",
      checked: autoStart,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: [] });
        rebuildTrayMenu();
      },
    },
    { type: "separator" },
    {
      label: "Quit Vibedog-for-agents",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  if (tray) return;
  const iconPath = path.join(__dirname, "assets", "tray-icon.png");
  let image;
  try {
    image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      // Fall back to an empty native image — Tray will use the default
      // generic icon, which is still better than crashing.
      image = nativeImage.createEmpty();
    }
  } catch (_err) {
    image = nativeImage.createEmpty();
  }

  tray = new Tray(image);
  tray.setToolTip("Vibedog-for-agents — Claude Code agent watch & review");
  rebuildTrayMenu();

  tray.on("click", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.moveTop();
  });
}

function createWindow() {
  initialDesktopState = readDesktopState();
  currentMode = initialDesktopState ? normalizeMode(initialDesktopState.mode) : "compact";
  snappedEdges = initialDesktopState ? normalizeSnappedEdges(initialDesktopState.snappedEdges) : { horizontal: null, vertical: null };
  isPeeking = Boolean(initialDesktopState && initialDesktopState.isPeeking);
  compactHoverExpanded = false;
  const initial = initialBoundsFromDesktopState(initialDesktopState);

  mainWindow = new BrowserWindow({
    width: initial.width,
    height: initial.height,
    minWidth: 46,
    minHeight: 40,
    maxWidth: MAX_MODE_BOUNDS.width,
    maxHeight: MAX_MODE_BOUNDS.height,
    x: initial.x,
    y: initial.y,
    frame: false,
    show: false,
    transparent: true,
    // Multiple Win11 sources can paint a rectangle around a transparent
    // frameless window:
    //   - thickFrame: WS_THICKFRAME style (defaults true even with frame:false)
    //   - hasShadow: DWM drop-shadow that bounds-traces the rectangle
    //   - roundedCorners: Win11 auto-rounding adds a subtle 1px outline
    //   - backgroundMaterial mica/acrylic: window-level accent border
    // Switching them all off, plus matching the BrowserWindow size to the
    // visible capsule (no transparent gutter), is what gives the pure
    // capsule with zero rectangle.
    thickFrame: false,
    roundedCorners: false,
    backgroundMaterial: "none",
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });

  reinforceWindowPriority();
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("move", scheduleSnapAfterMove);
  mainWindow.on("moved", scheduleSnapAfterMove);
  mainWindow.on("show", reinforceWindowPriority);
  mainWindow.on("restore", reinforceWindowPriority);
  mainWindow.on("focus", reinforceWindowPriority);
  mainWindow.on("blur", reinforceWindowPriority);
  mainWindow.on("close", (event) => {
    // Alt+F4 / system close button — hide to tray instead of quitting,
    // so the daemon (embedded in this process) keeps running. The Quit
    // menu in the tray sets isQuitting=true and that's the only path
    // that actually destroys the window.
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      return;
    }
    if (desktopStateWriteTimer) {
      clearTimeout(desktopStateWriteTimer);
      desktopStateWriteTimer = null;
    }
    writeDesktopStateNow();
  });
  mainWindow.on("closed", () => {
    stopWindowPriorityGuard();
    stopPeekHoverPolling();
    clearCompactCollapseTimer();
    clearStatusPopoutTimer();
    if (desktopStateWriteTimer) {
      clearTimeout(desktopStateWriteTimer);
      desktopStateWriteTimer = null;
    }
    mainWindow = null;
  });
  mainWindow.once("ready-to-show", () => {
    if (currentMode === "compact" && isSnapped()) {
      mainWindow.setBounds(isPeeking ? compactPeekBounds() : compactSnappedBounds());
    } else {
      isPeeking = false;
    }
    mainWindow.webContents.send("window:mode-changed", currentMode);
    mainWindow.webContents.send("window:snap-changed", snappedEdges);
    mainWindow.webContents.send("window:peek-changed", isPeeking);
    lastSentHoverExpanded = currentMode !== "compact" || compactHoverExpanded;
    mainWindow.webContents.send("window:hover-expanded-changed", lastSentHoverExpanded);
    mainWindow.showInactive();
    startWindowPriorityGuard();
    scheduleDesktopStateSave();
    if (isPeeking) {
      startPeekHoverPolling();
    }
    // CCC_DEVTOOLS=true auto-opens DevTools detached. The bubble is
    // frameless so the system menu is hidden — Ctrl+Shift+I from the
    // accelerator map sometimes gets eaten by IMEs (especially Chinese).
    // The opt-in env var is the most reliable handoff for debug sessions.
    if (process.env.CCC_DEVTOOLS === "true") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  });

  // Always wire an explicit accelerator that fires regardless of menu
  // visibility — F12 is the universal "open dev tools" key and isn't
  // touched by IMEs. Also accept Ctrl+Shift+I as a backup.
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const isToggle =
      input.key === "F12" ||
      (input.control && input.shift && (input.key === "I" || input.key === "i"));
    if (!isToggle) return;
    if (mainWindow.webContents.isDevToolsOpened()) {
      mainWindow.webContents.closeDevTools();
    } else {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
    event.preventDefault();
  });
}

app.whenReady().then(() => {
  debugLog(`whenReady fired — isPackaged=${app.isPackaged}`);
  // Packaged builds (.exe / .dmg / etc.) embed the daemon in this same
  // process so the user only ever launches one binary. In dev (`npm run
  // desktop` paired with `npm run daemon`) we skip this branch — the
  // standalone daemon is already binding 4317.
  if (app.isPackaged) {
    if (!process.env.CCC_DATA_DIR) {
      process.env.CCC_DATA_DIR = path.join(app.getPath("userData"), "companion-data");
    }
    try {
      require(path.join(__dirname, "..", "daemon", "src", "index.js"));
      debugLog("daemon required ok");
    } catch (error) {
      debugLog(`daemon require FAILED: ${error.stack || error.message}`);
      console.error("[clawdeck] embedded daemon failed to start:", error);
    }
    // Self-heal: every packaged launch makes sure ~/.claude/settings.json
    // has the correct managed HTTP hooks. With HTTP hooks the URL is the
    // only thing pointing back at us, so this idempotently rewrites our
    // entries even when the user uninstalled+reinstalled, wiped settings
    // by hand, or carried over legacy v1 command-style entries.
    try {
      const {
        USER_SETTINGS_PATH,
        mergeManagedHooks,
        readSettings
      } = require("../../scripts/lib/claude-settings");
      debugLog(`self-heal: claude-settings loaded; reading ${USER_SETTINGS_PATH}`);
      const settings = readSettings(USER_SETTINGS_PATH);
      const before = JSON.stringify(settings, null, 2) + "\n";
      mergeManagedHooks(settings);
      const after = JSON.stringify(settings, null, 2) + "\n";
      if (before !== after) {
        fs.mkdirSync(path.dirname(USER_SETTINGS_PATH), { recursive: true });
        const tmp = `${USER_SETTINGS_PATH}.clawdeck.tmp`;
        fs.writeFileSync(tmp, after, "utf8");
        fs.renameSync(tmp, USER_SETTINGS_PATH);
        debugLog(`self-heal: settings.json updated, ${after.length} bytes`);
        console.log("[clawdeck] self-heal: refreshed Claude Code hook entries");
      } else {
        debugLog("self-heal: no change needed");
      }
    } catch (error) {
      debugLog(`self-heal FAILED: ${error.stack || error.message}`);
      console.error(`[clawdeck] hook self-heal failed: ${error.message}`);
    }
  }

  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // The tray keeps the app alive after the window goes away. Only an
  // explicit Quit from the tray menu (or a system shutdown) should
  // actually exit — closing the bubble just hides it.
  if (!isQuitting && process.platform !== "darwin") {
    return;
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (desktopStateWriteTimer) {
    clearTimeout(desktopStateWriteTimer);
    desktopStateWriteTimer = null;
  }
  writeDesktopStateNow();
  stopWindowPriorityGuard();
});

ipcMain.handle("window:close", () => {
  if (mainWindow) {
    mainWindow.close();
  }
});

ipcMain.handle("window:minimize", () => {
  if (mainWindow) {
    mainWindow.minimize();
  }
});

ipcMain.handle("window:toggle-compact", () => {
  return setIslandMode(currentMode === "compact" ? "approval" : "compact");
});

ipcMain.handle("window:set-mode", (_event, mode) => {
  return setIslandMode(mode);
});

// Gear button — opens settings (Knowledge Cards config + collapsible
// sessions / activity / devices sections). Replaces the legacy dashboard
// mode; click again from inside settings to collapse back to compact.
ipcMain.handle("open:settings", () => {
  const target = currentMode === "settings" ? "compact" : "settings";
  return setIslandMode(target);
});

// 📚 button — opens the cards mode (Today / History / Wrong-book tabs).
ipcMain.handle("open:cards", () => {
  const target = currentMode === "cards" ? "compact" : "cards";
  return setIslandMode(target);
});

// ⤢ button — always EXPANDS to live monitor mode. Never toggles back
// to compact (use the − minimize button for that). The user explicitly
// wants this asymmetry: ⤢ = open, − = close.
ipcMain.handle("open:live", () => {
  if (currentMode === "live") {
    return { mode: currentMode };
  }
  return setIslandMode("live");
});

// Renderer reports the rendered .status-text width (px) after every status
// change. Main updates the compact bubble's target capsule width and animates
// the OS BrowserWindow to fit, so long status labels never get clipped by
// the absolute-positioned controls strip on hover. No-op in expanded modes
// — the resize takes effect the next time the bubble enters compact.
ipcMain.handle("window:set-status-width", (_event, width) => {
  const w = Number.isFinite(width) ? Math.max(0, Math.round(width)) : COMPACT_TEXT_W_MIN;
  if (w === compactTextWidth) return { width: compactTextWidth };
  compactTextWidth = w;
  if (mainWindow && currentMode === "compact" && !isPeeking) {
    const target = isSnapped() ? compactSnappedBounds() : targetBoundsForMode("compact");
    animateWindowBounds(target, 220, scheduleDesktopStateSave);
  }
  return { width: compactTextWidth };
});

ipcMain.handle("window:peek-hover", () => {
  setCompactHover(true);
});

ipcMain.handle("window:peek-unhover", () => {
  setCompactHover(false);
});

// Renderer fires this on every status change (any status worth showing).
// Main routes to popoutForStatus which picks the right hold duration and
// resets a stuck done attention if a new status supersedes it.
ipcMain.handle("window:status-popout", (_event, payload) => {
  const status = String(payload && payload.status || "");
  if (!status) return { shown: false };
  return popoutForStatus(status);
});

// Legacy alias — pre-status-popout renderers still call this; route to the
// unified handler with status="done" so behaviour is unchanged.
ipcMain.handle("window:done-attention", () => {
  return popoutForStatus("done");
});

ipcMain.handle("window:ack-attention", () => {
  clearDoneAttention();
  return { acknowledged: true };
});

ipcMain.handle("window:clear-attention", () => {
  clearDoneAttention();
  return { cleared: true };
});

ipcMain.handle("companion:get-enabled", () => readCompanionEnabled());

ipcMain.handle("companion:set-enabled", (_event, enabled) => setCompanionEnabled(Boolean(enabled)));

// Login-item / auto-start. Electron handles the platform-specific bits
// (registry on Windows, LaunchAgents on macOS, .desktop on Linux) — we
// just expose openAtLogin to the renderer's settings toggle. Args is
// kept empty for now; if we want a `--minimized` boot mode later, add
// it here and parse process.argv at startup.
ipcMain.handle("app:get-auto-start", () => {
  const settings = app.getLoginItemSettings();
  return Boolean(settings.openAtLogin);
});

ipcMain.handle("app:set-auto-start", (_event, enabled) => {
  app.setLoginItemSettings({
    openAtLogin: Boolean(enabled),
    args: [],
  });
  return Boolean(app.getLoginItemSettings().openAtLogin);
});

ipcMain.handle("window:set-hold", (_event, value) => {
  setHoldOpen(value);
  return { holdOpen };
});

// File-system helpers used by Settings → Cards storage. The renderer
// can't legally open native dialogs or shell URLs on its own (sandbox),
// so it goes through main process IPC.
ipcMain.handle("dialog:pick-folder", async (_event, options = {}) => {
  if (!mainWindow) return { canceled: true, folder: null };
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title || "Pick a folder",
    defaultPath: options.defaultPath || undefined,
    properties: ["openDirectory", "createDirectory", "promptToCreate"]
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true, folder: null };
  }
  return { canceled: false, folder: result.filePaths[0] };
});

ipcMain.handle("shell:open-folder", async (_event, folder) => {
  if (!folder || typeof folder !== "string") return { ok: false, error: "no folder" };
  const error = await shell.openPath(folder);
  return { ok: !error, error: error || null };
});
