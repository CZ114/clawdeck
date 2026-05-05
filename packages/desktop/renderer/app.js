const DAEMON_ORIGIN = "http://127.0.0.1:4317";
const WS_URL = "ws://127.0.0.1:4317/ws";

const STATUS_META = {
  idle: { emoji: "\u{1F4A4}", label: "Idle" },
  thinking: { emoji: "\u{1F914}", label: "Thinking" },
  running_tool: { emoji: "\u2699\uFE0F", label: "Running" },
  waiting: { emoji: "\u23F3", label: "Waiting" },
  waiting_approval: { emoji: "\u{1F7E1}", label: "Approval" },
  waiting_answer: { emoji: "\u2753", label: "Question" },
  done: { emoji: "\u2705", label: "Done" },
  failed: { emoji: "\u26A0\uFE0F", label: "Failed" },
  blocked: { emoji: "\u26D4", label: "Blocked" },
  offline: { emoji: "\u{1F50C}", label: "Offline" }
};
// Brief pause between renderStatus updating the DOM and the popout IPC
// firing — gives the orb's CSS a frame to render the new status before
// the bubble glides out of peek showing it.
const DONE_ATTENTION_TRIGGER_DELAY_MS = 260;

const state = {
  socket: null,
  connected: false,
  sessions: [],
  requests: [],
  devices: [],
  events: [],
  selectedAnswers: {},
  mode: "compact",
  theme: "midnight-teal",
  locale: "en",
  lastStatus: null,
  attention: null,
  eventsExpanded: false,
  // Knowledge Cards (Stage 1.5). `today` is the daemon's GET /cards/today
  // payload (or null before first fetch); `generation` mirrors the controls-
  // strip 📚 button state; `review` is the in-progress answering session
  // (null when not reviewing).
  cards: {
    today: null,
    generation: { state: "idle", startedAt: null, finishedAt: null, message: null },
    activeTab: "today",
    review: null,
    lastSummary: null,
    history: null,        // { fetchedAt, items: [...] } | null
    historyDetail: {},    // date -> full payload (lazy fetched on row expand)
    expandedHistory: null,// currently expanded date
    wrongBook: null,      // { fetchedAt, entries: [...] } | null
    expandedRecord: null  // composite key "<date>#<archiveId?>" for Record tab
  },
  // User-controlled settings, persisted to localStorage. Sent to the
  // generator on /cards/generate. Stub generator stamps them onto the
  // payload but doesn't bias content yet — real generator (Slice 3) will.
  settings: {
    focus: "",
    difficulty: "balanced",   // "casual" | "balanced" | "deep"
    autoGenerate: true,
    // 24h "HH:MM" — when current local time crosses this AND today
    // hasn't been auto-generated yet, fire. Default 09:00 = "morning".
    autoGenerateAt: "09:00",
    autoAddWrong: true,       // mirror of daemon-side default
    streakNotif: false,
    // Generation window (in days) used when no targetDate is set. Pinned to
    // the four range pills (1 / 3 / 7 / 30). Persisted across sessions.
    generateWindow: 1,
    // Backfill date — when set, generator writes to this date's deck file
    // instead of today's, and only uses sessions from that day. Cleared
    // back to null after each generate by default.
    generateDate: null,
    // How many cards to ask the model to generate (1..20). Best effort
    // — strict-source validation can still drop some.
    cardCount: 5,
    // Whether the model is allowed to fall back to WebSearch / WebFetch
    // when the user's focus doesn't appear in transcripts. Web cards must
    // cite their URL via source.kind="web" + source.fileRef=<URL>.
    webFallback: true,
    // Total character budget for transcripts fed into the `claude -p`
    // prompt. Larger = more sessions covered + slower run + higher
    // chance of hitting the model context window. Slider range 10k..1M chars.
    transcriptBudget: 60000,
    // When non-null, restrict the scanner to these sessionIds. null = "Auto"
    // mode (scanner uses the time window). Empty array = explicit "no
    // sessions" (rare; mostly used via the picker's "None" button to test
    // empty-deck behavior). Persisted across sessions.
    selectedSessionIds: null,
    // Surfaces 🗑 buttons in the Record tab + session picker for moving
    // Claude session JSONLs into the trash. Default off as a safety belt.
    allowSessionDelete: false
  }
};
let statusPopoutTriggerTimer = null;
let pairingHideTimer = null;
// Set while the system color picker is open. Mirrors the main-process holdOpen
// state so the renderer-side controls-hide timer doesn't fire while the user
// is interacting with a modal that's outside our window.
let pickerHold = false;

// Resolves with true when the user accepts the consent modal, false when they
// decline. Set up by ensureCardsConsent() below; resolved by the modal's
// Accept / Decline buttons.
let pendingConsentResolver = null;

const els = {
  island: document.querySelector(".island"),
  statusOrb: document.getElementById("statusOrb"),
  statusEmoji: document.getElementById("statusEmoji"),
  statusText: document.getElementById("statusText"),
  statusDetail: document.getElementById("statusDetail"),
  contextLabel: document.getElementById("contextLabel"),
  contextFill: document.getElementById("contextFill"),
  requestPanel: document.getElementById("requestPanel"),
  activeRequest: document.getElementById("activeRequest"),
  requestKind: document.getElementById("requestKind"),
  requestTool: document.getElementById("requestTool"),
  requestRisk: document.getElementById("requestRisk"),
  requestSummary: document.getElementById("requestSummary"),
  requestCwd: document.getElementById("requestCwd"),
  requestReason: document.getElementById("requestReason"),
  answerForm: document.getElementById("answerForm"),
  approvalActions: document.getElementById("approvalActions"),
  approveRequest: document.getElementById("approveRequest"),
  suggestionList: document.getElementById("suggestionList"),
  denyRequest: document.getElementById("denyRequest"),
  openThemePicker: document.getElementById("openThemePicker"),
  themeGrid: document.getElementById("themeGrid"),
  openCards: document.getElementById("openCards"),
  openLive: document.getElementById("openLive"),
  livePanel: document.getElementById("livePanel"),
  cardsButtonBadge: document.getElementById("cardsButtonBadge"),
  openSettings: document.getElementById("openSettings"),
  minimizeWindow: document.getElementById("minimizeWindow"),
  toggleEnabled: document.getElementById("toggleEnabled"),

  // Cards mode
  cardsPanel: document.getElementById("cardsPanel"),
  cardsTabButtons: Array.from(document.querySelectorAll(".cards-tab")),
  cardsTabBodies: Array.from(document.querySelectorAll(".cards-tab-body")),
  cardsEmpty: document.getElementById("cardsEmpty"),
  cardsEmptyMeta: document.getElementById("cardsEmptyMeta"),
  cardsGenerateButton: document.getElementById("cardsGenerateButton"),
  cardsRegenerateButton: document.getElementById("cardsRegenerateButton"),
  cardsDeck: document.getElementById("cardsDeck"),
  abstractDate: document.getElementById("abstractDate"),
  abstractMeta: document.getElementById("abstractMeta"),
  abstractBody: document.getElementById("abstractBody"),
  cardsGoalFill: document.getElementById("cardsGoalFill"),
  cardsGoalNum: document.getElementById("cardsGoalNum"),
  cardsDifficultyMix: document.getElementById("cardsDifficultyMix"),
  cardsStartReview: document.getElementById("cardsStartReview"),
  cardsRemainingLabel: document.getElementById("cardsRemainingLabel"),
  wrongTabCount: document.getElementById("wrongTabCount"),
  deckLiveBanner: document.getElementById("deckLiveBanner"),
  deckLiveText: document.getElementById("deckLiveText"),
  recordTabCount: document.getElementById("recordTabCount"),
  recordMeta: document.getElementById("recordMeta"),
  recordList: document.getElementById("recordList"),
  historyMeta: document.getElementById("historyMeta"),
  historyList: document.getElementById("historyList"),
  wrongIntro: document.getElementById("wrongIntro"),
  wrongCtaRow: document.getElementById("wrongCtaRow"),
  wrongFullReviewButton: document.getElementById("wrongFullReviewButton"),
  wrongCtaCount: document.getElementById("wrongCtaCount"),
  wrongList: document.getElementById("wrongList"),

  // Active review
  reviewActive: document.getElementById("reviewActive"),
  reviewBack: document.getElementById("reviewBack"),
  reviewProgressText: document.getElementById("reviewProgressText"),
  reviewDifficultyChip: document.getElementById("reviewDifficultyChip"),
  reviewProgressDots: document.getElementById("reviewProgressDots"),
  reviewQuestion: document.getElementById("reviewQuestion"),
  reviewSource: document.getElementById("reviewSource"),
  reviewSourceRef: document.getElementById("reviewSourceRef"),
  reviewSourceQuote: document.getElementById("reviewSourceQuote"),
  reviewOptions: document.getElementById("reviewOptions"),
  reviewCloze: document.getElementById("reviewCloze"),
  reviewClozeInputRow: document.getElementById("reviewClozeInputRow"),
  reviewClozeInput: document.getElementById("reviewClozeInput"),
  reviewFeedback: document.getElementById("reviewFeedback"),
  feedbackIcon: document.getElementById("feedbackIcon"),
  feedbackVerdict: document.getElementById("feedbackVerdict"),
  feedbackAnswer: document.getElementById("feedbackAnswer"),
  feedbackExplanation: document.getElementById("feedbackExplanation"),
  reviewSkip: document.getElementById("reviewSkip"),
  reviewSubmit: document.getElementById("reviewSubmit"),

  // Completion
  completionScreen: document.getElementById("completionScreen"),
  completionTitle: document.getElementById("completionTitle"),
  completionSub: document.getElementById("completionSub"),
  completionCorrect: document.getElementById("completionCorrect"),
  completionWrong: document.getElementById("completionWrong"),
  completionDone: document.getElementById("completionDone"),

  // Settings panel
  settingsPanel: document.getElementById("settingsPanel"),
  settingsCardsMeta: document.getElementById("settingsCardsMeta"),
  settingsGenerateButton: document.getElementById("settingsGenerateButton"),
  settingsOpenCards: document.getElementById("settingsOpenCards"),
  settingsCompanionState: document.getElementById("settingsCompanionState"),
  settingsFocus: document.getElementById("settingsFocus"),
  settingsDifficulty: document.getElementById("settingsDifficulty"),
  settingsDifficultyMeta: document.getElementById("settingsDifficultyMeta"),
  toggleAutoGenerate: document.getElementById("toggleAutoGenerate"),
  toggleAutoWrongBook: document.getElementById("toggleAutoWrongBook"),
  toggleStreakNotif: document.getElementById("toggleStreakNotif"),
  generateRangePills: document.getElementById("generateRangePills"),
  generateRangePillButtons: Array.from(document.querySelectorAll("#generateRangePills .range-pill")),
  generateDateInput: document.getElementById("generateDateInput"),
  generateDateClear: document.getElementById("generateDateClear"),
  settingsRangeMeta: document.getElementById("settingsRangeMeta"),
  cardCountSlider: document.getElementById("cardCountSlider"),
  cardCountValue: document.getElementById("cardCountValue"),
  transcriptBudgetSlider: document.getElementById("transcriptBudgetSlider"),
  transcriptBudgetValue: document.getElementById("transcriptBudgetValue"),
  settingsBudgetMeta: document.getElementById("settingsBudgetMeta"),
  // Specific sessions picker (heatmap + day detail)
  sessionPickerPanel: document.getElementById("sessionPickerPanel"),
  pickerAutoTopBtn: document.getElementById("pickerAutoTopBtn"),
  pickerAllBtn: document.getElementById("pickerAllBtn"),
  pickerNoneBtn: document.getElementById("pickerNoneBtn"),
  pickerRefreshBtn: document.getElementById("pickerRefreshBtn"),
  pickerCountMeta: document.getElementById("pickerCountMeta"),
  pickerModeTag: document.getElementById("pickerModeTag"),
  pickerSummaryMeta: document.getElementById("pickerSummaryMeta"),
  heatmap: document.getElementById("heatmap"),
  heatmapMonthLabels: document.getElementById("heatmapMonthLabels"),
  dayDetail: document.getElementById("dayDetail"),
  dayDetailTitle: document.getElementById("dayDetailTitle"),
  dayDetailList: document.getElementById("dayDetailList"),
  dayAllToggle: document.getElementById("dayAllToggle"),
  pickerConfirmBtn: document.getElementById("pickerConfirmBtn"),
  toggleAllowSessionDelete: document.getElementById("toggleAllowSessionDelete"),
  toggleAutoStart: document.getElementById("toggleAutoStart"),
  toggleWebFallback: document.getElementById("toggleWebFallback"),
  sessionsExpander: document.getElementById("sessionsExpander"),
  sessionsCountText: document.getElementById("sessionsCountText"),
  sessionsList: document.getElementById("sessionsList"),
  exportTodayButton: document.getElementById("exportTodayButton"),
  exportHistoryButton: document.getElementById("exportHistoryButton"),
  exportWrongBookButton: document.getElementById("exportWrongBookButton"),
  consentModal: document.getElementById("consentModal"),
  consentAccept: document.getElementById("consentAccept"),
  consentDecline: document.getElementById("consentDecline"),
  consentStateMeta: document.getElementById("consentStateMeta"),
  resetConsentButton: document.getElementById("resetConsentButton"),
  storagePathDisplay: document.getElementById("storagePathDisplay"),
  storageOpenButton: document.getElementById("storageOpenButton"),
  storagePickButton: document.getElementById("storagePickButton"),
  storagePendingNote: document.getElementById("storagePendingNote")
};

function latestSession() {
  return [...state.sessions].sort((a, b) => {
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  })[0];
}

function activeRequest() {
  const waiting = state.requests.find((request) => {
    return request.approvalKind === "ask_user_question" || request.risk === "high";
  });
  return waiting || state.requests[0] || null;
}

function requestQuestions(request) {
  if (Array.isArray(request.questions)) {
    return request.questions;
  }
  if (request.toolInput && Array.isArray(request.toolInput.questions)) {
    return request.toolInput.questions;
  }
  return [];
}

function questionKey(question, index) {
  return String((question && question.question) || `Question ${index + 1}`);
}

function optionLabel(option) {
  if (typeof option === "string") {
    return option;
  }
  return String((option && option.label) || "");
}

function isQuestionRequest(request) {
  return request && (request.approvalKind === "ask_user_question" || request.tool === "AskUserQuestion");
}

async function setMode(mode) {
  if (state.mode === mode) {
    return;
  }
  state.mode = mode;
  document.body.dataset.mode = mode;
  if (window.companionDesktop && window.companionDesktop.setMode) {
    await window.companionDesktop.setMode(mode);
  }
}

// ============================================================
// Theme presets — replaces the previous single-colour picker. The
// available themes live in packages/shared/themes.js and are loaded
// before app.js (see index.html), exposing window.CCC_THEMES.
// ============================================================

const THEME_STORAGE_KEY = "claude-code-companion.theme.v1";

function getThemes() {
  return (window.CCC_THEMES && window.CCC_THEMES.THEMES) || [];
}

function applyTheme(themeId, { persist = false } = {}) {
  const themes = getThemes();
  const fallback = (window.CCC_THEMES && window.CCC_THEMES.DEFAULT_THEME_ID) || "midnight-teal";
  const theme = themes.find((t) => t.id === themeId)
    || themes.find((t) => t.id === fallback)
    || themes[0];
  if (!theme) return;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars || {})) {
    root.style.setProperty(`--${key}`, value);
  }
  root.style.colorScheme = theme.colorScheme || "dark";
  document.body.dataset.theme = theme.id;
  // Tooltip on the bubble's color button shows current theme so the user
  // knows what they cycled to.
  if (els.openThemePicker) {
    els.openThemePicker.title = `Theme: ${theme.displayName} · click to cycle`;
    els.openThemePicker.setAttribute("aria-label", `Theme: ${theme.displayName}, click to cycle`);
  }
  state.theme = theme.id;
  if (persist) {
    try { window.localStorage.setItem(THEME_STORAGE_KEY, theme.id); } catch (_e) {}
  }
  renderThemeGrid();
}

// Full preview list inside Settings · Companion. Shown as a 2-column grid
// of cards; each card has the swatch row + name + description and clicking
// applies the theme.
function renderThemeGrid() {
  if (!els.themeGrid) return;
  const themes = getThemes();
  els.themeGrid.replaceChildren();
  for (const theme of themes) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "theme-option";
    if (state.theme === theme.id) opt.classList.add("is-active");

    const swatches = document.createElement("span");
    swatches.className = "theme-option-swatches";
    for (const key of ["surface-1", "accent", "accent-warm", "accent-sage", "accent-rose"]) {
      const dot = document.createElement("span");
      dot.style.background = theme.vars[key];
      swatches.append(dot);
    }

    const text = document.createElement("span");
    text.className = "theme-option-text";
    const name = document.createElement("span");
    name.className = "theme-option-name";
    name.innerHTML = `${escapeHtml(theme.displayName)}${theme.displayNameZh ? ` · ${escapeHtml(theme.displayNameZh)}` : ""} <span class="check">✓</span>`;
    const desc = document.createElement("span");
    desc.className = "theme-option-desc";
    desc.textContent = theme.description || "";
    text.append(name, desc);

    opt.append(swatches, text);
    opt.addEventListener("click", () => applyTheme(theme.id, { persist: true }));
    els.themeGrid.append(opt);
  }
}

// Cycle to the next theme in the list. Used by the bubble's compact
// color button — this works in any mode (compact / expanded) because it
// only requires a single click, no popover positioning math.
function cycleTheme() {
  const themes = getThemes();
  if (themes.length === 0) return;
  const idx = themes.findIndex((t) => t.id === state.theme);
  const next = themes[(idx + 1) % themes.length];
  applyTheme(next.id, { persist: true });
}

// ============================================================
// I18n — locale switcher + DOM walker. window.CCC_I18N is set by
// shared/i18n.js (loaded before app.js).
// ============================================================

const LOCALE_STORAGE_KEY = "claude-code-companion.locale.v1";

function applyLocale(locale, { persist = false } = {}) {
  const i18n = window.CCC_I18N;
  if (!i18n) return;
  i18n.setLocale(locale);
  state.locale = i18n.getLocale();
  document.documentElement.lang = state.locale === "zh" ? "zh-CN" : "en";
  // Walk every DOM element with data-i18n* attributes and re-render text.
  i18n.applyI18nToTree(document.body);
  // Update active state on language toggle buttons.
  for (const btn of document.querySelectorAll("#settingsLanguage .segment")) {
    btn.classList.toggle("is-active", btn.dataset.locale === state.locale);
  }
  // Re-render dynamic surfaces so they pick up the new locale.
  if (typeof applySettingsToInputs === "function") {
    try { applySettingsToInputs(); } catch (_e) {}
  }
  if (typeof renderThemeGrid === "function") {
    try { renderThemeGrid(); } catch (_e) {}
  }
  if (persist) {
    try { window.localStorage.setItem(LOCALE_STORAGE_KEY, state.locale); } catch (_e) {}
  }
}

function initLocale() {
  const i18n = window.CCC_I18N;
  if (!i18n) return;
  let stored = null;
  try { stored = window.localStorage.getItem(LOCALE_STORAGE_KEY); } catch (_e) {}
  const initial = stored
    || i18n.detectInitialLocale(navigator.language || "en");
  applyLocale(initial);
  // Bind segmented toggle.
  const seg = document.getElementById("settingsLanguage");
  if (seg) {
    seg.addEventListener("click", (event) => {
      const btn = event.target.closest(".segment");
      if (!btn || !btn.dataset.locale) return;
      applyLocale(btn.dataset.locale, { persist: true });
    });
  }
}

// ============================================================
// Settings rail-nav (Direction B). Click a rail item → swap which
// .set-panel has data-active="true". Persists last active section so
// the user lands on the same place next open.
// ============================================================
const SETTINGS_RAIL_KEY = "claude-code-companion.settings-section.v1";

