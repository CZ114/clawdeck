// Daily-review streak (Stage 1.5).
//
// Stateless: re-derived from the cards/<date>.json files on each request.
// Avoids a separate streak.json that could drift from the underlying decks
// after manual file edits / restored backups.
//
// "Completed day" = the date file exists AND every card has at least one
// attempt recorded. Quality (right/wrong) doesn't matter — wrong answers
// migrate to the wrong book; the streak rewards showing up.
//
// "Empty day" = the date file exists but state === "empty" OR has zero
// cards in the array (replay engaged but the user still hadn't reviewed).
// A missing date file also counts as empty for the protection rule.
//
// Protection rule (per ADR §"Decision 8"):
//   - 1 consecutive empty day → 🛡 protected, streak preserved.
//   - 2+ consecutive empty days → streak resets to 0.
//
// We walk back from `today` until the streak chain breaks.

const fs = require("node:fs");
const path = require("node:path");
const { todayLocalDate } = require("../../shared/cards");

// Hard cap so a malformed cards dir can't make us walk forever.
const MAX_LOOKBACK_DAYS = 365;

class CardsStreak {
  constructor({ cardsStore }) {
    if (!cardsStore || typeof cardsStore.readDay !== "function") {
      throw new Error("CardsStreak requires a cardsStore with readDay()");
    }
    this.cardsStore = cardsStore;
  }

  // Compute the user's current streak as of today.
  // Returns { count, todayState, lastCompletedDate, asOf, todayProtected }.
  //   todayState: "completed" | "empty" | "missing" | "in-progress"
  //   - completed: today's deck exists AND every card attempted
  //   - empty: today exists with state==="empty" or zero cards
  //   - missing: no deck file for today yet
  //   - in-progress: today exists with cards but not all attempted
  // count: number of consecutive completed days, allowing exactly ONE
  //   empty/missing day in the chain as a shield.
  compute() {
    const asOf = todayLocalDate();
    const todayState = classifyDay(this.cardsStore.readDay(asOf));

    // Decide where to start walking and whether the shield is already used.
    //   completed   → today counts; walk from yesterday with shield available
    //   empty       → today consumes the shield; walk from yesterday w/o shield
    //   in-progress → today doesn't qualify yet; walk from yesterday w/ shield
    //   missing     → no review today; walk from yesterday with shield available
    //                 (the shield is for "missed day", not just "no sessions")
    let count = 0;
    let lastCompletedDate = null;
    let allowShield = true;
    if (todayState === "completed") {
      count = 1;
      lastCompletedDate = asOf;
    } else if (todayState === "empty") {
      allowShield = false;
    }

    let cursor = shiftDate(asOf, -1);
    for (let i = 0; i < MAX_LOOKBACK_DAYS; i += 1) {
      const state = classifyDay(this.cardsStore.readDay(cursor));
      if (state === "completed") {
        count += 1;
        if (!lastCompletedDate) lastCompletedDate = cursor;
      } else if (state === "empty" || state === "missing") {
        if (!allowShield) break;
        allowShield = false;
      } else {
        break;  // in-progress (older) breaks the chain
      }
      cursor = shiftDate(cursor, -1);
    }

    return {
      asOf,
      count,
      todayState,
      // Shield is "in use" only when today itself is the empty day AND there
      // was a streak to protect (count would otherwise be > 0).
      todayProtected: todayState === "empty" && count > 0,
      lastCompletedDate
    };
  }
}

// Pure helper for unit-testability.
function classifyDay(payload) {
  if (!payload) return "missing";
  if (payload.state === "empty") return "empty";
  const cards = Array.isArray(payload.cards) ? payload.cards : [];
  if (cards.length === 0) return "empty";
  const allAttempted = cards.every((c) => Array.isArray(c.attempts) && c.attempts.length > 0);
  return allAttempted ? "completed" : "in-progress";
}

// Shift a YYYY-MM-DD date by `days` (positive or negative) using local
// time semantics so it matches todayLocalDate().
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  const yy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

module.exports = { CardsStreak, classifyDay, shiftDate };
