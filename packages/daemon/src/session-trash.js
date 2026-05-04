// Move-to-trash helper for Claude Code session JSONL files.
//
// Used by:
//   - cards-generator: auto-trash the session that the `claude -p`
//     subprocess itself creates each run (otherwise it shows up in the
//     next scan as noise).
//   - POST /sessions/delete: user-initiated cleanup via the bubble.
//
// Trash layout (under DATA_DIR):
//   <DATA_DIR>/trash/generator/<ts>-<sessionId>.jsonl
//   <DATA_DIR>/trash/manual/<ts>-<sessionId>.jsonl
// (both manifest.jsonl entries appended for audit.)
//
// Auto-prune keeps at most TRASH_MAX entries per category, oldest first.
// Hard delete is intentional only at prune time — the user always gets a
// recoverable copy at first.

const fs = require("node:fs");
const path = require("node:path");

const TRASH_MAX = 50;

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function timestampSlug() {
  // 2026-05-04T14-22-09-123 (filename-safe, sortable)
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return [
    d.getFullYear(),
    pad(d.getMonth() + 1),
    pad(d.getDate())
  ].join("-")
    + "T"
    + [pad(d.getHours()), pad(d.getMinutes()), pad(d.getSeconds())].join("-")
    + "-" + pad(d.getMilliseconds(), 3);
}

function basenameNoExt(p) {
  const b = path.basename(p);
  const dot = b.lastIndexOf(".");
  return dot > 0 ? b.slice(0, dot) : b;
}

class SessionTrash {
  constructor({ dataDir }) {
    this.root = path.join(dataDir, "trash");
  }

  // Move a single transcript JSONL into trash.
  // Returns { ok, trashedPath, reason? }. Never throws — caller can log.
  trashFile(filePath, category, { meta = {} } = {}) {
    if (!filePath) return { ok: false, reason: "no_path" };
    if (!["generator", "manual"].includes(category)) {
      return { ok: false, reason: "bad_category" };
    }
    if (!fs.existsSync(filePath)) {
      return { ok: false, reason: "not_found" };
    }

    const dir = path.join(this.root, category);
    try { ensureDir(dir); } catch (_e) { return { ok: false, reason: "mkdir_failed" }; }

    const sessionId = basenameNoExt(filePath);
    const trashedName = `${timestampSlug()}-${sessionId}.jsonl`;
    const trashedPath = path.join(dir, trashedName);

    try {
      fs.renameSync(filePath, trashedPath);
    } catch (renameError) {
      // Cross-device move (rare on Windows but possible if data dir is on
      // a different drive than ~/.claude). Fall back to copy + unlink.
      try {
        fs.copyFileSync(filePath, trashedPath);
        fs.unlinkSync(filePath);
      } catch (copyError) {
        return { ok: false, reason: `move_failed: ${copyError.message || renameError.message}` };
      }
    }

    this.appendManifest(category, {
      trashedAt: new Date().toISOString(),
      sessionId,
      origPath: filePath,
      trashedPath,
      ...meta
    });
    this.prune(category);
    return { ok: true, trashedPath };
  }

  appendManifest(category, entry) {
    const manifestPath = path.join(this.root, category, "manifest.jsonl");
    try {
      ensureDir(path.dirname(manifestPath));
      fs.appendFileSync(manifestPath, JSON.stringify(entry) + "\n");
    } catch (_e) {
      // Manifest is best-effort audit; failure shouldn't surface.
    }
  }

  // Keep at most TRASH_MAX JSONLs per category, oldest first by mtime.
  prune(category) {
    const dir = path.join(this.root, category);
    let entries;
    try {
      entries = fs.readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl") && f !== "manifest.jsonl")
        .map((f) => {
          const full = path.join(dir, f);
          let mtime = 0;
          try { mtime = fs.statSync(full).mtimeMs; } catch (_e) {}
          return { full, mtime };
        })
        .sort((a, b) => a.mtime - b.mtime);  // oldest first
    } catch (_e) {
      return;
    }
    const excess = entries.length - TRASH_MAX;
    if (excess <= 0) return;
    for (let i = 0; i < excess; i += 1) {
      try { fs.unlinkSync(entries[i].full); } catch (_e) {}
    }
  }
}

module.exports = { SessionTrash, TRASH_MAX };
