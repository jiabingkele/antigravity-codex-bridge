import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { z } from "zod";

const STATUS_LABELS = {
  all: "全部",
  running: "运行中",
  queued: "排队中",
  blocked: "堵塞",
  needs_input: "待决策",
  done: "已完成",
  resolved: "已接管",
  cancelled: "已取消",
};

const uiState = {
  dashboard: null,
  selectedTaskId: null,
  taskDetail: null,
  statusFilter: "all",
  searchQuery: "",
  activeTab: "overview", // overview | files | logs | timeline | prompt
  logFilter: "all", // all | errors | events
  logTailLines: 120,
  logKeyword: "",
  autoRefresh: true,
  mobileView: "list", // list | detail
  modal: null, // null | 'dispatch' | 'settings'
  toast: null,
  loadingDashboard: false,
  loadingDetail: false,
  inFlight: 0,
  caps: {
    serverTools: false,
    message: false,
    updateModelContext: false,
  },
  resumeDraft: "",
  resumeEffort: "",
};

const app = new App({ name: "Codex Console", version: "2.0.0" }, {});
let toastTimer = null;
let pollTimer = null;
let receivedInitialToolResult = false;

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function showToast(text, isError = false) {
  uiState.toast = { text, isError };
  render();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    uiState.toast = null;
    render();
  }, 4500);
}

function formatDuration(sec) {
  const n = Number(sec || 0);
  if (n < 60) return `${n.toFixed(1)}s`;
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  return `${m}m ${s}s`;
}

function formatTokens(n) {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function formatTimeShort(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return iso;
  }
}

function basenameDir(p) {
  if (!p) return "";
  const parts = String(p).replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function toFileUri(cwd, relOrAbs) {
  const isAbs = /^[a-zA-Z]:[\\/]/.test(relOrAbs) || relOrAbs.startsWith("/");
  let full = relOrAbs;
  if (!isAbs && cwd) {
    const sep = cwd.includes("\\") ? "\\" : "/";
    full = `${cwd.replace(/[\\/]+$/, "")}${sep}${relOrAbs}`;
  }
  const normalized = full.replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(normalized)) {
    return `file:///${encodeURI(normalized)}`;
  }
  return `file://${encodeURI(normalized.startsWith("/") ? normalized : `/${normalized}`)}`;
}

function applyThemeContext(ctx) {
  if (!ctx) return;
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
    document.documentElement.setAttribute("data-theme", ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
}

async function callServer(name, args = {}) {
  if (uiState.inFlight >= 3) {
    return null; // Stay strictly under the host's 4 in-flight call ceiling
  }
  uiState.inFlight++;
  try {
    const res = await app.callServerTool({ name, arguments: args });
    if (res?.structuredContent) return res.structuredContent;
    const text = res?.content?.[0]?.text;
    if (text) {
      try {
        return JSON.parse(text);
      } catch {
        return { ok: !res.isError, text };
      }
    }
    return { ok: !res?.isError };
  } finally {
    uiState.inFlight = Math.max(0, uiState.inFlight - 1);
  }
}

function ingestDashboard(data, preserveSelection = true) {
  if (!data || !data.tasks) return;
  uiState.dashboard = data;

  if (!preserveSelection && data.status_filter) {
    uiState.statusFilter = data.status_filter;
  }
  if (!preserveSelection && data.focus_task_id) {
    uiState.selectedTaskId = data.focus_task_id;
  }
  if (
    !uiState.selectedTaskId ||
    !data.tasks.some((t) => t.id === uiState.selectedTaskId)
  ) {
    uiState.selectedTaskId = data.tasks[0]?.id || null;
  }
}

async function refreshDashboard(silent = false) {
  if (uiState.loadingDashboard || !uiState.caps.serverTools) return;
  uiState.loadingDashboard = true;
  if (!silent) render();
  try {
    const data = await callServer("app_get_dashboard", {});
    if (data && data.ok !== false) {
      ingestDashboard(data, true);
    }
  } catch (err) {
    if (!silent) showToast(`刷新失败: ${err.message}`, true);
  } finally {
    uiState.loadingDashboard = false;
    render();
    schedulePoll();
  }
  if (uiState.selectedTaskId) {
    await refreshSelectedDetail(true);
  }
}

async function refreshSelectedDetail(silent = false) {
  if (!uiState.selectedTaskId || uiState.loadingDetail || !uiState.caps.serverTools) return;
  uiState.loadingDetail = true;
  if (!silent) render();
  try {
    const detail = await callServer("app_get_task_detail", {
      task_id: uiState.selectedTaskId,
      tail_lines: uiState.logTailLines,
      log_filter: uiState.logFilter,
    });
    if (detail && detail.ok) {
      uiState.taskDetail = detail;
    }
  } catch (err) {
    if (!silent) showToast(`读取任务详情失败: ${err.message}`, true);
  } finally {
    uiState.loadingDetail = false;
    render();
  }
}

function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  if (!uiState.autoRefresh || !uiState.caps.serverTools) return;
  const counts = uiState.dashboard?.counts;
  const hasActive = (counts?.running || 0) + (counts?.queued || 0) > 0;
  const interval = hasActive ? 2500 : 10000;
  pollTimer = setTimeout(() => {
    refreshDashboard(true);
  }, interval);
}

async function openFileInAntigravity(cwd, filePath) {
  const uri = toFileUri(cwd, filePath);
  try {
    const res = await app.request(
      {
        method: "com.google.antigravity/toggle-aux-pane",
        params: { tabType: "fileView", uri },
      },
      z.object({ isError: z.boolean().optional() }).passthrough()
    );
    if (res?.isError) {
      showToast("当前视图不支持侧栏打开文件（请在对话侧边栏视图中使用）", true);
    } else {
      showToast(`已在 Antigravity 打开 ${filePath}`);
    }
  } catch {
    showToast(`文件路径: ${uri}`);
  }
}

