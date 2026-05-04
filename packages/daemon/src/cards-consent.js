// Persistent record of the user's consent to feed Claude Code session
// transcripts to the local `claude -p` subprocess for card generation.
// Per docs/decisions/ADR-20260503-knowledge-cards.md §"Decision 11" the
// first generation must be opt-in; we remember the answer so subsequent
// generations don't re-prompt.
//
// Storage: `<DATA_DIR>/cards-consent.json`. Tiny shape so we keep it
// self-contained instead of bolting onto cards-store.

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;
// The consent text the user is agreeing to. If we ever materially change
// what gets piped to claude (new fields, different scope, looser
// redaction), bump this version so existing users get re-prompted.
const CONSENT_VERSION = "transcript-to-claude-v1";

class ConsentStore {
  constructor({ dataDir }) {
    if (!dataDir) {
      throw new Error("ConsentStore requires dataDir");
    }
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, "cards-consent.json");
  }

  read() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (_error) {
      return { given: false, givenAt: null, version: null };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      return { given: false, givenAt: null, version: null };
    }
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== SCHEMA_VERSION) {
      return { given: false, givenAt: null, version: null };
    }
    // Re-prompt if the consent contract changed since the user last agreed.
    if (parsed.given && parsed.version !== CONSENT_VERSION) {
      return { given: false, givenAt: parsed.givenAt || null, version: parsed.version || null };
    }
    return {
      given: Boolean(parsed.given),
      givenAt: parsed.givenAt || null,
      version: parsed.version || null
    };
  }

  // `given=true` records the agreement; `given=false` revokes (so the next
  // generate re-prompts). Either way we persist a versioned record.
  write(given) {
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      version: CONSENT_VERSION,
      given: Boolean(given),
      givenAt: given ? new Date().toISOString() : null,
      revokedAt: given ? null : new Date().toISOString()
    };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      console.warn(`[warn] cards-consent persist failed: ${error.message}`);
    }
    return payload;
  }
}

module.exports = { ConsentStore, CONSENT_VERSION };
