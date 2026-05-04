const fs = require("node:fs");
const path = require("node:path");
const {
  SCHEMA_VERSION,
  MASTERY_THRESHOLD,
  todayLocalDate,
  isValidDate,
  emptyDayPayload,
  emptyWrongBook,
  normalizeAttempt,
  checkAnswer,
  validateCard
} = require("../../shared/cards");

function masteryThresholdFor(card) {
  return MASTERY_THRESHOLD[card && card.difficulty] || 2;
}

// File-based store for the Knowledge Cards feature. One JSON file per day
// under `<DATA_DIR>/cards/<YYYY-MM-DD>.json`, plus a single aggregate
// `wrong-book.json` that tracks cards the user has missed and not yet
// mastered.
//
// Tradeoff: writes are atomic per file (write-temp + rename), but we
// deliberately avoid any cross-file transaction. A crash in the middle of
// recordAttempt() can leave the day file updated and the wrong book stale,
// or vice-versa. That's acceptable here — the worst symptom is a
// double-attribution that the user can fix with one more click.
class CardsStore {
  constructor({ dataDir, cardsDir }) {
    if (!dataDir) {
      throw new Error("CardsStore requires dataDir");
    }
    this.dataDir = dataDir;
    // cardsDir defaults to `<dataDir>/cards` but is overridable so users
    // can park their decks in a notes vault, iCloud folder, etc.
    this.cardsDir = cardsDir || path.join(dataDir, "cards");
    this.wrongBookPath = path.join(this.cardsDir, "wrong-book.json");
  }

  ensureDir() {
    fs.mkdirSync(this.cardsDir, { recursive: true });
  }

  dayFilePath(date) {
    return path.join(this.cardsDir, `${date}.json`);
  }

  // Archived (superseded) day files use `<date>-HHMMSS.json`. The HHMMSS
  // is taken from the existing file's updatedAt (so the archive name
  // reflects when the previous generation actually happened, not when we
  // archived it). Used by archiveExistingDay() during re-generation so
  // the user can still find their earlier deck in History.
  archivedDayFilePath(date, hhmmss) {
    return path.join(this.cardsDir, `${date}-${hhmmss}.json`);
  }

  // Read a day file. Returns null when the file is missing, unreadable, or
  // tagged with a different schema version (so a future schema bump doesn't
  // accidentally surface old-shape data to a new bubble).
  readDay(date) {
    if (!isValidDate(date)) return null;
    let raw;
    try {
      raw = fs.readFileSync(this.dayFilePath(date), "utf8");
    } catch (_error) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    return parsed;
  }

  writeDay(date, payload, { archivePrior = false } = {}) {
    if (!isValidDate(date)) {
      throw new Error(`Invalid date for cards file: ${date}`);
    }
    this.ensureDir();

    // If a generation just happened for this date and we already had a
    // deck, rename the existing file to `<date>-HHMMSS.json` first so the
    // user's earlier deck stays browsable in History instead of being
    // silently overwritten. archivePrior is opt-in so plain
    // recordAttempt-style writes don't churn the archive.
    if (archivePrior) {
      this._archiveExisting(date);
    }

    const final = {
      ...payload,
      schemaVersion: SCHEMA_VERSION,
      date,
      updatedAt: new Date().toISOString()
    };
    if (!final.createdAt) {
      final.createdAt = final.updatedAt;
    }
    const target = this.dayFilePath(date);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(final, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, target);
    return final;
  }

  // Move the existing <date>.json (if any) to <date>-HHMMSS.json. The
  // HHMMSS is derived from the existing file's updatedAt so the archive
  // name reflects when that deck was actually produced. Falls back to
  // current time if the existing payload is missing/corrupt.
  _archiveExisting(date) {
    const current = this.dayFilePath(date);
    if (!fs.existsSync(current)) return null;

    const existing = this.readDay(date);
    const sourceTime = existing && existing.updatedAt
      ? new Date(existing.updatedAt)
      : new Date();
    const hh = String(sourceTime.getHours()).padStart(2, "0");
    const mm = String(sourceTime.getMinutes()).padStart(2, "0");
    const ss = String(sourceTime.getSeconds()).padStart(2, "0");
    let stamp = `${hh}${mm}${ss}`;
    let target = this.archivedDayFilePath(date, stamp);

    // Collision guard — if two generations happen within the same second
    // (rare but possible during testing), append a suffix until we find a
    // free slot.
    let suffix = 0;
    while (fs.existsSync(target) && suffix < 100) {
      suffix += 1;
      target = this.archivedDayFilePath(date, `${stamp}-${suffix}`);
    }

    try {
      fs.renameSync(current, target);
      return target;
    } catch (error) {
      // Don't fail the new write if the archive rename fails — just log.
      console.warn(`[warn] cards-store archive failed for ${date}: ${error.message}`);
      return null;
    }
  }

