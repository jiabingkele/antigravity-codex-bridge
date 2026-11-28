import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import {
  buildCodexEnvironment,
  diagnoseCodexLaunch,
  findStoreCodex,
  localCodexCandidates,
  storeCodexCandidates,
} from "../server/codex-cli.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(REPO_ROOT, "server", "codex-mcp-server.mjs");
const isWindows = process.platform === "win32";

function testDirectory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeExecutable(file, content = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
}

test("子进程 PATH 保留原有绝对目录并补齐 Node.js 和全局安装位置", () => {
  const root = path.resolve(os.tmpdir(), "Codex 环境");
  const nodeDir = path.join(root, "Node.js");
  const bin = path.join(root, "旧 PATH");
  const npm = path.join(root, "npm-prefix");
  const roaming = path.join(root, "Roaming");
  const local = path.join(root, "Local");
  const env = {
    [isWindows ? "Path" : "PATH"]: [`"${bin}"`, isWindows ? bin.toUpperCase() : bin, "", "."].join(path.delimiter),
    ProgramFiles: path.join(root, "Program Files"),
    NPM_CONFIG_PREFIX: npm,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    CODEX_HOME: path.join(root, "codex-home"),
  };
  const patched = buildCodexEnvironment(env, path.join(nodeDir, isWindows ? "node.exe" : "node"), root);
  const dirs = patched.PATH.split(path.delimiter);
  assert.deepEqual(dirs.slice(0, 2), [nodeDir, bin]);
  assert.equal(dirs.length, new Set(dirs.map((dir) => isWindows ? dir.toLowerCase() : dir)).size);
  assert.ok(dirs.every((dir) => path.isAbsolute(dir)));
  assert.equal(patched.CODEX_HOME, env.CODEX_HOME);
  if (isWindows) {
    assert.equal("Path" in patched, false);
    assert.ok(dirs.includes(npm));
    assert.ok(dirs.includes(path.join(roaming, "npm")));
    assert.ok(dirs.includes(path.join(local, "Microsoft", "WindowsApps")));
    assert.ok(dirs.includes(path.join(env.ProgramFiles, "nodejs")));
    assert.ok("Path" in env);
  } else {
    assert.ok(dirs.includes(path.join(npm, "bin")));
    assert.ok(dirs.includes(path.join(root, ".local", "bin")));
  }
});

test("优先解析 npm 平台包原生文件并兼容旧版 vendor 目录", (t) => {
  const cpu = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  const abi = { win32: "pc-windows-msvc", darwin: "apple-darwin", linux: "unknown-linux-musl" }[process.platform];
  if (!cpu || !abi) return t.skip("当前平台没有对应的 Codex npm 平台包");
  const root = testDirectory(t);
  const bin = isWindows ? root : path.join(root, "bin");
  const modules = path.join(root, ...(isWindows ? [] : ["lib"]), "node_modules", "@openai");
  const executable = isWindows ? "codex.exe" : "codex";
  const launcher = writeExecutable(path.join(bin, isWindows ? "codex.cmd" : "codex"));
  const platformPackage = `codex-${process.platform}-${process.arch}`;
  const vendorPath = ["vendor", `${cpu}-${abi}`];
  const nested = writeExecutable(path.join(modules, "codex", "node_modules", "@openai", platformPackage, ...vendorPath, "bin", executable));
  const hoisted = writeExecutable(path.join(modules, platformPackage, ...vendorPath, "bin", executable));
  const legacy = writeExecutable(path.join(modules, "codex", ...vendorPath, "codex", executable));
  assert.deepEqual([...localCodexCandidates({ PATH: bin })], [nested, hoisted, legacy, launcher]);
  fs.unlinkSync(nested);
  fs.unlinkSync(hoisted);
  assert.deepEqual([...localCodexCandidates({ PATH: bin })], [legacy, launcher]);
});

function storeFixture(root, version, arch = process.arch) {
  const dir = path.join(root, `OpenAI.Codex_${version}_${arch}__publisher`);
  const binary = writeExecutable(path.join(dir, "app", "resources", "codex.exe"));
  return { dir, binary };
}

