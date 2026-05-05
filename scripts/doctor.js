#!/usr/bin/env node

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { COMPANION_DISABLED_FLAG } = require("../packages/shared/protocol");
const {
  CLAWDECK_HOOK_VERSION,
  CLAWDECK_VERSION_FIELD,
  USER_SETTINGS_PATH,
  desiredUserHooks,
  findManagedHookEntries,
  projectSettingsPaths,
  readSettings
} = require("./lib/claude-settings");

const HOST = process.env.CCC_HOST || "127.0.0.1";
const PORT = Number(process.env.CCC_PORT || 4317);

function usage() {
  console.error("Usage: node scripts/doctor.js [--settings <path>] [--project <path>] [--strict]");
  console.error("Example: npm run doctor -- --project D:\\Imperial\\individual\\week15");
}

function parseArgs(argv) {
  const options = {
    settingsPath: USER_SETTINGS_PATH,
    projectRoot: process.cwd(),
    strict: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--settings") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--settings requires a path.");
      }
      options.settingsPath = path.resolve(next);
      index += 1;
    } else if (arg.startsWith("--settings=")) {
      options.settingsPath = path.resolve(arg.slice("--settings=".length));
    } else if (arg === "--project") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error("--project requires a path.");
      }
      options.projectRoot = path.resolve(next);
      index += 1;
    } else if (arg.startsWith("--project=")) {
      options.projectRoot = path.resolve(arg.slice("--project=".length));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function healthCheck() {
  return new Promise((resolve) => {
    const req = http.request({
      host: HOST,
      port: PORT,
      path: "/health",
      method: "GET",
      timeout: 1200
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          resolve({ ok: res.statusCode === 200, statusCode: res.statusCode, body: JSON.parse(body) });
        } catch (_error) {
          resolve({ ok: false, statusCode: res.statusCode, body: null });
        }
      });
    });

    req.on("timeout", () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (error) => {
      resolve({ ok: false, error });
    });
    req.end();
  });
}

function hookEndpointFromUrl(url) {
  const match = String(url || "").match(/\/hook\/([a-z-]+)$/);
  return match ? match[1] : null;
}

function hasDesiredEntry(settings, eventName, desiredEntry) {
  const entries = settings && settings.hooks && Array.isArray(settings.hooks[eventName])
    ? settings.hooks[eventName]
    : [];
  const desiredMatcher = Object.prototype.hasOwnProperty.call(desiredEntry, "matcher")
    ? String(desiredEntry.matcher)
    : null;
  const desiredEndpoint = hookEndpointFromUrl(desiredEntry.hooks && desiredEntry.hooks[0] && desiredEntry.hooks[0].url);

  return entries.some((entry) => {
    const entryMatcher = entry && Object.prototype.hasOwnProperty.call(entry, "matcher")
      ? String(entry.matcher)
      : null;
    const hooks = Array.isArray(entry && entry.hooks) ? entry.hooks : [];
    return entryMatcher === desiredMatcher && hooks.some((hook) => {
      return hook && hook.type === "http" && hookEndpointFromUrl(hook.url) === desiredEndpoint;
    });
  });
}

function checkDesiredHookCoverage(settings) {
  const missing = [];
  const desired = desiredUserHooks();
  for (const [eventName, entries] of Object.entries(desired)) {
    for (const entry of entries) {
      if (!hasDesiredEntry(settings, eventName, entry)) {
        const matcher = Object.prototype.hasOwnProperty.call(entry, "matcher") ? ` matcher "${entry.matcher}"` : "";
        missing.push(`${eventName}${matcher}`);
      }
    }
  }
  return missing;
}

