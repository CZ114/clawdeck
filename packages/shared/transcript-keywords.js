// Keyword table used by the cards generator to bias transcript reading
// toward lines that look like a conversation summary / recap. When the
// per-session character budget can't hold the whole transcript, lines
// matching these keywords are kept first (then the rest in chronological
// order until the budget is exhausted).
//
// Each entry has:
//   - tokens: case-insensitive substrings; matched as whole-ish words.
//   - weight: higher = more "summary-like".
//   - lang:   "en" | "zh" | "any" — purely informational, lets translators
//             pick a slice to extend without re-deriving the whole table.
//
// To add a language, append more entries; do NOT replace existing English
// keys (the model + Claude Code's own auto-compact text is English).

const KEYWORDS = [
  // Claude Code's auto-compact / summary markers (highest signal)
  { tokens: ["compact summary", "compact-summary", "auto-compact", "context compact"], weight: 8, lang: "en" },
  { tokens: ["session summary", "summary of the session", "previous conversation summary"], weight: 8, lang: "en" },
  { tokens: ["abstract:", "## abstract", "# abstract"], weight: 7, lang: "en" },

  // Decision / outcome words — flag where the conversation concluded something
  { tokens: ["decision:", "conclusion:", "summary:", "tl;dr", "tldr"], weight: 6, lang: "en" },
  { tokens: ["resolved:", "fixed:", "shipped:", "merged:", "closed:"], weight: 5, lang: "en" },
  { tokens: ["root cause", "the bug was", "the issue was", "turned out to be"], weight: 5, lang: "en" },

  // Recap / summary verbs (lower weight — common but useful)
  { tokens: ["in summary", "to summarize", "to recap", "key takeaway", "key takeaways", "main point"], weight: 4, lang: "en" },
  { tokens: ["what we did", "we ended up", "ended up with", "final approach"], weight: 4, lang: "en" },

  // ADR / doc / architecture markers (often the keep-worthy artifact)
  { tokens: ["adr-", "rfc-", "architecture decision", "design decision"], weight: 5, lang: "en" },

  // Chinese summary markers
  { tokens: ["总结", "小结", "摘要", "结论"], weight: 6, lang: "zh" },
  { tokens: ["最终方案", "最终决定", "解决方案", "根本原因"], weight: 5, lang: "zh" },
  { tokens: ["简而言之", "一句话", "回顾一下"], weight: 4, lang: "zh" },
  { tokens: ["搞定", "修好了", "已合并", "已发布"], weight: 4, lang: "zh" }
];

// Pre-flatten for fast scoring. Each entry: { needle (lowercased), weight }.
const FLAT = KEYWORDS.flatMap((row) =>
  row.tokens.map((t) => ({ needle: t.toLowerCase(), weight: row.weight }))
);

// Score a single block of text. Score = sum of weights of matching keywords,
// capped per keyword (matching the same word 10 times shouldn't dominate).
// Returns 0 for empty/non-string input.
function keywordScore(text) {
  if (!text || typeof text !== "string") return 0;
  const hay = text.toLowerCase();
  let score = 0;
  for (const { needle, weight } of FLAT) {
    if (hay.includes(needle)) score += weight;
  }
  return score;
}

// Returns true if the text contains *any* summary keyword. Cheap path for
// callers that only care about "is this worth keeping".
function hasSummaryKeyword(text) {
  if (!text || typeof text !== "string") return false;
  const hay = text.toLowerCase();
  for (const { needle } of FLAT) {
    if (hay.includes(needle)) return true;
  }
  return false;
}

module.exports = {
  KEYWORDS,
  keywordScore,
  hasSummaryKeyword
};
