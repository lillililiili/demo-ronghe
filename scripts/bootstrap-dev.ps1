[CmdletBinding()]
param(
    [switch]$SkipFrontendInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$frontendDir = Join-Path $repoRoot 'dongying-vue'
$composeFile = Join-Path $repoRoot 'deploy\compose.yml'
$mapDataCandidates = @(
    (Join-Path $repoRoot 'map-data\dongying-dev\manifest.json'),
    (Join-Path (Split-Path -Parent $repoRoot) 'map-data\dongying-dev\manifest.json')
)

function Assert-Command {
    param([Parameter(Mandatory)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found. See the repository setup guide."
    }
}

Assert-Command docker
Assert-Command java
Assert-Command node
Assert-Command npm

docker info *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'Docker Engine is not running. Start Docker Desktop and try again.'
}

Write-Host 'Starting the personal PostgreSQL/PostGIS database...'
docker compose -f $composeFile up -d --wait db
if ($LASTEXITCODE -ne 0) {
    throw 'The local database failed to start.'
}

if (-not $SkipFrontendInstall -and -not (Test-Path (Join-Path $frontendDir 'node_modules'))) {
    Write-Host 'Installing frontend dependencies...'
    Push-Location $frontendDir
    try {
        npm install
        if ($LASTEXITCODE -ne 0) {
            throw 'Frontend dependency installation failed.'
        }
    }
    finally {
        Pop-Location
    }
}

$mapManifest = $mapDataCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($mapManifest) {
    Write-Host "Offline map package detected: $(Split-Path -Parent (Split-Path -Parent $mapManifest))"
}
else {
    Write-Warning 'Offline map package was not found. Set MAP_DATA_DIR before starting Vite; see docs/offline-map-deployment.'
}

Write-Host ''
Write-Host 'Local development dependencies are ready. Run these commands in two PowerShell windows:'
Write-Host '  cd dongying-vue; npm run dev'
Write-Host "  cd server; .\mvnw.cmd spring-boot:run `"-Dspring-boot.run.profiles=local`""
Write-Host ''
Write-Host 'Frontend: http://127.0.0.1:5173/'
Write-Host 'Backend health: http://127.0.0.1:8080/actuator/health'
