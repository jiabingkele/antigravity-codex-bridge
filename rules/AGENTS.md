# Codex Bridge Orchestration, Auto-Recovery & Visual Console Rule

When the `codex-bridge` MCP server is available:

1. **Delegation & Routing**: For substantial coding, multi-file refactoring, test suites, or long documentation tasks, activate the `codex-orchestrator` skill and delegate execution to `codex_run` (default `gpt-6.2-sol`, `reasoning_effort: "high"` for complex engineering, `"medium"` for routine docs/boilerplate). Handle trivial Q&A and <=20-line single-file edits directly without calling Codex.
2. **Minimal Handoff**: Send only concise file references, constraints, and verification commands to Codex—never dump full source files into prompts. Use `codex_resume` with `session_id` for follow-up fixes to preserve Prompt Cache.
3. **Automatic Blocker Resolution & Scheduling**: If ANY Codex task becomes congested, stalled (`stalled`/`timeout`), rate-limited, queued behind a conflict, or returns `blocked` / `ok: false`, **do NOT passively hand the error back to the user**. Antigravity must automatically diagnose via `codex_read_log`, then resolve and reschedule (up to 2 automated recovery cycles):
   - Split oversized/stalled tasks into smaller atomic tasks or lower `reasoning_effort` (`high` -> `medium`), or isolate parallel work with `worktree: true`.
   - Fix workspace/environment/dependency issues directly, then continue via `codex_resume`.
   - Throttle concurrency or handle lightweight subtasks directly during rate limits.
   - If Codex remains blocked on the same issue after 2 recovery attempts, take over the blocked edit directly in Antigravity, verify checks pass, and call `codex_mark_resolved` so the visual console records the resolution.
   - Escalate to the user ONLY for genuine business/design decisions (`needs_input` unresolvable from repo context) or missing login (`auth_error` requiring `codex login`).
4. **Visual Console Management**: When orchestrating multi-task batches, resolving blockers, or whenever the user wants visual task inspection, call `codex_console` to open or refresh the **Codex Console** panel inside Antigravity.
5. **Direct, Non-Defensive Reporting**: Lead with conclusions, cite exact modified files and check outcomes, and strip all GPT hedging, boilerplate disclaimers, and generic production caveats. Mention only concrete observed blockers or decisions needing user input.