function activateSettingsSection(sectionId) {
  const rail = document.getElementById("settingsRail");
  const panels = document.getElementById("settingsPanels");
  if (!rail || !panels) return;
  const validSections = Array.from(rail.querySelectorAll(".rail-item"))
    .map((b) => b.dataset.section);
  if (!validSections.includes(sectionId)) sectionId = validSections[0];
  for (const btn of rail.querySelectorAll(".rail-item")) {
    btn.classList.toggle("is-active", btn.dataset.section === sectionId);
  }
  for (const panel of panels.querySelectorAll(".set-panel")) {
    if (panel.dataset.section === sectionId) {
      panel.dataset.active = "true";
    } else {
      delete panel.dataset.active;
    }
  }
  try { window.localStorage.setItem(SETTINGS_RAIL_KEY, sectionId); } catch (_e) {}
}

const SETTINGS_RAIL_COLLAPSE_KEY = "claude-code-companion.settings-rail-collapsed.v1";

function setRailCollapsed(collapsed) {
  const body = document.querySelector('.settings-body[data-layout="rail"]');
  if (!body) return;
  if (collapsed) body.dataset.railCollapsed = "true";
  else delete body.dataset.railCollapsed;
  try { window.localStorage.setItem(SETTINGS_RAIL_COLLAPSE_KEY, collapsed ? "1" : "0"); } catch (_e) {}
}

function initSettingsRail() {
  const rail = document.getElementById("settingsRail");
  if (!rail) return;
  // Default to the merged Knowledge cards config — Live moved out to its
  // own bubble mode, so settings landing is the most-edited config block.
  let stored = null;
  try { stored = window.localStorage.getItem(SETTINGS_RAIL_KEY); } catch (_e) {}
  // Migrate legacy stored values from prior rail layouts.
  const legacyMap = {
    "quick": "cards-config", "sessions": "cards-config", "live": "cards-config",
    "prompt": "cards-config", "scope": "cards-config", "behavior": "cards-config"
  };
  if (stored && legacyMap[stored]) stored = legacyMap[stored];
  activateSettingsSection(stored || "cards-config");
  rail.addEventListener("click", (event) => {
    const btn = event.target.closest(".rail-item");
    if (!btn || !btn.dataset.section) return;
    activateSettingsSection(btn.dataset.section);
  });
  // Restore prior collapsed state.
  let storedCollapsed = null;
  try { storedCollapsed = window.localStorage.getItem(SETTINGS_RAIL_COLLAPSE_KEY); } catch (_e) {}
  if (storedCollapsed === "1") setRailCollapsed(true);
  const collapseBtn = document.getElementById("railCollapseBtn");
  if (collapseBtn) {
    collapseBtn.addEventListener("click", () => {
      const body = document.querySelector('.settings-body[data-layout="rail"]');
      const isCollapsed = body && body.dataset.railCollapsed === "true";
      setRailCollapsed(!isCollapsed);
    });
  }
  // Sessions floating-window collapse — separate from the rail collapse.
  // Use removeAttribute / setAttribute (not dataset.X = / delete dataset.X)
  // so the underlying HTML attribute is set/cleared atomically.
  const floater = document.getElementById("sessionsFloater");
  const floaterCollapse = document.getElementById("sessionsFloaterCollapse");
  const floaterHead = document.getElementById("sessionsFloaterHead");
  const setFloaterCollapsed = (collapsed) => {
    if (!floater) return;
    if (collapsed) floater.setAttribute("data-collapsed", "true");
    else floater.removeAttribute("data-collapsed");
    const glyph = floaterCollapse && floaterCollapse.querySelector("span");
    if (glyph) glyph.textContent = collapsed ? "+" : "−";
    if (floaterCollapse) floaterCollapse.title = collapsed ? "Expand" : "Collapse";
  };
  const toggleFloater = () => {
    const isCollapsed = floater && floater.getAttribute("data-collapsed") === "true";
    setFloaterCollapsed(!isCollapsed);
  };
  if (floater && floaterCollapse) {
    // Bind on the BUTTON itself; stopPropagation + return so the head's
    // handler can never double-toggle even if event ordering shifts.
    floaterCollapse.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      toggleFloater();
    });
  }
  // Click the header anywhere (not the button) to expand when collapsed.
  // Defensive: ignore clicks that come from inside the collapse button.
  if (floater && floaterHead) {
    floaterHead.addEventListener("click", (event) => {
      if (event.target.closest("#sessionsFloaterCollapse")) return;
      if (floater.getAttribute("data-collapsed") === "true") {
        setFloaterCollapsed(false);
      }
    });
  }
}

function initThemePicker() {
  let stored = null;
  try { stored = window.localStorage.getItem(THEME_STORAGE_KEY); } catch (_e) {}
  applyTheme(stored || ((window.CCC_THEMES && window.CCC_THEMES.DEFAULT_THEME_ID) || "midnight-teal"));

  if (els.openThemePicker) {
    els.openThemePicker.addEventListener("click", (event) => {
      event.stopPropagation();
      cycleTheme();
    });
  }
  // Re-render the grid whenever Settings opens (cheap; small list).
  renderThemeGrid();
}

function contextUsageFrom(subject) {
  const contextUsage = subject && subject.contextUsage;
  if (!contextUsage || typeof contextUsage !== "object") {
    return {
      percent: 0,
      label: "ctx --"
    };
  }

  const percent = Math.max(0, Math.min(100, Number(contextUsage.percent || 0)));
  return {
    percent,
    label: contextUsage.label || `ctx ${Math.round(percent)}%`
  };
}

function colorForContext(percent) {
  if (percent >= 85) {
    return "oklch(70% 0.07 25)"; // dusty rose — alarm
  }
  if (percent >= 65) {
    return "oklch(78% 0.08 70)"; // sand gold — caution
  }
  return "oklch(72% 0.06 195)"; // titanium teal — calm
}

function renderContext(contextUsage) {
  const percent = Math.round(contextUsage.percent || 0);
  const color = colorForContext(percent);
  document.documentElement.style.setProperty("--context-color", color);
  document.documentElement.style.setProperty("--context-angle", `${percent * 3.6}deg`);
  document.documentElement.style.setProperty("--context-percent", `${percent}%`);
  els.contextFill.style.width = `${percent}%`;
  els.contextLabel.textContent = contextUsage.label || `ctx ${percent}%`;
  const model = contextUsage.model ? ` - ${contextUsage.model}` : "";
  const source = contextUsage.windowSource ? ` - ${contextUsage.windowSource}` : "";
  els.statusOrb.title = `${contextUsage.label || `ctx ${percent}%`}${model}${source}`;
}

// Statuses worth flashing the bubble out of peek for. Idle / offline are the
// resting / disconnected states — popping the bubble out for those would
// just be visual noise (you'd see it pop right after every work cycle ends).
const POPOUT_DESTINATION_STATUSES = new Set([
  "thinking",
  "running_tool",
  "waiting",
  "waiting_approval",
  "waiting_answer",
  "done",
  "failed",
  "blocked"
]);

// Fire a popout on every status change. Main process holds the bubble out
// for ~4 s on transient statuses, ~10 min on `done` (or until the next
// status supersedes it). The 260 ms trigger delay lets the orb's CSS update
// land first so the popped-out bubble already shows the new status.
function maybeTriggerStatusPopout(status) {
  const previousStatus = state.lastStatus;
  state.lastStatus = status;

  // Status flapped away from done before the renderer-side trigger delay
  // fired — cancel the pending trigger so we don't pop a stale state.
  if (statusPopoutTriggerTimer && status !== previousStatus) {
    window.clearTimeout(statusPopoutTriggerTimer);
    statusPopoutTriggerTimer = null;
  }

  // Mirror the old "left done → drop attention" cleanup in the renderer
  // state. Main also clears its attentionState on the next popoutForStatus,
  // but keeping the renderer-side flag in sync avoids stale UI badges.
  if (status !== "done" && state.attention === "done") {
    state.attention = null;
    if (window.companionDesktop && window.companionDesktop.clearAttention) {
      window.companionDesktop.clearAttention();
    }
  }

  if (status === previousStatus) return;
  if (!POPOUT_DESTINATION_STATUSES.has(status)) return;
  if (!window.companionDesktop || !window.companionDesktop.statusPopout) return;

  statusPopoutTriggerTimer = window.setTimeout(() => {
    statusPopoutTriggerTimer = null;
    if (els.island.dataset.status === status) {
      window.companionDesktop.statusPopout(status);
    }
  }, DONE_ATTENTION_TRIGGER_DELAY_MS);
}

function renderStatus(status, detail, contextUsage) {
  // Mode-aware orb. In cards / settings modes the user is doing something
  // explicit on Companion itself, so the orb labels that — Claude Code's
  // underlying status (Done / Idle / etc.) is no longer the primary signal.
  // Approval / question modes keep using the request-status because the
  // in-card Approve / Deny row already conveys "decide now".
  let effectiveStatus = status;
  let effectiveLabel = null;
  let effectiveEmoji = null;
  if (state.mode === "settings") {
    effectiveStatus = "settings";
    effectiveEmoji = "⚙️";  // ⚙
    effectiveLabel = _t("settings.title") || "Settings";
  } else if (state.mode === "cards") {
    effectiveStatus = "cards";
    effectiveEmoji = "\u{1F4DA}";  // 📚
    effectiveLabel = _t("bubble.cards") || "Cards";
  }
  const meta = effectiveEmoji
    ? { emoji: effectiveEmoji, label: effectiveLabel }
    : STATUS_META[status] || STATUS_META.idle;
  els.island.dataset.status = effectiveStatus;
  els.statusEmoji.textContent = meta.emoji;
  els.statusText.textContent = meta.label;
  els.statusDetail.textContent = detail || "";
  renderContext(contextUsage);
  maybeTriggerStatusPopout(status);
  reportStatusTextWidth();
}

// Tell main how wide the status text actually rendered so it can resize
// the compact bubble to fit. Measurement happens on the next paint so the
// new textContent has actually laid out. Main no-ops if the value hasn't
// changed, so this is safe to call on every renderStatus tick.
let pendingStatusWidthFrame = 0;
function reportStatusTextWidth() {
  if (!window.companionDesktop || !window.companionDesktop.setStatusWidth) return;
  if (pendingStatusWidthFrame) return;
  pendingStatusWidthFrame = window.requestAnimationFrame(() => {
    pendingStatusWidthFrame = 0;
    if (!els.statusText) return;
    const rect = els.statusText.getBoundingClientRect();
    const w = Math.ceil(rect.width);
    if (w > 0) {
      window.companionDesktop.setStatusWidth(w);
    }
  });
}

function renderSession() {
  const request = activeRequest();
  const session = latestSession();
  const status = request
    ? isQuestionRequest(request)
      ? "waiting_answer"
      : "waiting_approval"
    : state.connected
      ? session && session.status
        ? session.status
        : "idle"
      : "offline";

  const detail = request
    ? request.summary || request.tool || "Waiting for a decision"
    : session && session.summary
      ? session.summary
      : state.connected
        ? "No request"
        : "Daemon offline";

  const contextUsage = contextUsageFrom((request && request.contextUsage) ? request : session);
  renderStatus(status, detail, contextUsage);
}

function renderRequest() {
  const request = activeRequest();
  state.selectedAnswers = {};
  // Cards / settings / live are "overview surfaces" — when a request
  // RESOLVES (or never arrives) while the user is reading them, we don't
  // want to forcibly collapse out from under their reading. But when a NEW
  // request ARRIVES, we always jump to approval mode regardless of where
  // the user is — approvals are time-sensitive and the previous overview
  // is one click away to return.
  const inOverview = state.mode === "cards" || state.mode === "settings" || state.mode === "live";

  if (!request) {
    els.activeRequest.hidden = true;
    if (inOverview) {
      // Overview surfaces (cards/settings) have their own panel that's
      // already visible via CSS; just keep request-panel hidden.
      els.requestPanel.hidden = true;
    } else {
      els.requestPanel.hidden = true;
      setMode("compact");
    }
    return;
  }

  const question = isQuestionRequest(request);
  els.requestPanel.hidden = false;
  els.activeRequest.hidden = false;
  els.requestKind.textContent = question ? "question" : "approval";
  els.requestTool.textContent = request.tool || "Tool request";
  els.requestRisk.textContent = request.risk || "low";
  els.requestRisk.dataset.risk = request.risk || "low";
  els.requestSummary.textContent = request.summary || "";
  els.requestCwd.textContent = request.cwd || "";
  els.requestReason.textContent = request.reason || "";
  els.answerForm.hidden = !question;
  els.approvalActions.hidden = question;
  renderSuggestionList(request);

  if (question) {
    renderAnswerForm(request);
  } else {
    els.answerForm.replaceChildren();
  }

  // Always snap to the request — even from cards / settings, an inbound
  // approval pulls focus. The previous mode is in state.mode briefly so
  // we *could* restore later, but for now the user dismisses + reopens
  // their previous surface manually.
  setMode(question ? "question" : "approval");
}

function describeRule(rule) {
  if (!rule || typeof rule !== "object") {
    return { tool: "", content: "" };
  }
  return {
    tool: rule.toolName || rule.tool ? String(rule.toolName || rule.tool) : "",
    content: rule.ruleContent || rule.scope || rule.path
      ? String(rule.ruleContent || rule.scope || rule.path)
      : ""
  };
}

function suggestionLabel(suggestion) {
  // Single-line button label. Multi-rule suggestions get the first rule plus
  // a "+N" hint so the button stays one line; the full rule list is exposed
  // via the button's title (tooltip) so the user can still inspect it.
  const rules = Array.isArray(suggestion && suggestion.rules) ? suggestion.rules : [];
  if (!rules.length) {
    return "Always allow this";
  }
  const { tool, content } = describeRule(rules[0]);
  const head = [tool, content].filter(Boolean).join(" ") || "this";
  const extra = rules.length > 1 ? ` +${rules.length - 1}` : "";
  return `Always allow ${head}${extra}`;
}

function suggestionTooltip(suggestion) {
  const rules = Array.isArray(suggestion && suggestion.rules) ? suggestion.rules : [];
  if (!rules.length) {
    return "Always allow this request";
  }
  return rules.map((rule, index) => {
    const { tool, content } = describeRule(rule);
    const body = [tool, content].filter(Boolean).join(" ") || "this";
    return rules.length === 1 ? `Always allow ${body}` : `${index + 1}. ${body}`;
  }).join("\n");
}

function renderSuggestionList(request) {
  if (!els.suggestionList) {
    return;
  }
  els.suggestionList.replaceChildren();

  const suggestions = request.approvalKind === "permission_request" && Array.isArray(request.permissionSuggestions)
    ? request.permissionSuggestions
    : [];

  suggestions.forEach((suggestion, index) => {
    if (!suggestion || suggestion.behavior !== "allow") {
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "allow";
    button.textContent = suggestionLabel(suggestion);
    button.title = suggestionTooltip(suggestion);
    button.addEventListener("click", () => {
      const requestId = currentRequestId();
      if (requestId) {
        decide(requestId, "always_allow", "Always allow from desktop companion", { suggestionIndex: index });
      }
    });
    els.suggestionList.append(button);
  });
}

function renderAnswerForm(request) {
  const questions = requestQuestions(request);
  const submit = document.createElement("button");
  submit.className = "approve";
  submit.type = "submit";
  submit.textContent = "Answer";

  const fields = questions.length ? questions : [{ question: "Answer", options: [] }];
  const children = fields.map((question, index) => {
    const block = document.createElement("div");
    block.className = "question";

    const title = document.createElement("div");
    title.className = "question-title";
    title.textContent = questionKey(question, index);
    block.append(title);

    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length) {
      const list = document.createElement("div");
      list.className = "option-list";
      options.forEach((option) => {
        const label = optionLabel(option);
        if (!label) {
          return;
        }
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", () => {
          state.selectedAnswers[questionKey(question, index)] = label;
          Array.from(list.children).forEach((item) => item.classList.remove("selected"));
          button.classList.add("selected");
        });
        list.append(button);
      });
      block.append(list);
    }

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Other answer";
    input.dataset.questionKey = questionKey(question, index);
    block.append(input);
    return block;
  });

  els.answerForm.replaceChildren(...children, submit);
  els.answerForm.onsubmit = (event) => {
    event.preventDefault();
    const answers = {};
    for (const input of els.answerForm.querySelectorAll("input[data-question-key]")) {
      const key = input.dataset.questionKey;
      const value = input.value.trim() || state.selectedAnswers[key];
      if (!value) {
        input.focus();
        return;
      }
      answers[key] = value;
    }
    decide(request.requestId, "answer", "Answered from desktop companion", { answers });
  };
}

/* ============================================================
   Dashboard rendering (pending queue, sessions, devices,
   pairing, audit events, health footer). Only paints when
   the user is in dashboard mode; cheap no-ops otherwise so
   the renderer doesn't churn on every WebSocket event. */

function renderPendingQueue() {
  if (!els.pendingSection || !els.pendingList) {
    return;
  }
  const activeId = currentRequestId();
  const others = state.requests.filter((req) => req.requestId !== activeId);

  if (els.pendingCount) {
    els.pendingCount.textContent = String(state.requests.length);
  }

  if (!others.length) {
    els.pendingSection.hidden = true;
    els.pendingList.replaceChildren();
    return;
  }

  els.pendingSection.hidden = false;
  const rows = others.map((req) => {
    const row = document.createElement("div");
    row.className = "dash-row";

    const head = document.createElement("div");
    head.className = "dash-row-head";

    const title = document.createElement("span");
    title.className = "dash-row-title";
    title.textContent = req.tool || "Tool request";

    const chip = document.createElement("span");
    chip.className = "dash-chip";
    chip.dataset.risk = req.risk || "low";
    chip.textContent = req.risk || "low";
    head.append(title, chip);
    row.append(head);

    if (req.summary) {
      const summary = document.createElement("span");
      summary.className = "dash-row-summary";
      summary.textContent = req.summary;
      row.append(summary);
    }

    const metaParts = [req.cwd, req.createdAt].filter(Boolean);
    if (metaParts.length) {
      const meta = document.createElement("span");
      meta.className = "dash-row-meta";
      meta.textContent = metaParts.join(" · ");
      row.append(meta);
    }

    const actions = document.createElement("div");
    actions.className = "dash-row-actions";

    const allowBtn = document.createElement("button");
    allowBtn.type = "button";
    allowBtn.className = "dash-row-action";
    allowBtn.dataset.variant = "approve";
    allowBtn.textContent = "Approve";
    allowBtn.addEventListener("click", () => {
      decide(req.requestId, "allow", "Approved from desktop companion");
    });

    const denyBtn = document.createElement("button");
    denyBtn.type = "button";
    denyBtn.className = "dash-row-action";
    denyBtn.textContent = "Deny";
    denyBtn.addEventListener("click", () => {
      decide(req.requestId, "deny", "Denied from desktop companion");
    });

    actions.append(allowBtn, denyBtn);
    row.append(actions);
    return row;
  });

  els.pendingList.replaceChildren(...rows);
}

