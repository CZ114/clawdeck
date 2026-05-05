/* I18n for Vibedog-for-agents (desktop bubble + cards generator).
 *
 * Two locales: "en" (default) and "zh" (中文). Strings are organized by
 * area (bubble.*, approval.*, cards.*, settings.*, consent.*) for quick
 * scanning. Adding a third locale is mechanical — copy the en/zh blocks,
 * translate the values, register the locale id below.
 *
 * Renderer usage:
 *   t("settings.title")            → "Settings" / "设置"
 *   t("cards.review.next", {n:3})  → simple {placeholder} substitution
 *   applyI18nToTree(rootElement)   → walks data-i18n attributes
 *
 * HTML usage (auto-applied on load + locale change):
 *   <span data-i18n="settings.title"></span>
 *   <button data-i18n-aria-label="bubble.minimize" data-i18n-title="bubble.minimize">−</button>
 *
 * Daemon usage (cards-generator): pass locale through /cards/generate body,
 * the generator picks the right prompt template from PROMPT_TEMPLATES.
 */

const LOCALES = ["en", "zh"];
const DEFAULT_LOCALE = "en";

const STRINGS = {
  en: {
    // ── Common ──────────────────────────────────────────────
    "common.cancel": "Cancel",
    "common.confirm": "Confirm",
    "common.close": "Close",
    "common.open": "Open",
    "common.reset": "Reset",
    "common.refresh": "Refresh",
    "common.save": "Save",
    "common.delete": "Delete",
    "common.loading": "Loading…",
    "common.empty": "Empty",
    "common.none": "None",
    "common.all": "All",
    "common.yes": "Yes",
    "common.no": "No",
    "common.copy": "Copy",
    "common.copied": "Copied",

    // ── Bubble status / controls ────────────────────────────
    "bubble.status.idle": "Idle",
    "bubble.status.thinking": "Thinking",
    "bubble.status.running": "Running",
    "bubble.status.waitingApproval": "Waiting",
    "bubble.status.waitingAnswer": "Question",
    "bubble.status.done": "Done",
    "bubble.status.failed": "Failed",
    "bubble.status.blocked": "Blocked",
    "bubble.status.compacting": "Compacting",
    "bubble.detail.noRequest": "No request",
    "bubble.context.label": "ctx",
    "bubble.toggleEnabled": "Toggle Vibedog-for-agents",
    "bubble.theme": "Theme",
    "bubble.cards": "Knowledge cards",
    "bubble.settings": "Settings",
    "bubble.live": "Live monitor",
    "bubble.minimize": "Collapse to island",

    // ── Approval panel ──────────────────────────────────────
    "approval.eyebrow.approval": "approval",
    "approval.eyebrow.question": "question",
    "approval.title.default": "Tool request",
    "approval.field.cwd": "cwd",
    "approval.field.reason": "reason",
    "approval.action.approve": "Approve",
    "approval.action.deny": "Deny",
    "approval.action.allow": "Always allow",
    "approval.action.allowOnce": "Allow once",
    "approval.suggestion.label": "Suggested rules",

    // ── Cards: tabs ─────────────────────────────────────────
    "cards.tab.today": "Today",
    "cards.tab.history": "History",
    "cards.tab.wrong": "Wrong book",
    "cards.tab.record": "Record",

    // ── Cards: empty / generation ──────────────────────────
    "cards.empty.title": "No cards generated yet",
    "cards.empty.text": "Click below to seed today's deck from the past 24 h of Claude Code sessions.",
    "cards.generate.now": "Generate now",
    "cards.generate.regenTooltip": "Regenerate today's deck",
    "cards.deck.goal": "Today's goal",
    "cards.deck.startReview": "Start review",
    "cards.deck.cards": "{n} cards",
    "cards.deck.lastGen": "last gen {time}",

    // ── Cards: review ──────────────────────────────────────
    "cards.review.correct": "Correct",
    "cards.review.wrong": "Not quite",
    "cards.review.queued": "queued for tomorrow",
    "cards.review.next": "Next →",
    "cards.review.skip": "Skip",
    "cards.review.back": "Back",
    "cards.review.fromSession": "From session",
    "cards.review.correctAnswer": "Correct answer",

    // ── Cards: history / wrong-book / record ────────────────
    "cards.history.empty": "No previous decks yet — generate today's first.",
    "cards.wrong.empty": "Wrong book is empty — answer some cards to populate it.",
    "cards.wrong.fullReview": "Full review",
    "cards.record.empty": "No generation runs recorded yet.",

    // ── Settings: sections ──────────────────────────────────
    "settings.title": "Settings",
    "settings.section.prompt": "Generation prompt",
    "settings.section.scope": "Generation scope",
    "settings.section.behavior": "Behavior",
    "settings.section.storage": "Storage",
    "settings.section.export": "Export",
    "settings.section.sessions": "Sessions",
    "settings.section.companion": "App",
    "settings.section.theme": "Theme",
    "settings.section.language": "Language",
    "settings.section.live": "Live",
    "settings.section.cardsConfig": "Knowledge cards",
    "settings.live.todayDeckLabel": "Today's deck",
    "settings.live.openCardsButton": "Open Knowledge Cards",
    "settings.live.openCardsHint": "switch to the cards mode for review",
    "settings.live.sessionsLabel": "Active Claude sessions",
    "settings.cardsConfig.lede": "Generation prompt, scope, and behaviour — everything that controls how today's deck is built.",

    // ── Settings: prompt section ────────────────────────────
    "settings.focus.label": "What do you want to learn?",
    "settings.focus.hint": "prepended to every generation prompt",
    "settings.focus.placeholder": "Leave empty = let the AI pick. e.g.\nElectron BrowserWindow IPC and setBounds behaviour;\nOKLCH colour space;\nClaude Code hook timeout + failure semantics.",
    "settings.difficulty.label": "Difficulty preference",
    "settings.difficulty.casual": "Casual",
    "settings.difficulty.balanced": "Balanced",
    "settings.difficulty.deep": "Deep",
    "settings.difficulty.balancedMeta": "Balanced ≈ 50% easy · 35% medium · 15% hard",
    "settings.difficulty.casualMeta": "Casual ≈ 70% easy · 25% medium · 5% hard",
    "settings.difficulty.deepMeta": "Deep ≈ 25% easy · 40% medium · 35% hard",
    "settings.cardCount.label": "Cards per generation",
    "settings.cardCount.meta": "model best-effort; strict-source can drop some",

    // ── Settings: scope section ────────────────────────────
    "settings.budget.label": "Transcript budget",
    "settings.budget.meta": "total characters fed to the model — bigger = more sessions, slower run",
    "settings.budget.detail": "{total} chars total · per-session cap ≈ {perSession}",
    "settings.picker.headline": "📅 Pick which days to review",
    "settings.picker.hint.prefix": "Tap a day to load its sessions · drag across days to multi-select · deeper colour = more sessions that day",
    "settings.picker.tap": "Tap",
    "settings.picker.drag": "drag",
    "settings.picker.autoTop": "Auto top-3",
    "settings.picker.autoTopTooltip": "Pick the latest 3 sessions",
    "settings.picker.allTooltip": "Pick every session",
    "settings.picker.noneTooltip": "Clear selection (= scan today's sessions only)",
    "settings.picker.refreshTooltip": "Re-scan ~/.claude/projects",
    "settings.picker.legendLess": "less",
    "settings.picker.legendMore": "more",
    "settings.picker.dayDetail.selectAll": "Select all",

    // ── Settings: behavior section ─────────────────────────
    "settings.autoGenerate.label": "Auto-generate daily",
    "settings.autoGenerate.meta": "runs once a day at the picked time",
    "settings.autoGenerate.timeHint": "scroll a wheel · 24h",
    "settings.autoWrong.label": "Auto-add wrong cards",
    "settings.autoWrong.meta": "missed cards return tomorrow",
    "settings.streakNotif.label": "Streak notifications",
    "settings.streakNotif.meta": "remind before 23:00 if not done",
    "settings.webFallback.label": "Allow web fallback",
    "settings.webFallback.meta": "when focus has no match in transcripts, model may use WebSearch + cite the URL",
    "settings.allowDelete.label": "Allow session deletion",
    "settings.allowDelete.meta": "enables 🗑 buttons to move Claude session JSONLs into the trash (recoverable)",

    // ── Settings: storage / export ─────────────────────────
    "settings.storage.label": "Cards folder",
    "settings.storage.openTooltip": "Open in explorer",
    "settings.storage.change": "Change…",
    "settings.storage.pendingNote": "⚠ daemon must restart to apply the new path. Existing decks are NOT auto-migrated — copy them manually if you want History to follow.",
    "settings.export.today": "↓ Today.md",
    "settings.export.history": "↓ All abstracts.md",
    "settings.export.wrong": "↓ Wrong book.md",
    "settings.export.hint": "Exported markdown imports cleanly into Obsidian / Notion etc.",

    // ── Settings: companion ─────────────────────────────────
    "settings.companion.hook": "Approval hook",
    "settings.companion.autoStart": "Start with Windows",
    "settings.companion.autoStartMeta": "auto-launch when you sign in",
    "settings.companion.consent": "Cards consent",
    "settings.companion.consentAccepted": "accepted {time} · Reset to revoke",
    "settings.companion.consentPending": "not yet accepted — first generate will prompt",
    "settings.theme.meta": "click any preset to apply · the bubble's color button cycles through them in order",
    "settings.language.meta": "bubble UI language; cards generator prompt also follows this setting",
    "settings.language.en": "English",
    "settings.language.zh": "中文",

    // ── Settings: quick actions ────────────────────────────
    "settings.quickActions.todayDeck": "Today's deck",
    "settings.quickActions.openCards": "Open cards",
    "settings.quickActions.openCardsMeta": "Today / History / Wrong book",

    // ── Consent modal ──────────────────────────────────────
    "consent.eyebrow": "First generation",
    "consent.title": "Knowledge Cards data usage",
    "consent.body.intro": "Vibedog-for-agents will read the past N days of Claude Code session content (your prompts, assistant replies, tool calls + output summaries) and run them through redaction:",
    "consent.body.li1": "Strip lines mentioning .env / .envrc / secrets/ paths",
    "consent.body.li2": "Replace token-shaped strings (GitHub PAT / Anthropic key / AWS key etc.)",
    "consent.body.li3": "Replace your home directory with ~",
    "consent.body.scope": "The redacted text is then piped to your local `claude -p` subprocess. Nothing leaves your machine that wouldn't already leave when you use Claude Code itself.",
    "consent.accept": "I understand · enable cards",
    "consent.decline": "Not now"
  },

  zh: {
    // ── 通用 ────────────────────────────────────────────────
    "common.cancel": "取消",
    "common.confirm": "确定",
    "common.close": "关闭",
    "common.open": "打开",
    "common.reset": "重置",
    "common.refresh": "刷新",
    "common.save": "保存",
    "common.delete": "删除",
    "common.loading": "加载中…",
    "common.empty": "空",
    "common.none": "无",
    "common.all": "全部",
    "common.yes": "是",
    "common.no": "否",
    "common.copy": "复制",
    "common.copied": "已复制",

    // ── 浮岛状态 / 控件 ────────────────────────────────────
    "bubble.status.idle": "空闲",
    "bubble.status.thinking": "思考中",
    "bubble.status.running": "运行中",
    "bubble.status.waitingApproval": "等待批准",
    "bubble.status.waitingAnswer": "等待回答",
    "bubble.status.done": "完成",
    "bubble.status.failed": "失败",
    "bubble.status.blocked": "被阻止",
    "bubble.status.compacting": "压缩中",
    "bubble.detail.noRequest": "无请求",
    "bubble.context.label": "ctx",
    "bubble.toggleEnabled": "切换 Vibedog-for-agents 启用状态",
    "bubble.theme": "主题",
    "bubble.cards": "知识卡片",
    "bubble.settings": "设置",
    "bubble.live": "实时监视",
    "bubble.minimize": "收回浮岛",

    // ── 批准面板 ────────────────────────────────────────
    "approval.eyebrow.approval": "批准",
    "approval.eyebrow.question": "提问",
    "approval.title.default": "工具请求",
    "approval.field.cwd": "目录",
    "approval.field.reason": "原因",
    "approval.action.approve": "批准",
    "approval.action.deny": "拒绝",
    "approval.action.allow": "永远允许",
    "approval.action.allowOnce": "只允许这一次",
    "approval.suggestion.label": "建议规则",

    // ── 卡片：标签页 ──────────────────────────────────────
    "cards.tab.today": "今日",
    "cards.tab.history": "历史",
    "cards.tab.wrong": "错题本",
    "cards.tab.record": "记录",

    // ── 卡片：空状态 / 生成 ───────────────────────────────
    "cards.empty.title": "尚未生成卡片",
    "cards.empty.text": "点击下方按钮，从过去 24 小时的 Claude Code 会话生成今日卡片。",
    "cards.generate.now": "立即生成",
    "cards.generate.regenTooltip": "重新生成今日卡片",
    "cards.deck.goal": "今日目标",
    "cards.deck.startReview": "开始复习",
    "cards.deck.cards": "{n} 张卡片",
    "cards.deck.lastGen": "上次生成 {time}",

    // ── 卡片：复习 ──────────────────────────────────────
    "cards.review.correct": "正确",
    "cards.review.wrong": "差一点",
    "cards.review.queued": "已加入明日错题",
    "cards.review.next": "下一题 →",
    "cards.review.skip": "跳过",
    "cards.review.back": "返回",
    "cards.review.fromSession": "来源 session",
    "cards.review.correctAnswer": "正确答案",

    // ── 卡片：历史 / 错题本 / 记录 ────────────────────────
    "cards.history.empty": "尚无历史卡片 — 先生成今日的吧。",
    "cards.wrong.empty": "错题本是空的 — 答几道题就会有内容。",
    "cards.wrong.fullReview": "全部复习",
    "cards.record.empty": "尚无生成记录。",

    // ── 设置：分区 ──────────────────────────────────────
    "settings.title": "设置",
    "settings.section.prompt": "生成提示词",
    "settings.section.scope": "生成范围",
    "settings.section.behavior": "行为",
    "settings.section.storage": "存储",
    "settings.section.export": "导出",
    "settings.section.sessions": "会话",
    "settings.section.companion": "应用",
    "settings.section.theme": "主题",
    "settings.section.language": "语言",
    "settings.section.live": "实时",
    "settings.section.cardsConfig": "知识卡片设置",
    "settings.live.todayDeckLabel": "今日卡片",
    "settings.live.openCardsButton": "打开知识卡片",
    "settings.live.openCardsHint": "切换到卡片模式开始复习",
    "settings.live.sessionsLabel": "活跃的 Claude session",
    "settings.cardsConfig.lede": "生成提示词、范围、行为 — 所有决定今日卡片如何生成的设置都在这里。",

    // ── 设置：生成提示 ──────────────────────────────────
    "settings.focus.label": "你想学什么？",
    "settings.focus.hint": "会附加到每次生成提示词的开头",
    "settings.focus.placeholder": "留空 = 让 AI 自己挑重点。例如：\nElectron BrowserWindow IPC 与 setBounds 行为；\nOKLCH 色彩空间；\nClaude Code hook 的 timeout 与失败语义。",
    "settings.difficulty.label": "难度偏好",
    "settings.difficulty.casual": "轻松",
    "settings.difficulty.balanced": "均衡",
    "settings.difficulty.deep": "深入",
    "settings.difficulty.balancedMeta": "均衡 ≈ 50% 简单 · 35% 中等 · 15% 困难",
    "settings.difficulty.casualMeta": "轻松 ≈ 70% 简单 · 25% 中等 · 5% 困难",
    "settings.difficulty.deepMeta": "深入 ≈ 25% 简单 · 40% 中等 · 35% 困难",
    "settings.cardCount.label": "每次生成的卡片数",
    "settings.cardCount.meta": "模型尽力而为；strict-source 校验可能丢一些",

    // ── 设置：范围 ────────────────────────────────────
    "settings.budget.label": "Transcript 字符预算",
    "settings.budget.meta": "总共喂给模型的字符 — 越大覆盖越多 session，但越慢",
    "settings.budget.detail": "总 {total} 字符 · 单 session ≈ {perSession}",
    "settings.picker.headline": "📅 选哪几天的内容来复习",
    "settings.picker.hint.prefix": "点一天加载当天 session · 横向拖动多选连续几天 · 颜色越深当天 session 越多",
    "settings.picker.tap": "点击",
    "settings.picker.drag": "拖动",
    "settings.picker.autoTop": "自动选最近3条",
    "settings.picker.autoTopTooltip": "自动选最近的 3 个 session",
    "settings.picker.allTooltip": "选全部 session",
    "settings.picker.noneTooltip": "清空选择（= 只扫今日 session）",
    "settings.picker.refreshTooltip": "重新扫描 ~/.claude/projects",
    "settings.picker.legendLess": "少",
    "settings.picker.legendMore": "多",
    "settings.picker.dayDetail.selectAll": "全选",

    // ── 设置：行为 ────────────────────────────────────
    "settings.autoGenerate.label": "每日定时生成",
    "settings.autoGenerate.meta": "每天到时间自动跑一次",
    "settings.autoGenerate.timeHint": "滑动选时 · 24 小时制",
    "settings.autoWrong.label": "自动加入错题本",
    "settings.autoWrong.meta": "答错的卡片明天再来",
    "settings.streakNotif.label": "连胜提醒",
    "settings.streakNotif.meta": "23:00 前未完成时提醒",
    "settings.webFallback.label": "允许 Web 回退",
    "settings.webFallback.meta": "当 focus 在 transcript 里找不到匹配时，允许模型用 WebSearch 并标注 URL 来源",
    "settings.allowDelete.label": "允许删除 session",
    "settings.allowDelete.meta": "开启后会在选择列表/记录里出现 🗑 按钮，点击移动 JSONL 到回收站（可恢复）",

    // ── 设置：存储 / 导出 ────────────────────────────
    "settings.storage.label": "卡片存储位置",
    "settings.storage.openTooltip": "在文件管理器中打开",
    "settings.storage.change": "更换…",
    "settings.storage.pendingNote": "⚠ daemon 重启后才会生效。已有 deck 不会自动迁移，需要手动复制过去。",
    "settings.export.today": "↓ 今日.md",
    "settings.export.history": "↓ 全部摘要.md",
    "settings.export.wrong": "↓ 错题本.md",
    "settings.export.hint": "导出后可直接导入 Obsidian / Notion 等笔记软件",

    // ── 设置：companion ──────────────────────────────
    "settings.companion.hook": "批准 hook",
    "settings.companion.autoStart": "开机自启",
    "settings.companion.autoStartMeta": "登录 Windows 时自动启动",
    "settings.companion.consent": "卡片同意书",
    "settings.companion.consentAccepted": "已同意 {time} · 重置可撤回",
    "settings.companion.consentPending": "尚未同意 · 首次生成时会询问",
    "settings.theme.meta": "点预设直接换 · 控制条色环按顺序循环",
    "settings.language.meta": "UI + 卡片生成器一起切",
    "settings.language.en": "English",
    "settings.language.zh": "中文",

    // ── 设置：快捷操作 ────────────────────────────────
    "settings.quickActions.todayDeck": "今日卡片",
    "settings.quickActions.openCards": "打开卡片",
    "settings.quickActions.openCardsMeta": "今日 / 历史 / 错题本",

    // ── 同意书 modal ────────────────────────────────
    "consent.eyebrow": "首次生成",
    "consent.title": "Knowledge Cards 数据使用说明",
    "consent.body.intro": "Vibedog-for-agents 会读取过去 N 天的 Claude Code session 内容（你的提问、助手回答、工具调用与输出摘要），过一遍脱敏：",
    "consent.body.li1": "去掉 .env / .envrc / secrets/ 路径附近的行",
    "consent.body.li2": "替换 token-shaped 字符串（GitHub PAT / Anthropic key / AWS key 等）",
    "consent.body.li3": "把用户主目录替换成 ~",
    "consent.body.scope": "脱敏后的文本会喂给本地 `claude -p` 子进程。除此之外，没有任何数据离开你的机器，等同于你正常使用 Claude Code 时已经发生的数据流。",
    "consent.accept": "我了解 · 启用卡片",
    "consent.decline": "暂不启用"
  }
};

