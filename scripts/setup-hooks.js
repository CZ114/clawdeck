#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SETTINGS_RELATIVE_PATH = path.join(".claude", "settings.local.json");
// PowerShell is a Windows-only Claude Code tool — including it in `permissions`
// or as a hook matcher on macOS/Linux makes Claude Code error on every prompt
// (no such tool registered), which bricks the entire CLI for the user.
const SHELL_TOOLS = process.platform === "win32" ? ["Bash", "PowerShell"] : ["Bash"];
const ASK_RULES = SHELL_TOOLS;
const SHELL_MATCHER = SHELL_TOOLS.join("|");
const DENY_RULES = ["Read(./.env)", "Read(./.env.*)", "Read(./secrets/**)"];
const MANAGED_SCRIPT_NAMES = ["event.js", "pre-tool-use.js", "permission-request.js"];

function usage() {
  console.error("Usage: node scripts/setup-hooks.js <target-repo> [--dry-run] [--status-only|--approval-only|--disable]");
  console.error("Example: npm run setup-hooks -- D:\\Imperial\\individual\\week15");
}

function normalizeForCommand(filePath) {
  return filePath.replace(/\\/g, "/");
}

function hookCommand(relativeScriptPath) {
  const scriptPath = normalizeForCommand(path.join(ROOT, relativeScriptPath));
  return `node "${scriptPath}"`;
}

function commandHook(relativeScriptPath, timeout, statusMessage) {
  const hook = {
    type: "command",
    timeout,
    command: hookCommand(relativeScriptPath)
  };

  if (statusMessage) {
    hook.statusMessage = statusMessage;
  }

  return hook;
}

function desiredHookConfig(options = {}) {
  const installStatus = options.installStatus !== false;
  const installApproval = options.installApproval !== false;
  const eventHook = commandHook("packages/hooks/event.js", 10);
  const answerHook = commandHook(
    "packages/hooks/pre-tool-use.js",
    60,
    "Waiting for Claude Code Companion answer"
  );
  const permissionHook = commandHook(
    "packages/hooks/permission-request.js",
    60,
    "Waiting for Claude Code Companion approval"
  );

  const config = {};

  if (installStatus) {
    config.UserPromptSubmit = [
      {
        hooks: [eventHook]
      }
    ];
    config.PostToolUse = [
      {
        matcher: "*",
        hooks: [eventHook]
      }
    ];
    config.PostToolUseFailure = [
      {
        matcher: "*",
        hooks: [eventHook]
      }
    ];
    config.Notification = [
      {
        hooks: [eventHook]
      }
    ];
    config.Stop = [
      {
        hooks: [eventHook]
      }
    ];
  }

  const preToolUseEntries = [];
  if (installStatus) {
    preToolUseEntries.push({
      matcher: "*",
      hooks: [eventHook]
    });
  }
  if (installApproval) {
    preToolUseEntries.push({
      matcher: "AskUserQuestion",
      hooks: [answerHook]
    });
  }
  if (preToolUseEntries.length) {
    config.PreToolUse = preToolUseEntries;
  }

  if (installApproval) {
    config.PermissionRequest = [
      {
        matcher: SHELL_MATCHER,
        hooks: [permissionHook]
      }
    ];
  }

  return config;
}

function readExistingSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) {
    return {};
  }

  const raw = fs.readFileSync(settingsPath, "utf8");
  if (!raw.trim()) {
    return {};
  }

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} must contain a JSON object.`);
  }
  return parsed;
}

function ensureStringArray(container, key) {
  if (!Array.isArray(container[key])) {
    container[key] = [];
  }
  return container[key];
}

function addUniqueStrings(target, values) {
  let added = 0;
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
      added += 1;
    }
  }
  return added;
}

function hookEntryContainsManagedScript(entry) {
  if (!entry || typeof entry !== "object" || !Array.isArray(entry.hooks)) {
    return false;
  }

  return entry.hooks.some((hook) => {
    const command = String((hook && hook.command) || "");
    const normalized = command.replace(/\\/g, "/");
    return MANAGED_SCRIPT_NAMES.some((scriptName) => {
      return normalized.includes(`/packages/hooks/${scriptName}`) || normalized.includes(`\\packages\\hooks\\${scriptName}`);
    });
  });
}

function mergeSettings(settings, options = {}) {
  const report = {
    addedAskRules: 0,
    addedDenyRules: 0,
    removedManagedHookEntries: 0,
    addedHookEntries: 0
  };

  if (!settings.permissions || typeof settings.permissions !== "object" || Array.isArray(settings.permissions)) {
    settings.permissions = {};
  }
  if (options.installApproval !== false) {
    report.addedAskRules = addUniqueStrings(ensureStringArray(settings.permissions, "ask"), ASK_RULES);
    report.addedDenyRules = addUniqueStrings(ensureStringArray(settings.permissions, "deny"), DENY_RULES);
  }

  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }

  const desired = options.disable ? {} : desiredHookConfig(options);
  const allManagedEvents = Object.keys(desiredHookConfig({ installStatus: true, installApproval: true }));
  for (const eventName of allManagedEvents) {
    if (!Array.isArray(settings.hooks[eventName])) {
      continue;
    }
    const originalLength = settings.hooks[eventName].length;
    settings.hooks[eventName] = settings.hooks[eventName].filter((entry) => !hookEntryContainsManagedScript(entry));
    report.removedManagedHookEntries += originalLength - settings.hooks[eventName].length;
  }

  for (const [eventName, entries] of Object.entries(desired)) {
    if (!Array.isArray(settings.hooks[eventName])) {
      settings.hooks[eventName] = [];
    }

    for (const entry of entries) {
      settings.hooks[eventName].push(entry);
      report.addedHookEntries += 1;
    }
  }

  return report;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const disable = args.includes("--disable") || args.includes("--uninstall");
  const statusOnly = args.includes("--status-only") || args.includes("--no-approval");
  const approvalOnly = args.includes("--approval-only") || args.includes("--no-status");
  const targetArg = args.find((arg) => !arg.startsWith("--"));

  if (!targetArg || args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(targetArg ? 0 : 1);
  }
  if ([disable, statusOnly, approvalOnly].filter(Boolean).length > 1) {
    throw new Error("Choose only one mode: --disable, --status-only, or --approval-only.");
  }

  const targetRepo = path.resolve(targetArg);
  if (!fs.existsSync(targetRepo) || !fs.statSync(targetRepo).isDirectory()) {
    throw new Error(`Target repo does not exist or is not a directory: ${targetRepo}`);
  }

  const claudeDir = path.join(targetRepo, ".claude");
  const settingsPath = path.join(targetRepo, SETTINGS_RELATIVE_PATH);
  const settings = readExistingSettings(settingsPath);
  const options = {
    disable,
    installStatus: !approvalOnly,
    installApproval: !statusOnly
  };
  const report = mergeSettings(settings, options);
  const output = JSON.stringify(settings, null, 2) + "\n";

  if (!dryRun) {
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, output, "utf8");
  }

  console.log(`${dryRun ? "Dry run for" : "Updated"} ${settingsPath}`);
  console.log(`mode: ${disable ? "disable" : statusOnly ? "status-only" : approvalOnly ? "approval-only" : "status+approval"}`);
  console.log(`ask rules added: ${report.addedAskRules}`);
  console.log(`deny rules added: ${report.addedDenyRules}`);
  console.log(`managed hook entries replaced: ${report.removedManagedHookEntries}`);
  console.log(`managed hook entries installed: ${report.addedHookEntries}`);

  if (dryRun) {
    console.log(output);
  }
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