function renderSessionsList() {
  if (!els.sessionsList) {
    return;
  }
  if (els.sessionsCount) {
    els.sessionsCount.textContent = String(state.sessions.length);
  }
  if (!state.sessions.length) {
    const empty = document.createElement("div");
    empty.className = "dash-empty";
    empty.textContent = "No Claude session state yet.";
    els.sessionsList.replaceChildren(empty);
    return;
  }

  const sorted = [...state.sessions].sort((a, b) => {
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });

  const rows = sorted.map((session) => {
    const row = document.createElement("div");
    row.className = "dash-row";

    const head = document.createElement("div");
    head.className = "dash-row-head";
    const title = document.createElement("span");
    title.className = "dash-row-title";
    title.textContent = session.tool || session.hookEventName || "Claude Code";
    const chip = document.createElement("span");
    chip.className = "dash-chip";
    chip.dataset.status = session.status || "idle";
    chip.textContent = session.status || "idle";
    head.append(title, chip);
    row.append(head);

    if (session.summary) {
      const summary = document.createElement("span");
      summary.className = "dash-row-summary";
      summary.textContent = session.summary;
      row.append(summary);
    }

    const sessionShort = session.sessionId ? String(session.sessionId).slice(0, 12) : "";
    const metaParts = [sessionShort, session.cwd, session.updatedAt].filter(Boolean);
    if (metaParts.length) {
      const meta = document.createElement("span");
      meta.className = "dash-row-meta";
      meta.textContent = metaParts.join(" · ");
      row.append(meta);
    }
    return row;
  });

  els.sessionsList.replaceChildren(...rows);
}

function renderDevices() {
  if (!els.devicesList) {
    return;
  }
  const active = state.devices.filter((device) => !device.revokedAt);
  if (!active.length) {
    const empty = document.createElement("div");
    empty.className = "dash-empty";
    empty.textContent = "No paired devices.";
    els.devicesList.replaceChildren(empty);
    return;
  }

  const rows = active.map((device) => {
    const row = document.createElement("div");
    row.className = "dash-row";

    const head = document.createElement("div");
    head.className = "dash-row-head";
    const title = document.createElement("span");
    title.className = "dash-row-title";
    title.textContent = device.deviceName || "Unnamed device";
    head.append(title);
    row.append(head);

    const idShort = device.deviceId ? String(device.deviceId).slice(0, 10) : "";
    const lastSeen = device.lastSeenAt ? `last seen ${device.lastSeenAt}` : `paired ${device.createdAt || ""}`;
    const meta = document.createElement("span");
    meta.className = "dash-row-meta";
    meta.textContent = [idShort, lastSeen].filter(Boolean).join(" · ");
    row.append(meta);

    const actions = document.createElement("div");
    actions.className = "dash-row-actions";
    const revokeBtn = document.createElement("button");
    revokeBtn.type = "button";
    revokeBtn.className = "dash-row-action";
    revokeBtn.textContent = "Revoke";
    revokeBtn.addEventListener("click", () => revokeDevice(device.deviceId));
    actions.append(revokeBtn);
    row.append(actions);
    return row;
  });

  els.devicesList.replaceChildren(...rows);
}

function describeEvent(ev) {
  if (!ev || typeof ev !== "object") {
    return "";
  }
  if (ev.type === "permission_request") {
    const parts = [ev.tool, ev.risk ? `(${ev.risk})` : "", ev.summary].filter(Boolean);
    return parts.join(" ");
  }
  if (ev.type === "permission_decision") {
    const idShort = ev.requestId ? String(ev.requestId).slice(0, 8) : "";
    const parts = [ev.decision, idShort && `[${idShort}]`, ev.reason].filter(Boolean);
    return parts.join(" ");
  }
  if (ev.type === "device_paired" || ev.type === "device_revoked") {
    return ev.deviceName || ev.deviceId || "";
  }
  return "";
}

function renderEvents() {
  if (!els.eventsList) {
    return;
  }
  const recent = state.events.slice(-30).reverse();
  if (!recent.length) {
    const empty = document.createElement("div");
    empty.className = "dash-empty";
    empty.textContent = "No audit events yet.";
    els.eventsList.replaceChildren(empty);
    return;
  }

  const rows = recent.map((ev) => {
    const row = document.createElement("div");
    row.className = "dash-event-row";
    row.dataset.type = ev.type || "";

    const time = document.createElement("time");
    if (ev.createdAt) {
      const date = new Date(ev.createdAt);
      time.textContent = Number.isNaN(date.getTime())
        ? ""
        : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }

    const desc = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = ev.type || "event";
    desc.append(strong);
    const detail = describeEvent(ev);
    if (detail) {
      desc.append(" ", document.createTextNode(detail));
    }

    row.append(time, desc);
    return row;
  });

  els.eventsList.replaceChildren(...rows);
}

function renderHealth() {
  if (!els.dashHealthLabel || !els.dashHealthMeta) {
    return;
  }
  const live = state.connected;
  els.dashHealthLabel.textContent = live ? "live" : "offline";
  const footer = els.dashHealthLabel.closest(".dash-footer");
  if (footer) {
    footer.dataset.state = live ? "live" : "offline";
  }

  const sessionsLabel = `${state.sessions.length} session${state.sessions.length === 1 ? "" : "s"}`;
  const pendingLabel = `${state.requests.length} pending`;
  els.dashHealthMeta.textContent = [pendingLabel, sessionsLabel, "127.0.0.1:4317"].join(" · ");
}

async function fetchDevices() {
  try {
    const data = await fetchJson("/devices");
    state.devices = Array.isArray(data.devices) ? data.devices : [];
  } catch (_error) {
    state.devices = [];
  }
  renderDevices();
}

async function fetchEvents() {
  try {
    const data = await fetchJson("/events");
    state.events = Array.isArray(data.events) ? data.events : [];
  } catch (_error) {
    state.events = [];
  }
  renderEvents();
}

async function revokeDevice(deviceId) {
  if (!deviceId) {
    return;
  }
  try {
    await fetchJson("/devices/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceId })
    });
  } catch (_error) {
    // No retry — user will see the device still listed and can try again.
  }
  fetchDevices();
}

async function generatePairingToken() {
  if (!els.pairingPanel || !els.pairingTokenValue || !els.pairingTokenMeta) {
    return;
  }
  if (pairingHideTimer) {
    clearTimeout(pairingHideTimer);
    pairingHideTimer = null;
  }
  els.pairingPanel.hidden = false;
  els.pairingTokenValue.textContent = "...";
  els.pairingTokenMeta.textContent = "";

  try {
    const data = await fetchJson("/pairing-token");
    els.pairingTokenValue.textContent = data.pairingToken || "";
    if (data.expiresAt) {
      els.pairingTokenMeta.textContent = `expires ${data.expiresAt}`;
      const ttl = new Date(data.expiresAt).getTime() - Date.now();
      if (Number.isFinite(ttl) && ttl > 0) {
        pairingHideTimer = setTimeout(() => {
          pairingHideTimer = null;
          els.pairingPanel.hidden = true;
          els.pairingTokenValue.textContent = "";
          els.pairingTokenMeta.textContent = "";
        }, ttl);
      }
    }
  } catch (error) {
    els.pairingTokenValue.textContent = "";
    els.pairingTokenMeta.textContent = `error: ${error.message}`;
  }
}

function refreshDashboardSnapshot() {
  if (state.mode !== "dashboard") {
    return;
  }
  fetchDevices();
  if (state.eventsExpanded) {
    fetchEvents();
  }
}

function render() {
  renderSession();
  renderRequest();
  renderPendingQueue();
  renderSessionsList();
  renderHealth();
  if (state.eventsExpanded) {
    renderEvents();
  }
}

async function fetchJson(pathname, options = {}) {
  const response = await fetch(`${DAEMON_ORIGIN}${pathname}`, {
    cache: "no-store",
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

async function refresh() {
  try {
    const [sessions, pending] = await Promise.all([
      fetchJson("/sessions"),
      fetchJson("/pending-requests")
    ]);
    state.sessions = sessions.sessions || [];
    state.requests = pending.requests || [];
  } catch (_error) {
    state.connected = false;
  }
  // Audit events change on every approval flow; refresh them too when the
  // user has the events drawer open. Devices are touched only on pair /
  // revoke so we don't refetch them on each tick — see refreshDashboardSnapshot.
  if (state.mode === "dashboard" && state.eventsExpanded) {
    fetchEvents();
  }
  render();
}

function connectSocket() {
  const socket = new WebSocket(WS_URL);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.connected = true;
    if (state.mode === "dashboard") {
      refreshDashboardSnapshot();
    }
    render();
  });

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (_error) {
      return;
    }

    if (message.type === "hello") {
      state.sessions = message.sessions || [];
      state.requests = message.requests || [];
      render();
      return;
    }

    if (message.type === "session_states_snapshot") {
      state.sessions = message.sessions || [];
      render();
      return;
    }

    if (message.type === "pending_requests_snapshot") {
      state.requests = message.requests || [];
      render();
      return;
    }

    if (message.type === "permission_request" || message.type === "permission_decision_result") {
      refresh();
    }
  });

  socket.addEventListener("close", () => {
    state.connected = false;
    render();
    setTimeout(connectSocket, 1200);
  });

  socket.addEventListener("error", () => {
    state.connected = false;
    render();
  });
}

async function decide(requestId, decision, reason, extra = {}) {
  const payload = {
    type: "permission_decision",
    requestId,
    decision,
    reason,
    ...extra
  };

  if (state.connected && state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
    window.setTimeout(refresh, 120);
    return;
  }

  await fetchJson("/permission-decisions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  await refresh();
}

function currentRequestId() {
  const request = activeRequest();
  return request && request.requestId;
}

els.approveRequest.addEventListener("click", () => {
  const requestId = currentRequestId();
  if (requestId) {
    decide(requestId, "allow", "Approved from desktop companion");
  }
});

els.denyRequest.addEventListener("click", () => {
  const requestId = currentRequestId();
  if (!requestId) {
    return;
  }
  decide(requestId, "deny", "Denied from desktop companion");
});

if (els.openCards) {
  els.openCards.addEventListener("click", () => window.companionDesktop.openCards());
}
if (els.openLive) {
  els.openLive.addEventListener("click", () => window.companionDesktop.openLive());
}
if (els.openSettings) {
  els.openSettings.addEventListener("click", () => window.companionDesktop.openSettings());
}
if (els.minimizeWindow) {
  // Reinterpreted: instead of minimising the BrowserWindow to the taskbar,
  // collapse from any expanded mode (cards / settings / approval) back to
  // the compact island. If we're already compact, this is a no-op.
  els.minimizeWindow.addEventListener("click", () => {
    if (state.mode !== "compact") {
      setMode("compact");
    }
  });
}

function applyEnabledState(enabled) {
  if (enabled) {
    delete document.body.dataset.companionDisabled;
    if (els.toggleEnabled) {
      els.toggleEnabled.title = "Disable Vibedog-for-agents approvals (fall back to terminal)";
      els.toggleEnabled.setAttribute("aria-pressed", "false");
    }
  } else {
    document.body.dataset.companionDisabled = "true";
    if (els.toggleEnabled) {
      els.toggleEnabled.title = "Enable Vibedog-for-agents approvals";
      els.toggleEnabled.setAttribute("aria-pressed", "true");
    }
  }
}

if (els.toggleEnabled && window.companionDesktop.getEnabled) {
  window.companionDesktop.getEnabled().then(applyEnabledState);
  els.toggleEnabled.addEventListener("click", async () => {
    const next = document.body.dataset.companionDisabled === "true";
    const result = await window.companionDesktop.setEnabled(next);
    applyEnabledState(result);
  });
}

if (window.companionDesktop.onEnabledChanged) {
  window.companionDesktop.onEnabledChanged(applyEnabledState);
}

window.companionDesktop.onModeChanged((mode) => {
  const previous = state.mode;
  state.mode = mode;
  document.body.dataset.mode = mode;
  // Refresh the orb so settings / cards modes get their mode-specific
  // emoji + label instead of stale Claude Code status.
  renderSession();

  // Entering cards mode for the first time (or after leaving) pulls fresh
  // /cards/today + generation status, and the wrong-book aggregate so the
  // wrong tab badge is accurate without forcing the user to click that tab.
  if (mode === "cards" && previous !== "cards") {
    Promise.all([fetchCardsToday(), fetchCardsWrongBook()])
      .then(() => renderCards());
  }
  if (mode === "settings" && previous !== "settings") {
    fetchCardsToday().then(() => renderSettings());
  }
  // Live mode reuses the same DOM ids (sessionsList, settingsCardsMeta,
  // generate button) that settings used to host. Refresh today's-deck
  // meta + sessions on entry so the floating window paints with live data.
  if (mode === "live" && previous !== "live") {
    fetchCardsToday().then(() => renderSettings());
  }
  // Explicitly toggle .hidden on the live-panel — belt-and-suspenders so
  // the section is unmistakably visible when mode === "live", regardless
  // of any cascade quirks with the [hidden] UA rule.
  if (els.livePanel) {
    els.livePanel.hidden = mode !== "live";
  }
  if (mode !== "cards") {
    // Leaving cards always exits an in-progress review.
    state.cards.review = null;
    if (els.completionScreen) els.completionScreen.hidden = true;
    if (els.reviewActive) els.reviewActive.hidden = true;
  }
  // Mode flips reshape what's visible (active-request vs full feed), so
  // re-render once the new data-mode attribute is set on <body>.
  render();
});

window.companionDesktop.onPeekChanged((peeking) => {
  document.body.dataset.peeking = peeking ? "true" : "false";
});

if (window.companionDesktop.onSnapChanged) {
  window.companionDesktop.onSnapChanged((edges) => {
    if (edges.horizontal) {
      document.body.dataset.snapHorizontal = String(edges.horizontal);
    } else {
      delete document.body.dataset.snapHorizontal;
    }
    if (edges.vertical) {
      document.body.dataset.snapVertical = String(edges.vertical);
    } else {
      delete document.body.dataset.snapVertical;
    }
  });
}

if (window.companionDesktop.onAttentionChanged) {
  window.companionDesktop.onAttentionChanged((attention) => {
    state.attention = attention || null;
    if (attention) {
      document.body.dataset.attention = String(attention);
    } else {
      delete document.body.dataset.attention;
    }
  });
}

if (window.companionDesktop.onHoverExpandedChanged) {
  // The compact bubble is too narrow at rest to host the controls strip
  // alongside the orb + label. Main.js flips this on once the bubble has
  // actually animated to its wider hover size; CSS gates window-actions
  // visibility on this attribute so the strip never overlaps the status.
  window.companionDesktop.onHoverExpandedChanged((expanded) => {
    document.body.dataset.hoverExpanded = expanded ? "true" : "false";
  });
}
document.body.dataset.hoverExpanded = "false";

initLocale();
initThemePicker();
initSettingsRail();

const HOVER_TO_EXPAND_MS = 100;
const LEAVE_TO_COLLAPSE_MS = 320;
// Window controls strip (power / color / gear / expand / minus) is JS-driven
// instead of pure :hover so a brief drift off the painted capsule — into the
// transparent 12 px BrowserWindow gutter, or a 1-frame hover flicker while
// the window animates between compact and hover widths — doesn't snap the
// strip closed mid-reach. Show is instant; hide waits CONTROLS_LEAVE_GRACE_MS.
const CONTROLS_LEAVE_GRACE_MS = 420;
let peekHoverTimer = null;
let peekLeaveTimer = null;
let controlsHideTimer = null;

function acknowledgeAttentionFromPointer() {
  if (state.attention && window.companionDesktop.ackAttention) {
    state.attention = null;
    window.companionDesktop.ackAttention();
  }
}

function showWindowControls() {
  if (controlsHideTimer) {
    clearTimeout(controlsHideTimer);
    controlsHideTimer = null;
  }
  document.body.dataset.controls = "visible";
}

function controlsKeepAliveFocused() {
  const active = document.activeElement;
  return !!(active && active !== document.body && active.closest && active.closest(".window-actions"));
}

function scheduleHideWindowControls() {
  if (controlsHideTimer) {
    return;
  }
  if (controlsKeepAliveFocused()) {
    return;
  }
  if (pickerHold) {
    return;
  }
  controlsHideTimer = setTimeout(() => {
    controlsHideTimer = null;
    if (controlsKeepAliveFocused() || pickerHold) {
      return;
    }
    delete document.body.dataset.controls;
  }, CONTROLS_LEAVE_GRACE_MS);
}

document.body.addEventListener("pointerenter", () => {
  acknowledgeAttentionFromPointer();
  showWindowControls();

  // Compact mode uses hover to expand the tiny island or reveal the edge peek.
  // Approval and question modes stay fully visible so the request is actionable.
  if (state.mode !== "compact") {
    return;
  }
  if (peekLeaveTimer) {
    clearTimeout(peekLeaveTimer);
    peekLeaveTimer = null;
  }
  if (peekHoverTimer) {
    return;
  }
  peekHoverTimer = setTimeout(() => {
    peekHoverTimer = null;
    window.companionDesktop.peekHover();
  }, HOVER_TO_EXPAND_MS);
});

document.body.addEventListener("pointermove", () => {
  acknowledgeAttentionFromPointer();
  // Cheap re-assertion: any cursor motion inside the BrowserWindow keeps the
  // controls strip alive and cancels a pending hide.
  showWindowControls();

  // When the bubble peeks past a screen edge, the window slides out from
  // under the cursor without dispatching pointerleave/enter — so a later
  // hover never re-fires pointerenter and the slit feels dead. pointermove
  // always fires on cursor movement, so it's the reliable hover signal here.
  if (state.mode !== "compact") {
    return;
  }
  if (document.body.dataset.peeking !== "true") {
    return;
  }
  if (peekLeaveTimer) {
    clearTimeout(peekLeaveTimer);
    peekLeaveTimer = null;
  }
  if (peekHoverTimer) {
    return;
  }
  peekHoverTimer = setTimeout(() => {
    peekHoverTimer = null;
    window.companionDesktop.peekHover();
  }, HOVER_TO_EXPAND_MS);
});

document.body.addEventListener("pointerleave", () => {
  scheduleHideWindowControls();

  if (state.mode !== "compact") {
    return;
  }
  if (peekHoverTimer) {
    clearTimeout(peekHoverTimer);
    peekHoverTimer = null;
  }
  if (peekLeaveTimer) {
    return;
  }
  if (pickerHold) {
    // The cursor leaving the bubble while the color picker is open is
    // expected; main.js has already pinned the bubble open via setHold.
    return;
  }
  peekLeaveTimer = setTimeout(() => {
    peekLeaveTimer = null;
    window.companionDesktop.peekUnhover();
  }, LEAVE_TO_COLLAPSE_MS);
});

// If a control had focus and then loses it (e.g., color picker dialog closes),
// run the leave check so the strip can fade out cleanly.
document.addEventListener("focusout", () => {
  if (document.body.dataset.controls === "visible" && !document.body.matches(":hover")) {
    scheduleHideWindowControls();
  }
});

// ============================================================
// Knowledge Cards (Stage 1.5) renderer
// ============================================================

// Tiny markdown renderer — covers what we actually emit in abstracts:
// h1/h2/h3, paragraphs, bullet/ordered lists, inline code, fenced code,
// strong, em, blockquote, hr, links. No raw-html escape hatch; the daemon
// is the only writer and we control its output.
function renderMarkdown(source) {
  const text = String(source || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = text.split("\n");
  let out = "";
  let i = 0;
  let listType = null;       // 'ul' | 'ol' | null
  let inCode = false;
  let codeBuffer = [];
  let paragraph = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    out += `<p>${renderInline(paragraph.join(" "))}</p>`;
    paragraph = [];
  }
  function closeList() {
    if (listType) {
      out += `</${listType}>`;
      listType = null;
    }
  }
  function openList(type) {
    if (listType === type) return;
    closeList();
    out += `<${type}>`;
    listType = type;
  }

  while (i < lines.length) {
    const line = lines[i];

    if (inCode) {
      if (/^```\s*$/.test(line)) {
        out += `<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`;
        codeBuffer = [];
        inCode = false;
      } else {
        codeBuffer.push(line);
      }
      i += 1;
      continue;
    }

    if (/^```/.test(line)) {
      flushParagraph();
      closeList();
      inCode = true;
      i += 1;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      closeList();
      i += 1;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      out += `<h${level}>${renderInline(heading[2])}</h${level}>`;
      i += 1;
      continue;
    }

    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      flushParagraph();
      closeList();
      out += "<hr>";
      i += 1;
      continue;
    }

    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      flushParagraph();
      closeList();
      out += `<blockquote>${renderInline(bq[1])}</blockquote>`;
      i += 1;
      continue;
    }

    const ul = line.match(/^[-*]\s+(.+)$/);
    if (ul) {
      flushParagraph();
      openList("ul");
      out += `<li>${renderInline(ul[1])}</li>`;
      i += 1;
      continue;
    }

    const ol = line.match(/^\d+\.\s+(.+)$/);
    if (ol) {
      flushParagraph();
      openList("ol");
      out += `<li>${renderInline(ol[1])}</li>`;
      i += 1;
      continue;
    }

    paragraph.push(line);
    i += 1;
  }

  flushParagraph();
  closeList();
  if (inCode) {
    // Unterminated code fence — emit what we got.
    out += `<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`;
  }

  return out;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(source) {
  // Order matters: code first so its contents aren't touched by other rules.
  let text = escapeHtml(String(source || ""));
  text = text.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    return `<a href="${escapeHtml(href)}">${label}</a>`;
  });
  return text;
}

