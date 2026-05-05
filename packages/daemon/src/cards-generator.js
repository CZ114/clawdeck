// Knowledge Cards generator (Stage 1.5).
//
// Spawns the user's local `claude` CLI in headless mode (`-p`) and feeds it
// a structured prompt built from the daemon's recent session + audit
// activity. Parses cards JSON back, validates against the strict-source
// schema in shared/cards.js, and returns a payload ready for the cards
// store.
//
// Why subprocess and not the Anthropic API: the user already has Claude
// Code installed and authenticated; reusing it avoids a separate API key,
// a separate billing surface, and any auth lifecycle code on our side.
//
// Envs:
//   CCC_CARDS_USE_STUB=true            — bypass spawn, return seeded sample
//   CCC_CARDS_GENERATE_TIMEOUT_MS=N    — kill subprocess after N ms (def 120000)
//   CCC_CLAUDE_BIN=path                — override the CLI binary path
//
// Returned shape (always — never throws to caller):
//   { payload: { ...cards-store day shape... } | null,
//     dropped: [{ id, reason }, ...],
//     stub: boolean,
//     error: string | null,
//     prompt: string | null }    // included for debug surface; not phone-visible

const { spawn } = require("node:child_process");
const { todayLocalDate, validateCard } = require("../../shared/cards");
const { PROMPT_TEMPLATES, LOCALES, DEFAULT_LOCALE } = require("../../shared/i18n");

// Default timeouts: WebSearch / WebFetch runs add a lot — each tool call
// is a real HTTP roundtrip and the model often makes 2-3 of them before
// settling. 120s was tight even on a fast network.
const GENERATE_TIMEOUT_NO_WEB_MS = Number(process.env.CCC_CARDS_GENERATE_TIMEOUT_MS || 180_000);
const GENERATE_TIMEOUT_WITH_WEB_MS = Number(process.env.CCC_CARDS_GENERATE_TIMEOUT_WEB_MS || 360_000);
const USE_STUB = process.env.CCC_CARDS_USE_STUB === "true";
const CLAUDE_BIN = process.env.CCC_CLAUDE_BIN || "claude";

const DIFFICULTY_DESCRIPTIONS = {
  casual:   "≈ 70% easy / 25% medium / 5% hard (concept-heavy)",
  balanced: "≈ 50% easy / 35% medium / 15% hard",
  deep:     "≈ 25% easy / 40% medium / 35% hard (foundation-heavy)"
};

async function generateCards({
  focus,
  difficulty,
  windowDays,
  targetDate,
  cardCount,
  webFallback,
  locale,        // "en" | "zh" — selects bilingual prompt template
  sessions,
  auditEvents,
  transcripts,  // [{sessionId, cwd, text}, ...] — real per-session content
  sourceDateRange, // {from, to, days} | null — span of the included sessions
  sampleDeckPayload  // injected fallback for stub / spawn-failure paths
}) {
  const date = isValidDate(targetDate) ? targetDate : todayLocalDate();
  const window = clamp(Number(windowDays) || 1, 1, 60);
  const focusText = String(focus || "").trim();
  const difficultyKey = ["casual", "balanced", "deep"].includes(difficulty) ? difficulty : "balanced";
  const count = clamp(Number(cardCount) || 5, 1, 20);
  const webAllowed = webFallback !== false;
  const localeKey = LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;

  if (USE_STUB) {
    return wrapStub(sampleDeckPayload, { date, focus: focusText, difficulty: difficultyKey });
  }

  let prompt;
  try {
    const transcript = formatTranscript({
      sessions,
      auditEvents,
      transcripts,
      windowDays: window,
      anchorDate: date
    });
    prompt = composePrompt({
      focus: focusText,
      difficulty: difficultyKey,
      transcript: redact(transcript),
      date,
      windowDays: window,
      cardCount: count,
      webAllowed,
      locale: localeKey,
      sourceDateRange
    });
  } catch (error) {
    return errorResult(error, { date, focus: focusText, difficulty: difficultyKey });
  }

  let raw;
  try {
    raw = await spawnClaude(prompt, { webAllowed });
  } catch (error) {
    // Fall back to stub IF and ONLY IF it's a "spawn failed" type error
    // (claude not on PATH, etc.) — that way an unauth'd dev environment
    // still gets a working bubble. Real subprocess failures (model
    // refused / timed out) propagate as errors.
    if (isSpawnFailure(error)) {
      const stub = wrapStub(sampleDeckPayload, { date, focus: focusText, difficulty: difficultyKey });
      stub.error = `claude CLI not available (${error.message}); using stub deck`;
      stub.prompt = prompt;
      return stub;
    }
    return errorResult(error, { date, focus: focusText, difficulty: difficultyKey, prompt });
  }

  let parsed;
  try {
    parsed = parseModelResponse(raw);
  } catch (error) {
    return errorResult(
      new Error(`Could not parse cards JSON from claude -p output: ${error.message}`),
      { date, focus: focusText, difficulty: difficultyKey, prompt, raw }
    );
  }

  return composePayload({
    date,
    focus: focusText,
    difficulty: difficultyKey,
    parsed,
    prompt,
    sourceDateRange
  });
}

