#!/usr/bin/env node
/**
 * Zero-dependency MCP stdio server + MCP App backend bridging Antigravity <-> OpenAI Codex CLI.
 *
 * Features:
 * - Pure Node.js >= 18 built-ins at runtime (zero runtime dependencies; Windows/macOS/Linux).
 * - Built-in concurrency & directory write-lock scheduler with persistent task registry.
 * - Automatic stall/congestion detection (stall_timeout_seconds + hard timeout) and blocker
 *   classification so Antigravity can automatically resolve, split, resume, or take over.
 * - Strict --output-schema JSON receipts + disk-isolated raw logs to cut cross-model tokens.
 * - Native Antigravity MCP App (`ui://codex-bridge/console.html`) with aux_pane + global
 *   entrypoints and app-only management tools for real-time visual monitoring and control.
 */

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "codex-bridge";
const SERVER_VERSION = "2.1.0";
const CONSOLE_URI = "ui://codex-bridge/console.html";
const CONSOLE_MIME = "text/html;profile=mcp-app";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, "..");
const RESULT_SCHEMA_PATH = path.join(PLUGIN_ROOT, "schemas", "codex-result.schema.json");
const REVIEW_SCHEMA_PATH = path.join(PLUGIN_ROOT, "schemas", "codex-review.schema.json");
const DEFAULT_CONSOLE_HTML_PATH = path.join(PLUGIN_ROOT, "ui", "dist", "console.html");

const DEFAULT_MODEL = process.env.CODEX_BRIDGE_MODEL || "gpt-6.2-sol";
const DEFAULT_REASONING_EFFORT = process.env.CODEX_BRIDGE_REASONING_EFFORT || "high";
const DEFAULT_SANDBOX = process.env.CODEX_BRIDGE_SANDBOX || "workspace-write";
const DEFAULT_PROFILE = process.env.CODEX_BRIDGE_PROFILE || "";
const DEFAULT_REMOTE = process.env.CODEX_BRIDGE_REMOTE || "";
const DEFAULT_TIMEOUT_SEC = Number(process.env.CODEX_BRIDGE_TIMEOUT_SEC || 600);
const DEFAULT_STALL_TIMEOUT_SEC = Number(process.env.CODEX_BRIDGE_STALL_TIMEOUT_SEC || 180);
const DEFAULT_MAX_CONCURRENCY = Math.max(1, Number(process.env.CODEX_BRIDGE_MAX_CONCURRENCY || 2));
const MAX_STORED_TASKS = 120;

const EXECUTION_CONTRACT = [
  "",
  "【执行契约】",
  "- 请全程使用简体中文进行过程说明、日志输出（agent_message）以及最终回执中的所有描述字段（summary、checks[].note、blockers 等）；代码标识符、文件路径与命令保持原样。",
  "- 直接在磁盘上修改或创建文件；严禁在最终回执中粘贴文件全文或大段代码。",
  "- 结束前必须执行相关构建、lint 或测试验证，并将每条命令与结果如实写入 checks。",
  "- 最终输出必须严格为符合 output-schema 的合法 JSON，表述客观精炼，禁止免责声明、防御性措辞与泛泛建议。",
].join("\n");

// ---------------------------------------------------------------------------
// Paths & Binary Discovery
// ---------------------------------------------------------------------------

function resolveDataDir() {
  const configured = process.env.CODEX_BRIDGE_DATA_DIR;
  if (configured && !configured.includes("${PLUGIN_DATA}") && configured.trim() !== "") {
    return configured;
  }
  return path.join(os.tmpdir(), "antigravity-codex-bridge");
}

function ensureLogsDir() {
  const logsDir = path.join(resolveDataDir(), "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  return logsDir;
}

function getStateFilePath() {
  const dir = resolveDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, "state.json");
}

function getConsoleHtmlPath() {
  const override = process.env.CODEX_BRIDGE_CONSOLE_HTML;
  if (override && override.trim() !== "") return path.resolve(override.trim());
  return DEFAULT_CONSOLE_HTML_PATH;
}

function isFileExecutable(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === "win32") return true;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    if (process.platform === "win32" && /\.(exe|cmd|bat)$/i.test(filePath)) {
      return fs.existsSync(filePath);
    }
    return false;
  }
}

export function resolveCodexBinary() {
  if (process.env.CODEX_BIN && process.env.CODEX_BIN.trim() !== "") {
    return process.env.CODEX_BIN.trim();
  }

  const isWin = process.platform === "win32";
  const pathEnv = process.env.PATH || "";
  const searchDirs = pathEnv.split(path.delimiter).filter(Boolean);

  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA;
    const appData = process.env.APPDATA;
    if (localAppData) {
      searchDirs.push(path.join(localAppData, "Microsoft", "WindowsApps"));
    }
    if (appData) {
      searchDirs.push(path.join(appData, "npm"));
    }
    const candidates = ["codex.exe", "codex.cmd", "codex.bat", "codex"];
    for (const dir of searchDirs) {
      for (const name of candidates) {
        const full = path.join(dir, name);
        if (isFileExecutable(full)) return full;
      }
    }
    return "codex";
  }

  searchDirs.push(
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".local", "bin"),
    path.join(os.homedir(), ".npm-global", "bin")
  );
  for (const dir of searchDirs) {
    const full = path.join(dir, "codex");
    if (isFileExecutable(full)) return full;
  }
  return "codex";
}

function isInsideGitRepo(dir) {
  let current = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function truncateLines(text, maxLines) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length <= maxLines) return lines.join("\n");
  return [...lines.slice(0, maxLines), `... (+${lines.length - maxLines} more lines)`].join("\n");
}

function collectGitSnapshot(cwd) {
  if (!isInsideGitRepo(cwd)) return null;
  const opts = { cwd, encoding: "utf8", timeout: 5000, windowsHide: true };
  const statusRes = spawnSync("git", ["status", "--short"], opts);
  const diffRes = spawnSync("git", ["diff", "--stat"], opts);
  if (statusRes.error && diffRes.error) return null;

  return {
    status_short: statusRes.status === 0 ? truncateLines(statusRes.stdout || "", 30) : "",
    diff_stat: diffRes.status === 0 ? truncateLines(diffRes.stdout || "", 30) : "",
  };
}

