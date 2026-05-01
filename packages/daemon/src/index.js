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

const PORT = Number(process.env.CCC_PORT || 4317);
const HOST = process.env.CCC_HOST || "127.0.0.1";
const REQUEST_TIMEOUT_MS = Number(process.env.CCC_APPROVAL_TIMEOUT_MS || 55_000);
const DATA_DIR = process.env.CCC_DATA_DIR || path.join(process.cwd(), ".claude-companion");
const DEFAULT_CONTEXT_WINDOW_TOKENS = Number(process.env.CCC_CONTEXT_WINDOW_TOKENS || 200_000);

const pendingRequests = new Map();
const sessionStates = new Map();
const auditEvents = [];
const wsClients = new Set();
const deviceStore = new DeviceStore({ dataDir: DATA_DIR });
const pairingManager = new PairingManager();
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

function contextWindowFromModel(model) {
  // Claude Code records the active model id on every assistant turn in the
  // transcript. The 1M-context variants always carry a "[1m]" suffix in that
  // id, so that suffix is the cleanest signal we can rely on. Everything else
  // currently defaults to the standard 200k window.
  if (!model) {
    return 0;
  }
  const text = String(model).toLowerCase();
  if (text.includes("[1m]")) {
    return 1_000_000;
  }
  return 200_000;
}

