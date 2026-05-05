const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const USER_SETTINGS_PATH = path.join(os.homedir(), ".claude", "settings.json");

// Hook entry version — bumped whenever the shape of an entry we write
// changes meaningfully so older self-installed entries can be detected
// and replaced. Lives on a custom field that Claude Code preserves.
const CLAWDECK_HOOK_VERSION = 2;
const CLAWDECK_VERSION_FIELD = "x-clawdeck-version";
const DEFAULT_PORT = Number(process.env.CCC_PORT || 4317);
const DEFAULT_HOST = process.env.CCC_HOST || "127.0.0.1";

// Legacy (v1) command-style hooks pointed at these scripts. Kept around
// so a Clawdeck install that finds an older installation still wipes the
// stale entries and replaces them with HTTP versions.
const LEGACY_SCRIPT_NAMES = ["event.js", "pre-tool-use.js", "permission-request.js"];

function httpHook(endpoint, timeout, statusMessage, opts = {}) {
  const port = Number(opts.port || DEFAULT_PORT);
  const host = opts.host || DEFAULT_HOST;
  const hook = {
    type: "http",
    url: `http://${host}:${port}/hook/${endpoint}`,
    timeout,
    [CLAWDECK_VERSION_FIELD]: CLAWDECK_HOOK_VERSION
  };
  if (statusMessage) {
    hook.statusMessage = statusMessage;
  }
  return hook;
}

function desiredUserHooks(opts = {}) {
  const eventHook = httpHook("event", 10, undefined, opts);
  const approvalHook = httpHook(
    "pre-tool-use",
    60,
    "Waiting for Vibedog-for-agents approval",
    opts
  );
  const permissionHook = httpHook(
    "permission-request",
    60,
    "Waiting for Vibedog-for-agents approval",
    opts
  );

  return {
    PreToolUse: [
      {
        matcher: "ExitPlanMode|AskUserQuestion",
        hooks: [approvalHook]
      },
      {
        matcher: "",
        hooks: [eventHook]
      }
    ],
    PermissionRequest: [
      {
        matcher: "",
        hooks: [permissionHook]
      }
    ],
    PostToolUse: [
      {
        matcher: "",
        hooks: [eventHook]
      }
    ],
    PostToolUseFailure: [
      {
        matcher: "",
        hooks: [eventHook]
      }
    ],
    UserPromptSubmit: [
      {
        hooks: [eventHook]
      }
    ],
    Notification: [
      {
        hooks: [eventHook]
      }
    ],
    Stop: [
      {
        hooks: [eventHook]
      }
    ],
    SessionEnd: [
      {
        hooks: [eventHook]
      }
    ]
  };
}

function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  let raw = fs.readFileSync(settingsPath, "utf8");
  // Windows PowerShell 5.1's `Set-Content -Encoding utf8` (and various
  // editors) prepend a UTF-8 BOM that JSON.parse rejects. Strip it so a
  // BOM-tagged settings.json doesn't quietly break the self-heal path.
  if (raw.charCodeAt(0) === 0xFEFF) {
    raw = raw.slice(1);
  }
  if (!raw.trim()) {
    return {};
  }

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} must contain a JSON object.`);
  }
  return parsed;
}

// Identifies entries we own. Two paths:
//   1) Modern (v2+) — hook has our x-clawdeck-version marker.
//   2) Legacy (v1)  — hook command references one of our hook scripts.
//      Detected so we can scrub it and replace with an HTTP entry.
function isManagedHook(hook) {
  if (!hook || typeof hook !== "object") return false;
  if (hook[CLAWDECK_VERSION_FIELD] != null) return true;

  const command = String(hook.command || "").replace(/\\/g, "/");
  return LEGACY_SCRIPT_NAMES.some((name) =>
    command.includes(`/packages/hooks/${name}`)
  );
}

function hookEntryContainsManagedScript(entry) {
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) {
    return false;
  }
  return entry.hooks.some(isManagedHook);
}

function managedHookEvents() {
  return Object.keys(desiredUserHooks());
}

function mergeManagedHooks(settings, options = {}) {
  const report = {
    removedManagedHookEntries: 0,
    addedHookEntries: 0
  };

  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }

  // Pass 1: scrub every managed entry from EVERY event the user might
  // have, not just events we currently want — picks up legacy entries
  // under events we no longer manage so they don't survive a migration.
  for (const eventName of Object.keys(settings.hooks)) {
    if (!Array.isArray(settings.hooks[eventName])) continue;
    const before = settings.hooks[eventName].length;
    settings.hooks[eventName] = settings.hooks[eventName].filter(
      (entry) => !hookEntryContainsManagedScript(entry)
    );
    report.removedManagedHookEntries += before - settings.hooks[eventName].length;
    if (!settings.hooks[eventName].length) {
      delete settings.hooks[eventName];
    }
  }

  if (!options.uninstall) {
    const desired = desiredUserHooks(options);
    for (const [eventName, entries] of Object.entries(desired)) {
      if (!Array.isArray(settings.hooks[eventName])) {
        settings.hooks[eventName] = [];
      }
      for (const entry of entries) {
        settings.hooks[eventName].push(entry);
        report.addedHookEntries += 1;
      }
    }
  }

  if (!Object.keys(settings.hooks).length) {
    delete settings.hooks;
  }

  return report;
}

function findManagedHookEntries(settings) {
  const matches = [];
  const hooks = settings && settings.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return matches;
  }

  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    entries.forEach((entry, entryIndex) => {
      const hookList = Array.isArray(entry && entry.hooks) ? entry.hooks : [];
      hookList.forEach((hook, hookIndex) => {
        if (isManagedHook(hook)) {
          matches.push({
            eventName,
            entryIndex,
            hookIndex,
            matcher: entry && Object.prototype.hasOwnProperty.call(entry, "matcher") ? String(entry.matcher) : null,
            type: hook.type || "command",
            url: hook.url || null,
            command: hook.command ? String(hook.command) : null,
            version: hook[CLAWDECK_VERSION_FIELD] || null
          });
        }
      });
    });
  }
  return matches;
}

function projectSettingsPaths(projectRoot) {
  return [
    path.join(projectRoot, ".claude", "settings.json"),
    path.join(projectRoot, ".claude", "settings.local.json")
  ];
}

module.exports = {
  CLAWDECK_HOOK_VERSION,
  CLAWDECK_VERSION_FIELD,
  USER_SETTINGS_PATH,
  desiredUserHooks,
  findManagedHookEntries,
  hookEntryContainsManagedScript,
  isManagedHook,
  managedHookEvents,
  mergeManagedHooks,
  projectSettingsPaths,
  readSettings
};