// ============================================================
// Prompt composition
// ============================================================

function composePrompt({ focus, difficulty, transcript, date, windowDays, cardCount, webAllowed, locale, sourceDateRange }) {
  const localeKey = LOCALES.includes(locale) ? locale : DEFAULT_LOCALE;
  const tpl = PROMPT_TEMPLATES[localeKey] || PROMPT_TEMPLATES[DEFAULT_LOCALE];
  // Output language directive — the model follows the prompt's language
  // when generating the abstract + question text. JSON keys stay English
  // (they're parsed structurally, never shown to the user).
  const outputLanguageDirective = localeKey === "zh"
    ? `IMPORTANT: All natural-language card text (questions, options, abstract, explanation snippets) MUST be in Simplified Chinese (中文). JSON keys stay English.`
    : `IMPORTANT: All natural-language card text MUST be in English. JSON keys stay English.`;
  // When the user picked sessions explicitly, the "past N days" framing
  // is misleading — the activity log might be 4 days from a fortnight
  // ago, not "today". Tell the model the real span so the abstract
  // doesn't open with "今天" / "this day" when the source is older.
  const spanLine = sourceDateRange && sourceDateRange.from
    ? sourceDateRange.from === sourceDateRange.to
      ? `Activity span: a single day (${sourceDateRange.from})`
      : `Activity span: ${sourceDateRange.from} → ${sourceDateRange.to} (${sourceDateRange.days} day${sourceDateRange.days === 1 ? "" : "s"} of activity, possibly with gaps)`
    : `Activity window: past ${windowDays} day${windowDays === 1 ? "" : "s"}`;
  // Force the abstract to acknowledge the span — without this directive
  // the model still defaults to "这一天 ..." even when the activity log
  // covers a multi-day stretch.
  const spanDirective = sourceDateRange && sourceDateRange.from
    ? sourceDateRange.from === sourceDateRange.to
      ? `In the abstract opening line, refer to the source date explicitly (e.g. "${sourceDateRange.from}" / "On ${sourceDateRange.from}, …" / "${sourceDateRange.from} 这一天，…"). Do NOT call it "today" / "这一天" without the date — the deck may be reviewed days later.`
      : `In the abstract opening line, refer to the source span explicitly (e.g. "Across ${sourceDateRange.from}–${sourceDateRange.to} (${sourceDateRange.days} days), …" / "${sourceDateRange.from} 到 ${sourceDateRange.to} 这 ${sourceDateRange.days} 天里，…"). Do NOT use singular phrases like "today" / "this day" / "这一天" — the activity is multi-day.`
    : null;

  return [
    tpl.intro,
    ``,
    `Today's date: ${date}`,
    spanLine,
    `Target card count: ${cardCount} cards (best effort; produce as close as possible)`,
    ``,
    outputLanguageDirective,
    ``,
    spanDirective,
    spanDirective ? `` : null,
    focus
      ? [
          `User's stated learning focus:`,
          `"""`,
          focus,
          `"""`,
          ``,
          `Weight card selection toward this focus when relevant content exists.`
        ].join("\n")
      : `User did not set a focus — pick the most consequential decisions over trivia.`,
    ``,
    `Difficulty preference: ${difficulty} (${DIFFICULTY_DESCRIPTIONS[difficulty]})`,
    ``,
    `Difficulty definitions:`,
    `- "easy"   — conceptual ("what is X" / "why does X exist")`,
    `- "medium" — mechanism / implementation ("X works this way because Y")`,
    `- "hard"   — foundation / math / OS-level ("the underlying reason X behaves this way")`,
    ``,
    `=== ACTIVITY LOG (verbatim) ===`,
    transcript,
    `=== END LOG ===`,
    ``,
    `CRITICAL — STRICT SOURCE MODE`,
    `Every card MUST carry source.snippet with a verbatim quote (10+ characters)`,
    `from either the activity log above OR (if web fallback applies — see below)`,
    `from a verifiable web page. Do NOT paraphrase. Do NOT invent quotes.`,
    `Cards without a verifiable source MUST NOT be generated.`,
    ``,
    webAllowed ? [
      `=== WEB FALLBACK POLICY (web tools enabled) ===`,
      ``,
      `PREFER cards sourced from the activity log above. Only use the web when:`,
      `  (a) the user set a focus, AND`,
      `  (b) the activity log contains nothing relevant to that focus`,
      ``,
      `When you fall back to web, use WebSearch to find an authoritative page,`,
      `then WebFetch to read it. Each web-sourced card MUST set:`,
      `  - source.kind = "web"`,
      `  - source.sessionId = "web"`,
      `  - source.snippet = <verbatim quote, 10+ chars, from the page>`,
      `  - source.fileRef = <full https:// URL>`,
      `  - source.webTitle = <page title, if available>`,
      ``,
      `AND prefix the question with: "(no matching session content — sourced from web) "`,
      ``,
      `For session-sourced cards (the default), use:`,
      `  - source.kind = "session"`,
      `  - source.sessionId = <real id from activity log>`,
      `  - source.snippet = <verbatim quote from the log>`,
      `  - source.fileRef = <best-guess path:line if relevant>`,
      ``,
      `Mix both kinds if useful. The user wants to know which is which —`,
      `your tagging is the only signal they get. NEVER claim a quote came`,
      `from session content if it didn't.`
    ].join("\n") : [
      `=== WEB FALLBACK DISABLED ===`,
      ``,
      `Web tools are not allowed in this run. If the activity log lacks`,
      `enough relevant material, return an empty cards array and report`,
      `focusCoverage: 0. Do NOT invent content.`
    ].join("\n"),
    ``,
    `STRING ESCAPING — these break JSON.parse and have crashed prior runs:`,
    `- NEVER use raw " (ASCII 0x22) inside any string value for emphasis.`,
    `- For Chinese emphasis use 「」 corner brackets, e.g. 消除了「本地脚本不存在」的问题.`,
    `- For English emphasis use backticks or single quotes, e.g. 'this case' or \`this case\`.`,
    `- If a literal " MUST appear in a value (rare — e.g. quoting a string`,
    `  literal from the activity log), escape it as \\".`,
    `- Newlines inside string values must be \\n, never raw line breaks.`,
    ``,
    `OUTPUT FORMAT — RAW JSON ONLY, no markdown fence, no commentary, no leading thought:`,
    `{`,
    `  "abstract": "## Day title\\n\\n${tpl.abstractInstruction}",`,
    `  "focusCoverage": 0..100,`,
    `  "cards": [`,
    `    {`,
    `      "id": "card_<short-random>",`,
    `      "type": "choice" | "cloze",`,
    `      "difficulty": "easy" | "medium" | "hard",`,
    `      "question": "...",`,
    `      "options": ["A","B","C","D"],   // choice only`,
    `      "answer": <number-index> | "<string>",`,
    `      "source": {`,
    `        "kind": "session" | "web",`,
    `        "sessionId": "<from log>" | "web",`,
    `        "snippet": "<verbatim quote>",`,
    `        "fileRef": "<file:line OR https:// URL>",`,
    `        "webTitle": "<page title — web only, optional>"`,
    `      },`,
    `      "explanation": {`,
    `        "fromSession": true | false,`,
    `        "snippet": "<1-2 sentence explanation grounded in the source>"`,
    `      }`,
    `    }`,
    `  ]`,
    `}`,
    ``,
    `Output the JSON object now and only the JSON object.`
  ].filter(Boolean).join("\n");
}

