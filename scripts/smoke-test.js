#!/usr/bin/env node

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PORT = 54317;
const SMOKE_DATA_DIR = path.join(os.tmpdir(), "claude-code-companion-smoke-" + process.pid);
const ENV = {
  ...process.env,
  CCC_PORT: String(PORT),
  CCC_APPROVAL_TIMEOUT_MS: "5000",
  CCC_DATA_DIR: SMOKE_DATA_DIR,
  // Override the disabled-flag path so flipping the switch in tests
  // doesn't touch the user's real ~/.claude-companion/disabled.
  CCC_COMPANION_DISABLED_FLAG: path.join(SMOKE_DATA_DIR, "disabled"),
  CCC_MODEL_CONTEXT_WINDOWS: JSON.stringify({
    "smoke-custom-model": 123456
  }),
  // Force the cards generator to use the seeded stub deck — smoke must
  // not spawn the real `claude` CLI (CI doesn't have it installed).
  CCC_CARDS_USE_STUB: "true"
};

function request(method, pathname, body) {
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: pathname,
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload)
            }
          : {}
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`${method} ${pathname} -> ${res.statusCode}: ${data}`));
            return;
          }
          const contentType = String(res.headers["content-type"] || "");
          if (contentType.includes("application/json")) {
            resolve(data ? JSON.parse(data) : {});
            return;
          }
          resolve(data);
        });
      }
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function waitForHealth() {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(async () => {
      try {
        await request("GET", "/health");
        clearInterval(timer);
        resolve();
      } catch (error) {
        if (Date.now() - started > 5000) {
          clearInterval(timer);
          reject(error);
        }
      }
    }, 100);
  });
}

function decodeServerFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }

  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < 4) {
      return null;
    }
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) {
      return null;
    }
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }

  if (buffer.length < offset + length) {
    return null;
  }

  if (opcode !== 0x1) {
    return null;
  }

  return buffer.subarray(offset, offset + length).toString("utf8");
}

function waitForWebSocketHello(token) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const socket = net.createConnection({ host: "127.0.0.1", port: PORT });
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for WebSocket hello"));
    }, 5000);

    socket.on("connect", () => {
      const pathAndQuery = token ? "/ws?token=" + encodeURIComponent(token) : "/ws";
      socket.write(
        [
          "GET " + pathAndQuery + " HTTP/1.1",
          "Host: 127.0.0.1:" + PORT,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: " + key,
          "Sec-WebSocket-Version: 13",
          "",
          ""
        ].join("\r\n")
      );
    });

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);

      if (!upgraded) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          return;
        }

        const headers = buffer.subarray(0, headerEnd).toString("utf8");
        if (!headers.includes("101 Switching Protocols")) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error("WebSocket upgrade failed: " + headers));
          return;
        }

        buffer = buffer.subarray(headerEnd + 4);
        upgraded = true;
      }

      const frame = decodeServerFrame(buffer);
      if (!frame) {
        return;
      }

      const message = JSON.parse(frame);
      clearTimeout(timer);
      socket.end();
      resolve(message);
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

// Post directly to the daemon's HTTP hook endpoint — same call shape
// Claude Code uses for `"type":"http"` hooks, so this exercises the
// production path without spawning a separate hook process.
function postHook(endpoint, input, opts = {}) {
  const payload = JSON.stringify(input);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: `/hook/${endpoint}`,
        method: "POST",
        timeout: opts.timeout || 30000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload)
        }
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`POST /hook/${endpoint} -> ${res.statusCode}: ${data}`));
            return;
          }
          try {
            resolve(JSON.parse(data));
          } catch (_error) {
            resolve(data);
          }
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`POST /hook/${endpoint} timed out after ${opts.timeout || 30000}ms`));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function setCompanionDisabled(on) {
  const flagPath = ENV.CCC_COMPANION_DISABLED_FLAG;
  fs.mkdirSync(path.dirname(flagPath), { recursive: true });
  if (on) {
    fs.writeFileSync(flagPath, "1", "utf8");
  } else if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
}

