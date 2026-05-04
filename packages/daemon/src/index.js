#!/usr/bin/env node

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PROTOCOL_VERSION,
  claudePermissionRequestDecision,
  claudePreToolUseDecision,
  createId,
  jsonResponse,
  normalizeDecision,
  nowIso,
  readJsonBody
} = require("../../shared/protocol");
const { assessToolRisk, summarizeToolInput } = require("../../shared/risk");
const { acceptWebSocket } = require("./websocket");
const { DeviceStore, PairingManager } = require("./devices");
const { CardsStore } = require("./cards-store");
const { TranscriptIndex } = require("./transcript-index");
const { readTranscript } = require("./transcript-reader");
const { scanAllProjects, snapshotJsonlPaths } = require("./transcript-scanner");
const { SessionTrash } = require("./session-trash");
const { todayLocalDate } = require("../../shared/cards");
const { generateCards } = require("./cards-generator");
const {
  composeDayMarkdown,
  composeAllAbstractsMarkdown,
  composeWrongBookMarkdown
} = require("./cards-markdown");
const { ConsentStore, CONSENT_VERSION } = require("./cards-consent");
const { StorageConfig } = require("./cards-storage-config");
const { CardsStreak } = require("./cards-streak");

const PORT = Number(process.env.CCC_PORT || 4317);
const HOST = process.env.CCC_HOST || "127.0.0.1";
const REQUEST_TIMEOUT_MS = Number(process.env.CCC_APPROVAL_TIMEOUT_MS || 55_000);
const DATA_DIR = process.env.CCC_DATA_DIR || path.join(process.cwd(), ".claude-companion");
const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;
const EXTENDED_CONTEXT_WINDOW_TOKENS = 1_000_000;
const CONTEXT_WINDOW_OVERRIDE_TOKENS = Number(process.env.CCC_CONTEXT_WINDOW_TOKENS || 0);
const MODEL_CONTEXT_WINDOW_OVERRIDES = parseModelContextWindowOverrides(process.env.CCC_MODEL_CONTEXT_WINDOWS);
// Claude Code auto-upgrades Opus 4.6/4.7 and Sonnet 4.6 to a 1M window on
// Max/Team/Enterprise plans unless CLAUDE_CODE_DISABLE_1M_CONTEXT=1 is set.
// The transcript itself only records the bare model id (e.g. "claude-opus-4-7"),
// so we mirror Claude Code's own gating here instead of waiting for a [1m] tag.
const CLAUDE_DISABLE_1M = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === "1" ||
  process.env.CCC_DISABLE_1M_CONTEXT === "true";
const ONE_M_MODEL_PATTERNS = [
  /claude[-_ ]?opus[-_ ]?4[-_ ]?6/,
  /claude[-_ ]?opus[-_ ]?4[-_ ]?7/,
  /claude[-_ ]?sonnet[-_ ]?4[-_ ]?6/
];

// Per-user store of windows we've learned by direct observation. Keyed by
// model family ("opus-4-7"), so a fresh build like claude-opus-4-7-20251115
// inherits the same window without re-learning.
const LEARNED_CONTEXT_FILE = path.join(os.homedir(), ".claude-companion", "learned-context.json");
// Compact heuristic: a usage drop counts only if the prior peak was substantial.
// 50k filters out start-of-session jitter and short tool round-trips.
const COMPACT_PEAK_THRESHOLD = 50_000;
const COMPACT_DROP_RATIO = 0.3;
// Fixed buckets we snap a learned window into; new buckets get added as
// Anthropic ships them. Keep ascending.
const KNOWN_WINDOW_BUCKETS = [DEFAULT_CONTEXT_WINDOW_TOKENS, EXTENDED_CONTEXT_WINDOW_TOKENS];

const pendingRequests = new Map();
const sessionStates = new Map();
const auditEvents = [];
const wsClients = new Set();
const deviceStore = new DeviceStore({ dataDir: DATA_DIR });
const pairingManager = new PairingManager();
// Resolve where cards live: default <DATA_DIR>/cards, but the user can
// relocate via Settings → Storage. The override file lives at
// <DATA_DIR>/cards-storage-config.json (NOT inside the cards dir, so
// changing the cards dir doesn't orphan the config that defined it).
const cardsStorageConfig = new StorageConfig({
  daemonDataDir: DATA_DIR,
  defaultCardsDir: path.join(DATA_DIR, "cards")
});
const resolvedCardsDir = cardsStorageConfig.resolvedCardsDir().cardsDir;
const cardsStore = new CardsStore({ dataDir: DATA_DIR, cardsDir: resolvedCardsDir });
const transcriptIndex = new TranscriptIndex({ dataDir: DATA_DIR });
const consentStore = new ConsentStore({ dataDir: DATA_DIR });
const sessionTrash = new SessionTrash({ dataDir: DATA_DIR });
const cardsStreak = new CardsStreak({ cardsStore });
// Tracked across a generation run so the bubble can show live progress
// (which sessions got scanned, included, skipped) and so the persisted
// generationRecord on the deck has the same data after the run ends.
let cardsGenerationStatus = {
  state: "idle",       // idle | generating | error
  startedAt: null,
  finishedAt: null,
  message: null,
  stage: null,         // scanning | reading | calling | parsing | done
  scanned: []          // [{sessionId, cwd, status, chars, source}]
};
let stateSequence = 0;

function htmlResponse(res, html) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store"
  });
  res.end(html);
}

function audit(event) {
  const item = {
    eventId: createId("evt"),
    createdAt: nowIso(),
    ...event
  };
  auditEvents.push(item);
  if (auditEvents.length > 500) {
    auditEvents.shift();
  }
  return item;
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isLoopbackRequest(req) {
  return isLoopbackAddress(req.socket.remoteAddress);
}

function bearerToken(req, url) {
  const authorization = String(req.headers.authorization || "");
  if (authorization.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }
  return url.searchParams.get("token");
}

function authenticatedDevice(req, url) {
  return deviceStore.authenticate(bearerToken(req, url), nowIso());
}

function requireLocalRequest(req, res) {
  if (isLoopbackRequest(req)) {
    return true;
  }

  jsonResponse(res, 403, {
    error: "This endpoint is only available from the local machine."
  });
  return false;
}

function requireAuthorizedRequest(req, res, url) {
  const token = bearerToken(req, url);
  if (token) {
    const device = deviceStore.authenticate(token, nowIso());
    if (device) {
      return device;
    }
  }

  if (isLoopbackRequest(req)) {
    return {
      deviceId: "local",
      deviceName: "Local browser"
    };
  }

  jsonResponse(res, 401, {
    error: "Missing or invalid device token."
  });
  return null;
}

function unauthorizedUpgrade(socket) {
  const body = "Missing or invalid token.";
  socket.write(
    [
      "HTTP/1.1 401 Unauthorized",
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${Buffer.byteLength(body)}`,
      "",
      body
    ].join("\r\n")
  );
  socket.destroy();
}

function pendingRequestList() {
  return Array.from(pendingRequests.values()).map((entry) => entry.request);
}

function sessionStateList() {
  return Array.from(sessionStates.values()).sort((a, b) => {
    return String(b.updatedAt).localeCompare(String(a.updatedAt));
  });
}

function isAskUserQuestionRequest(request) {
  return request && request.tool === "AskUserQuestion";
}

function questionList(toolInput) {
  return toolInput && Array.isArray(toolInput.questions) ? toolInput.questions : [];
}

function questionKey(question, index) {
  return String((question && question.question) || `Question ${index + 1}`);
}

function normalizeQuestionAnswers(questions, rawAnswers) {
  if (!rawAnswers || typeof rawAnswers !== "object" || Array.isArray(rawAnswers)) {
    return {
      answers: {},
      missing: questions.map((question, index) => questionKey(question, index))
    };
  }

  const normalized = {};
  const missing = [];

  if (!questions.length) {
    for (const [key, value] of Object.entries(rawAnswers)) {
      const answer = Array.isArray(value) ? value.join(", ") : String(value || "").trim();
      if (key && answer) {
        normalized[key] = answer;
      }
    }
    return {
      answers: normalized,
      missing: Object.keys(normalized).length ? [] : ["Answer"]
    };
  }

  questions.forEach((question, index) => {
    const key = questionKey(question, index);
    const value = rawAnswers[key];
    const answer = Array.isArray(value) ? value.join(", ") : String(value || "").trim();
    if (!answer) {
      missing.push(key);
      return;
    }
    normalized[key] = answer;
  });

  return { answers: normalized, missing };
}

function normalizeIncomingDecision(rawDecision) {
  if (rawDecision === "always_allow") {
    return "always_allow";
  }
  return normalizeDecision(rawDecision);
}

function truncateText(value, maxLength = 220) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength - 1) + "...";
}

function compactTokenCount(value) {
  const count = Number(value || 0);
  if (!Number.isFinite(count) || count <= 0) {
    return "0";
  }
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}m`;
  }
  if (count >= 1_000) {
    return `${Math.round(count / 100) / 10}k`;
  }
  return String(Math.round(count));
}

function numberFromAny(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return number;
    }
  }
  return 0;
}

function parseModelContextWindowOverrides(raw) {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }

    return Object.entries(parsed)
      .map(([pattern, tokens]) => ({
        pattern: String(pattern || "").trim().toLowerCase(),
        tokens: Number(tokens)
      }))
      .filter((item) => item.pattern && Number.isFinite(item.tokens) && item.tokens > 0);
  } catch (error) {
    console.warn(`[warn] Ignoring invalid CCC_MODEL_CONTEXT_WINDOWS: ${error.message}`);
    return [];
  }
}