function formatTranscript({ sessions, auditEvents, transcripts, windowDays, anchorDate }) {
  const cutoffMs = Date.parse(`${anchorDate}T00:00:00`) - (windowDays - 1) * 24 * 60 * 60 * 1000;

  const sessionLines = (Array.isArray(sessions) ? sessions : []).map((s) => {
    const parts = [
      `[session ${s.sessionId || "(unknown)"}]`,
      `status=${s.status || "?"}`,
      s.tool ? `tool=${s.tool}` : "",
      s.cwd ? `cwd=${s.cwd}` : "",
      s.summary ? `summary=${s.summary}` : ""
    ].filter(Boolean);
    return parts.join("  ");
  });

  const eventLines = [];
  for (const ev of (Array.isArray(auditEvents) ? auditEvents : [])) {
    const ts = Date.parse(ev.createdAt);
    if (Number.isFinite(ts) && ts < cutoffMs) continue;
    if (ev.type === "permission_request") {
      eventLines.push(`[${ev.createdAt}] PERMISSION_REQUEST ${ev.tool} risk=${ev.risk} ${ev.summary || ""}`);
    } else if (ev.type === "permission_decision") {
      eventLines.push(`[${ev.createdAt}] PERMISSION_DECISION ${ev.decision} ${ev.requestId || ""} ${ev.reason || ""}`);
    } else if (ev.type === "cards_generated" || ev.type === "card_answered") {
      // skip self-referential events
    } else {
      eventLines.push(`[${ev.createdAt}] ${ev.type}`);
    }
  }

  // Real transcript blocks (Slice 3B). The daemon handler resolves these
  // from transcript-index + transcript-reader before calling. Each block
  // is already prompt-formatted (role-tagged messages, redacted, capped).
  const transcriptBlocks = (Array.isArray(transcripts) ? transcripts : []).map((t) => {
    const header = `=== Session ${t.sessionId || "(unknown)"}${t.cwd ? `  cwd=${t.cwd}` : ""} ===`;
    return `${header}\n${t.text}`;
  });

  if (sessionLines.length === 0 && eventLines.length === 0 && transcriptBlocks.length === 0) {
    return "(no recorded activity in window — generate cards based on whatever signal you can extract from the empty state, or report focusCoverage=0 with empty cards array)";
  }

  const parts = [
    `--- sessions (${sessionLines.length}) ---`,
    sessionLines.join("\n") || "(none)",
    ``,
    `--- audit events (${eventLines.length}, newest last) ---`,
    eventLines.join("\n") || "(none)"
  ];

  if (transcriptBlocks.length > 0) {
    parts.push(``);
    parts.push(`--- transcripts (${transcriptBlocks.length} session${transcriptBlocks.length === 1 ? "" : "s"}, real content) ---`);
    parts.push(transcriptBlocks.join("\n\n"));
  }

  return parts.join("\n");
}