function runCli(scriptPath, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: ROOT,
      env: ENV,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`CLI exited ${code}: ${stderr || stdout}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function pendingCount() {
  const pending = await request("GET", "/pending-requests");
  return pending.requests.length;
}

// Counts entries that own a managed HTTP hook for the given endpoint.
// Accepts either a script name like "event.js" (legacy callsite) or an
// endpoint slug like "event" so existing assertions keep reading well.
function countHookEntries(settings, eventName, endpointOrScript) {
  const endpoint = String(endpointOrScript || "").replace(/\.js$/, "");
  const entries = (settings.hooks && settings.hooks[eventName]) || [];
  return entries.filter((entry) => {
    return Array.isArray(entry.hooks) && entry.hooks.some((hook) => {
      if (!hook || hook.type !== "http") return false;
      return String(hook.url || "").endsWith(`/hook/${endpoint}`);
    });
  }).length;
}

async function verifySetupHooksCli() {
  const targetRepo = path.join(ENV.CCC_DATA_DIR, "setup-hooks-target");
  const claudeDir = path.join(targetRepo, ".claude");
  const settingsPath = path.join(claudeDir, "settings.local.json");
  fs.rmSync(targetRepo, { recursive: true, force: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        permissions: {
          ask: ["Read"],
          deny: ["Read(secret.md)"]
        },
        hooks: {
          PreToolUse: [
            {
              matcher: "Read",
              hooks: [
                {
                  type: "command",
                  command: "node keep-existing-hook.js"
                }
              ]
            }
          ]
        }
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  await runCli("scripts/setup-hooks.js", [targetRepo]);
  const first = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  for (const rule of ["Read", "Bash", "PowerShell"]) {
    if (!first.permissions.ask.includes(rule)) {
      throw new Error(`Expected setup-hooks to preserve/add ask rule ${rule}`);
    }
  }
  for (const rule of ["Read(secret.md)", "Read(./.env)", "Read(./.env.*)", "Read(./secrets/**)"]) {
    if (!first.permissions.deny.includes(rule)) {
      throw new Error(`Expected setup-hooks to preserve/add deny rule ${rule}`);
    }
  }
  if (countHookEntries(first, "PreToolUse", "event.js") !== 1) {
    throw new Error("Expected one managed PreToolUse status hook");
  }
  if (countHookEntries(first, "PreToolUse", "pre-tool-use.js") !== 1) {
    throw new Error("Expected one managed AskUserQuestion hook");
  }
  if (countHookEntries(first, "PermissionRequest", "permission-request.js") !== 1) {
    throw new Error("Expected one managed PermissionRequest hook");
  }
  const existingHookStillThere = first.hooks.PreToolUse.some((entry) => {
    return Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook.command === "node keep-existing-hook.js");
  });
  if (!existingHookStillThere) {
    throw new Error("Expected setup-hooks to preserve unrelated existing hooks");
  }

  const beforeSecondRun = JSON.stringify(first);
  await runCli("scripts/setup-hooks.js", [targetRepo]);
  const second = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (JSON.stringify(second) !== beforeSecondRun) {
    throw new Error("Expected setup-hooks to be idempotent");
  }

  const statusOnlyRepo = path.join(ENV.CCC_DATA_DIR, "setup-hooks-status-only-target");
  fs.rmSync(statusOnlyRepo, { recursive: true, force: true });
  fs.mkdirSync(statusOnlyRepo, { recursive: true });
  await runCli("scripts/setup-hooks.js", [statusOnlyRepo, "--status-only"]);
  const statusOnly = JSON.parse(
    fs.readFileSync(path.join(statusOnlyRepo, ".claude", "settings.local.json"), "utf8")
  );
  if (countHookEntries(statusOnly, "UserPromptSubmit", "event.js") !== 1) {
    throw new Error("Expected status-only setup to install status hooks");
  }
  if (countHookEntries(statusOnly, "PermissionRequest", "permission-request.js") !== 0) {
    throw new Error("Expected status-only setup to omit permission request hooks");
  }

  const approvalOnlyRepo = path.join(ENV.CCC_DATA_DIR, "setup-hooks-approval-only-target");
  fs.rmSync(approvalOnlyRepo, { recursive: true, force: true });
  fs.mkdirSync(approvalOnlyRepo, { recursive: true });
  await runCli("scripts/setup-hooks.js", [approvalOnlyRepo, "--approval-only"]);
  const approvalOnly = JSON.parse(
    fs.readFileSync(path.join(approvalOnlyRepo, ".claude", "settings.local.json"), "utf8")
  );
  if (countHookEntries(approvalOnly, "UserPromptSubmit", "event.js") !== 0) {
    throw new Error("Expected approval-only setup to omit lifecycle status hooks");
  }
  if (countHookEntries(approvalOnly, "PermissionRequest", "permission-request.js") !== 1) {
    throw new Error("Expected approval-only setup to install permission request hook");
  }

  await runCli("scripts/setup-hooks.js", [targetRepo, "--disable"]);
  const disabled = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (!disabled.permissions.ask.includes("Read") || !disabled.permissions.deny.includes("Read(secret.md)")) {
    throw new Error("Expected disable setup to preserve permissions");
  }
  if (countHookEntries(disabled, "PreToolUse", "event.js") !== 0) {
    throw new Error("Expected disable setup to remove managed status hook");
  }
  if (countHookEntries(disabled, "PreToolUse", "pre-tool-use.js") !== 0) {
    throw new Error("Expected disable setup to remove managed AskUserQuestion hook");
  }
  if (countHookEntries(disabled, "PermissionRequest", "permission-request.js") !== 0) {
    throw new Error("Expected disable setup to remove managed PermissionRequest hook");
  }
  const existingHookStillThereAfterDisable = disabled.hooks.PreToolUse.some((entry) => {
    return Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook.command === "node keep-existing-hook.js");
  });
  if (!existingHookStillThereAfterDisable) {
    throw new Error("Expected disable setup to preserve unrelated existing hooks");
  }
}

async function waitForPending() {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const pending = await request("GET", "/pending-requests");
    if (pending.requests.length > 0) {
      return pending.requests[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("No pending request appeared");
}

async function waitForSessionStatus(sessionId, status) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const body = await request("GET", "/sessions");
    const session = body.sessions.find((item) => item.sessionId === sessionId);
    if (session && (!status || session.status === status)) {
      return session;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No session state ${status || "any"} appeared for ${sessionId}`);
}

function writeTranscriptUsage(transcriptPath, model, usage) {
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  fs.writeFileSync(
    transcriptPath,
    JSON.stringify({
      type: "assistant",
      message: {
        model,
        usage
      }
    }) + "\n",
    "utf8"
  );
}

