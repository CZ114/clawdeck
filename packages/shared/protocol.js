const PROTOCOL_VERSION = 1;

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function claudePreToolUseDecision(permissionDecision, reason, extra = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason: reason,
      ...extra
    }
  };
}

function claudePermissionRequestDecision(decision) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    suppressOutput: true,
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision
    }
  };
}

function claudeNoopDecision() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    suppressOutput: true
  };
}

function jsonResponse(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function normalizeDecision(value) {
  if (value === "approve" || value === "allow") {
    return "allow";
  }
  if (value === "deny" || value === "block") {
    return "deny";
  }
  if (value === "ask") {
    return "ask";
  }
  if (value === "answer") {
    return "answer";
  }
  return null;
}

module.exports = {
  PROTOCOL_VERSION,
  claudeNoopDecision,
  claudePermissionRequestDecision,
  claudePreToolUseDecision,
  createId,
  jsonResponse,
  normalizeDecision,
  nowIso,
  readJsonBody
};