function result(level, title, detail) {
  return { level, title, detail };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const results = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  results.push(nodeMajor >= 20
    ? result("pass", "Node.js", `v${process.versions.node}`)
    : result("fail", "Node.js", `v${process.versions.node}; Node 20+ is required`));

  let userSettings = {};
  if (!fs.existsSync(options.settingsPath)) {
    results.push(result("fail", "User Claude settings", `missing: ${options.settingsPath}`));
  } else {
    try {
      userSettings = readSettings(options.settingsPath);
      results.push(result("pass", "User Claude settings", options.settingsPath));
    } catch (error) {
      results.push(result("fail", "User Claude settings", error.message));
    }
  }

  const managedEntries = findManagedHookEntries(userSettings);
  results.push(managedEntries.length
    ? result("pass", "Global Vibedog-for-agents hooks", `${managedEntries.length} managed hook(s) found`)
    : result("fail", "Global Vibedog-for-agents hooks", "not installed; run npm run setup-user-hooks"));

  const missingCoverage = checkDesiredHookCoverage(userSettings);
  results.push(missingCoverage.length
    ? result("fail", "Global hook coverage", `missing: ${missingCoverage.join(", ")}`)
    : result("pass", "Global hook coverage", "all expected events present"));

  const stale = managedEntries.filter((entry) => {
    return entry.version != null && Number(entry.version) < CLAWDECK_HOOK_VERSION;
  });
  if (stale.length) {
    results.push(result("warn", "Hook version", `${stale.length} hook(s) older than v${CLAWDECK_HOOK_VERSION} — re-run setup-user-hooks to upgrade`));
  } else {
    results.push(result("pass", "Hook version", `all entries at v${CLAWDECK_HOOK_VERSION} (${CLAWDECK_VERSION_FIELD})`));
  }

  const legacy = managedEntries.filter((entry) => entry.type === "command");
  if (legacy.length) {
    results.push(result("warn", "Legacy command hooks", `${legacy.length} v1 command-style hook(s) — re-run setup-user-hooks to migrate`));
  }

  if (fs.existsSync(COMPANION_DISABLED_FLAG)) {
    results.push(result("warn", "Vibedog-for-agents enabled", `disabled flag present: ${COMPANION_DISABLED_FLAG}`));
  } else {
    results.push(result("pass", "Vibedog-for-agents enabled", "no disabled flag"));
  }

  const health = await healthCheck();
  if (health.ok) {
    const pending = health.body && Number.isFinite(Number(health.body.pendingRequests))
      ? `, pending=${health.body.pendingRequests}`
      : "";
    results.push(result("pass", "Daemon", `http://${HOST}:${PORT}/health ok${pending}`));
  } else {
    const detail = health.error ? health.error.message : `HTTP ${health.statusCode || "unknown"}`;
    results.push(result("warn", "Daemon", `not reachable at http://${HOST}:${PORT}/health (${detail})`));
  }

  const projectRoot = options.projectRoot;
  if (fs.existsSync(projectRoot) && fs.statSync(projectRoot).isDirectory()) {
    const projectManaged = [];
    for (const settingsPath of projectSettingsPaths(projectRoot)) {
      if (!fs.existsSync(settingsPath)) {
        continue;
      }
      try {
        const settings = readSettings(settingsPath);
        const matches = findManagedHookEntries(settings);
        if (matches.length) {
          projectManaged.push({ settingsPath, count: matches.length });
        }
      } catch (error) {
        results.push(result("fail", "Project Claude settings", `${settingsPath}: ${error.message}`));
      }
    }

    if (projectManaged.length && managedEntries.length) {
      const detail = projectManaged.map((item) => `${item.settingsPath} (${item.count})`).join("; ");
      results.push(result("warn", "Double hook risk", `global and project Vibedog-for-agents hooks both present: ${detail}`));
    } else if (projectManaged.length) {
      const detail = projectManaged.map((item) => `${item.settingsPath} (${item.count})`).join("; ");
      results.push(result("warn", "Project Vibedog-for-agents hooks", `project-only managed hooks present: ${detail}`));
    } else {
      results.push(result("pass", "Project Vibedog-for-agents hooks", `none found under ${projectRoot}`));
    }
  } else {
    results.push(result("warn", "Project root", `not found: ${projectRoot}`));
  }

  const icon = {
    pass: "[ok]",
    warn: "[warn]",
    fail: "[fail]"
  };
  for (const item of results) {
    console.log(`${icon[item.level]} ${item.title}: ${item.detail}`);
  }

  const failures = results.filter((item) => item.level === "fail").length;
  const warnings = results.filter((item) => item.level === "warn").length;
  console.log(`summary: ${failures} failure(s), ${warnings} warning(s)`);

  if (failures || (options.strict && warnings)) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