async function main() {
  const daemon = spawn(process.execPath, ["packages/daemon/src/index.js"], {
    cwd: ROOT,
    env: ENV,
    stdio: ["ignore", "pipe", "pipe"]
  });

  daemon.stdout.on("data", (chunk) => process.stdout.write(`[daemon] ${chunk}`));
  daemon.stderr.on("data", (chunk) => process.stderr.write(`[daemon] ${chunk}`));

  try {
    await waitForHealth();
    await verifySetupHooksCli();

    // Companion-disabled flag: when ~/.claude-companion/disabled exists,
    // the daemon must return noop decisions for every hook endpoint and
    // skip session-state recording — Claude Code falls back to its
    // native prompt without going through us.
    setCompanionDisabled(true);
    try {
      const disabledPrePendingBefore = await pendingCount();
      const disabledPreOutput = await postHook("pre-tool-use", {
        session_id: "sess_smoke_disabled_pre",
        transcript_path: "C:/tmp/transcript-disabled-pre.jsonl",
        cwd: ROOT,
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "Disabled question?",
              header: "Disabled",
              options: [{ label: "Yes" }],
              multiSelect: false
            }
          ]
        }
      });
      if (!disabledPreOutput.suppressOutput || disabledPreOutput.hookSpecificOutput) {
        throw new Error("Expected disabled-flag PreToolUse to return noop");
      }
      if ((await pendingCount()) !== disabledPrePendingBefore) {
        throw new Error("Expected disabled-flag PreToolUse not to create a pending request");
      }

      const disabledPermissionPendingBefore = await pendingCount();
      const disabledPermissionOutput = await postHook("permission-request", {
        session_id: "sess_smoke_disabled_permission",
        transcript_path: "C:/tmp/transcript-disabled-permission.jsonl",
        cwd: ROOT,
        permission_mode: "default",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "npm run lint" }
      });
      if (!disabledPermissionOutput.suppressOutput || disabledPermissionOutput.hookSpecificOutput) {
        throw new Error("Expected disabled-flag PermissionRequest to return noop");
      }
      if ((await pendingCount()) !== disabledPermissionPendingBefore) {
        throw new Error("Expected disabled-flag PermissionRequest not to create a pending request");
      }

      const disabledEventOutput = await postHook("event", {
        session_id: "sess_smoke_status_disabled",
        transcript_path: "C:/tmp/transcript-status-disabled.jsonl",
        cwd: ROOT,
        hook_event_name: "UserPromptSubmit",
        prompt: "This status should not be recorded"
      });
      if (!disabledEventOutput.suppressOutput) {
        throw new Error("Expected disabled-flag event hook to return noop");
      }
      const disabledSessions = await request("GET", "/sessions");
      if (disabledSessions.sessions.some((item) => item.sessionId === "sess_smoke_status_disabled")) {
        throw new Error("Expected disabled-flag event not to create a session state");
      }
    } finally {
      setCompanionDisabled(false);
    }

    const approvalPage = await request("GET", "/");
    if (!String(approvalPage).includes("Vibedog-for-agents")) {
      throw new Error("Approval page did not render expected title");
    }

    const hello = await waitForWebSocketHello();
    if (hello.type !== "hello") {
      throw new Error(`Expected WebSocket hello, received ${hello.type}`);
    }
    if (!Array.isArray(hello.sessions)) {
      throw new Error("Expected WebSocket hello to include session states");
    }

    const pairing = await request("GET", "/pairing-token");
    if (!pairing.pairingToken) {
      throw new Error("Expected pairing token");
    }

    const paired = await request("POST", "/pair", {
      pairingToken: pairing.pairingToken,
      deviceName: "Smoke Test iPhone"
    });
    if (!paired.authToken || !paired.deviceId) {
      throw new Error("Expected paired device credentials");
    }

    const authenticatedHello = await waitForWebSocketHello(paired.authToken);
    if (authenticatedHello.device.deviceName !== "Smoke Test iPhone") {
      throw new Error("Expected authenticated WebSocket hello for paired device");
    }

    const promptHookOutput = await postHook("event", {
      session_id: "sess_smoke_status",
      transcript_path: "C:/tmp/transcript-status.jsonl",
      cwd: ROOT,
      hook_event_name: "UserPromptSubmit",
      prompt: "Build a tiny status smoke test"
    });
    if (!promptHookOutput.suppressOutput) {
      throw new Error("Expected status event hook to suppress output");
    }

    const thinkingState = await waitForSessionStatus("sess_smoke_status", "thinking");
    if (!thinkingState.summary.includes("Build a tiny status smoke test")) {
      throw new Error("Expected UserPromptSubmit summary in session state");
    }

    const oneMillionTranscript = path.join(ENV.CCC_DATA_DIR, "transcript-context-1m.jsonl");
    writeTranscriptUsage(oneMillionTranscript, "smoke-context-model[1m]", {
      input_tokens: 100000
    });
    await postHook("event", {
      session_id: "sess_smoke_context_1m",
      transcript_path: oneMillionTranscript,
      cwd: ROOT,
      hook_event_name: "UserPromptSubmit",
      prompt: "Check 1m context"
    });
    const oneMillionState = await waitForSessionStatus("sess_smoke_context_1m", "thinking");
    if (!oneMillionState.contextUsage || oneMillionState.contextUsage.maxTokens !== 1000000) {
      throw new Error("Expected [1m] model id to resolve a 1,000,000 token context window");
    }
    if (oneMillionState.contextUsage.windowSource !== "model-id" || oneMillionState.contextUsage.windowRule !== "1m") {
      throw new Error("Expected [1m] context window source metadata");
    }

    const overrideTranscript = path.join(ENV.CCC_DATA_DIR, "transcript-context-override.jsonl");
    writeTranscriptUsage(overrideTranscript, "smoke-custom-model-beta", {
      input_tokens: 12345
    });
    await postHook("event", {
      session_id: "sess_smoke_context_override",
      transcript_path: overrideTranscript,
      cwd: ROOT,
      hook_event_name: "UserPromptSubmit",
      prompt: "Check model override context"
    });
    const overrideState = await waitForSessionStatus("sess_smoke_context_override", "thinking");
    if (!overrideState.contextUsage || overrideState.contextUsage.maxTokens !== 123456) {
      throw new Error("Expected CCC_MODEL_CONTEXT_WINDOWS to override context window");
    }
    if (overrideState.contextUsage.windowSource !== "model-override") {
      throw new Error("Expected context window source to report model-override");
    }

    await postHook("event", {
      session_id: "sess_smoke_status",
      transcript_path: "C:/tmp/transcript-status.jsonl",
      cwd: ROOT,
      hook_event_name: "PreToolUse",
      tool_name: "Read",
      tool_input: {
        file_path: path.join(ROOT, "README.md")
      }
    });
    await waitForSessionStatus("sess_smoke_status", "running_tool");

    await postHook("event", {
      session_id: "sess_smoke_status",
      transcript_path: "C:/tmp/transcript-status.jsonl",
      cwd: ROOT,
      hook_event_name: "PostToolUse",
      tool_name: "Read",
      tool_input: {
        file_path: path.join(ROOT, "README.md")
      },
      tool_response: {
        success: true
      }
    });
    await waitForSessionStatus("sess_smoke_status", "thinking");

    await postHook("event", {
      session_id: "sess_smoke_status",
      transcript_path: "C:/tmp/transcript-status.jsonl",
      cwd: ROOT,
      hook_event_name: "Notification",
      message: "Claude is waiting for your input"
    });
    await waitForSessionStatus("sess_smoke_status", "waiting");

    await postHook("event", {
      session_id: "sess_smoke_status",
      transcript_path: "C:/tmp/transcript-status.jsonl",
      cwd: ROOT,
      hook_event_name: "Stop"
    });
    await waitForSessionStatus("sess_smoke_status", "done");

    await postHook("event", {
      session_id: "sess_smoke_status_failure",
      transcript_path: "C:/tmp/transcript-status-failure.jsonl",
      cwd: ROOT,
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: {
        command: "npm test"
      },
      error: "Command failed"
    });
    await waitForSessionStatus("sess_smoke_status_failure", "failed");

    const hookPromise = postHook("pre-tool-use", {
      session_id: "sess_smoke",
      transcript_path: "C:/tmp/transcript.jsonl",
      cwd: ROOT,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: {
        command: "npm test"
      }
    });

    const pending = await waitForPending();
    if (pending.risk !== "low") {
      throw new Error(`Expected low risk for npm test, received ${pending.risk}`);
    }
    await waitForSessionStatus("sess_smoke", "waiting_approval");

    await request("POST", "/permission-decisions", {
      requestId: pending.requestId,
      decision: "allow",
      reason: "Smoke test approved"
    });
    await waitForSessionStatus("sess_smoke", "running_tool");

    const output = await hookPromise;
    const decision = output.hookSpecificOutput && output.hookSpecificOutput.permissionDecision;
    if (decision !== "allow") {
      throw new Error(`Expected allow decision, received ${decision}`);
    }

    const permissionHookPromise = postHook("permission-request", {
      session_id: "sess_smoke_native",
      transcript_path: "C:/tmp/transcript-native.jsonl",
      cwd: ROOT,
      permission_mode: "default",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: {
        command: "npm run lint",
        description: "Run lint"
      },
      permission_suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "npm run lint" }],
          behavior: "allow",
          destination: "localSettings"
        }
      ]
    });

    const nativePending = await waitForPending();
    if (nativePending.approvalKind !== "permission_request") {
      throw new Error(`Expected native permission request, received ${nativePending.approvalKind}`);
    }
    await waitForSessionStatus("sess_smoke_native", "waiting_approval");

    await request("POST", "/permission-decisions", {
      requestId: nativePending.requestId,
      decision: "always_allow",
      reason: "Smoke test always allow"
    });
    await waitForSessionStatus("sess_smoke_native", "running_tool");

    const nativeOutput = await permissionHookPromise;
    const nativeDecision = nativeOutput.hookSpecificOutput && nativeOutput.hookSpecificOutput.decision;
    if (!nativeDecision || nativeDecision.behavior !== "allow") {
      throw new Error("Expected PermissionRequest allow decision");
    }
    if (!nativeDecision.updatedPermissions || nativeDecision.updatedPermissions.length !== 1) {
      throw new Error("Expected PermissionRequest updatedPermissions for always_allow");
    }

    const powershellPermissionHookPromise = postHook("permission-request", {
      session_id: "sess_smoke_native_powershell",
      transcript_path: "C:/tmp/transcript-native-powershell.jsonl",
      cwd: ROOT,
      permission_mode: "default",
      hook_event_name: "PermissionRequest",
      tool_name: "PowerShell",
      tool_input: {
        command: "New-Item -ItemType Directory -Path \"D:\\Imperial\\individual\\week14\\test\" -Force",
        description: "Create test folder"
      },
      permission_suggestions: [
        {
          type: "addRules",
          rules: [
            {
              toolName: "PowerShell",
              ruleContent: "New-Item -ItemType Directory -Path \"D:\\Imperial\\individual\\week14\\test\" -Force"
            }
          ],
          behavior: "allow",
          destination: "localSettings"
        }
      ]
    });

    const powershellPending = await waitForPending();
    if (powershellPending.tool !== "PowerShell") {
      throw new Error(`Expected PowerShell pending request, received ${powershellPending.tool}`);
    }
    if (powershellPending.risk !== "medium") {
      throw new Error(`Expected medium risk for PowerShell file mutation, received ${powershellPending.risk}`);
    }
    await waitForSessionStatus("sess_smoke_native_powershell", "waiting_approval");

    await request("POST", "/permission-decisions", {
      requestId: powershellPending.requestId,
      decision: "allow",
      reason: "Smoke test PowerShell approved"
    });
    await waitForSessionStatus("sess_smoke_native_powershell", "running_tool");

    const powershellOutput = await powershellPermissionHookPromise;
    const powershellDecision = powershellOutput.hookSpecificOutput && powershellOutput.hookSpecificOutput.decision;
    if (!powershellDecision || powershellDecision.behavior !== "allow") {
      throw new Error("Expected PowerShell PermissionRequest allow decision");
    }

    const questionHookPromise = postHook("pre-tool-use", {
      session_id: "sess_smoke_question",
      transcript_path: "C:/tmp/transcript-question.jsonl",
      cwd: ROOT,
      permission_mode: "default",
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_input: {
        questions: [
          {
            question: "Which implementation should I use?",
            header: "Impl",
            options: [
              { label: "Simple", description: "Use the smallest working path" },
              { label: "Robust", description: "Build extra validation now" }
            ],
            multiSelect: false
          }
        ]
      }
    });

    const questionPending = await waitForPending();
    if (questionPending.approvalKind !== "ask_user_question") {
      throw new Error(`Expected AskUserQuestion request, received ${questionPending.approvalKind}`);
    }
    if (!questionPending.questions || questionPending.questions.length !== 1) {
      throw new Error("Expected one AskUserQuestion question in pending request");
    }
    await waitForSessionStatus("sess_smoke_question", "waiting_answer");

    await request("POST", "/permission-decisions", {
      requestId: questionPending.requestId,
      decision: "answer",
      reason: "Smoke test question answered",
      answers: {
        "Which implementation should I use?": "Simple"
      }
    });
    await waitForSessionStatus("sess_smoke_question", "thinking");

    const questionOutput = await questionHookPromise;
    const questionDecision = questionOutput.hookSpecificOutput && questionOutput.hookSpecificOutput.permissionDecision;
    const updatedInput = questionOutput.hookSpecificOutput && questionOutput.hookSpecificOutput.updatedInput;
    if (questionDecision !== "allow") {
      throw new Error(`Expected AskUserQuestion allow decision, received ${questionDecision}`);
    }
    if (!updatedInput || !updatedInput.answers || updatedInput.answers["Which implementation should I use?"] !== "Simple") {
      throw new Error("Expected AskUserQuestion updatedInput answers");
    }
    if (!updatedInput.questions || updatedInput.questions.length !== 1) {
      throw new Error("Expected AskUserQuestion updatedInput to preserve questions");
    }

    await verifyCardsLifecycle();

    console.log("Smoke test passed.");
  } finally {
    daemon.kill();
  }
}