function modelFamilyFromText(text) {
  if (text.includes("opus")) {
    return "opus";
  }
  if (text.includes("sonnet")) {
    return "sonnet";
  }
  if (text.includes("haiku")) {
    return "haiku";
  }
  return "unknown";
}

// Family-versioned key — "claude-opus-4-7" / "claude-opus-4-7-20251115" both
// collapse to "opus-4-7", so a learned window survives minor build bumps.
function modelFamilyKey(model) {
  if (!model) {
    return null;
  }
  const text = String(model).toLowerCase();
  const match = text.match(/(opus|sonnet|haiku)[-_ ]?(\d+)[-_ ]?(\d+)/);
  if (!match) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function snapToKnownBucket(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  let best = KNOWN_WINDOW_BUCKETS[0];
  let bestDistance = Math.abs(value - best);
  for (const bucket of KNOWN_WINDOW_BUCKETS) {
    const distance = Math.abs(value - bucket);
    if (distance < bestDistance) {
      best = bucket;
      bestDistance = distance;
    }
  }
  return best;
}

function loadLearnedContext() {
  try {
    const raw = fs.readFileSync(LEARNED_CONTEXT_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.models && typeof parsed.models === "object") {
      return parsed;
    }
  } catch (_error) {
    // Missing file or unparseable JSON: start fresh.
  }
  return { version: 1, models: {} };
}

let learnedContext = loadLearnedContext();
let learnedContextWriteTimer = null;

function saveLearnedContextSoon() {
  if (learnedContextWriteTimer) {
    return;
  }
  learnedContextWriteTimer = setTimeout(() => {
    learnedContextWriteTimer = null;
    try {
      const dir = path.dirname(LEARNED_CONTEXT_FILE);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${LEARNED_CONTEXT_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(learnedContext, null, 2), "utf8");
      fs.renameSync(tmp, LEARNED_CONTEXT_FILE);
    } catch (error) {
      console.warn(`[warn] Failed to persist learned-context.json: ${error.message}`);
    }
  }, 500);
}

function getLearnedWindow(model) {
  const key = modelFamilyKey(model);
  if (!key) {
    return null;
  }
  const entry = learnedContext.models[key];
  if (!entry || !Number.isFinite(entry.window) || entry.window <= 0) {
    return null;
  }
  return { window: entry.window, key };
}

function recordLearnedWindow(model, window, peakSeen, reason) {
  const key = modelFamilyKey(model);
  if (!key || !Number.isFinite(window) || window <= 0) {
    return;
  }
  const previous = learnedContext.models[key];
  // Never demote — a previously-confirmed 1M wins over a later weaker signal.
  if (previous && previous.window >= window) {
    if (Number.isFinite(peakSeen) && peakSeen > 0 && (!previous.peakSeen || peakSeen > previous.peakSeen)) {
      previous.peakSeen = peakSeen;
      saveLearnedContextSoon();
    }
    return;
  }
  learnedContext.models[key] = {
    window,
    peakSeen: Number.isFinite(peakSeen) && peakSeen > 0 ? peakSeen : null,
    confirmedAt: nowIso(),
    confirmedBy: reason
  };
  saveLearnedContextSoon();
}

function modelOverrideFromEnv(modelText) {
  const exact = MODEL_CONTEXT_WINDOW_OVERRIDES.find((item) => modelText === item.pattern);
  if (exact) {
    return exact;
  }
  return MODEL_CONTEXT_WINDOW_OVERRIDES.find((item) => modelText.includes(item.pattern)) || null;
}

function contextWindowRecord(maxTokens, source, model, rule) {
  return {
    maxTokens,
    source,
    rule,
    model: model ? String(model) : null,
    modelFamily: model ? modelFamilyFromText(String(model).toLowerCase()) : "unknown"
  };
}

function contextWindowFromModel(model) {
  if (!model) {
    return contextWindowRecord(DEFAULT_CONTEXT_WINDOW_TOKENS, "default", null, "missing-model");
  }

  const text = String(model).toLowerCase();
  const override = modelOverrideFromEnv(text);
  if (override) {
    return contextWindowRecord(override.tokens, "model-override", model, override.pattern);
  }

  // Learned per-family from observed transcripts. Wins over [1m] / family
  // defaults because it reflects what we've actually seen this model do.
  const learned = getLearnedWindow(model);
  if (learned) {
    return contextWindowRecord(learned.window, "learned", model, learned.key);
  }

  // Claude Code's model aliases sometimes carry an explicit [1m] marker.
  if (text.includes("[1m]") || /(^|[^a-z0-9])1m([^a-z0-9]|$)/.test(text)) {
    return contextWindowRecord(EXTENDED_CONTEXT_WINDOW_TOKENS, "model-id", model, "1m");
  }

  // Opus 4.6/4.7 and Sonnet 4.6 default to 1M on Claude Code unless the
  // CLAUDE_CODE_DISABLE_1M_CONTEXT escape hatch is set.
  if (!CLAUDE_DISABLE_1M && ONE_M_MODEL_PATTERNS.some((pattern) => pattern.test(text))) {
    return contextWindowRecord(EXTENDED_CONTEXT_WINDOW_TOKENS, "claude-code-default", model, "1m-default");
  }

  if (text.includes("claude") || ["opus", "sonnet", "haiku"].some((name) => text.includes(name))) {
    return contextWindowRecord(DEFAULT_CONTEXT_WINDOW_TOKENS, "model-default", model, modelFamilyFromText(text));
  }

  return contextWindowRecord(DEFAULT_CONTEXT_WINDOW_TOKENS, "default", model, "fallback");
}

function contextWindowFromUsage(usage, model) {
  const explicit = numberFromAny(
    usage.context_window_tokens,
    usage.contextWindowTokens,
    usage.context_window,
    usage.contextWindow,
    usage.max_context_tokens,
    usage.maxContextTokens
  );

  if (explicit) {
    return contextWindowRecord(explicit, "usage", model, "usage-field");
  }

  if (CONTEXT_WINDOW_OVERRIDE_TOKENS) {
    return contextWindowRecord(CONTEXT_WINDOW_OVERRIDE_TOKENS, "env", model, "CCC_CONTEXT_WINDOW_TOKENS");
  }

  return contextWindowFromModel(model);
}

function contextUsageFromUsage(usage, model) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return null;
  }

  const inputTokens = numberFromAny(usage.input_tokens, usage.inputTokens);
  const cacheReadTokens = numberFromAny(usage.cache_read_input_tokens, usage.cacheReadInputTokens);
  const cacheCreationTokens = numberFromAny(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens);
  const outputTokens = numberFromAny(usage.output_tokens, usage.outputTokens);
  const usedTokens = inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens;
  let contextWindow = contextWindowFromUsage(usage, model);

  // If observed usage already exceeds the resolved window, the model must
  // have a larger window than we guessed. Promote to 1M rather than show >100%.
  if (usedTokens > contextWindow.maxTokens && contextWindow.maxTokens < EXTENDED_CONTEXT_WINDOW_TOKENS) {
    contextWindow = contextWindowRecord(EXTENDED_CONTEXT_WINDOW_TOKENS, "observed-overrun", model, "exceeded-200k");
  }

  const maxTokens = contextWindow.maxTokens;

  if (!usedTokens || !maxTokens) {
    return null;
  }

  const percent = Math.max(0, Math.min(100, Math.round((usedTokens / maxTokens) * 100)));
  return {
    usedTokens,
    maxTokens,
    percent,
    label: `${compactTokenCount(usedTokens)} / ${compactTokenCount(maxTokens)}`,
    model: model ? String(model) : null,
    modelFamily: contextWindow.modelFamily,
    windowSource: contextWindow.source,
    windowRule: contextWindow.rule,
    source: "transcript"
  };
}

function claudeProjectSlug(cwd) {
  const text = String(cwd || "").replace(/\\/g, "/").replace(/^([A-Za-z]):/, "$1-");
  return text.replace(/\/+/g, "-").replace(/^-+/, "");
}

