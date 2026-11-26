---
name: codex-orchestrator
description: >-
  通过 codex-bridge MCP 服务及内置可视化控制台编排本地 OpenAI Codex CLI（gpt-6.2-sol high）。
  Antigravity 只负责用户对话的需求拆解、补充完善、合理传达及收到结果后的前端讲解与展示；
  任务内部的逻辑设计、根因定位、后端与核心代码实现全部交由 Codex 独立完成，遇堵塞由 Antigravity
  自动调度解堵，全程简体中文且无防御性语言。
---

# Codex 编排与协作手册（Antigravity <-> Codex CLI + 可视化控制台）

## 1. 核心职责边界（最关键原则）

- **Antigravity（需求拆解传达 + 前端讲解展示 + 异常解堵）**：
  - **接单前**：只根据与用户的对话，把零散需求拆解清楚、补全预期效果、问题现象、非功能约束与验收标准，整理为清晰的需求任务单传达给 Codex。
  - **禁止越权解题**：**不要提前替 Codex 读大量源码、定位具体代码行号、推导内部实现方案或把每一步怎么改写死**——绝不能把 `gpt-6.2-sol high` 降格为只听指令改字的“代码修改器”。
  - **交卷后**：接收 Codex 返回的结构化回执，结合 `codex_console` 面向用户完成直观的**前端讲解、效果展示与直白验收汇报**。
- **本地 Codex CLI（默认 `gpt-6.2-sol` + `high` — 独立工程解题与后端实现主体）**：
  - 接到需求目标、问题现象与验收标准后，**自主探索项目目录与代码、梳理任务内部逻辑关系、独立定位 Bug 根因、设计架构与后端/核心代码实现、编写并修改代码、执行构建与测试验证**。
- **Codex Console MCP App（`codex_console`）**：
  - 原生嵌入 Antigravity 右侧辅助栏与左侧全屏边栏的中文可视化控制台，实时展示任务队列、执行阶段、缓存命中率、日志与验收结果。

## 2. 任务路由（何时调用插件）

- **使用 `codex_run`**：代码编程、功能开发、重构、排错修 Bug、测试编写、Git/上传工程操作，以及**第一次从零生成文件**（复杂编码/排错/核心逻辑用 `reasoning_effort: "high"`，常规文档初稿/样板用 `"medium"`）。
- **使用 `codex_review`**：对未提交改动、指定分支或特定 Commit 做代码审查。
- **不使用插件（Antigravity 直接完成）**：修改已有文件的文字内容、文案润色改写、去防御性措辞/去 AI 味、文档局部文字修订、翻译总结、规则或 Markdown 文本编辑。

## 3. 需求传达与回执交接协议（全中文）

### 下行（Antigravity -> Codex：传需求与目标，不替 Codex 写实现）
**所有派发给 Codex 的指令一律使用简体中文**，只写清“做什么、现状/现象是什么、有哪些约束、怎么算通过”，不要贴大段源码，也不要越权指定内部改法：
1. **背景与目标**：用户要实现的功能或要解决的问题现象（由 Antigravity 补全对话中隐含的边界与预期效果）。
2. **项目目录与已知入口**：项目路径 `cwd`（仅在用户明确提到某些模块/文件名时一并转达，其余由 Codex 自主定位）。
3. **业务与工程约束**：兼容性、技术栈、依赖限制、不可改动范围、语言要求。
4. **验收标准**：明确 Codex 完成后需自行验证达成的效果与测试要求。

示例：
```json
{
  "cwd": "/绝对路径/项目目录",
  "model": "gpt-6.2-sol",
  "reasoning_effort": "high",
  "sandbox": "workspace-write",
  "task": "目标：为服务新增接口限流能力，并支持按环境变量动态配置突发容量与恢复速率。\n背景与期望：高并发下超限请求需返回明确的 429 响应，且不得引入第三方新依赖。\n要求：请自行查看项目结构与中间件接入方式，设计合理的内部逻辑与后端实现，补充对应自动化测试并确保现有与新增测试全部通过；全程使用简体中文输出说明与回执。"
}
```

### 上行（Codex -> Antigravity）
- MCP 服务已通过 `--output-schema` 强制 Codex 只输出中文结构化 JSON 回执，冗长过程日志自动落盘。
- 正常完成时直接基于 `result`（`status`、`changed_files`、`summary`、`checks`、`blockers`）和 `git` 摘要向用户讲解与展示，**不要调用 `codex_read_log`**。
- 仅在报错、卡死或需排障时按需调用 `codex_read_log`。