async function verifyCardsLifecycle() {
  // 1. Empty start: today is unseeded.
  const beforeGen = await request("GET", "/cards/today");
  if (!beforeGen.payload || beforeGen.payload.state !== "empty") {
    throw new Error(`Expected empty cards state before generation, got ${beforeGen.payload && beforeGen.payload.state}`);
  }
  if (beforeGen.payload.cards.length !== 0) {
    throw new Error("Expected zero cards before generation");
  }
  if (!beforeGen.generation || beforeGen.generation.state !== "idle") {
    throw new Error("Expected generation state idle before any /cards/generate call");
  }

  // 2. Stub generation populates today.json.
  const gen = await request("POST", "/cards/generate", {
    focus: "Electron IPC; OKLCH; hook timeout"
  });
  if (!gen.ok || !gen.stub || !gen.payload) {
    throw new Error("Expected stub generation to return ok/stub/payload");
  }
  if (gen.payload.state !== "ready") {
    throw new Error(`Expected generated payload state=ready, got ${gen.payload.state}`);
  }
  if (gen.payload.cards.length < 3) {
    throw new Error("Expected stub deck to have at least 3 cards");
  }
  if (gen.payload.focusSnapshot !== "Electron IPC; OKLCH; hook timeout") {
    throw new Error("Expected focus to round-trip into payload");
  }

  // 3. Today now reflects the deck.
  const afterGen = await request("GET", "/cards/today");
  if (afterGen.payload.state !== "ready") {
    throw new Error("Expected today state=ready after generation");
  }
  const choiceCard = afterGen.payload.cards.find((c) => c.type === "choice");
  const clozeCard  = afterGen.payload.cards.find((c) => c.type === "cloze");
  if (!choiceCard || !clozeCard) {
    throw new Error("Expected both a choice card and a cloze card in stub deck");
  }
  for (const card of afterGen.payload.cards) {
    if (!card.source || !card.source.snippet || !card.source.snippet.trim()) {
      throw new Error(`Card ${card.id} missing strict-source snippet`);
    }
  }

  // 4. Wrong answer enters the wrong book.
  const wrong = await request("POST", "/cards/answer", {
    cardId: choiceCard.id,
    picked: choiceCard.answer === 0 ? 3 : 0,
    durationMs: 1234
  });
  if (wrong.correct !== false) {
    throw new Error("Expected wrong answer to be reported as not correct");
  }
  const wrongBook1 = await request("GET", "/cards/wrong-book");
  if (!wrongBook1.entries || wrongBook1.entries.length !== 1 || wrongBook1.entries[0].cardId !== choiceCard.id) {
    throw new Error("Expected wrong book to contain the missed choice card");
  }
  if (wrongBook1.entries[0].consecutiveCorrect !== 0 || wrongBook1.entries[0].totalMisses !== 1) {
    throw new Error("Expected fresh wrong-book entry with 0 consecutive / 1 miss");
  }

  // 5. Two consecutive correct answers master a medium card and remove it
  //    from the wrong book.
  for (let i = 0; i < 2; i += 1) {
    const correct = await request("POST", "/cards/answer", {
      cardId: choiceCard.id,
      picked: choiceCard.answer
    });
    if (!correct.correct) {
      throw new Error(`Expected correct answer round ${i + 1} to be reported as correct`);
    }
  }
  const wrongBook2 = await request("GET", "/cards/wrong-book");
  if (wrongBook2.entries.length !== 0) {
    throw new Error("Expected medium card to leave the wrong book after 2 consecutive correct attempts");
  }

  // 6. Cloze validation: server compares trimmed strings.
  const cloze = await request("POST", "/cards/answer", {
    cardId: clozeCard.id,
    picked: ` ${clozeCard.answer} `
  });
  if (!cloze.correct) {
    throw new Error("Expected cloze answer to match after trim");
  }

  // 7. Unknown card id returns 404 cleanly.
  let unknownErr = null;
  try {
    await request("POST", "/cards/answer", { cardId: "card_does_not_exist", picked: "x" });
  } catch (error) {
    unknownErr = error;
  }
  if (!unknownErr || !/404/.test(unknownErr.message)) {
    throw new Error("Expected unknown card id to return HTTP 404");
  }

  // 8. History endpoint surfaces today's deck as a summary.
  const history = await request("GET", "/cards/history");
  if (!Array.isArray(history.history) || history.history.length === 0) {
    throw new Error("Expected history to surface today's deck");
  }
  const today = history.history[0];
  if (!today.title || !today.title.includes("Stage 1.5")) {
    throw new Error(`Expected history title to come from abstract h2, got ${JSON.stringify(today.title)}`);
  }
  if (today.difficultyMix.medium < 1 || today.difficultyMix.easy < 1 || today.difficultyMix.hard < 1) {
    throw new Error(`Expected difficulty mix to count all three tiers, got ${JSON.stringify(today.difficultyMix)}`);
  }

  // 9. /cards/history/<date> returns the full payload.
  const detail = await request("GET", `/cards/history/${today.date}`);
  if (!detail.payload || detail.payload.cards.length !== afterGen.payload.cards.length) {
    throw new Error("Expected history detail to match today's payload card count");
  }

  // 10. Generation status reflects the most recent run.
  const status = await request("GET", "/cards/generation-status");
  if (status.state !== "idle" || !status.finishedAt) {
    throw new Error(`Expected generation status idle with finishedAt set, got ${JSON.stringify(status)}`);
  }

  // 11. Wrong-book replay: a card that's only in the wrong book (not in
  //     today's deck) can still be answered, with the daemon scoring against
  //     the entry's snapshot and updating consecutiveCorrect. To set this
  //     up, deliberately miss a fresh medium card we haven't touched yet
  //     (the third stub card — hard difficulty), then verify replay works.
  const hardCard = afterGen.payload.cards.find((c) => c.difficulty === "hard");
  if (!hardCard) {
    throw new Error("Stub deck must contain a hard card for replay test");
  }
  await request("POST", "/cards/answer", {
    cardId: hardCard.id,
    picked: hardCard.answer === 0 ? 3 : 0
  });
  const wrongBook3 = await request("GET", "/cards/wrong-book");
  if (!wrongBook3.entries.some((e) => e.cardId === hardCard.id)) {
    throw new Error("Hard card should now be in the wrong book");
  }

  // Simulate today rolling over: drop today's deck file so the hard card is
  // ONLY reachable via the wrong-book lookup path.
  const todayDate = afterGen.payload.date;
  fs.unlinkSync(path.join(ENV.CCC_DATA_DIR, "cards", `${todayDate}.json`));
  const afterClear = await request("GET", "/cards/today");
  if (afterClear.payload.state !== "empty" || afterClear.payload.cards.length !== 0) {
    throw new Error("Expected today to be empty after clearing the day file");
  }

  // First replay attempt: wrong → consecutiveCorrect stays 0, totalMisses
  // increments.
  const replay1 = await request("POST", "/cards/answer", {
    cardId: hardCard.id,
    picked: hardCard.answer === 0 ? 3 : 0
  });
  if (replay1.replay !== true) {
    throw new Error(`Expected replay=true on wrong-book-only answer, got ${JSON.stringify(replay1)}`);
  }
  if (replay1.correct !== false) {
    throw new Error("Wrong replay attempt should be reported as not correct");
  }
  const wrongBook4 = await request("GET", "/cards/wrong-book");
  const entry4 = wrongBook4.entries.find((e) => e.cardId === hardCard.id);
  if (!entry4 || entry4.consecutiveCorrect !== 0 || entry4.totalMisses !== 2) {
    throw new Error(`Expected entry to track 2 misses / 0 consecutive after second wrong, got ${JSON.stringify(entry4)}`);
  }

  // 12. Hard mastery requires 3 consecutive correct (per ADR §"Decision 9").
  //     Two corrects shouldn't remove the entry yet.
  for (let i = 0; i < 2; i += 1) {
    const r = await request("POST", "/cards/answer", {
      cardId: hardCard.id,
      picked: hardCard.answer
    });
    if (!r.replay || !r.correct) {
      throw new Error(`Expected replay+correct on round ${i + 1}, got ${JSON.stringify(r)}`);
    }
  }
  const wrongBook5 = await request("GET", "/cards/wrong-book");
  const entry5 = wrongBook5.entries.find((e) => e.cardId === hardCard.id);
  if (!entry5 || entry5.consecutiveCorrect !== 2) {
    throw new Error(`Hard card should still be in book after 2 corrects (need 3), got ${JSON.stringify(entry5)}`);
  }

  // The 3rd correct triggers mastery and removes the entry.
  await request("POST", "/cards/answer", {
    cardId: hardCard.id,
    picked: hardCard.answer
  });
  const wrongBook6 = await request("GET", "/cards/wrong-book");
  if (wrongBook6.entries.some((e) => e.cardId === hardCard.id)) {
    throw new Error("Hard card should be removed after 3 consecutive corrects");
  }

  // 13. Unknown card id (not in today, not in wrong book) still returns 404.
  let stillUnknownErr = null;
  try {
    await request("POST", "/cards/answer", { cardId: "card_truly_unknown", picked: "x" });
  } catch (error) {
    stillUnknownErr = error;
  }
  if (!stillUnknownErr || !/404/.test(stillUnknownErr.message)) {
    throw new Error("Expected unknown card id (no today, no wrong-book) to return 404");
  }

  // 14. Transcript index — when a hook event includes transcript_path, the
  //     daemon records it to ~/.claude-companion/transcript-index.json so
  //     the cards generator (Slice 3B) can later pull real session content
  //     into the prompt.
  await verifyTranscriptIndex();

  // 15. Re-generation for the same date archives the prior deck instead of
  //     silently overwriting. The new file lands at <date>.json, the old
  //     one at <date>-HHMMSS.json, and history surfaces both rows.
  await verifySameDayArchive();
}

