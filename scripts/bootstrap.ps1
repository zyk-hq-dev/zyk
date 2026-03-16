# Zyk Bootstrap — one command to go from zero to running
# Usage: .\scripts\bootstrap.ps1
# Requires: Docker Desktop, Node.js 20+, PowerShell 5+

$ErrorActionPreference = "Stop"

function Write-Step  { param($msg) Write-Host "  $msg" -ForegroundColor White }
function Write-Ok    { param($msg) Write-Host "  $([char]0x2713) $msg" -ForegroundColor Green }
function Write-Warn  { param($msg) Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Dim   { param($msg) Write-Host "  $msg" -ForegroundColor DarkGray }
function Write-Cmd   { param($msg) Write-Host "  $msg" -ForegroundColor Cyan }

Write-Host ""
Write-Host "  ⚡ Zyk Bootstrap" -ForegroundColor White -NoNewline
Write-Host "  — starts Hatchet, generates a token, configures Claude" -ForegroundColor DarkGray
Write-Host ""

# ── Detect docker compose ─────────────────────────────────────────────────────
$DC = $null
try { docker compose version | Out-Null; $DC = "docker compose" } catch {}
if (-not $DC) {
    try { docker-compose version | Out-Null; $DC = "docker-compose" } catch {}
}
if (-not $DC) {
    Write-Warn "Docker Compose not found."
    Write-Cmd  "Install Docker Desktop: https://docs.docker.com/get-docker/"
    exit 1
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir   = Split-Path -Parent $ScriptDir
$EnvFile   = Join-Path $RootDir ".env"
$McpDir    = Join-Path $RootDir "mcp-server"

Set-Location $RootDir

# ── 1. Check for existing valid token ─────────────────────────────────────────
$ExistingToken = ""
if (Test-Path $EnvFile) {
    $lines = Get-Content $EnvFile
    foreach ($line in $lines) {
        if ($line -match "^HATCHET_CLIENT_TOKEN=(.+)$") {
            $ExistingToken = $Matches[1].Trim().Trim('"').Trim("'")
            break
        }
    }
}

if ($ExistingToken -and $ExistingToken -ne "your-token-here") {
    Write-Ok "Token already in .env — skipping token generation"
    Write-Dim "(Delete HATCHET_CLIENT_TOKEN from .env and re-run to regenerate)"
    Write-Host ""
} else {
    # ── 2. Start Postgres + Hatchet ───────────────────────────────────────────
    Write-Step "Starting Postgres and Hatchet..."
    Invoke-Expression "$DC up postgres hatchet-engine -d"
    Write-Host ""

    # ── 3. Wait for Hatchet health ────────────────────────────────────────────
    Write-Host "  Waiting for Hatchet to be ready" -NoNewline -ForegroundColor DarkGray
    $Attempts = 0; $Max = 45
    while ($Attempts -lt $Max) {
        $ready = $false
        try {
            $result = Invoke-Expression "$DC exec hatchet-engine wget -qO- http://localhost:8080/api/ready" 2>&1
            if ($LASTEXITCODE -eq 0) { $ready = $true }
        } catch {}
        if ($ready) {
            Write-Host ""
            Write-Ok "Hatchet is ready"
            break
        }
        $Attempts++
        Write-Host "." -NoNewline -ForegroundColor DarkGray
        Start-Sleep -Seconds 2
    }
    Write-Host ""

    if ($Attempts -ge $Max) {
        Write-Warn "Hatchet not ready after 90s."
        Write-Cmd  "$DC logs hatchet-engine"
        exit 1
    }

    # ── 4. Generate API token via REST API ───────────────────────────────────
    # Uses the Hatchet REST API so the token matches the tenant you see in the UI.
    Write-Dim "Generating API token..."
    $GenerateScript = Join-Path $ScriptDir "generate-token.js"
    $Token = node $GenerateScript 2>&1
    # node writes errors to stderr which PowerShell captures in $Token when using 2>&1;
    # check that the output looks like a JWT (starts with "ey")
    if (-not $Token -or -not ($Token -match '^ey')) {
        Write-Warn "Token generation failed:"
        Write-Host $Token
        Write-Host ""
        Write-Dim  "Is Hatchet fully up? Check: $DC logs hatchet-engine"
        exit 1
    }

    Write-Ok "Token generated"

    # ── 6. Write .env ─────────────────────────────────────────────────────────
    if (-not (Test-Path $EnvFile)) {
        $Example = Join-Path $RootDir ".env.example"
        if (Test-Path $Example) {
            Copy-Item $Example $EnvFile
        } else {
            New-Item -ItemType File -Path $EnvFile | Out-Null
        }
    }

    $EnvContent = Get-Content $EnvFile -Raw
    if ($EnvContent -match "HATCHET_CLIENT_TOKEN=") {
        $EnvContent = $EnvContent -replace "(?m)^HATCHET_CLIENT_TOKEN=.*", "HATCHET_CLIENT_TOKEN=$Token"
        [System.IO.File]::WriteAllText($EnvFile, $EnvContent.TrimEnd() + "`n")
    } else {
        Add-Content $EnvFile "HATCHET_CLIENT_TOKEN=$Token"
    }

    Write-Ok "Token written to .env"
    Write-Host ""
}

# ── 7. Build MCP server if needed ─────────────────────────────────────────────
$ServerDist = Join-Path $McpDir "dist\index.js"
if (-not (Test-Path $ServerDist)) {
    Write-Step "Building MCP server..."
    Set-Location $McpDir
    npm install --silent
    npm run build --silent
    Set-Location $RootDir
    Write-Ok "MCP server built"
    Write-Host ""
}

# ── 8. Configure Claude ───────────────────────────────────────────────
Write-Step "Configuring Claude..."
Write-Host ""
$SetupScript = Join-Path $McpDir "setup.js"
node $SetupScript --yes

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Step "Useful links:"
Write-Cmd  "Zyk dashboard:  http://localhost:3100"
Write-Cmd  "Hatchet UI:     http://localhost:8888"
Write-Host ""
