# Antigravity Codex Bridge

将 **Google Antigravity** 与本地 **OpenAI Codex CLI（默认 `gpt-6.2-sol` + `high` 思考深度）** 深度结合的一体化插件包：**零运行时依赖 MCP Server + 内置可视化控制台（MCP App）+ 防堵塞自动调度/接管规则 + 编排验收 Skill**。

---

## 核心架构与特性

### 1. 清晰的双模型分工与全链路中文体验
- **Antigravity（总控 / 调度 / 自动解堵 / 验收与人话翻译）**：全程使用**简体中文**思考、拆解任务、向 Codex 下达极简引用单、监控调度队列、验收 `git diff` 与测试结果，并剔除 GPT 惯用的防御性套话与免责声明，只输出清晰结论与真实风险。
- **本地 Codex CLI（主力执行者）**：默认以 `gpt-6.2-sol`（`reasoning_effort="high"`）接收中文任务单与内置中文执行契约，直接完成多文件编写、重构、测试修复、长文档撰写与 Code Review，其过程日志、结构化回执、堵塞原因与调度建议均以简体中文输出。

### 2. 极速 & 极省 Token 设计
- **零运行时依赖**：MCP Server 仅使用 Node.js 内置标准库，控制台前端已预打包为单文件 `ui/dist/console.html`。在其他电脑安装**无需 `npm install` 或 `pip install`**，`git clone` 即用，Windows / macOS / Linux 完全通用。
- **传引用，不传全文**：Antigravity 只传递文件路径、行号范围与验证命令；Codex 直接写磁盘，不在回复中贴整份代码。
- **JSON Schema 物理锁死防御性长文**：通过 `codex exec --output-schema` 强制只返回极简结构化回执；过程输出与 stderr 自动落盘到日志文件，不进入 Antigravity 上下文（仅排障时按需调用 `codex_read_log`）。
- **Prompt Cache 复用**：返工与追问走 `codex_resume`（`codex exec resume <session_id>`），保留上下文并命中 OpenAI 缓存。

### 3. 防堵塞自动解决与智能调度（附加规则）
- **内置并发与目录写锁调度器**：默认 `max_concurrency = 2`；同目录非 `worktree` 写任务自动串行排队防冲突，只读任务或开启 `worktree: true` 的并行任务自动并发执行。
- **卡死熔断与根因自动分类**：除总超时外，支持**静默无进度超时**（默认 `180s` 无任何进展自动熔断），并自动归类堵塞原因（`stalled` / `timeout` / `rate_limit` / `sandbox_denied` / `missing_dependency` / `test_failure` / `needs_decision` / `auth_error`）。
- **Antigravity 自动接管闭环**：遇到堵塞或失败时，Antigravity 不会被动把报错丢回给用户，而是自动查日志定位 → 拆分大任务 / 降档重调度 / 修环境后 `codex_resume` 续跑；若连续 2 轮仍未解开，由 **Antigravity 直接接管完成并验收**，同时通过 `codex_mark_resolved` 把自动解堵轨迹写入可视化控制台。

### 4. 内置 Antigravity 可视化控制台（Codex Console MCP App）
原生嵌入 Antigravity 软件界面，自动跟随深色/浅色主题，支持 **3 种打开入口**：
1. **左侧边栏全屏视图**：点击 Antigravity 左侧栏 **Codex Console**；
2. **右侧辅助栏（Side Pane）**：点击右侧栏 **`+`** 菜单选择 **Codex Console**；
3. **对话内自动拉起**：对 Antigravity 说“打开 Codex 控制台”或在批量调度时自动调用 `codex_console` 打开并实时刷新。