// ============================================================
// Cards data — fetch + render
// ============================================================

// ============================================================
// Cards consent (Slice 5)
// ============================================================

async function fetchCardsConsent() {
  try {
    const data = await fetchJson("/cards/consent");
    return {
      given: Boolean(data && data.given),
      givenAt: (data && data.givenAt) || null,
      version: (data && data.consentVersion) || null
    };
  } catch (_error) {
    return { given: false, givenAt: null, version: null };
  }
}

async function postCardsConsent(given) {
  try {
    return await fetchJson("/cards/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ given: Boolean(given) })
    });
  } catch (error) {
    console.error("[cards] consent write failed:", error);
    return null;
  }
}

// Returns true when the user is OK with the data flow (existing or just-
// accepted), false when they decline. Shows the modal exactly once per
// not-yet-given state; future calls fast-path-return true.
async function ensureCardsConsent() {
  const current = await fetchCardsConsent();
  if (current.given) return true;
  return showConsentModal();
}

function showConsentModal() {
  if (!els.consentModal) return Promise.resolve(true);  // missing UI = don't block
  if (pendingConsentResolver) {
    // Modal is already up — caller-stacking shouldn't open a second one.
    // Reuse the same promise so multiple Generate clicks just await once.
    return new Promise((resolve) => {
      const previous = pendingConsentResolver;
      pendingConsentResolver = (value) => {
        previous(value);
        resolve(value);
      };
    });
  }
  els.consentModal.hidden = false;
  return new Promise((resolve) => {
    pendingConsentResolver = resolve;
  });
}

function resolveConsentModal(value) {
  if (els.consentModal) els.consentModal.hidden = true;
  const resolver = pendingConsentResolver;
  pendingConsentResolver = null;
  if (resolver) resolver(Boolean(value));
}

if (els.consentAccept) {
  els.consentAccept.addEventListener("click", async () => {
    els.consentAccept.disabled = true;
    await postCardsConsent(true);
    els.consentAccept.disabled = false;
    resolveConsentModal(true);
    renderConsentMeta();  // refresh Settings row
  });
}
if (els.consentDecline) {
  els.consentDecline.addEventListener("click", () => {
    resolveConsentModal(false);
  });
}

if (els.resetConsentButton) {
  els.resetConsentButton.addEventListener("click", async () => {
    await postCardsConsent(false);
    renderConsentMeta();
  });
}


async function renderConsentMeta() {
  if (!els.consentStateMeta) return;
  const c = await fetchCardsConsent();
  els.consentStateMeta.textContent = c.given
    ? _t("settings.companion.consentAccepted", { time: formatTimeShort(c.givenAt) })
    : _t("settings.companion.consentPending");
}

// ============================================================
// Cards storage location (Slice 7)
// ============================================================

let storageState = null;  // { cardsDir, defaultCardsDir, isDefault, configuredAt, note }

async function fetchStorageState() {
  try {
    storageState = await fetchJson("/cards/storage");
  } catch (_error) {
    storageState = null;
  }
  return storageState;
}

async function renderStorageRow() {
  if (!els.storagePathDisplay) return;
  const s = await fetchStorageState();
  if (!s) {
    els.storagePathDisplay.textContent = "—";
    if (els.storagePendingNote) els.storagePendingNote.hidden = true;
    return;
  }
  const label = s.isDefault
    ? `${s.cardsDir} (default)`
    : `${s.cardsDir} (custom · set ${formatTimeShort(s.configuredAt)})`;
  els.storagePathDisplay.textContent = label;
  els.storagePathDisplay.title = s.cardsDir;
  if (els.storagePendingNote) {
    els.storagePendingNote.hidden = !s.note;
  }
}

if (els.storageOpenButton) {
  els.storageOpenButton.addEventListener("click", async () => {
    const s = storageState || (await fetchStorageState());
    if (!s) return;
    if (window.companionDesktop && window.companionDesktop.openFolder) {
      await window.companionDesktop.openFolder(s.cardsDir);
    }
  });
}

if (els.storagePickButton) {
  els.storagePickButton.addEventListener("click", async () => {
    if (!window.companionDesktop || !window.companionDesktop.pickFolder) return;
    const s = storageState || (await fetchStorageState());
    const result = await window.companionDesktop.pickFolder({
      title: "Choose Knowledge Cards storage folder",
      defaultPath: s ? s.cardsDir : undefined
    });
    if (result.canceled || !result.folder) return;
    try {
      await fetchJson("/cards/storage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cardsDir: result.folder })
      });
    } catch (error) {
      console.error("[storage] update failed:", error);
      return;
    }
    await renderStorageRow();
  });
}

async function fetchCardsToday() {
  try {
    const data = await fetchJson("/cards/today");
    state.cards.today = data.payload || null;
    state.cards.generation = data.generation || state.cards.generation;
    state.cards.lastSummary = state.cards.today;
    updateCardsButton();
  } catch (_error) {
    state.cards.today = null;
  }
  // Streak depends on cards/<date>.json on disk — refresh whenever today
  // changes (after generate, after answers, on initial open).
  fetchStreak();
}

// Scheduled auto-generate. Fires at the user-picked HH:MM each day —
// alarm-clock semantics: if the app is running at the time, it fires;
// if the app started later but the time has already passed AND today
// hasn't been auto-generated, fire immediately (catch-up). At most
// once per local date, tracked via localStorage so it survives reloads.
const AUTO_GEN_LAST_DATE_KEY = "ccc.autoGen.lastDate";

function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function todayLocalDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function maybeAutoGenerate() {
  if (!state.settings.autoGenerate) return;
  const target = state.settings.autoGenerateAt || "09:00";
  if (!/^\d{2}:\d{2}$/.test(target)) return;
  // Only catch up after the configured time. Before it, just wait —
  // the tick loop below re-calls this function every minute.
  if (nowHHMM() < target) return;

  const today = todayLocalDateString();
  let lastDate = null;
  try { lastDate = window.localStorage.getItem(AUTO_GEN_LAST_DATE_KEY); } catch (_e) {}
  if (lastDate === today) return;

  // Snapshot today's deck. If it already has cards from a manual run,
  // stamp + bail (don't blow away the user's current deck).
  await fetchCardsToday();
  const deck = state.cards.today;
  const hasCards = deck && Array.isArray(deck.cards) && deck.cards.length > 0;
  const inFlight = state.cards.generation && state.cards.generation.state === "generating";
  try { window.localStorage.setItem(AUTO_GEN_LAST_DATE_KEY, today); } catch (_e) {}
  if (hasCards || inFlight) return;

  // Fire the same generate flow the manual button uses. Consent modal
  // gates first-ever run; if user declines, the date stamp above means
  // we won't pester them again today.
  triggerCardsGenerate();
}

// Tick once a minute (well, once every 30 s for crisper fire times).
// Cheap — just a couple of comparisons + a localStorage read most ticks.
let autoGenTickTimer = null;
function startAutoGenTickLoop() {
  if (autoGenTickTimer) return;
  autoGenTickTimer = setInterval(() => {
    maybeAutoGenerate().catch(() => {});
  }, 30_000);
}

async function fetchStreak() {
  try {
    state.cards.streak = await fetchJson("/cards/streak");
  } catch (_error) {
    state.cards.streak = null;
  }
  renderStreakBadge();
}

// Paint every badge slot (deck header + empty-state + Settings preview).
// Visibility is derived from the badge state, not the page state, so the
// same call works for all regions.
function renderStreakBadge() {
  const s = state.cards.streak;
  for (const id of ["streakBadge", "streakBadgeEmpty"]) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.classList.remove("is-protected", "is-zero");
    if (!s) {
      el.setAttribute("hidden", "");
      continue;
    }
    if (s.todayProtected) {
      el.textContent = `🛡 protected · ${s.count} day${s.count === 1 ? "" : "s"}`;
      el.title = "Today's deck is empty (no new sessions). Streak preserved by the 1-day shield. A second consecutive empty day will reset it.";
      el.classList.add("is-protected");
      el.removeAttribute("hidden");
    } else if (s.count > 0) {
      el.textContent = `🔥 ${s.count} day${s.count === 1 ? "" : "s"}`;
      const tail = s.todayState === "completed"
        ? "Today's deck is fully reviewed."
        : "Review today's cards to keep the streak going.";
      el.title = `Streak: ${s.count} consecutive completed day${s.count === 1 ? "" : "s"}. ${tail}`;
      el.removeAttribute("hidden");
    } else {
      // Hide entirely when streak is zero AND today isn't started — less noise.
      if (s.todayState === "missing" || s.todayState === "in-progress") {
        el.setAttribute("hidden", "");
      } else {
        el.textContent = "🔥 0 days";
        el.title = "No active streak. Review today's deck to start one.";
        el.classList.add("is-zero");
        el.removeAttribute("hidden");
      }
    }
  }
}

async function fetchCardsGenerationStatus() {
  try {
    const status = await fetchJson("/cards/generation-status");
    state.cards.generation = status || state.cards.generation;
    updateCardsButton();
  } catch (_error) {
    /* Network blip — leave existing state alone. */
  }
}

function unansweredCardCount(payload) {
  if (!payload || !Array.isArray(payload.cards)) return 0;
  return payload.cards.filter((c) => {
    const last = Array.isArray(c.attempts) && c.attempts.length
      ? c.attempts[c.attempts.length - 1]
      : null;
    // A card is "done" for today once it has at least one correct attempt.
    return !last || !last.correct;
  }).length;
}

function difficultyMix(payload) {
  const mix = { easy: 0, medium: 0, hard: 0 };
  if (!payload || !Array.isArray(payload.cards)) return mix;
  for (const c of payload.cards) {
    if (mix[c.difficulty] !== undefined) mix[c.difficulty] += 1;
  }
  return mix;
}

function updateCardsButton() {
  if (!els.openCards || !els.cardsButtonBadge) return;
  const remaining = unansweredCardCount(state.cards.today);
  const generating = state.cards.generation && state.cards.generation.state === "generating";
  els.openCards.classList.toggle("has-cards", remaining > 0 && !generating);
  els.openCards.classList.toggle("generating", generating);
  if (remaining > 0 && !generating) {
    els.cardsButtonBadge.textContent = String(remaining);
    els.cardsButtonBadge.hidden = false;
  } else {
    els.cardsButtonBadge.hidden = true;
  }
}

function renderCards() {
  if (!els.cardsPanel) return;

  // Tab body visibility — only active tab body renders.
  for (const body of els.cardsTabBodies) {
    body.hidden = body.dataset.tabBody !== state.cards.activeTab;
  }
  for (const tab of els.cardsTabButtons) {
    tab.classList.toggle("is-active", tab.dataset.tab === state.cards.activeTab);
  }

  // Wrong-book tab badge count is independent of which tab is active.
  updateWrongTabBadge();

  // Render whichever tab is showing.
  if (state.cards.activeTab === "history") renderHistoryTab();
  else if (state.cards.activeTab === "wrong") renderWrongBookTab();
  else if (state.cards.activeTab === "record") renderRecordTab();

  // Don't repaint review/completion when reviewing — those overlays manage
  // their own visibility.
  if (state.cards.review) return;
  if (els.reviewActive) els.reviewActive.hidden = true;
  // Don't auto-hide completionScreen here — it's controlled by the explicit
  // "Back to today" click and by mode-leave (see onModeChanged). Hiding it
  // here would race with endReviewSession() which has just opened it.

  if (state.cards.activeTab !== "today") return;

  const payload = state.cards.today;
  const hasDeck = payload && payload.state !== "empty" && Array.isArray(payload.cards) && payload.cards.length > 0;

  if (!hasDeck) {
    if (els.cardsEmpty) els.cardsEmpty.hidden = false;
    if (els.cardsDeck)  els.cardsDeck.hidden  = true;
    const gen = state.cards.generation;
    if (els.cardsEmptyMeta) {
      els.cardsEmptyMeta.classList.remove("error");
      if (gen && gen.state === "generating") {
        const elapsed = gen.startedAt
          ? Math.max(0, Math.round((Date.now() - Date.parse(gen.startedAt)) / 1000))
          : 0;
        const note = state.settings.webFallback
          ? "web tools enabled — can take 2-5 min"
          : "model only, no web — usually 30-90s";
        // Daemon's live message (e.g. "Reading session 3/7 · myproj/foo")
        // wins when present; otherwise show the static window-scope note.
        const live = gen.message && gen.message.length > 0
          ? gen.message
          : note;
        els.cardsEmptyMeta.textContent = `Generating · ${elapsed}s elapsed · ${live}`;
      } else if (gen && gen.state === "error") {
        els.cardsEmptyMeta.classList.add("error");
        els.cardsEmptyMeta.textContent = `Generation failed: ${gen.message || "unknown error"} · check daemon is running on 127.0.0.1:4317`;
      } else if (gen && gen.finishedAt) {
        els.cardsEmptyMeta.textContent = `last gen ${formatTimeShort(gen.finishedAt)} · ${gen.message || ""}`;
      } else {
        els.cardsEmptyMeta.textContent = "";
      }
    }
    if (els.cardsGenerateButton) {
      els.cardsGenerateButton.disabled = gen && gen.state === "generating";
      if (gen && gen.state === "generating") {
        els.cardsGenerateButton.textContent = "Generating …";
      } else if (gen && gen.state === "error") {
        els.cardsGenerateButton.textContent = "↻ Retry";
      } else {
        els.cardsGenerateButton.textContent = "Generate now";
      }
    }
    return;
  }

  if (els.cardsEmpty) els.cardsEmpty.hidden = true;
  if (els.cardsDeck)  els.cardsDeck.hidden  = false;

  if (els.abstractDate) {
    // The deck's own date stays primary (it's the file key — cards/<date>.json).
    // When the source content actually came from a different span (heatmap
    // pick of older sessions), append a "based on" tag so the user isn't
    // confused by an abstract that talks about content from days/weeks ago.
    let dateLine = `${payload.date} ${weekdayShort(payload.date)}`;
    const range = payload.sourceDateRange;
    if (range && range.from && (range.from !== payload.date || range.to !== payload.date)) {
      const isZh = state.locale === "zh";
      const span = range.from === range.to
        ? range.from
        : `${range.from} → ${range.to} · ${range.days}${isZh ? " 天" : "d"}`;
      dateLine += isZh ? `  ·  内容自 ${span}` : `  ·  from ${span}`;
    }
    els.abstractDate.textContent = dateLine;
  }
  if (els.abstractMeta) {
    const stats = payload.stats || {};
    const parts = [];
    if (stats.sessions) parts.push(`${stats.sessions} sessions`);
    if (stats.durationMin) parts.push(`${stats.durationMin} min`);
    if (payload.replay) parts.push("replay");
    els.abstractMeta.textContent = parts.join(" · ");
  }
  if (els.abstractBody) {
    els.abstractBody.innerHTML = renderMarkdown(payload.abstract || "");
  }

  const total = payload.cards.length;
  const remaining = unansweredCardCount(payload);
  const done = total - remaining;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  if (els.cardsGoalFill) els.cardsGoalFill.style.width = `${pct}%`;
  if (els.cardsGoalNum) {
    els.cardsGoalNum.innerHTML = `<strong>${done}</strong> / ${total} cards`;
  }
  if (els.cardsDifficultyMix) {
    const mix = difficultyMix(payload);
    els.cardsDifficultyMix.innerHTML = `
      <span><span class="num easy-n">${mix.easy}</span> easy</span>
      <span>·</span>
      <span><span class="num medium-n">${mix.medium}</span> mid</span>
      <span>·</span>
      <span><span class="num hard-n">${mix.hard}</span> hard</span>`.trim();
  }
  if (els.cardsRemainingLabel) {
    els.cardsRemainingLabel.textContent = remaining > 0 ? `${remaining} left →` : "all done";
  }
  if (els.cardsStartReview) {
    els.cardsStartReview.disabled = remaining === 0;
  }

  // Live banner above the deck — only shown while a regen is actually
  // running. Post-gen historical detail moved to the Record tab.
  renderDeckLiveBanner();
}

function renderDeckLiveBanner() {
  if (!els.deckLiveBanner || !els.deckLiveText) return;
  const liveGen = state.cards.generation;
  const active = liveGen && liveGen.state === "generating";
  if (!active) {
    els.deckLiveBanner.hidden = true;
    return;
  }
  const elapsed = liveGen.startedAt
    ? Math.max(0, Math.round((Date.now() - Date.parse(liveGen.startedAt)) / 1000))
    : 0;
  const stage = liveGen.stage || "running";
  const msg = liveGen.message || "";
  els.deckLiveText.textContent = `LIVE · ${stage} · ${elapsed}s · ${msg}`;
  els.deckLiveBanner.hidden = false;
}

// ============================================================
// Record tab — log of every generation run across current decks +
// archived prior generations. Shares the /cards/history fetch (each
// summary now carries generationRecord) so we don't need a separate
// endpoint.
// ============================================================

function renderRecordTab() {
  if (!els.recordList) return;
  const history = state.cards.history;

  if (!history) {
    els.recordList.replaceChildren(emptyRow("Loading …"));
    if (els.recordMeta) els.recordMeta.textContent = "loading";
    fetchCardsHistory().then(renderRecordTab);
    return;
  }

  // A history summary becomes a "run" row when it carries a
  // generationRecord — older decks generated before Slice 7 don't have
  // one and are skipped here (they still appear in the History tab).
  const runs = (history.items || []).filter((item) => item && item.generationRecord);
  if (els.recordTabCount) {
    if (runs.length > 0) {
      els.recordTabCount.textContent = String(runs.length);
      els.recordTabCount.hidden = false;
    } else {
      els.recordTabCount.hidden = true;
    }
  }
  if (els.recordMeta) {
    els.recordMeta.textContent = runs.length > 0
      ? `${runs.length} run${runs.length === 1 ? "" : "s"} · newest first`
      : "—";
  }

  if (runs.length === 0) {
    els.recordList.replaceChildren(emptyRow("No generation runs yet — Generate now to start the log."));
    return;
  }

  const rows = runs.map(buildRecordRow);
  els.recordList.replaceChildren(...rows);
}