async function verifySameDayArchive() {
  // Step #5 above deletes today's deck to simulate empty-day fallback;
  // re-seed it here so we have a canonical file to archive in step #15.
  await request("POST", "/cards/generate", { focus: "first pass for archive test" });

  const cardsDir = path.join(ENV.CCC_DATA_DIR, "cards");
  const filesBefore = fs.readdirSync(cardsDir);
  const dateOnlyBefore = filesBefore.filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
  if (dateOnlyBefore.length !== 1) {
    throw new Error(`Expected exactly 1 canonical date file before re-gen, found ${dateOnlyBefore.length}: ${dateOnlyBefore.join(", ")}`);
  }
  const todayFile = dateOnlyBefore[0];
  const beforePayload = JSON.parse(fs.readFileSync(path.join(cardsDir, todayFile), "utf8"));

  // Force the existing file's updatedAt back by 1 second so the new gen's
  // timestamp differs (the archive name uses HHMMSS — same-second writes
  // collide and trigger the suffix path; we want a clean test).
  const backdated = {
    ...beforePayload,
    updatedAt: new Date(Date.parse(beforePayload.updatedAt) - 2000).toISOString()
  };
  fs.writeFileSync(path.join(cardsDir, todayFile), JSON.stringify(backdated, null, 2) + "\n", "utf8");

  // Re-generate.
  const regen = await request("POST", "/cards/generate", {
    focus: "second pass for archive test"
  });
  if (!regen.ok || !regen.payload) {
    throw new Error("Re-generation should still return ok + payload");
  }

  // After: one canonical + at least one archive for today's date.
  const filesAfter = fs.readdirSync(cardsDir);
  const dateOnlyAfter = filesAfter.filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
  const archiveAfter = filesAfter.filter((n) => /^\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.json$/.test(n));
  if (dateOnlyAfter.length !== dateOnlyBefore.length) {
    throw new Error(`Canonical date file count changed unexpectedly: ${dateOnlyBefore.length} → ${dateOnlyAfter.length}`);
  }
  if (archiveAfter.length < 1) {
    throw new Error(`Expected at least 1 archive file after re-gen, found 0`);
  }

  // History should now list both — the canonical (updated) AND the archive.
  const history = await request("GET", "/cards/history");
  const todayDate = beforePayload.date;
  const sameDateRows = (history.history || []).filter((h) => h.date === todayDate);
  if (sameDateRows.length < 2) {
    throw new Error(`History should surface both current + archived for ${todayDate}; got ${sameDateRows.length}`);
  }
  const hasArchiveRow = sameDateRows.some((h) => h.isArchive === true && /^\d{2}:\d{2}:\d{2}$/.test(String(h.archivedAt || "")));
  if (!hasArchiveRow) {
    throw new Error("Expected at least one archive row with isArchive=true and archivedAt formatted as HH:MM:SS");
  }

  // /cards/history/<date>?archive=<HHMMSS> returns the archived payload.
  const archiveRow = sameDateRows.find((h) => h.isArchive);
  const archiveId = archiveRow.archivedAt.replace(/:/g, "");
  const archived = await request("GET", `/cards/history/${todayDate}?archive=${archiveId}`);
  if (!archived.payload || archived.payload.date !== todayDate) {
    throw new Error("Archive detail endpoint did not return the archived payload");
  }
  // The archived content must match the pre-regen content (same cards).
  if (archived.payload.cards.length !== beforePayload.cards.length) {
    throw new Error(`Archive payload card count ${archived.payload.cards.length} doesn't match pre-regen ${beforePayload.cards.length}`);
  }

  // 16. History-replay path — answering a card sourced from a historical
  //     day routes through recordHistoryAttempt: scoring works, miss
  //     feeds the wrong book, but the historical file itself is read-only
  //     (no attempts array on the snapshot card).
  const histCard = archived.payload.cards[0];
  const wrongAnswer = histCard.answer === 0 ? 3 : 0;
  const histResult = await request("POST", "/cards/answer", {
    cardId: histCard.id,
    picked: wrongAnswer,
    historyDate: todayDate,
    historyArchiveId: archiveId
  });
  if (histResult.replay !== true) {
    throw new Error("Expected replay=true on history-replay answer");
  }
  if (histResult.correct !== false) {
    throw new Error("Expected wrong history-replay answer to be reported as not correct");
  }
  // Wrong book should now contain the missed historical card.
  const wrongBookAfterHist = await request("GET", "/cards/wrong-book");
  if (!wrongBookAfterHist.entries.some((e) => e.cardId === histCard.id)) {
    throw new Error("Expected missed historical card to land in the wrong book");
  }
  // Historical snapshot stays read-only — its card.attempts must NOT have
  // grown from the replay (the wrong-book carries the attempt instead).
  const archivedAgain = await request("GET", `/cards/history/${todayDate}?archive=${archiveId}`);
  const sameCardInArchive = archivedAgain.payload.cards.find((c) => c.id === histCard.id);
  if (sameCardInArchive && Array.isArray(sameCardInArchive.attempts) && sameCardInArchive.attempts.length > 0) {
    throw new Error("Historical snapshot was mutated by history-replay (should be read-only)");
  }

  // 17. Markdown export — three scopes, all return text/markdown with
  //     the documented frontmatter + body shape.
  await verifyMarkdownExport(todayDate, archiveId);

  // 18. Consent endpoints — stores user's opt-in for piping transcripts
  //     to the claude subprocess. (Generate gating is skipped in stub
  //     mode, so we test the endpoints in isolation.)
  await verifyConsent();

  // 19. Transcript scanner — direct unit-style test against a fake
  //     ~/.claude/projects/ tree, plus storage-config round-trip via
  //     the daemon endpoints. (Scanner integration into /cards/generate
  //     is implicitly exercised by the stub deck path even though stub
  //     itself doesn't read transcripts.)
  await verifyScannerAndStorage();
}

