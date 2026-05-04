# Clawdeck

<p align="center">
  <em>给 Windows 上 Claude Code 的悬浮小搭档。</em><br>
  <em>权限审批从它走 · 状态信息挂在屏幕边缘</em><br>
  <em>· 昨天的会话，明天变成考你的卡片。</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/stage-1.5%20已发布-2ea44f" alt="Stage 1.5 已发布">
  &nbsp;
  <img src="https://img.shields.io/badge/version-v1.2.0-ff8800" alt="v1.2.0">
  &nbsp;
  <img src="https://img.shields.io/badge/platform-Windows-0078d4" alt="Windows">
  &nbsp;
  <img src="https://img.shields.io/badge/node-20%2B-339933" alt="Node 20+">
  &nbsp;
  <img src="https://img.shields.io/badge/themes-4-blueviolet" alt="4 套主题">
</p>

<p align="center">
  <a href="README.md">English</a> &nbsp;·&nbsp; <strong>中文</strong>
</p>

---

<p align="center">
  <img src="media/hero-status.apng" alt="状态环依次切过 Idle / Thinking / Running tool / Awaiting approval / Done — 一眼就知道 Claude 在干嘛" width="480">
</p>

<p align="center"><em>状态环挂在那儿，扫一眼就知道 Claude 在干嘛。不用 Alt+Tab。</em></p>

<p align="center">
  <img src="media/edges-cycle.apng" alt="气泡停靠到屏幕右、上、左、下四边 —— 闲置时藏到边后只剩一条 4px 的 context 进度光带" width="640">
</p>

<p align="center"><em>拖到屏幕任何一边都能贴住。你没在看它的时候，它会自己藏到边后，只露一条 4px 的 context 进度条 —— 不挡路，但要看一眼随时能看。</em></p>

> 协议代码和环境变量 (`CCC_*`) 里仍然写着 **"Claude Code Companion"** —— 同一个项目，正在改名中。下一站 iOS 同伴 app。

---

## 为什么做这个

Claude Code 原生体验有三件事让人不爽，这里都解决：

| 不爽 | Clawdeck 的解法 |
|---|---|
| 权限请求一弹出，终端焦点立刻被抢走 | 浮动气泡里点一下，决定回到 Claude，焦点留在你的编辑器里 |
| 不切窗口就不知道 Claude 在干嘛 | 屏幕边缘的环境感知状态环 —— 余光扫一眼就够 |
| 会话里那些灵光一现，关了对话就蒸发了 | 每天自动从昨天的 transcript 里生成卡片，每张都引用真实的会话原文 |

---

## 五个模式 · 一条液滴弧线

| 模式 | 触发方式 | 显示什么 |
|---|---|---|
| **Compact** | 默认静止状态 | 状态环 + 状态文字 + context 计量；贴边后会自动 peek |
| **Approval / Question** | 收到权限请求自动进入 | 风险等级 · 工具 / cwd / 原因 · Approve / Deny / Always-allow，问答类请求支持自由文本回复 |
| **📚 Cards** | 📚 按钮 | Today · History · Wrong-book · 生成记录 |
| **⚙ Settings** | ⚙ 按钮 | 左侧导航：知识卡片 · 存储 · 导出 · Companion (主题 + 中英文 + Hook 状态) |
| **⤢ Live** | ⤢ 按钮 | 半透明监视面板 + 心跳 dot：当日 deck 摘要 + 当前活跃 Claude 会话 |

模式之间的切换走一条同步的 `cubic-bezier(0.34, 1.56, 0.64, 1)` 曲线 —— OS 窗口尺寸和 CSS `border-radius` 用同一条带过冲的"水珠拉伸"曲线，所以一次切换在视觉上是**一**个动作，不是两个。

<p align="center">
  <img src="media/approval-flow.apng" alt="Bash 请求落下 → 气泡自动 morph 成审批卡片 → 用户点 Approve → 气泡滑回 compact，状态闪一下 Done" width="520">
</p>

<p align="center">
  <img src="media/hero-morph.apng" alt="Settings → 在热力图选 5 天 → Live → 点 Generate → 📚 新 deck 出现" width="480">
</p>

---

## Knowledge Cards · Stage 1.5

