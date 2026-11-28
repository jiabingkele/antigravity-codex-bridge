#Requires -Version 5.1
[CmdletBinding()]
param(
    [string]$InstallDir = (Join-Path $HOME ".gemini\config\plugins\codex-bridge"),
    [string]$Model = "gpt-6.2-sol",
    [string]$ReasoningEffort = "high",
    [switch]$StartDaemon
)

$ErrorActionPreference = "Stop"

Write-Host "==> Installing Antigravity Codex Bridge Plugin" -ForegroundColor Cyan

# 1. Check Node.js >= 18
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    throw "Node.js >= 18 is required but 'node' was not found in PATH. Install from https://nodejs.org/"
}
$nodeVerRaw = (& node -v).Trim()
$nodeMajor = [int]($nodeVerRaw.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 18) {
    throw "Node.js >= 18 is required, found $nodeVerRaw."
}
Write-Host "[OK] Node.js $nodeVerRaw" -ForegroundColor Green

# 2. Copy plugin files from repository root into Antigravity plugins directory
$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$TargetResolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)

if ($RepoRoot.Path.TrimEnd('\') -ieq $TargetResolved.TrimEnd('\')) {
    Write-Host "[OK] Already located in target plugin directory: $TargetResolved" -ForegroundColor Green
} else {
    $ParentDir = Split-Path -Parent $TargetResolved
    if (-not (Test-Path $ParentDir)) {
        New-Item -ItemType Directory -Path $ParentDir -Force | Out-Null
    }
    if (Test-Path $TargetResolved) {
        Write-Host "Updating existing installation in place at $TargetResolved ..." -ForegroundColor Yellow
    } else {
        New-Item -ItemType Directory -Path $TargetResolved -Force | Out-Null
    }

    $itemsToCopy = @(
        "plugin.json",
        "mcp_config.json",
        "README.md",
        "LICENSE",
        "assets",
        "rules",
        "schemas",
        "server",
        "skills"
    )
    foreach ($item in $itemsToCopy) {
        $src = Join-Path $RepoRoot.Path $item
        $dest = Join-Path $TargetResolved $item
        if (Test-Path $src) {
            if (Test-Path $src -PathType Container) {
                if (-not (Test-Path $dest)) {
                    New-Item -ItemType Directory -Path $dest -Force | Out-Null
                }
                Copy-Item -Path (Join-Path $src "*") -Destination $dest -Recurse -Force
            } else {
                Copy-Item -Path $src -Destination $dest -Force
            }
        }
    }
    $uiDistSrc = Join-Path $RepoRoot.Path "ui\dist"
    if (Test-Path $uiDistSrc) {
        $uiDistDest = Join-Path $TargetResolved "ui\dist"
        New-Item -ItemType Directory -Path $uiDistDest -Force | Out-Null
        Copy-Item -Path (Join-Path $uiDistSrc "*") -Destination $uiDistDest -Recurse -Force
    }
    Write-Host "[OK] Copied plugin files (including Codex Console UI) to $TargetResolved" -ForegroundColor Green
}

# 3. Apply custom default model / reasoning effort if requested
if ($Model -ne "gpt-6.2-sol" -or $ReasoningEffort -ne "high") {
    $mcpConfigPath = Join-Path $TargetResolved "mcp_config.json"
    $cfg = Get-Content $mcpConfigPath -Raw | ConvertFrom-Json
    $cfg.mcpServers.'codex-bridge'.env.CODEX_BRIDGE_MODEL = $Model
    $cfg.mcpServers.'codex-bridge'.env.CODEX_BRIDGE_REASONING_EFFORT = $ReasoningEffort
    $cfg | ConvertTo-Json -Depth 10 | Set-Content -Path $mcpConfigPath -Encoding UTF8
    Write-Host "[OK] Configured defaults: model=$Model, reasoning_effort=$ReasoningEffort" -ForegroundColor Green
}

# 4. Run self-test using the same CLI resolver as the MCP server
Write-Host "==> Running MCP server self-test..." -ForegroundColor Cyan
$serverScript = Join-Path $TargetResolved "server\codex-mcp-server.mjs"
$prevPref = $ErrorActionPreference
$prevEncoding = [Console]::OutputEncoding
try {
    $ErrorActionPreference = "Continue"
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $selfTestReport = & node $serverScript --self-test
    $selfTestExit = $LASTEXITCODE
} finally {
    [Console]::OutputEncoding = $prevEncoding
    $ErrorActionPreference = $prevPref
}
$selfTestReport | Write-Host
if ($selfTestExit -ne 0) {
    Write-Warning "Self-test failed. Check the report above for the detected CLI and error."
}

# 5. Optional: start local Codex daemon to reduce cold-start latency
if ($StartDaemon -and $selfTestExit -eq 0) {
    $codexBinary = ($selfTestReport -join "`n" | ConvertFrom-Json).codex_binary
    Write-Host "==> Starting Codex background app-server daemon..." -ForegroundColor Cyan
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & $codexBinary app-server daemon start 2>&1 | ForEach-Object { $_.ToString() } | Where-Object { $_ -notmatch "could not create PATH aliases" }
    $ErrorActionPreference = $prevPref
}

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host "Plugin path: $TargetResolved"
Write-Host "Next steps:"
Write-Host "  1. Sign in from Codex Desktop or run: codex login"
Write-Host "  2. (Optional speedup) Keep local daemon warm with -StartDaemon."
Write-Host "  3. Restart or start a new Antigravity conversation and check MCP Servers -> codex-bridge."
