import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const SERVER_PATH = path.join(REPO_ROOT, "server", "codex-mcp-server.mjs");

function createMockCodex(tmpDir) {
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

  if (process.platform === "win32") {
    const cmdPath = path.join(tmpDir, "mock-codex.cmd");
    fs.writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "${mockJsPath}" %*\r\n`, "utf8");
    return cmdPath;
  } else {
    const shPath = path.join(tmpDir, "mock-codex.sh");
    fs.writeFileSync(shPath, `#!/usr/bin/env bash\nexec "${process.execPath}" "${mockJsPath}" "$@"\n`, "utf8");
    fs.chmodSync(shPath, 0o755);
    return shPath;
  }
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

test("MCP server + MCP App Console + scheduler + blocker auto-recovery lifecycle", async () => {
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
    assert.ok(blockedData.blocker.auto_recovery_hint.length > 10);

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
