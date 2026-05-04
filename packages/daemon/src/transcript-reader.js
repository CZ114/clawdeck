// Reads Claude Code's per-session JSONL transcripts and renders them as
// prompt-friendly text for the cards generator (Slice 3B).
//
// Claude Code stores one JSON object per line with shapes like:
//   { type: "user"      , timestamp, message: { role, content: [...] } }
//   { type: "assistant" , timestamp, message: { role, content: [...] } }
//   { type: "summary"   , timestamp, summary }
// Content blocks include "text", "tool_use", "tool_result", "thinking".
//
// We keep aggressive caps (per-message + per-session + total) because the
// model has a finite context window and many sessions can pile up under a
// single date window. Hard policy:
//   - Skip "thinking" blocks entirely (often very long, low signal).
//   - Skip "summary" entries (auto-compact summaries).
//   - Truncate long text / tool_result content to a fixed cap.
// Every line passes through redact() before going into the prompt.

const fs = require("node:fs");
const { keywordScore } = require("../../shared/transcript-keywords");

const TOKEN_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,    // Anthropic API key shape
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,        // OpenAI key shape
  /\bghp_[A-Za-z0-9]{20,}\b/g,         // GitHub PAT
  /\bgho_[A-Za-z0-9]{20,}\b/g,         // GitHub OAuth
  /\bAKIA[0-9A-Z]{16}\b/g,             // AWS access key
  /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}\b/gi
];

function redact(text) {
  if (!text) return "";
  let out = String(text);

  // 1. Strip whole lines that mention .env / .envrc / secrets/ paths.
  out = out.replace(/^.*\.env(?:\.[A-Za-z0-9_]+)?\b.*$/gm, "(redacted: .env reference)");
  out = out.replace(/^.*\b(?:secrets|credentials)\/[^\s]+.*$/gm, "(redacted: secrets path)");

  // 2. Replace token-shaped strings with a placeholder.
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, "(redacted: token)");
  }

  // 3. Replace user home dir with ~ so usernames don't leak in absolute
  //    paths. Cover both the literal home dir and the env-var forms.
  const home = process.env.HOME || process.env.USERPROFILE || "";
  if (home) {
    out = out.replace(new RegExp(escapeRegex(home), "g"), "~");
  }
  out = out.replace(/%USERPROFILE%/g, "~").replace(/\$HOME/g, "~");

  return out;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Read + format a single transcript file. Returns either a non-empty
// string (ready to drop into the prompt) or "" when there's nothing
// useful in the window.
function readTranscript({ transcriptPath, since = 0, maxChars = 12000 }) {
  if (!transcriptPath || typeof transcriptPath !== "string") return "";
  if (!fs.existsSync(transcriptPath)) return "";

  let raw;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch (_error) {
    return "";
  }

  const lines = raw.split("\n");
  let skippedOlder = 0;

  // Pass 1: parse + format every in-window entry, scoring each for
  // summary-likeness via the shared keyword table. We keep insertion
  // order so chronological output is preserved when nothing gets dropped.
  const entries = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const trimmed = lines[idx].trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch (_error) {
      continue;  // partial / corrupt line
    }

    const tsRaw = entry.timestamp || entry.createdAt || (entry.message && entry.message.timestamp);
    const ts = tsRaw ? Date.parse(tsRaw) : NaN;
    if (Number.isFinite(since) && since > 0 && Number.isFinite(ts) && ts < since) {
      skippedOlder += 1;
      continue;
    }

    const block = formatEntry(entry);
    if (!block) continue;

    const next = redact(block);
    entries.push({
      idx,
      text: next,
      score: keywordScore(next)
    });
  }

  if (entries.length === 0) return "";

  // Pass 2: budget fill. Cheap path — if everything fits, keep all.
  const totalChars = entries.reduce((sum, e) => sum + e.text.length, 0);
  let kept;
  let truncated = false;
  if (totalChars <= maxChars) {
    kept = entries;
  } else {
    // Greedy: rank by (score desc, recency desc by idx), include while
    // budget remains, then re-sort survivors back to chronological order
    // so the prompt reads naturally.
    truncated = true;
    const ranked = entries.slice().sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.idx - a.idx;
    });
    const picked = [];
    let used = 0;
    for (const e of ranked) {
      if (used + e.text.length > maxChars) continue;
      picked.push(e);
      used += e.text.length;
    }
    kept = picked.sort((a, b) => a.idx - b.idx);
  }

  const formatted = kept.map((e) => e.text);
  if (truncated) {
    formatted.push("(... truncated to fit context budget; kept summary-keyword entries first ...)");
  }

  const header = skippedOlder > 0
    ? `(window: skipped ${skippedOlder} earlier entries)\n`
    : "";
  return header + formatted.join("\n\n");
}

// Format one parsed JSONL entry into a compact, role-tagged block.
function formatEntry(entry) {
  if (!entry || typeof entry !== "object") return null;

  const ts = formatTimestamp(entry.timestamp || entry.createdAt);
  const role = entry.type
    || (entry.message && entry.message.role)
    || "unknown";

  // Skip auto-compact summaries — they're often massive and meta.
  if (role === "summary") return null;

  const content = entry.message && entry.message.content;
  if (!content) {
    // Some hook events come through transcript files too — they have a
    // top-level shape we don't care about. Skip silently.
    return null;
  }

  const blocks = Array.isArray(content) ? content : [{ type: "text", text: String(content) }];
  const lines = [];

  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text") {
      const text = truncate(String(block.text || ""), 800);
      if (text) lines.push(text);
    } else if (block.type === "tool_use") {
      const name = String(block.name || "?");
      const input = block.input ? JSON.stringify(block.input) : "";
      lines.push(`→ tool_use ${name}: ${truncate(input, 300)}`);
    } else if (block.type === "tool_result") {
      const inner = typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content || "");
      lines.push(`← tool_result: ${truncate(inner, 200)}`);
    } else if (block.type === "thinking") {
      // Skip — verbose, low signal for review-card generation.
    }
  }

  if (lines.length === 0) return null;
  return `[${ts}] ${role}\n${lines.join("\n")}`;
}

function formatTimestamp(ts) {
  if (!ts) return "?";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hour = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${min}`;
}

function truncate(s, max) {
  if (!s) return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + " (... truncated)";
}

module.exports = {
  readTranscript,
  redact,
  // exported for tests
  formatEntry
};
