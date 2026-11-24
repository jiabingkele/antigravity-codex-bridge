---
name: codex-orchestrator
description: >-
  Orchestrate local OpenAI Codex CLI (gpt-6.2-sol high) via the codex-bridge MCP server
  and its visual Codex Console UI. Handles heavy coding, refactoring, documentation, and
  code reviews with minimal cross-model token transfer, automatic blocker/stall recovery
  and rescheduling by Antigravity, and direct non-defensive acceptance reporting.
---

# Codex Orchestrator (Antigravity <-> Codex CLI + Visual Console)

Antigravity acts as **architect, scheduler, automatic unblocker, verifier, and human-friendly translator**.
Local Codex CLI (`gpt-6.2-sol`, `reasoning_effort="high"`) acts as the **execution worker**.
The bundled **Codex Console** MCP App (`codex_console`) renders live task queues, receipts, diffs, logs, blockers, and Prompt Cache metrics directly inside Antigravity's side pane and left sidebar.

## 1. Routing Policy (Avoid Wasteful Handoffs)

- **Handle directly in Antigravity**: Q&A, reading/explaining code, small edits (<= 20 lines in 1 file), quick config tweaks.
- **Delegate to `codex_run` (`reasoning_effort: "high"`)**: Multi-file features, complex refactors, hard debugging, architecture implementation, iterative test-fixing.
- **Delegate to `codex_run` (`reasoning_effort: "medium"` or `"low"`)**: Long documentation drafts, boilerplate generation, repetitive tests.
- **Delegate to `codex_review`**: Reviewing uncommitted diffs, base branch changes, or specific commits.

## 2. Visual Console & Multi-Task Scheduling

- For multi-step / parallel dispatches or when the user asks to monitor Codex tasks, call `codex_console` once to open/refresh the side-pane **Codex Console** (also always reachable from the left sidebar or side-pane `+` menu).
- For independent parallel workstreams, call `codex_run` with `background: true` (and `worktree: true` when tasks may touch overlapping files in the same repo). Track progress via `codex_status` and refresh `codex_console` after major transitions.
- The built-in scheduler enforces `max_concurrency` and same-directory write locks automatically so parallel write jobs never corrupt the working tree.

## 3. Zero-Waste Handoff Protocol

### Downlink (Antigravity -> Codex)
Pass **references, never full files**. Keep `task` under ~250 words:
1. **Goal**: Exact expected outcome.
2. **Scope**: File paths and line ranges (let Codex read from disk).
3. **Constraints**: Interfaces, compatibility, non-goals.
4. **Verification**: Exact test/lint/build command Codex MUST run before exiting.

### Uplink (Codex -> Antigravity)
- The MCP server enforces `--output-schema` JSON receipts and writes raw logs to disk.
- Verify from `result` (`status`, `changed_files`, `summary`, `checks`, `blockers`) and `git` (`status_short`, `diff_stat`).
- **Never call `codex_read_log`** on healthy runs; inspect logs only when a task fails, stalls, or reports blockers.
- For high-risk changes, inspect only key diff hunks rather than re-reading whole files.

## 4. Automatic Blocker Resolution & Rescheduling Playbook

When any task returns `ok: false`, `status: "blocked"`, `status: "needs_input"`, or stalls in `codex_status`:

1. **Diagnose immediately**: Read `blocker.type`, `blocker.detail`, and call `codex_read_log(log_path, tail_lines=100)`.
2. **Resolve and reschedule automatically (max 2 Codex retries per blocker)**:
   - **`stalled` / `timeout`**:
     - Check `git diff --stat` to see partial progress.
     - If Codex stalled mid-way with a `session_id`, call `codex_resume` with narrower remaining steps (optionally switching `reasoning_effort` to `"medium"`).
     - If the original task was too large, cancel if still running (`codex_cancel`), split into 2–3 smaller atomic `codex_run` tasks (with `worktree: true` if parallel), and mark the original blocked task resolved via `codex_mark_resolved(action="split_and_rescheduled", ...)`.
   - **`rate_limit`**:
     - Pause launching extra concurrent Codex jobs, handle lightweight tasks directly in Antigravity, retry heavy Codex job after backoff, and log resolution via `codex_mark_resolved(action="concurrency_throttled", ...)`.
   - **`sandbox_denied` / `missing_dependency`**:
     - Fix the local environment/dependency/permission issue safely in Antigravity, then resume the exact session via `codex_resume` and record via `codex_mark_resolved(action="env_fixed_and_resumed", ...)`.
   - **`test_failure` / `execution_error`**:
     - Inspect the failing hunk/assertion directly; send a surgical fix instruction to `codex_resume(session_id, ...)` to reuse Prompt Cache.
     - If Codex still fails after 2 focused `codex_resume` cycles, **Antigravity takes over directly**: fix the code, run the verification command to green, and call `codex_mark_resolved(action="antigravity_takeover", summary=..., changed_files=...)`.
   - **`needs_decision` / `auth_error`**:
     - Resolve `needs_decision` from repository conventions whenever unambiguous; escalate to the user only for genuine product/architecture trade-offs or when `codex login` is required.
3. **Keep the Console truthful**: Always finish an automated recovery by updating status with `codex_mark_resolved` (and `codex_console` if the user is monitoring).

## 5. Acceptance & Anti-Defensive Translation Rules

When reporting completed work to the user:
1. **Lead with the conclusion**: Done / Auto-Recovered / Needs Decision, what changed, and verified check results.
2. **Remove all defensive GPT language**: Strip disclaimers, hedging, throat-clearing, and generic caveats (e.g. "需要注意的是", "仅供参考", "建议您在生产环境自行评估", "虽然我尽力确保……").
3. **Highlight only real signal**: Clickable modified file links, test pass/fail facts, auto-recovery actions taken (if any), and real decisions needing user sign-off.
4. **No redundant code dumps**: Summarize key logic concisely instead of pasting files Codex wrote.