function normalizeCwdKey(dir) {
  const abs = path.resolve(dir);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

function validateCwd(cwd) {
  if (!cwd || typeof cwd !== "string") {
    throw new Error("`cwd` must be a non-empty directory path.");
  }
  const resolved = path.resolve(cwd);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Working directory does not exist: ${resolved}`);
  }
  return resolved;
}

function deriveTitle(text, fallback) {
  if (!text || typeof text !== "string") return fallback;
  const firstLine = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0);
  if (!firstLine) return fallback;
  return firstLine.length > 84 ? `${firstLine.slice(0, 81)}...` : firstLine;
}

// ---------------------------------------------------------------------------
// Persistent Task Registry & Scheduler
// ---------------------------------------------------------------------------

const state = {
  settings: {
    max_concurrency: DEFAULT_MAX_CONCURRENCY,
    stall_timeout_seconds: DEFAULT_STALL_TIMEOUT_SEC,
    default_timeout_seconds: DEFAULT_TIMEOUT_SEC,
    auto_recovery_enabled: true,
  },
  tasks: [],
};

// Runtime-only maps for live processes and queue runners
const runtimeJobs = new Map(); // taskId -> { child, cancel, execFn, waitPromise, resolveWait }
const pendingQueue = []; // array of taskIds waiting for concurrency/cwd slot
const activeCwdLocks = new Map(); // cwdKey -> taskId
let runningCount = 0;
let lastPersistMs = 0;

function loadPersistedState() {
  const filePath = getStateFilePath();
  if (!fs.existsSync(filePath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (parsed.settings && typeof parsed.settings === "object") {
      state.settings = {
        ...state.settings,
        ...parsed.settings,
      };
    }
    if (Array.isArray(parsed.tasks)) {
      const nowIso = new Date().toISOString();
      state.tasks = parsed.tasks.slice(0, MAX_STORED_TASKS).map((t) => {
        if (t.status === "running" || t.status === "queued") {
          return {
            ...t,
            status: "blocked",
            current_stage: "interrupted",
            blocker_type: "server_restarted",
            blocker_detail: "任务执行期间 MCP 服务发生重启而中断。",
            auto_recovery_hint: "请检查工作区 git diff 确认局部进度，随后通过 codex_resume 续跑或重新派发。",
            finished_at: nowIso,
            timeline: [
              ...(Array.isArray(t.timeline) ? t.timeline : []),
              {
                at: nowIso,
                event: "blocked",
                detail: "MCP 服务重启导致任务中断",
              },
            ],
          };
        }
        return t;
      });
    }
  } catch (err) {
    process.stderr.write(`[codex-bridge] Failed to load state.json: ${err.message}\n`);
  }
}

function persistState(force = false) {
  const now = Date.now();
  if (!force && now - lastPersistMs < 900) return;
  lastPersistMs = now;

  if (state.tasks.length > MAX_STORED_TASKS) {
    state.tasks = state.tasks.slice(0, MAX_STORED_TASKS);
  }
  const filePath = getStateFilePath();
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup error
    }
    process.stderr.write(`[codex-bridge] Failed to save state.json: ${err.message}\n`);
  }
}

function findTask(taskId) {
  return state.tasks.find((t) => t.id === taskId) || null;
}

function addTimeline(task, event, detail) {
  if (!Array.isArray(task.timeline)) task.timeline = [];
  task.timeline.push({
    at: new Date().toISOString(),
    event,
    detail: String(detail || ""),
  });
  if (task.timeline.length > 40) {
    task.timeline = task.timeline.slice(-40);
  }
}

function createTaskRecord(init) {
  const nowIso = new Date().toISOString();
  const id = `tsk_${Date.now().toString(36)}_${crypto.randomBytes(2).toString("hex")}`;
  const task = {
    id,
    kind: init.kind,
    parent_task_id: init.parent_task_id || null,
    session_id: init.session_id || null,
    status: "queued",
    current_stage: "queued",
    blocker_type: null,
    blocker_detail: null,
    auto_recovery_hint: null,
    title: init.title,
    task: init.task || "",
    cwd: init.cwd,
    model: init.model,
    reasoning_effort: init.reasoning_effort,
    sandbox: init.sandbox || DEFAULT_SANDBOX,
    worktree: Boolean(init.worktree),
    needs_cwd_lock: Boolean(init.needs_cwd_lock),
    created_at: nowIso,
    started_at: null,
    last_activity_at: nowIso,
    finished_at: null,
    duration_sec: 0,
    exit_code: null,
    event_count: 0,
    usage: null,
    result: null,
    review: null,
    git: null,
    errors: [],
    log_path: null,
    recovery_history: [],
    timeline: [{ at: nowIso, event: "queued", detail: `已入队（${init.kind === "resume" ? "断点续跑" : init.kind === "review" ? "代码审查" : "新建任务"}）` }],
  };
  state.tasks.unshift(task);
  persistState(true);
  return task;
}

function classifyBlocker({ timedOut, stalled, exitCode, errors, result }) {
  const joined = [
    ...(errors || []),
    ...(result?.blockers || []),
    ...((result?.checks || []).filter((c) => !c.passed).map((c) => `${c.command}: ${c.note}`)),
  ]
    .join(" \n ")
    .toLowerCase();

  if (stalled) {
    return {
      type: "stalled",
      detail: "Codex 在静默超时阈值内无任何进展输出，已触发卡死熔断。",
      hint: "请先调用 codex_read_log 查看尾部日志；若任务过大，拆分为更小的原子子任务，或携带已有 session_id 缩小范围（可降档至 medium）后用 codex_resume 续跑。",
    };
  }
  if (timedOut) {
    return {
      type: "timeout",
      detail: "Codex 执行时间超出单任务总超时上限。",
      hint: "先检查 git diff 确认已完成的改动，再用 codex_resume 续跑剩余步骤，或将剩余工作拆分为并行子任务重调度。",
    };
  }
  if (/(429|rate.?limit|too many requests|quota|overloaded)/i.test(joined)) {
    return {
      type: "rate_limit",
      detail: "触发 OpenAI 接口限流或配额拥塞（429/quota）。",
      hint: "降低最大并发数并暂停叠加派单，轻量改动由 Antigravity 直接完成，稍后重试核心 Codex 任务。",
    };
  }
  if (/(unauthorized|401|not logged in|authentication|invalid api key|login required)/i.test(joined)) {
    return {
      type: "auth_error",
      detail: "Codex CLI 未登录或认证凭据已过期。",
      hint: "请提示用户在终端执行 `codex login` 重新登录，完成后再继续或重跑任务。",
    };
  }
  if (/windows sandbox failed|provisioning service is unavailable|workspace runtime provisioning service/i.test(joined)) {
    return {
      type: "sandbox_denied",
      detail: "Windows Codex 沙盒运行时服务未就绪（workspace-write 无法创建执行环境）。",
      hint: "可启动 Codex Desktop 后重试；或在受信任的本地仓库中，改用 `sandbox: \"danger-full-access\"` 重调度执行。",
    };
  }
  if (/(permission denied|read-only file system|sandbox|eacces|eperm|operation not permitted)/i.test(joined)) {
    return {
      type: "sandbox_denied",
      detail: "操作被文件系统权限或 Codex 沙盒策略拦截。",
      hint: "由 Antigravity 查看尾部日志确认被拦截的操作，安全修复工作区/权限边界后再调用 codex_resume 续跑。",
    };
  }
  if (/(command not found|not recognized as|cannot find module|modulenotfounderror|no module named|enoent)/i.test(joined)) {
    return {
      type: "missing_dependency",
      detail: "执行过程中缺少必要命令、依赖包或目标文件。",
      hint: "由 Antigravity 核查并补全本地环境/依赖，随后调用 codex_resume 续跑。",
    };
  }
  if (result?.status === "needs_input") {
    return {
      type: "needs_decision",
      detail: (result.blockers && result.blockers[0]) || "Codex 请求澄清需求或确认设计取舍。",
      hint: "若可依据项目既有约定直接确定，请用中文通过 codex_resume 明确答复；仅当涉及真实业务/架构取舍时再向用户请示。",
    };
  }
  if (Array.isArray(result?.checks) && result.checks.some((c) => c.passed === false)) {
    const failedCheck = result.checks.find((c) => c.passed === false);
    return {
      type: "test_failure",
      detail: `验收检查未通过：${failedCheck.command}（${failedCheck.note || "退出码非 0"}）`,
      hint: "核查失败日志与改动 diff，用中文向 codex_resume 发送精准修复指令；若连续 2 轮仍失败，由 Antigravity 直接接管修复并调用 codex_mark_resolved。",
    };
  }
  if (result?.status === "blocked" || exitCode !== 0) {
    return {
      type: "execution_error",
      detail:
        (result?.blockers && result.blockers[0]) ||
        (errors && errors[0]) ||
        `Codex 非正常退出（退出码 ${exitCode}）。`,
      hint: "调用 codex_read_log 定位根因，修复障碍或缩小范围后用 codex_resume 续跑；若持续堵塞，由 Antigravity 直接接管并调用 codex_mark_resolved。",
    };
  }
  return null;
}

function scheduleNext() {
  const maxConc = Math.max(1, Number(state.settings.max_concurrency || DEFAULT_MAX_CONCURRENCY));
  if (runningCount >= maxConc) return;

  for (let i = 0; i < pendingQueue.length; i++) {
    if (runningCount >= maxConc) break;
    const taskId = pendingQueue[i];
    const task = findTask(taskId);
    const job = runtimeJobs.get(taskId);
    if (!task || !job || task.status !== "queued") {
      pendingQueue.splice(i, 1);
      i--;
      continue;
    }

    const cwdKey = normalizeCwdKey(task.cwd);
    if (task.needs_cwd_lock && activeCwdLocks.has(cwdKey)) {
      if (task.current_stage !== "waiting_cwd_lock") {
        task.current_stage = "waiting_cwd_lock";
        addTimeline(task, "waiting", `等待目录写锁释放：${task.cwd}`);
        persistState(true);
      }
      continue;
    }

    // Dequeue & launch
    pendingQueue.splice(i, 1);
    i--;
    runningCount++;
    if (task.needs_cwd_lock) {
      activeCwdLocks.set(cwdKey, taskId);
    }

    task.status = "running";
    task.current_stage = "starting";
    task.started_at = new Date().toISOString();
    task.last_activity_at = task.started_at;
    addTimeline(task, "started", `已启动执行（${task.model} · ${task.reasoning_effort}）`);
    persistState(true);

    job
      .execFn(task, job)
      .catch((err) => {
        const nowIso = new Date().toISOString();
        task.status = "blocked";
        task.current_stage = "failed";
        task.finished_at = nowIso;
        task.errors.push(err.message || String(err));
        task.blocker_type = "execution_error";
        task.blocker_detail = err.message || String(err);
        addTimeline(task, "blocked", task.blocker_detail);
        persistState(true);
        return buildTaskCompactPayload(task);
      })
      .then((payload) => {
        runningCount = Math.max(0, runningCount - 1);
        if (task.needs_cwd_lock && activeCwdLocks.get(cwdKey) === taskId) {
          activeCwdLocks.delete(cwdKey);
        }
        job.resolveWait(payload);
        runtimeJobs.delete(taskId);
        persistState(true);
        scheduleNext();
      });
  }
}

