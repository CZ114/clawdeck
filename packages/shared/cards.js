// Schema, validators, and pure logic for the Knowledge Cards feature
// (Stage 1.5). Lives in `shared/` so the daemon, the future generator
// subprocess wrapper, and any tests can all share one definition.
//
// Decisions captured in docs/decisions/ADR-20260503-knowledge-cards.md.

const SCHEMA_VERSION = 1;

const DIFFICULTIES = ["easy", "medium", "hard"];
const CARD_TYPES = ["choice", "cloze"];
const DAY_STATES = ["empty", "ready", "replay"];

// Per-difficulty mastery threshold. A wrong-book entry is removed once the
// user has answered the same card correctly this many times in a row. Hard
// cards demand more reps because their material is more foundation-level —
// getting it once might be lucky; getting it three times in a row signals
// real grasp. (ADR §"Decision 9".)
const MASTERY_THRESHOLD = {
  easy: 2,
  medium: 2,
  hard: 3
};

// Streak survives this many consecutive empty days before resetting. The
// 1-day grace prevents one busy or sick day from killing a multi-week
// streak; longer would dilute the streak's meaning. (ADR §"Decision 8".)
const STREAK_SHIELD_DAYS = 1;

function todayLocalDate(now = new Date()) {
  // YYYY-MM-DD in *local* time so the day boundary lines up with the user's
  // wall clock rather than UTC.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isValidDifficulty(value) {
  return DIFFICULTIES.includes(value);
}

function isValidCardType(value) {
  return CARD_TYPES.includes(value);
}

function isValidDayState(value) {
  return DAY_STATES.includes(value);
}

function emptyDayPayload(date) {
  return {
    schemaVersion: SCHEMA_VERSION,
    date,
    state: "empty",
    cards: [],
    abstract: "",
    focusSnapshot: "",
    focusCoverage: null,
    sourceSessionIds: [],
    stats: { sessions: 0, durationMin: 0 },
    createdAt: null,
    updatedAt: null,
    replay: false
  };
}

function emptyWrongBook() {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: null,
    entries: []
  };
}

function normalizeAttempt(attempt) {
  if (!attempt || typeof attempt !== "object") {
    return null;
  }
  return {
    at: typeof attempt.at === "string" && attempt.at ? attempt.at : new Date().toISOString(),
    picked: attempt.picked === undefined || attempt.picked === null
      ? ""
      : String(attempt.picked),
    correct: Boolean(attempt.correct),
    durationMs: Number.isFinite(attempt.durationMs) ? Number(attempt.durationMs) : null
  };
}

// Compare a user's answer against the card's stored answer. The daemon
// computes correctness server-side rather than trusting the client — keeps
// wrong-book state honest and lets the future generator change answer
// representations without breaking older bubbles.
function checkAnswer(card, picked) {
  if (!card) return false;
  if (card.type === "choice") {
    if (typeof card.answer === "number") {
      return Number(picked) === card.answer;
    }
    return String(picked) === String(card.answer);
  }
  if (card.type === "cloze") {
    return String(picked || "").trim() === String(card.answer || "").trim();
  }
  return false;
}

// Returns true if the card's recent attempt tail meets the per-difficulty
// mastery threshold. Used by the wrong-book updater to decide whether an
// entry should be removed.
function isMastered(card) {
  if (!card || !Array.isArray(card.attempts)) return false;
  const threshold = MASTERY_THRESHOLD[card.difficulty] || 2;
  if (card.attempts.length < threshold) return false;
  const tail = card.attempts.slice(-threshold);
  return tail.every((a) => a && a.correct);
}

// Validate a card payload coming from the generator (or a stub fixture).
// Strict-source mode is hard-coded: a card without a verbatim source.snippet
// is rejected. (ADR §"Decision 7".)
function validateCard(card) {
  if (!card || typeof card !== "object") {
    return { ok: false, reason: "card-not-object" };
  }
  if (!card.id || typeof card.id !== "string") {
    return { ok: false, reason: "card-missing-id" };
  }
  if (!isValidCardType(card.type)) {
    return { ok: false, reason: "card-bad-type" };
  }
  if (!isValidDifficulty(card.difficulty)) {
    return { ok: false, reason: "card-bad-difficulty" };
  }
  if (!card.question || typeof card.question !== "string") {
    return { ok: false, reason: "card-missing-question" };
  }
  if (card.answer === undefined || card.answer === null || card.answer === "") {
    return { ok: false, reason: "card-missing-answer" };
  }
  if (card.type === "choice") {
    if (!Array.isArray(card.options) || card.options.length < 2) {
      return { ok: false, reason: "choice-needs-options" };
    }
  }
  const source = card.source;
  if (!source || typeof source !== "object") {
    return { ok: false, reason: "card-missing-source" };
  }
  if (!source.snippet || typeof source.snippet !== "string" || !source.snippet.trim()) {
    return { ok: false, reason: "card-source-snippet-empty" };
  }
  return { ok: true };
}

module.exports = {
  SCHEMA_VERSION,
  DIFFICULTIES,
  CARD_TYPES,
  DAY_STATES,
  MASTERY_THRESHOLD,
  STREAK_SHIELD_DAYS,
  todayLocalDate,
  isValidDate,
  isValidDifficulty,
  isValidCardType,
  isValidDayState,
  emptyDayPayload,
  emptyWrongBook,
  normalizeAttempt,
  checkAnswer,
  isMastered,
  validateCard
};