function buildRecordRow(item) {
  const archiveId = item.isArchive && item.archivedAt
    ? item.archivedAt.replace(/:/g, "")
    : null;
  const rowKey = historyDetailKey(item.date, archiveId);
  const rec = item.generationRecord || {};

  const row = document.createElement("div");
  row.className = "record-row";
  if (item.isArchive) row.classList.add("is-archive");
  row.dataset.date = item.date;
  if (archiveId) row.dataset.archiveId = archiveId;

  const head = document.createElement("button");
  head.type = "button";
  head.className = "record-row-head";

  const date = document.createElement("span");
  date.className = "record-date";
  // archives → MM-DD HH:MM; current decks → MM-DD Weekday HH:MM (if we
  // have updatedAt)
  if (item.isArchive) {
    date.textContent = `${item.date.slice(5)} ${item.archivedAt.slice(0, 5)}`;
  } else {
    const time = item.updatedAt ? formatTimeShort(item.updatedAt) : "";
    date.textContent = `${item.date.slice(5)} ${weekdayShort(item.date)}${time ? ` ${time}` : ""}`;
  }

  const summary = document.createElement("span");
  summary.className = "record-summary";
  const scanned = Array.isArray(rec.scannedSessions) ? rec.scannedSessions : [];
  const includedCount = scanned.filter((s) => s.status === "included").length;
  const sec = Math.round((Number(rec.durationMs) || 0) / 1000);
  const focusBit = rec.focus || (rec.focusSnapshot || "");
  const focusShort = focusBit && focusBit.length > 30
    ? focusBit.slice(0, 30) + "…"
    : focusBit;
  const summaryParts = [
    `${includedCount}/${scanned.length} sessions`,
    sec > 0 ? `${sec}s` : null,
    rec.webFallback ? "web" : null,
    rec.stub ? "stub" : null,
    focusShort ? `focus: ${focusShort}` : null
  ].filter(Boolean);
  summary.textContent = summaryParts.join(" · ");

  const stat = document.createElement("div");
  stat.className = "record-stat";
  const accepted = rec.cardsAccepted ?? item.cards ?? 0;
  const dropped = rec.cardsDropped ?? 0;
  stat.innerHTML = `
    <span><span class="accept">${accepted}</span> ✓${dropped > 0 ? ` <span class="drop">${dropped} ✕</span>` : ""}</span>
    <span>${Math.round((rec.totalCharsInPrompt || 0) / 1000)}k chars</span>
  `;

  head.append(date, summary, stat);
  row.append(head);

  const detail = document.createElement("div");
  detail.className = "record-detail";
  detail.hidden = state.cards.expandedRecord !== rowKey;
  row.append(detail);
  if (state.cards.expandedRecord === rowKey) {
    paintRecordDetail(detail, rec);
  }

  head.addEventListener("click", () => {
    const same = state.cards.expandedRecord === rowKey;
    state.cards.expandedRecord = same ? null : rowKey;
    renderRecordTab();
  });

  return row;
}

function paintRecordDetail(container, record) {
  container.replaceChildren();

  // Stats grid
  const stats = document.createElement("div");
  stats.className = "gen-record-stats";
  const kv = (key, val) => {
    const span = document.createElement("span");
    span.className = "stat-pair";
    span.innerHTML = `<span class="key">${escapeHtml(key)}:</span><span>${escapeHtml(val)}</span>`;
    return span;
  };
  if (record.windowDays) stats.append(kv("window", `${record.windowDays}d`));
  if (record.cardCount) stats.append(kv("target", `${record.cardCount} cards`));
  if (record.difficulty) stats.append(kv("difficulty", record.difficulty));
  if (typeof record.webFallback === "boolean") stats.append(kv("web", record.webFallback ? "allowed" : "off"));
  if (record.transcriptBudget) stats.append(kv("budget", `${Math.round(record.transcriptBudget / 1000)}k`));
  if (record.cardsAccepted !== undefined) stats.append(kv("accepted", `${record.cardsAccepted}`));
  if (record.cardsDropped !== undefined) stats.append(kv("dropped", `${record.cardsDropped}`));
  if (record.targetDate) stats.append(kv("backfill", record.targetDate));
  if (record.generatedAt) stats.append(kv("at", formatTimeShort(record.generatedAt)));
  container.append(stats);

  // Per-session list (or 0-session note)
  const sessions = Array.isArray(record.scannedSessions) ? record.scannedSessions : [];
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "gen-record-empty";
    empty.textContent = "0 sessions matched the window";
    container.append(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "gen-record-sessions";
  for (const session of sessions) {
    const row = document.createElement("div");
    row.className = "gen-record-session";

    const status = document.createElement("span");
    const cls = session.status === "included" ? "included"
      : session.status === "empty" ? "empty"
      : "skipped";
    status.className = `status ${cls}`;
    status.textContent = session.status;

    const label = document.createElement("span");
    label.className = "label";
    const cwd = session.cwd
      ? session.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/")
      : session.sessionId;
    label.textContent = cwd;
    label.title = `${session.cwd || ""}\n${session.sessionId} · ${session.source || "?"}`;

    const chars = document.createElement("span");
    chars.className = "chars";
    chars.textContent = session.chars > 0
      ? `${Math.round(session.chars / 100) / 10}k`
      : "—";

    row.append(status, label, chars);

    if (state.settings.allowSessionDelete && session.sessionId) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "delete-btn";
      del.textContent = "🗑";
      del.title = "Move this session JSONL to trash (recoverable)";
      del.addEventListener("click", async () => {
        if (!confirm(`Move session ${session.sessionId} to trash?`)) return;
        await deleteSessions([session.sessionId]);
        // Invalidate the picker's cached candidates so the heatmap reflects
        // the change next time the panel opens.
        picker.candidates = null;
        del.disabled = true;
        del.textContent = "✓";
      });
      row.append(del);
    }

    list.append(row);
  }
  container.append(list);
}

// ============================================================
// History tab
// ============================================================

async function fetchCardsHistory() {
  try {
    const data = await fetchJson("/cards/history?limit=30");
    state.cards.history = {
      fetchedAt: Date.now(),
      items: Array.isArray(data.history) ? data.history : []
    };
  } catch (_error) {
    state.cards.history = state.cards.history || { fetchedAt: 0, items: [] };
  }
}

// History detail cache key: date for current decks, "<date>#<HHMMSS>" for
// archived prior generations. Same date can appear multiple times in
// History when the user re-generates same-day, so the key has to be
// composite.
function historyDetailKey(date, archiveId) {
  return archiveId ? `${date}#${archiveId}` : date;
}

async function fetchHistoryDetail(date, archiveId) {
  const key = historyDetailKey(date, archiveId);
  if (state.cards.historyDetail[key]) return state.cards.historyDetail[key];
  const url = archiveId
    ? `/cards/history/${date}?archive=${encodeURIComponent(archiveId)}`
    : `/cards/history/${date}`;
  try {
    const data = await fetchJson(url);
    if (data && data.payload) {
      state.cards.historyDetail[key] = data.payload;
      return data.payload;
    }
  } catch (_error) {
    // swallow — UI shows the row collapsed
  }
  return null;
}

function renderHistoryTab() {
  if (!els.historyList) return;
  const history = state.cards.history;

  // Lazy-load on first view; subsequent renders use the cache.
  if (!history) {
    els.historyList.replaceChildren(emptyRow("Loading …"));
    fetchCardsHistory().then(renderHistoryTab);
    if (els.historyMeta) els.historyMeta.textContent = "loading";
    return;
  }

  const items = history.items || [];
  if (els.historyMeta) {
    els.historyMeta.textContent = items.length
      ? `${items.length} stored · newest first`
      : "—";
  }

  if (items.length === 0) {
    els.historyList.replaceChildren(emptyRow("No abstracts stored yet."));
    return;
  }

  const rows = items.map((item) => buildHistoryRow(item));
  els.historyList.replaceChildren(...rows);
}

function buildHistoryRow(item) {
  // archiveId is HHMMSS-style for archived items; null for current decks.
  // The HHMMSS suffix in the daemon's filename, no colons.
  const archiveId = item.isArchive && item.archivedAt
    ? item.archivedAt.replace(/:/g, "")
    : null;
  const rowKey = historyDetailKey(item.date, archiveId);

  const row = document.createElement("div");
  row.className = "history-row";
  if (item.isArchive) row.classList.add("is-archive");
  row.dataset.date = item.date;
  if (archiveId) row.dataset.archiveId = archiveId;

  const head = document.createElement("button");
  head.type = "button";
  head.className = "history-row-head";

  const date = document.createElement("span");
  date.className = "history-date";
  // Archive rows show the time of the prior gen so the user can tell
  // multiple same-day decks apart at a glance.
  date.textContent = item.isArchive
    ? `${item.date.slice(5)} ${item.archivedAt.slice(0, 5)}`
    : `${item.date.slice(5)} ${weekdayShort(item.date)}`;

  const title = document.createElement("span");
  title.className = "history-title";
  const titleText = item.title || "(no title)";
  title.textContent = item.isArchive ? `${titleText} · earlier` : titleText;

  const stat = document.createElement("div");
  stat.className = "history-stat";
  if (item.cards === 0) {
    stat.innerHTML = `
      <span class="accuracy skipped">— skipped</span>
      <span>0 cards</span>`;
  } else {
    const acc = document.createElement("span");
    acc.className = "accuracy";
    acc.textContent = `${item.correct}/${item.cards}`;
    const cnt = document.createElement("span");
    cnt.textContent = `${item.cards} card${item.cards === 1 ? "" : "s"}`;
    stat.append(acc, cnt);
  }

  head.append(date, title, stat);
  row.append(head);

  const detail = document.createElement("div");
  detail.className = "history-detail";
  detail.hidden = state.cards.expandedHistory !== rowKey;
  row.append(detail);

  if (state.cards.expandedHistory === rowKey) {
    paintHistoryDetail(detail, item.date, archiveId);
  }

  head.addEventListener("click", () => {
    const same = state.cards.expandedHistory === rowKey;
    state.cards.expandedHistory = same ? null : rowKey;
    renderHistoryTab();
  });

  return row;
}

function paintHistoryDetail(container, date, archiveId) {
  const key = historyDetailKey(date, archiveId);
  const cached = state.cards.historyDetail[key];
  if (!cached) {
    container.innerHTML = `<div class="md" style="color: var(--ink-2)">Loading…</div>`;
    fetchHistoryDetail(date, archiveId).then(() => {
      // Only repaint if user is still viewing this row.
      if (state.cards.expandedHistory === key) renderHistoryTab();
    });
    return;
  }

  container.replaceChildren();

  const meta = document.createElement("div");
  meta.className = "history-detail-meta";
  const stats = cached.stats || {};
  if (stats.sessions) meta.append(makeMetaSpan(`${stats.sessions} sessions`));
  if (stats.durationMin) meta.append(makeMetaSpan(`${stats.durationMin} min`));
  const mix = difficultyMix(cached);
  meta.append(buildDifficultyMixSpan(mix));
  container.append(meta);

  const body = document.createElement("div");
  body.className = "md";
  body.innerHTML = renderMarkdown(cached.abstract || "");
  container.append(body);

  // Review CTA — kicks off a session sourced from this historical day.
  // Misses still feed the wrong-book even though the historical snapshot
  // itself is read-only. An inline ↓ md button right below lets the user
  // pull just this day's deck (with archive id when applicable) without
  // going to Settings.
  const cardCount = Array.isArray(cached.cards) ? cached.cards.length : 0;
  const ctaRow = document.createElement("div");
  ctaRow.className = "history-detail-cta";
  if (cardCount > 0) {
    const cta = document.createElement("button");
    cta.type = "button";
    cta.className = "btn-primary";
    cta.textContent = `Review ${cardCount} card${cardCount === 1 ? "" : "s"} from this day →`;
    cta.addEventListener("click", () => startHistoryReview(date, archiveId));
    ctaRow.append(cta);
  }
  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "btn-secondary";
  exportBtn.textContent = "↓ Export this day as Markdown";
  exportBtn.addEventListener("click", () => downloadCardsExport("today", { date, archive: archiveId || undefined }));
  ctaRow.append(exportBtn);
  container.append(ctaRow);
}

function makeMetaSpan(text) {
  const s = document.createElement("span");
  s.textContent = text;
  return s;
}

function buildDifficultyMixSpan(mix) {
  const span = document.createElement("span");
  span.className = "difficulty-mix";
  span.innerHTML = `
    <span><span class="num easy-n">${mix.easy}</span> easy</span>
    <span>·</span>
    <span><span class="num medium-n">${mix.medium}</span> mid</span>
    <span>·</span>
    <span><span class="num hard-n">${mix.hard}</span> hard</span>`.trim();
  return span;
}

function emptyRow(text) {
  const div = document.createElement("div");
  div.className = "cards-empty";
  div.innerHTML = `<div class="cards-empty-text">${escapeHtml(text)}</div>`;
  return div;
}

// ============================================================
// Wrong book tab
// ============================================================

async function fetchCardsWrongBook() {
  try {
    const data = await fetchJson("/cards/wrong-book");
    state.cards.wrongBook = {
      fetchedAt: Date.now(),
      entries: Array.isArray(data.entries) ? data.entries : []
    };
  } catch (_error) {
    state.cards.wrongBook = state.cards.wrongBook || { fetchedAt: 0, entries: [] };
  }
  updateWrongTabBadge();
}

function updateWrongTabBadge() {
  if (!els.wrongTabCount) return;
  const count = state.cards.wrongBook
    ? state.cards.wrongBook.entries.length
    : 0;
  if (count > 0) {
    els.wrongTabCount.textContent = String(count);
    els.wrongTabCount.hidden = false;
  } else {
    els.wrongTabCount.hidden = true;
  }
}

function renderWrongBookTab() {
  if (!els.wrongList) return;
  const book = state.cards.wrongBook;

  if (!book) {
    els.wrongList.replaceChildren(emptyRow("Loading …"));
    if (els.wrongCtaRow) els.wrongCtaRow.hidden = true;
    fetchCardsWrongBook().then(renderWrongBookTab);
    return;
  }

  const entries = book.entries || [];

  // CTA — surfaced only when there's something to review. Count goes in
  // the right-hand "arrow" slot for visual consistency with the Today
  // tab's "Start review · N left →".
  if (els.wrongCtaRow) els.wrongCtaRow.hidden = entries.length === 0;
  if (els.wrongCtaCount) {
    els.wrongCtaCount.textContent = entries.length > 0
      ? `${entries.length} card${entries.length === 1 ? "" : "s"} →`
      : "";
  }

  if (entries.length === 0) {
    els.wrongList.replaceChildren(emptyRow("No missed cards yet — keep it that way."));
    return;
  }

  const rows = entries.map((entry) => buildWrongRow(entry));
  els.wrongList.replaceChildren(...rows);
}

function buildWrongRow(entry) {
  const row = document.createElement("div");
  row.className = "wrong-row";

  const card = entry.card || {};
  const tag = document.createElement("span");
  tag.className = `wrong-tag ${card.type === "cloze" ? "cloze" : ""}`.trim();
  tag.textContent = card.type === "cloze" ? "cloze" : "choice";

  const text = document.createElement("div");
  text.className = "wrong-row-text";
  const q = document.createElement("div");
  q.className = "wrong-question";
  q.textContent = card.question || "(question missing)";
  const meta = document.createElement("div");
  meta.className = "wrong-meta";

  if (card.difficulty) {
    const chip = document.createElement("span");
    chip.className = `difficulty-chip ${card.difficulty}`;
    chip.textContent = card.difficulty;
    meta.append(chip);
  }

  const ref = document.createElement("span");
  const fileRef = (card.source && card.source.fileRef) || "";
  const added = entry.addedAt ? entry.addedAt.slice(5, 10) : "";
  ref.textContent = [
    added ? `added ${added}` : "",
    fileRef
  ].filter(Boolean).join(" · ");
  if (ref.textContent) meta.append(ref);

  text.append(q, meta);

  const right = document.createElement("div");
  right.className = "wrong-right";

  const attempts = document.createElement("div");
  attempts.className = "wrong-attempts";
  const misses = entry.totalMisses || 0;
  const consecutive = entry.consecutiveCorrect || 0;
  if (consecutive > 0) {
    attempts.innerHTML = `
      <span class="progress-text">${consecutive}× ✓</span>
      <span>${misses} miss${misses === 1 ? "" : "es"}</span>`;
  } else {
    attempts.innerHTML = `
      <span class="miss">${"✕".repeat(Math.min(misses, 3))}</span>
      <span>${misses} miss${misses === 1 ? "" : "es"}</span>`;
  }

  const replay = document.createElement("button");
  replay.type = "button";
  replay.className = "btn-replay";
  replay.textContent = "Replay";
  replay.title = "Try this card now (single-card session)";
  replay.addEventListener("click", () => startWrongReplay(entry.cardId));

  right.append(attempts, replay);
  row.append(tag, text, right);
  return row;
}

// ============================================================
// Settings — persistence, render, event wiring
// ============================================================

const SETTINGS_LS_KEY = "claude-code-companion.cards-settings.v1";

// Difficulty meta key for the i18n table — the actual string is resolved
// at render time so it follows the active locale.
const DIFFICULTY_META_KEYS = {
  casual:   "settings.difficulty.casualMeta",
  balanced: "settings.difficulty.balancedMeta",
  deep:     "settings.difficulty.deepMeta"
};
function _t(key, vars) {
  return (window.CCC_I18N && window.CCC_I18N.t) ? window.CCC_I18N.t(key, vars) : key;
}

function clampInt(n, min, max, fallback) {
  if (!Number.isFinite(n)) return fallback;
  const v = Math.round(n);
  if (v < min || v > max) return fallback;
  return v;
}

function loadSettingsFromStorage() {
  try {
    const raw = window.localStorage.getItem(SETTINGS_LS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      Object.assign(state.settings, {
        focus: typeof parsed.focus === "string" ? parsed.focus : state.settings.focus,
        difficulty: ["casual", "balanced", "deep"].includes(parsed.difficulty)
          ? parsed.difficulty : state.settings.difficulty,
        autoGenerate: typeof parsed.autoGenerate === "boolean" ? parsed.autoGenerate : state.settings.autoGenerate,
        autoGenerateAt: typeof parsed.autoGenerateAt === "string" && /^\d{2}:\d{2}$/.test(parsed.autoGenerateAt)
          ? parsed.autoGenerateAt
          : state.settings.autoGenerateAt,
        autoAddWrong: typeof parsed.autoAddWrong === "boolean" ? parsed.autoAddWrong : state.settings.autoAddWrong,
        streakNotif:  typeof parsed.streakNotif  === "boolean" ? parsed.streakNotif  : state.settings.streakNotif,
        generateWindow: [1, 3, 7, 30].includes(Number(parsed.generateWindow))
          ? Number(parsed.generateWindow) : state.settings.generateWindow,
        cardCount: clampInt(Number(parsed.cardCount), 1, 20, state.settings.cardCount),
        webFallback: typeof parsed.webFallback === "boolean" ? parsed.webFallback : state.settings.webFallback,
        transcriptBudget: clampInt(Number(parsed.transcriptBudget), 10000, 1000000, state.settings.transcriptBudget),
        selectedSessionIds: Array.isArray(parsed.selectedSessionIds)
          ? parsed.selectedSessionIds.filter((s) => typeof s === "string" && s)
          : state.settings.selectedSessionIds,
        allowSessionDelete: typeof parsed.allowSessionDelete === "boolean"
          ? parsed.allowSessionDelete : state.settings.allowSessionDelete
        // generateDate intentionally NOT persisted — backfill is per-session
      });
    }
  } catch (_error) {
    // Treat any read/parse failure as "no saved settings" — keep defaults.
  }
}

function persistSettings() {
  try {
    window.localStorage.setItem(SETTINGS_LS_KEY, JSON.stringify(state.settings));
  } catch (_error) {
    // localStorage full / blocked — UI keeps the value in memory for the
    // session, lose it on next reload. Acceptable: settings are convenience.
  }
}