function transcriptCandidates(transcriptPath, sessionId, cwd) {
  const candidates = [];
  if (transcriptPath) {
    candidates.push(transcriptPath);
  }

  const slug = claudeProjectSlug(cwd);
  if (slug && sessionId && sessionId !== "unknown") {
    candidates.push(path.join(os.homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`));
  }

  return [...new Set(candidates.filter(Boolean))];
}

function latestContextUsageFromTranscript(transcriptPath, sessionId, cwd) {
  for (const candidate of transcriptCandidates(transcriptPath, sessionId, cwd)) {
    const contextUsage = latestContextUsageFromTranscriptFile(candidate);
    if (contextUsage) {
      return contextUsage;
    }
  }
  return null;
}

function usedTokensFromUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return 0;
  }
  return numberFromAny(usage.input_tokens, usage.inputTokens) +
    numberFromAny(usage.cache_read_input_tokens, usage.cacheReadInputTokens) +
    numberFromAny(usage.cache_creation_input_tokens, usage.cacheCreationInputTokens) +
    numberFromAny(usage.output_tokens, usage.outputTokens);
}

// Scan a transcript file for the latest usage line plus any peak / compact
// signals visible in the suffix we read. Returning a single struct lets us
// fold both display data and learned-context updates into one I/O pass.
function scanTranscriptUsage(transcriptPath) {
  try {
    const stats = fs.statSync(transcriptPath);
    const readSize = Math.min(stats.size, 256 * 1024);
    const fd = fs.openSync(transcriptPath, "r");
    let lines;
    try {
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
      lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }

    let latestUsage = null;
    let latestModel = null;
    let peak = 0;
    let runningPeak = 0;
    let compactDetected = false;
    let peakBeforeCompact = 0;

    for (const line of lines) {
      let item;
      try {
        item = JSON.parse(line);
      } catch (_error) {
        continue;
      }
      const usage = item && item.message && item.message.usage;
      if (!usage) {
        continue;
      }
      const used = usedTokensFromUsage(usage);
      if (used <= 0) {
        continue;
      }

      // A sharp drop after a substantial peak is our compact signal — the
      // suffix may even straddle the compact boundary. Reset the running peak
      // afterwards so we don't re-trigger on the same drop.
      if (runningPeak >= COMPACT_PEAK_THRESHOLD && used < runningPeak * COMPACT_DROP_RATIO) {
        compactDetected = true;
        peakBeforeCompact = Math.max(peakBeforeCompact, runningPeak);
        runningPeak = used;
      } else if (used > runningPeak) {
        runningPeak = used;
      }
      if (used > peak) {
        peak = used;
      }

      latestUsage = usage;
      const model = item.message.model;
      if (model) {
        latestModel = model;
      }
    }

    return { latestUsage, latestModel, peak, compactDetected, peakBeforeCompact };
  } catch (_error) {
    return null;
  }
}

function latestContextUsageFromTranscriptFile(transcriptPath) {
  const scan = scanTranscriptUsage(transcriptPath);
  if (!scan) {
    return null;
  }

  // Promote learned window: peak-overrun is unambiguous (a 200k model can't
  // hold more than 200k); compact-detected snaps to the nearest known bucket.
  if (scan.latestModel) {
    if (scan.peak > DEFAULT_CONTEXT_WINDOW_TOKENS) {
      recordLearnedWindow(scan.latestModel, EXTENDED_CONTEXT_WINDOW_TOKENS, scan.peak, "peak-overrun");
    } else if (scan.compactDetected && scan.peakBeforeCompact >= COMPACT_PEAK_THRESHOLD) {
      const bucket = snapToKnownBucket(scan.peakBeforeCompact);
      if (bucket) {
        recordLearnedWindow(scan.latestModel, bucket, scan.peakBeforeCompact, "compact-observed");
      }
    }
  }

  if (!scan.latestUsage) {
    return null;
  }
  return contextUsageFromUsage(scan.latestUsage, scan.latestModel);
}

function sessionIdFromHookInput(hookInput) {
  return String((hookInput && hookInput.session_id) || "unknown");
}

function sessionSummaryFromHookInput(hookInput) {
  const eventName = String((hookInput && hookInput.hook_event_name) || "Unknown");
  const toolName = String((hookInput && hookInput.tool_name) || "");
  const toolInput = (hookInput && hookInput.tool_input) || {};

  if (eventName === "UserPromptSubmit") {
    return truncateText(hookInput.prompt || "User submitted a prompt");
  }

  if (toolName) {
    return summarizeToolInput(toolName, toolInput);
  }

  if (eventName === "Notification") {
    return truncateText(hookInput.message || hookInput.notification || "Claude Code notification");
  }

  if (eventName === "Stop") {
    return "Claude finished the current turn";
  }

  if (eventName === "SessionEnd") {
    return "Claude Code session ended";
  }

  return eventName;
}

function statusForHookInput(hookInput) {
  const eventName = String((hookInput && hookInput.hook_event_name) || "");
  const toolName = String((hookInput && hookInput.tool_name) || "");
  const message = String((hookInput && (hookInput.message || hookInput.notification)) || "").toLowerCase();

  if (eventName === "UserPromptSubmit") {
    return "thinking";
  }
  if (eventName === "PreToolUse") {
    return toolName === "AskUserQuestion" ? "waiting_answer" : "running_tool";
  }
  if (eventName === "PostToolUse") {
    return "thinking";
  }
  if (eventName === "PostToolUseFailure") {
    return "failed";
  }
  if (eventName === "PermissionRequest") {
    return "waiting_approval";
  }
  if (eventName === "Notification") {
    if (message.includes("permission")) {
      return "waiting_approval";
    }
    if (message.includes("input") || message.includes("waiting")) {
      return "waiting";
    }
    return "thinking";
  }
  if (eventName === "Stop") {
    return "done";
  }
  if (eventName === "SessionEnd") {
    return "idle";
  }
  return "thinking";
}

function updateSessionStateFromHook(hookInput, status, details = {}) {
  const sessionId = sessionIdFromHookInput(hookInput);
  const previous = sessionStates.get(sessionId);
  const now = nowIso();
  const toolName = String((hookInput && hookInput.tool_name) || details.tool || "");
  const transcriptPath = (hookInput && hookInput.transcript_path) || (previous && previous.transcriptPath) || null;
  const cwd = String((hookInput && hookInput.cwd) || (previous && previous.cwd) || process.cwd());
  // Persist sessionId → transcript_path mapping. The cards generator (Slice
  // 3B) reads from this index to feed real Claude Code transcripts into
  // the prompt instead of just lifecycle summaries.
  if (sessionId && transcriptPath) {
    transcriptIndex.record(sessionId, transcriptPath, { cwd });
  }
  const contextUsage = latestContextUsageFromTranscript(transcriptPath, sessionId, cwd) ||
    details.contextUsage ||
    (previous && previous.contextUsage) ||
    null;
  const next = {
    protocolVersion: PROTOCOL_VERSION,
    type: "session_state",
    sessionId,
    status,
    cwd,
    transcriptPath,
    permissionMode: (hookInput && hookInput.permission_mode) || (previous && previous.permissionMode) || null,
    hookEventName: String((hookInput && hookInput.hook_event_name) || details.hookEventName || ""),
    tool: toolName || null,
    summary: details.summary || sessionSummaryFromHookInput(hookInput),
    requestId: details.requestId || null,
    risk: details.risk || null,
    reason: details.reason || null,
    decision: details.decision || null,
    contextUsage,
    sequence: ++stateSequence,
    createdAt: (previous && previous.createdAt) || now,
    updatedAt: now
  };

  sessionStates.set(sessionId, next);
  audit({
    type: "session_state",
    sessionId,
    status,
    hookEventName: next.hookEventName,
    tool: next.tool,
    summary: next.summary,
    requestId: next.requestId,
    decision: next.decision
  });
  broadcastSessionStates();
  return next;
}

function updateSessionStateFromRequest(request, status, details = {}) {
  return updateSessionStateFromHook(
    {
      session_id: request.sessionId,
      transcript_path: request.transcriptPath,
      cwd: request.cwd,
      permission_mode: request.permissionMode,
      hook_event_name: request.hookEventName,
      tool_name: request.tool,
      tool_input: request.toolInput
    },
    status,
    {
      requestId: request.requestId,
      summary: request.summary,
      risk: request.risk,
      reason: request.reason,
      ...details
    }
  );
}

function statusAfterDecision(request, decision) {
  if (decision === "deny" || decision === "block") {
    return "blocked";
  }
  if (decision === "ask") {
    return isAskUserQuestionRequest(request) ? "waiting_answer" : "waiting_approval";
  }
  if (decision === "answer") {
    return "thinking";
  }
  return isAskUserQuestionRequest(request) ? "thinking" : "running_tool";
}

function makeEvent(type, payload = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    type,
    eventId: createId("evt"),
    createdAt: nowIso(),
    ...payload
  };
}

function sendWsEvent(client, type, payload) {
  client.sendJson(makeEvent(type, payload));
}

function broadcastWsEvent(type, payload) {
  const event = makeEvent(type, payload);
  for (const client of wsClients) {
    client.sendJson(event);
  }
}

function broadcastPendingRequests() {
  broadcastWsEvent("pending_requests_snapshot", {
    requests: pendingRequestList()
  });
}

function broadcastSessionStates() {
  broadcastWsEvent("session_states_snapshot", {
    sessions: sessionStateList()
  });
}

// The legacy browser dashboard at http://127.0.0.1:4317/ has been replaced by
// the desktop bubble's dashboard mode. This page is only ever seen when
// somebody hits the daemon URL in a browser by mistake — keep it tiny and
// direct so they know where to go instead.
function daemonRootNoticeHtml() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claude Code Companion</title>
  <style>
    body {
      margin: 0;
      display: grid;
      place-items: center;
      min-height: 100vh;
      background: #111315;
      color: #f4f4f5;
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    main { max-width: 32rem; padding: 32px; text-align: center; }
    h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; letter-spacing: 0.005em; }
    p { margin: 6px 0; color: #9ca3af; font-size: 14px; line-height: 1.55; }
    code {
      padding: 1px 6px; border-radius: 4px;
      background: #191d21; color: #e5e7eb;
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12.5px;
    }
  </style>
</head>
<body>
  <main>
    <h1>Claude Code Companion</h1>
    <p>The browser dashboard has been replaced by the desktop bubble.</p>
    <p>Run <code>npm run desktop</code> from the repo root to launch it. Approvals, sessions, devices, pairing tokens, and audit events all live inside the bubble's dashboard mode now (gear icon in the controls strip).</p>
  </main>
</body>
</html>`;
}

function localAddresses() {
  const result = [];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const entry of interfaces || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        result.push(entry.address);
      }
    }
  }
  return result;
}