// ============================================================
// Cards generator prompt templates (one per locale).
// The model output language follows the prompt language. The structural
// part (JSON shape requirement, strict-source rule) stays in English in
// both versions because changing JSON keys would break parsing.
// ============================================================

const PROMPT_TEMPLATES = {
  en: {
    intro: "You are reviewing the user's Claude Code activity log to generate review cards for spaced-repetition study (Knowledge Cards feature in claude-code-companion).",
    abstractInstruction: "Markdown summary, 2-4 paragraphs with h3 sections like 'Key decisions' / 'Files touched'. Use lists, inline code (`backticks`), strong, blockquote. If web cards were used, mention that too."
  },
  zh: {
    intro: "你正在审阅用户的 Claude Code 活动日志，为 claude-code-companion 的 Knowledge Cards 功能生成用于间隔复习的题卡。",
    abstractInstruction: "Markdown 摘要，2-4 段，使用 h3 分节（如「关键决定」/「触及文件」）。可用列表、行内代码 `backticks`、加粗、引用块。若用了 web 卡片，请一并提及。"
  }
};

// ============================================================
// Public API
// ============================================================

let currentLocale = DEFAULT_LOCALE;

function setLocale(locale) {
  if (!LOCALES.includes(locale)) return;
  currentLocale = locale;
}

