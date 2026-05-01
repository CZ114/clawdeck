#!/usr/bin/env node

const http = require("node:http");

const [, , rawDecision, requestId, ...reasonParts] = process.argv;
const decision = rawDecision === "approve" ? "allow" : rawDecision;
const answerJson = decision === "answer" ? reasonParts.join(" ") : "";
const reason = decision === "answer" ? "Answered from manual CLI" : reasonParts.join(" ") || `Manual ${decision}`;
const port = Number(process.env.CCC_PORT || 4317);
const host = process.env.CCC_HOST || "127.0.0.1";

if (!decision || !requestId || !["allow", "deny", "ask", "answer", "always_allow"].includes(decision)) {
  console.error("Usage: node scripts/decide.js <approve|allow|deny|ask|always_allow> <requestId> [reason]");
  console.error("   or: node scripts/decide.js answer <requestId> '{\"Question\":\"Answer\"}'");
  process.exit(1);
}

let answers;
if (decision === "answer") {
  try {
    answers = JSON.parse(answerJson);
  } catch (error) {
    console.error(`Answer payload must be a JSON object: ${error.message}`);
    process.exit(1);
  }
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    console.error("Answer payload must be a JSON object.");
    process.exit(1);
  }
}

const payload = JSON.stringify({ requestId, decision, reason, answers });

const req = http.request(
  {
    host,
    port,
    path: "/permission-decisions",
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload)
    }
  },
  (res) => {
    let body = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => {
      body += chunk;
    });
    res.on("end", () => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        console.error(body);
        process.exit(1);
      }
      console.log(body);
    });
  }
);

req.on("error", (error) => {
  console.error(`Could not reach daemon at http://${host}:${port}: ${error.message}`);
  process.exit(1);
});

req.write(payload);
req.end();