完全在本地生成。Companion 把 `~/.claude/projects/` 下的 JSONL 切片脱敏后，喂给本机的 `claude -p` 子进程；模型返回的卡片每张都带回真实会话引用。**绝不瞎编** —— 严格 source 校验会丢掉对不上号的卡片。

- ✅ **严格引用** —— 每张卡片都引用真实会话原文行；可选 web fallback 引用 URL
- 🛡 **发送前脱敏** —— `.env*` 邻近行删除，token-shaped 字符串（GitHub PAT / Anthropic key / AWS key）替换，用户名换成 `~`
- 🔒 **本地优先** —— 用你已经认证过的 `claude -p`，Companion 不直接调 Anthropic API
- 🗂 **Today · History · Wrong-book · 生成记录** 四个 tab
- 🔁 **错题再战** —— 答错的卡片自动归档，连续答对达阈值自动毕业（难度越高门槛越高）
- 🔥 **连续天数** —— 一天空档不断签，🛡 盾会顶上
- 🎚 **难度预设** —— Casual / Balanced / Deep 调整 easy/medium/hard 比例
- 📅 **热力图选择器** —— 拖选哪些天的 session 喂给 generator；Auto top-3 / All / None 快捷键
- 🌐 **双语** —— UI 和 generator prompt 都按 locale 分流（English / 中文）
- ↓ **导出 Markdown** —— Today / 全部摘要 / Wrong-book，复制到 Obsidian / Notion 都干净

首次生成有**一个明确的同意弹窗**说明数据流。

<p align="center">
  <img src="media/cards-review.apng" alt="Cards 模式：Today's deck → Start review → 答对 + 答错，每张都带原文引用" width="460">
</p>

---

## 四套主题 · 零付费皮肤

四套主题正文对比度都过 WCAG-AA。Approve 永远是 sage 绿，Deny 永远是 rose 红 —— 不管你切哪个主题。

| | | |
|---|---|---|
| **Midnight Teal** 深海青夜 | 暗色 | 黄昏冷调底面 + teal 强调色（默认）|
| **Amber Hearth** 暖夜炉火 | 暗色 | 暖棕 + 琥珀，日落后看眼睛舒服 |
| **Paper Light** 晨纸轻亮 | 亮色 | 白底 + 石墨灰字 + 柔和强调色，白天用 |
| **Aurora Indigo** 极光紫夜 | 暗色 | 深靛 + 薰衣草 + 桃，电影质感 |

控制条上那个色环按钮按一下就循环切；**Settings → Companion** 里有完整预览可以直接选。

<p align="center">
  <img src="media/themes-cycle.apng" alt="四个主题预设循环切换" width="480">
</p>

---

## 一分钟跑起来

> 需要 Windows + **Node.js 20 以上**。

```powershell
npm install
npm run setup-user-hooks    # 把 hook 注入 ~/.claude/settings.json (有备份)
npm run doctor              # 验证安装
```

开两个终端：

```powershell
npm run daemon              # 一个终端 —— http://127.0.0.1:4317
npm run desktop             # 另一个 —— 气泡本体
```

完事。打开 Claude Code 进任何一个项目，权限请求现在都从气泡走。

### Kill-switch（紧急关闭）

气泡上的 ⏻ 按钮等价于一个 sentinel 文件：

```powershell
type nul > %USERPROFILE%\.claude-companion\disabled    # 关
del %USERPROFILE%\.claude-companion\disabled           # 开
```

按 shell 的临时旁路（影响下次在那个 shell 里启动的 Claude Code）：

```powershell
$env:CCC_BYPASS_APPROVAL_HOOK = "true"   # 走 Claude Code 自带的审批 / 问答 UI
$env:CCC_DISABLE_STATUS_HOOK  = "true"   # 不再记录状态 hook 事件
```

---

## Companion 装的几个 hook

三个 Claude Code hook，由 `setup-user-hooks` 合并到 `~/.claude/settings.json`（项目级用 `setup-hooks -- <path>`）。任何时候用 `npm run doctor` 验证。