function contextWindowFromUsage(usage, model) {
  return numberFromAny(
    usage.context_window_tokens,
    usage.contextWindowTokens,
    usage.context_window,
    usage.contextWindow,
    usage.max_context_tokens,
    usage.maxContextTokens,
    contextWindowFromModel(model),
    DEFAULT_CONTEXT_WINDOW_TOKENS
  );
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
  const maxTokens = contextWindowFromUsage(usage, model);

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

function latestContextUsageFromTranscriptFile(transcriptPath) {
  try {
    const stats = fs.statSync(transcriptPath);
    const readSize = Math.min(stats.size, 256 * 1024);
    const fd = fs.openSync(transcriptPath, "r");
    try {
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, stats.size - readSize);
      const lines = buffer.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        let item;
        try {
          item = JSON.parse(lines[index]);
        } catch (_error) {
          continue;
        }

        const usage = item && item.message && item.message.usage;
        const model = item && item.message && item.message.model;
        const contextUsage = contextUsageFromUsage(usage, model);
        if (contextUsage) {
          return contextUsage;
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (_error) {
    return null;
  }

  return null;
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
      return "waiting_answer";
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

function approvalPageHtml() {
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Claude Code Companion</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #111315;
      --panel: #191d21;
      --panel-2: #20262b;
      --text: #f4f4f5;
      --muted: #9ca3af;
      --line: #343a40;
      --green: #22c55e;
      --red: #ef4444;
      --amber: #f59e0b;
      --blue: #38bdf8;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    main {
      width: min(920px, calc(100% - 32px));
      margin: 0 auto;
      padding: 32px 0;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
    }

    h1 {
      margin: 0;
      font-size: 24px;
      font-weight: 700;
      letter-spacing: 0;
    }

    .status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 14px;
      white-space: nowrap;
    }

    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.12);
    }

    .empty,
    .card {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }

    .empty {
      padding: 28px;
      color: var(--muted);
      text-align: center;
    }

    .list {
      display: grid;
      gap: 14px;
    }

    .section-title {
      margin: 18px 0 10px;
      color: var(--muted);
      font-size: 13px;
      font-weight: 800;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .state-list {
      display: grid;
      gap: 10px;
      margin-bottom: 18px;
    }

    .state-card {
      display: grid;
      gap: 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      padding: 14px 16px;
    }

    .state-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }

    .state-summary {
      margin: 4px 0 0;
      color: #e5e7eb;
      overflow-wrap: anywhere;
    }

    .state-meta {
      color: var(--muted);
      font-size: 13px;
      overflow-wrap: anywhere;
    }

    .state-chip {
      flex: 0 0 auto;
      border-radius: 999px;
      padding: 5px 9px;
      background: #334155;
      color: white;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
    }

    .state-thinking,
    .state-running_tool {
      background: #2563eb;
    }

    .state-waiting_approval,
    .state-waiting_answer {
      background: #b45309;
    }

    .state-done,
    .state-idle {
      background: #15803d;
    }

    .state-failed,
    .state-blocked {
      background: #b91c1c;
    }

    .card {
      overflow: hidden;
    }

    .card-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 16px;
      background: var(--panel-2);
      border-bottom: 1px solid var(--line);
    }

    .summary {
      margin: 4px 0 0;
      font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
      overflow-wrap: anywhere;
      color: #e5e7eb;
    }

    .meta {
      display: grid;
      gap: 8px;
      padding: 16px;
      color: var(--muted);
      font-size: 14px;
    }

    .row {
      display: grid;
      grid-template-columns: 140px minmax(0, 1fr);
      gap: 12px;
    }

    .value {
      color: var(--text);
      overflow-wrap: anywhere;
    }

    .badge {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 72px;
      height: 28px;
      border-radius: 999px;
      padding: 0 10px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      color: #0f172a;
    }

    .risk-low {
      background: var(--green);
    }

    .risk-medium {
      background: var(--amber);
    }

    .risk-high {
      background: var(--red);
      color: white;
    }

    .actions {
      display: flex;
      gap: 10px;
      padding: 0 16px 16px;
    }

    button {
      height: 40px;
      border: 0;
      border-radius: 8px;
      padding: 0 16px;
      color: white;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }

    button:disabled {
      cursor: wait;
      opacity: 0.65;
    }

    input[type="text"] {
      width: 100%;
      min-height: 40px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      background: #111827;
      color: var(--text);
      font: inherit;
    }

    .question-form {
      display: grid;
      gap: 12px;
      padding: 16px;
      border-top: 1px solid var(--line);
    }

    .question-block {
      display: grid;
      gap: 10px;
      min-width: 0;
      margin: 0;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
    }

    .question-block legend {
      padding: 0 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .question-text {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .option-list {
      display: grid;
      gap: 8px;
    }

    .option-row {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      gap: 8px;
      align-items: start;
      color: var(--text);
    }

    .option-row small {
      display: block;
      margin-top: 2px;
      color: var(--muted);
    }

    .approve {
      background: #15803d;
    }

    .deny {
      background: #b91c1c;
    }

    .refresh {
      background: #2563eb;
    }

    .pairing {
      background: #475569;
    }

    .toolbar {
      display: flex;
      gap: 10px;
      justify-content: flex-end;
      margin-bottom: 14px;
    }

    .toast {
      min-height: 22px;
      margin-top: 16px;
      color: var(--blue);
      font-size: 14px;
    }

    @media (max-width: 640px) {
      header {
        align-items: flex-start;
        flex-direction: column;
      }

      .row {
        grid-template-columns: 1fr;
        gap: 3px;
      }

      .actions {
        flex-direction: column;
      }

      button {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Claude Code Companion</h1>
        <div class="status"><span class="dot"></span><span id="health">Connected to local daemon</span></div>
      </div>
      <div class="status" id="transport">Connecting WebSocket</div>
    </header>

    <div class="toolbar">
      <button class="pairing" type="button" id="pairing">Show Pairing Token</button>
      <button class="refresh" type="button" id="refresh">Refresh</button>
    </div>

    <h2 class="section-title">Claude Status</h2>
    <section id="sessions" class="state-list"></section>

    <h2 class="section-title">Pending Requests</h2>
    <section id="requests" class="list"></section>
    <div id="toast" class="toast"></div>
  </main>

  <script>
    const sessionsEl = document.getElementById("sessions");
    const requestsEl = document.getElementById("requests");
    const toastEl = document.getElementById("toast");
    const healthEl = document.getElementById("health");
    const refreshBtn = document.getElementById("refresh");
    const pairingBtn = document.getElementById("pairing");
    const transportEl = document.getElementById("transport");
    let socket = null;
    let socketConnected = false;

    function setToast(message) {
      toastEl.textContent = message || "";
    }

    function addRow(parent, label, value) {
      const row = document.createElement("div");
      row.className = "row";
      const left = document.createElement("div");
      left.textContent = label;
      const right = document.createElement("div");
      right.className = "value";
      right.textContent = value || "";
      row.append(left, right);
      parent.append(row);
    }

    function renderSessions(sessions) {
      if (!sessions.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No Claude session state yet.";
        sessionsEl.replaceChildren(empty);
        return;
      }

      const cards = sessions.map((session) => {
        const card = document.createElement("article");
        card.className = "state-card";

        const head = document.createElement("div");
        head.className = "state-head";

        const copy = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = session.tool || session.hookEventName || "Claude Code";
        const summary = document.createElement("p");
        summary.className = "state-summary";
        summary.textContent = session.summary || "";
        copy.append(title, summary);

        const chip = document.createElement("span");
        chip.className = "state-chip state-" + (session.status || "idle");
        chip.textContent = session.status || "idle";
        head.append(copy, chip);

        const meta = document.createElement("div");
        meta.className = "state-meta";
        meta.textContent = [session.sessionId, session.cwd, session.updatedAt].filter(Boolean).join(" · ");

        card.append(head, meta);
        return card;
      });

      sessionsEl.replaceChildren(...cards);
    }

    function getQuestions(request) {
      if (Array.isArray(request.questions)) {
        return request.questions;
      }
      if (request.toolInput && Array.isArray(request.toolInput.questions)) {
        return request.toolInput.questions;
      }
      return [];
    }

    function questionKey(question, index) {
      return String((question && question.question) || "Question " + (index + 1));
    }

    function optionLabel(option) {
      if (typeof option === "string") {
        return option;
      }
      return String((option && option.label) || "");
    }

    function optionDescription(option) {
      if (!option || typeof option === "string") {
        return "";
      }
      return String(option.description || "");
    }

    function renderQuestionForm(request) {
      const questions = getQuestions(request);
      const form = document.createElement("form");
      form.className = "question-form";

      if (!questions.length) {
        const input = document.createElement("input");
        input.type = "text";
        input.name = "custom_0";
        input.placeholder = "Answer";
        form.append(input);
      }

      questions.forEach((question, index) => {
        const fieldset = document.createElement("fieldset");
        fieldset.className = "question-block";

        const legend = document.createElement("legend");
        legend.textContent = String(question.header || "Question");
        fieldset.append(legend);

        const text = document.createElement("p");
        text.className = "question-text";
        text.textContent = questionKey(question, index);
        fieldset.append(text);

        const optionList = document.createElement("div");
        optionList.className = "option-list";
        const options = Array.isArray(question.options) ? question.options : [];
        options.forEach((option, optionIndex) => {
          const labelText = optionLabel(option);
          if (!labelText) {
            return;
          }

          const label = document.createElement("label");
          label.className = "option-row";

          const input = document.createElement("input");
          input.type = question.multiSelect ? "checkbox" : "radio";
          input.name = "question_" + index;
          input.value = labelText;
          input.checked = !question.multiSelect && optionIndex === 0;

          const copy = document.createElement("span");
          copy.textContent = labelText;
          const description = optionDescription(option);
          if (description) {
            const small = document.createElement("small");
            small.textContent = description;
            copy.append(small);
          }

          label.append(input, copy);
          optionList.append(label);
        });
        fieldset.append(optionList);

        const custom = document.createElement("input");
        custom.type = "text";
        custom.name = "custom_" + index;
        custom.placeholder = "Other answer";
        fieldset.append(custom);

        form.append(fieldset);
      });

      const answer = document.createElement("button");
      answer.className = "approve";
      answer.type = "submit";
      answer.textContent = "Answer";
      form.append(answer);

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const answers = {};

        if (!questions.length) {
          const value = String(form.elements.custom_0.value || "").trim();
          if (!value) {
            setToast("Answer is required.");
            return;
          }
          answers.Answer = value;
          decide(request.requestId, "answer", "Answered from local web UI", { answers });
          return;
        }

        for (let index = 0; index < questions.length; index += 1) {
          const question = questions[index];
          const key = questionKey(question, index);
          const custom = String((form.elements["custom_" + index] && form.elements["custom_" + index].value) || "").trim();
          if (custom) {
            answers[key] = custom;
            continue;
          }

          const selected = Array.from(form.querySelectorAll('input[name="question_' + index + '"]:checked')).map((input) => input.value);
          if (!selected.length) {
            setToast("Choose an answer for: " + key);
            return;
          }
          answers[key] = question.multiSelect ? selected.join(", ") : selected[0];
        }

        decide(request.requestId, "answer", "Answered from local web UI", { answers });
      });

      return form;
    }

    function renderEmpty() {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No pending Claude Code approval requests.";
      requestsEl.replaceChildren(empty);
    }

    function renderRequests(requests) {
      if (!requests.length) {
        renderEmpty();
        return;
      }

      const cards = requests.map((request) => {
        const card = document.createElement("article");
        card.className = "card";

        const head = document.createElement("div");
        head.className = "card-head";

        const titleWrap = document.createElement("div");
        const title = document.createElement("strong");
        title.textContent = request.tool || "Unknown tool";
        const summary = document.createElement("p");
        summary.className = "summary";
        summary.textContent = request.summary || "";
        titleWrap.append(title, summary);

        const badge = document.createElement("span");
        badge.className = "badge risk-" + (request.risk || "low");
        badge.textContent = request.risk || "low";
        head.append(titleWrap, badge);

        const meta = document.createElement("div");
        meta.className = "meta";
        addRow(meta, "Request ID", request.requestId);
        addRow(meta, "Session", request.sessionId);
        addRow(meta, "Working directory", request.cwd);
        addRow(meta, "Hook event", request.hookEventName || request.approvalKind);
        addRow(meta, "Reason", request.reason);
        addRow(meta, "Created", request.createdAt);

        const actions = document.createElement("div");
        actions.className = "actions";
        const isQuestionRequest = request.approvalKind === "ask_user_question" || request.tool === "AskUserQuestion";

        const deny = document.createElement("button");
        deny.className = "deny";
        deny.type = "button";
        deny.textContent = "Deny";
        deny.addEventListener("click", () => {
          const reason = window.prompt("Reason for denial", "Denied from local web UI");
          if (reason !== null) {
            decide(request.requestId, "deny", reason);
          }
        });

        if (isQuestionRequest) {
          card.append(head, meta, renderQuestionForm(request));
          actions.append(deny);
          card.append(actions);
          return card;
        }

        const approve = document.createElement("button");
        approve.className = "approve";
        approve.type = "button";
        approve.textContent = "Approve";
        approve.addEventListener("click", () => decide(request.requestId, "allow"));

        actions.append(approve, deny);
        if (request.approvalKind === "permission_request" && request.permissionSuggestions && request.permissionSuggestions.length) {
          const alwaysAllow = document.createElement("button");
          alwaysAllow.className = "refresh";
          alwaysAllow.type = "button";
          alwaysAllow.textContent = "Always Allow";
          alwaysAllow.addEventListener("click", () => {
            decide(request.requestId, "always_allow", "Always allow from local web UI");
          });
          actions.append(alwaysAllow);
        }
        card.append(head, meta, actions);
        return card;
      });

      requestsEl.replaceChildren(...cards);
    }

    async function loadRequests() {
      try {
        const response = await fetch("/pending-requests", { cache: "no-store" });
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        const data = await response.json();
        if (!socketConnected) {
          healthEl.textContent = "Connected to local daemon";
        }
        renderRequests(data.requests || []);
      } catch (error) {
        healthEl.textContent = "Daemon connection problem";
        requestsEl.innerHTML = "";
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Could not load pending requests: " + error.message;
        requestsEl.append(empty);
      }
    }

    async function loadSessions() {
      try {
        const response = await fetch("/sessions", { cache: "no-store" });
        if (!response.ok) {
          throw new Error("HTTP " + response.status);
        }
        const data = await response.json();
        renderSessions(data.sessions || []);
      } catch (error) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "Could not load session states: " + error.message;
        sessionsEl.replaceChildren(empty);
      }
    }

    async function refreshDashboard() {
      await Promise.all([loadSessions(), loadRequests()]);
    }

    async function decide(requestId, decision, reason, extra) {
      setToast("Sending " + decision + " for " + requestId + "...");
      const payload = {
        type: "permission_decision",
        requestId,
        decision,
        reason: reason || (decision === "allow" ? "Approved from local web UI" : "Denied from local web UI")
      };
      Object.assign(payload, extra || {});

      if (socketConnected && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
        return;
      }

      const response = await fetch("/permission-decisions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setToast(body.error || "Decision failed");
        return;
      }

      setToast("Decision sent: " + decision + " for " + requestId);
      await refreshDashboard();
    }

    async function showPairingToken() {
      try {
        const response = await fetch("/pairing-token", { cache: "no-store" });
        const body = await response.json();
        if (!response.ok) {
          setToast(body.error || "Could not create pairing token");
          return;
        }
        setToast("Pairing token: " + body.pairingToken + " · expires " + body.expiresAt);
      } catch (error) {
        setToast("Could not create pairing token: " + error.message);
      }
    }

    function connectWebSocket() {
      const scheme = window.location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(scheme + "://" + window.location.host + "/ws");

      socket.addEventListener("open", () => {
        socketConnected = true;
        healthEl.textContent = "Connected to local daemon";
        transportEl.textContent = "WebSocket realtime";
        setToast("");
      });

      socket.addEventListener("message", (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (error) {
          return;
        }

        if (message.type === "hello") {
          renderSessions(message.sessions || []);
          renderRequests(message.requests || []);
          return;
        }

        if (message.type === "pending_requests_snapshot") {
          renderRequests(message.requests || []);
          return;
        }

        if (message.type === "session_states_snapshot") {
          renderSessions(message.sessions || []);
          return;
        }

        if (message.type === "permission_request") {
          refreshDashboard();
          return;
        }

        if (message.type === "permission_decision_result") {
          setToast("Decision sent: " + message.decision + " for " + message.requestId);
          return;
        }

        if (message.type === "error") {
          setToast(message.error || "WebSocket error");
        }
      });

      socket.addEventListener("close", () => {
        socketConnected = false;
        transportEl.textContent = "HTTP fallback";
        setTimeout(connectWebSocket, 1200);
      });

      socket.addEventListener("error", () => {
        socketConnected = false;
        transportEl.textContent = "HTTP fallback";
      });
    }

    refreshBtn.addEventListener("click", refreshDashboard);
    pairingBtn.addEventListener("click", showPairingToken);
    connectWebSocket();
    refreshDashboard();
    setInterval(() => {
      if (!socketConnected) {
        refreshDashboard();
      }
    }, 1500);
  </script>
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
      const suggestion = request.permissionSuggestions.find((item) => item && item.behavior === "allow");
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

  pending.resolve({ decision, reason, answers: body.answers });
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

  pending.resolve({ decision, reason, answers: body.answers });
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

async function route(req, res) {
  if (req.method === "OPTIONS") {
    jsonResponse(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === "GET" && url.pathname === "/") {
    htmlResponse(res, approvalPageHtml());
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
  console.log("Open approval page: http://" + HOST + ":" + PORT + "/");
  console.log("Realtime events: ws://" + HOST + ":" + PORT + "/ws");
  console.log("Pairing token endpoint: http://" + HOST + ":" + PORT + "/pairing-token");
  console.log("Stage 0 endpoints: GET /health, POST /hook/pre-tool-use, POST /hook/permission-request, POST /hook/event, GET /sessions, GET /pending-requests, POST /permission-decisions");
});