function makePermissionRequest(hookInput, approvalKind) {
  const requestId = createId("req");
  const toolName = String(hookInput.tool_name || "Unknown");
  const toolInput = hookInput.tool_input || {};
  const risk = assessToolRisk(toolName, toolInput);
  const effectiveApprovalKind = toolName === "AskUserQuestion" ? "ask_user_question" : approvalKind;
  const transcriptPath = hookInput.transcript_path || null;
  const sessionId = String(hookInput.session_id || "unknown");
  const cwd = String(hookInput.cwd || process.cwd());

  return {
    protocolVersion: PROTOCOL_VERSION,
    type: "permission_request",
    approvalKind: effectiveApprovalKind,
    hookEventName: hookInput.hook_event_name || (effectiveApprovalKind === "permission_request" ? "PermissionRequest" : "PreToolUse"),
    requestId,
    sessionId,
    transcriptPath,
    cwd,
    permissionMode: hookInput.permission_mode || null,
    tool: toolName,
    toolInput,
    questions: questionList(toolInput),
    summary: summarizeToolInput(toolName, toolInput),
    risk: risk.level,
    reason: risk.reason,
    permissionSuggestions: Array.isArray(hookInput.permission_suggestions) ? hookInput.permission_suggestions : [],
    contextUsage: latestContextUsageFromTranscript(transcriptPath, sessionId, cwd),
    createdAt: nowIso(),
    timeoutMs: REQUEST_TIMEOUT_MS
  };
}

function waitForDecision(request) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (!pendingRequests.has(request.requestId)) {
        return;
      }
      pendingRequests.delete(request.requestId);
      updateSessionStateFromRequest(request, "blocked", {
        decision: "deny",
        reason: "Timed out waiting for approval"
      });
      audit({
        type: "permission_decision",
        requestId: request.requestId,
        decision: "deny",
        reason: "Timed out waiting for approval"
      });
      broadcastWsEvent("permission_decision", {
        requestId: request.requestId,
        decision: "deny",
        reason: "Timed out waiting for approval"
      });
      broadcastPendingRequests();
      resolve({
        decision: "deny",
        reason: "Timed out waiting for Claude Code Companion approval."
      });
    }, REQUEST_TIMEOUT_MS);

    pendingRequests.set(request.requestId, {
      request,
      resolve: (decision) => {
        clearTimeout(timeout);
        resolve(decision);
      }
    });
    updateSessionStateFromRequest(request, isAskUserQuestionRequest(request) ? "waiting_answer" : "waiting_approval");
    broadcastWsEvent("permission_request", { request });
    broadcastPendingRequests();
  });
}

async function handlePreToolUse(req, res) {
  if (!requireLocalRequest(req, res)) {
    return;
  }

  const hookInput = await readJsonBody(req);
  const request = makePermissionRequest(hookInput, "pre_tool_use");

  audit({
    type: "permission_request",
    requestId: request.requestId,
    sessionId: request.sessionId,
    tool: request.tool,
    summary: request.summary,
    risk: request.risk,
    reason: request.reason
  });

  console.log(`[pending] ${request.requestId} ${request.risk.toUpperCase()} ${request.tool}: ${request.summary}`);
  if (isAskUserQuestionRequest(request)) {
    console.log(`          answer:  node scripts/decide.js answer ${request.requestId} '{"Question":"Answer"}'`);
  } else {
    console.log(`          approve: node scripts/decide.js approve ${request.requestId}`);
  }
  console.log(`          deny:    node scripts/decide.js deny ${request.requestId}`);

  const decision = await waitForDecision(request);
  if (isAskUserQuestionRequest(request)) {
    const rawDecision = String(decision.decision || "");
    const normalizedDecision = normalizeDecision(rawDecision) || "deny";
    const reason = decision.reason || "Decision from Claude Code Companion";

    if (rawDecision === "answer" || normalizedDecision === "allow") {
      const normalized = normalizeQuestionAnswers(request.questions, decision.answers);
      if (normalized.missing.length) {
        jsonResponse(
          res,
          200,
          claudePreToolUseDecision(
            "deny",
            `AskUserQuestion requires answers for: ${normalized.missing.join(", ")}`
          )
        );
        return;
      }

      jsonResponse(
        res,
        200,
        claudePreToolUseDecision("allow", reason, {
          updatedInput: {
            ...request.toolInput,
            questions: request.questions,
            answers: normalized.answers
          }
        })
      );
      return;
    }

    jsonResponse(res, 200, claudePreToolUseDecision(normalizedDecision, reason));
    return;
  }

  let permissionDecision = normalizeDecision(decision.decision) || "deny";
  if (permissionDecision === "answer") {
    permissionDecision = "deny";
  }
  const reason = decision.reason || `Decision from Claude Code Companion: ${permissionDecision}`;

  jsonResponse(res, 200, claudePreToolUseDecision(permissionDecision, reason));
}

async function handlePermissionRequestHook(req, res) {
  if (!requireLocalRequest(req, res)) {
    return;
  }

  const hookInput = await readJsonBody(req);
  const request = makePermissionRequest(hookInput, "permission_request");

  audit({
    type: "permission_request",
    requestId: request.requestId,
    sessionId: request.sessionId,
    hookEventName: "PermissionRequest",
    tool: request.tool,
    summary: request.summary,
    risk: request.risk,
    reason: request.reason
  });

  console.log(`[native] ${request.requestId} ${request.risk.toUpperCase()} ${request.tool}: ${request.summary}`);
  console.log(`         approve: node scripts/decide.js approve ${request.requestId}`);
  console.log(`         deny:    node scripts/decide.js deny ${request.requestId}`);

  const approval = await waitForDecision(request);
  jsonResponse(res, 200, claudePermissionRequestDecision(permissionRequestDecision(request, approval)));
}

async function handleHookEvent(req, res) {
  if (!requireLocalRequest(req, res)) {
    return;
  }

  const hookInput = await readJsonBody(req);
  const status = statusForHookInput(hookInput);
  const state = updateSessionStateFromHook(hookInput, status);

  jsonResponse(res, 200, {
    ok: true,
    state
  });
}

function permissionRequestDecision(request, approval) {
  const rawDecision = String(approval.decision || "");
  const reason = approval.reason || "Decision from Claude Code Companion";

  if (rawDecision === "allow" || rawDecision === "approve" || rawDecision === "always_allow") {
    const decision = {
      behavior: "allow"
    };

    if (rawDecision === "always_allow") {
      // Renderer ships the index of the suggestion the user picked from the
      // bubble; legacy CLI / web UI clients leave it undefined and we fall
      // back to the first allow-style suggestion.
      const idx = Number(approval.suggestionIndex);
      const suggestions = Array.isArray(request.permissionSuggestions) ? request.permissionSuggestions : [];
      const suggestion = Number.isInteger(idx) && idx >= 0 && idx < suggestions.length
        ? suggestions[idx]
        : suggestions.find((item) => item && item.behavior === "allow");
      if (suggestion) {
        decision.updatedPermissions = [suggestion];
      }
    }

    return decision;
  }

  return {
    behavior: "deny",
    message: reason
  };
}

async function handlePermissionDecision(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const device = requireAuthorizedRequest(req, res, url);
  if (!device) {
    return;
  }

  const body = await readJsonBody(req);
  const requestId = String(body.requestId || "");
  const rawDecision = String(body.decision || "");
  const decision = normalizeIncomingDecision(rawDecision);

  if (!requestId || !decision) {
    jsonResponse(res, 400, {
      error: "requestId and decision are required. decision must be approve/allow/deny/block/ask/answer/always_allow."
    });
    return;
  }

  const pending = pendingRequests.get(requestId);
  if (!pending) {
    jsonResponse(res, 404, { error: `No pending request found for ${requestId}` });
    return;
  }
  if (decision === "answer" && !isAskUserQuestionRequest(pending.request)) {
    jsonResponse(res, 400, { error: "answer decisions are only valid for AskUserQuestion requests." });
    return;
  }
  if (decision === "answer" && (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers))) {
    jsonResponse(res, 400, { error: "answer decisions require an answers object." });
    return;
  }

  pendingRequests.delete(requestId);
  const reason = String(body.reason || `User selected ${decision}`);
  updateSessionStateFromRequest(pending.request, statusAfterDecision(pending.request, decision), {
    decision,
    reason
  });
  audit({
    type: "permission_decision",
    requestId,
    decision,
    reason,
    answerKeys: decision === "answer" ? Object.keys(body.answers) : undefined,
    deviceId: device.deviceId,
    deviceName: device.deviceName
  });

  pending.resolve({ decision, reason, answers: body.answers, suggestionIndex: body.suggestionIndex });
  broadcastWsEvent("permission_decision", {
    requestId,
    decision,
    reason
  });
  broadcastPendingRequests();
  jsonResponse(res, 200, { ok: true, requestId, decision, reason });
}