**控制台查看与管理功能一览**：
- **顶部 KPI 驾驶舱**：实时展示运行/排队数、堵塞告警数、已完成/已接管数、**Prompt Cache 命中率 (%)**、累计输出 Token 与均耗时、并发水位与目录写锁数。
- **任务队列与筛选检索**：按状态（全部 / 运行中 / 排队中 / 堵塞 / 已完成 / 已接管）与关键字搜索任务、Session、路径与堵塞类型。
- **5 大深度详情视图**：
  1. **概览与验收**：结构化回执摘要、验收检查表（PASS/FAIL）、堵塞诊断卡片、Antigravity 自动接管记录、Token 缓存分布条、元数据与 Session ID 一键复制；
  2. **文件与 Diff**：改动文件列表（点击**“在侧栏打开”**直接在 Antigravity 打开对应文件）、`git status` 与 `git diff --stat`；
  3. **实时日志**：支持按 `全部 / 仅错误 / JSONL 事件` 过滤、关键字检索、动态调节尾部行数（80~400 行）；
  4. **调度时间线**：完整记录入队 → 启动 → Session 建立 → 堵塞/熔断 → Antigravity 自动接管全过程，以及同 `session_id` 的多轮续接链；
  5. **指令与续接**：查看原始任务单，并可直接填写追问指令调用 `codex_resume` 复用缓存续跑。
- **交互控制**：支持后台**派发新任务**、**中止卡死/排队任务**、实时调整并发上限与静默超时阈值、清理历史记录，以及一键通知 Antigravity **自动解堵**或**验收汇报**。

---

## 环境要求

1. **Google Antigravity**
2. **Node.js >= 18**（仅作运行时，无需安装依赖）
3. **OpenAI Codex CLI**（已安装并完成登录）：
   ```bash
   npm install -g @openai/codex   # 或通过 Windows Store / Homebrew 安装
   codex login
   codex --version
   ```

---

## 在任意电脑上安装

### 方式一：一行命令克隆即装（推荐）

直接克隆到 Antigravity 全局插件目录 `~/.gemini/config/plugins/codex-bridge` 即可自动发现加载（`mcp_config.json` 使用 `${PLUGIN_ROOT}` 与 `${PLUGIN_DATA}` 动态路径，**无需修改任何路径**）：

**Windows (PowerShell)：**
```powershell
git clone https://github.com/jiabingkele/antigravity-codex-bridge.git "$HOME\.gemini\config\plugins\codex-bridge"
node "$HOME\.gemini\config\plugins\codex-bridge\server\codex-mcp-server.mjs" --self-test
```

**macOS / Linux：**
```bash
git clone https://github.com/jiabingkele/antigravity-codex-bridge.git ~/.gemini/config/plugins/codex-bridge
node ~/.gemini/config/plugins/codex-bridge/server/codex-mcp-server.mjs --self-test
```

> 当 `--self-test` 输出 `"ok": true` 且 `"console_ui_ready": true` 时，说明服务、Codex CLI、Schema 与可视化控制台已全部就绪。

### 方式二：使用安装脚本（可自定义模型/思考深度并顺便启动常驻守护进程）

**Windows (PowerShell)：**
```powershell
git clone https://github.com/jiabingkele/antigravity-codex-bridge.git
cd antigravity-codex-bridge
.\scripts\install.ps1 -StartDaemon
```

自定义默认档位示例：
```powershell
.\scripts\install.ps1 -Model "gpt-6.2-sol" -ReasoningEffort "high" -StartDaemon
```

**macOS / Linux：**
```bash
git clone https://github.com/jiabingkele/antigravity-codex-bridge.git
cd antigravity-codex-bridge
chmod +x scripts/install.sh
./scripts/install.sh --start-daemon
```

### Windows 沙箱故障

遇到 `windows sandbox failed: app runtime provisioning service is unavailable` 时，启动 Codex Desktop 后重试。仅在受信任的仓库中，也可在 `mcp_config.json` 的 `env` 中设置 `"CODEX_BRIDGE_SANDBOX": "danger-full-access"`，重启 Antigravity 后重试。

---

## 提速建议（强烈推荐）

运行一次以下命令保持本地 Codex 后台常驻，显著减少每次派发任务的冷启动延迟：

```bash
codex app-server daemon start
```

---

