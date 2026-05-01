#!/usr/bin/env node

const http = require("node:http");
const { claudeNoopDecision } = require("../shared/protocol");

const PORT = Number(process.env.CCC_PORT || 4317);
const HOST = process.env.CCC_HOST || "127.0.0.1";
const TIMEOUT_MS = Number(process.env.CCC_HOOK_TIMEOUT_MS || 58_000);
const DISABLE_STATUS =
  process.env.CCC_DISABLE_STATUS_HOOK === "true" ||
  process.env.CCC_STATUS_HOOK === "off";

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

function postJson(pathname, body) {
  const payload = Buffer.from(body, "utf8");

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: pathname,
        method: "POST",
        timeout: TIMEOUT_MS,
        headers: {
          "content-type": "application/json",
          "content-length": payload.length
        }
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`Daemon returned HTTP ${res.statusCode}`));
            return;
          }
          resolve();
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

function writeNoop() {
  process.stdout.write(JSON.stringify(claudeNoopDecision()));
}

async function main() {
  const input = await readStdin();

  try {
    JSON.parse(input);
  } catch (_error) {
    writeNoop();
    return;
  }

  if (DISABLE_STATUS) {
    writeNoop();
    return;
  }

  try {
    await postJson("/hook/event", input);
  } catch (_error) {
    // Status hooks should never block Claude Code work.
  }

  writeNoop();
}

main().catch(() => {
  writeNoop();
});
