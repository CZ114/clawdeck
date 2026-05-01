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
const ENV = {
  ...process.env,
  CCC_PORT: String(PORT),
  CCC_APPROVAL_TIMEOUT_MS: "5000",
  CCC_DATA_DIR: path.join(os.tmpdir(), "claude-code-companion-smoke-" + process.pid)
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

function runHook(scriptPath, input, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: ROOT,
      env: { ...ENV, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"]
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
        reject(new Error(`Hook exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });
    child.stdin.end(JSON.stringify(input));
  });
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

function countHookEntries(settings, eventName, scriptName) {
  const entries = (settings.hooks && settings.hooks[eventName]) || [];
  return entries.filter((entry) => {
    return Array.isArray(entry.hooks) && entry.hooks.some((hook) => {
      return String(hook.command || "").replace(/\\/g, "/").includes(`/packages/hooks/${scriptName}`);
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

    const bypassPrePendingBefore = await pendingCount();
    const bypassPreOutput = await runHook(
      "packages/hooks/pre-tool-use.js",
      {
        session_id: "sess_smoke_bypass_pre",
        transcript_path: "C:/tmp/transcript-bypass-pre.jsonl",
        cwd: ROOT,
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "Bypass this question?",
              header: "Bypass",
              options: [{ label: "Yes" }],
              multiSelect: false
            }
          ]
        }
      },
      { CCC_BYPASS_APPROVAL_HOOK: "true" }
    );
    if (!bypassPreOutput.suppressOutput || bypassPreOutput.hookSpecificOutput) {
      throw new Error("Expected PreToolUse bypass to return a no-op hook output");
    }
    if ((await pendingCount()) !== bypassPrePendingBefore) {
      throw new Error("Expected PreToolUse bypass not to create a pending request");
    }

    const bypassPermissionPendingBefore = await pendingCount();
    const bypassPermissionOutput = await runHook(
      "packages/hooks/permission-request.js",
      {
        session_id: "sess_smoke_bypass_permission",
        transcript_path: "C:/tmp/transcript-bypass-permission.jsonl",
        cwd: ROOT,
        permission_mode: "default",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: {
          command: "npm run lint"
        }
      },
      { CCC_BYPASS_APPROVAL_HOOK: "true" }
    );
    if (!bypassPermissionOutput.suppressOutput || bypassPermissionOutput.hookSpecificOutput) {
      throw new Error("Expected PermissionRequest bypass to return a no-op hook output");
    }
    if ((await pendingCount()) !== bypassPermissionPendingBefore) {
      throw new Error("Expected PermissionRequest bypass not to create a pending request");
    }

    await runHook(
      "packages/hooks/event.js",
      {
        session_id: "sess_smoke_status_disabled",
        transcript_path: "C:/tmp/transcript-status-disabled.jsonl",
        cwd: ROOT,
        hook_event_name: "UserPromptSubmit",
        prompt: "This status should not be recorded"
      },
      { CCC_DISABLE_STATUS_HOOK: "true" }
    );
    const disabledSessions = await request("GET", "/sessions");
    if (disabledSessions.sessions.some((item) => item.sessionId === "sess_smoke_status_disabled")) {
      throw new Error("Expected disabled status hook not to create a session state");
    }

    const approvalPage = await request("GET", "/");
    if (!String(approvalPage).includes("Claude Code Companion")) {
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

    const promptHookOutput = await runHook("packages/hooks/event.js", {
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

    await runHook("packages/hooks/event.js", {
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

    await runHook("packages/hooks/event.js", {
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

    await runHook("packages/hooks/event.js", {
      session_id: "sess_smoke_status",
      transcript_path: "C:/tmp/transcript-status.jsonl",
      cwd: ROOT,
      hook_event_name: "Stop"
    });
    await waitForSessionStatus("sess_smoke_status", "done");

    await runHook("packages/hooks/event.js", {
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

    const hookPromise = runHook("packages/hooks/pre-tool-use.js", {
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

    const permissionHookPromise = runHook("packages/hooks/permission-request.js", {
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

    const powershellPermissionHookPromise = runHook("packages/hooks/permission-request.js", {
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

    const questionHookPromise = runHook("packages/hooks/pre-tool-use.js", {
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

    console.log("Smoke test passed.");
  } finally {
    daemon.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