function enqueueTask(task, execFn) {
  let resolveWait;
  const waitPromise = new Promise((res) => {
    resolveWait = res;
  });
  runtimeJobs.set(task.id, {
    child: null,
    cancelled: false,
    execFn,
    waitPromise,
    resolveWait,
  });
  pendingQueue.push(task.id);
  scheduleNext();
  return waitPromise;
}

function cancelTaskById(taskId, reason = "由用户或调度器中止") {
  const task = findTask(taskId);
  if (!task) {
    throw new Error(`未找到任务：${taskId}`);
  }
  if (task.status !== "queued" && task.status !== "running") {
    return {
      ok: true,
      task_id: task.id,
      status: task.status,
      note: `任务已处于结束状态（${task.status}），无需中止。`,
    };
  }

  const job = runtimeJobs.get(taskId);
  const nowIso = new Date().toISOString();
  if (task.status === "queued") {
    const idx = pendingQueue.indexOf(taskId);
    if (idx !== -1) pendingQueue.splice(idx, 1);
    task.status = "cancelled";
    task.current_stage = "cancelled";
    task.finished_at = nowIso;
    task.errors.push(reason);
    addTimeline(task, "cancelled", reason);
    persistState(true);
    if (job) {
      job.cancelled = true;
      job.resolveWait(buildTaskCompactPayload(task));
      runtimeJobs.delete(taskId);
    }
    return { ok: true, task_id: task.id, status: "cancelled" };
  }

  if (job) {
    job.cancelled = true;
    job.cancelReason = reason;
    if (job.child && !job.child.killed) {
      try {
        job.child.kill("SIGTERM");
        setTimeout(() => {
          if (job.child && !job.child.killed) job.child.kill("SIGKILL");
        }, 2500).unref();
      } catch {
        // Ignore kill error
      }
    }
  }
  addTimeline(task, "cancelling", reason);
  persistState(true);
  return { ok: true, task_id: task.id, status: "cancelling" };
}

// ---------------------------------------------------------------------------
// Subprocess Runner with Live Progress & Stall Detection
// ---------------------------------------------------------------------------

function quoteCmdArg(arg) {
  if (/^[a-zA-Z0-9_./:=\\-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

function spawnCodexProcess(codexBin, args, cwd) {
  const isWinBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(codexBin);

  if (isWinBatch) {
    const commandLine = [quoteCmdArg(codexBin), ...args.map(quoteCmdArg)].join(" ");
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: process.env,
    });
  }

  return spawn(codexBin, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    env: process.env,
  });
}

function runCodexSubprocess({
  task,
  job,
  args,
  stdinText,
  cwd,
  outputFilePath,
  timeoutSeconds,
  stallTimeoutSeconds,
}) {
  return new Promise((resolve) => {
    const startMs = Date.now();
    const logsDir = ensureLogsDir();
    const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${task.id}`;
    const logPath = path.join(logsDir, `${runId}.log`);
    task.log_path = logPath;
    persistState(true);

    const logStream = fs.createWriteStream(logPath, { encoding: "utf8" });
    const codexBin = resolveCodexBinary();
    logStream.write(
      `# codex-bridge task ${task.id}\n# bin: ${codexBin}\n# cwd: ${cwd}\n# args: ${JSON.stringify(args)}\n\n`
    );

    let child;
    try {
      child = spawnCodexProcess(codexBin, args, cwd);
    } catch (err) {
      logStream.end();
      resolve({
        ok: false,
        exitCode: -1,
        timedOut: false,
        stalled: false,
        cancelled: false,
        durationSec: 0,
        sessionId: task.session_id,
        usage: null,
        errors: [`Failed to start Codex CLI (${codexBin}): ${err.message}`],
        lastMessageRaw: "",
        logPath,
      });
      return;
    }

    job.child = child;

    let sessionId = task.session_id || null;
    let usage = null;
    const errors = [];
    let timedOut = false;
    let stalled = false;
    let stdoutBuf = "";
    let stderrTail = [];

    const effectiveTimeoutMs =
      Math.max(10, Number(timeoutSeconds || state.settings.default_timeout_seconds || DEFAULT_TIMEOUT_SEC)) * 1000;
    const effectiveStallMs =
      Math.max(15, Number(stallTimeoutSeconds || state.settings.stall_timeout_seconds || DEFAULT_STALL_TIMEOUT_SEC)) *
      1000;

    function killChild() {
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 3000).unref();
      } catch {
        // Ignore
      }
    }

    const hardTimer = setTimeout(() => {
      timedOut = true;
      errors.push(`Codex 执行超过硬超时上限（${Math.round(effectiveTimeoutMs / 1000)} 秒）。`);
      task.current_stage = "timed_out";
      addTimeline(task, "timeout", `超出 ${Math.round(effectiveTimeoutMs / 1000)} 秒上限`);
      persistState(true);
      killChild();
    }, effectiveTimeoutMs);
    hardTimer.unref();

    let stallTimer = null;
    function resetStallTimer() {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalled = true;
        errors.push(
          `Codex 连续 ${Math.round(effectiveStallMs / 1000)} 秒无任何进展，已自动熔断。`
        );
        task.current_stage = "stalled";
        addTimeline(task, "stalled", `连续 ${Math.round(effectiveStallMs / 1000)} 秒无进展输出`);
        persistState(true);
        killChild();
      }, effectiveStallMs);
      stallTimer.unref();
    }
    resetStallTimer();

    function touchActivity(stage) {
      task.last_activity_at = new Date().toISOString();
      task.duration_sec = Number(((Date.now() - startMs) / 1000).toFixed(2));
      if (stage) task.current_stage = stage;
      resetStallTimer();
      persistState(false);
    }

    function processJsonlLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return;
      logStream.write(`[stdout] ${trimmed}\n`);
      task.event_count = (task.event_count || 0) + 1;

      try {
        const evt = JSON.parse(trimmed);
        if (evt.type === "thread.started" && evt.thread_id) {
          sessionId = evt.thread_id;
          task.session_id = sessionId;
          addTimeline(task, "session", `已建立会话 ${sessionId}`);
          touchActivity("executing");
        } else {
          if (!sessionId && typeof evt.thread_id === "string") {
            sessionId = evt.thread_id;
            task.session_id = sessionId;
          } else if (!sessionId && typeof evt.session_id === "string") {
            sessionId = evt.session_id;
            task.session_id = sessionId;
          }
          if (evt.type === "item.started") {
            const itemType = evt.item?.type || "step";
            touchActivity(`running:${itemType}`);
          } else if (evt.type === "item.completed") {
            touchActivity("executing");
          } else if (evt.type === "turn.completed" && evt.usage) {
            usage = evt.usage;
            task.usage = usage;
            touchActivity("finalizing");
          } else {
            touchActivity("executing");
          }
        }
        if (evt.type === "error" && evt.message) {
          errors.push(String(evt.message));
        }
        if (evt.type === "turn.failed") {
          const msg = evt.error?.message || evt.message || "Codex turn failed";
          errors.push(String(msg));
        }
      } catch {
        touchActivity("executing");
      }
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, idx);
        stdoutBuf = stdoutBuf.slice(idx + 1);
        processJsonlLine(line);
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      logStream.write(`[stderr] ${chunk}`);
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.includes("could not create PATH aliases")) continue;
        touchActivity();
        stderrTail.push(trimmed);
        if (stderrTail.length > 14) stderrTail.shift();
      }
    });

    child.on("error", (err) => {
      errors.push(`Process error (${codexBin}): ${err.message}`);
    });

    child.on("close", (code) => {
      clearTimeout(hardTimer);
      if (stallTimer) clearTimeout(stallTimer);
      if (stdoutBuf.trim()) {
        processJsonlLine(stdoutBuf);
      }
      logStream.end();

      let lastMessageRaw = "";
      try {
        if (outputFilePath && fs.existsSync(outputFilePath)) {
          lastMessageRaw = fs.readFileSync(outputFilePath, "utf8").trim();
        }
      } catch {
        // Ignore
      } finally {
        try {
          if (outputFilePath && fs.existsSync(outputFilePath)) {
            fs.unlinkSync(outputFilePath);
          }
        } catch {
          // Ignore
        }
      }

      if (code !== 0 && !job.cancelled && errors.length === 0 && stderrTail.length > 0) {
        errors.push(stderrTail.slice(-4).join(" | "));
      }

      resolve({
        ok: code === 0 && !timedOut && !stalled && !job.cancelled,
        exitCode: code ?? -1,
        timedOut,
        stalled,
        cancelled: Boolean(job.cancelled),
        cancelReason: job.cancelReason || null,
        durationSec: Number(((Date.now() - startMs) / 1000).toFixed(2)),
        sessionId,
        usage,
        errors,
        lastMessageRaw,
        logPath,
      });
    });

    if (typeof stdinText === "string" && stdinText.length > 0) {
      child.stdin.write(stdinText, "utf8");
    }
    child.stdin.end();
  });
}

