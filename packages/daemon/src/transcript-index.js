// Persistent index of `sessionId → transcript_path` mappings, fed by hook
// events. Lets the cards generator (Slice 3B) reach into Claude Code's
// real per-session JSONL transcripts so the model sees actual decisions /
// edits / dialogue instead of just lifecycle summaries.
//
// Storage: `<DATA_DIR>/transcript-index.json`. Survives daemon restarts so
// historical sessions can still be fed into a backfill generation request.
// Schema versioned for future shape changes.

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;

class TranscriptIndex {
  constructor({ dataDir }) {
    if (!dataDir) {
      throw new Error("TranscriptIndex requires dataDir");
    }
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "transcript-index.json");
    this.entries = new Map();
    this._load();
  }

  _load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (_error) {
      return;  // No file yet — start with an empty index.
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      return;  // Corrupt — start fresh; persisting later will overwrite.
    }
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || !Array.isArray(parsed.entries)) {
      return;
    }
    for (const entry of parsed.entries) {
      if (entry && entry.sessionId && entry.transcriptPath) {
        this.entries.set(entry.sessionId, entry);
      }
    }
  }

  _persist() {
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      entries: Array.from(this.entries.values())
    };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      // Persistence failures shouldn't break the daemon — log once and
      // continue serving from in-memory state.
      console.warn(`[warn] transcript-index persist failed: ${error.message}`);
    }
  }

  // Record (or refresh) a transcript-path mapping. Idempotent: repeated
  // calls with the same sessionId update lastSeenAt + cwd but preserve
  // firstSeenAt. transcriptPath changes (rare — Claude Code typically
  // pins one path per session) overwrite.
  record(sessionId, transcriptPath, meta = {}) {
    if (!sessionId || !transcriptPath) return null;
    const existing = this.entries.get(sessionId);
    const now = new Date().toISOString();
    const entry = {
      sessionId,
      transcriptPath,
      cwd: meta.cwd || (existing && existing.cwd) || null,
      firstSeenAt: (existing && existing.firstSeenAt) || now,
      lastSeenAt: now
    };
    this.entries.set(sessionId, entry);
    this._persist();
    return entry;
  }

  lookup(sessionId) {
    return this.entries.get(sessionId) || null;
  }

  list() {
    return Array.from(this.entries.values());
  }

  // Returns sessions whose lastSeenAt is at or after the given cutoff.
  // Used by the generator to scope which transcripts to pull for a
  // requested date window.
  recentSessions(sinceMs) {
    return this.list().filter((entry) => {
      const t = Date.parse(entry.lastSeenAt || "");
      return Number.isFinite(t) && t >= sinceMs;
    });
  }
}

module.exports = { TranscriptIndex, SCHEMA_VERSION };
