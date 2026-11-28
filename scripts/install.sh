#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOME}/.gemini/config/plugins/codex-bridge"
MODEL="gpt-6.2-sol"
REASONING_EFFORT="high"
START_DAEMON=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --model)
      MODEL="$2"
      shift 2
      ;;
    --reasoning-effort)
      REASONING_EFFORT="$2"
      shift 2
      ;;
    --start-daemon)
      START_DAEMON=1
      shift
      ;;
    -h|--help)
      echo "Usage: ./scripts/install.sh [--install-dir DIR] [--model MODEL] [--reasoning-effort low|medium|high|xhigh] [--start-daemon]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

echo "==> Installing Antigravity Codex Bridge Plugin"

# 1. Check Node.js >= 18
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js >= 18 is required but 'node' was not found in PATH." >&2
  exit 1
fi
NODE_VER="$(node -v)"
NODE_MAJOR="${NODE_VER#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if [[ "${NODE_MAJOR}" -lt 18 ]]; then
  echo "[ERROR] Node.js >= 18 is required, found ${NODE_VER}." >&2
  exit 1
fi
echo "[OK] Node.js ${NODE_VER}"

# 2. Copy plugin files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

mkdir -p "$(dirname "${INSTALL_DIR}")"
TARGET_ABS="$(cd "$(dirname "${INSTALL_DIR}")" && pwd)/$(basename "${INSTALL_DIR}")"

if [[ "${REPO_ROOT}" == "${TARGET_ABS}" ]]; then
  echo "[OK] Already located in target plugin directory: ${TARGET_ABS}"
else
  rm -rf "${TARGET_ABS}"
  mkdir -p "${TARGET_ABS}"
  for item in plugin.json mcp_config.json README.md LICENSE assets rules schemas server skills; do
    if [[ -e "${REPO_ROOT}/${item}" ]]; then
      cp -R "${REPO_ROOT}/${item}" "${TARGET_ABS}/${item}"
    fi
  done
  if [[ -d "${REPO_ROOT}/ui/dist" ]]; then
    mkdir -p "${TARGET_ABS}/ui/dist"
    cp -R "${REPO_ROOT}/ui/dist/." "${TARGET_ABS}/ui/dist/"
  fi
  chmod +x "${TARGET_ABS}/server/codex-mcp-server.mjs"
  echo "[OK] Copied plugin files (including Codex Console UI) to ${TARGET_ABS}"
fi

# 3. Apply custom defaults if overridden
if [[ "${MODEL}" != "gpt-6.2-sol" || "${REASONING_EFFORT}" != "high" ]]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
    cfg.mcpServers["codex-bridge"].env.CODEX_BRIDGE_MODEL = process.argv[2];
    cfg.mcpServers["codex-bridge"].env.CODEX_BRIDGE_REASONING_EFFORT = process.argv[3];
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  ' "${TARGET_ABS}/mcp_config.json" "${MODEL}" "${REASONING_EFFORT}"
  echo "[OK] Configured defaults: model=${MODEL}, reasoning_effort=${REASONING_EFFORT}"
fi

# 4. Run self-test using the same CLI resolver as the MCP server
echo "==> Running MCP server self-test..."
SELF_TEST_EXIT=0
SELF_TEST_REPORT="$(node "${TARGET_ABS}/server/codex-mcp-server.mjs" --self-test)" || SELF_TEST_EXIT=$?
printf '%s\n' "${SELF_TEST_REPORT}"

# 5. Optional daemon start
if [[ "${START_DAEMON}" -eq 1 && "${SELF_TEST_EXIT}" -eq 0 ]]; then
  CODEX_BINARY="$(node -p 'JSON.parse(process.argv[1]).codex_binary' "${SELF_TEST_REPORT}")"
  echo "==> Starting Codex background app-server daemon..."
  "${CODEX_BINARY}" app-server daemon start || true
fi

echo ""
echo "Installation complete!"
echo "Plugin path: ${TARGET_ABS}"
echo "Next steps:"
echo "  1. Ensure Codex is signed in: codex login"
echo "  2. (Optional speedup) Keep local daemon warm: codex app-server daemon start"
echo "  3. Start a new Antigravity conversation and verify MCP Servers -> codex-bridge."