  // Build a clean payload from a generator output and persist it. Drops any
  // card that fails strict-source validation. Returns the persisted payload
  // plus a `dropped` array so callers (and tests) can tell which cards were
  // refused.
  saveGeneratedDay(date, raw) {
    const cards = Array.isArray(raw && raw.cards) ? raw.cards : [];
    const accepted = [];
    const dropped = [];
    for (const card of cards) {
      const verdict = validateCard(card);
      if (!verdict.ok) {
        dropped.push({ id: card && card.id, reason: verdict.reason });
        continue;
      }
      accepted.push({ ...card, attempts: Array.isArray(card.attempts) ? card.attempts : [] });
    }

    const payload = {
      ...emptyDayPayload(date),
      ...raw,
      cards: accepted,
      state: accepted.length === 0 ? "empty" : (raw && raw.state) || "ready"
    };
    // Re-generation for a date that already has a deck archives the prior
    // file into <date>-HHMMSS.json so the user's earlier abstract + cards
    // stay reachable from History instead of being silently overwritten.
    const persisted = this.writeDay(date, payload, { archivePrior: true });
    return { payload: persisted, dropped };
  }

  // What the bubble's GET /cards/today returns. If today has no file yet,
  // synthesize an empty payload so the renderer doesn't have to special-case
  // 404s. (Empty-day fallback to past-N-days + wrong book lives in the
  // generator, not here — this method only reflects what's already on disk.)
  todayPayload() {
    const date = todayLocalDate();
    const stored = this.readDay(date);
    if (stored) return stored;
    return emptyDayPayload(date);
  }