function applySettingsToInputs() {
  if (els.settingsFocus) els.settingsFocus.value = state.settings.focus;
  if (els.settingsDifficulty) {
    Array.from(els.settingsDifficulty.querySelectorAll(".segment")).forEach((btn) => {
      btn.classList.toggle("is-active", btn.dataset.value === state.settings.difficulty);
    });
  }
  if (els.settingsDifficultyMeta) {
    const key = DIFFICULTY_META_KEYS[state.settings.difficulty] || DIFFICULTY_META_KEYS.balanced;
    els.settingsDifficultyMeta.textContent = _t(key);
  }
  paintToggle(els.toggleAutoGenerate, state.settings.autoGenerate);
  paintToggle(els.toggleAutoWrongBook, state.settings.autoAddWrong);
  paintToggle(els.toggleStreakNotif, state.settings.streakNotif);
  paintToggle(els.toggleWebFallback, state.settings.webFallback);
  paintToggle(els.toggleAllowSessionDelete, state.settings.allowSessionDelete);
  applyGenerateRangeToInputs();
  applyCardCountToInputs();
  applyTranscriptBudgetToInputs();
  applyPickerSummaryToInputs();
}

// Reflect state.settings.selectedSessionIds in the section-title pill so
// the user can read the selection mode at a glance even when the panel
// is collapsed. The hint text below the heading is static (instructions),
// not reused for status — that previously caused the instructions to
// vanish the first time selection state changed.
function applyPickerSummaryToInputs() {
  const ids = state.settings.selectedSessionIds;
  const tag = els.pickerModeTag;
  if (!tag) return;
  if (ids === null || ids === undefined || ids.length === 0) {
    tag.textContent = "Auto";
    tag.classList.remove("is-explicit");
  } else {
    tag.textContent = `${ids.length}`;
    tag.classList.add("is-explicit");
  }
}

function applyCardCountToInputs() {
  const value = clampInt(state.settings.cardCount, 1, 20, 5);
  if (els.cardCountSlider && Number(els.cardCountSlider.value) !== value) {
    els.cardCountSlider.value = String(value);
  }
  if (els.cardCountValue) els.cardCountValue.textContent = String(value);
}

function formatBudgetLabel(chars) {
  if (chars >= 1_000_000) {
    const m = chars / 1_000_000;
    return `${m === Math.floor(m) ? m.toFixed(0) : m.toFixed(2)}M`;
  }
  return `${Math.round(chars / 1000)}k`;
}

function applyTranscriptBudgetToInputs() {
  const value = clampInt(state.settings.transcriptBudget, 10000, 1000000, 60000);
  if (els.transcriptBudgetSlider && Number(els.transcriptBudgetSlider.value) !== value) {
    els.transcriptBudgetSlider.value = String(value);
  }
  if (els.transcriptBudgetValue) els.transcriptBudgetValue.textContent = formatBudgetLabel(value);
  if (els.settingsBudgetMeta) {
    els.settingsBudgetMeta.textContent =
      `${formatBudgetLabel(value)} chars total · per-session cap ≈ ${formatBudgetLabel(Math.floor(value / 5))}`;
  }
}

// Kept as a no-op so older call sites (e.g. saved-state hydration) don't
// crash. The previous "Generate from / backfill date" pills were folded
// into the heatmap — backfill is now a checkbox in the day-detail panel,
// generateWindow is internal-only (default 1 day when no explicit picks).
function applyGenerateRangeToInputs() {
  /* no-op since the controls are gone */
}

function paintToggle(button, on) {
  if (!button) return;
  button.classList.toggle("is-on", Boolean(on));
  button.setAttribute("aria-checked", on ? "true" : "false");
}

function renderSessionsList() {
  if (!els.sessionsList) return;
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const label = sessions.length ? `${sessions.length} active` : "—";
  // Rail badge was removed when Live moved out to its own mode; the
  // count now lives only in the floating-window header.
  if (els.sessionsCountText) els.sessionsCountText.textContent = label;
  const inline = document.getElementById("sessionsCountInline");
  if (inline) inline.textContent = label;

  if (sessions.length === 0) {
    els.sessionsList.replaceChildren(emptyRow("No active Claude sessions."));
    return;
  }

  const sorted = [...sessions].sort((a, b) => {
    return String(b.updatedAt || "").localeCompare(String(a.updatedAt || ""));
  });

  const rows = sorted.map((session) => {
    const row = document.createElement("div");
    row.className = "session-row";

    const dot = document.createElement("span");
    dot.className = "dot";
    if (session.status === "waiting" || session.status === "waiting_approval" || session.status === "waiting_answer") {
      dot.classList.add("warm");
    } else if (session.status === "failed" || session.status === "blocked") {
      dot.classList.add("rose");
    } else if (session.status === "idle") {
      dot.classList.add("idle");
    }

    // Two-line center column: tool name on top, cwd path mono-styled on
    // the bottom. cwd is the most useful identifier when several Claude
    // Code sessions are open in different repos.
    const text = document.createElement("div");
    text.className = "row-text";
    const tool = document.createElement("span");
    tool.className = "row-tool";
    tool.textContent = session.tool || session.hookEventName || "claude";
    text.append(tool);
    if (session.cwd) {
      const cwd = document.createElement("span");
      cwd.className = "row-cwd";
      cwd.textContent = compactPath(session.cwd);
      cwd.title = session.cwd;
      text.append(cwd);
    }

    const meta = document.createElement("span");
    meta.className = "row-meta";
    meta.textContent = session.status || "idle";

    row.append(dot, text, meta);
    return row;
  });
  els.sessionsList.replaceChildren(...rows);
}

// Trim a long cwd path so the session row stays compact. Replaces the
// home dir with ~ and keeps just the last 2-3 segments when the full
// path would overflow.
function compactPath(absPath) {
  if (!absPath) return "";
  // Best-effort home-dir contraction. We don't have process.env on the
  // renderer side, but a local-only daemon path will match a stable shape.
  const path = String(absPath).replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/, "~")
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~");
  // If still long, keep the last 3 segments.
  const segments = path.split(/[\\/]/).filter(Boolean);
  if (segments.length > 3 && path.length > 40) {
    return "…/" + segments.slice(-3).join("/");
  }
  return path;
}

function renderSettings() {
  if (!els.settingsPanel) return;

  if (els.settingsCardsMeta) {
    const gen = state.cards.generation;
    const today = state.cards.today;
    if (gen && gen.state === "generating") {
      els.settingsCardsMeta.textContent = "Generating now …";
    } else if (today && Array.isArray(today.cards) && today.cards.length > 0) {
      els.settingsCardsMeta.textContent = `${today.cards.length} cards · last gen ${formatTimeShort(today.updatedAt)}`;
    } else {
      els.settingsCardsMeta.textContent = "No cards yet — click Generate now.";
    }
  }
  if (els.settingsGenerateButton) {
    els.settingsGenerateButton.disabled = state.cards.generation.state === "generating";
  }
  if (els.settingsCompanionState) {
    els.settingsCompanionState.textContent =
      document.body.dataset.companionDisabled === "true" ? "disabled" : "active";
  }

  applySettingsToInputs();
  renderSessionsList();
  renderConsentMeta();  // fire-and-forget; updates the consent row asynchronously
  renderStorageRow();   // same — fetches /cards/storage and paints the path
}