function applyPermissionDecisionFromWebSocket(client, body) {
  const requestId = String(body.requestId || "");
  const rawDecision = String(body.decision || "");
  const decision = normalizeIncomingDecision(rawDecision);

  if (!requestId || !decision) {
    sendWsEvent(client, "error", {
      error: "requestId and decision are required. decision must be approve/allow/deny/block/ask/answer/always_allow."
    });
    return;
  }

  const pending = pendingRequests.get(requestId);
  if (!pending) {
    sendWsEvent(client, "error", {
      error: `No pending request found for ${requestId}`
    });
    return;
  }
  if (decision === "answer" && !isAskUserQuestionRequest(pending.request)) {
    sendWsEvent(client, "error", {
      error: "answer decisions are only valid for AskUserQuestion requests."
    });
    return;
  }
  if (decision === "answer" && (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers))) {
    sendWsEvent(client, "error", {
      error: "answer decisions require an answers object."
    });
    return;
  }

  pendingRequests.delete(requestId);
  const reason = String(body.reason || `User selected ${decision}`);
  updateSessionStateFromRequest(pending.request, statusAfterDecision(pending.request, decision), {
    decision,
    reason
  });
  audit({
    type: "permission_decision",
    requestId,
    decision,
    reason,
    answerKeys: decision === "answer" ? Object.keys(body.answers) : undefined,
    deviceId: client.device && client.device.deviceId,
    deviceName: client.device && client.device.deviceName
  });

  pending.resolve({ decision, reason, answers: body.answers, suggestionIndex: body.suggestionIndex });
  sendWsEvent(client, "permission_decision_result", {
    ok: true,
    requestId,
    decision,
    reason
  });
  broadcastWsEvent("permission_decision", {
    requestId,
    decision,
    reason
  });
  broadcastPendingRequests();
}

async function handlePairingToken(req, res) {
  if (!requireLocalRequest(req, res)) {
    return;
  }

  jsonResponse(res, 200, {
    protocolVersion: PROTOCOL_VERSION,
    type: "pairing_token",
    ...pairingManager.current(nowIso()),
    service: "claude-code-companion-daemon",
    connect: {
      host: HOST,
      port: PORT,
      localAddresses: localAddresses(),
      websocketPath: "/ws"
    }
  });
}

async function handlePair(req, res) {
  const body = await readJsonBody(req);
  const pairingToken = String(body.pairingToken || "");
  const deviceName = String(body.deviceName || "Unnamed device");

  if (!pairingManager.consume(pairingToken)) {
    jsonResponse(res, 401, {
      error: "Invalid or expired pairing token."
    });
    return;
  }

  const result = deviceStore.createDevice(deviceName, nowIso());
  audit({
    type: "device_paired",
    deviceId: result.device.deviceId,
    deviceName: result.device.deviceName
  });

  jsonResponse(res, 200, {
    protocolVersion: PROTOCOL_VERSION,
    type: "paired_device",
    deviceId: result.device.deviceId,
    deviceName: result.device.deviceName,
    authToken: result.authToken
  });
}

async function handleDevices(req, res) {
  if (!requireLocalRequest(req, res)) {
    return;
  }

  jsonResponse(res, 200, {
    devices: deviceStore.list()
  });
}

async function handleRevokeDevice(req, res) {
  if (!requireLocalRequest(req, res)) {
    return;
  }

  const body = await readJsonBody(req);
  const deviceId = String(body.deviceId || "");
  const revoked = deviceStore.revoke(deviceId, nowIso());
  if (!revoked) {
    jsonResponse(res, 404, {
      error: `No active device found for ${deviceId}`
    });
    return;
  }

  audit({
    type: "device_revoked",
    deviceId: revoked.deviceId,
    deviceName: revoked.deviceName
  });
  jsonResponse(res, 200, {
    ok: true,
    device: revoked
  });
}

// =============================================================
// Knowledge Cards (Stage 1.5) — see ADR-20260503-knowledge-cards
// =============================================================

async function handleCardsToday(req, res, url) {
  const device = requireAuthorizedRequest(req, res, url);
  if (!device) return;

  jsonResponse(res, 200, {
    payload: cardsStore.todayPayload(),
    generation: cardsGenerationStatus
  });
}

async function handleCardsHistory(req, res, url) {
  const device = requireAuthorizedRequest(req, res, url);
  if (!device) return;

  const limit = Number(url.searchParams.get("limit") || 30);
  jsonResponse(res, 200, {
    history: cardsStore.listHistory({ limit })
  });
}

async function handleCardsHistoryDate(req, res, url, date) {
  const device = requireAuthorizedRequest(req, res, url);
  if (!device) return;

  // ?archive=HHMMSS (or HHMMSS-N) → read the superseded prior generation
  // for this date instead of the canonical current deck. Lets the History
  // tab open old abstracts side-by-side without losing them on re-gen.
  const archiveId = url.searchParams.get("archive");
  const payload = archiveId
    ? cardsStore.readArchivedDay(date, archiveId)
    : cardsStore.readDay(date);
  if (!payload) {
    jsonResponse(res, 404, {
      error: archiveId
        ? `No archived cards for ${date} @ ${archiveId}`
        : `No cards stored for ${date}`
    });
    return;
  }
  jsonResponse(res, 200, { payload });
}

async function handleCardsWrongBook(req, res, url) {
  const device = requireAuthorizedRequest(req, res, url);
  if (!device) return;

  jsonResponse(res, 200, cardsStore.readWrongBook());
}

async function handleCardsAnswer(req, res, url) {
  const device = requireAuthorizedRequest(req, res, url);
  if (!device) return;

  const body = await readJsonBody(req);
  const cardId = String(body.cardId || "");
  if (!cardId) {
    jsonResponse(res, 400, { error: "cardId required" });
    return;
  }

  let result;
  try {
    result = cardsStore.recordAttempt({
      cardId,
      picked: body.picked,
      durationMs: body.durationMs,
      // History replay context — when the renderer started a review from
      // the History tab. Daemon uses these to look up the card in the
      // historical snapshot when it's not in today's deck or wrong book.
      historyDate: typeof body.historyDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.historyDate)
        ? body.historyDate
        : undefined,
      historyArchiveId: typeof body.historyArchiveId === "string"
        ? body.historyArchiveId
        : undefined
    });
  } catch (error) {
    jsonResponse(res, 404, { error: error.message });
    return;
  }

  audit({
    type: "card_answered",
    cardId,
    correct: result.attempt.correct,
    difficulty: result.card.difficulty,
    replay: result.replay
  });

  jsonResponse(res, 200, {
    ok: true,
    correct: result.attempt.correct,
    replay: result.replay,
    answer: result.card.answer,
    explanation: result.card.explanation || null,
    attempts: Array.isArray(result.card.attempts) ? result.card.attempts : []
  });
}

// GET /sessions/scan-candidates?limit=20[&windowDays=N]
// Returns the most-recently-edited Claude Code sessions for the picker UI.
// Each entry carries enough context for a meaningful pick: cwd, sessionId,
// lastSeenAt, group size (--resume forks), and a short first-user-message
// preview pulled from the JSONL header peek.
function handleScanCandidates(req, res, url) {
  if (!requireLocalRequest(req, res)) return;
  const limit = Math.max(1, Math.min(10000, Number(url.searchParams.get("limit") || 20)));
  const windowDays = Number(url.searchParams.get("windowDays"));
  const sinceMs = Number.isFinite(windowDays) && windowDays > 0
    ? Date.now() - windowDays * 24 * 60 * 60 * 1000
    : 0;
  let scanned;
  try {
    scanned = scanAllProjects({ sinceMs });
  } catch (error) {
    jsonResponse(res, 500, { error: error.message });
    return;
  }
  const items = scanned.slice(0, limit).map((s) => {
    let preview = "";
    try {
      // Re-peek to pull a short first-user-text preview. The peek already
      // ran during scanAllProjects but we didn't keep the text — cheap to
      // redo for the small picker subset.
      const fd = fs.openSync(s.transcriptPath, "r");
      const buf = Buffer.alloc(8 * 1024);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      const lines = buf.toString("utf8", 0, bytes).split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch (_e) { continue; }
        if (parsed.type === "user" && parsed.message && parsed.message.content) {
          const c = parsed.message.content;
          const text = Array.isArray(c)
            ? (c.find((b) => b && b.type === "text") || {}).text || ""
            : String(c);
          preview = String(text || "").trim().replace(/\s+/g, " ").slice(0, 80);
          if (preview) break;
        }
      }
    } catch (_e) { /* preview is optional */ }
    return {
      sessionId: s.sessionId,
      cwd: s.projectDirDecoded || null,
      lastSeenAt: s.mtime,
      groupSize: s.groupSize || 1,
      sizeBytes: s.sizeBytes,
      preview
    };
  });
  jsonResponse(res, 200, { items });
}

// POST /sessions/delete
// Body: { sessionIds: ["<id>", ...] }
// Moves each matching JSONL into the trash/manual/ folder. Hard delete is
// avoided so the user can recover from a misclick. The UI gates the call
// behind a "Allow session deletion" toggle, but the daemon still accepts
// any local request — the toggle is a UX guard, not a security one.
async function handleSessionsDelete(req, res) {
  if (!requireLocalRequest(req, res)) return;
  const body = await readJsonBody(req).catch(() => ({}));
  const ids = Array.isArray(body.sessionIds)
    ? body.sessionIds.filter((s) => typeof s === "string" && s)
    : [];
  if (ids.length === 0) {
    jsonResponse(res, 400, { error: "sessionIds required" });
    return;
  }
  // Build sessionId → transcriptPath map by scanning everything (no time
  // window — user may want to delete an old session).
  const all = scanAllProjects({ sinceMs: 0 });
  const byId = new Map(all.map((s) => [s.sessionId, s.transcriptPath]));
  const results = ids.map((id) => {
    const filePath = byId.get(id);
    if (!filePath) return { sessionId: id, ok: false, reason: "not_found" };
    return { sessionId: id, ...sessionTrash.trashFile(filePath, "manual") };
  });
  const okCount = results.filter((r) => r.ok).length;
  jsonResponse(res, 200, {
    requested: ids.length,
    trashed: okCount,
    results
  });
}