| Hook | 何时触发 | 做什么 | 模式 |
|---|---|---|---|
| `PreToolUse` | 每次工具调用前（Bash / Edit / Write / …） | 把 Claude 的权限请求路由到气泡的审批卡，approve / deny / answer 的结果作为 hook 退出码回给 Claude | **blocking** —— Claude 等你决定 |
| `PermissionRequest` | 任何显式 `ask` 权限决定 | 在气泡里弹出请求，通过 WebSocket 等待 decide / approve / deny / answer | **blocking** |
| `Event` | 每个 Claude 生命周期事件（`thinking` / `tool_started` / `tool_finished` / `done` / …） | 把会话状态喂给气泡的状态环和 Live 监视面板的 session 列表 | **non-blocking** —— 发出去就不等 |

Hook 脚本本体在 [`packages/hooks/`](packages/hooks/) —— 都是裸 Node 入口，POST 到本地 daemon 然后把 daemon 的回复按 Claude hook 协议写到 stdout。`setup-user-hooks` 只是写一行 JSON 指向它们，没有任何东西被打包进 Claude Code。

**只卸载 Companion 的 hook**（不动你别的 hook）：

```powershell
npm run setup-user-hooks -- --uninstall
```

---

## 架构

```
Claude Code (你的终端)
  ↓ hook (PreToolUse / PermissionRequest / Event)
本地 daemon — http://127.0.0.1:4317
  ↕ ws://127.0.0.1:4317/ws    实时事件
Electron 气泡 (renderer + main)
```

HTTP 端点（气泡 + 未来的客户端共用）：

```
/sessions                  当前活跃 Claude Code 会话列表
/pending-requests          等决定的权限请求
/permission-decisions      决定日志
/pairing-token             给规划中的 iPhone 客户端用
```

<details>
<summary><strong>项目级 hook 安装</strong>（仅当你只想给某一个 repo 装时）</summary>

```powershell
npm run setup-hooks -- D:\path\to\project
npm run setup-hooks -- D:\path\to\project --status-only
npm run setup-hooks -- D:\path\to\project --approval-only
npm run setup-hooks -- D:\path\to\project --disable
```
</details>

<details>
<summary><strong>命令行手动审批</strong>（headless / 脚本场景）</summary>

```powershell
npm run approve -- <requestId>
npm run deny -- <requestId> "Reason"
npm run answer -- <requestId> '{"Question text":"Answer label"}'
```

气泡内部走 WebSocket 调的是同一套。
</details>

<details>
<summary><strong>Hook 入口</strong></summary>

```powershell
npm run hook:permission-request   # blocking —— 守审批
npm run hook:event                # non-blocking —— 喂状态 / context
```
</details>

<details>
<summary><strong>重新渲染本 README 里的 demo APNG</strong></summary>

页面上这些动画是 [`scripts/render-demos.js`](scripts/render-demos.js) 自动渲染出来的 —— Playwright 启动一个 headless Chromium，逐个跑 [`demo/bubble-mockup.html`](demo/bubble-mockup.html) 里的 sequence，ffmpeg 裁切 + 编 APNG。

```powershell
winget install ffmpeg            # 一次性
npx playwright install chromium  # 一次性
npm run render-demos             # ~90 秒，重生 media/ 下全部 6 张 APNG
```

每次改完 demo HTML，再跑一遍就行。
</details>

---

## 路线图

| Stage | 内容 | 状态 |
|---|---|---|
| **0** | 审批 daemon + hook 技术验证 | 已发布 |
| **1** | Windows 浮动气泡（5 模式 + 液滴 morph） | 已发布 |
| **1.5** | Knowledge Cards（Today / History / Wrong-book / 记录 · streak · 热力图选 session · 双语 generator） | **已发布 — v1.2.0** |
| **2** | 桌面拟人 / 桌宠层 | _搁置_ |
| **3** | iPhone 客户端（局域网内）| _规划中_ |
| **4** | iOS 上的 Live Activity / Dynamic Island 镜像 | _规划中_ |
| **5** | 远程中继（跨网络使用）| _规划中_ |

Stage 2 等 1.5 跑过一段真实使用再评估。

---

<p align="center">
  <sub>Windows 优先 · iOS 在路上。<br>整个项目就是用 Claude Code 自己写出来的 —— 这个递归就是核心 demo。</sub>
</p>
