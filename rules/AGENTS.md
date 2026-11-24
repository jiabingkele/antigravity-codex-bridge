# Codex Bridge 编排、防堵塞自动调度与全中文输出规则

1. **永久全中文思考与交互**：
   - Antigravity 的所有思考分析过程、任务规划、回复、验收结论、堵塞说明，一律使用**简体中文**（代码标识符、文件路径、命令行参数与专有名词保持原样）。
   - 下发给 Codex（GPT）的所有任务指令（`codex_run.task`、`codex_resume.instruction`、`codex_review.instructions`），以及写入控制台的取消原因（`codex_cancel.reason`）和自动解堵摘要（`codex_mark_resolved.summary`），**必须全部使用简体中文**，确保 Codex 的过程日志、回执与控制台展示均自然以中文呈现。

2. **任务分级路由**（当 `codex-bridge` MCP 服务可用时）：
   - 多文件编码、复杂重构、测试套件编写、疑难排错、长文档撰写：激活 `codex-orchestrator` skill 并派发给 `codex_run`（默认 `gpt-6.2-sol`，复杂工程用 `reasoning_effort: "high"`，常规文档/样板代码用 `"medium"`）。
   - 简单问答、阅读解释、单文件 20 行以内小改动：由 Antigravity 直接完成，不走跨模型往返。

3. **极简引用交接与缓存复用**：
   - 下行只传文件路径、行号范围、约束与验证命令，禁止把大段源码全文贴进提示词。
   - 返工修复优先调用 `codex_resume` 传入 `session_id`，吃满 OpenAI Prompt Cache。

4. **堵塞自动解决与智能调度**：
   - 凡是 Codex 任务出现拥塞、静默卡死（`stalled`/`timeout`）、限流（`rate_limit`）、沙盒拦截（`sandbox_denied`）、排队冲突或返回 `blocked` / `ok: false`，**禁止直接把报错甩给用户**。Antigravity 必须自动执行以下恢复闭环（最多 2 轮自动恢复）：
     - 调用 `codex_read_log` 诊断根因；
     - 过大或卡死任务拆分为原子子任务，或将 `reasoning_effort` 从 `high` 降至 `medium`，或用 `worktree: true` 隔离并行；
     - 环境/依赖/受信任仓库 Windows 沙盒问题由 Antigravity 直接修复或调整参数后 `codex_resume` / 重调度；
     - 限流时降低并发并由 Antigravity 直接处理轻量任务；
     - 若同一问题经 2 轮自动恢复后 Codex 仍堵塞，由 **Antigravity 直接接管修改并跑通验证**，随后调用 `codex_mark_resolved`（用中文填写解堵说明）同步更新控制台；
     - 仅在遇到无法从仓库推断的业务/架构取舍（`needs_decision`）或需重新登录（`auth_error`）时才向用户请示。

5. **可视化控制台与直白验收汇报**：
   - 批量调度、自动解堵或用户查看进度时，调用 `codex_console` 打开或刷新 Antigravity 内的 **Codex Console**。
   - 对用户汇报一律**结论先行**，列出准确改动文件与验收结果，彻底删除 GPT 式的免责声明、防御性谦辞与空洞建议，只保留真实未解的阻塞项或需拍板事项。