async function handleCardsGenerate(req, res) {
  if (!requireLocalRequest(req, res)) return;

  const body = await readJsonBody(req).catch(() => ({}));
  const focus = typeof body.focus === "string" ? body.focus : "";
  const difficulty = typeof body.difficulty === "string" ? body.difficulty : "balanced";
  const windowDays = Number.isFinite(Number(body.windowDays)) ? Number(body.windowDays) : 1;
  const targetDate = typeof body.targetDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.targetDate)
    ? body.targetDate
    : null;
  const requestedCount = Number(body.cardCount);
  const cardCount = Number.isFinite(requestedCount)
    ? Math.max(1, Math.min(20, Math.round(requestedCount)))
    : 5;
  const webFallback = body.webFallback !== false;  // default true
  // Transcript budget (chars): explicit body field > env override > default.
  // Clamped to a sane range so a malformed UI value can't blow up the prompt.
  const DEFAULT_BUDGET = Number(process.env.CCC_CARDS_TRANSCRIPT_BUDGET || 60_000);
  const requestedBudget = Number.isFinite(Number(body.transcriptBudget))
    ? Number(body.transcriptBudget)
    : DEFAULT_BUDGET;
  const transcriptBudget = Math.max(10_000, Math.min(1_000_000, requestedBudget));
  // Optional: explicit allowlist of sessionIds. When non-empty, ONLY these
  // sessions feed the prompt (window/date still apply as a cutoff filter).
  // Empty / missing → fall back to "scan everything in window" (legacy).
  const selectedSessionIds = Array.isArray(body.selectedSessionIds)
    ? body.selectedSessionIds.filter((s) => typeof s === "string" && s)
    : [];
  // Locale for the generator prompt — controls the natural-language output
  // (abstract, questions, options). en/zh only; anything else falls to en.
  const locale = body.locale === "zh" ? "zh" : "en";
  const date = targetDate || todayLocalDate();

  // Consent gate: real generator pipes session transcript content to a
  // local `claude -p` subprocess (and possibly to web tools when fallback
  // is on). First time the user triggers generation we require explicit
  // opt-in (per ADR §"Decision 11"). Stub mode skips this — no real data
  // crosses the daemon process boundary in stub mode.
  const usingStub = process.env.CCC_CARDS_USE_STUB === "true";
  if (!usingStub) {
    const consent = consentStore.read();
    if (!consent.given) {
      jsonResponse(res, 403, {
        error: "consent_required",
        consentVersion: CONSENT_VERSION,
        message: "First generation needs explicit consent — see /cards/consent"
      });
      return;
    }
  }

  cardsGenerationStatus = {
    state: "generating",
    startedAt: nowIso(),
    finishedAt: null,
    stage: "scanning",
    scanned: [],
    message: targetDate
      ? `Generating cards for ${targetDate} — discovering sessions…`
      : `Generating today's cards (window ${windowDays}d) — discovering sessions…`
  };

  // Discover sessions from BOTH sources, then dedupe by sessionId:
  //   - transcriptIndex: sessions where Companion's hook fired (richer
  //     metadata: cwd, lastSeenAt from real events)
  //   - scanAllProjects: every JSONL under ~/.claude/projects/, including
  //     sessions Companion never saw a hook for (other repos, history
  //     pre-dating Companion install). Slice 7's "scan ALL projects".
  const cutoffMs = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const TRANSCRIPT_TOTAL_BUDGET = transcriptBudget;
  // Per-session cap defaults to total/5 so a single chatty session can't
  // monopolize the prompt; env override still wins for power users.
  const TRANSCRIPT_PER_SESSION = Number(
    process.env.CCC_CARDS_TRANSCRIPT_PER_SESSION || Math.max(4_000, Math.floor(TRANSCRIPT_TOTAL_BUDGET / 5))
  );

  const indexedSessions = transcriptIndex.recentSessions(cutoffMs);
  const scannedFromDisk = scanAllProjects({ sinceMs: cutoffMs });

  const bySessionId = new Map();
  for (const e of indexedSessions) {
    bySessionId.set(e.sessionId, {
      sessionId: e.sessionId,
      transcriptPath: e.transcriptPath,
      cwd: e.cwd || null,
      lastSeenAt: e.lastSeenAt,
      source: "indexed"
    });
  }
  for (const s of scannedFromDisk) {
    if (bySessionId.has(s.sessionId)) continue;
    bySessionId.set(s.sessionId, {
      sessionId: s.sessionId,
      transcriptPath: s.transcriptPath,
      cwd: s.projectDirDecoded,
      lastSeenAt: s.mtime,
      source: "scanned"
    });
  }
  let allSessions = Array.from(bySessionId.values()).sort((a, b) => {
    return String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || ""));
  });

  // If the user explicitly picked sessions, restrict to that set. This
  // happens AFTER discovery so a typo'd id silently drops out (vs. throwing).
  if (selectedSessionIds.length > 0) {
    const allow = new Set(selectedSessionIds);
    allSessions = allSessions.filter((s) => allow.has(s.sessionId));
  }

  cardsGenerationStatus.message = `Reading ${allSessions.length} session${allSessions.length === 1 ? "" : "s"}…`;
  cardsGenerationStatus.stage = "reading";

  // Read transcript content per session. Cap per-session + overall so
  // the prompt fits the model's context window. Each session is recorded
  // in `scanned` with its outcome (included / empty / skipped-by-budget)
  // so the bubble + the persisted generationRecord can show transparency.
  const transcripts = [];
  let transcriptCharsUsed = 0;
  for (let i = 0; i < allSessions.length; i += 1) {
    const entry = allSessions[i];
    const cwdLabel = entry.cwd ? entry.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join("/") : "?";
    cardsGenerationStatus.message = `Reading session ${i + 1}/${allSessions.length} · ${cwdLabel}`;
    if (transcriptCharsUsed >= TRANSCRIPT_TOTAL_BUDGET) {
      cardsGenerationStatus.scanned.push({
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        source: entry.source,
        status: "skipped (budget)",
        chars: 0
      });
      continue;
    }
    const remaining = TRANSCRIPT_TOTAL_BUDGET - transcriptCharsUsed;
    const text = readTranscript({
      transcriptPath: entry.transcriptPath,
      since: cutoffMs,
      maxChars: Math.min(TRANSCRIPT_PER_SESSION, remaining)
    });
    if (!text) {
      cardsGenerationStatus.scanned.push({
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        source: entry.source,
        status: "empty",
        chars: 0
      });
      continue;
    }
    transcripts.push({
      sessionId: entry.sessionId,
      cwd: entry.cwd || null,
      text
    });
    transcriptCharsUsed += text.length;
    cardsGenerationStatus.scanned.push({
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      source: entry.source,
      status: "included",
      chars: text.length
    });
  }

  cardsGenerationStatus.stage = "calling";
  cardsGenerationStatus.message = transcripts.length > 0
    ? `Calling claude -p with ${transcripts.length} session${transcripts.length === 1 ? "" : "s"} (${Math.round(transcriptCharsUsed / 1000)}k chars)…`
    : `Calling claude -p (no transcript content found in window)…`;

  // Snapshot every session JSONL under ~/.claude/projects BEFORE calling
  // claude -p, so we can diff after and trash whatever the subprocess
  // creates as its OWN session file (otherwise the next generate scans
  // the prior generator's noise and the loop snowballs).
  const preSnapshot = snapshotJsonlPaths();

  // generateCards never throws — it returns { payload, dropped, stub, error }.
  // Stub fallback kicks in when claude CLI isn't on PATH, so a dev box with
  // no Claude Code install still gets a working bubble.
  const result = await generateCards({
    focus,
    difficulty,
    windowDays,
    targetDate,
    cardCount,
    webFallback,
    locale,
    sessions: sessionStateList(),
    auditEvents,
    transcripts,
    sampleDeckPayload
  });

  // Diff snapshot regardless of success/failure. Anything new is, by
  // definition, a session that didn't exist before this run — i.e. the
  // generator's own subprocess session. Trash it so the next scan is clean.
  try {
    const postSnapshot = snapshotJsonlPaths();
    const newPaths = [];
    for (const p of postSnapshot) {
      if (!preSnapshot.has(p)) newPaths.push(p);
    }
    for (const p of newPaths) {
      sessionTrash.trashFile(p, "generator", { reason: "auto-cleanup of generator's own session" });
    }
    if (newPaths.length > 0) {
      console.log(`[cards] auto-trashed ${newPaths.length} generator session${newPaths.length === 1 ? "" : "s"}`);
    }
  } catch (cleanupError) {
    console.log(`[cards] generator-session cleanup failed: ${cleanupError.message}`);
  }

  if (!result.payload) {
    cardsGenerationStatus = {
      state: "error",
      startedAt: cardsGenerationStatus.startedAt,
      finishedAt: nowIso(),
      message: result.error || "Generation failed"
    };
    jsonResponse(res, 500, { error: result.error || "Generation failed" });
    return;
  }

  let persisted;
  try {
    // Stamp the generationRecord onto the payload before saving so
    // History tab can show "what got scanned" alongside the abstract.
    const finishedAt = nowIso();
    const startedMs = Date.parse(cardsGenerationStatus.startedAt) || Date.now();
    result.payload.generationRecord = {
      generatedAt: cardsGenerationStatus.startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs,
      windowDays,
      targetDate,
      cardCount,
      difficulty,
      webFallback,
      transcriptBudget,
      selectedSessionIds: selectedSessionIds.length > 0 ? selectedSessionIds.slice() : null,
      stub: !!result.stub,
      scannedSessions: cardsGenerationStatus.scanned.slice(),
      totalCharsInPrompt: transcriptCharsUsed,
      cardsAccepted: 0,
      cardsDropped: result.dropped.length
    };
    const saved = cardsStore.saveGeneratedDay(date, result.payload);
    persisted = saved.payload;
    // Update with final accepted count post-validation.
    persisted.generationRecord.cardsAccepted = persisted.cards.length;
    persisted.generationRecord.cardsDropped =
      result.dropped.length + saved.dropped.length;
    // Re-write so the persisted file has the corrected counts.
    cardsStore.writeDay(date, persisted, { archivePrior: false });

    cardsGenerationStatus = {
      state: "idle",
      startedAt: cardsGenerationStatus.startedAt,
      finishedAt,
      stage: "done",
      scanned: cardsGenerationStatus.scanned,
      message: result.stub
        ? `Stub deck written (${persisted.cards.length} cards, ${result.dropped.length + saved.dropped.length} dropped)`
        : `Generated ${persisted.cards.length} cards (dropped ${result.dropped.length + saved.dropped.length}) from ${transcripts.length} session${transcripts.length === 1 ? "" : "s"}`
    };
  } catch (error) {
    cardsGenerationStatus = {
      state: "error",
      startedAt: cardsGenerationStatus.startedAt,
      finishedAt: nowIso(),
      message: error.message
    };
    jsonResponse(res, 500, { error: error.message });
    return;
  }

  audit({
    type: "cards_generated",
    date: persisted.date,
    cards: persisted.cards.length,
    dropped: result.dropped.length,
    stub: !!result.stub,
    focus: focus ? "set" : "empty",
    windowDays,
    targetDate
  });

  jsonResponse(res, 200, {
    ok: true,
    stub: !!result.stub,
    payload: persisted,
    dropped: result.dropped
  });
}

