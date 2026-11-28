import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const isWindows = process.platform === "win32";
const isBatch = (file) => isWindows && /\.(cmd|bat)$/i.test(file);
const codexName = isWindows ? "codex.exe" : "codex";

function absoluteDirs(dirs) {
  const paths = new Map();
  for (const value of dirs) {
    const dir = value?.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !path.isAbsolute(dir)) continue;
    const key = path.normalize(dir).replace(/[\\/]+$/, "");
    const normalized = isWindows ? key.toLowerCase() : key;
    if (!paths.has(normalized)) paths.set(normalized, dir);
  }
  return [...paths.values()];
}

function at(base, ...segments) {
  return base && path.join(base, ...segments);
}

export function buildCodexEnvironment(env = process.env, execPath = process.execPath, home = os.homedir()) {
  const childEnv = { ...env };
  const pathKey = Object.keys(env).find((key) => isWindows ? /^path$/i.test(key) : key === "PATH");
  if (isWindows) {
    for (const key of Object.keys(childEnv)) {
      if (/^path$/i.test(key)) delete childEnv[key];
    }
  }
  const nodeDir = path.dirname(execPath);
  const npmPrefix = env.NPM_CONFIG_PREFIX || env.npm_config_prefix;
  const dirs = isWindows
    ? [
        npmPrefix,
        at(env.APPDATA, "npm"),
        at(env.LOCALAPPDATA, "Microsoft", "WindowsApps"),
        at(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
        at(env.ProgramFiles, "WinGet", "Links"),
        at(env.ProgramFiles, "nodejs"),
        at(env.ProgramW6432, "nodejs"),
        at(env["ProgramFiles(x86)"], "nodejs"),
        env.PNPM_HOME,
      ]
    : [
        at(npmPrefix, "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/home/linuxbrew/.linuxbrew/bin",
        path.join(home, ".local", "bin"),
        path.join(home, ".npm-global", "bin"),
        env.PNPM_HOME,
      ];
  childEnv.PATH = absoluteDirs([nodeDir, ...(env[pathKey]?.split(path.delimiter) || []), ...dirs]).join(path.delimiter);
  return childEnv;
}

function isExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (!isWindows) fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function* npmNativeBinaries(dir, launcher) {
  const arch = process.arch;
  const cpu = { x64: "x86_64", arm64: "aarch64" }[arch];
  const abi = { win32: "pc-windows-msvc", darwin: "apple-darwin", linux: "unknown-linux-musl" }[process.platform];
  if (!cpu || !abi) return;

  const roots = [
    path.join(dir, "node_modules", "@openai", "codex"),
    path.join(dir, "..", "lib", "node_modules", "@openai", "codex"),
  ];
  if (launcher) {
    try {
      const entry = fs.realpathSync(launcher);
      if (/[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/i.test(entry)) {
        roots.unshift(path.dirname(path.dirname(entry)));
      }
    } catch {
      // A broken npm symlink does not prevent trying the other installations.
    }
  }
  const platformPackage = `codex-${process.platform}-${arch}`;
  for (const root of absoluteDirs(roots)) {
    for (const pkg of [
      path.join(root, "node_modules", "@openai", platformPackage),
      path.join(root, "..", platformPackage),
      root,
    ]) {
      const target = path.join(pkg, "vendor", `${cpu}-${abi}`);
      yield path.join(target, "bin", codexName);
      yield path.join(target, "codex", codexName);
    }
  }
}

export function* localCodexCandidates(env) {
  const seen = new Set();
  for (const dir of absoluteDirs(env.PATH.split(path.delimiter))) {
    const native = path.join(dir, codexName);
    const launchers = isWindows ? ["codex.cmd", "codex.bat"].map((name) => path.join(dir, name)) : [native];
    const candidates = [
      ...(isWindows ? [native] : []),
      ...npmNativeBinaries(dir, isWindows ? null : native),
      ...launchers,
    ];
    for (const candidate of candidates) {
      const key = isWindows ? candidate.toLowerCase() : candidate;
      if (seen.has(key) || !isExecutable(candidate)) continue;
      seen.add(key);
      yield candidate;
    }
  }
}

const storePackage = /^OpenAI\.Codex_(\d+\.\d+\.\d+\.\d+)_([^_]+)__[^_]+$/i;

export function storeCodexCandidates(packageDirs) {
  // AppX versions have four numeric components. Skip resource-only and other-CPU packages.
  const architectures = process.arch === "arm64" ? ["arm64", "x64", "neutral"] : [process.arch, "neutral"];
  const packages = [];
  for (const dir of absoluteDirs(packageDirs)) {
    const match = path.basename(dir).match(storePackage);
    if (!match) continue;
    const architectureRank = architectures.indexOf(match[2].toLowerCase());
    if (architectureRank < 0) continue;
    const binary = path.join(dir, "app", "resources", "codex.exe");
    if (isExecutable(binary)) packages.push({ binary, version: match[1].split(".").map(Number), architectureRank });
  }
  packages.sort((a, b) => {
    const index = a.version.findIndex((part, i) => part !== b.version[i]);
    return index < 0 ? a.architectureRank - b.architectureRank : b.version[index] - a.version[index];
  });
  return packages.map(({ binary }) => binary);
}

export async function* findStoreCodex(env, timeout) {
  // WindowsApps is normally not listable. Get-AppxPackage can resolve the current user's package and custom volumes.
  const powershell = path.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let registered = [];
  try {
    const { stdout } = await execFileAsync(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-AppxPackage -Name OpenAI.Codex | ForEach-Object { $_.InstallLocation }",
    ], { env, encoding: "utf8", timeout: Math.min(timeout, 2500), windowsHide: true });
    registered = storeCodexCandidates(stdout.split(/\r?\n/));
  } catch {
    // Fall back to filesystem discovery if the AppX query cannot run.
  }
  yield* registered;

  const roots = absoluteDirs([env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]]);
  const packageDirs = roots.flatMap((root) => {
    const windowsApps = path.join(root, "WindowsApps");
    try {
      return fs.readdirSync(windowsApps).filter((name) => storePackage.test(name))
        .map((name) => path.join(windowsApps, name));
    } catch {
      return [];
    }
  });
  for (const binary of storeCodexCandidates(packageDirs)) {
    if (!registered.includes(binary)) yield binary;
  }
}

function quoteBatchArg(arg) {
  if (/[\r\n]/.test(arg)) throw new TypeError("Windows 批处理启动参数不能包含换行。");
  // Encode for Windows argv first, then escape cmd metacharacters, including expansion markers.
  return `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/, "$&$&")}"`
    .replace(/([()%!^"<>&| ])/g, "^$1");
}

export function codexInvocation(binary, args, env) {
  if (!isBatch(binary)) return { file: binary, args, options: { env, windowsHide: true } };
  const shell = env.ComSpec || env.COMSPEC || path.join(env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  const command = [binary, ...args].map(quoteBatchArg).join(" ");
  return {
    file: shell,
    args: ["/d", "/v:off", "/s", "/c", `"${command}"`],
    options: { env, windowsHide: true, windowsVerbatimArguments: true },
  };
}

const missingNode = /(?:^|\r?\n)\s*['"]+node(?:\.exe)?['"]+\s+(?:is not recognized\b|[^\r\n\x00-\x7f])/i;

export function diagnoseCodexLaunch(binary, { error, stderr = "", cwd, missing = false } = {}) {
  if (error?.code === "ENOENT" && cwd && !fs.existsSync(cwd)) {
    return {
      type: "execution_error",
      detail: `任务工作目录已不存在（${cwd}）。`,
      hint: "确认工作目录路径后重新派发任务。",
    };
  }
  if (isBatch(binary) && missingNode.test(stderr)) {
    return {
      type: "missing_dependency",
      detail: `Codex CLI 启动脚本找不到 Node.js（${binary}）。`,
      hint: "确认已安装 Node.js，或运行 `npm install -g @openai/codex@latest` 修复 CLI 安装。完成后刷新控制台并重新派发任务。",
    };
  }
  if (missing || error?.code === "ENOENT") {
    return {
      type: "missing_dependency",
      detail: binary ? `无法启动 Codex CLI（${binary}），可执行文件或启动程序不存在。` : "未找到可启动的 Codex CLI。",
      hint: "运行 `npm install -g @openai/codex` 安装 CLI，或在 Windows 安装并打开 Codex Desktop。若设置了 CODEX_BIN，请检查路径。完成后刷新控制台并重新派发任务。",
    };
  }
  if (/Missing optional dependency @openai\/codex-/i.test(stderr)) {
    return {
      type: "missing_dependency",
      detail: `Codex CLI 缺少当前平台的原生程序（${binary}）。`,
      hint: "运行 `npm install -g @openai/codex@latest` 重新安装包含平台组件的 CLI，完成后刷新控制台并重新派发任务。",
    };
  }
  return null;
}

async function probeCodex() {
  const env = buildCodexEnvironment();
  const configured = env.CODEX_BIN?.trim();
  const override = configured && (configured.includes(path.sep) || (isWindows && configured.includes("/")))
    ? path.resolve(configured) : configured;
  if (override && path.isAbsolute(override) && !isExecutable(override)) {
    return { binary: override, blocker: diagnoseCodexLaunch(override, { missing: true }) };
  }
  const deadline = performance.now() + 5000;
  async function* candidates() {
    if (override) {
      if (!path.isAbsolute(override)) {
        const names = isWindows && !/\.(exe|com|cmd|bat)$/i.test(override)
          ? [`${override}.exe`, `${override}.com`, `${override}.cmd`, `${override}.bat`] : [override];
        for (const dir of absoluteDirs(env.PATH.split(path.delimiter))) {
          for (const name of names) {
            const binary = path.join(dir, name);
            if (isExecutable(binary)) {
              yield binary;
              return;
            }
          }
        }
      }
      yield override;
      return;
    }
    yield* localCodexCandidates(env);
    const remaining = Math.floor(deadline - performance.now());
    if (isWindows && remaining > 0) yield* findStoreCodex(env, remaining);
  }

  let failure;
  for await (const binary of candidates()) {
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) break;
    try {
      const { file, args, options } = codexInvocation(binary, ["--version"], env);
      const { stdout, stderr } = await execFileAsync(file, args, {
        ...options, encoding: "utf8", timeout: Math.min(remaining, 1500), maxBuffer: 128 * 1024,
      });
      const version = `${stdout}\n${stderr}`.split(/\r?\n/).map((line) => line.trim())
        .find((line) => /^codex-cli\s+\S/i.test(line));
      if (version) return { binary, env, version };
      failure ??= { binary, error: "版本探测未返回 codex-cli 版本号。" };
    } catch (error) {
      const blocker = diagnoseCodexLaunch(binary, { error, stderr: error.stderr });
      const detail = error.killed ? "版本探测超时。" : (error.stderr?.trim() || error.message);
      if (!failure || (blocker && !failure.blocker)) failure = { binary, error: detail, blocker };
    }
  }
  return failure || { binary: override || "codex", blocker: diagnoseCodexLaunch(override, { missing: true }) };
}

let cachedProbe;

export async function getCodexCli({ retryFailure = false } = {}) {
  if (cachedProbe) {
    const { pending, result, expires } = cachedProbe;
    if (pending) return pending;
    if (performance.now() < expires && (result.version
      ? !path.isAbsolute(result.binary) || isExecutable(result.binary)
      : !retryFailure)) return result;
  }
  const entry = { pending: probeCodex() };
  cachedProbe = entry;
  entry.result = await entry.pending;
  entry.pending = null;
  entry.expires = performance.now() + (entry.result.version ? 60_000 : 2500);
  return entry.result;
}

export function invalidateCodexCli(result) {
  if (cachedProbe?.result === result) cachedProbe = null;
}