// ============================================================
// Redaction (basic; expand in future slice when transcript reading lands)
// ============================================================

const TOKEN_PATTERNS = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,    // Anthropic API key shape
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,        // OpenAI key shape
  /\bghp_[A-Za-z0-9]{20,}\b/g,         // GitHub PAT
  /\bgho_[A-Za-z0-9]{20,}\b/g,         // GitHub OAuth
  /\bAKIA[0-9A-Z]{16}\b/g,             // AWS access key
  /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}\b/gi
];

const ENV_LINE_PATTERN = /^.*\.env(?:\.[A-Za-z0-9_]+)?\b.*$/gm;

function redact(text) {
  if (!text) return "";
  let out = String(text);

  // 1. Strip lines that mention .env / .envrc / secrets/
  out = out.replace(ENV_LINE_PATTERN, "(redacted: .env reference)");
  out = out.replace(/^.*\b(?:secrets|credentials|\.envrc)\/[^\s]+.*$/gm, "(redacted: secrets path)");

  // 2. Replace token-shaped strings with placeholder.
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

// ============================================================
// Subprocess
// ============================================================

function spawnClaude(prompt, { webAllowed } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let child;
    const args = ["-p", "--output-format", "json"];
    if (webAllowed) {
      // WebSearch + WebFetch let the model fall back to authoritative web
      // pages when the user's focus has no transcript match. Disabled by
      // default for stricter privacy / lower token cost.
      args.push("--allowedTools", "WebSearch,WebFetch");
    }
    const timeoutMs = webAllowed ? GENERATE_TIMEOUT_WITH_WEB_MS : GENERATE_TIMEOUT_NO_WEB_MS;
    try {
      child = spawn(CLAUDE_BIN, args, {
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      reject(error);
      return;
    }

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_e) { /* noop */ }
      const hint = webAllowed
        ? "raise CCC_CARDS_GENERATE_TIMEOUT_WEB_MS or turn off web fallback in Settings"
        : "raise CCC_CARDS_GENERATE_TIMEOUT_MS";
      reject(new Error(`claude -p timed out after ${Math.round(timeoutMs / 1000)}s — ${hint}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);  // ENOENT etc. — caller decides whether to fall back to stub
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${stderr.trim().slice(0, 500) || "(no stderr)"}`));
        return;
      }
      resolve(stdout);
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

function isSpawnFailure(error) {
  const code = error && error.code;
  return code === "ENOENT" || code === "EACCES" || code === "ENOTDIR";
}

// ============================================================
// Response parsing
// ============================================================

// claude -p with --output-format json returns a wrapper:
//   { result: "<assistant text>", duration_ms, stop_reason, ... }
// We want the inner JSON we asked the model to emit. The model may also
// occasionally wrap it in ```json fences despite the prompt — strip them.
function parseModelResponse(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout.trim());
  } catch (_e) {
    // Maybe the user has an older claude CLI that emits raw text. Try
    // treating stdout as the assistant text directly.
    return parseInnerCards(stdout);
  }
  if (outer && typeof outer.result === "string") {
    return parseInnerCards(outer.result);
  }
  // Some shapes nest under {messages: [...]}; fall back to outer parse.
  return parseInnerCards(JSON.stringify(outer));
}