function formatTimeShort(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function weekdayShort(yyyymmdd) {
  if (!yyyymmdd) return "";
  const d = new Date(`${yyyymmdd}T12:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

// ============================================================
// Generate now (stub-backed for slice 1; real subprocess later)
// ============================================================

let cardsGenPollTimer = null;

async function triggerCardsGenerate() {
  // Pre-flight: real generator pipes session content to claude -p. The
  // user must explicitly opt in once (per ADR §"Decision 11"). Modal is
  // shown by ensureCardsConsent if consent isn't on file yet.
  const ok = await ensureCardsConsent();
  if (!ok) {
    state.cards.generation = {
      state: "error",
      startedAt: state.cards.generation.startedAt,
      finishedAt: new Date().toISOString(),
      message: "Generation cancelled — consent declined"
    };
    renderCards();
    renderSettings();
    updateCardsButton();
    return;
  }

  state.cards.generation = {
    state: "generating",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    message: null
  };
  updateCardsButton();
  renderCards();
  renderSettings();
  startCardsGenerationPolling();

  try {
    const result = await fetchJson("/cards/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        focus: state.settings.focus || "",
        difficulty: state.settings.difficulty || "balanced",
        windowDays: state.settings.generateWindow || 1,
        targetDate: state.settings.generateDate || null,
        cardCount: state.settings.cardCount || 5,
        webFallback: state.settings.webFallback !== false,
        transcriptBudget: state.settings.transcriptBudget || 60000,
        selectedSessionIds: Array.isArray(state.settings.selectedSessionIds)
          ? state.settings.selectedSessionIds
          : [],
        locale: state.locale || "en"
      })
    });
    if (result && result.payload) {
      // Only swap state.cards.today if the generation was for today; a
      // backfill writes to a different date file and leaves today alone.
      if (!state.settings.generateDate) {
        state.cards.today = result.payload;
      }
    }
    state.cards.generation = {
      state: "idle",
      startedAt: state.cards.generation.startedAt,
      finishedAt: new Date().toISOString(),
      message: result && result.stub ? "stub deck written" : "ok"
    };
    // Any successful generate may have changed the History tab — either it
    // added a backfill date OR it archived today's prior deck into a new
    // <date>-HHMMSS row. Invalidate both the list cache and the per-date
    // detail cache so the next History view fetches fresh.
    state.cards.history = null;
    state.cards.historyDetail = {};
    state.cards.expandedHistory = null;
    // Backfill is single-shot: clear the date once we've generated for it
    // so the next click of Generate goes back to the rolling-window mode.
    if (state.settings.generateDate) {
      state.settings.generateDate = null;
    }
    // Same one-shot semantics for the heatmap session pick — once it's
    // been used to feed a generation, drop back to Auto so the next run
    // doesn't silently re-use the same selection (a real bug report from
    // a user who picked sessions, generated, then expected the next
    // generate to be fresh and got the same set).
    if (Array.isArray(state.settings.selectedSessionIds)) {
      state.settings.selectedSessionIds = null;
      persistSettings();
      if (picker && picker.draft) {
        picker.draft.clear();
      }
      if (els.heatmap) renderHeatmap();
      if (els.dayDetail) renderDayDetail();
      updatePickerCountMeta();
      applyPickerSummaryToInputs();
    }
  } catch (error) {
    console.error("[cards] generate failed:", error);
    state.cards.generation = {
      state: "error",
      startedAt: state.cards.generation.startedAt,
      finishedAt: new Date().toISOString(),
      message: error.message || String(error)
    };
  }
  stopCardsGenerationPolling();
  await fetchCardsToday();
  renderCards();
  renderSettings();
  updateCardsButton();
}

function startCardsGenerationPolling() {
  stopCardsGenerationPolling();
  cardsGenPollTimer = setInterval(async () => {
    await fetchCardsGenerationStatus();
    renderCards();
    renderSettings();
  }, 800);
}

function stopCardsGenerationPolling() {
  if (cardsGenPollTimer) {
    clearInterval(cardsGenPollTimer);
    cardsGenPollTimer = null;
  }
}

// ============================================================
// Active review state machine
// ============================================================

function unansweredCards(payload) {
  if (!payload || !Array.isArray(payload.cards)) return [];
  return payload.cards.filter((c) => {
    const last = Array.isArray(c.attempts) && c.attempts.length
      ? c.attempts[c.attempts.length - 1]
      : null;
    return !last || !last.correct;
  });
}

function startReviewSession() {
  if (!state.cards.today) return;
  const queue = unansweredCards(state.cards.today);
  if (queue.length === 0) return;

  const cards = {};
  for (const c of queue) cards[c.id] = c;

  state.cards.review = {
    source: "today",
    queue: queue.map((c) => c.id),
    cards,
    index: 0,
    correct: 0,
    wrong: 0,
    selected: null,
    feedback: null,
    startedAt: Date.now()
  };
  if (els.completionScreen) els.completionScreen.hidden = true;
  if (els.reviewActive) els.reviewActive.hidden = false;
  renderActiveReview();
}

// Multi-card review session sourced from a historical day (or an
// archived prior generation of a day). The full payload was loaded into
// state.cards.historyDetail by the user expanding that history row;
// we resolve all cards from it here. Misses still feed the wrong-book.
function startHistoryReview(date, archiveId) {
  const key = historyDetailKey(date, archiveId);
  const payload = state.cards.historyDetail[key];
  if (!payload || !Array.isArray(payload.cards) || payload.cards.length === 0) return;

  const cards = {};
  for (const c of payload.cards) cards[c.id] = c;

  state.cards.review = {
    source: "history",
    historyDate: date,
    historyArchiveId: archiveId || null,
    queue: payload.cards.map((c) => c.id),
    cards,
    index: 0,
    correct: 0,
    wrong: 0,
    selected: null,
    feedback: null,
    startedAt: Date.now()
  };
  if (els.completionScreen) els.completionScreen.hidden = true;
  if (els.reviewActive) els.reviewActive.hidden = false;
  renderActiveReview();
}

// Full-book review sourced from the wrong book. Builds a queue of every
// outstanding entry, ordered by total misses descending so the most-
// stuck cards come up first. Submits via the existing wrong-book lookup
// path on the daemon — no extra context needed in the answer body.
function startWrongBookFullReview() {
  const book = state.cards.wrongBook;
  if (!book || !Array.isArray(book.entries) || book.entries.length === 0) return;

  const sorted = [...book.entries].sort((a, b) => {
    return (b.totalMisses || 0) - (a.totalMisses || 0);
  });

  const cards = {};
  for (const entry of sorted) {
    if (entry && entry.cardId && entry.card) {
      cards[entry.cardId] = entry.card;
    }
  }
  const queue = sorted.map((e) => e.cardId).filter((id) => cards[id]);
  if (queue.length === 0) return;

  state.cards.review = {
    source: "wrong",
    queue,
    cards,
    index: 0,
    correct: 0,
    wrong: 0,
    selected: null,
    feedback: null,
    startedAt: Date.now()
  };
  if (els.completionScreen) els.completionScreen.hidden = true;
  if (els.reviewActive) els.reviewActive.hidden = false;
  renderActiveReview();
}

// Single-card replay sourced from a wrong-book entry. The card snapshot is
// resolved at session start so the renderer never needs to reach into
// state.cards.today (which doesn't contain wrong-book replays).
function startWrongReplay(cardId) {
  const book = state.cards.wrongBook;
  if (!book) return;
  const entry = book.entries.find((e) => e.cardId === cardId);
  if (!entry || !entry.card) return;

  state.cards.review = {
    source: "wrong",
    queue: [cardId],
    cards: { [cardId]: entry.card },
    index: 0,
    correct: 0,
    wrong: 0,
    selected: null,
    feedback: null,
    startedAt: Date.now()
  };
  if (els.completionScreen) els.completionScreen.hidden = true;
  if (els.reviewActive) els.reviewActive.hidden = false;
  renderActiveReview();
}

function endReviewSession({ completed }) {
  const review = state.cards.review;
  const source = review ? review.source : "today";

  if (els.reviewActive) els.reviewActive.hidden = true;
  if (completed && els.completionScreen && review) {
    if (els.completionCorrect) els.completionCorrect.textContent = String(review.correct);
    if (els.completionWrong)   els.completionWrong.textContent   = String(review.wrong);
    if (els.completionSub) {
      const elapsed = Math.round((Date.now() - review.startedAt) / 1000);
      els.completionSub.textContent =
        `${review.correct + review.wrong} cards · ${elapsed}s`;
    }
    if (els.completionTitle) {
      // Replay sessions don't claim "Daily goal reached" — they're a single-
      // card retry, not the full daily flow. History replays get their own
      // wording so it's clear what just happened. Wrong-book full review
      // (queue.length > 1, source="wrong") gets a sweep-style title.
      if (source === "wrong") {
        const isSweep = review.queue.length > 1;
        if (isSweep) {
          els.completionTitle.textContent = review.wrong === 0
            ? "Wrong book · clean sweep"
            : "Wrong book review complete";
        } else {
          els.completionTitle.textContent = review.wrong === 0
            ? "Replay complete · ✓"
            : "Replay complete";
        }
      } else if (source === "history") {
        els.completionTitle.textContent = review.wrong === 0
          ? "History replay · all correct"
          : "History replay complete";
      } else {
        els.completionTitle.textContent = review.wrong === 0
          ? "Daily goal reached!"
          : "Review session complete";
      }
    }
    els.completionScreen.hidden = false;
    // Stash the source so the "Back" button in completion can route to the
    // tab the user came from.
    state.cards.lastReviewSource = source;
  }
  state.cards.review = null;
  // Refresh both today and wrong-book — either could have changed depending
  // on the path taken.
  Promise.all([fetchCardsToday(), fetchCardsWrongBook()]).then(() => {
    renderCards();
    renderSettings();
  });
}

function currentReviewCard() {
  const review = state.cards.review;
  if (!review || review.index >= review.queue.length) return null;
  const id = review.queue[review.index];
  return review.cards[id] || null;
}

function renderActiveReview() {
  const review = state.cards.review;
  const card = currentReviewCard();
  if (!review || !card) {
    endReviewSession({ completed: true });
    return;
  }

  if (els.reviewActive) els.reviewActive.hidden = false;
  if (els.completionScreen) els.completionScreen.hidden = true;

  const total = review.queue.length;
  const position = review.index + 1;
  if (els.reviewProgressText) {
    els.reviewProgressText.textContent = `Card ${position} / ${total}`;
  }

  if (els.reviewDifficultyChip) {
    const chip = els.reviewDifficultyChip;
    chip.className = "difficulty-chip";
    if (card.difficulty) {
      chip.classList.add(card.difficulty);
      chip.textContent = card.difficulty;
    } else {
      chip.textContent = "";
    }
  }

  if (els.reviewProgressDots) {
    const dots = [];
    for (let i = 0; i < total; i += 1) {
      let cls = "";
      if (i < review.index) cls = "done";
      else if (i === review.index) cls = "current";
      dots.push(`<span class="dot ${cls}"></span>`);
    }
    els.reviewProgressDots.innerHTML = dots.join("");
  }

  if (els.reviewQuestion) els.reviewQuestion.textContent = card.question || "";

  // Source block — render web vs session differently. Web cards must
  // carry source.kind="web" + source.fileRef=<URL>; session cards have
  // file:line + role-tagged transcript snippet.
  const source = card.source || {};
  const isWebSource = source.kind === "web";
  if (els.reviewSource) {
    els.reviewSource.open = isWebSource;  // open by default for web — URL is the headline
    els.reviewSource.hidden = false;
    els.reviewSource.classList.toggle("is-web", isWebSource);
  }
  if (els.reviewSourceRef) {
    if (isWebSource) {
      els.reviewSourceRef.innerHTML = `
        <span class="source-kind-badge web">🌐 web</span>
        <span class="source-ref-text">${escapeHtml(source.webTitle || source.fileRef || "")}</span>`;
    } else {
      els.reviewSourceRef.innerHTML = `
        <span class="source-kind-badge session">session</span>
        <span class="source-ref-text">${escapeHtml(source.fileRef || source.sessionId || "")}</span>`;
    }
  }
  if (els.reviewSourceQuote) {
    if (isWebSource) {
      const url = source.fileRef || "";
      const urlHtml = url
        ? `<div class="web-url"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></div>`
        : "";
      els.reviewSourceQuote.innerHTML = `${urlHtml}<div class="web-snippet">${escapeHtml(source.snippet || "")}</div>`;
    } else {
      els.reviewSourceQuote.innerHTML = renderSourceSnippet(source.snippet || "");
    }
  }

  // Choice / cloze body
  if (card.type === "choice") {
    renderChoiceOptions(card, review);
    if (els.reviewCloze) els.reviewCloze.hidden = true;
    if (els.reviewClozeInputRow) els.reviewClozeInputRow.hidden = true;
    if (els.reviewOptions) els.reviewOptions.hidden = false;
  } else if (card.type === "cloze") {
    if (els.reviewOptions) {
      els.reviewOptions.replaceChildren();
      els.reviewOptions.hidden = true;
    }
    if (els.reviewCloze) {
      els.reviewCloze.hidden = false;
      els.reviewCloze.textContent = card.question || "";
    }
    if (els.reviewClozeInputRow) {
      els.reviewClozeInputRow.hidden = false;
      if (els.reviewClozeInput) {
        els.reviewClozeInput.value = "";
        els.reviewClozeInput.disabled = false;
        setTimeout(() => els.reviewClozeInput.focus(), 0);
      }
    }
  }

  // Feedback area defaults to hidden — including the inner blocks so
  // last card's content doesn't flash through during the next paint.
  if (els.reviewFeedback) els.reviewFeedback.hidden = true;
  if (els.feedbackAnswer) els.feedbackAnswer.hidden = true;
  if (els.feedbackExplanation) els.feedbackExplanation.hidden = true;
  if (els.reviewSubmit) {
    els.reviewSubmit.textContent = "Submit";
    els.reviewSubmit.disabled = false;
  }
}

function renderChoiceOptions(card, review) {
  if (!els.reviewOptions) return;
  els.reviewOptions.replaceChildren();
  (card.options || []).forEach((opt, idx) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option";
    if (review.selected === idx) button.classList.add("selected");
    button.innerHTML = `
      <span class="option-key">${String.fromCharCode(65 + idx)}</span>
      <span></span>`;
    button.lastElementChild.textContent = String(opt);
    button.addEventListener("click", () => {
      if (review.feedback) return; // locked once submitted
      review.selected = idx;
      renderActiveReview();
    });
    els.reviewOptions.append(button);
  });
}

function renderSourceSnippet(snippet) {
  // Convert leading "user:" / "assistant:" / "edit:" lines into
  // role-tagged headers so the source quote reads like a real transcript.
  const lines = String(snippet || "").split("\n");
  let out = "";
  for (const raw of lines) {
    const role = raw.match(/^(user|assistant|edit)\s*:\s*(.*)$/i);
    if (role) {
      const tag = role[1].toLowerCase();
      out += `<span class="speaker ${tag}">${tag}</span>`;
      const rest = role[2];
      if (rest) out += `${escapeHtml(rest)}\n`;
      continue;
    }
    out += `${escapeHtml(raw)}\n`;
  }
  return out;
}

async function submitReviewAnswer() {
  const review = state.cards.review;
  const card = currentReviewCard();
  if (!review || !card) return;

  let picked = "";
  if (card.type === "choice") {
    if (review.selected === null || review.selected === undefined) return;
    picked = String(review.selected);
  } else if (card.type === "cloze") {
    picked = els.reviewClozeInput ? els.reviewClozeInput.value : "";
    if (!picked.trim()) {
      els.reviewClozeInput && els.reviewClozeInput.focus();
      return;
    }
  }

  if (els.reviewSubmit) {
    els.reviewSubmit.disabled = true;
    els.reviewSubmit.textContent = "Checking …";
  }

  // History replay needs to tell the daemon which historical file to read
  // the card from — we don't carry that context server-side otherwise.
  const answerBody = { cardId: card.id, picked, durationMs: 0 };
  if (review.source === "history" && review.historyDate) {
    answerBody.historyDate = review.historyDate;
    if (review.historyArchiveId) answerBody.historyArchiveId = review.historyArchiveId;
  }

  let result;
  try {
    result = await fetchJson("/cards/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(answerBody)
    });
  } catch (error) {
    if (els.reviewSubmit) {
      els.reviewSubmit.disabled = false;
      els.reviewSubmit.textContent = "Retry";
    }
    return;
  }

  review.feedback = { correct: Boolean(result.correct), answer: result.answer, explanation: result.explanation };
  if (result.correct) {
    review.correct += 1;
  } else {
    review.wrong += 1;
  }
  paintReviewFeedback(card, review.feedback);

  // Wrong-book aggregate may have changed (entry added / removed / mastered).
  // Invalidate today's history-detail cache + the history list so re-opens
  // reflect the updated attempts. Fetch the wrong-book in the background so
  // the tab badge stays accurate during a session.
  if (state.cards.today && state.cards.today.date) {
    delete state.cards.historyDetail[state.cards.today.date];
  }
  state.cards.history = null;
  fetchCardsWrongBook();
  // The streak count flips from N → N+1 the moment the user attempts the
  // last unattempted card of the day, so refresh after every answer.
  fetchStreak();
}

function paintReviewFeedback(card, feedback) {
  if (els.reviewFeedback) els.reviewFeedback.hidden = false;
  if (els.feedbackIcon) {
    els.feedbackIcon.className = `feedback-icon ${feedback.correct ? "correct" : "wrong"}`;
    els.feedbackIcon.textContent = feedback.correct ? "✓" : "✕";
  }
  if (els.feedbackVerdict) {
    els.feedbackVerdict.className = `feedback-verdict ${feedback.correct ? "correct" : "wrong"}`;
    els.feedbackVerdict.innerHTML = `
      <span class="top">${feedback.correct ? "Correct" : "Not quite"}</span>
      <span class="sub">${feedback.correct ? "+1" : "queued for tomorrow"}</span>`;
  }
  // Always surface the canonical correct answer above the explanation, so
  // the user can verify against their pick (especially valuable for cloze
  // where the option-list visualization isn't present, and for the wrong
  // path where the highlighted option might still feel ambiguous).
  if (els.feedbackAnswer) {
    let answerHtml = "";
    if (card.type === "choice") {
      const correctIdx = typeof card.answer === "number"
        ? card.answer
        : (card.options || []).findIndex((o) => String(o) === String(card.answer));
      const letter = correctIdx >= 0 ? String.fromCharCode(65 + correctIdx) : "?";
      const text = correctIdx >= 0 ? String((card.options || [])[correctIdx] || "") : "";
      answerHtml = `
        <span class="label">正确答案</span>
        <div class="answer-row">
          <span class="answer-key">${letter}</span>
          <span class="answer-text">${escapeHtml(text)}</span>
        </div>`;
    } else if (card.type === "cloze") {
      answerHtml = `
        <span class="label">正确答案</span>
        <div class="answer-row">
          <span class="answer-key">${escapeHtml(String(card.answer || ""))}</span>
        </div>`;
    }
    if (answerHtml) {
      els.feedbackAnswer.hidden = false;
      els.feedbackAnswer.innerHTML = answerHtml;
    } else {
      els.feedbackAnswer.hidden = true;
    }
  }
  if (els.feedbackExplanation) {
    if (feedback.explanation && feedback.explanation.snippet) {
      els.feedbackExplanation.hidden = false;
      els.feedbackExplanation.innerHTML = `
        <span class="by-source">From session</span>
        <div>${escapeHtml(feedback.explanation.snippet)}</div>`;
    } else {
      els.feedbackExplanation.hidden = true;
    }
  }

  // Mark choice option visually after submission.
  if (card.type === "choice" && els.reviewOptions) {
    const correctIdx = typeof card.answer === "number"
      ? card.answer
      : (card.options || []).findIndex((o) => String(o) === String(card.answer));
    Array.from(els.reviewOptions.children).forEach((btn, idx) => {
      btn.classList.add("disabled");
      if (idx === correctIdx) btn.classList.add("correct");
      else if (idx === state.cards.review.selected && !feedback.correct) btn.classList.add("wrong");
    });
  }
  if (card.type === "cloze" && els.reviewClozeInput) {
    els.reviewClozeInput.disabled = true;
  }

  if (els.reviewSubmit) {
    els.reviewSubmit.disabled = false;
    els.reviewSubmit.textContent = "Next →";
  }
}

function advanceReview() {
  const review = state.cards.review;
  if (!review) return;
  review.index += 1;
  review.selected = null;
  review.feedback = null;
  if (review.index >= review.queue.length) {
    endReviewSession({ completed: true });
    return;
  }
  renderActiveReview();
}

function skipCurrentReview() {
  const review = state.cards.review;
  if (!review) return;
  review.index += 1;
  review.selected = null;
  review.feedback = null;
  if (review.index >= review.queue.length) {
    endReviewSession({ completed: true });
    return;
  }
  renderActiveReview();
}

// ============================================================
// Cards / settings event wiring
// ============================================================

if (els.cardsTabButtons.length) {
  els.cardsTabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      state.cards.activeTab = btn.dataset.tab || "today";
      renderCards();
    });
  });
}

if (els.cardsGenerateButton) {
  els.cardsGenerateButton.addEventListener("click", triggerCardsGenerate);
}
if (els.cardsRegenerateButton) {
  els.cardsRegenerateButton.addEventListener("click", triggerCardsGenerate);
}
if (els.settingsGenerateButton) {
  els.settingsGenerateButton.addEventListener("click", triggerCardsGenerate);
}
if (els.settingsOpenCards) {
  els.settingsOpenCards.addEventListener("click", () => window.companionDesktop.openCards());
}

// Settings event wiring — focus textarea, difficulty segmented, three
// toggles. Each handler updates state.settings + persists to localStorage.
// triggerCardsGenerate reads from state.settings to compose the request.

if (els.settingsFocus) {
  els.settingsFocus.addEventListener("input", () => {
    state.settings.focus = els.settingsFocus.value;
    persistSettings();
  });
}

if (els.settingsDifficulty) {
  els.settingsDifficulty.addEventListener("click", (event) => {
    const btn = event.target.closest(".segment");
    if (!btn || !els.settingsDifficulty.contains(btn)) return;
    const value = btn.dataset.value;
    if (!value || state.settings.difficulty === value) return;
    state.settings.difficulty = value;
    persistSettings();
    applySettingsToInputs();
  });
}

// Apple-clock-style two-wheel time picker — scroll-snaps to a 24px row,
// reads the centred row as the value. Padding rows at the top and
// bottom let 00 / 23 / 59 actually land in the centre band. JS reads
// scrollTop on scroll-end; CSS scroll-snap-type pulls the wheel to a
// stable row even on flick gestures.
function bindAutoGenerateTimePicker() {
  const root = document.getElementById("autoGenerateTimePicker");
  if (!root) return;
  const ROW_H = 24;
  const VISIBLE_ROWS = 3;
  const PAD_ROWS = (VISIBLE_ROWS - 1) / 2; // 1 pad above + 1 below

  function buildWheel(el, max) {
    el.replaceChildren();
    for (let i = 0; i < PAD_ROWS; i += 1) {
      const pad = document.createElement("div");
      pad.className = "time-wheel-cell is-pad";
      el.append(pad);
    }
    for (let i = 0; i <= max; i += 1) {
      const cell = document.createElement("div");
      cell.className = "time-wheel-cell";
      cell.textContent = String(i).padStart(2, "0");
      cell.dataset.value = String(i);
      el.append(cell);
    }
    for (let i = 0; i < PAD_ROWS; i += 1) {
      const pad = document.createElement("div");
      pad.className = "time-wheel-cell is-pad";
      el.append(pad);
    }
  }

  function valueFor(el) {
    return Math.max(0, Math.round(el.scrollTop / ROW_H));
  }
  function paintCurrent(el) {
    const idx = valueFor(el);
    el.querySelectorAll(".time-wheel-cell").forEach((c, i) => {
      // i=0..PAD_ROWS-1 are top pads, i=PAD_ROWS..PAD_ROWS+max are values
      // current cell sits at i = PAD_ROWS + idx... but we use scrollTop /
      // ROW_H so just compare against (idx + PAD_ROWS).
      c.classList.toggle("is-current", i === idx + PAD_ROWS);
    });
  }
  function setWheelTo(el, value) {
    el.scrollTop = value * ROW_H;
    paintCurrent(el);
  }
  function readTime() {
    const h = valueFor(root.querySelector('.time-wheel[data-unit="hour"]'));
    const m = valueFor(root.querySelector('.time-wheel[data-unit="minute"]'));
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  const hourEl = root.querySelector('.time-wheel[data-unit="hour"]');
  const minEl  = root.querySelector('.time-wheel[data-unit="minute"]');
  buildWheel(hourEl, 23);
  buildWheel(minEl, 59);

  // Hydrate from saved setting.
  const initial = state.settings.autoGenerateAt || "09:00";
  const [ih, im] = initial.split(":").map((n) => parseInt(n, 10) || 0);
  setWheelTo(hourEl, ih);
  setWheelTo(minEl, im);

  // Persist on scroll-end. Debounce so a flick doesn't spam writes.
  let writeTimer = null;
  const onScroll = (el) => {
    paintCurrent(el);
    if (writeTimer) clearTimeout(writeTimer);
    writeTimer = setTimeout(() => {
      writeTimer = null;
      state.settings.autoGenerateAt = readTime();
      persistSettings();
    }, 220);
  };
  hourEl.addEventListener("scroll", () => onScroll(hourEl), { passive: true });
  minEl.addEventListener("scroll", () => onScroll(minEl), { passive: true });

  // Native wheel scrolling on Windows feels too aggressive — one mouse-
  // wheel tick easily moves 100 px, jumping 4–5 rows. Override with a
  // throttled "one row per wheel notch" handler.
  function bindWheelOnly(el, max) {
    let wheelLock = 0;
    el.addEventListener("wheel", (event) => {
      event.preventDefault();
      const now = performance.now();
      if (now - wheelLock < 80) return;
      wheelLock = now;
      const dir = event.deltaY > 0 ? 1 : -1;
      const current = valueFor(el);
      const next = Math.max(0, Math.min(max, current + dir));
      el.scrollTo({ top: next * ROW_H, behavior: "smooth" });
    }, { passive: false });
  }
  bindWheelOnly(hourEl, 23);
  bindWheelOnly(minEl, 59);

  // Mouse / touch drag — pointerdown captures the wheel, pointermove
  // translates the wheel, pointerup snaps to the nearest cell. While
  // dragging we kill scroll-snap so the wheel tracks the cursor 1:1
  // instead of fighting back to the nearest snap point.
  function bindDrag(el, max) {
    let dragging = false;
    let startY = 0;
    let startScroll = 0;
    let pointerId = null;
    el.addEventListener("pointerdown", (event) => {
      // Ignore non-primary buttons; let wheel/touch primary through.
      if (event.button !== 0 && event.pointerType === "mouse") return;
      dragging = true;
      startY = event.clientY;
      startScroll = el.scrollTop;
      pointerId = event.pointerId;
      try { el.setPointerCapture(pointerId); } catch (_e) {}
      el.style.scrollSnapType = "none";
      el.style.cursor = "grabbing";
    });
    el.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dy = event.clientY - startY;
      const next = Math.max(0, Math.min(max * ROW_H, startScroll - dy));
      el.scrollTop = next;
    });
    const finishDrag = () => {
      if (!dragging) return;
      dragging = false;
      try { if (pointerId !== null) el.releasePointerCapture(pointerId); } catch (_e) {}
      pointerId = null;
      el.style.cursor = "";
      // Snap to nearest cell. Force-restore scroll-snap on the next
      // frame so the smooth scroll lands on the snap, not before it.
      const idx = Math.max(0, Math.min(max, Math.round(el.scrollTop / ROW_H)));
      el.scrollTo({ top: idx * ROW_H, behavior: "smooth" });
      requestAnimationFrame(() => {
        el.style.scrollSnapType = "";
      });
    };
    el.addEventListener("pointerup", finishDrag);
    el.addEventListener("pointercancel", finishDrag);
    el.style.cursor = "grab";
  }
  bindDrag(hourEl, 23);
  bindDrag(minEl, 59);

  // Hide the wheel when auto-generate is off (still rendered so we don't
  // re-build on toggle, just visually collapsed via [hidden]).
  function syncWheelVisibility() {
    root.hidden = !state.settings.autoGenerate;
  }
  syncWheelVisibility();
  // Rebind: when the existing toggleAutoGenerate handler flips the bool,
  // also update visibility.
  const toggleEl = els.toggleAutoGenerate;
  if (toggleEl) {
    const observer = new MutationObserver(syncWheelVisibility);
    observer.observe(toggleEl, { attributes: true, attributeFilter: ["class"] });
  }
}

function bindToggle(button, key) {
  if (!button) return;
  button.addEventListener("click", () => {
    state.settings[key] = !state.settings[key];
    persistSettings();
    paintToggle(button, state.settings[key]);
  });
}
bindToggle(els.toggleAutoGenerate, "autoGenerate");
bindToggle(els.toggleAutoWrongBook, "autoAddWrong");
bindToggle(els.toggleStreakNotif, "streakNotif");
bindToggle(els.toggleWebFallback, "webFallback");
bindToggle(els.toggleAllowSessionDelete, "allowSessionDelete");

// Auto-start toggle is OS-managed (Electron's setLoginItemSettings hits
// the registry on Windows / LaunchAgents on macOS), so it doesn't sit in
// state.settings.* like the other toggles. We read the current value from
// main on mount, paint the button, and write back through IPC on click.
if (els.toggleAutoStart && window.companionDesktop?.getAutoStart) {
  window.companionDesktop.getAutoStart().then((on) => {
    paintToggle(els.toggleAutoStart, on);
  });
  els.toggleAutoStart.addEventListener("click", async () => {
    const next = !els.toggleAutoStart.classList.contains("is-on");
    const result = await window.companionDesktop.setAutoStart(next);
    paintToggle(els.toggleAutoStart, result);
  });
}

if (els.cardCountSlider) {
  els.cardCountSlider.addEventListener("input", () => {
    const value = clampInt(Number(els.cardCountSlider.value), 1, 20, 5);
    state.settings.cardCount = value;
    if (els.cardCountValue) els.cardCountValue.textContent = String(value);
  });
  els.cardCountSlider.addEventListener("change", () => {
    persistSettings();
  });
}

if (els.transcriptBudgetSlider) {
  els.transcriptBudgetSlider.addEventListener("input", () => {
    const value = clampInt(Number(els.transcriptBudgetSlider.value), 10000, 1000000, 60000);
    state.settings.transcriptBudget = value;
    if (els.transcriptBudgetValue) els.transcriptBudgetValue.textContent = formatBudgetLabel(value);
    if (els.settingsBudgetMeta) {
      els.settingsBudgetMeta.textContent =
        `${formatBudgetLabel(value)} chars total · per-session cap ≈ ${formatBudgetLabel(Math.floor(value / 5))}`;
    }
  });
  els.transcriptBudgetSlider.addEventListener("change", () => {
    persistSettings();
  });
}

// ============================================================
// Specific sessions picker — GitHub-contributions-style heatmap
// + day-detail panel for per-session refinement.
//
// Two layers of state:
//   - state.settings.selectedSessionIds  → committed (sent to /cards/generate)
//   - picker.draft                       → working copy edited by the panel,
//                                          flushed to settings on Confirm
// ============================================================

// Single-row horizontal heatmap. Span = (oldest active day - left padding)
// → today. With ~30 days of history this is ~37 cells which fits any
// reasonable panel; with longer history the wrap scrolls horizontally.
// We never go SHORTER than HEATMAP_MIN_DAYS so a brand-new user still sees
// a usable strip — but we don't pad with empty months either.
const HEATMAP_MIN_DAYS = 30;
const HEATMAP_LEFT_PAD_DAYS = 3;          // breathing room before oldest data
const HEATMAP_LEVELS = [0, 1, 3, 6, 11];  // bucket thresholds (low → high)

// candidates: full result of /sessions/scan-candidates
// byDate:     Map<"YYYY-MM-DD", Array<candidate>>
// draft:      Set<sessionId>  (working selection; commits to settings on Confirm)
// focusDates: Set<"YYYY-MM-DD"> currently shown in the day-detail panel
// dragAnchor / dragCurrent: heatmap drag state
const picker = {
  candidates: null,
  byDate: new Map(),
  draft: new Set(),
  focusDates: new Set(),
  dragAnchor: null,
  dragCurrent: null,
  isDragging: false
};

function localDateString(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfDay(d) {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

// Bucket a session count into a 0-4 visual level.
function heatmapLevel(count) {
  if (!count || count < 1) return 0;
  for (let i = HEATMAP_LEVELS.length - 1; i >= 0; i -= 1) {
    if (count >= HEATMAP_LEVELS[i]) return i;
  }
  return 0;
}

async function fetchScanCandidates() {
  try {
    // High limit so the heatmap shows the full available history (the
    // daemon's own clamp caps at 100 — bumped below).
    const data = await fetchJson("/sessions/scan-candidates?limit=10000");
    const items = Array.isArray(data.items) ? data.items : [];
    // Sort newest-first by last activity (mtime). Daemon already sorts
    // this way, but a defensive sort here keeps the UI predictable.
    items.sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));
    picker.candidates = items;
  } catch (_error) {
    picker.candidates = [];
  }
  rebuildByDate();
  syncDraftFromSettings();
  renderHeatmap();
  renderDayDetail();
}

function rebuildByDate() {
  picker.byDate = new Map();
  for (const item of (picker.candidates || [])) {
    const ds = localDateString(item.lastSeenAt);
    if (!ds) continue;
    if (!picker.byDate.has(ds)) picker.byDate.set(ds, []);
    picker.byDate.get(ds).push(item);
  }
}

// Pull the committed selection into the draft (called on panel open + after
// external changes). The draft is what the panel mutates; nothing is
// persisted until Confirm.
function syncDraftFromSettings() {
  picker.draft = new Set(state.settings.selectedSessionIds || []);
  // Default focus = the most recent day with any sessions, so the detail
  // panel isn't empty on first open.
  if (picker.focusDates.size === 0 && picker.byDate.size > 0) {
    const newest = Array.from(picker.byDate.keys()).sort().pop();
    picker.focusDates = new Set([newest]);
  }
}

// Render a single horizontal row of cells, one per day. Today is on the
// rightmost end. The strip auto-extends to cover the user's oldest
// session, with a floor of HEATMAP_MIN_DAYS so the layout never collapses.
function renderHeatmap() {
  if (!els.heatmap) return;
  els.heatmap.replaceChildren();
  if (els.heatmapMonthLabels) els.heatmapMonthLabels.replaceChildren();

  const today = startOfDay(new Date());
  // Find the oldest day with data; default to today if no data yet.
  let oldestActiveMs = today.getTime();
  for (const ds of picker.byDate.keys()) {
    const t = Date.parse(ds);
    if (Number.isFinite(t) && t < oldestActiveMs) oldestActiveMs = t;
  }
  // Pad the start a few days for visual breathing room, then enforce
  // HEATMAP_MIN_DAYS so an empty workspace still shows a meaningful strip.
  const minStartMs = today.getTime() - (HEATMAP_MIN_DAYS - 1) * 86400000;
  const paddedStartMs = Math.min(
    oldestActiveMs - HEATMAP_LEFT_PAD_DAYS * 86400000,
    minStartMs
  );
  const startDay = startOfDay(new Date(paddedStartMs));
  const totalDays = Math.round((today.getTime() - startDay.getTime()) / 86400000) + 1;
  const committed = new Set(state.settings.selectedSessionIds || []);

  let prevMonth = -1;
  for (let i = 0; i < totalDays; i += 1) {
    const d = addDays(startDay, i);
    const ds = localDateString(d);
    const sessions = picker.byDate.get(ds) || [];
    const cell = document.createElement("div");
    cell.className = "heatmap-cell";
    const lvl = heatmapLevel(sessions.length);
    cell.classList.add(`lvl-${lvl}`);
    cell.dataset.date = ds;
    if (d.getTime() === today.getTime()) cell.classList.add("is-today");
    if (sessions.some((s) => committed.has(s.sessionId))) cell.classList.add("is-committed");
    if (picker.focusDates.has(ds)) cell.classList.add("is-anchor");
    cell.title = `${ds} · ${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
    els.heatmap.append(cell);

    // Month label tick — render once when month changes.
    if (els.heatmapMonthLabels) {
      const monthIdx = d.getMonth();
      if (monthIdx !== prevMonth) {
        const tick = document.createElement("div");
        tick.className = "month-tick";
        tick.style.gridColumn = String(i + 1);
        const label = document.createElement("span");
        label.textContent = d.toLocaleString(undefined, { month: "short" });
        tick.append(label);
        els.heatmapMonthLabels.append(tick);
        prevMonth = monthIdx;
      }
    }
  }
  paintDragRange();

  // Auto-scroll to the right edge so today is visible on first paint.
  const wrap = els.heatmap.parentElement;
  if (wrap && wrap.scrollLeft === 0) {
    requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
  }
}

// During drag, recolor cells in the [anchor, current] inclusive range.
function paintDragRange() {
  if (!els.heatmap) return;
  const cells = els.heatmap.querySelectorAll(".heatmap-cell");
  if (!picker.isDragging || !picker.dragAnchor || !picker.dragCurrent) {
    cells.forEach((c) => c.classList.remove("in-range"));
    return;
  }
  const a = picker.dragAnchor, b = picker.dragCurrent;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  cells.forEach((c) => {
    const ds = c.dataset.date;
    c.classList.toggle("in-range", !!ds && ds >= lo && ds <= hi);
  });
}

// Enumerate every date string between lo and hi inclusive.
function enumerateDates(lo, hi) {
  const start = startOfDay(new Date(lo));
  const end = startOfDay(new Date(hi));
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    out.push(localDateString(d));
  }
  return out;
}

// Heatmap pointer events. mousedown/up over .heatmap-cell, with elementFromPoint
// during move so dragging works across cell gaps.
function bindHeatmapPointer() {
  if (!els.heatmap) return;
  els.heatmap.addEventListener("pointerdown", (event) => {
    const cell = event.target.closest(".heatmap-cell");
    if (!cell || cell.classList.contains("is-empty")) return;
    event.preventDefault();
    picker.isDragging = true;
    picker.dragAnchor = cell.dataset.date;
    picker.dragCurrent = cell.dataset.date;
    try { els.heatmap.setPointerCapture(event.pointerId); } catch (_e) {}
    paintDragRange();
  });
  els.heatmap.addEventListener("pointermove", (event) => {
    if (!picker.isDragging) return;
    // Use elementFromPoint to handle moving over the cell gaps.
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const cell = target && target.closest && target.closest(".heatmap-cell");
    if (!cell || cell.classList.contains("is-empty")) return;
    if (cell.dataset.date && cell.dataset.date !== picker.dragCurrent) {
      picker.dragCurrent = cell.dataset.date;
      paintDragRange();
    }
  });
  const finishDrag = () => {
    if (!picker.isDragging) return;
    picker.isDragging = false;
    const a = picker.dragAnchor, b = picker.dragCurrent;
    if (!a || !b) return;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const dates = enumerateDates(lo, hi).filter((ds) => picker.byDate.has(ds));
    picker.focusDates = new Set(dates);
    // Drag-as-bulk-select: auto-add every session in the range to the
    // selection AND immediately commit. The old flow left the result in
    // a "draft" limbo until the user hit 确定 — which they often didn't,
    // so Generate kept falling back to today's session only.
    if (a !== b) {
      for (const ds of dates) {
        for (const s of (picker.byDate.get(ds) || [])) {
          picker.draft.add(s.sessionId);
        }
      }
    }
    commitDraft();
    renderDayDetail();
  };
  els.heatmap.addEventListener("pointerup", finishDrag);
  els.heatmap.addEventListener("pointercancel", finishDrag);
  els.heatmap.addEventListener("pointerleave", () => {
    if (picker.isDragging && picker.dragAnchor === picker.dragCurrent) {
      // Treat a leave-without-move as a single click — finalize on the anchor
      // so the detail panel still updates.
      finishDrag();
    }
  });
}

function renderDayDetail() {
  if (!els.dayDetail || !els.dayDetailList || !els.dayDetailTitle) return;
  if (picker.focusDates.size === 0) {
    els.dayDetail.setAttribute("hidden", "");
    return;
  }
  els.dayDetail.removeAttribute("hidden");
  const dates = Array.from(picker.focusDates).sort();
  els.dayDetailTitle.textContent = dates.length === 1
    ? `${dates[0]} · ${(picker.byDate.get(dates[0]) || []).length} session${((picker.byDate.get(dates[0]) || []).length) === 1 ? "" : "s"}`
    : `${dates[0]} → ${dates[dates.length - 1]} · ${dates.length} day${dates.length === 1 ? "" : "s"}`;


  // Flatten focus dates' sessions, newest first.
  const sessions = [];
  for (const ds of dates) {
    for (const s of (picker.byDate.get(ds) || [])) sessions.push(s);
  }
  sessions.sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));

  els.dayDetailList.replaceChildren();
  for (const item of sessions) {
    const row = document.createElement("label");
    row.className = "day-session";
    const checked = picker.draft.has(item.sessionId);
    if (checked) row.classList.add("is-checked");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = checked;
    cb.addEventListener("change", () => {
      if (cb.checked) picker.draft.add(item.sessionId);
      else picker.draft.delete(item.sessionId);
      row.classList.toggle("is-checked", cb.checked);
      updateSelectAllToggle();
      // Auto-commit so the selection actually reaches /cards/generate
      // even if the user never clicks 确定. Old flow left changes in
      // limbo and Generate fell back to today's session.
      commitDraft();
    });
    const text = document.createElement("div");
    text.className = "day-session-text";
    const cwd = document.createElement("div");
    cwd.className = "day-session-cwd";
    cwd.textContent = item.cwd
      ? item.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/")
      : item.sessionId;
    cwd.title = `${item.cwd || ""}\n${item.sessionId}${item.groupSize > 1 ? ` (${item.groupSize} forks)` : ""}`;
    const preview = document.createElement("div");
    preview.className = "day-session-preview";
    preview.textContent = item.preview || "(no preview)";
    text.append(cwd, preview);
    const time = document.createElement("span");
    time.className = "day-session-time";
    time.textContent = relativeTime(item.lastSeenAt);
    row.append(cb, text, time);

    if (state.settings.allowSessionDelete) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "day-session-delete";
      del.textContent = "🗑";
      del.title = "Move this session JSONL to ~/.claude-companion/trash/manual/";
      del.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!confirm(`Move session ${item.sessionId} to trash? (recoverable)`)) return;
        await deleteSessions([item.sessionId]);
        picker.draft.delete(item.sessionId);
        await fetchScanCandidates();
      });
      row.append(del);
    }
    els.dayDetailList.append(row);
  }
  updateSelectAllToggle();
  updatePickerCountMeta();
}