## MCP 工具一览

| 工具名 | 面向 | 作用 |
| :--- | :--- | :--- |
| `codex_console` | 模型 / UI 入口 | 打开或刷新 Antigravity 内的可视化 **Codex Console**（支持侧栏 + 左侧全屏入口） |
| `codex_run` | 模型 | 派发非交互 Codex 任务（支持 `background: true`、`worktree: true`、防卡死熔断） |
| `codex_resume` | 模型 | 按 `session_id` 续接会话，吃满 Prompt Cache |
| `codex_review` | 模型 | 对未提交更改 / 分支 / Commit 运行结构化 Code Review |
| `codex_status` | 模型 | 查询队列、并发锁与各任务状态，支撑自动调度 |
| `codex_cancel` | 模型 | 中止卡死任务或取消排队任务 |
| `codex_mark_resolved` | 模型 | 记录 Antigravity 自动解堵/接管结果并同步到控制台 |
| `codex_read_log` | 模型 | 仅在报错或堵塞时按需读取落盘日志尾部 |
| `app_*` (7 个) | 仅控制台 UI | 供控制台实时拉取看板/详情/过滤日志、派发、续接、中止、调参（对模型隐藏，零上下文开销） |

---

## 自定义配置

可编辑 `~/.gemini/config/plugins/codex-bridge/mcp_config.json` 中的 `env`：

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `CODEX_BRIDGE_MODEL` | `gpt-6.2-sol` | 默认模型 slug |
| `CODEX_BRIDGE_REASONING_EFFORT` | `high` | 默认思考深度（`low` / `medium` / `high` / `xhigh`） |
| `CODEX_BRIDGE_MAX_CONCURRENCY` | `2` | 默认最大并发数（也可在控制台实时调整） |
| `CODEX_BRIDGE_STALL_TIMEOUT_SEC` | `180` | 无进度静默熔断阈值秒数 |
| `CODEX_BRIDGE_TIMEOUT_SEC` | `600` | 单任务总超时秒数 |
| `CODEX_BRIDGE_SANDBOX` | `workspace-write` | 默认 Codex 沙盒策略 |
| `CODEX_BRIDGE_PROFILE` | *(空)* | 若填写则优先使用 Codex `-p <profile>` |
| `CODEX_BRIDGE_REMOTE` | *(空)* | 可选 `app-server` 远程/本地地址 |
| `CODEX_BIN` | *(自动探测)* | 手动指定 `codex` 可执行文件路径 |

---

## 更新与卸载

- **更新**（方式一克隆安装）：`git -C ~/.gemini/config/plugins/codex-bridge pull`
- **开关 / 卸载**：在 Antigravity 的 **Customizations -> Plugins -> Codex Bridge** 一键停用或卸载。

---

## 目录结构与二次开发

```text
antigravity-codex-bridge/
├── plugin.json                        # Antigravity 插件清单
├── mcp_config.json                    # 本地 MCP stdio 配置
├── rules/AGENTS.md                    # 调度路由 + 防堵塞自动解堵 + 去防御性语言常驻规则
├── skills/codex-orchestrator/SKILL.md # 完整编排、自动解堵剧本与验收指南
├── server/codex-mcp-server.mjs        # 零依赖 Node.js MCP Server + 调度器 + MCP App 后端
├── schemas/                           # 强制结构化 JSON 回执 Schema
├── ui/
│   ├── src/                           # Codex Console 前端源码（基于 @modelcontextprotocol/ext-apps）
│   ├── build.mjs                      # 单文件 HTML 打包脚本
│   └── dist/console.html              # 预构建单文件控制台（随仓提交，免安装依赖）
├── scripts/                           # Windows / macOS / Linux 一键安装脚本
└── tests/mcp-server.test.mjs          # 自动化全链路测试
```

二次开发修改控制台 UI 后重新打包与测试：
```bash
pnpm --dir ui install
node ui/build.mjs
node --test tests/mcp-server.test.mjs
```

## License

MIT
