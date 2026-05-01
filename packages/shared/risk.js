const HIGH_RISK_PATTERNS = [
  { pattern: /\brm\s+(-[^\s]*r[^\s]*f|-rf|-fr)\b/i, reason: "Recursive force delete" },
  { pattern: /\bRemove-Item\b.*\b-Recurse\b.*\b-Force\b/i, reason: "Recursive force delete" },
  { pattern: /\bdel\b.*\s\/s\b.*\s\/q\b/i, reason: "Recursive quiet delete" },
  { pattern: /\bsudo\b/i, reason: "Elevated privilege command" },
  { pattern: /\b(curl|wget|iwr|Invoke-WebRequest)\b.*\|\s*(sh|bash|iex|Invoke-Expression)\b/i, reason: "Downloads and executes remote code" },
  { pattern: /\bgit\s+push\b.*\b--force\b/i, reason: "Force pushes git history" },
  { pattern: /\bchmod\b\s+-R\s+777\b/i, reason: "Overly broad permission change" },
  { pattern: /\bchown\b\s+-R\b/i, reason: "Recursive ownership change" },
  { pattern: /(^|\s)(~\/\.ssh|%USERPROFILE%\\\.ssh|[A-Z]:\\Users\\[^\\]+\\\.ssh)\b/i, reason: "Accesses SSH keys" },
  { pattern: /(^|\s)(\.env|.*\\\.env|.*\/\.env)(\s|$)/i, reason: "Touches environment secret file" },
  { pattern: /\b(format|diskpart|bcdedit)\b/i, reason: "Potential system-level destructive command" }
];

const MEDIUM_RISK_PATTERNS = [
  { pattern: /\b(npm|pnpm|yarn|bun)\s+(install|add|remove|update)\b/i, reason: "Changes JavaScript dependencies" },
  { pattern: /\b(pip|pipx|uv)\s+(install|add|remove)\b/i, reason: "Changes Python dependencies" },
  { pattern: /\bgit\s+push\b/i, reason: "Pushes code to a remote" },
  { pattern: /\b(curl|wget|iwr|Invoke-WebRequest)\b/i, reason: "Performs a network request" },
  { pattern: /\b(New-Item|Set-Content|Out-File|Copy-Item|Move-Item|Remove-Item)\b/i, reason: "Changes files via PowerShell" }
];

const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const FILE_MUTATION_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);

function commandFromToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") {
    return "";
  }
  return String(toolInput.command || toolInput.cmd || "");
}

function firstQuestionSummary(toolInput) {
  const questions = toolInput && Array.isArray(toolInput.questions) ? toolInput.questions : [];
  if (!questions.length) {
    return "Ask user a clarification question";
  }
  return String(questions[0].question || "Ask user a clarification question");
}

function summarizeToolInput(toolName, toolInput) {
  if (SHELL_TOOLS.has(toolName)) {
    return commandFromToolInput(toolInput) || `${toolName} command`;
  }

  if (toolName === "AskUserQuestion") {
    return firstQuestionSummary(toolInput);
  }

  if (toolInput && typeof toolInput === "object") {
    const filePath = toolInput.file_path || toolInput.path;
    if (filePath) {
      return `${toolName}: ${filePath}`;
    }
  }

  return toolName || "Unknown tool";
}

function assessToolRisk(toolName, toolInput) {
  if (!SHELL_TOOLS.has(toolName)) {
    return {
      level: FILE_MUTATION_TOOLS.has(toolName) ? "medium" : "low",
      reason: FILE_MUTATION_TOOLS.has(toolName)
        ? "Tool may modify files"
        : "No high-risk rule matched"
    };
  }

  const command = commandFromToolInput(toolInput);

  for (const rule of HIGH_RISK_PATTERNS) {
    if (rule.pattern.test(command)) {
      return { level: "high", reason: rule.reason };
    }
  }

  for (const rule of MEDIUM_RISK_PATTERNS) {
    if (rule.pattern.test(command)) {
      return { level: "medium", reason: rule.reason };
    }
  }

  return { level: "low", reason: "No high-risk rule matched" };
}

module.exports = {
  assessToolRisk,
  summarizeToolInput
};