function updateSelectAllToggle() {
  if (!els.dayAllToggle) return;
  const sessions = [];
  for (const ds of picker.focusDates) {
    for (const s of (picker.byDate.get(ds) || [])) sessions.push(s);
  }
  if (sessions.length === 0) {
    els.dayAllToggle.checked = false;
    els.dayAllToggle.indeterminate = false;
    return;
  }
  const inDraft = sessions.filter((s) => picker.draft.has(s.sessionId)).length;
  els.dayAllToggle.indeterminate = inDraft > 0 && inDraft < sessions.length;
  els.dayAllToggle.checked = inDraft === sessions.length;
}

function updatePickerCountMeta() {
  if (!els.pickerCountMeta) return;
  const total = (picker.candidates || []).length;
  const inDraft = picker.draft.size;
  const committed = (state.settings.selectedSessionIds || []).length;
  const dirty = inDraft !== committed
    || Array.from(picker.draft).some((id) => !(state.settings.selectedSessionIds || []).includes(id));
  els.pickerCountMeta.textContent = dirty
    ? `draft ${inDraft} / ${total} · unsaved`
    : `${committed} / ${total} selected`;
}

function commitDraft() {
  state.settings.selectedSessionIds = Array.from(picker.draft);
  persistSettings();
  applyPickerSummaryToInputs();
  renderHeatmap();
  updatePickerCountMeta();
}

// Helper — short "5m ago" / "3h ago" / "2d ago" / "Apr 3" style.
function relativeTime(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const diffMs = Date.now() - t;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 14) return `${d}d`;
  const date = new Date(t);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

async function deleteSessions(ids) {
  try {
    const res = await fetchJson("/sessions/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionIds: ids })
    });
    return res;
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Picker toolbar wiring. No "Choose…" toggle anymore — the panel is part
// of the Generation scope expander itself, so it's visible whenever the
// user expands that section. We lazily fetch candidates on first paint.
async function ensurePickerCandidates() {
  if (picker.candidates) return;
  await fetchScanCandidates();
}

if (els.pickerAutoTopBtn) {
  els.pickerAutoTopBtn.addEventListener("click", async () => {
    await ensurePickerCandidates();
    // Pick the 3 most-recently-touched sessions and commit. This is the
    // common-case "I just want recent context" shortcut.
    const top = (picker.candidates || []).slice(0, 3);
    picker.draft = new Set(top.map((s) => s.sessionId));
    // Focus the days those sessions live on so the detail panel shows them.
    picker.focusDates = new Set(top.map((s) => localDateString(s.lastSeenAt)).filter(Boolean));
    commitDraft();
    renderDayDetail();
  });
}
if (els.pickerAllBtn) {
  els.pickerAllBtn.addEventListener("click", async () => {
    await ensurePickerCandidates();
    const items = picker.candidates || [];
    picker.draft = new Set(items.map((s) => s.sessionId));
    commitDraft();
    renderDayDetail();
  });
}
if (els.pickerNoneBtn) {
  els.pickerNoneBtn.addEventListener("click", () => {
    // Empty selection → daemon falls back to "scan today's window only".
    picker.draft = new Set();
    picker.focusDates = new Set();
    commitDraft();
    renderDayDetail();
  });
}
if (els.pickerRefreshBtn) {
  els.pickerRefreshBtn.addEventListener("click", () => {
    fetchScanCandidates();
  });
}
if (els.dayAllToggle) {
  els.dayAllToggle.addEventListener("change", () => {
    const want = els.dayAllToggle.checked;
    for (const ds of picker.focusDates) {
      for (const s of (picker.byDate.get(ds) || [])) {
        if (want) picker.draft.add(s.sessionId);
        else picker.draft.delete(s.sessionId);
      }
    }
    commitDraft();
    renderDayDetail();
  });
}
// 确定 button is now mostly a no-op (changes already committed live)
// but kept as an explicit "yes I'm done picking" affordance. Earlier
// version only flashed the meta-line color which the user reported
// as too subtle — now the button itself becomes a sage "✓ 已保存"
// pill for 1.4 s. Hard to miss.
if (els.pickerConfirmBtn) {
  const btn = els.pickerConfirmBtn;
  const originalLabel = btn.textContent;
  let revertTimer = null;
  btn.addEventListener("click", () => {
    commitDraft();
    if (revertTimer) clearTimeout(revertTimer);
    btn.classList.add("is-saved-flash");
    btn.textContent = state.locale === "zh" ? "✓ 已保存" : "✓ Saved";
    if (els.pickerCountMeta) {
      els.pickerCountMeta.classList.add("is-flash-saved");
    }
    revertTimer = setTimeout(() => {
      btn.classList.remove("is-saved-flash");
      btn.textContent = originalLabel;
      if (els.pickerCountMeta) {
        els.pickerCountMeta.classList.remove("is-flash-saved");
      }
      revertTimer = null;
    }, 1400);
  });
}

bindHeatmapPointer();

// Export buttons — fetch the .md from /cards/export and trigger a save
// dialog via a transient blob URL. The daemon serves with
// `content-disposition: attachment` so a normal browser would prompt to
// save; Electron's webContents.session honors it the same way.
async function downloadCardsExport(scope, { date, archive } = {}) {
  const params = new URLSearchParams({ scope });
  if (date) params.set("date", date);
  if (archive) params.set("archive", archive);
  const url = `${DAEMON_ORIGIN}/cards/export?${params.toString()}`;
  let response;
  try {
    response = await fetch(url, { cache: "no-store" });
  } catch (error) {
    console.error("[cards] export fetch failed:", error);
    return;
  }
  if (!response.ok) {
    console.error(`[cards] export ${scope} returned ${response.status}`);
    return;
  }
  const text = await response.text();
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = (match && match[1]) || `companion-${scope}.md`;

  const blob = new Blob([text], { type: "text/markdown" });
  const blobUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 500);
}

if (els.exportTodayButton) {
  els.exportTodayButton.addEventListener("click", () => downloadCardsExport("today"));
}
if (els.exportHistoryButton) {
  els.exportHistoryButton.addEventListener("click", () => downloadCardsExport("history"));
}
if (els.exportWrongBookButton) {
  els.exportWrongBookButton.addEventListener("click", () => downloadCardsExport("wrong-book"));
}

// Sessions expander — fetch fresh on every open so an inactive expander
// doesn't show stale data. The /sessions endpoint is cheap.
if (els.sessionsExpander) {
  els.sessionsExpander.addEventListener("toggle", () => {
    if (els.sessionsExpander.open) {
      refresh().then(renderSessionsList);
    }
  });
}

// (Generate-from pills + backfill date input were dropped — heatmap is
// now the sole scope control. state.settings.generateWindow stays at 1
// internally; backfill date is set/cleared via the day-detail checkbox.)

// Pre-fetch picker candidates ~600 ms after app boot so the heatmap
// is primed by the time the user opens settings — no click required.
// Cheap one-time disk scan; renderHeatmap is a no-op until DOM exists.
setTimeout(() => {
  if (!picker.candidates) fetchScanCandidates();
}, 600);


if (els.cardsStartReview) {
  els.cardsStartReview.addEventListener("click", startReviewSession);
}
if (els.wrongFullReviewButton) {
  els.wrongFullReviewButton.addEventListener("click", startWrongBookFullReview);
}
if (els.reviewBack) {
  els.reviewBack.addEventListener("click", () => endReviewSession({ completed: false }));
}
if (els.reviewSkip) {
  els.reviewSkip.addEventListener("click", skipCurrentReview);
}
if (els.reviewSubmit) {
  els.reviewSubmit.addEventListener("click", () => {
    const review = state.cards.review;
    if (review && review.feedback) {
      advanceReview();
    } else {
      submitReviewAnswer();
    }
  });
}
if (els.reviewClozeInput) {
  els.reviewClozeInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      const review = state.cards.review;
      if (review && review.feedback) advanceReview();
      else submitReviewAnswer();
    }
  });
}
if (els.completionDone) {
  els.completionDone.addEventListener("click", () => {
    if (els.completionScreen) els.completionScreen.hidden = true;
    // Route back to whichever tab spawned the session.
    const src = state.cards.lastReviewSource;
    state.cards.activeTab = src === "wrong" ? "wrong"
      : src === "history" ? "history"
      : "today";
    state.cards.lastReviewSource = null;
    // History review may have added wrong-book entries; force re-fetch so
    // the badges + lists are up to date next time the user looks.
    if (src === "history") {
      state.cards.history = null;
      state.cards.historyDetail = {};
      state.cards.expandedHistory = null;
    }
    renderCards();
  });
}

// Hydrate persisted settings before any render so the inputs paint with
// the user's saved focus / difficulty / toggles instead of flashing the
// defaults. Synchronous localStorage read — no async race here.
loadSettingsFromStorage();
applySettingsToInputs();

// Prime the cards button on first load (no-op if daemon hasn't responded yet).
fetchCardsToday().then(updateCardsButton);

// Auto-generate scheduler — checks every 30 s whether now ≥ user's
// picked time AND today hasn't been generated yet. Initial 1.5 s delay
// lets the daemon WS settle + the consent modal (if first run) land
// cleanly without fighting the bubble's morph animation.
setTimeout(() => {
  maybeAutoGenerate().catch(() => {});
  startAutoGenTickLoop();
}, 1500);

// Wire the time-wheel picker — Apple-clock-style two-drum scroll.
bindAutoGenerateTimePicker();

// Debug handle: expose state on window so DevTools console can poke at
// `appState.cards.today`, etc. Read-only contract — don't mutate from
// devtools or the renderer's internal invariants get out of sync.
window.appState = state;

connectSocket();
refresh();
setInterval(() => {
  if (!state.connected) {
    refresh();
  }
}, 1800);