test("商店安装路径按数字版本排序并跳过其他架构、资源包和缺失文件", (t) => {
  const root = testDirectory(t);
  const old = storeFixture(root, "26.9.200.0");
  const latest = storeFixture(root, "26.10.2.0");
  const otherArch = storeFixture(root, "27.0.0.0", "unsupported");
  const resource = path.join(root, `OpenAI.Codex_28.0.0.0_${process.arch}_resource_publisher`);
  writeExecutable(path.join(resource, "app", "resources", "codex.exe"));
  const missing = path.join(root, `OpenAI.Codex_29.0.0.0_${process.arch}__publisher`);
  fs.mkdirSync(path.join(missing, "app", "resources", "codex.exe"), { recursive: true });
  assert.deepEqual(
    storeCodexCandidates([old.dir, otherArch.dir, missing, latest.dir, resource, latest.dir]),
    [latest.binary, old.binary],
  );
});

test("Windows AppX 查询失败后仍会跨 Program Files 目录查找最新商店版", { skip: !isWindows }, async (t) => {
  const root = testDirectory(t);
  const programFiles = path.join(root, "Program Files");
  const programFiles64 = path.join(root, "Program Files 64");
  const old = storeFixture(path.join(programFiles, "WindowsApps"), "26.9.0.0");
  const latest = storeFixture(path.join(programFiles64, "WindowsApps"), "26.10.0.0");
  const env = { SystemRoot: path.join(root, "不存在的 Windows"), ProgramFiles: programFiles, ProgramW6432: programFiles64 };
  const discovered = [];
  for await (const binary of findStoreCodex(env, 500)) discovered.push(binary);
  assert.deepEqual(discovered, [latest.binary, old.binary]);
});

test("启动诊断区分 CLI 缺失与工作目录消失", (t) => {
  const missingCli = diagnoseCodexLaunch("codex", { error: { code: "ENOENT" } });
  assert.equal(missingCli.type, "missing_dependency");
  assert.match(missingCli.hint, /npm install -g @openai\/codex/);
  const missingCwd = diagnoseCodexLaunch("codex", {
    error: { code: "ENOENT" }, cwd: path.join(testDirectory(t), "missing"),
  });
  assert.equal(missingCwd.type, "execution_error");
  assert.match(missingCwd.detail, /任务工作目录已不存在/);
});

test("Windows 启动诊断识别英文和非 UTF-8 的 node 未找到提示", { skip: !isWindows }, () => {
  for (const stderr of [
    `'"node"' is not recognized as an internal or external command,\r\noperable program or batch file.`,
    Buffer.from([0x27, 0x22, 0x6e, 0x6f, 0x64, 0x65, 0x22, 0x27, 0x20, 0xb2, 0xbb, 0xca, 0xc7]).toString("utf8"),
  ]) {
    const blocker = diagnoseCodexLaunch("codex.cmd", { stderr });
    assert.equal(blocker.type, "missing_dependency");
    assert.match(blocker.detail, /找不到 Node\.js/);
    assert.match(blocker.hint, /重新派发任务/);
    assert.equal(diagnoseCodexLaunch("codex.exe", { stderr }), null);
  }
});