async function askAntigravity(promptText) {
  if (!uiState.caps.message) {
    showToast("全局视图无关联对话，请从对话侧栏打开控制台以直接通知 Antigravity", true);
    return;
  }
  try {
    await app.sendMessage({
      role: "user",
      content: [{ type: "text", text: promptText }],
    });
    showToast("已通知 Antigravity 处理");
  } catch (err) {
    showToast(`发送消息失败: ${err.message}`, true);
  }
}

async function attachTaskContext(task) {
  if (!uiState.caps.updateModelContext) {
    showToast("当前视图不支持附加对话上下文", true);
    return;
  }
  const summary = [
    `[Codex Console 选定任务]`,
    `task_id=${task.id} status=${task.status} session_id=${task.session_id || "none"}`,
    `cwd=${task.cwd} model=${task.model} effort=${task.reasoning_effort}`,
    task.blocker_type ? `blocker=${task.blocker_type}: ${task.blocker_detail}` : "",
    task.log_path ? `log_path=${task.log_path}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    await app.updateModelContext({
      content: [{ type: "text", text: summary }],
    });
    showToast("已将任务信息附加到下一次对话消息");
  } catch (err) {
    showToast(`附加上下文失败: ${err.message}`, true);
  }
}

function getFilteredTasks() {
  const tasks = uiState.dashboard?.tasks || [];
  const q = uiState.searchQuery.trim().toLowerCase();
  return tasks.filter((t) => {
    if (uiState.statusFilter === "blocked") {
      if (t.status !== "blocked" && t.status !== "needs_input") return false;
    } else if (uiState.statusFilter !== "all" && t.status !== uiState.statusFilter) {
      return false;
    }
    if (!q) return true;
    const hay = `${t.title} ${t.id} ${t.session_id || ""} ${t.cwd} ${t.blocker_type || ""} ${t.model}`.toLowerCase();
    return hay.includes(q);
  });
}

function renderStatusBadge(status) {
  const label = STATUS_LABELS[status] || status;
  return `<span class="status-badge status-${escapeHtml(status)}">${escapeHtml(label)}</span>`;
}

function renderLogsHtml(raw) {
  if (!raw) return `<div class="empty-state">暂无日志输出</div>`;
  const kw = uiState.logKeyword.trim().toLowerCase();
  const lines = raw.split(/\r?\n/).filter((l) => (!kw ? true : l.toLowerCase().includes(kw)));
  if (lines.length === 0) return `<div class="empty-state">没有匹配 "${escapeHtml(uiState.logKeyword)}" 的日志行</div>`;
  return `<pre class="code-box">${lines
    .map((line) => {
      let cls = "";
      if (line.startsWith("[stderr]") || /"type"\s*:\s*"(error|turn\.failed)"/.test(line)) {
        cls = "log-line-err";
      } else if (line.startsWith("[stdout]")) {
        cls = "log-line-evt";
      } else if (line.startsWith("#")) {
        cls = "log-line-meta";
      }
      return cls ? `<span class="${cls}">${escapeHtml(line)}</span>` : escapeHtml(line);
    })
    .join("\n")}</pre>`;
}

function renderDetailBody(detail) {
  const t = detail.task;
  const tab = uiState.activeTab;

  if (tab === "overview") {
    const usage = t.usage;
    const inTok = Number(usage?.input_tokens || 0);
    const cachedTok = Number(usage?.cached_input_tokens || 0);
    const outTok = Number(usage?.output_tokens || 0);
    const freshTok = Math.max(0, inTok - cachedTok);
    const totalTok = Math.max(1, inTok + outTok);
    const hitPct = inTok > 0 ? ((cachedTok / inTok) * 100).toFixed(1) : "0.0";

    const blockerHtml = t.blocker_type
      ? `<div class="panel panel-alert">
           <div class="panel-title">
             <span>堵塞诊断 · ${escapeHtml(t.blocker_type)}</span>
             ${
               uiState.caps.message
                 ? `<button class="btn btn-sm btn-warn" data-action="ask-unblock">让 Antigravity 自动解堵</button>`
                 : ""
             }
           </div>
           <div><strong>原因：</strong>${escapeHtml(t.blocker_detail || "未知阻塞")}</div>
           ${
             t.auto_recovery_hint
               ? `<div style="margin-top:6px;color:var(--fg-2)"><strong>调度建议：</strong>${escapeHtml(t.auto_recovery_hint)}</div>`
               : ""
           }
         </div>`
      : "";

    const recoveryHtml =
      Array.isArray(t.recovery_history) && t.recovery_history.length > 0
        ? `<div class="panel panel-recovery">
             <div class="panel-title">Antigravity 自动接管与调度记录 (${t.recovery_history.length})</div>
             <div class="timeline">
               ${t.recovery_history
                 .map(
                   (r) => `<div class="tl-item">
                     <span class="tl-time">${escapeHtml(formatTimeShort(r.at))}</span>
                     <span class="tl-evt">${escapeHtml(r.action)}</span>
                     <span class="tl-detail">${escapeHtml(r.note)}</span>
                   </div>`
                 )
                 .join("")}
             </div>
           </div>`
        : "";

    let receiptHtml = "";
    if (t.kind === "review" && t.review) {
      const issues = Array.isArray(t.review.issues) ? t.review.issues : [];
      receiptHtml = `<div class="panel">
        <div class="panel-title">
          <span>Code Review 结果</span>
          <span class="status-badge ${t.review.verdict === "approve" ? "status-done" : "status-blocked"}">${escapeHtml(t.review.verdict || "unknown")}</span>
        </div>
        <div style="margin-bottom:8px">${escapeHtml(t.review.summary || "")}</div>
        ${
          issues.length > 0
            ? `<table class="data-table">
                <thead><tr><th>级别</th><th>位置</th><th>问题</th><th>建议修复</th></tr></thead>
                <tbody>
                  ${issues
                    .map(
                      (i) => `<tr>
                        <td><span class="kind-tag">${escapeHtml(i.severity)}</span></td>
                        <td class="mono">${escapeHtml(i.file)}${i.line ? `:${i.line}` : ""}</td>
                        <td>${escapeHtml(i.problem)}</td>
                        <td>${escapeHtml(i.fix)}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
            : `<div style="color:var(--ok-fg)">未发现需要阻塞合并的问题。</div>`
        }
      </div>`;
    } else if (t.result) {
      const summaryBullets = Array.isArray(t.result.summary) ? t.result.summary : [];
      const checks = Array.isArray(t.result.checks) ? t.result.checks : [];
      const blockers = Array.isArray(t.result.blockers) ? t.result.blockers : [];
      receiptHtml = `<div class="panel">
        <div class="panel-title">结构化回执摘要</div>
        ${
          summaryBullets.length > 0
            ? `<ul class="bullet-list">${summaryBullets.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>`
            : t.result.raw_text
            ? `<pre class="code-box">${escapeHtml(t.result.raw_text)}</pre>`
            : `<div style="color:var(--fg-3)">暂无摘要（任务可能仍在运行）</div>`
        }
        ${
          blockers.length > 0
            ? `<div style="margin-top:8px;color:var(--err-fg)"><strong>上报阻塞：</strong> ${escapeHtml(blockers.join("；"))}</div>`
            : ""
        }
      </div>
      <div class="panel">
        <div class="panel-title">验收检查项 (${checks.filter((c) => c.passed).length}/${checks.length})</div>
        ${
          checks.length > 0
            ? `<table class="data-table">
                <thead><tr><th>状态</th><th>命令</th><th>结果说明</th></tr></thead>
                <tbody>
                  ${checks
                    .map(
                      (c) => `<tr>
                        <td><span class="status-badge ${c.passed ? "status-done" : "status-blocked"}">${c.passed ? "PASS" : "FAIL"}</span></td>
                        <td class="mono">${escapeHtml(c.command)}</td>
                        <td>${escapeHtml(c.note)}</td>
                      </tr>`
                    )
                    .join("")}
                </tbody>
              </table>`
            : `<div style="color:var(--fg-3)">Codex 尚未上报检查命令。</div>`
        }
      </div>`;
    } else if (t.status === "running" || t.status === "queued") {
      receiptHtml = `<div class="panel">
        <div class="panel-title">实时执行进度</div>
        <div>当前阶段：<span class="mono">${escapeHtml(t.current_stage)}</span> · 已捕获 JSONL 事件：<strong>${t.event_count || 0}</strong> · 最近活跃：${escapeHtml(formatTimeShort(t.last_activity_at))}</div>
      </div>`;
    }

    const tokenPanel = usage
      ? `<div class="panel">
           <div class="panel-title">
             <span>Token 与 Prompt Cache 统计</span>
             <span style="color:var(--ok-fg)">Cache 命中 ${hitPct}%</span>
           </div>
           <div class="token-bar">
             <div class="token-seg-cached" style="width:${(cachedTok / totalTok) * 100}%" title="Cached Input"></div>
             <div class="token-seg-fresh" style="width:${(freshTok / totalTok) * 100}%" title="Fresh Input"></div>
             <div class="token-seg-out" style="width:${(outTok / totalTok) * 100}%" title="Output"></div>
           </div>
           <div class="task-meta">
             <span class="ok">Cached: ${formatTokens(cachedTok)}</span>
             <span class="accent">Fresh In: ${formatTokens(freshTok)}</span>
             <span>Out: ${formatTokens(outTok)}</span>
           </div>
         </div>`
      : "";

    const metaPanel = `<div class="panel">
      <div class="panel-title">
        <span>任务元数据</span>
        ${t.session_id ? `<button class="btn btn-sm" data-action="copy-session">复制 Session ID</button>` : ""}
      </div>
      <div class="kv-grid">
        <div class="kv-item"><div class="kv-k">Task ID</div><div class="kv-v">${escapeHtml(t.id)}</div></div>
        <div class="kv-item"><div class="kv-k">Session ID</div><div class="kv-v">${escapeHtml(t.session_id || "-")}</div></div>
        <div class="kv-item"><div class="kv-k">Model / Effort</div><div class="kv-v">${escapeHtml(t.model)} · ${escapeHtml(t.reasoning_effort)}</div></div>
        <div class="kv-item"><div class="kv-k">Sandbox / Worktree</div><div class="kv-v">${escapeHtml(t.sandbox)}${t.worktree ? " · worktree" : ""}</div></div>
        <div class="kv-item"><div class="kv-k">耗时 / 退出码</div><div class="kv-v">${escapeHtml(formatDuration(t.duration_sec))} · code ${t.exit_code ?? "-"}</div></div>
        <div class="kv-item"><div class="kv-k">工作目录</div><div class="kv-v">${escapeHtml(t.cwd)}</div></div>
      </div>
    </div>`;

    return `${blockerHtml}${recoveryHtml}${receiptHtml}${tokenPanel}${metaPanel}`;
  }

  if (tab === "files") {
    const files = Array.isArray(t.result?.changed_files) ? t.result.changed_files : [];
    const filesList =
      files.length > 0
        ? files
            .map(
              (f) => `<div class="file-row">
                <span class="mono">${escapeHtml(f)}</span>
                <button class="btn btn-sm" data-action="open-file" data-file="${escapeHtml(f)}">在侧栏打开</button>
              </div>`
            )
            .join("")
        : `<div style="color:var(--fg-3)">回执中未记录改动文件。</div>`;

    return `<div class="panel">
      <div class="panel-title">改动文件清单 (${files.length})</div>
      ${filesList}
    </div>
    <div class="panel">
      <div class="panel-title">Git Diff 统计</div>
      <pre class="code-box">${escapeHtml(t.git?.diff_stat || "无 diff 变更或非 Git 目录")}</pre>
    </div>
    <div class="panel">
      <div class="panel-title">Git Status</div>
      <pre class="code-box">${escapeHtml(t.git?.status_short || "工作区干净或非 Git 目录")}</pre>
    </div>`;
  }

  if (tab === "logs") {
    return `<div class="panel">
      <div class="log-toolbar">
        ${["all", "errors", "events"]
          .map((f) => {
            const name = f === "all" ? "全部" : f === "errors" ? "仅错误" : "JSONL 事件";
            return `<button class="pill ${uiState.logFilter === f ? "active" : ""}" data-action="log-filter" data-val="${f}">${name}</button>`;
          })
          .join("")}
        <select id="logTailSelect" style="padding:3px 6px;border-radius:5px;border:1px solid var(--border-1);background:var(--bg-1)">
          ${[80, 120, 200, 400]
            .map((n) => `<option value="${n}" ${uiState.logTailLines === n ? "selected" : ""}>尾部 ${n} 行</option>`)
            .join("")}
        </select>
        <input id="logKeywordInput" class="search-input" style="max-width:190px;padding:3px 7px" placeholder="过滤关键字..." value="${escapeHtml(uiState.logKeyword)}" />
        <button class="btn btn-sm" data-action="refresh-detail">刷新日志</button>
      </div>
      <div style="font-size:11px;color:var(--fg-3);margin-bottom:6px">日志文件：${escapeHtml(t.log_path || "-")}（共 ${detail.log_total_lines || 0} 行）</div>
      ${renderLogsHtml(detail.log_tail)}
    </div>`;
  }

  if (tab === "timeline") {
    const tl = Array.isArray(t.timeline) ? t.timeline : [];
    const chain = Array.isArray(detail.session_chain) ? detail.session_chain : [];
    return `<div class="panel">
      <div class="panel-title">调度与执行时间线 (${tl.length})</div>
      <div class="timeline">
        ${tl
          .map(
            (ev) => `<div class="tl-item">
              <span class="tl-time">${escapeHtml(formatTimeShort(ev.at))}</span>
              <span class="tl-evt">${escapeHtml(ev.event)}</span>
              <span class="tl-detail">${escapeHtml(ev.detail)}</span>
            </div>`
          )
          .join("")}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">同 Session 续接链 (${chain.length})</div>
      ${
        chain.length > 0
          ? chain
              .map(
                (item) => `<div class="file-row">
                  <div>
                    ${renderStatusBadge(item.status)}
                    <span class="kind-tag" style="margin-left:4px">${escapeHtml(item.kind)}</span>
                    <span style="margin-left:6px">${escapeHtml(item.title)}</span>
                  </div>
                  <button class="btn btn-sm" data-action="select-task" data-id="${escapeHtml(item.id)}">查看</button>
                </div>`
              )
              .join("")
          : `<div style="color:var(--fg-3)">暂无多轮续接记录。</div>`
      }
    </div>`;
  }

  // tab === "prompt"
  return `<div class="panel">
    <div class="panel-title">下发给 Codex 的原始任务单</div>
    <pre class="code-box">${escapeHtml(t.task || "(空)")}</pre>
  </div>
  <div class="panel">
    <div class="panel-title">断点续接 / 追问返工（复用 Session Prompt Cache）</div>
    ${
      t.session_id
        ? `<div class="field" style="margin-bottom:8px">
             <label>续接指令（Session: <span class="mono">${escapeHtml(t.session_id)}</span>）</label>
             <textarea id="resumeInstructionInput" rows="3" placeholder="例如：仅修复边界测试空指针并重跑测试...">${escapeHtml(uiState.resumeDraft)}</textarea>
           </div>
           <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
             <select id="resumeEffortSelect" style="padding:5px 8px;border-radius:6px;border:1px solid var(--border-1);background:var(--bg-1)">
               <option value="" ${uiState.resumeEffort === "" ? "selected" : ""}>沿用原档位</option>
               <option value="low" ${uiState.resumeEffort === "low" ? "selected" : ""}>low</option>
               <option value="medium" ${uiState.resumeEffort === "medium" ? "selected" : ""}>medium</option>
               <option value="high" ${uiState.resumeEffort === "high" ? "selected" : ""}>high</option>
               <option value="xhigh" ${uiState.resumeEffort === "xhigh" ? "selected" : ""}>xhigh</option>
             </select>
             <button class="btn btn-primary" data-action="submit-resume">发送到 Codex 续跑</button>
           </div>`
        : `<div style="color:var(--fg-3)">该任务尚未生成 session_id（可能是 ephemeral 或启动即失败），无法续接。</div>`
    }
  </div>`;
}

function renderModal() {
  if (!uiState.modal) return "";
  const dash = uiState.dashboard;

  if (uiState.modal === "dispatch") {
    const defaultCwd = uiState.taskDetail?.task?.cwd || dash?.tasks?.[0]?.cwd || "";
    const defModel = dash?.environment?.default_model || "gpt-6.2-sol";
    const defEffort = dash?.environment?.default_reasoning_effort || "high";
    return `<div class="modal-backdrop" data-action="close-modal">
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-header">
          <span>派发新 Codex 任务</span>
          <button class="btn btn-ghost btn-sm" data-action="close-modal">✕</button>
        </div>
        <div class="field">
          <label>工作目录 (绝对路径 cwd) *</label>
          <input id="dispCwd" type="text" placeholder="例如 C:\\Projects\\my-app" value="${escapeHtml(defaultCwd)}" />
        </div>
        <div class="field">
          <label>任务单 (传文件路径、约束与验证命令，不要贴全文源码) *</label>
          <textarea id="dispTask" rows="5" placeholder="目标：...&#10;涉及文件：src/...&#10;验证：运行 npm test 全部通过"></textarea>
        </div>
        <div class="field-row">
          <div class="field">
            <label>模型</label>
            <input id="dispModel" type="text" value="${escapeHtml(defModel)}" />
          </div>
          <div class="field">
            <label>思考深度 (reasoning_effort)</label>
            <select id="dispEffort">
              ${["low", "medium", "high", "xhigh"]
                .map((e) => `<option value="${e}" ${e === defEffort ? "selected" : ""}>${e}</option>`)
                .join("")}
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>沙盒模式</label>
            <select id="dispSandbox">
              <option value="workspace-write" selected>workspace-write</option>
              <option value="read-only">read-only</option>
              <option value="danger-full-access">danger-full-access</option>
            </select>
          </div>
          <div class="field" style="justify-content:flex-end">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin-top:16px">
              <input id="dispWorktree" type="checkbox" /> 启用独立 Git Worktree（并行无冲突）
            </label>
          </div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">
          <button class="btn" data-action="close-modal">取消</button>
          <button class="btn btn-primary" data-action="submit-dispatch">后台派发执行</button>
        </div>
      </div>
    </div>`;
  }

  if (uiState.modal === "settings") {
    const s = dash?.scheduler || {};
    return `<div class="modal-backdrop" data-action="close-modal">
      <div class="modal" onclick="event.stopPropagation()">
        <div class="modal-header">
          <span>调度器与防堵塞设置</span>
          <button class="btn btn-ghost btn-sm" data-action="close-modal">✕</button>
        </div>
        <div class="field-row">
          <div class="field">
            <label>最大并发数 (1-8)</label>
            <input id="setMaxConc" type="number" min="1" max="8" value="${escapeHtml(s.max_concurrency ?? 2)}" />
          </div>
          <div class="field">
            <label>无进度卡死阈值 (秒)</label>
            <input id="setStallSec" type="number" min="30" max="1800" value="${escapeHtml(s.stall_timeout_seconds ?? 180)}" />
          </div>
        </div>
        <div class="field">
          <label>单任务硬超时上限 (秒)</label>
          <input id="setHardSec" type="number" min="60" max="3600" value="${escapeHtml(s.default_timeout_seconds ?? 600)}" />
        </div>
        <div class="field">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input id="setAutoRec" type="checkbox" ${s.auto_recovery_enabled !== false ? "checked" : ""} />
            堵塞时启用 Antigravity 自动诊断、重调度与接管提示
          </label>
        </div>
        <div style="border-top:1px solid var(--border-2);padding-top:10px;display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <button class="btn btn-danger btn-sm" data-action="clear-finished">清理已完成/已取消历史</button>
          <div style="display:flex;gap:8px">
            <button class="btn" data-action="close-modal">取消</button>
            <button class="btn btn-primary" data-action="submit-settings">保存配置</button>
          </div>
        </div>
      </div>
    </div>`;
  }

  return "";
}

function render() {
  const root = document.getElementById("app");
  const dash = uiState.dashboard;
  if (!dash) {
    root.innerHTML = `<div class="boot-state">正在加载 Codex Bridge 控制台数据...</div>`;
    return;
  }

  const c = dash.counts || {};
  const m = dash.metrics || {};
  const s = dash.scheduler || {};
  const env = dash.environment || {};
  const blockedTotal = (c.blocked || 0) + (c.needs_input || 0);
  const dotClass = blockedTotal > 0 ? "alert" : (c.running || 0) > 0 ? "busy" : "";

  const filteredTasks = getFilteredTasks();
  const detail =
    uiState.taskDetail && uiState.taskDetail.task?.id === uiState.selectedTaskId
      ? uiState.taskDetail
      : null;

  const filterKeys = [
    ["all", c.total || 0],
    ["running", c.running || 0],
    ["queued", c.queued || 0],
    ["blocked", blockedTotal],
    ["done", c.done || 0],
    ["resolved", c.resolved || 0],
  ];

  root.innerHTML = `
    <header class="topbar">
      <div class="brand-group">
        <span class="brand-dot ${dotClass}"></span>
        <span class="brand-title">Codex Console</span>
        <span class="env-chip">${escapeHtml(env.default_model || "gpt-6.2-sol")} · ${escapeHtml(env.default_reasoning_effort || "high")}</span>
        <span class="env-chip">${escapeHtml(env.codex_version || "codex")}</span>
      </div>
      <div class="topbar-actions">
        <button class="btn btn-sm ${uiState.autoRefresh ? "btn-active" : ""}" data-action="toggle-poll">
          ${uiState.autoRefresh ? "● 实时刷新" : "○ 暂停刷新"}
        </button>
        <button class="btn btn-sm" data-action="refresh-all" ${uiState.loadingDashboard ? "disabled" : ""}>刷新</button>
        <button class="btn btn-sm" data-action="open-settings">⚙ 调度</button>
        <button class="btn btn-sm btn-primary" data-action="open-dispatch">+ 派发任务</button>
      </div>
    </header>

    ${
      uiState.toast
        ? `<div class="toast ${uiState.toast.isError ? "error" : ""}">
             <span>${escapeHtml(uiState.toast.text)}</span>
             <button class="btn btn-ghost btn-sm" data-action="dismiss-toast">✕</button>
           </div>`
        : ""
    }

    <section class="kpi-strip">
      <div class="kpi-card">
        <div class="kpi-label">运行 / 排队</div>
        <div class="kpi-value">${c.running || 0} <span style="font-size:12px;color:var(--fg-2)">/ ${c.queued || 0}</span></div>
        <div class="kpi-sub">目录锁: ${(s.active_cwd_locks || []).length}</div>
      </div>
      <div class="kpi-card ${blockedTotal > 0 ? "alert" : ""}">
        <div class="kpi-label">堵塞 / 待决策</div>
        <div class="kpi-value">${blockedTotal}</div>
        <div class="kpi-sub">${s.auto_recovery_enabled !== false ? "自动解堵规则已开启" : "手动处理模式"}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">已完成 / 已接管</div>
        <div class="kpi-value">${c.done || 0} <span style="font-size:12px;color:#c084fc">/ ${c.resolved || 0}</span></div>
        <div class="kpi-sub">总历史任务: ${c.total || 0}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Prompt Cache 命中</div>
        <div class="kpi-value" style="color:var(--ok-fg)">${m.cache_hit_rate_pct ?? 0}%</div>
        <div class="kpi-sub">${formatTokens(m.total_cached_tokens)} / ${formatTokens(m.total_input_tokens)} in</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">累计输出 / 均耗时</div>
        <div class="kpi-value">${formatTokens(m.total_output_tokens)}</div>
        <div class="kpi-sub">平均 ${formatDuration(m.avg_duration_sec)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">并发水位 / 卡死阈值</div>
        <div class="kpi-value">${s.running_count || 0}/${s.max_concurrency || 2}</div>
        <div class="kpi-sub">静默 ${s.stall_timeout_seconds || 180}s 熔断</div>
      </div>
    </section>

    <div class="mobile-switcher">
      <button class="btn btn-sm ${uiState.mobileView === "list" ? "btn-active" : ""}" data-action="mobile-view" data-val="list">任务队列 (${filteredTasks.length})</button>
      <button class="btn btn-sm ${uiState.mobileView === "detail" ? "btn-active" : ""}" data-action="mobile-view" data-val="detail">任务详情</button>
    </div>

    <main class="workspace" data-mobile-view="${uiState.mobileView}">
      <aside class="left-pane">
        <div class="list-controls">
          <input id="taskSearchInput" class="search-input" type="search" placeholder="搜索任务、Session、路径、堵塞类型..." value="${escapeHtml(uiState.searchQuery)}" />
          <div class="filter-pills">
            ${filterKeys
              .map(
                ([k, count]) =>
                  `<button class="pill ${uiState.statusFilter === k ? "active" : ""}" data-action="status-filter" data-val="${k}">${STATUS_LABELS[k]} (${count})</button>`
              )
              .join("")}
          </div>
        </div>
        <div class="task-list">
          ${
            filteredTasks.length === 0
              ? `<div class="empty-state">
                   <strong>暂无匹配任务</strong>
                   <p>点击右上角 "+ 派发任务"，或在对话中让 Antigravity 调度 Codex。</p>
                 </div>`
              : filteredTasks
                  .map((t) => {
                    const selected = t.id === uiState.selectedTaskId;
                    const inTok = Number(t.usage?.input_tokens || 0);
                    const cachedTok = Number(t.usage?.cached_input_tokens || 0);
                    const cacheBadge =
                      inTok > 0 && cachedTok > 0
                        ? `<span class="ok">${Math.round((cachedTok / inTok) * 100)}% cache</span>`
                        : "";
                    const checkBadge =
                      t.checks_total > 0
                        ? `<span class="${t.checks_passed === t.checks_total ? "ok" : "err"}">✓ ${t.checks_passed}/${t.checks_total}</span>`
                        : "";
                    return `<div class="task-card ${selected ? "selected" : ""}" data-action="select-task" data-id="${escapeHtml(t.id)}">
                      <div class="task-card-top">
                        <div class="badge-row">
                          ${renderStatusBadge(t.status)}
                          <span class="kind-tag">${escapeHtml(t.kind)}</span>
                          ${t.worktree ? `<span class="kind-tag">WT</span>` : ""}
                        </div>
                        <span class="mono" style="color:var(--fg-3)">${escapeHtml(formatDuration(t.duration_sec))}</span>
                      </div>
                      <div class="task-title">${escapeHtml(t.title)}</div>
                      <div class="task-meta">
                        <span>${escapeHtml(basenameDir(t.cwd))}</span>
                        <span>${escapeHtml(t.reasoning_effort)}</span>
                        ${t.changed_files_count > 0 ? `<span>${t.changed_files_count} 文件</span>` : ""}
                        ${checkBadge}
                        ${cacheBadge}
                        ${t.blocker_type ? `<span class="err">${escapeHtml(t.blocker_type)}</span>` : ""}
                      </div>
                    </div>`;
                  })
                  .join("")
          }
        </div>
      </aside>

      <section class="right-pane">
        ${
          !uiState.selectedTaskId
            ? `<div class="empty-state">
                 <strong>未选择任务</strong>
                 <p>从左侧选择任意 Codex 任务查看回执、Git Diff、实时日志与调度轨迹。</p>
               </div>`
            : !detail
            ? `<div class="empty-state">正在读取任务详情...</div>`
            : `
              <div class="detail-header">
                <div class="detail-title-row">
                  <div>
                    <div class="badge-row" style="margin-bottom:4px">
                      ${renderStatusBadge(detail.task.status)}
                      <span class="kind-tag">${escapeHtml(detail.task.kind)}</span>
                      <span class="mono" style="color:var(--fg-3)">${escapeHtml(detail.task.id)}</span>
                    </div>
                    <div class="detail-title">${escapeHtml(detail.task.title)}</div>
                  </div>
                </div>
                <div class="detail-actions">
                  ${
                    detail.task.status === "running" || detail.task.status === "queued"
                      ? `<button class="btn btn-sm btn-danger" data-action="cancel-task">中止任务</button>`
                      : ""
                  }
                  ${
                    (detail.task.status === "blocked" || detail.task.status === "needs_input") && uiState.caps.message
                      ? `<button class="btn btn-sm btn-warn" data-action="ask-unblock">让 Antigravity 自动解堵</button>`
                      : ""
                  }
                  ${
                    (detail.task.status === "done" || detail.task.status === "resolved") && uiState.caps.message
                      ? `<button class="btn btn-sm" data-action="ask-verify">让 Antigravity 验收汇报</button>`
                      : ""
                  }
                  ${
                    uiState.caps.updateModelContext
                      ? `<button class="btn btn-sm" data-action="attach-context">附加到下次对话</button>`
                      : ""
                  }
                  <button class="btn btn-sm btn-ghost" data-action="refresh-detail">刷新详情</button>
                </div>
              </div>

              <nav class="tabs">
                ${[
                  ["overview", "概览与验收"],
                  ["files", `文件与 Diff (${detail.task.result?.changed_files?.length || 0})`],
                  ["logs", `实时日志 (${detail.log_total_lines || 0})`],
                  ["timeline", "调度时间线"],
                  ["prompt", "指令与续接"],
                ]
                  .map(
                    ([k, label]) =>
                      `<button class="tab-btn ${uiState.activeTab === k ? "active" : ""}" data-action="switch-tab" data-val="${k}">${label}</button>`
                  )
                  .join("")}
              </nav>

              <div class="detail-body">
                ${renderDetailBody(detail)}
              </div>
            `
        }
      </section>
    </main>

    ${renderModal()}
  `;
}

// Event Delegation
document.addEventListener("click", async (ev) => {
  const target = ev.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  if (action === "dismiss-toast") {
    uiState.toast = null;
    render();
  } else if (action === "toggle-poll") {
    uiState.autoRefresh = !uiState.autoRefresh;
    render();
    schedulePoll();
  } else if (action === "refresh-all") {
    await refreshDashboard(false);
  } else if (action === "refresh-detail") {
    await refreshSelectedDetail(false);
  } else if (action === "status-filter") {
    uiState.statusFilter = target.dataset.val;
    render();
  } else if (action === "mobile-view") {
    uiState.mobileView = target.dataset.val;
    render();
  } else if (action === "switch-tab") {
    uiState.activeTab = target.dataset.val;
    render();
    if (uiState.activeTab === "logs") await refreshSelectedDetail(true);
  } else if (action === "log-filter") {
    uiState.logFilter = target.dataset.val;
    await refreshSelectedDetail(false);
  } else if (action === "select-task") {
    uiState.selectedTaskId = target.dataset.id;
    uiState.mobileView = "detail";
    uiState.resumeDraft = "";
    render();
    await refreshSelectedDetail(false);
  } else if (action === "open-dispatch") {
    uiState.modal = "dispatch";
    render();
  } else if (action === "open-settings") {
    uiState.modal = "settings";
    render();
  } else if (action === "close-modal") {
    uiState.modal = null;
    render();
  } else if (action === "copy-session") {
    const sid = uiState.taskDetail?.task?.session_id;
    if (sid && navigator.clipboard) {
      await navigator.clipboard.writeText(sid).catch(() => {});
      showToast(`已复制 Session ID: ${sid}`);
    }
  } else if (action === "open-file") {
    const cwd = uiState.taskDetail?.task?.cwd;
    const f = target.dataset.file;
    await openFileInAntigravity(cwd, f);
  } else if (action === "cancel-task") {
    const tid = uiState.selectedTaskId;
    if (!tid) return;
    const res = await callServer("app_cancel_task", {
      task_id: tid,
      reason: "用户在 Codex Console 中止",
    });
    showToast(res?.ok ? `已中止任务 ${tid}` : `中止失败: ${res?.error || "未知错误"}`, !res?.ok);
    await refreshDashboard(true);
  } else if (action === "ask-unblock") {
    const t = uiState.taskDetail?.task;
    if (!t) return;
    await askAntigravity(
      `Codex 任务 ${t.id} 发生堵塞（类型: ${t.blocker_type || "unknown"}，原因: ${t.blocker_detail || "无"}，目录: ${t.cwd}，session_id: ${t.session_id || "none"}，日志: ${t.log_path || "none"}）。请按防堵塞自动解决规则：立即查看日志定位根因，自动拆分/修环境/用 codex_resume 续跑或由你直接接管修复，完成后调用 codex_mark_resolved 更新控制台状态并简明汇报结论。`
    );
  } else if (action === "ask-verify") {
    const t = uiState.taskDetail?.task;
    if (!t) return;
    await askAntigravity(
      `请验收 Codex 任务 ${t.id}（目录: ${t.cwd}），核对改动文件与测试结果，去掉防御性措辞，直接给我可读性高的验收结论。`
    );
  } else if (action === "attach-context") {
    if (uiState.taskDetail?.task) {
      await attachTaskContext(uiState.taskDetail.task);
    }
  } else if (action === "submit-dispatch") {
    const cwd = document.getElementById("dispCwd")?.value.trim();
    const task = document.getElementById("dispTask")?.value.trim();
    const model = document.getElementById("dispModel")?.value.trim();
    const reasoning_effort = document.getElementById("dispEffort")?.value;
    const sandbox = document.getElementById("dispSandbox")?.value;
    const worktree = Boolean(document.getElementById("dispWorktree")?.checked);
    if (!cwd || !task) {
      showToast("请填写工作目录 (cwd) 和任务单内容", true);
      return;
    }
    const res = await callServer("app_dispatch_task", {
      cwd,
      task,
      model,
      reasoning_effort,
      sandbox,
      worktree,
    });
    if (res?.ok) {
      uiState.modal = null;
      uiState.selectedTaskId = res.task_id;
      uiState.mobileView = "detail";
      showToast(`已派发任务 ${res.task_id}（状态: ${res.status}）`);
      await refreshDashboard(true);
    } else {
      showToast(`派发失败: ${res?.error || "未知错误"}`, true);
    }
  } else if (action === "submit-resume") {
    const t = uiState.taskDetail?.task;
    const instruction = document.getElementById("resumeInstructionInput")?.value.trim();
    const reasoning_effort = document.getElementById("resumeEffortSelect")?.value;
    if (!t?.session_id || !instruction) {
      showToast("请输入续接指令", true);
      return;
    }
    const args = {
      session_id: t.session_id,
      cwd: t.cwd,
      instruction,
    };
    if (reasoning_effort) args.reasoning_effort = reasoning_effort;
    const res = await callServer("app_resume_task", args);
    if (res?.ok) {
      uiState.resumeDraft = "";
      uiState.selectedTaskId = res.task_id;
      uiState.activeTab = "overview";
      showToast(`已复用会话续跑：${res.task_id}`);
      await refreshDashboard(true);
    } else {
      showToast(`续跑失败: ${res?.error || "未知错误"}`, true);
    }
  } else if (action === "submit-settings") {
    const max_concurrency = Number(document.getElementById("setMaxConc")?.value);
    const stall_timeout_seconds = Number(document.getElementById("setStallSec")?.value);
    const default_timeout_seconds = Number(document.getElementById("setHardSec")?.value);
    const auto_recovery_enabled = Boolean(document.getElementById("setAutoRec")?.checked);
    const res = await callServer("app_update_scheduler", {
      max_concurrency,
      stall_timeout_seconds,
      default_timeout_seconds,
      auto_recovery_enabled,
    });
    if (res?.ok) {
      uiState.modal = null;
      showToast("调度器配置已保存并立即生效");
      await refreshDashboard(true);
    } else {
      showToast(`保存失败: ${res?.error || "未知错误"}`, true);
    }
  } else if (action === "clear-finished") {
    const res = await callServer("app_clear_finished", {});
    uiState.modal = null;
    showToast(`已清理 ${res?.removed || 0} 条已完成/已取消记录`);
    await refreshDashboard(true);
  }
});

document.addEventListener("input", (ev) => {
  if (ev.target.id === "taskSearchInput") {
    uiState.searchQuery = ev.target.value;
    render();
    const el = document.getElementById("taskSearchInput");
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  } else if (ev.target.id === "logKeywordInput") {
    uiState.logKeyword = ev.target.value;
    render();
    const el = document.getElementById("logKeywordInput");
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  } else if (ev.target.id === "resumeInstructionInput") {
    uiState.resumeDraft = ev.target.value;
  }
});

document.addEventListener("change", async (ev) => {
  if (ev.target.id === "logTailSelect") {
    uiState.logTailLines = Number(ev.target.value);
    await refreshSelectedDetail(false);
  } else if (ev.target.id === "resumeEffortSelect") {
    uiState.resumeEffort = ev.target.value;
  }
});

// Register ALL MCP App lifecycle handlers BEFORE connect()
app.ontoolinput = () => {
  // Handled gracefully when tool starts
};

app.ontoolresult = (result) => {
  receivedInitialToolResult = true;
  if (result?.structuredContent && result.structuredContent.tasks) {
    ingestDashboard(result.structuredContent, false);
    render();
    if (uiState.selectedTaskId && uiState.caps.serverTools) {
      refreshSelectedDetail(true);
    }
    schedulePoll();
  }
};

app.ontoolcancelled = () => {
  uiState.loadingDashboard = false;
  render();
};

app.onhostcontextchanged = (ctx) => {
  applyThemeContext(ctx);
};

async function boot() {
  try {
    await app.connect();
    applyThemeContext(app.getHostContext());
    const caps = app.getHostCapabilities() || {};
    uiState.caps = {
      serverTools: Boolean(caps.serverTools),
      message: Boolean(caps.message),
      updateModelContext: Boolean(caps.updateModelContext),
    };

    // Wait briefly for initial ontoolresult from codex_console, otherwise fetch directly
    setTimeout(async () => {
      if (!receivedInitialToolResult && uiState.caps.serverTools) {
        await refreshDashboard(false);
      } else if (uiState.selectedTaskId && uiState.caps.serverTools && !uiState.taskDetail) {
        await refreshSelectedDetail(true);
      }
      schedulePoll();
    }, 120);
  } catch (err) {
    const root = document.getElementById("app");
    root.innerHTML = `<div class="boot-state">MCP App 初始化失败：${escapeHtml(err.message)}</div>`;
  }
}

boot();