function getLocale() {
  return currentLocale;
}

function detectInitialLocale(navigatorLanguage) {
  if (typeof navigatorLanguage === "string" && /^zh\b/i.test(navigatorLanguage)) return "zh";
  return "en";
}

// Look up a translation. Falls back to en, then to the key itself.
// Optional `vars` object substitutes {placeholder} tokens.
function t(key, vars) {
  const table = STRINGS[currentLocale] || STRINGS[DEFAULT_LOCALE];
  let value = table[key];
  if (value === undefined) value = STRINGS[DEFAULT_LOCALE][key];
  if (value === undefined) return key;
  if (vars && typeof value === "string") {
    return value.replace(/\{(\w+)\}/g, (_m, name) => (name in vars ? String(vars[name]) : `{${name}}`));
  }
  return value;
}

// Walk a DOM subtree and apply data-i18n attributes:
//   data-i18n               → element.textContent
//   data-i18n-title         → element.title
//   data-i18n-aria-label    → element.aria-label
//   data-i18n-placeholder   → element.placeholder
function applyI18nToTree(root) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  // The root itself can have data-i18n too — include it in the iteration.
  const all = [root, ...root.querySelectorAll("[data-i18n], [data-i18n-title], [data-i18n-aria-label], [data-i18n-placeholder]")];
  for (const el of all) {
    if (!el || !el.dataset) continue;
    if (el.dataset.i18n) {
      el.textContent = t(el.dataset.i18n);
    }
    if (el.dataset.i18nTitle) {
      el.title = t(el.dataset.i18nTitle);
    }
    if (el.dataset.i18nAriaLabel) {
      el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
    }
    if (el.dataset.i18nPlaceholder) {
      el.placeholder = t(el.dataset.i18nPlaceholder);
    }
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    LOCALES,
    DEFAULT_LOCALE,
    STRINGS,
    PROMPT_TEMPLATES,
    setLocale,
    getLocale,
    detectInitialLocale,
    t,
    applyI18nToTree
  };
}
if (typeof window !== "undefined") {
  window.CCC_I18N = {
    LOCALES,
    DEFAULT_LOCALE,
    STRINGS,
    PROMPT_TEMPLATES,
    setLocale,
    getLocale,
    detectInitialLocale,
    t,
    applyI18nToTree
  };
}