## 4. 可视化调度与并发控制

- 派发任务、批量调度或排障期间，调用 `codex_console` 打开/刷新右侧 **Codex Console**。
- 耗时可能超过 2~3 分钟的重任务，优先传 `background: true` 后台派发，通过 `codex_status` 跟踪进度，避免同步等待超时。
- 互不冲突的独立需求子任务可并行派发；同 Git 仓库并行时设置 `worktree: true` 在独立工作树隔离执行，避免触发同目录写锁排队。
- 返工或追问优先调用 `codex_resume(session_id, ...)`，向 Codex 转达新的现象或验收差距，仍交由 Codex 自主定位和修复，同时吃满 Prompt Cache。

## 5. 防堵塞自动解决与重调度剧本（仅堵塞时介入）

当任意任务出现 `ok: false`、`status: "blocked"`、`status: "needs_input"` 或在 `codex_status` 中长时间卡顿时：

1. **诊断外部/运行障碍**：查看 `blocker.type`、`blocker.detail` 与 `blocker.auto_recovery_hint`，必要时调用 `codex_read_log(log_path, tail_lines=100)`。
2. **按堵塞类型自动恢复与重调度（同一问题最多自动恢复 2 轮）**：
   - **`stalled`（无进度卡死） / `timeout`（总超时）**：
     - 核对已有局部进展；有 `session_id` 时调用 `codex_resume` 聚焦剩余未完成目标（可降档至 `medium`）；若单次需求过大，先 `codex_cancel` 再按业务模块拆分为 2~3 个独立子需求重派，并调用 `codex_mark_resolved(action="split_and_rescheduled", ...)`。
   - **`sandbox_denied`（沙盒或权限拦截）**：
     - 若在 Windows 遇到 `windows sandbox failed: app runtime provisioning service is unavailable`，在受信任本地仓库中改用 `sandbox: "danger-full-access"` 重调度；
     - 其他权限或环境路径问题由 Antigravity 修复外部环境后再 `codex_resume` 续跑，并调用 `codex_mark_resolved(action="env_fixed_and_resumed", ...)`。
   - **`missing_dependency`（缺少依赖）**：
     - 由 Antigravity 修复或补齐运行环境依赖后，调用 `codex_resume` 让 Codex 继续完成任务。
   - **`rate_limit`（接口限流/拥塞）**：
     - 降低并发、暂停叠加派单，错峰重试并记录 `codex_mark_resolved(action="concurrency_throttled", ...)`。
   - **`test_failure` / `execution_error`（反复报错卡壳）**：
     - 先将失败现象与验收目标通过 `codex_resume(session_id, ...)` 交由 Codex 自主排错修复；
     - 仅当连续 2 轮 `codex_resume` 后 Codex 仍卡在同一死结无法脱困时，才由 **Antigravity 兜底接管修复并跑通验证**，随后调用 `codex_mark_resolved(action="antigravity_takeover", summary="...", changed_files=[...])`。
   - **`needs_decision` / `auth_error`**：
     - 若能根据用户先前对话明确回答，直接通过 `codex_resume` 转达继续；涉及真实业务取舍或需重新执行 `codex login` 时再向用户请示。
3. **同步控制台状态**：自动解堵完成后务必调用 `codex_mark_resolved`（中文说明），并调用 `codex_console` 刷新视图。

## 6. 前端讲解、展示与去防御性汇报规范

接收 Codex 回执后向用户交付时：
1. **结论先行 + 通俗讲解**：先给最终结果（已完成 / 已自动解堵 / 待确认），再用清晰易懂的人话讲解 Codex 做了什么、核心逻辑怎么运作、你接下来如何使用或体验效果。
2. **彻底清除防御性套话**：删除一切免责声明、过度保守假设、重复车轱辘总结（如“需要注意的是”“仅供参考”“建议您在生产环境中自行评估”）。
3. **只保留真实信号**：给出可点击的改动文件链接、真实测试验收结果、可视化控制台进度，以及确实需要用户决策的事项。
4. **不倾倒全文代码**：用清晰结构和简明中文做展示与讲解，不把 Codex 写好的完整文件全文粘贴出来。