function parseReceipt(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return {
      raw_text: raw.length > 1500 ? `${raw.slice(0, 1500)}...[truncated]` : raw,
    };
  }
}

function tempReceiptFile(prefix) {
  const dir = ensureLogsDir();
  return path.join(dir, `.${prefix}-${crypto.randomBytes(6).toString("hex")}.json`);
}

function finalizeTaskRecord(task, run, { parsedReceipt, isReview, includeDiffStat }) {
  const nowIso = new Date().toISOString();
  task.finished_at = nowIso;
  task.last_activity_at = nowIso;
  task.duration_sec = run.durationSec;
  task.exit_code = run.exitCode;
  if (run.sessionId) task.session_id = run.sessionId;
  if (run.usage) task.usage = run.usage;
  if (run.errors.length > 0) task.errors = [...task.errors, ...run.errors];
  if (isReview) {
    task.review = parsedReceipt;
  } else {
    task.result = parsedReceipt;
  }
  task.git = includeDiffStat ? collectGitSnapshot(task.cwd) : null;

  if (run.cancelled) {
    task.status = "cancelled";
    task.current_stage = "cancelled";
    task.blocker_type = null;
    task.blocker_detail = run.cancelReason || "Cancelled";
    addTimeline(task, "cancelled", task.blocker_detail);
    persistState(true);
    return;
  }

  const blocker = isReview
    ? run.ok
      ? null
      : classifyBlocker({
          timedOut: run.timedOut,
          stalled: run.stalled,
          exitCode: run.exitCode,
          errors: task.errors,
          result: null,
        })
    : classifyBlocker({
        timedOut: run.timedOut,
        stalled: run.stalled,
        exitCode: run.exitCode,
        errors: task.errors,
        result: parsedReceipt,
      });

  if (blocker) {
    task.status = blocker.type === "needs_decision" ? "needs_input" : "blocked";
    task.current_stage = blocker.type;
    task.blocker_type = blocker.type;
    task.blocker_detail = blocker.detail;
    task.auto_recovery_hint = blocker.hint;
    addTimeline(task, task.status, `${blocker.detail}`);
  } else {
    task.status = "done";
    task.current_stage = "completed";
    task.blocker_type = null;
    task.blocker_detail = null;
    task.auto_recovery_hint = null;
    addTimeline(task, "done", `执行完成，耗时 ${task.duration_sec} 秒`);
  }
  persistState(true);
}

function buildTaskCompactPayload(task) {
  const base = {
    ok: task.status === "done" || task.status === "resolved",
    task_id: task.id,
    status: task.status,
    session_id: task.session_id,
    model: task.model,
    reasoning_effort: task.reasoning_effort,
    duration_sec: task.duration_sec,
    exit_code: task.exit_code,
    usage: task.usage,
    git: task.git,
    errors: task.errors,
    log_path: task.log_path,
  };
  if (task.kind === "review") {
    base.review = task.review;
  } else {
    base.result = task.result;
  }
  if (task.blocker_type) {
    base.blocker = {
      type: task.blocker_type,
      detail: task.blocker_detail,
      auto_recovery_hint: task.auto_recovery_hint,
    };
  }
  return base;
}

// ---------------------------------------------------------------------------
// Core Tool Handlers
// ---------------------------------------------------------------------------

async function handleCodexRun(params) {
  const cwd = validateCwd(params.cwd);
  if (!params.task || typeof params.task !== "string" || !params.task.trim()) {
    throw new Error("`task` must be a non-empty instruction string.");
  }

  const model = params.model || DEFAULT_MODEL;
  const reasoningEffort = params.reasoning_effort || DEFAULT_REASONING_EFFORT;
  const sandbox = params.sandbox || DEFAULT_SANDBOX;
  const profile = params.profile || DEFAULT_PROFILE;
  const remote = params.remote || DEFAULT_REMOTE;
  const worktree = params.worktree === true;
  const includeDiffStat = params.include_diff_stat !== false;
  const background = params.background === true;

  const task = createTaskRecord({
    kind: "run",
    title: deriveTitle(params.task, "Codex task"),
    task: params.task.trim(),
    cwd,
    model: profile ? `profile:${profile}` : model,
    reasoning_effort: profile ? "profile-default" : reasoningEffort,
    sandbox,
    worktree,
    needs_cwd_lock: sandbox !== "read-only" && !worktree,
  });

  const waitPromise = enqueueTask(task, async (t, job) => {
    const outputFile = tempReceiptFile("run");
    const args = ["exec"];
    if (profile) {
      args.push("-p", profile);
    } else {
      args.push("-m", model);
      args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    }
    args.push("-s", sandbox);
    args.push("-C", cwd);
    if (worktree) args.push("--worktree");
    if (params.ephemeral === true) args.push("--ephemeral");
    if (params.skip_git_repo_check === true || !isInsideGitRepo(cwd)) {
      args.push("--skip-git-repo-check");
    }
    if (remote) args.push("--remote", remote);
    args.push("--output-schema", RESULT_SCHEMA_PATH);
    args.push("-o", outputFile);
    args.push("--json");
    args.push("-");

    const prompt = `${params.task.trim()}\n${EXECUTION_CONTRACT}\n`;
    const run = await runCodexSubprocess({
      task: t,
      job,
      args,
      stdinText: prompt,
      cwd,
      outputFilePath: outputFile,
      timeoutSeconds: params.timeout_seconds,
      stallTimeoutSeconds: params.stall_timeout_seconds,
    });

    finalizeTaskRecord(t, run, {
      parsedReceipt: parseReceipt(run.lastMessageRaw),
      isReview: false,
      includeDiffStat,
    });
    return buildTaskCompactPayload(t);
  });

  if (background) {
    return {
      ok: true,
      dispatched: true,
      task_id: task.id,
      status: task.status,
      queue_position: pendingQueue.indexOf(task.id) + 1,
      running_count: runningCount,
      max_concurrency: state.settings.max_concurrency,
      cwd,
      model: task.model,
      reasoning_effort: task.reasoning_effort,
    };
  }

  return await waitPromise;
}

async function handleCodexResume(params) {
  const cwd = validateCwd(params.cwd);
  if (!params.instruction || typeof params.instruction !== "string" || !params.instruction.trim()) {
    throw new Error("`instruction` must be a non-empty follow-up string.");
  }

  const parentTask = params.session_id
    ? state.tasks.find((t) => t.session_id === params.session_id)
    : state.tasks.find((t) => t.session_id);

  const model = params.model || parentTask?.model || DEFAULT_MODEL;
  const reasoningEffort = params.reasoning_effort || parentTask?.reasoning_effort || DEFAULT_REASONING_EFFORT;
  const remote = params.remote || DEFAULT_REMOTE;
  const includeDiffStat = params.include_diff_stat !== false;
  const background = params.background === true;

  const task = createTaskRecord({
    kind: "resume",
    parent_task_id: parentTask?.id || null,
    session_id: params.session_id && params.session_id !== "last" ? String(params.session_id) : null,
    title: deriveTitle(params.instruction, "Resume Codex session"),
    task: params.instruction.trim(),
    cwd,
    model,
    reasoning_effort: reasoningEffort,
    sandbox: parentTask?.sandbox || DEFAULT_SANDBOX,
    worktree: false,
    needs_cwd_lock: true,
  });

  const waitPromise = enqueueTask(task, async (t, job) => {
    const outputFile = tempReceiptFile("resume");
    const args = ["exec", "resume"];
    if (params.model) args.push("-m", params.model);
    if (params.reasoning_effort) {
      args.push("-c", `model_reasoning_effort="${params.reasoning_effort}"`);
    }
    if (params.skip_git_repo_check === true || !isInsideGitRepo(cwd)) {
      args.push("--skip-git-repo-check");
    }
    if (params.ephemeral === true) args.push("--ephemeral");
    if (remote) args.push("--remote", remote);
    args.push("--output-schema", RESULT_SCHEMA_PATH);
    args.push("-o", outputFile);
    args.push("--json");

    if (!params.session_id || params.session_id === "last") {
      args.push("--last");
    } else {
      args.push(String(params.session_id));
    }
    args.push("-");

    const prompt = `${params.instruction.trim()}\n${EXECUTION_CONTRACT}\n`;
    const run = await runCodexSubprocess({
      task: t,
      job,
      args,
      stdinText: prompt,
      cwd,
      outputFilePath: outputFile,
      timeoutSeconds: params.timeout_seconds,
      stallTimeoutSeconds: params.stall_timeout_seconds,
    });

    finalizeTaskRecord(t, run, {
      parsedReceipt: parseReceipt(run.lastMessageRaw),
      isReview: false,
      includeDiffStat,
    });
    return buildTaskCompactPayload(t);
  });

  if (background) {
    return {
      ok: true,
      dispatched: true,
      task_id: task.id,
      status: task.status,
      session_id: task.session_id,
      queue_position: pendingQueue.indexOf(task.id) + 1,
    };
  }

  return await waitPromise;
}

