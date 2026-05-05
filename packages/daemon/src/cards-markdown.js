// Markdown export for Knowledge Cards (Stage 1.5).
//
// Three composer entry points map to the user-visible Settings buttons:
//   - composeDayMarkdown(payload)         → single-day (Today / a History row)
//   - composeAllAbstractsMarkdown(items)  → every stored day, joined with `---`
//   - composeWrongBookMarkdown(book)      → all currently-active wrong-book entries
//
// All outputs share a YAML frontmatter contract so a downstream tool
// (Obsidian, dataview, an Anki importer, etc.) can read the metadata
// without re-parsing prose. Card Q/A pairs use a `**Q**` / `**A**` two-
// line shape that's trivially convertible to Anki .csv with cut.

function composeDayMarkdown(payload) {
  if (!payload) return "";
  const lines = [];

  const stats = payload.stats || {};
  const sourceCounts = payload.sourceCounts || { session: 0, web: 0 };
  const totalCards = Array.isArray(payload.cards) ? payload.cards.length : 0;
  const correctCards = totalCards
    ? payload.cards.filter((c) => {
        const last = Array.isArray(c.attempts) && c.attempts.length
          ? c.attempts[c.attempts.length - 1]
          : null;
        return last && last.correct;
      }).length
    : 0;

  // --- frontmatter ---
  lines.push("---");
  lines.push(`date: ${payload.date}`);
  if (payload.focusSnapshot) {
    lines.push("focus: |");
    for (const ln of String(payload.focusSnapshot).split("\n")) {
      lines.push(`  ${ln}`);
    }
  }
  if (typeof payload.focusCoverage === "number") {
    lines.push(`focus_coverage: ${payload.focusCoverage}`);
  }
  if (payload.difficultyPreference) {
    lines.push(`difficulty: ${payload.difficultyPreference}`);
  }
  if (stats.sessions) lines.push(`sessions: ${stats.sessions}`);
  if (stats.durationMin) lines.push(`duration_min: ${stats.durationMin}`);
  lines.push(`cards: ${totalCards}`);
  lines.push(`correct: ${correctCards}`);
  if (sourceCounts.web > 0) {
    lines.push(`source_session: ${sourceCounts.session}`);
    lines.push(`source_web: ${sourceCounts.web}`);
  }
  if (payload.replay) lines.push(`replay: true`);
  if (payload.updatedAt) lines.push(`generated_at: ${payload.updatedAt}`);
  lines.push("---");
  lines.push("");

  // --- title + abstract ---
  const heading = formatHeading(payload.date);
  lines.push(`# ${heading}`);
  lines.push("");

  const subtitleParts = [];
  if (stats.sessions) subtitleParts.push(`${stats.sessions} sessions`);
  if (stats.durationMin) subtitleParts.push(`${stats.durationMin} min`);
  if (sourceCounts.web > 0) subtitleParts.push(`${sourceCounts.web} web cards`);
  if (subtitleParts.length) {
    lines.push(`_${subtitleParts.join(" · ")}_`);
    lines.push("");
  }

  if (payload.abstract) {
    lines.push(String(payload.abstract).trim());
    lines.push("");
  }

  // --- cards ---
  if (totalCards > 0) {
    lines.push("---");
    lines.push("");
    lines.push("## Cards");
    lines.push("");
    payload.cards.forEach((card, index) => {
      lines.push(...formatCardBlock(card, index + 1));
      lines.push("");
    });
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function composeAllAbstractsMarkdown(items) {
  // items: array of [{date, payload}], newest-first
  const blocks = [];
  blocks.push("---");
  blocks.push(`scope: all-abstracts`);
  blocks.push(`generated_at: ${new Date().toISOString()}`);
  blocks.push(`count: ${items.length}`);
  blocks.push("---");
  blocks.push("");
  blocks.push("# Vibedog-for-agents abstracts — full history");
  blocks.push("");

  for (const item of items) {
    const payload = item.payload;
    if (!payload) continue;
    blocks.push(`## ${formatHeading(payload.date)}${item.archivedAt ? ` · ${item.archivedAt} (earlier)` : ""}`);
    blocks.push("");
    if (payload.focusSnapshot) {
      blocks.push(`> Focus: ${oneLine(payload.focusSnapshot)}`);
      blocks.push("");
    }
    if (payload.abstract) {
      blocks.push(String(payload.abstract).trim());
      blocks.push("");
    }
    blocks.push("---");
    blocks.push("");
  }

  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function composeWrongBookMarkdown(book) {
  const entries = Array.isArray(book && book.entries) ? book.entries : [];
  const lines = [];
  lines.push("---");
  lines.push(`scope: wrong-book`);
  lines.push(`generated_at: ${new Date().toISOString()}`);
  lines.push(`entries: ${entries.length}`);
  lines.push("---");
  lines.push("");
  lines.push("# Wrong book");
  lines.push("");
  lines.push(`_${entries.length} card${entries.length === 1 ? "" : "s"} waiting for mastery._`);
  lines.push("");

  if (entries.length === 0) {
    lines.push("No missed cards.");
    return lines.join("\n") + "\n";
  }

  entries.forEach((entry, index) => {
    const card = entry.card || {};
    lines.push(`## ${index + 1}. ${oneLine(card.question || "(missing question)")}`);
    lines.push("");
    const meta = [
      card.difficulty ? `difficulty: ${card.difficulty}` : null,
      card.type ? `type: ${card.type}` : null,
      `consecutive correct: ${entry.consecutiveCorrect || 0}`,
      `total misses: ${entry.totalMisses || 0}`,
      entry.addedAt ? `added: ${entry.addedAt}` : null,
      entry.lastAttemptAt ? `last attempt: ${entry.lastAttemptAt}` : null
    ].filter(Boolean);
    lines.push(meta.map((m) => `- ${m}`).join("\n"));
    lines.push("");
    lines.push(...formatCardBody(card));
    lines.push("");
    lines.push("---");
    lines.push("");
  });

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ============================================================
// Internals
// ============================================================

function formatCardBlock(card, ordinal) {
  const lines = [];
  const tag = [card.difficulty, card.type].filter(Boolean).join(" · ") || "card";
  lines.push(`### ${ordinal}. (${tag})`);
  lines.push("");
  lines.push(...formatCardBody(card));
  return lines;
}

function formatCardBody(card) {
  const lines = [];
  lines.push(`**Q**: ${oneLine(card.question || "")}`);
  lines.push("");

  if (card.type === "choice" && Array.isArray(card.options)) {
    const correctIdx = typeof card.answer === "number"
      ? card.answer
      : card.options.findIndex((o) => String(o) === String(card.answer));
    card.options.forEach((opt, idx) => {
      const letter = String.fromCharCode(65 + idx);
      const mark = idx === correctIdx ? "✓ " : "";
      lines.push(`- ${letter}. ${mark}${oneLine(String(opt))}`);
    });
    lines.push("");
    const correctLetter = correctIdx >= 0 ? String.fromCharCode(65 + correctIdx) : "?";
    const correctText = correctIdx >= 0 ? String(card.options[correctIdx] || "") : "";
    lines.push(`**A**: ${correctLetter}${correctText ? ` — ${oneLine(correctText)}` : ""}`);
  } else if (card.type === "cloze") {
    lines.push(`**A**: ${oneLine(String(card.answer || ""))}`);
  } else {
    lines.push(`**A**: ${oneLine(String(card.answer || ""))}`);
  }

  // explanation + source attribution
  if (card.explanation && card.explanation.snippet) {
    lines.push("");
    lines.push(`> ${card.explanation.fromSession === false ? "Explanation" : "From session"}: ${oneLine(card.explanation.snippet)}`);
  }

  const source = card.source;
  if (source && (source.snippet || source.fileRef)) {
    lines.push("");
    if (source.kind === "web") {
      lines.push(`> source (🌐 web): ${source.fileRef || ""}${source.webTitle ? ` — ${source.webTitle}` : ""}`);
    } else if (source.fileRef) {
      lines.push(`> source: ${source.fileRef}${source.sessionId ? ` (session ${source.sessionId})` : ""}`);
    } else if (source.sessionId) {
      lines.push(`> source: session ${source.sessionId}`);
    }
  }

  return lines;
}

function formatHeading(date) {
  if (!date) return "(no date)";
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  const weekday = d.toLocaleDateString("en-US", { weekday: "long" });
  return `${date} · ${weekday}`;
}

function oneLine(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

module.exports = {
  composeDayMarkdown,
  composeAllAbstractsMarkdown,
  composeWrongBookMarkdown
};
