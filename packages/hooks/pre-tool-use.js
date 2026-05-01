#!/usr/bin/env node

const http = require("node:http");
const { claudeNoopDecision, claudePreToolUseDecision } = require("../shared/protocol");

const PORT = Number(process.env.CCC_PORT || 4317);
const HOST = process.env.CCC_HOST || "127.0.0.1";
const TIMEOUT_MS = Number(process.env.CCC_HOOK_TIMEOUT_MS || 58_000);
const FAIL_OPEN = process.env.CCC_FAIL_OPEN === "true";
const BYPASS_APPROVAL =
  process.env.CCC_BYPASS_APPROVAL_HOOK === "true" ||
  process.env.CCC_REMOTE_APPROVAL === "off";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function postJson(path, body) {
  const payload = Buffer.from(body, "utf8");

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method: "POST",
        timeout: TIMEOUT_MS,
        headers: {
          "content-type": "application/json",
          "content-length": payload.length
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
            reject(new Error(`Daemon returned HTTP ${res.statusCode}: ${data}`));
            return;
          }
          resolve(data);
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Timed out after ${TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function writeDecision(permissionDecision, reason) {
  process.stdout.write(JSON.stringify(claudePreToolUseDecision(permissionDecision, reason)));
}

function writeNoop() {
  process.stdout.write(JSON.stringify(claudeNoopDecision()));
}

async function main() {
  const input = await readStdin();

  try {
    JSON.parse(input);
  } catch (error) {
    writeDecision("deny", `Invalid Claude Code hook JSON: ${error.message}`);
    return;
  }

  if (BYPASS_APPROVAL) {
    writeNoop();
    return;
  }

  try {
    const response = await postJson("/hook/pre-tool-use", input);
    process.stdout.write(response);
  } catch (error) {
    if (FAIL_OPEN) {
      writeNoop();
      return;
    }
    writeDecision("deny", `Companion daemon unavailable. Start it with npm run daemon. Details: ${error.message}`);
  }
}

main().catch((error) => {
  writeDecision("deny", `Companion hook failed: ${error.message}`);
});