function parseInnerCards(text) {
  let body = String(text || "").trim();
  // Strip ``` or ```json fences.
  const fenceMatch = body.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) body = fenceMatch[1].trim();
  // Find the first { ... } block if there's any chatter before/after.
  const firstBrace = body.indexOf("{");
  const lastBrace = body.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    body = body.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(body);
  } catch (firstErr) {
    // Salvage path — the most common breakage we see in zh-locale output
    // is unescaped `"` used for emphasis inside Chinese string values
    // (`从根本上消除了"X"的问题`). Detect any `"..."` span that's
    // surrounded by CJK / Chinese punctuation on both sides AND contains
    // CJK inside, then swap to 「...」 corner brackets and retry. This
    // can't accidentally rewrite legit JSON structure because the
    // look-behind / look-ahead require non-JSON-structural neighbours.
    const repaired = repairUnescapedEmphasisQuotes(body);
    if (repaired !== body) {
      try {
        return JSON.parse(repaired);
      } catch (_secondErr) {
        // Fall through — surface the original error since the salvage
        // didn't help, telling us the breakage is something else.
      }
    }
    throw firstErr;
  }
}

// Replace `"X"` → `「X」` ONLY when:
//  - X contains at least one CJK char (so we won't touch English strings)
//  - the opening `"` is NOT preceded by a JSON structural char (`:`, `{`,
//    `,`, `[`, whitespace, `\`) — which would mean it IS the opening
//    quote of a key/value
//  - the closing `"` is NOT followed by a JSON structural char (`:`, `,`,
//    `}`, `]`, whitespace, end) — same reason for the closing quote
// Anything not matching both fences stays as-is. Run multiple passes so
// we catch nested cases on the same line.
function repairUnescapedEmphasisQuotes(input) {
  const re = /([一-鿿　-〿＀-￯])"([^"\\\n]{1,120}?[一-鿿][^"\\\n]{0,120}?)"(?=[一-鿿　-〿＀-￯])/g;
  let prev = input;
  for (let i = 0; i < 4; i += 1) {
    const next = prev.replace(re, "$1「$2」");
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

// ============================================================
// Payload composition
// ============================================================

function composePayload({ date, focus, difficulty, parsed, prompt, sourceDateRange }) {
  const cards = Array.isArray(parsed && parsed.cards) ? parsed.cards : [];
  const validated = [];
  const dropped = [];

  for (const rawCard of cards) {
    const card = { ...rawCard };
    if (!card.id || typeof card.id !== "string") {
      card.id = `card_${Math.random().toString(36).slice(2, 10)}`;
    }
    if (!Array.isArray(card.attempts)) card.attempts = [];

    const verdict = validateCard(card);
    if (verdict.ok) {
      validated.push(card);
    } else {
      dropped.push({ id: card.id, reason: verdict.reason });
    }
  }

  const abstract = parsed && typeof parsed.abstract === "string" ? parsed.abstract : "";
  const focusCoverage = parsed && Number.isFinite(parsed.focusCoverage)
    ? Math.max(0, Math.min(100, Math.round(parsed.focusCoverage)))
    : null;

  const sourceSessionIds = Array.from(new Set(
    validated
      .map((c) => c.source && c.source.sessionId)
      .filter((s) => typeof s === "string" && s && s !== "web")
  ));
  // Stamp source.kind = "session" on cards that didn't say so explicitly,
  // so the renderer can rely on the field instead of a falsy check.
  for (const c of validated) {
    if (c.source && c.source.kind !== "web") {
      c.source.kind = "session";
    }
  }
  const webCards = validated.filter((c) => c.source && c.source.kind === "web").length;

  return {
    payload: {
      date,
      state: validated.length > 0 ? "ready" : "empty",
      abstract,
      focusSnapshot: focus,
      focusCoverage,
      difficultyPreference: difficulty,
      sourceSessionIds,
      sourceDateRange: sourceDateRange || null,
      sourceCounts: {
        session: validated.length - webCards,
        web: webCards
      },
      stats: { sessions: sourceSessionIds.length, durationMin: 0 },
      cards: validated
    },
    dropped,
    stub: false,
    error: null,
    prompt
  };
}

function wrapStub(sampleDeckPayload, { date, focus, difficulty }) {
  if (typeof sampleDeckPayload !== "function") {
    return errorResult(new Error("Stub deck builder not provided"), { date, focus, difficulty });
  }
  return {
    payload: sampleDeckPayload({ date, focus, difficulty }),
    dropped: [],
    stub: true,
    error: null,
    prompt: null
  };
}

function errorResult(error, { date, focus, difficulty, prompt = null, raw = null }) {
  return {
    payload: null,
    dropped: [],
    stub: false,
    error: error.message || String(error),
    prompt,
    raw,
    requested: { date, focus, difficulty }
  };
}

// ============================================================
// Utilities
// ============================================================

function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

module.exports = {
  generateCards,
  // exposed for unit-style coverage in smoke
  composePrompt,
  formatTranscript,
  redact,
  parseModelResponse,
  composePayload
};
