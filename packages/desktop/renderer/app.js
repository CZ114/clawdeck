const DAEMON_ORIGIN = "http://127.0.0.1:4317";
const WS_URL = "ws://127.0.0.1:4317/ws";

const STATUS_META = {
  idle: { emoji: "\u{1F4A4}", label: "Idle" },
  thinking: { emoji: "\u{1F914}", label: "Thinking" },
  running_tool: { emoji: "\u2699\uFE0F", label: "Running" },
  waiting_approval: { emoji: "\u{1F7E1}", label: "Approval" },
  waiting_answer: { emoji: "\u2753", label: "Question" },
  done: { emoji: "\u2705", label: "Done" },
  failed: { emoji: "\u26A0\uFE0F", label: "Failed" },
  blocked: { emoji: "\u26D4", label: "Blocked" },
  offline: { emoji: "\u{1F50C}", label: "Offline" }
};

const state = {
  socket: null,
  connected: false,
  sessions: [],
  requests: [],
  selectedAnswers: {},
  mode: "compact"
};

const els = {
  island: document.querySelector(".island"),
  statusEmoji: document.getElementById("statusEmoji"),
  statusText: document.getElementById("statusText"),
  statusDetail: document.getElementById("statusDetail"),
  contextLabel: document.getElementById("contextLabel"),
  contextFill: document.getElementById("contextFill"),
  requestPanel: document.getElementById("requestPanel"),
  requestKind: document.getElementById("requestKind"),
  requestTool: document.getElementById("requestTool"),
  requestRisk: document.getElementById("requestRisk"),
  requestSummary: document.getElementById("requestSummary"),
  requestCwd: document.getElementById("requestCwd"),
  requestReason: document.getElementById("requestReason"),
  answerForm: document.getElementById("answerForm"),
  approvalActions: document.getElementById("approvalActions"),
  approveRequest: document.getElementById("approveRequest"),
  alwaysAllowRequest: document.getElementById("alwaysAllowRequest"),
  denyRequest: document.getElementById("denyRequest"),
  refreshNow: document.getElementById("refreshNow"),
  openDashboard: document.getElementById("openDashboard"),
  minimizeWindow: document.getElementById("minimizeWindow"),
  closeWindow: document.getElementById("closeWindow")
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
    return "#ff6b6b";
  }
  if (percent >= 65) {
    return "#ffd166";
  }
  return "#42d392";
}

function renderContext(contextUsage) {
  const percent = Math.round(contextUsage.percent || 0);
  const color = colorForContext(percent);
  document.documentElement.style.setProperty("--context-color", color);
  document.documentElement.style.setProperty("--context-angle", `${percent * 3.6}deg`);
  els.contextFill.style.width = `${percent}%`;
  els.contextLabel.textContent = contextUsage.label || `ctx ${percent}%`;
}

function renderStatus(status, detail, contextUsage) {
  const meta = STATUS_META[status] || STATUS_META.idle;
  els.island.dataset.status = status;
  els.statusEmoji.textContent = meta.emoji;
  els.statusText.textContent = meta.label;
  els.statusDetail.textContent = detail || "";
  renderContext(contextUsage);
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

  if (!request) {
    els.requestPanel.hidden = true;
    setMode("compact");
    return;
  }

  const question = isQuestionRequest(request);
  els.requestPanel.hidden = false;
  els.requestKind.textContent = question ? "question" : "approval";
  els.requestTool.textContent = request.tool || "Tool request";
  els.requestRisk.textContent = request.risk || "low";
  els.requestRisk.dataset.risk = request.risk || "low";
  els.requestSummary.textContent = request.summary || "";
  els.requestCwd.textContent = request.cwd || "";
  els.requestReason.textContent = request.reason || "";
  els.answerForm.hidden = !question;
  els.approvalActions.hidden = question;
  els.alwaysAllowRequest.hidden = !(
    request.approvalKind === "permission_request" &&
    Array.isArray(request.permissionSuggestions) &&
    request.permissionSuggestions.length
  );

  if (question) {
    renderAnswerForm(request);
    setMode("question");
  } else {
    els.answerForm.replaceChildren();
    setMode("approval");
  }
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

function render() {
  renderSession();
  renderRequest();
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
  render();
}

function connectSocket() {
  const socket = new WebSocket(WS_URL);
  state.socket = socket;

  socket.addEventListener("open", () => {
    state.connected = true;
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

els.alwaysAllowRequest.addEventListener("click", () => {
  const requestId = currentRequestId();
  if (requestId) {
    decide(requestId, "always_allow", "Always allow from desktop companion");
  }
});

els.denyRequest.addEventListener("click", () => {
  const requestId = currentRequestId();
  if (!requestId) {
    return;
  }
  const reason = window.prompt("Deny reason", "Denied from desktop companion");
  if (reason !== null) {
    decide(requestId, "deny", reason);
  }
});

els.refreshNow.addEventListener("click", refresh);
els.openDashboard.addEventListener("click", () => window.companionDesktop.openDashboard());
els.minimizeWindow.addEventListener("click", () => window.companionDesktop.minimize());
els.closeWindow.addEventListener("click", () => window.companionDesktop.close());

window.companionDesktop.onModeChanged((mode) => {
  state.mode = mode;
  document.body.dataset.mode = mode;
});

connectSocket();
refresh();
setInterval(() => {
  if (!state.connected) {
    refresh();
  }
}, 1800);
