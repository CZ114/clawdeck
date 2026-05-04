// Persistent override for where Knowledge Cards files live on disk.
//
// The default cards directory is `<DATA_DIR>/cards` (so when you run
// `npm run daemon` from the project root, decks land in
// `<project>/.claude-companion/cards`). Some users want their decks in a
// notes vault, an iCloud folder, or anywhere outside the repo. This
// store records that choice so daemon restarts respect it.
//
// Storage location: `<DATA_DIR>/cards-storage-config.json`. Deliberately
// kept OUTSIDE the cards directory itself — otherwise pointing cards at
// a new folder would orphan the config that defined the new folder.
//
// Migration policy: this module does NOT copy existing decks when the
// path changes. The renderer warns the user. They can move files
// manually if they want History to follow.

const fs = require("node:fs");
const path = require("node:path");

const SCHEMA_VERSION = 1;

class StorageConfig {
  constructor({ daemonDataDir, defaultCardsDir }) {
    if (!daemonDataDir || !defaultCardsDir) {
      throw new Error("StorageConfig requires daemonDataDir and defaultCardsDir");
    }
    this.daemonDataDir = daemonDataDir;
    this.defaultCardsDir = defaultCardsDir;
    this.filePath = path.join(daemonDataDir, "cards-storage-config.json");
  }

  // Read the configured cards dir, falling back to the default if no
  // config file exists or it's malformed.
  resolvedCardsDir() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (_error) {
      return { cardsDir: this.defaultCardsDir, isDefault: true, configuredAt: null };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      return { cardsDir: this.defaultCardsDir, isDefault: true, configuredAt: null };
    }
    if (!parsed || parsed.schemaVersion !== SCHEMA_VERSION || typeof parsed.cardsDir !== "string") {
      return { cardsDir: this.defaultCardsDir, isDefault: true, configuredAt: null };
    }
    return {
      cardsDir: parsed.cardsDir,
      isDefault: parsed.cardsDir === this.defaultCardsDir,
      configuredAt: parsed.configuredAt || null
    };
  }

  // Persist a new cards dir. Pass null/empty to revert to default
  // (deletes the override file).
  setCardsDir(cardsDir) {
    if (!cardsDir || cardsDir === this.defaultCardsDir) {
      try {
        fs.unlinkSync(this.filePath);
      } catch (_error) {
        // already absent — fine
      }
      return { cardsDir: this.defaultCardsDir, isDefault: true, configuredAt: null };
    }

    const payload = {
      schemaVersion: SCHEMA_VERSION,
      cardsDir,
      configuredAt: new Date().toISOString()
    };
    fs.mkdirSync(this.daemonDataDir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, this.filePath);
    return { cardsDir, isDefault: false, configuredAt: payload.configuredAt };
  }
}

module.exports = { StorageConfig };