async function handleCardsExport(req, res, url) {
  const device = requireAuthorizedRequest(req, res, url);
  if (!device) return;

  const scope = url.searchParams.get("scope") || "today";
  const date = url.searchParams.get("date");
  const archive = url.searchParams.get("archive");

  let markdown = "";
  let filename = "companion-export.md";

  if (scope === "today") {
    const targetDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayLocalDate();
    const payload = archive
      ? cardsStore.readArchivedDay(targetDate, archive)
      : cardsStore.readDay(targetDate);
    if (!payload) {
      jsonResponse(res, 404, { error: `No deck for ${targetDate}${archive ? ` @ ${archive}` : ""}` });
      return;
    }
    markdown = composeDayMarkdown(payload);
    filename = `companion-${targetDate}${archive ? `-${archive}` : ""}.md`;
  } else if (scope === "history") {
    // Pull a wider list (limit 365) so the export covers a year of decks
    // even if the History tab UI shows only the most recent 30. Resolve
    // each summary back to its full payload via the public store API.
    const items = cardsStore.listHistory({ limit: 365 });
    const expanded = [];
    for (const summary of items) {
      const archiveId = summary.isArchive && summary.archivedAt
        ? summary.archivedAt.replace(/:/g, "")
        : null;
      const payload = archiveId
        ? cardsStore.readArchivedDay(summary.date, archiveId)
        : cardsStore.readDay(summary.date);
      if (payload) expanded.push({ payload, archivedAt: summary.archivedAt });
    }
    markdown = composeAllAbstractsMarkdown(expanded);
    filename = "companion-history.md";
  } else if (scope === "wrong-book") {
    markdown = composeWrongBookMarkdown(cardsStore.readWrongBook());
    filename = "companion-wrong-book.md";
  } else {
    jsonResponse(res, 400, { error: `Unknown scope: ${scope}` });
    return;
  }

  res.writeHead(200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-length": Buffer.byteLength(markdown),
    "content-disposition": `attachment; filename="${filename}"`,
    "cache-control": "no-store"
  });
  res.end(markdown);
}

async function handleCardsGenerationStatus(req, res, url) {
  const device = requireAuthorizedRequest(req, res, url);
  if (!device) return;

  jsonResponse(res, 200, cardsGenerationStatus);
}

async function handleCardsStorageRead(req, res, url) {
  const device = requireAuthorizedRequest(req, res, url);
  if (!device) return;
  const resolved = cardsStorageConfig.resolvedCardsDir();
  jsonResponse(res, 200, {
    cardsDir: cardsStore.cardsDir,
    defaultCardsDir: cardsStorageConfig.defaultCardsDir,
    isDefault: resolved.isDefault,
    configuredAt: resolved.configuredAt,
    note: resolved.cardsDir !== cardsStore.cardsDir
      ? "configuration changed; restart daemon to apply"
      : null
  });
}

async function handleCardsStorageWrite(req, res) {
  if (!requireLocalRequest(req, res)) return;
  const body = await readJsonBody(req).catch(() => ({}));
  const wanted = typeof body.cardsDir === "string" ? body.cardsDir.trim() : "";
  // Empty string / null → revert to default.
  const next = cardsStorageConfig.setCardsDir(wanted || null);
  audit({
    type: "cards_storage_changed",
    cardsDir: next.cardsDir,
    isDefault: next.isDefault
  });
  jsonResponse(res, 200, {
    ok: true,
    cardsDir: next.cardsDir,
    isDefault: next.isDefault,
    configuredAt: next.configuredAt,
    appliedAfterRestart: next.cardsDir !== cardsStore.cardsDir,
    note: "Daemon must restart to read/write the new directory."
  });
}

async function handleCardsConsentRead(req, res, url) {
  const device = requireAuthorizedRequest(req, res, url);
  if (!device) return;

  const record = consentStore.read();
  jsonResponse(res, 200, {
    given: record.given,
    givenAt: record.givenAt,
    consentVersion: CONSENT_VERSION
  });
}

async function handleCardsConsentWrite(req, res) {
  // Local-only — phones shouldn't be able to grant transcript-pipe consent
  // remotely; that decision belongs to the human at the console.
  if (!requireLocalRequest(req, res)) return;

  const body = await readJsonBody(req).catch(() => ({}));
  const given = Boolean(body.given);
  const written = consentStore.write(given);
  audit({
    type: given ? "cards_consent_given" : "cards_consent_revoked",
    consentVersion: CONSENT_VERSION
  });
  jsonResponse(res, 200, {
    ok: true,
    given: written.given,
    givenAt: written.givenAt,
    consentVersion: CONSENT_VERSION
  });
}

