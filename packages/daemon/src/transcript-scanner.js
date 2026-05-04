// Enumerates Claude Code's per-project transcript JSONL files directly
// from `~/.claude/projects/`, instead of relying solely on the hook-fed
// transcript-index. The index only knows about sessions where Companion's
// hook fired; the scanner picks up everything Claude Code has stored,
// including sessions that pre-date Companion's install or that ran in
// projects where the hook isn't configured.
//
// Layout (Claude Code default):
//   ~/.claude/projects/
//     -Users-name-some-project/
//       <sessionId>.jsonl
//       <sessionId>.jsonl
//     -D--Imperial-individual-claude-code-companion/
//       ...
//
// Project dir names are URL-encoded absolute cwd paths. We best-effort
// decode them back so the prompt context can show "cwd=/Users/.../foo".

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const DEFAULT_CLAUDE_PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

// How many lines to peek per file to pull cwd + firstUserMsgId. Both fields
// usually appear on the very first lines (the user's opening prompt + any
// system-init entries), so 30 is plenty without forcing a full file read.
const PEEK_LINES = 30;

function scanAllProjects({ root = DEFAULT_CLAUDE_PROJECTS_ROOT, sinceMs = 0 } = {}) {
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory());
  } catch (_error) {
    // No ~/.claude/projects yet — nothing to scan.
    return [];
  }

  // First pass: enumerate every JSONL in window with its peek metadata.
  const all = [];
  for (const projectDir of projectDirs) {
    const projectPath = path.join(root, projectDir.name);
    let files;
    try {
      files = fs.readdirSync(projectPath, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".jsonl"));
    } catch (_error) {
      continue;
    }
    for (const file of files) {
      const fullPath = path.join(projectPath, file.name);
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch (_error) {
        continue;
      }
      if (sinceMs > 0 && stat.mtimeMs < sinceMs) continue;
      const sessionId = file.name.replace(/\.jsonl$/, "");
      // Peek first ~30 lines to extract the real cwd + firstUserMsgId.
      // The dir-name decoder is best-effort (a literal "-" in a folder
      // name becomes ambiguous); cwd from inside the JSONL is canonical.
      // firstUserMsgId lets us group --resume forks (CloudCLI approach
      // borrowed from esp32_sensor_dashboard).
      const peek = peekTranscriptHeader(fullPath);
      all.push({
        sessionId,
        transcriptPath: fullPath,
        projectDirEncoded: projectDir.name,
        // Prefer real cwd over the encoded dir name when we can read it.
        projectDirDecoded: peek.cwd || decodeProjectDir(projectDir.name),
        cwdSource: peek.cwd ? "jsonl" : "decoded",
        firstUserMsgId: peek.firstUserMsgId,
        mtime: stat.mtime.toISOString(),
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size
      });
    }
  }

  // Group by firstUserMsgId so `claude --resume` forks (multiple .jsonl
  // files for the same logical conversation) collapse to one entry.
  // Keep the newest fork per group — the most up-to-date fork is the one
  // the user would see in the CLI's "resume" picker.
  const groups = new Map();
  for (const file of all) {
    const key = file.firstUserMsgId || file.sessionId;
    const existing = groups.get(key);
    if (!existing || existing.mtimeMs < file.mtimeMs) {
      // When we replace, surface the fact that this was the latest of N.
      const groupSize = (existing ? existing.groupSize : 0) + 1;
      groups.set(key, { ...file, groupSize });
    } else {
      existing.groupSize = (existing.groupSize || 1) + 1;
    }
  }

  // Newest-first so the most recent sessions land in the prompt before
  // the cap kicks in.
  return Array.from(groups.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Read the first PEEK_LINES of a JSONL file and pull (a) the real cwd
// the session ran in, and (b) the uuid of the first user message (used
// for grouping --resume fork siblings). Both can appear in different
// orders / on different lines, so we scan rather than indexing line 0.
function peekTranscriptHeader(filePath) {
  let raw;
  try {
    // Read up to ~64 KB — enough to comfortably cover PEEK_LINES of typical
    // transcript entries without slurping a giant file.
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    raw = buf.toString("utf8", 0, bytes);
  } catch (_error) {
    return { cwd: null, firstUserMsgId: null };
  }

  const lines = raw.split("\n");
  let cwd = null;
  let firstUserMsgId = null;

  for (let i = 0; i < Math.min(lines.length, PEEK_LINES); i += 1) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (_error) {
      continue;
    }
    if (!cwd && typeof parsed.cwd === "string" && parsed.cwd) cwd = parsed.cwd;
    if (
      !firstUserMsgId &&
      parsed.type === "user" &&
      parsed.parentUuid === null &&
      typeof parsed.uuid === "string"
    ) {
      firstUserMsgId = parsed.uuid;
    }
    if (cwd && firstUserMsgId) break;
  }
  return { cwd, firstUserMsgId };
}

// Claude Code stores cwd-encoded project directories. Examples:
//   "-Users-alice-projects-foo"        → "/Users/alice/projects/foo"
//   "-D--Imperial-individual-cccomp"   → "D:/Imperial/individual/cccomp" (Windows)
// The encoding isn't perfectly reversible (a literal "-" in a folder name
// becomes ambiguous), so we treat this as best-effort and fall back to
// the encoded name when in doubt.
function decodeProjectDir(encoded) {
  if (typeof encoded !== "string") return "";
  if (!encoded.startsWith("-")) return encoded;
  // Windows-style: starts with "-X--" where X is the drive letter, "--"
  // marks the colon. e.g. "-D--Imperial-..." → "D:/Imperial/..."
  const winMatch = encoded.match(/^-([A-Za-z])--(.+)$/);
  if (winMatch) {
    return `${winMatch[1].toUpperCase()}:/` + winMatch[2].replace(/-/g, "/");
  }
  return "/" + encoded.slice(1).replace(/-/g, "/");
}

// Snapshot every JSONL path under the projects root. Returns a Set of
// absolute paths. Used by the cards generator to diff before/after the
// `claude -p` subprocess so we can identify (and trash) the new session
// that the subprocess itself creates.
function snapshotJsonlPaths({ root = DEFAULT_CLAUDE_PROJECTS_ROOT } = {}) {
  const out = new Set();
  let projectDirs;
  try {
    projectDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory());
  } catch (_error) {
    return out;
  }
  for (const projectDir of projectDirs) {
    const projectPath = path.join(root, projectDir.name);
    let files;
    try {
      files = fs.readdirSync(projectPath, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".jsonl"));
    } catch (_error) {
      continue;
    }
    for (const file of files) {
      out.add(path.join(projectPath, file.name));
    }
  }
  return out;
}

module.exports = {
  scanAllProjects,
  snapshotJsonlPaths,
  decodeProjectDir,
  peekTranscriptHeader,
  DEFAULT_CLAUDE_PROJECTS_ROOT
};