async function verifyScannerAndStorage() {
  // Fake `~/.claude/projects/` layout under a sibling temp dir, then
  // call the scanner directly with that root.
  const fakeRoot = path.join(ENV.CCC_DATA_DIR, "fake-claude-projects");
  const projectA = path.join(fakeRoot, "-Users-alice-projects-foo");
  const projectB = path.join(fakeRoot, "-D--Imperial-week15");
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });
  const oldFile = path.join(projectA, "sess_old.jsonl");
  const recentA = path.join(projectA, "sess_recent_a.jsonl");
  const recentB = path.join(projectB, "sess_recent_b.jsonl");
  // Each fake JSONL carries a real `cwd` field on the first user message
  // — the scanner's peek should pick it up and prefer it over the
  // best-effort dir-name decoder.
  const userLine = (sessionCwd, parentUuid, uuid) => JSON.stringify({
    type: "user", parentUuid, uuid, cwd: sessionCwd,
    message: { role: "user", content: [{ type: "text", text: "hi" }] }
  });
  fs.writeFileSync(oldFile, userLine("/Users/alice/projects/foo-real", null, "uuid-old") + "\n");
  fs.writeFileSync(recentA, userLine("/Users/alice/projects/foo-real", null, "uuid-shared") + "\n");
  fs.writeFileSync(recentB, userLine("D:/Imperial/week15-real", null, "uuid-shared") + "\n");
  // Backdate the "old" file by 30 days; recent ones stay current.
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000;
  fs.utimesSync(oldFile, old / 1000, old / 1000);

  const { scanAllProjects, decodeProjectDir, peekTranscriptHeader } =
    require(path.join(ROOT, "packages/daemon/src/transcript-scanner.js"));

  // No window filter → after grouping by firstUserMsgId there's only ONE
  // entry per logical conversation. recentA + recentB share uuid-shared
  // so they collapse to one (whichever has newer mtime); old has its own
  // uuid → separate entry. Total: 2.
  const all = scanAllProjects({ root: fakeRoot, sinceMs: 0 });
  if (all.length !== 2) {
    throw new Error(`Expected 2 grouped sessions in fake projects root, got ${all.length}: ${all.map((s) => s.sessionId).join(", ")}`);
  }

  // Window of past 1 day → drops the 30-day-old entry, leaves the
  // grouped recentA/recentB pair as one entry.
  const recent = scanAllProjects({ root: fakeRoot, sinceMs: Date.now() - 24 * 60 * 60 * 1000 });
  if (recent.length !== 1) {
    throw new Error(`Expected 1 entry after grouping inside 1d window, got ${recent.length}`);
  }
  if ((recent[0].groupSize || 0) < 2) {
    throw new Error(`Expected groupSize >= 2 for the resume-fork pair, got ${recent[0].groupSize}`);
  }

  // Scanner should prefer the cwd from inside the JSONL over the
  // dir-name decoder. recent[0] picked the newer fork; both forks have
  // their own real cwd in their first line.
  if (recent[0].cwdSource !== "jsonl") {
    throw new Error(`Expected cwd to come from JSONL peek, got source=${recent[0].cwdSource}`);
  }
  if (!recent[0].projectDirDecoded.endsWith("-real")) {
    throw new Error(`Expected real-cwd suffix in scanner output, got ${recent[0].projectDirDecoded}`);
  }

  // Direct peek check — pulls cwd + firstUserMsgId out of a JSONL.
  const peek = peekTranscriptHeader(recentB);
  if (peek.cwd !== "D:/Imperial/week15-real") {
    throw new Error(`peek cwd mismatch: ${peek.cwd}`);
  }
  if (peek.firstUserMsgId !== "uuid-shared") {
    throw new Error(`peek firstUserMsgId mismatch: ${peek.firstUserMsgId}`);
  }

  // Project dir decoder — best-effort but covers POSIX + Windows shapes.
  if (decodeProjectDir("-Users-alice-projects-foo") !== "/Users/alice/projects/foo") {
    throw new Error("POSIX project dir decode failed");
  }
  const winDecoded = decodeProjectDir("-D--Imperial-week15");
  if (winDecoded !== "D:/Imperial/week15") {
    throw new Error(`Windows project dir decode unexpected: ${winDecoded}`);
  }

  // Storage config endpoints — round-trip through the daemon API.
  const initialStorage = await request("GET", "/cards/storage");
  if (!initialStorage.cardsDir || !initialStorage.isDefault) {
    throw new Error(`Expected default storage on first read, got ${JSON.stringify(initialStorage)}`);
  }

  const newDir = path.join(ENV.CCC_DATA_DIR, "custom-cards-target");
  const updated = await request("POST", "/cards/storage", { cardsDir: newDir });
  if (updated.isDefault !== false || updated.cardsDir !== newDir) {
    throw new Error(`Storage POST didn't apply: ${JSON.stringify(updated)}`);
  }
  if (!updated.appliedAfterRestart) {
    throw new Error("Storage POST should warn that daemon restart is needed");
  }

  // Persist file shape
  const configFile = path.join(ENV.CCC_DATA_DIR, "cards-storage-config.json");
  if (!fs.existsSync(configFile)) {
    throw new Error(`Storage config file not written: ${configFile}`);
  }
  const persisted = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (persisted.cardsDir !== newDir) {
    throw new Error("Persisted storage config doesn't match POST body");
  }

  // Reverting to default (empty body) deletes the override file.
  const reverted = await request("POST", "/cards/storage", { cardsDir: "" });
  if (!reverted.isDefault) {
    throw new Error("Storage POST with empty body should revert to default");
  }
  if (fs.existsSync(configFile)) {
    throw new Error("Reverting to default should delete the override file");
  }
}