// Deterministic seed deck — used by the stub generator above and by the
// smoke test. Pulls real decisions from this very ADR / repo so a
// developer running `npm run smoke` immediately sees plausible content.
function sampleDeckPayload({ focus, difficulty, date }) {
  const sourceSnippetSetupHooks =
    "user: 4. mac 上测试出现问题：安装 hook 后 Claude Code 报错没有 power shell 指令\n" +
    "\n" +
    "assistant: setup-hooks.js has ASK_RULES = ['Bash', 'PowerShell']. On Mac,\n" +
    "PowerShell isn't a registered Claude Code tool, so listing it in\n" +
    "permissions.ask makes Claude Code reject the entire permissions block.\n" +
    "Make setup-hooks.js platform-aware.\n" +
    "\n" +
    "edit: scripts/setup-hooks.js:7-13\n" +
    "+ const SHELL_TOOLS = process.platform === 'win32'\n" +
    "+   ? ['Bash', 'PowerShell']\n" +
    "+   : ['Bash'];";

  const sourceSnippetCloze =
    "From packages/desktop/main.js (compactPeekBounds):\n" +
    "const capsuleSpan = (axis) => axis === 'x'\n" +
    "  ? full.width  - 2 * BUBBLE_PADDING - PEEK_VISIBLE_PX\n" +
    "  : full.height - 2 * BUBBLE_PADDING - PEEK_VISIBLE_PX;\n" +
    "// Both axes subtract the same constant so the visible peek width\n" +
    "// is uniform (12 px) regardless of which edge the bubble snaps to.";

  const sourceSnippetClaudeP =
    "user: 不要改 api，由设定时间或者每次用户打开该软件的时候自动触发 prompt\n" +
    "\n" +
    "assistant: 不调 Anthropic API，直接调用用户本地已经装好的 claude CLI\n" +
    "(headless 模式)。好处：不用配 API key、不用新增订阅成本、模型质量\n" +
    "跟 Claude Code 用的一致、Companion 永远不直接持有用户密钥。";

  return {
    date,
    state: "ready",
    abstract:
      "## Stage 1.5 Knowledge Cards 设计完成\n" +
      "\n" +
      "今天主要在 **companion repo** 完成了 Knowledge Cards 功能的完整设计 + 写了第一份 ADR。\n" +
      "\n" +
      "### 关键决定\n" +
      "\n" +
      "- 用 `claude -p` headless 子进程生成卡片，避免引入新的 API key\n" +
      "- 强制溯源：每张卡必须有 verbatim session 引用，没有就丢弃\n" +
      "- 难度三档：easy 概念 / medium 实现 / hard 底层\n" +
      "- 空白日 fallback：从 wrong book + 过去 N 天抽题，streak 1 天保护\n" +
      "\n" +
      "### 触及文件\n" +
      "\n" +
      "- `docs/knowledge-cards-v1.html`\n" +
      "- `docs/decisions/ADR-20260503-knowledge-cards.md`\n" +
      "- `docs/stages.md`\n" +
      "- `CLAUDE.md`\n" +
      "\n" +
      "> 下一步：实现 daemon 端的 cards-store + endpoints",
    focusSnapshot: focus || "",
    focusCoverage: focus ? 70 : null,
    difficultyPreference: difficulty || "balanced",
    sourceSessionIds: ["sess_seed"],
    stats: { sessions: 1, durationMin: 90 },
    cards: [
      {
        id: "card_seed_1",
        type: "choice",
        difficulty: "medium",
        question: "为什么 setup-hooks.js 把 PowerShell 限定在 Windows？",
        options: [
          "Claude Code 在 macOS 上没把 PATH 透传给 hook 进程",
          "Claude Code 启动时校验 permissions.ask 里的工具名，列出未知工具会让 CLI 直接拒绝运行",
          "PowerShell Core 在 macOS 能跑但太慢，不适合 hook 路径",
          "Apple sandbox 阻止 PowerShell 派生子进程"
        ],
        answer: 1,
        source: {
          sessionId: "sess_seed",
          snippet: sourceSnippetSetupHooks,
          fileRef: "scripts/setup-hooks.js#L7-13"
        },
        explanation: {
          fromSession: true,
          snippet: "Claude Code maintains an internal tool whitelist; pointing permissions.ask at an unknown tool fails startup validation."
        },
        attempts: []
      },
      {
        id: "card_seed_2",
        type: "cloze",
        difficulty: "easy",
        question: "填空：compactPeekBounds 里 capsuleSpan 的 X 轴公式 — 减号后面的常量是？",
        answer: "PEEK_VISIBLE_PX",
        source: {
          sessionId: "sess_seed",
          snippet: sourceSnippetCloze,
          fileRef: "packages/desktop/main.js#L365-L368"
        },
        explanation: {
          fromSession: true,
          snippet: "Same constant on both axes — visible peek width is uniform (12 px)."
        },
        attempts: []
      },
      {
        id: "card_seed_3",
        type: "choice",
        difficulty: "hard",
        question: "为什么 Companion 选择 spawn `claude -p` 而不是直接调 Anthropic API？",
        options: [
          "claude -p 比 API 调用快约 30%",
          "API 调用需要绕过 Cloudflare bot 检测",
          "复用用户已认证的 Claude Code 会话，避免引入新的密钥配置 / 计费 / 鉴权生命周期",
          "Anthropic SDK 在 Node 20 之前不稳定"
        ],
        answer: 2,
        source: {
          sessionId: "sess_seed",
          snippet: sourceSnippetClaudeP,
          fileRef: "docs/decisions/ADR-20260503-knowledge-cards.md#decision-1"
        },
        explanation: {
          fromSession: true,
          snippet: "User explicitly preferred not configuring a separate API key. Subprocess sidesteps auth lifecycle entirely."
        },
        attempts: []
      }
    ]
  };
}

async function route(req, res) {
  if (req.method === "OPTIONS") {
    jsonResponse(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === "GET" && url.pathname === "/") {
    htmlResponse(res, daemonRootNoticeHtml());
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    jsonResponse(res, 200, {
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      service: "claude-code-companion-daemon",
      pendingRequests: pendingRequests.size,
      sessions: sessionStates.size,
      port: PORT,
      host: HOST,
      localAddresses: localAddresses()
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/pairing-token") {
    await handlePairingToken(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/pair") {
    await handlePair(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/devices") {
    await handleDevices(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/devices/revoke") {
    await handleRevokeDevice(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/hook/pre-tool-use") {
    await handlePreToolUse(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/hook/permission-request") {
    await handlePermissionRequestHook(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/hook/event") {
    await handleHookEvent(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/pending-requests") {
    const device = requireAuthorizedRequest(req, res, url);
    if (!device) {
      return;
    }

    jsonResponse(res, 200, {
      requests: pendingRequestList()
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/sessions") {
    const device = requireAuthorizedRequest(req, res, url);
    if (!device) {
      return;
    }

    jsonResponse(res, 200, {
      sessions: sessionStateList()
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/permission-decisions") {
    await handlePermissionDecision(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/events") {
    const device = requireAuthorizedRequest(req, res, url);
    if (!device) {
      return;
    }

    jsonResponse(res, 200, { events: auditEvents.slice(-100) });
    return;
  }

  // Knowledge Cards (Stage 1.5)
  if (req.method === "GET" && url.pathname === "/cards/today") {
    await handleCardsToday(req, res, url);
    return;
  }
  if (req.method === "GET" && url.pathname === "/cards/history") {
    await handleCardsHistory(req, res, url);
    return;
  }
  const historyDateMatch = url.pathname.match(/^\/cards\/history\/(\d{4}-\d{2}-\d{2})$/);
  if (req.method === "GET" && historyDateMatch) {
    await handleCardsHistoryDate(req, res, url, historyDateMatch[1]);
    return;
  }
  if (req.method === "GET" && url.pathname === "/cards/wrong-book") {
    await handleCardsWrongBook(req, res, url);
    return;
  }
  if (req.method === "GET" && url.pathname === "/cards/generation-status") {
    await handleCardsGenerationStatus(req, res, url);
    return;
  }
  if (req.method === "GET" && url.pathname === "/cards/export") {
    await handleCardsExport(req, res, url);
    return;
  }
  if (req.method === "GET" && url.pathname === "/cards/consent") {
    await handleCardsConsentRead(req, res, url);
    return;
  }
  if (req.method === "POST" && url.pathname === "/cards/consent") {
    await handleCardsConsentWrite(req, res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/cards/storage") {
    await handleCardsStorageRead(req, res, url);
    return;
  }
  if (req.method === "POST" && url.pathname === "/cards/storage") {
    await handleCardsStorageWrite(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/cards/answer") {
    await handleCardsAnswer(req, res, url);
    return;
  }
  if (req.method === "POST" && url.pathname === "/cards/generate") {
    await handleCardsGenerate(req, res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/sessions/scan-candidates") {
    handleScanCandidates(req, res, url);
    return;
  }
  if (req.method === "POST" && url.pathname === "/sessions/delete") {
    await handleSessionsDelete(req, res);
    return;
  }
  if (req.method === "GET" && url.pathname === "/cards/streak") {
    if (!requireLocalRequest(req, res)) return;
    try {
      jsonResponse(res, 200, cardsStreak.compute());
    } catch (error) {
      jsonResponse(res, 500, { error: error.message });
    }
    return;
  }

  jsonResponse(res, 404, { error: "Not found" });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error("[error]", error);
    if (!res.headersSent) {
      jsonResponse(res, 500, { error: error.message });
    } else {
      res.end();
    }
  });
});

server.on("upgrade", (req, socket) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  let device = null;
  const token = bearerToken(req, url);
  if (token) {
    device = authenticatedDevice(req, url);
  } else if (isLoopbackRequest(req)) {
    device = {
      deviceId: "local",
      deviceName: "Local browser"
    };
  }

  if (!device) {
    unauthorizedUpgrade(socket);
    return;
  }

  const client = acceptWebSocket(req, socket, {
    onMessage: (wsClient, text) => {
      let message;
      try {
        message = JSON.parse(text);
      } catch (error) {
        sendWsEvent(wsClient, "error", { error: `Invalid JSON: ${error.message}` });
        return;
      }

      if (message.type === "permission_decision") {
        applyPermissionDecisionFromWebSocket(wsClient, message);
        return;
      }

      sendWsEvent(wsClient, "error", { error: `Unsupported message type: ${message.type || "unknown"}` });
    },
    onClose: (wsClient) => {
      wsClients.delete(wsClient);
    },
    onError: (_wsClient, error) => {
      console.error("[ws]", error.message);
    }
  });

  if (!client) {
    return;
  }

  client.device = device;
  wsClients.add(client);
  sendWsEvent(client, "hello", {
    service: "claude-code-companion-daemon",
    device,
    requests: pendingRequestList(),
    sessions: sessionStateList()
  });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`[error] Port ${PORT} on ${HOST} is already in use.`);
    console.error("[error] Another Claude Code Companion daemon is likely already running.");
    console.error("[error] To stop it on Windows, run in PowerShell:");
    console.error(
      `        Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`
    );
    console.error("[error] Or set $env:CCC_PORT to a different port before starting the daemon.");
    process.exit(1);
  }
  throw error;
});

server.listen(PORT, HOST, () => {
  console.log(`Claude Code Companion daemon listening on http://${HOST}:${PORT}`);
  console.log("Daemon home: http://" + HOST + ":" + PORT + "/  (visiting in a browser shows a redirect notice; the dashboard now lives in the desktop bubble)");
  console.log("Realtime events: ws://" + HOST + ":" + PORT + "/ws");
  console.log("Pairing token endpoint: http://" + HOST + ":" + PORT + "/pairing-token");
  console.log("Stage 0 endpoints: GET /health, POST /hook/pre-tool-use, POST /hook/permission-request, POST /hook/event, GET /sessions, GET /pending-requests, POST /permission-decisions");
});