  // List of small summaries for the History tab — newest first. Includes
  // both current per-date decks (`<date>.json`) and archived prior
  // generations (`<date>-HHMMSS.json`). Sorted by updatedAt DESC so the
  // most recent generation lands at the top regardless of date.
  listHistory({ limit = 30 } = {}) {
    if (!fs.existsSync(this.cardsDir)) return [];
    let files;
    try {
      files = fs.readdirSync(this.cardsDir);
    } catch (_error) {
      return [];
    }
    const summaries = [];
    for (const name of files) {
      const dateOnly = name.match(/^(\d{4}-\d{2}-\d{2})\.json$/);
      const archived = name.match(/^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})(?:-\d+)?\.json$/);
      if (!dateOnly && !archived) continue;
      const date = dateOnly ? dateOnly[1] : archived[1];
      const fullPath = path.join(this.cardsDir, name);
      const payload = this._readPayloadFromPath(fullPath);
      if (!payload) continue;
      const summary = this.summarize(payload);
      // Stamp archive metadata when applicable so the renderer can show
      // "05-04 14:23 (archived)" instead of just "05-04".
      if (archived) {
        summary.archivedAt = `${archived[2]}:${archived[3]}:${archived[4]}`;
        summary.archivedFile = name;
        summary.isArchive = true;
      } else {
        summary.isArchive = false;
      }
      summaries.push(summary);
    }
    // Most-recent-first: sort by updatedAt (which the writer always sets).
    // For archived files this is the time of the archived generation.
    summaries.sort((a, b) => {
      const ta = String(b.updatedAt || `${b.date}T00:00:00Z`);
      const tb = String(a.updatedAt || `${a.date}T00:00:00Z`);
      return ta.localeCompare(tb);
    });
    return summaries.slice(0, Math.max(0, Number(limit) || 30));
  }

  // Internal: read a payload from an arbitrary path under cardsDir. Used
  // by listHistory to scan archive files alongside canonical date files.
  _readPayloadFromPath(filePath) {
    let raw;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (_error) {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    return parsed;
  }

  // Read a specific archived (superseded) day file. archiveId is the
  // HHMMSS suffix used in the filename, optionally with a `-N` collision
  // suffix. Returns null if not found.
  readArchivedDay(date, archiveId) {
    if (!isValidDate(date) || typeof archiveId !== "string") return null;
    if (!/^\d{6}(?:-\d+)?$/.test(archiveId)) return null;
    return this._readPayloadFromPath(this.archivedDayFilePath(date, archiveId));
  }

  summarize(payload) {
    const cards = Array.isArray(payload.cards) ? payload.cards : [];
    let answered = 0;
    let correct = 0;
    const difficultyMix = { easy: 0, medium: 0, hard: 0 };
    for (const c of cards) {
      if (difficultyMix[c.difficulty] !== undefined) difficultyMix[c.difficulty] += 1;
      if (Array.isArray(c.attempts) && c.attempts.length > 0) {
        answered += 1;
        const last = c.attempts[c.attempts.length - 1];
        if (last && last.correct) correct += 1;
      }
    }
    // Pick the first markdown h2 as the day's title — fall back to the
    // first non-empty line if the abstract isn't h2-led.
    const abstract = String(payload.abstract || "");
    const h2 = abstract.match(/^##\s+(.+)$/m);
    const firstLine = abstract.split("\n").map((s) => s.trim()).find(Boolean) || "";
    return {
      date: payload.date,
      state: payload.state || "ready",
      replay: Boolean(payload.replay),
      title: h2 ? h2[1].trim() : firstLine,
      cards: cards.length,
      answered,
      correct,
      difficultyMix,
      focusSnapshot: payload.focusSnapshot || "",
      stats: payload.stats || { sessions: 0, durationMin: 0 },
      updatedAt: payload.updatedAt || null,
      // Generation record (Slice 7) — surfaces "what got scanned" for the
      // Record tab. Kept compact: scannedSessions stays full but each entry
      // is small (sessionId + cwd + status + chars), so 30 days × ~5 sessions
      // is well under a few KB total.
      generationRecord: payload.generationRecord || null
    };
  }

  // Record a single attempt against a card. The daemon checks correctness
  // server-side from the stored answer rather than trusting the client (see
  // shared/cards.js#checkAnswer). Three code paths:
  //   - Today's deck (the common case during fresh review): appends to the
  //     card's `attempts` array AND mirrors the result into the wrong-book.
  //   - Wrong-book replay (card not in today's deck): runs the comparison
  //     against the wrong-book entry's snapshot and updates the entry's
  //     consecutiveCorrect / totalMisses / mastery directly.
  //   - History replay (renderer passes historyDate + optional
  //     historyArchiveId): scores against that historical day's snapshot
  //     and may add to wrong-book on miss; the historical file itself is
  //     read-only — we don't append to its attempts array.
  // All paths return `{ card, attempt, replay }` so the route handler can
  // tell the renderer which surface needs refreshing.
  recordAttempt({ cardId, picked, durationMs, historyDate, historyArchiveId }) {
    if (!cardId) {
      throw new Error("recordAttempt requires cardId");
    }

    // History replay path takes priority when the renderer explicitly says
    // "this card came from history". Without this branch the same cardId
    // appearing in both today's deck and a historical archive (common when
    // the user re-generates same-day) would always route to today, never
    // exercising the historical snapshot's read-only contract.
    if (historyDate) {
      const histPayload = historyArchiveId
        ? this.readArchivedDay(historyDate, historyArchiveId)
        : this.readDay(historyDate);
      const histCard = histPayload && Array.isArray(histPayload.cards)
        ? histPayload.cards.find((c) => c.id === cardId)
        : null;
      if (histCard) {
        return this.recordHistoryAttempt(histCard, picked, durationMs);
      }
      throw new Error(`Card ${cardId} not found in history file ${historyDate}${historyArchiveId ? ` @ ${historyArchiveId}` : ""}`);
    }

    const date = todayLocalDate();
    const todayPayload = this.readDay(date);
    const todayCard = todayPayload && Array.isArray(todayPayload.cards)
      ? todayPayload.cards.find((c) => c.id === cardId)
      : null;

    if (todayCard) {
      return this.recordTodayAttempt(date, todayPayload, todayCard, picked, durationMs);
    }

    const book = this.readWrongBook();
    const entry = book.entries.find((e) => e.cardId === cardId);
    if (entry) {
      return this.recordReplayAttempt(book, entry, picked, durationMs);
    }

    throw new Error(`Card not found in today's deck or wrong book: ${cardId}`);
  }

  // History replay scoring — read-only against the historical snapshot.
  // Misses still feed the wrong-book so old material can come back into
  // the user's daily mix.
  recordHistoryAttempt(card, picked, durationMs) {
    const correct = checkAnswer(card, picked);
    const attempt = normalizeAttempt({
      picked,
      correct,
      durationMs,
      at: new Date().toISOString()
    });
    // Forward to wrong-book using a synthetic single-attempt clone so the
    // existing applyAttemptToWrongBook logic doesn't pollute the historical
    // record with a real attempts array.
    this.applyAttemptToWrongBook({ ...card, attempts: [attempt] });
    return { card, attempt, replay: true };
  }

  recordTodayAttempt(date, payload, card, picked, durationMs) {
    const correct = checkAnswer(card, picked);
    const attempt = normalizeAttempt({
      picked,
      correct,
      durationMs,
      at: new Date().toISOString()
    });
    if (!Array.isArray(card.attempts)) card.attempts = [];
    card.attempts.push(attempt);

    this.applyAttemptToWrongBook(card);
    this.writeDay(date, payload);
    return { card, attempt, replay: false };
  }

  // Wrong-book replay: there's no "today's deck" entry to update. The
  // entry's consecutiveCorrect is the single source of truth for mastery.
  recordReplayAttempt(book, entry, picked, durationMs) {
    const card = entry.card || {};
    const correct = checkAnswer(card, picked);
    const attempt = normalizeAttempt({
      picked,
      correct,
      durationMs,
      at: new Date().toISOString()
    });

    entry.lastAttemptAt = attempt.at;
    if (correct) {
      entry.consecutiveCorrect = (entry.consecutiveCorrect || 0) + 1;
      if (entry.consecutiveCorrect >= masteryThresholdFor(card)) {
        const idx = book.entries.indexOf(entry);
        if (idx >= 0) book.entries.splice(idx, 1);
      }
    } else {
      entry.consecutiveCorrect = 0;
      entry.totalMisses = (entry.totalMisses || 0) + 1;
    }
    this.writeWrongBook(book);
    return { card, attempt, replay: true };
  }

  readWrongBook() {
    let raw;
    try {
      raw = fs.readFileSync(this.wrongBookPath, "utf8");
    } catch (_error) {
      return emptyWrongBook();
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_error) {
      return emptyWrongBook();
    }
    if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== SCHEMA_VERSION) {
      return emptyWrongBook();
    }
    if (!Array.isArray(parsed.entries)) parsed.entries = [];
    return parsed;
  }

  writeWrongBook(book) {
    this.ensureDir();
    const final = {
      ...book,
      schemaVersion: SCHEMA_VERSION,
      updatedAt: new Date().toISOString()
    };
    const tmp = `${this.wrongBookPath}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(final, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, this.wrongBookPath);
    return final;
  }

  // Wrong-book mutation, called once per recorded attempt. The card argument
  // already has the new attempt appended to card.attempts.
  applyAttemptToWrongBook(card) {
    const lastAttempt = card.attempts[card.attempts.length - 1];
    if (!lastAttempt) return;

    const book = this.readWrongBook();
    const idx = book.entries.findIndex((e) => e.cardId === card.id);

    if (idx === -1) {
      // Not currently in the book — only add if this attempt was wrong.
      if (!lastAttempt.correct) {
        book.entries.push({
          cardId: card.id,
          addedAt: lastAttempt.at,
          consecutiveCorrect: 0,
          totalMisses: 1,
          lastAttemptAt: lastAttempt.at,
          card: cloneCardForBook(card)
        });
        this.writeWrongBook(book);
      }
      return;
    }

    const entry = book.entries[idx];
    entry.lastAttemptAt = lastAttempt.at;
    if (lastAttempt.correct) {
      entry.consecutiveCorrect += 1;
      // Mastered? Removed from book. Per-difficulty threshold lives in
      // shared/cards.js#MASTERY_THRESHOLD. We use entry.consecutiveCorrect
      // as the source of truth so the same logic works for replay (where
      // there is no card.attempts history at all).
      if (entry.consecutiveCorrect >= masteryThresholdFor(card)) {
        book.entries.splice(idx, 1);
      }
    } else {
      entry.consecutiveCorrect = 0;
      entry.totalMisses += 1;
      entry.card = cloneCardForBook(card);
    }
    this.writeWrongBook(book);
  }
}

// Strip the mutable attempts array — the wrong-book entry tracks its own
// consecutive count separately, and we don't want today's attempts to
// persist forever in the book snapshot.
function cloneCardForBook(card) {
  const clone = { ...card };
  delete clone.attempts;
  return clone;
}

module.exports = { CardsStore };