async function verifyConsent() {
  const initial = await request("GET", "/cards/consent");
  if (initial.given !== false) {
    throw new Error(`Consent should start as not given, got ${JSON.stringify(initial)}`);
  }
  if (typeof initial.consentVersion !== "string" || !initial.consentVersion) {
    throw new Error("consent response should include a consentVersion string");
  }

  const granted = await request("POST", "/cards/consent", { given: true });
  if (granted.given !== true || !granted.givenAt) {
    throw new Error(`Granting consent should return given=true with givenAt, got ${JSON.stringify(granted)}`);
  }

  const afterGrant = await request("GET", "/cards/consent");
  if (afterGrant.given !== true) {
    throw new Error("GET after POST should reflect granted consent");
  }

  // Persisted to disk in the agreed shape.
  const consentFile = path.join(ENV.CCC_DATA_DIR, "cards-consent.json");
  if (!fs.existsSync(consentFile)) {
    throw new Error(`Expected consent file at ${consentFile}`);
  }
  const persisted = JSON.parse(fs.readFileSync(consentFile, "utf8"));
  if (persisted.given !== true || persisted.version !== granted.consentVersion) {
    throw new Error(`Persisted consent shape unexpected: ${JSON.stringify(persisted)}`);
  }

  // Revoke round-trip.
  const revoked = await request("POST", "/cards/consent", { given: false });
  if (revoked.given !== false) {
    throw new Error("Revoking consent should return given=false");
  }
  const afterRevoke = await request("GET", "/cards/consent");
  if (afterRevoke.given !== false) {
    throw new Error("GET after revoke should reflect ungranted state");
  }

  // Re-grant for downstream tests / interactive use after smoke.
  await request("POST", "/cards/consent", { given: true });
}