function createConsoleHarness() {
  const source = fs.readFileSync(path.join(REPO_ROOT, "ui", "src", "app.js"), "utf8")
    .replace(/^import\s+[\s\S]*?;\r?\n/gm, "");
  const listeners = new Map();
  const inputs = new Map();
  const calls = [];
  const tasks = ["task-1", "task-2"].map((id) => ({ id, title: id, status: "done" }));
  const responses = {
    app_get_dashboard: () => ({ ok: true, tasks, generated_at: "初始时间" }),
    app_get_task_detail: ({ task_id }) => ({ ok: true, task: tasks.find((task) => task.id === task_id) }),
  };
  const newScrollArea = () => ({ scrollTop: 0, scrollLeft: 0 });
  let html = "";
  let renders = 0;
  let scrollAreas = new Map();
  const root = {
    get innerHTML() {
      return html;
    },
    set innerHTML(value) {
      html = value;
      renders++;
      scrollAreas = new Map();
      inputs.clear();
      document.activeElement = null;
      Object.assign(document.documentElement, newScrollArea());
      Object.assign(document.body, newScrollArea());
      for (const [, name] of html.matchAll(/class="(task-list|tabs|detail-body|code-box|modal)"/g)) {
        const selector = `.${name}`;
        if (!scrollAreas.has(selector)) scrollAreas.set(selector, []);
        scrollAreas.get(selector).push(newScrollArea());
      }
      for (const [, id] of html.matchAll(/<(?:input|textarea|select) id="([^"]+)"/g)) {
        inputs.set(id, {
          id,
          value: "",
          matches: (selector) => selector === "input[id], textarea[id], select[id]",
          focus: () => { document.activeElement = inputs.get(id); },
          setSelectionRange(start, end, direction) {
            Object.assign(this, { selectionStart: start, selectionEnd: end, selectionDirection: direction });
          },
        });
      }
    },
    querySelectorAll: (selector) => scrollAreas.get(selector) ?? [],
  };
  const document = {
    documentElement: newScrollArea(),
    body: newScrollArea(),
    getElementById: (id) => id === "app" ? root : inputs.get(id),
    addEventListener: (event, listener) => listeners.set(event, listener),
  };
  const consoleApp = runInNewContext(`${source}\n({ uiState, render, refreshDashboard, refreshSelectedDetail });`, {
    App: class {
      connect() {
        return new Promise(() => {});
      }
      async callServerTool({ name, arguments: args }) {
        calls.push({ name, args });
        return { structuredContent: await responses[name](args) };
      }
    },
    document,
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  Object.assign(consoleApp.uiState, {
    dashboard: responses.app_get_dashboard(),
    selectedTaskId: tasks[0].id,
    taskDetail: responses.app_get_task_detail({ task_id: tasks[0].id }),
    activeTab: "files",
    caps: { serverTools: true },
  });
  consoleApp.render();

  return {
    ...consoleApp, root, document, inputs, calls, responses,
    get renders() { return renders; },
    click(action, { backdrop = false, ...dataset } = {}) {
      return listeners.get("click")({
        target: {
          matches: (selector) => backdrop && selector === '[data-modal-backdrop="true"]',
          closest: (selector) => action && selector === "[data-action]" ? { dataset: { action, ...dataset } } : null,
        },
      });
    },
    press: (key) => listeners.get("keydown")({ key }),
    input: (target) => listeners.get("input")({ target }),
  };
}

test("控制台弹窗支持关闭和提交，静默刷新保留表单", async () => {
  const ui = createConsoleHarness();
  for (const modal of ["settings", "dispatch"]) {
    await ui.click(`open-${modal}`);
    assert.match(ui.root.innerHTML, /class="modal-backdrop" data-modal-backdrop="true">\s*<div class="modal">/);
    assert.equal((ui.root.innerHTML.match(/data-action="close-modal"/g) || []).length, 2);
    await ui.click(null);
    ui.press("Enter");
    assert.equal(ui.uiState.modal, modal);
    await ui.click("close-modal");
    assert.equal(ui.uiState.modal, null);
  }
  await ui.click("open-settings");
  await ui.click(null, { backdrop: true });
  assert.equal(ui.uiState.modal, null);

  await ui.click("open-dispatch");
  const draft = ui.inputs.get("dispTask");
  draft.value = "待提交的任务";
  const beforePoll = ui.renders;
  const dashboard = { ...ui.uiState.dashboard, scheduler: { max_concurrency: 5 } };
  const detail = { ...ui.uiState.taskDetail, task: { ...ui.uiState.taskDetail.task, title: "最新任务详情" } };
  ui.responses.app_get_dashboard = () => dashboard;
  ui.responses.app_get_task_detail = () => detail;
  await ui.refreshDashboard(true);
  assert.equal(ui.renders, beforePoll);
  assert.equal(ui.inputs.get("dispTask"), draft);
  assert.equal(draft.value, "待提交的任务");
  assert.equal(ui.uiState.dashboard, dashboard);
  assert.equal(ui.uiState.taskDetail, detail);
  ui.press("Escape");
  assert.equal(ui.uiState.modal, null);
  assert.equal(ui.renders, beforePoll + 1);
  assert.match(ui.root.innerHTML, /最新任务详情/);
  assert.doesNotMatch(ui.root.innerHTML, /class="modal-backdrop"/);

  await ui.click("open-dispatch");
  ui.inputs.get("dispCwd").value = REPO_ROOT;
  ui.inputs.get("dispTask").value = "验证派发";
  ui.responses.app_dispatch_task = () => ({ ok: true, task_id: detail.task.id, status: "queued" });
  await ui.click("submit-dispatch");
  assert.equal(ui.uiState.modal, null);
  assert.equal(ui.calls.find(({ name }) => name === "app_dispatch_task").args.task, "验证派发");

  await ui.click("open-settings");
  ui.inputs.get("setMaxConc").value = "5";
  ui.inputs.get("setStallSec").value = "120";
  ui.inputs.get("setHardSec").value = "600";
  ui.inputs.get("setAutoRec").checked = true;
  ui.responses.app_update_scheduler = () => ({ ok: true });
  await ui.click("submit-settings");
  assert.equal(ui.uiState.modal, null);
  assert.equal(ui.calls.find(({ name }) => name === "app_update_scheduler").args.max_concurrency, 5);

  await ui.click("open-settings");
  ui.responses.app_clear_finished = () => ({ ok: true, removed: 2 });
  await ui.click("clear-finished");
  assert.equal(ui.uiState.modal, null);
  assert.ok(ui.calls.some(({ name }) => name === "app_clear_finished"));
  assert.match(ui.root.innerHTML, /已清理 2 条/);
});

test("控制台轮询仅渲染变更并保留滚动、焦点和选区", async () => {
  const ui = createConsoleHarness();
  const selectors = [".task-list", ".tabs", ".detail-body", ".code-box", ".modal"];
  const areas = () => [
    ui.document.documentElement,
    ui.document.body,
    ...selectors.flatMap((selector) => ui.root.querySelectorAll(selector)),
  ];
  const positions = (elements) => elements.map(({ scrollTop, scrollLeft }) => [scrollTop, scrollLeft]);
  const scroll = () => areas().forEach((area, index) => {
    area.scrollTop = 30 + index;
    area.scrollLeft = 10 + index;
  });
  scroll();
  const initialPositions = positions(areas());
  assert.equal(ui.root.querySelectorAll(".code-box").length, 2);
  const search = ui.inputs.get("taskSearchInput");
  search.focus();
  search.setSelectionRange(1, 3, "backward");

  const beforePoll = ui.renders;
  const dashboard = { ...ui.uiState.dashboard, generated_at: "刷新时间" };
  ui.responses.app_get_dashboard = () => dashboard;
  await ui.refreshDashboard(true);
  assert.equal(ui.renders, beforePoll);
  assert.equal(ui.inputs.get("taskSearchInput"), search);

  ui.responses.app_get_dashboard = () => ({ ...dashboard, scheduler: { max_concurrency: 4 } });
  await ui.refreshDashboard(true);
  assert.equal(ui.renders, beforePoll + 1);
  assert.deepEqual(positions(areas()), initialPositions);
  const focused = ui.inputs.get("taskSearchInput");
  assert.notEqual(focused, search);
  assert.equal(ui.document.activeElement, focused);
  assert.deepEqual([focused.selectionStart, focused.selectionEnd, focused.selectionDirection], [1, 3, "backward"]);
  focused.value = "task";
  ui.input(focused);
  assert.equal(ui.document.activeElement.selectionStart, 1);
  assert.equal(ui.document.activeElement.selectionEnd, 3);

  const beforeDetail = ui.renders;
  const getDetail = ui.responses.app_get_task_detail;
  ui.responses.app_get_task_detail = (args) => ({ ...getDetail(args), log_tail: "新日志" });
  await ui.refreshDashboard(true);
  assert.equal(ui.renders, beforeDetail + 1);
  assert.deepEqual(positions(areas()), initialPositions);

  let finishPoll;
  ui.responses.app_get_dashboard = () => new Promise((resolve) => { finishPoll = resolve; });
  const pendingPoll = ui.refreshDashboard(true);
  await ui.click("open-settings");
  scroll();
  const modalPositions = positions(areas());
  ui.render();
  assert.deepEqual(positions(areas()), modalPositions);
  await ui.click("close-modal");
  assert.match(ui.root.innerHTML, /data-action="refresh-all"\s*>/);
  const afterClose = ui.renders;
  finishPoll({ ...ui.uiState.dashboard, generated_at: "下一次刷新时间" });
  await pendingPoll;
  assert.equal(ui.renders, afterClose);

  await ui.click("switch-tab", { val: "logs" });
  assert.deepEqual(positions(areas()).slice(0, 4), initialPositions.slice(0, 4));
  assert.deepEqual(positions(ui.root.querySelectorAll(".detail-body")), [[0, 0]]);
  assert.deepEqual(positions(ui.root.querySelectorAll(".code-box")), [[0, 0]]);
  scroll();
  await ui.click("select-task", { id: "task-2" });
  assert.deepEqual(positions(areas()).slice(0, 3), initialPositions.slice(0, 3));
  assert.deepEqual(positions(ui.root.querySelectorAll(".detail-body")), [[0, 0]]);
  assert.deepEqual(positions(ui.root.querySelectorAll(".code-box")), [[0, 0]]);
});

function createMockCodex(tmpDir, { discoverable = false } = {}) {
  const mockJsPath = path.join(tmpDir, "mock-codex.mjs");
  const mockScript = `
import fs from "node:fs";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  console.log("codex-cli 0.171.0-mock");
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdinText = Buffer.concat(chunks).toString("utf8");

const outIdx = args.indexOf("-o");
const outPath = outIdx !== -1 ? args[outIdx + 1] : null;
const schemaIdx = args.indexOf("--output-schema");
const schemaPath = schemaIdx !== -1 ? args[schemaIdx + 1] : null;

if (stdinText.includes("SLEEP_LONG")) {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-sleep-1" }));
  await new Promise((r) => setTimeout(r, 8000));
  process.exit(0);
}

if (stdinText.includes("RATE_LIMIT_TRIGGER")) {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-429-1" }));
  console.log(JSON.stringify({ type: "turn.failed", error: { message: "HTTP 429 Too Many Requests: rate limit exceeded" } }));
  process.exit(1);
}

const isResume = args[0] === "exec" && args[1] === "resume";
const isReview = args[0] === "exec" && args[1] === "review";

if ((isResume || isReview) && (args.includes("-C") || args.includes("-s"))) {
  console.error("Invalid flag passed to resume/review: " + JSON.stringify(args));
  process.exit(2);
}

console.error("WARNING: proceeding, even though we could not create PATH aliases: access denied");
console.error("Noisy progress line that must NOT enter Antigravity context");

const threadId = isReview ? "thread-review-456" : "thread-shared-123";
console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
console.log(JSON.stringify({ type: "item.started", item: { type: "command_execution" } }));
console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", output: "HUGE_NOISY_LOG_LINE" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: isResume ? 850 : 200, output_tokens: 60 } }));

if (outPath) {
  let payload;
  if (isReview) {
    payload = {
      verdict: "changes_requested",
      issues: [
        {
          severity: "high",
          file: "src/app.js",
          line: 12,
          problem: "Null dereference on empty input",
          fix: "Guard input before property access"
        }
      ],
      summary: "1 high-severity null guard missing."
    };
  } else {
    payload = {
      status: "done",
      changed_files: ["src/demo.js"],
      summary: [isResume ? "Fixed edge case on resumed session" : "Implemented requested change"],
      checks: [{ command: "npm test", passed: true, note: "5 passed" }],
      blockers: []
    };
  }
  fs.writeFileSync(outPath, JSON.stringify(payload), "utf8");
}

if (process.env.MOCK_CAPTURE_FILE) {
  fs.writeFileSync(
    process.env.MOCK_CAPTURE_FILE,
    JSON.stringify({ args, stdinText, schemaExists: Boolean(schemaPath && fs.existsSync(schemaPath)) }),
    "utf8"
  );
}
`;
  fs.writeFileSync(mockJsPath, mockScript, "utf8");

  return isWindows
    ? writeExecutable(path.join(tmpDir, discoverable ? "codex.cmd" : "mock-codex.cmd"), '@echo off\r\n"node" "%~dp0mock-codex.mjs" %*\r\n')
    : writeExecutable(path.join(tmpDir, discoverable ? "codex" : "mock-codex.sh"), `#!/bin/sh\nexec node "${mockJsPath}" "$@"\n`);
}

class McpTestClient {
  constructor(env) {
    this.child = spawn(process.execPath, [SERVER_PATH], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.nextId = 1;
    this.pending = new Map();
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.rl.on("line", (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve(msg);
      }
    });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async close() {
    this.rl.close();
    this.child.stdin.end();
    await new Promise((r) => this.child.on("close", r));
  }
}

function isolatedServerEnv(tmpDir, env = {}) {
  return {
    CODEX_BIN: "",
    CODEX_BRIDGE_DATA_DIR: path.join(tmpDir, "data"),
    PATH: "",
    APPDATA: path.join(tmpDir, "Roaming"),
    LOCALAPPDATA: path.join(tmpDir, "Local"),
    NPM_CONFIG_PREFIX: "",
    npm_config_prefix: "",
    ...env,
  };
}

function selfTest(env) {
  const result = spawnSync(process.execPath, [SERVER_PATH, "--self-test"], {
    env: { ...process.env, ...env }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.error, undefined);
  return { status: result.status, report: JSON.parse(result.stdout) };
}

function callTool(client, name, args = {}) {
  return client.request("tools/call", { name, arguments: args });
}

test("跳过无效候选并在旧 PATH 下自动探测和执行 npm 启动器", async (t) => {
  const root = testDirectory(t);
  const globalBin = isWindows ? path.join(root, "Roaming", "npm") : path.join(root, "npm-prefix", "bin");
  const earlier = path.join(root, "失效的 CLI");
  writeExecutable(path.join(earlier, isWindows ? "codex.exe" : "codex"), "#!/bin/sh\necho invalid-launcher\n");
  fs.mkdirSync(globalBin, { recursive: true });
  const launcher = createMockCodex(globalBin, { discoverable: true });
  const capture = path.join(root, "capture.json");
  const env = isolatedServerEnv(root, {
    PATH: earlier, NPM_CONFIG_PREFIX: isWindows ? "" : path.dirname(globalBin), MOCK_CAPTURE_FILE: capture,
  });
  const { status, report } = selfTest(env);
  assert.equal(status, 0, JSON.stringify(report));
  assert.equal(report.codex_binary, launcher);
  assert.equal(report.codex_version, "codex-cli 0.171.0-mock");

  const client = new McpTestClient(env);
  try {
    const profile = '测试 & %PATH% ! "模型" \\';
    const run = await callTool(client, "codex_run", { cwd: root, task: "测试旧 PATH", profile });
    const result = JSON.parse(run.result.content[0].text);
    assert.equal(result.status, "done", JSON.stringify(result));
    const { args } = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.equal(args[args.indexOf("-p") + 1], profile);
  } finally {
    await client.close();
  }
});

test("显式 CLI 路径缺失时自检和任务给出中文诊断，安装后控制台自动恢复", async (t) => {
  const root = testDirectory(t);
  const launcher = path.join(root, isWindows ? "mock-codex.cmd" : "mock-codex.sh");
  const env = isolatedServerEnv(root, { CODEX_BIN: launcher });
  const { status, report } = selfTest(env);
  assert.equal(status, 1);
  assert.equal(report.codex_binary, launcher);
  assert.match(report.codex_error, /可执行文件或启动程序不存在/);
  assert.match(report.codex_recovery_hint, /CODEX_BIN/);

  const client = new McpTestClient(env);
  try {
    const version = async () => (await callTool(client, "app_get_dashboard")).result.structuredContent.environment.codex_version;
    assert.equal(await version(), "Codex CLI 不可用");
    const run = await callTool(client, "codex_run", { cwd: root, task: "测试启动失败" });
    const failed = JSON.parse(run.result.content[0].text);
    assert.equal(failed.blocker.type, "missing_dependency");
    assert.match(failed.blocker.detail, /可执行文件或启动程序不存在/);
    assert.match(failed.blocker.auto_recovery_hint, /重新派发任务/);
    assert.equal(createMockCodex(root), launcher);
    await new Promise((resolve) => setTimeout(resolve, 2600));
    assert.equal(await version(), "codex-cli 0.171.0-mock");
    fs.unlinkSync(launcher);
    assert.equal(await version(), "Codex CLI 不可用");
    createMockCodex(root);
    const retried = await callTool(client, "codex_run", { cwd: root, task: "安装后立刻重试" });
    assert.equal(JSON.parse(retried.result.content[0].text).status, "done");
  } finally {
    await client.close();
  }
});

test("CLI 启动返回 ENOENT 时自检提示检查 CLI 安装路径", (t) => {
  const root = testDirectory(t);
  const { status, report } = selfTest(isolatedServerEnv(root, { CODEX_BIN: `missing-codex-${process.pid}` }));
  assert.equal(status, 1);
  assert.match(report.codex_error, /可执行文件或启动程序不存在/);
  assert.match(report.codex_recovery_hint, /npm install -g @openai\/codex/);
});

test("Windows 批处理运行时找不到 node 时，任务显示可执行的中文建议", { skip: !isWindows }, async (t) => {
  const root = testDirectory(t);
  const launcher = writeExecutable(path.join(root, "测试 Codex.cmd"),
    '@echo off\r\nif "%~1"=="--version" (\r\n  echo codex-cli 0.0.0\r\n  exit /b 0\r\n)\r\nset "PATH="\r\n"node" --version\r\n');
  const client = new McpTestClient(isolatedServerEnv(root, { CODEX_BIN: launcher }));
  try {
    const run = await callTool(client, "codex_run", { cwd: root, task: "测试缺失 Node.js" });
    const failed = JSON.parse(run.result.content[0].text);
    assert.equal(failed.blocker.type, "missing_dependency", JSON.stringify(failed));
    assert.match(failed.blocker.detail, /启动脚本找不到 Node\.js/);
    assert.match(failed.blocker.auto_recovery_hint, /npm install -g @openai\/codex/);
  } finally {
    await client.close();
  }
  writeExecutable(launcher, '@echo off\r\nset "PATH="\r\n"node" --version\r\n');
  const { status, report } = selfTest(isolatedServerEnv(root, { CODEX_BIN: launcher }));
  assert.equal(status, 1);
  assert.match(report.codex_error, /启动脚本找不到 Node\.js/);
});

test("MCP 服务、可视化控制台、调度与堵塞恢复全流程", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bridge-v2-test-"));
  const dataDir = path.join(tmpDir, "data");
  const workDir = path.join(tmpDir, "work");
  const captureFile = path.join(tmpDir, "capture.json");
  fs.mkdirSync(workDir, { recursive: true });

  const mockBin = createMockCodex(tmpDir);
  const client = new McpTestClient({
    CODEX_BIN: mockBin,
    CODEX_BRIDGE_DATA_DIR: dataDir,
    CODEX_BRIDGE_MODEL: "gpt-6.2-sol",
    CODEX_BRIDGE_REASONING_EFFORT: "high",
    MOCK_CAPTURE_FILE: captureFile,
  });

  try {
    // 1. Initialize & capabilities (tools + resources)
    const init = await client.request("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    assert.equal(init.result.protocolVersion, "2025-03-26");
    assert.ok(init.result.capabilities.tools);
    assert.ok(init.result.capabilities.resources);
    client.notify("notifications/initialized", {});

    const ping = await client.request("ping", {});
    assert.deepEqual(ping.result, {});

    // 2. MCP App resources/list & resources/read
    const resList = await client.request("resources/list", {});
    assert.equal(resList.result.resources.length, 1);
    assert.equal(resList.result.resources[0].uri, "ui://codex-bridge/console.html");
    assert.equal(resList.result.resources[0].mimeType, "text/html;profile=mcp-app");

    const resRead = await client.request("resources/read", {
      uri: "ui://codex-bridge/console.html",
    });
    const htmlDoc = resRead.result.contents[0];
    assert.equal(htmlDoc.mimeType, "text/html;profile=mcp-app");
    assert.ok(htmlDoc.text.includes("<!doctype html>"));
    assert.ok(htmlDoc.text.includes("Codex Console"));
    assert.ok(htmlDoc.text.includes('class="modal-backdrop" data-modal-backdrop="true"'));
    assert.ok(!htmlDoc.text.includes('onclick="event.stopPropagation()"'));
    assert.ok(Buffer.byteLength(htmlDoc.text, "utf8") < 10 * 1024 * 1024);

    // 3. tools/list metadata verification (entrypoints & app-only visibility)
    const list = await client.request("tools/list", {});
    const byName = new Map(list.result.tools.map((t) => [t.name, t]));
    const consoleTool = byName.get("codex_console");
    assert.equal(consoleTool._meta.ui.resourceUri, "ui://codex-bridge/console.html");
    assert.deepEqual(
      consoleTool._meta["com.google.antigravity/ui"].entrypoints.map((e) => e.type),
      ["aux_pane", "global"]
    );
    assert.deepEqual(byName.get("app_get_dashboard")._meta.ui.visibility, ["app"]);
    assert.deepEqual(byName.get("app_get_task_detail")._meta.ui.visibility, ["app"]);

    // 4. codex_console works with empty {} arguments (entrypoint requirement)
    const consoleResp = await client.request("tools/call", {
      name: "codex_console",
      arguments: {},
    });
    assert.equal(consoleResp.result.isError, false);
    assert.equal(consoleResp.result.structuredContent.ok, true);
    assert.ok(Array.isArray(consoleResp.result.structuredContent.tasks));

    // 5. codex_run & codex_resume (verifies noise isolation, JSON receipt, session chain, cache hit)
    const runResp = await client.request("tools/call", {
      name: "codex_run",
      arguments: { cwd: workDir, task: "Implement feature X in src/demo.js" },
    });
    assert.equal(runResp.result.isError, false);
    const runData = JSON.parse(runResp.result.content[0].text);
    assert.equal(runData.ok, true);
    assert.equal(runData.status, "done");
    assert.equal(runData.session_id, "thread-shared-123");
    assert.ok(!runResp.result.content[0].text.includes("HUGE_NOISY_LOG_LINE"));

    const resumeResp = await client.request("tools/call", {
      name: "codex_resume",
      arguments: {
        cwd: workDir,
        session_id: runData.session_id,
        instruction: "Fix edge case in src/demo.js",
      },
    });
    assert.equal(resumeResp.result.isError, false);
    const resumeData = JSON.parse(resumeResp.result.content[0].text);
    assert.equal(resumeData.usage.cached_input_tokens, 850);

    // 6. codex_review
    const reviewResp = await client.request("tools/call", {
      name: "codex_review",
      arguments: { cwd: workDir },
    });
    const reviewData = JSON.parse(reviewResp.result.content[0].text);
    assert.equal(reviewData.review.verdict, "changes_requested");

    // 7. Blocker classification (rate_limit) + Antigravity auto-recovery via codex_mark_resolved
    const blockedResp = await client.request("tools/call", {
      name: "codex_run",
      arguments: { cwd: workDir, task: "RATE_LIMIT_TRIGGER" },
    });
    assert.equal(blockedResp.result.isError, true);
    const blockedData = JSON.parse(blockedResp.result.content[0].text);
    assert.equal(blockedData.status, "blocked");
    assert.equal(blockedData.blocker.type, "rate_limit");
    assert.ok(blockedData.blocker.detail.includes("限流"));
    assert.ok(blockedData.blocker.auto_recovery_hint.includes("并发"));

    const resolveResp = await client.request("tools/call", {
      name: "codex_mark_resolved",
      arguments: {
        task_id: blockedData.task_id,
        action: "antigravity_takeover",
        summary: "Applied fix directly in Antigravity after 429 congestion.",
        changed_files: ["src/demo.js"],
      },
    });
    assert.equal(resolveResp.result.isError, false);
    const resolveData = JSON.parse(resolveResp.result.content[0].text);
    assert.equal(resolveData.status, "resolved");

    // 8. Background dispatch + queue + cancel + scheduler settings
    const updResp = await client.request("tools/call", {
      name: "app_update_scheduler",
      arguments: { max_concurrency: 1, stall_timeout_seconds: 120 },
    });
    assert.equal(updResp.result.structuredContent.settings.max_concurrency, 1);

    const bg1 = await client.request("tools/call", {
      name: "codex_run",
      arguments: { cwd: workDir, task: "SLEEP_LONG job 1", background: true },
    });
    const bg2 = await client.request("tools/call", {
      name: "codex_run",
      arguments: { cwd: workDir, task: "SLEEP_LONG job 2", background: true },
    });
    const bg1Data = JSON.parse(bg1.result.content[0].text);
    const bg2Data = JSON.parse(bg2.result.content[0].text);
    assert.equal(bg1Data.status, "running");
    assert.equal(bg2Data.status, "queued");

    const statusResp = await client.request("tools/call", {
      name: "codex_status",
      arguments: {},
    });
    const statusData = JSON.parse(statusResp.result.content[0].text);
    assert.equal(statusData.scheduler.running_count, 1);
    assert.equal(statusData.scheduler.queued_count, 1);

    await client.request("tools/call", {
      name: "codex_cancel",
      arguments: { task_id: bg2Data.task_id, reason: "Test queue cancel" },
    });
    await client.request("tools/call", {
      name: "codex_cancel",
      arguments: { task_id: bg1Data.task_id, reason: "Test running cancel" },
    });

    // 9. Dashboard & Task Detail verification (cache %, recovery_history, session_chain, logs)
    // 3 completed runs: (200 + 850 + 200) / 3000 = 41.7% cache hit rate
    const dashResp = await client.request("tools/call", {
      name: "app_get_dashboard",
      arguments: {},
    });
    const dash = dashResp.result.structuredContent;
    assert.equal(dash.metrics.cache_hit_rate_pct, 41.7);
    assert.equal(dash.counts.resolved, 1);

    const detailResp = await client.request("tools/call", {
      name: "app_get_task_detail",
      arguments: { task_id: resumeData.task_id, log_filter: "events", tail_lines: 50 },
    });
    const detail = detailResp.result.structuredContent;
    assert.equal(detail.session_chain.length, 2);
    assert.ok(detail.log_tail.includes("HUGE_NOISY_LOG_LINE"));

    // 10. Path traversal check on codex_read_log
    const traversalResp = await client.request("tools/call", {
      name: "codex_read_log",
      arguments: { log_path: SERVER_PATH },
    });
    assert.equal(traversalResp.result.isError, true);
  } finally {
    await client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