async function handleCodexReview(params) {
  const cwd = validateCwd(params.cwd);
  const model = params.model || DEFAULT_MODEL;
  const reasoningEffort = params.reasoning_effort || DEFAULT_REASONING_EFFORT;
  const remote = params.remote || DEFAULT_REMOTE;
  const background = params.background === true;

  const targetDesc = params.commit
    ? `审查提交 ${params.commit}`
    : params.base
    ? `审查分支差异（对比 ${params.base}）`
    : params.instructions
    ? deriveTitle(params.instructions, "自定义代码审查")
    : "审查当前未提交代码改动";

  const task = createTaskRecord({
    kind: "review",
    title: targetDesc,
    task: params.instructions || targetDesc,
    cwd,
    model,
    reasoning_effort: reasoningEffort,
    sandbox: "read-only",
    worktree: false,
    needs_cwd_lock: false,
  });

  const waitPromise = enqueueTask(task, async (t, job) => {
    const outputFile = tempReceiptFile("review");
    const args = ["exec", "review"];
    args.push("-m", model);
    args.push("-c", `model_reasoning_effort="${reasoningEffort}"`);
    if (remote) args.push("--remote", remote);
    args.push("--ephemeral");
    args.push("--output-schema", REVIEW_SCHEMA_PATH);
    args.push("-o", outputFile);
    args.push("--json");

    const hasCustomInstructions =
      typeof params.instructions === "string" && params.instructions.trim().length > 0;
    let stdinText = "";
    if (params.commit) {
      args.push("--commit", String(params.commit));
    } else if (params.base) {
      args.push("--base", String(params.base));
    } else if (hasCustomInstructions) {
      args.push("-");
      stdinText = `${params.instructions.trim()}\n\n请全程使用简洁客观的简体中文，仅输出符合审查 Schema 的合法 JSON，禁止免责声明与防御性措辞。\n`;
    } else {
      args.push("--uncommitted");
    }

    const run = await runCodexSubprocess({
      task: t,
      job,
      args,
      stdinText,
      cwd,
      outputFilePath: outputFile,
      timeoutSeconds: params.timeout_seconds || 300,
      stallTimeoutSeconds: params.stall_timeout_seconds,
    });

    finalizeTaskRecord(t, run, {
      parsedReceipt: parseReceipt(run.lastMessageRaw),
      isReview: true,
      includeDiffStat: false,
    });
    return buildTaskCompactPayload(t);
  });

  if (background) {
    return {
      ok: true,
      dispatched: true,
      task_id: task.id,
      status: task.status,
      queue_position: pendingQueue.indexOf(task.id) + 1,
    };
  }

  return await waitPromise;
}

