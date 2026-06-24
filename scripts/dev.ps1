# Developer pipeline on Windows (PowerShell). Prefer: lai dev
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$NoCache = $false
foreach ($arg in $args) {
    if ($arg -eq "--no-cache" -or $arg -eq "--force") { $NoCache = $true }
}

if ((Test-Path "$Root\.git") -and (Test-Path "$Root\backend")) {
    python -c @"
from pathlib import Path
import sys
sys.path.insert(0, r'$Root')
from lai.compose_build import ensure_developer_build_env
if ensure_developer_build_env(Path(r'$Root')):
    print('Updated .env: local :local image tags for developer builds.')
"@ 2>$null
}

Write-Host "==> Ordered build via lai build (ML runtimes first)"
if ($NoCache) {
    lai build --no-cache
} else {
    lai build
}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> Start stack"
docker compose up -d @args