async function verifyMarkdownExport(todayDate, archiveId) {
  const fetchMarkdown = (pathname) => new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: pathname, method: "GET", headers: {} },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`GET ${pathname} -> ${res.statusCode}: ${data}`));
            return;
          }
          resolve({ body: data, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });

  // 17a. scope=today
  const today = await fetchMarkdown("/cards/export?scope=today");
  if (!String(today.headers["content-type"] || "").includes("text/markdown")) {
    throw new Error(`export today should be text/markdown, got ${today.headers["content-type"]}`);
  }
  if (!/^---\n/.test(today.body)) {
    throw new Error("today export missing YAML frontmatter");
  }
  if (!today.body.includes("\n# ")) {
    throw new Error("today export missing H1 heading");
  }
  if (!/\*\*Q\*\*:/.test(today.body) || !/\*\*A\*\*:/.test(today.body)) {
    throw new Error("today export missing Q/A pairs");
  }
  const cd = String(today.headers["content-disposition"] || "");
  if (!/attachment; filename=".+\.md"/.test(cd)) {
    throw new Error(`today export missing attachment content-disposition, got: ${cd}`);
  }

  // 17b. scope=today with archive id pulls the archived deck
  const archivedExport = await fetchMarkdown(`/cards/export?scope=today&date=${todayDate}&archive=${archiveId}`);
  if (!archivedExport.body.includes(`date: ${todayDate}`)) {
    throw new Error("archived export missing matching date in frontmatter");
  }

  // 17c. scope=history
  const history = await fetchMarkdown("/cards/export?scope=history");
  if (!/scope: all-abstracts/.test(history.body)) {
    throw new Error("history export missing all-abstracts scope marker");
  }
  if (!/^# Vibedog-for-agents abstracts — full history/m.test(history.body)) {
    throw new Error("history export missing top-level title");
  }

  // 17d. scope=wrong-book
  const wrongBook = await fetchMarkdown("/cards/export?scope=wrong-book");
  if (!/scope: wrong-book/.test(wrongBook.body)) {
    throw new Error("wrong-book export missing scope marker");
  }
  if (!/^# Wrong book/m.test(wrongBook.body)) {
    throw new Error("wrong-book export missing title");
  }

  // 17e. unknown scope returns 400
  let unknownErr = null;
  try {
    await fetchMarkdown("/cards/export?scope=nonsense");
  } catch (error) {
    unknownErr = error;
  }
  if (!unknownErr || !/400/.test(unknownErr.message)) {
    throw new Error("unknown export scope should return 400");
  }
}

async function verifyTranscriptIndex() {
  // Stage a fake JSONL transcript file with a couple of plausible entries
  // — exact same shape Claude Code writes for its real transcripts.
  const fakeTranscript = path.join(ENV.CCC_DATA_DIR, "fake-transcript.jsonl");
  const transcriptLines = [
    JSON.stringify({
      type: "user",
      timestamp: "2026-05-03T12:00:00Z",
      message: { role: "user", content: [{ type: "text", text: "why does PowerShell need to be Windows-only?" }] }
    }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-05-03T12:00:05Z",
      message: { role: "assistant", content: [
        { type: "text", text: "Claude Code rejects unknown tool names in permissions.ask." },
        { type: "tool_use", name: "Edit", input: { file_path: "scripts/setup-hooks.js" } }
      ] }
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-05-03T12:00:10Z",
      message: { role: "user", content: [{ type: "tool_result", content: "edit applied" }] }
    })
  ];
  fs.writeFileSync(fakeTranscript, transcriptLines.join("\n") + "\n", "utf8");

  // Send a status hook that includes the transcript path. The daemon's
  // updateSessionStateFromHook should record it into the index.
  await postHook("event", {
    hook_event_name: "PostToolUse",
    session_id: "sess_smoke_transcript",
    transcript_path: fakeTranscript,
    cwd: ENV.CCC_DATA_DIR,
    tool_name: "Edit",
    tool_input: { file_path: "scripts/setup-hooks.js" }
  });

  // The index file should exist and contain our session.
  const indexFile = path.join(ENV.CCC_DATA_DIR, "transcript-index.json");
  if (!fs.existsSync(indexFile)) {
    throw new Error("transcript-index.json was not written after a hook event with transcript_path");
  }
  const indexData = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  const entry = (indexData.entries || []).find((e) => e.sessionId === "sess_smoke_transcript");
  if (!entry) {
    throw new Error("transcript index missing the sess_smoke_transcript entry");
  }
  if (entry.transcriptPath !== fakeTranscript) {
    throw new Error(`Expected transcriptPath ${fakeTranscript}, got ${entry.transcriptPath}`);
  }

  // Direct read via the reader module — assert it can find verbatim strings
  // we wrote into the JSONL, and that the role-tagged formatter trims tool
  // results / annotates user / assistant blocks correctly.
  const { readTranscript } = require(path.join(ROOT, "packages/daemon/src/transcript-reader.js"));
  const formatted = readTranscript({ transcriptPath: fakeTranscript, since: 0, maxChars: 5000 });
  if (!formatted.includes("PowerShell")) {
    throw new Error("transcript-reader output missing user content");
  }
  if (!formatted.includes("permissions.ask")) {
    throw new Error("transcript-reader output missing assistant content");
  }
  if (!formatted.includes("tool_use Edit")) {
    throw new Error("transcript-reader output missing tool_use marker");
  }
  if (!formatted.includes("tool_result")) {
    throw new Error("transcript-reader output missing tool_result marker");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