function handleReadLog(params) {
  if (!params.log_path || typeof params.log_path !== "string") {
    throw new Error("`log_path` is required.");
  }
  const logsDir = path.resolve(ensureLogsDir());
  const target = path.resolve(params.log_path);
  const rel = path.relative(logsDir, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Access denied: log_path must be inside ${logsDir}`);
  }
  if (!fs.existsSync(target)) {
    throw new Error(`Log file not found: ${target}`);
  }
  const tailLines = Math.min(Math.max(Number(params.tail_lines || 80), 1), 400);
  const content = fs.readFileSync(target, "utf8");
  const lines = content.split(/\r?\n/);
  const sliced = lines.slice(-tailLines).join("\n");
  return {
    ok: true,
    log_path: target,
    total_lines: lines.length,
    returned_lines: Math.min(lines.length, tailLines),
    tail: sliced,
  };
}

function handleCodexStatus(params) {
  if (params.task_id) {
    const task = findTask(params.task_id);
    if (!task) throw new Error(`Task not found: ${params.task_id}`);
    return buildTaskCompactPayload(task);
  }
  const statusFilter = params.status && params.status !== "all" ? params.status : null;
  const limit = Math.min(Math.max(Number(params.limit || 20), 1), 50);
  const filtered = state.tasks
    .filter((t) => (!statusFilter ? true : t.status === statusFilter))
    .slice(0, limit)
    .map(summarizeTaskForList);

  return {
    ok: true,
    scheduler: {
      running_count: runningCount,
      queued_count: pendingQueue.length,
      max_concurrency: state.settings.max_concurrency,
      stall_timeout_seconds: state.settings.stall_timeout_seconds,
      active_cwd_locks: Array.from(activeCwdLocks.keys()),
    },
    counts: computeStatusCounts(),
    tasks: filtered,
  };
}

function handleMarkResolved(params) {
  const task = findTask(params.task_id);
  if (!task) throw new Error(`未找到任务：${params.task_id}`);
  const nowIso = new Date().toISOString();
  const action = params.action || "antigravity_takeover";
  const summary = params.summary || "已由 Antigravity 自动解决并验收。";

  task.status = "resolved";
  task.current_stage = "resolved_by_antigravity";
  if (!task.finished_at) task.finished_at = nowIso;
  if (!Array.isArray(task.recovery_history)) task.recovery_history = [];
  task.recovery_history.push({
    at: nowIso,
    by: "antigravity",
    action,
    note: summary,
    changed_files: Array.isArray(params.changed_files) ? params.changed_files : [],
  });
  addTimeline(task, "resolved", `Antigravity（${action}）：${summary}`);
  persistState(true);

  return {
    ok: true,
    task_id: task.id,
    status: task.status,
    recovery_count: task.recovery_history.length,
  };
}

// ---------------------------------------------------------------------------
// Dashboard / MCP App Helpers
// ---------------------------------------------------------------------------

function computeStatusCounts() {
  const counts = {
    total: state.tasks.length,
    running: 0,
    queued: 0,
    blocked: 0,
    needs_input: 0,
    done: 0,
    resolved: 0,
    cancelled: 0,
  };
  for (const t of state.tasks) {
    if (counts[t.status] !== undefined) counts[t.status]++;
  }
  return counts;
}

function computeAggregateMetrics() {
  let totalInput = 0;
  let totalCached = 0;
  let totalOutput = 0;
  let finishedCount = 0;
  let totalDuration = 0;

  for (const t of state.tasks) {
    if (t.usage) {
      totalInput += Number(t.usage.input_tokens || 0);
      totalCached += Number(t.usage.cached_input_tokens || 0);
      totalOutput += Number(t.usage.output_tokens || 0);
    }
    if (t.finished_at && typeof t.duration_sec === "number" && t.duration_sec > 0) {
      finishedCount++;
      totalDuration += t.duration_sec;
    }
  }

  const cacheHitRate = totalInput > 0 ? Number(((totalCached / totalInput) * 100).toFixed(1)) : 0;
  const avgDuration = finishedCount > 0 ? Number((totalDuration / finishedCount).toFixed(1)) : 0;

  return {
    total_input_tokens: totalInput,
    total_cached_tokens: totalCached,
    total_output_tokens: totalOutput,
    cache_hit_rate_pct: cacheHitRate,
    avg_duration_sec: avgDuration,
  };
}

function summarizeTaskForList(t) {
  const nowSec =
    t.status === "running" && t.started_at
      ? Number(((Date.now() - Date.parse(t.started_at)) / 1000).toFixed(1))
      : t.duration_sec;

  const checks = Array.isArray(t.result?.checks) ? t.result.checks : [];
  const checksPassed = checks.filter((c) => c.passed).length;
  const changedCount = Array.isArray(t.result?.changed_files)
    ? t.result.changed_files.length
    : 0;
  const reviewIssueCount = Array.isArray(t.review?.issues) ? t.review.issues.length : 0;

  return {
    id: t.id,
    kind: t.kind,
    parent_task_id: t.parent_task_id,
    session_id: t.session_id,
    status: t.status,
    current_stage: t.current_stage,
    blocker_type: t.blocker_type,
    blocker_detail: t.blocker_detail,
    title: t.title,
    cwd: t.cwd,
    model: t.model,
    reasoning_effort: t.reasoning_effort,
    sandbox: t.sandbox,
    worktree: t.worktree,
    created_at: t.created_at,
    started_at: t.started_at,
    last_activity_at: t.last_activity_at,
    finished_at: t.finished_at,
    duration_sec: nowSec,
    event_count: t.event_count || 0,
    changed_files_count: changedCount,
    checks_passed: checksPassed,
    checks_total: checks.length,
    review_issues_count: reviewIssueCount,
    usage: t.usage,
    recovery_count: Array.isArray(t.recovery_history) ? t.recovery_history.length : 0,
  };
}

let cachedCodexVersion = null;
function getCodexVersionFast() {
  if (cachedCodexVersion !== null) return cachedCodexVersion;
  const codexBin = resolveCodexBinary();
  try {
    const ver = spawnSync(codexBin, ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(codexBin),
    });
    cachedCodexVersion =
      ver.status === 0
        ? (ver.stdout || ver.stderr || "detected").trim()
        : "unavailable";
  } catch {
    cachedCodexVersion = "unavailable";
  }
  return cachedCodexVersion;
}

function buildDashboardSnapshot(options = {}) {
  const counts = computeStatusCounts();
  const metrics = computeAggregateMetrics();
  const tasks = state.tasks.slice(0, 80).map(summarizeTaskForList);
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    environment: {
      codex_version: getCodexVersionFast(),
      default_model: DEFAULT_MODEL,
      default_reasoning_effort: DEFAULT_REASONING_EFFORT,
      platform: process.platform,
    },
    scheduler: {
      running_count: runningCount,
      queued_count: pendingQueue.length,
      max_concurrency: state.settings.max_concurrency,
      stall_timeout_seconds: state.settings.stall_timeout_seconds,
      default_timeout_seconds: state.settings.default_timeout_seconds,
      auto_recovery_enabled: state.settings.auto_recovery_enabled,
      active_cwd_locks: Array.from(activeCwdLocks.keys()),
    },
    counts,
    metrics,
    tasks,
    focus_task_id: options.focus_task_id || (tasks[0] ? tasks[0].id : null),
    status_filter: options.status_filter || "all",
  };
}

function handleAppGetTaskDetail(params) {
  const task = findTask(params.task_id);
  if (!task) throw new Error(`Task not found: ${params.task_id}`);
  const tailLines = Math.min(Math.max(Number(params.tail_lines || 120), 20), 400);
  const logFilter = params.log_filter || "all"; // all | errors | events

  let logTail = "";
  let logTotalLines = 0;
  if (task.log_path && fs.existsSync(task.log_path)) {
    try {
      const content = fs.readFileSync(task.log_path, "utf8");
      let lines = content.split(/\r?\n/);
      logTotalLines = lines.length;
      if (logFilter === "errors") {
        lines = lines.filter(
          (l) =>
            l.startsWith("[stderr]") ||
            /"type"\s*:\s*"(error|turn\.failed)"/.test(l) ||
            /error|fail|exception|denied|timeout|stall/i.test(l)
        );
      } else if (logFilter === "events") {
        lines = lines.filter((l) => l.startsWith("[stdout] {"));
      }
      logTail = lines.slice(-tailLines).join("\n");
    } catch (err) {
      logTail = `[Unable to read log: ${err.message}]`;
    }
  }

  // Find sibling tasks in the same session_id chain
  const sessionChain = task.session_id
    ? state.tasks
        .filter((t) => t.session_id === task.session_id)
        .map((t) => ({
          id: t.id,
          kind: t.kind,
          status: t.status,
          title: t.title,
          created_at: t.created_at,
          duration_sec: t.duration_sec,
        }))
        .reverse()
    : [];

  return {
    ok: true,
    task: {
      ...task,
      duration_sec:
        task.status === "running" && task.started_at
          ? Number(((Date.now() - Date.parse(task.started_at)) / 1000).toFixed(1))
          : task.duration_sec,
    },
    log_tail: logTail,
    log_total_lines: logTotalLines,
    session_chain: sessionChain,
  };
}

function handleAppUpdateScheduler(params) {
  if (params.max_concurrency !== undefined) {
    const val = Number(params.max_concurrency);
    if (!Number.isFinite(val) || val < 1 || val > 8) {
      throw new Error("max_concurrency must be between 1 and 8.");
    }
    state.settings.max_concurrency = Math.round(val);
  }
  if (params.stall_timeout_seconds !== undefined) {
    const val = Number(params.stall_timeout_seconds);
    if (!Number.isFinite(val) || val < 30 || val > 1800) {
      throw new Error("stall_timeout_seconds must be between 30 and 1800.");
    }
    state.settings.stall_timeout_seconds = Math.round(val);
  }
  if (params.default_timeout_seconds !== undefined) {
    const val = Number(params.default_timeout_seconds);
    if (!Number.isFinite(val) || val < 60 || val > 3600) {
      throw new Error("default_timeout_seconds must be between 60 and 3600.");
    }
    state.settings.default_timeout_seconds = Math.round(val);
  }
  if (typeof params.auto_recovery_enabled === "boolean") {
    state.settings.auto_recovery_enabled = params.auto_recovery_enabled;
  }
  persistState(true);
  scheduleNext();
  return {
    ok: true,
    settings: state.settings,
    running_count: runningCount,
    queued_count: pendingQueue.length,
  };
}

function handleAppClearFinished() {
  const before = state.tasks.length;
  state.tasks = state.tasks.filter(
    (t) => t.status === "running" || t.status === "queued" || t.status === "blocked" || t.status === "needs_input"
  );
  const removed = before - state.tasks.length;
  persistState(true);
  return { ok: true, removed, remaining: state.tasks.length };
}

// ---------------------------------------------------------------------------
// MCP Tool & Resource Definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "codex_console",
    title: "Codex Console",
    description:
      "Open or refresh the interactive Codex Console UI inside Antigravity (side pane & sidebar) to visually inspect running/queued/blocked Codex tasks, structured receipts, diffs, live logs, and Prompt Cache metrics.",
    _meta: {
      ui: { resourceUri: CONSOLE_URI },
      "com.google.antigravity/ui": {
        entrypoints: [
          { type: "aux_pane", title: "Codex Console" },
          { type: "global", title: "Codex Console" },
        ],
      },
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        focus_task_id: {
          type: "string",
          description: "Optional task ID to select automatically in the console.",
        },
        status_filter: {
          type: "string",
          enum: ["all", "running", "queued", "blocked", "needs_input", "done", "resolved"],
          description: "Optional initial status filter.",
        },
      },
    },
  },
  {
    name: "codex_run",
    description:
      "Delegate a coding, refactoring, or documentation task to local OpenAI Codex CLI (default: gpt-6.2-sol, reasoning_effort=high). Enforces strict JSON receipts, isolates raw logs to disk, enforces concurrency/cwd write-locks, and detects stalls automatically.",
    inputSchema: {
      type: "object",
      required: ["task", "cwd"],
      additionalProperties: false,
      properties: {
        task: {
          type: "string",
          description:
            "Concise task brief: goal, target file paths/line ranges, constraints, and exact verification command(s). Pass references, never full file contents.",
        },
        cwd: {
          type: "string",
          description: "Absolute path to the target project directory.",
        },
        model: {
          type: "string",
          description: `Codex model slug. Defaults to '${DEFAULT_MODEL}'.`,
        },
        reasoning_effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh"],
          description: `Reasoning depth ('high' for complex code/bugs, 'medium'/'low' for routine docs/boilerplate). Defaults to '${DEFAULT_REASONING_EFFORT}'.`,
        },
        sandbox: {
          type: "string",
          enum: ["read-only", "workspace-write", "danger-full-access"],
          description: "Codex execution sandbox. Defaults to 'workspace-write'.",
        },
        profile: {
          type: "string",
          description: "Optional Codex config profile (-p <name>) overriding model/reasoning_effort.",
        },
        worktree: {
          type: "boolean",
          description: "Run inside a new managed Git worktree for isolated parallel tasks.",
        },
        background: {
          type: "boolean",
          description: "Dispatch asynchronously and return task_id immediately (poll via codex_status or watch in codex_console). Defaults to false.",
        },
        ephemeral: {
          type: "boolean",
          description: "Skip persisting rollout files (disables later codex_resume).",
        },
        skip_git_repo_check: {
          type: "boolean",
          description: "Allow running outside a Git repo (auto-enabled when .git is absent).",
        },
        include_diff_stat: {
          type: "boolean",
          description: "Include git status --short and git diff --stat in response. Defaults to true.",
        },
        timeout_seconds: {
          type: "integer",
          description: "Hard max runtime in seconds. Defaults to 600.",
        },
        stall_timeout_seconds: {
          type: "integer",
          description: "Auto-abort as stalled if Codex produces zero progress for this many seconds. Defaults to 180.",
        },
      },
    },
  },
  {
    name: "codex_resume",
    description:
      "Continue an existing Codex session using its session_id (reuses context and OpenAI Prompt Cache for fast follow-up fixes or blocker recovery without re-explaining background).",
    inputSchema: {
      type: "object",
      required: ["instruction", "cwd"],
      additionalProperties: false,
      properties: {
        session_id: {
          type: "string",
          description: "Session UUID returned by a prior codex_run. Omit or pass 'last' to resume the latest session.",
        },
        instruction: {
          type: "string",
          description: "Focused follow-up or fix instruction.",
        },
        cwd: {
          type: "string",
          description: "Absolute path to the target project directory.",
        },
        model: {
          type: "string",
          description: "Optional model override for this resumed turn.",
        },
        reasoning_effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh"],
          description: "Optional reasoning effort override for this resumed turn.",
        },
        background: {
          type: "boolean",
          description: "Dispatch asynchronously and return task_id immediately. Defaults to false.",
        },
        include_diff_stat: {
          type: "boolean",
          description: "Include git status --short and git diff --stat. Defaults to true.",
        },
        timeout_seconds: {
          type: "integer",
          description: "Hard max runtime in seconds. Defaults to 600.",
        },
        stall_timeout_seconds: {
          type: "integer",
          description: "Auto-abort as stalled after this many silent seconds. Defaults to 180.",
        },
      },
    },
  },
  {
    name: "codex_review",
    description:
      "Run non-interactive Codex code review on uncommitted changes, a base branch, or a specific commit, returning only structured actionable issues.",
    inputSchema: {
      type: "object",
      required: ["cwd"],
      additionalProperties: false,
      properties: {
        cwd: {
          type: "string",
          description: "Absolute path to the Git repository.",
        },
        base: {
          type: "string",
          description: "Review changes against this base branch (optional).",
        },
        commit: {
          type: "string",
          description: "Review changes introduced by a specific commit SHA (optional).",
        },
        instructions: {
          type: "string",
          description: "Optional custom review prompt (used when base/commit are omitted).",
        },
        model: {
          type: "string",
          description: `Codex model slug. Defaults to '${DEFAULT_MODEL}'.`,
        },
        reasoning_effort: {
          type: "string",
          enum: ["low", "medium", "high", "xhigh"],
          description: `Reasoning depth. Defaults to '${DEFAULT_REASONING_EFFORT}'.`,
        },
        background: {
          type: "boolean",
          description: "Dispatch asynchronously and return task_id immediately. Defaults to false.",
        },
        timeout_seconds: {
          type: "integer",
          description: "Max runtime in seconds. Defaults to 300.",
        },
      },
    },
  },
  {
    name: "codex_status",
    description:
      "Check scheduler queue status, running/blocked tasks, or inspect a single task_id for automated rescheduling and blocker detection.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        task_id: {
          type: "string",
          description: "Optional task_id to inspect a specific task in compact form.",
        },
        status: {
          type: "string",
          enum: ["all", "running", "queued", "blocked", "needs_input", "done", "resolved", "cancelled"],
          description: "Filter task list by status when task_id is omitted.",
        },
        limit: {
          type: "integer",
          description: "Max tasks to return (1-50). Defaults to 20.",
        },
      },
    },
  },
  {
    name: "codex_cancel",
    description:
      "Abort a stalled/running Codex task or remove a queued task so Antigravity can reschedule, split, or take over.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      additionalProperties: false,
      properties: {
        task_id: {
          type: "string",
          description: "Task ID to cancel.",
        },
        reason: {
          type: "string",
          description: "Concise reason for cancellation (logged in console timeline).",
        },
      },
    },
  },
  {
    name: "codex_mark_resolved",
    description:
      "Mark a blocked/stalled Codex task as resolved after Antigravity automatically resolves the blocker, reschedules, or takes over implementation directly. Updates the visual Codex Console.",
    inputSchema: {
      type: "object",
      required: ["task_id", "summary"],
      additionalProperties: false,
      properties: {
        task_id: {
          type: "string",
          description: "Blocked task ID that Antigravity resolved.",
        },
        action: {
          type: "string",
          enum: [
            "antigravity_takeover",
            "split_and_rescheduled",
            "env_fixed_and_resumed",
            "concurrency_throttled",
          ],
          description: "How Antigravity resolved the blocker.",
        },
        summary: {
          type: "string",
          description: "Terse factual summary of what fixed the blocker.",
        },
        changed_files: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of files Antigravity modified during takeover.",
        },
      },
    },
  },
  {
    name: "codex_read_log",
    description:
      "Read the tail of a saved Codex run log file. Call ONLY when a task fails, stalls, or reports blockers needing diagnosis.",
    inputSchema: {
      type: "object",
      required: ["log_path"],
      additionalProperties: false,
      properties: {
        log_path: {
          type: "string",
          description: "Exact log_path returned by a previous codex_* call.",
        },
        tail_lines: {
          type: "integer",
          description: "Number of trailing lines to read (1-400). Defaults to 80.",
        },
      },
    },
  },

  // --- App-only tools (hidden from model, invoked by the Codex Console UI) ---
  {
    name: "app_get_dashboard",
    description: "App-only: fetch full dashboard metrics, scheduler state, and task list.",
    _meta: { ui: { visibility: ["app"] } },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "app_get_task_detail",
    description: "App-only: fetch complete detail, git snapshot, timeline, session chain, and filtered log tail for one task.",
    _meta: { ui: { visibility: ["app"] } },
    inputSchema: {
      type: "object",
      required: ["task_id"],
      additionalProperties: false,
      properties: {
        task_id: { type: "string" },
        tail_lines: { type: "integer" },
        log_filter: { type: "string", enum: ["all", "errors", "events"] },
      },
    },
  },
  {
    name: "app_dispatch_task",
    description: "App-only: dispatch a background Codex task directly from the Console UI.",
    _meta: { ui: { visibility: ["app"] } },
    inputSchema: {
      type: "object",
      required: ["task", "cwd"],
      additionalProperties: false,
      properties: {
        task: { type: "string" },
        cwd: { type: "string" },
        model: { type: "string" },
        reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
        sandbox: { type: "string", enum: ["read-only", "workspace-write", "danger-full-access"] },
        worktree: { type: "boolean" },
      },
    },
  },
  {
    name: "app_resume_task",
    description: "App-only: resume a task session asynchronously from the Console UI.",
    _meta: { ui: { visibility: ["app"] } },
    inputSchema: {
      type: "object",
      required: ["session_id", "instruction", "cwd"],
      additionalProperties: false,
      properties: {
        session_id: { type: "string" },
        instruction: { type: "string" },
        cwd: { type: "string" },
        reasoning_effort: { type: "string", enum: ["low", "medium", "high", "xhigh"] },
      },
    },
  },
  {
    name: "app_cancel_task",
    description: "App-only: cancel a running or queued task from the Console UI.",
    _meta: { ui: { visibility: ["app"] } },
    inputSchema: {
      type: "object",
      required: ["task_id"],
      additionalProperties: false,
      properties: {
        task_id: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
  {
    name: "app_update_scheduler",
    description: "App-only: update concurrency limit, stall timeout, or auto-recovery flag.",
    _meta: { ui: { visibility: ["app"] } },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        max_concurrency: { type: "integer" },
        stall_timeout_seconds: { type: "integer" },
        default_timeout_seconds: { type: "integer" },
        auto_recovery_enabled: { type: "boolean" },
      },
    },
  },
  {
    name: "app_clear_finished",
    description: "App-only: remove completed and cancelled tasks from history while preserving active and blocked tasks.",
    _meta: { ui: { visibility: ["app"] } },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
];

const RESOURCES = [
  {
    uri: CONSOLE_URI,
    name: "Codex Console",
    description:
      "Interactive visual dashboard inside Antigravity for managing Codex CLI tasks, queues, blockers, diffs, logs, and Prompt Cache metrics.",
    mimeType: CONSOLE_MIME,
    _meta: {
      ui: {
        prefersBorder: false,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 Stdio Transport
// ---------------------------------------------------------------------------

function sendMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResult(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  sendMessage({ jsonrpc: "2.0", id, error: err });
}

function readConsoleHtml() {
  const htmlPath = getConsoleHtmlPath();
  if (!fs.existsSync(htmlPath)) {
    throw new Error(
      `Console UI bundle missing at ${htmlPath}. Run 'pnpm --dir ui run build' to generate it.`
    );
  }
  const html = fs.readFileSync(htmlPath, "utf8");
  if (!html.trim()) {
    throw new Error(`Console UI bundle at ${htmlPath} is empty.`);
  }
  return html;
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  if (method === "notifications/initialized" || method?.startsWith("notifications/")) {
    return;
  }

  if (method === "initialize") {
    const requested = params?.protocolVersion;
    const protocolVersion =
      requested && SUPPORTED_PROTOCOL_VERSIONS.has(requested)
        ? requested
        : "2025-03-26";
    sendResult(id, {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      instructions:
        "所有下发给 Codex 的指令、恢复摘要与原因均使用简体中文。使用 codex_run 委派重任务，codex_resume 复用 Prompt Cache，codex_review 执行代码审查，codex_status/codex_cancel/codex_mark_resolved 配合自动防堵塞调度，codex_console 打开或刷新可视化控制台。",
    });
    return;
  }

  if (method === "ping") {
    if (!isNotification) sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, { tools: TOOLS });
    return;
  }

  if (method === "resources/list") {
    sendResult(id, { resources: RESOURCES });
    return;
  }

  if (method === "resources/read") {
    const uri = params?.uri;
    if (uri !== CONSOLE_URI) {
      sendError(id, -32602, `Unknown resource URI: ${uri}`);
      return;
    }
    try {
      const html = readConsoleHtml();
      sendResult(id, {
        contents: [
          {
            uri: CONSOLE_URI,
            mimeType: CONSOLE_MIME,
            text: html,
            _meta: {
              ui: {
                prefersBorder: false,
              },
            },
          },
        ],
      });
    } catch (err) {
      sendError(id, -32603, err.message || String(err));
    }
    return;
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    try {
      if (toolName === "codex_console") {
        const snapshot = buildDashboardSnapshot(toolArgs);
        const summaryLine = `Codex 控制台已就绪：运行中=${snapshot.counts.running}，排队中=${snapshot.counts.queued}，堵塞=${snapshot.counts.blocked + snapshot.counts.needs_input}，已完成=${snapshot.counts.done}，已自动接管=${snapshot.counts.resolved}，缓存命中率=${snapshot.metrics.cache_hit_rate_pct}%。`;
        sendResult(id, {
          content: [{ type: "text", text: summaryLine }],
          structuredContent: snapshot,
          isError: false,
        });
        return;
      }

      let payload;
      if (toolName === "codex_run") {
        payload = await handleCodexRun(toolArgs);
      } else if (toolName === "codex_resume") {
        payload = await handleCodexResume(toolArgs);
      } else if (toolName === "codex_review") {
        payload = await handleCodexReview(toolArgs);
      } else if (toolName === "codex_status") {
        payload = handleCodexStatus(toolArgs);
      } else if (toolName === "codex_cancel") {
        payload = cancelTaskById(toolArgs.task_id, toolArgs.reason);
      } else if (toolName === "codex_mark_resolved") {
        payload = handleMarkResolved(toolArgs);
      } else if (toolName === "codex_read_log") {
        payload = handleReadLog(toolArgs);
      } else if (toolName === "app_get_dashboard") {
        payload = buildDashboardSnapshot();
      } else if (toolName === "app_get_task_detail") {
        payload = handleAppGetTaskDetail(toolArgs);
      } else if (toolName === "app_dispatch_task") {
        payload = await handleCodexRun({ ...toolArgs, background: true });
      } else if (toolName === "app_resume_task") {
        payload = await handleCodexResume({ ...toolArgs, background: true });
      } else if (toolName === "app_cancel_task") {
        payload = cancelTaskById(toolArgs.task_id, toolArgs.reason || "Cancelled from Codex Console");
      } else if (toolName === "app_update_scheduler") {
        payload = handleAppUpdateScheduler(toolArgs);
      } else if (toolName === "app_clear_finished") {
        payload = handleAppClearFinished();
      } else {
        sendError(id, -32602, `Unknown tool: ${toolName}`);
        return;
      }

      sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: payload.ok === false,
      });
    } catch (err) {
      const errPayload = { ok: false, error: err.message || String(err) };
      sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(errPayload) }],
        structuredContent: errPayload,
        isError: true,
      });
    }
    return;
  }

  if (!isNotification) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

function runSelfTest() {
  const codexBin = resolveCodexBinary();
  const schemasOk =
    fs.existsSync(RESULT_SCHEMA_PATH) && fs.existsSync(REVIEW_SCHEMA_PATH);
  const consoleHtmlPath = getConsoleHtmlPath();
  const consoleUiOk = fs.existsSync(consoleHtmlPath) && fs.statSync(consoleHtmlPath).size > 0;
  let codexVersion = "not found";
  try {
    const ver = spawnSync(codexBin, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(codexBin),
    });
    if (ver.status === 0) {
      codexVersion = (ver.stdout || ver.stderr || "").trim();
    } else {
      codexVersion = `error (exit ${ver.status}): ${(ver.stderr || ver.error?.message || "").trim()}`;
    }
  } catch (err) {
    codexVersion = `error: ${err.message}`;
  }

  const report = {
    ok:
      schemasOk &&
      consoleUiOk &&
      !codexVersion.startsWith("error") &&
      codexVersion !== "not found",
    version: SERVER_VERSION,
    node: process.version,
    platform: process.platform,
    plugin_root: PLUGIN_ROOT,
    data_dir: resolveDataDir(),
    codex_binary: codexBin,
    codex_version: codexVersion,
    default_model: DEFAULT_MODEL,
    default_reasoning_effort: DEFAULT_REASONING_EFFORT,
    max_concurrency: DEFAULT_MAX_CONCURRENCY,
    stall_timeout_seconds: DEFAULT_STALL_TIMEOUT_SEC,
    schemas_present: schemasOk,
    console_ui_ready: consoleUiOk,
    console_ui_bytes: consoleUiOk ? fs.statSync(consoleHtmlPath).size : 0,
    model_tools: TOOLS.filter((t) => !t._meta?.ui?.visibility?.includes("app") || t._meta?.ui?.visibility?.includes("model")).map((t) => t.name),
    app_only_tools: TOOLS.filter((t) => t._meta?.ui?.visibility?.length === 1 && t._meta.ui.visibility[0] === "app").map((t) => t.name),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(report.ok ? 0 : 1);
}

function startStdioServer() {
  loadPersistedState();
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      sendError(null, -32700, `Parse error: ${err.message}`);
      return;
    }
    handleRequest(msg).catch((err) => {
      if (msg && msg.id !== undefined && msg.id !== null) {
        sendError(msg.id, -32603, err.message || String(err));
      } else {
        process.stderr.write(`[codex-bridge] Unhandled error: ${err.stack || err}\n`);
      }
    });
  });

  rl.on("close", () => {
    for (const job of runtimeJobs.values()) {
      if (job.child && !job.child.killed) {
        try {
          job.child.kill("SIGTERM");
        } catch {
          // Ignore
        }
      }
    }
    persistState(true);
    process.exit(0);
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  try {
    const argvReal = fs.realpathSync(path.resolve(process.argv[1]));
    const selfReal = fs.realpathSync(__filename);
    return process.platform === "win32"
      ? argvReal.toLowerCase() === selfReal.toLowerCase()
      : argvReal === selfReal;
  } catch {
    const argvPath = path.resolve(process.argv[1]);
    return process.platform === "win32"
      ? argvPath.toLowerCase() === __filename.toLowerCase()
      : argvPath === __filename;
  }
}

if (process.argv.includes("--self-test")) {
  runSelfTest();
} else if (isMainModule()) {
  startStdioServer();
}
