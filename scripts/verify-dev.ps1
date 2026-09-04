[CmdletBinding()]
param(
    [string]$SeedAccount = 'admin1',
    [string]$SeedPassword = $(if ($env:APP_DEV_SEED_PASSWORD) { $env:APP_DEV_SEED_PASSWORD } else { 'changeme' })
)

$ErrorActionPreference = 'Stop'

function Test-Endpoint {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$Uri
    )

    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 5
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) {
            Write-Host "[OK] $Name - $Uri"
            return $true
        }
    }
    catch {
        Write-Host "[FAIL] $Name - $Uri - $($_.Exception.Message)"
        return $false
    }

    Write-Host "[FAIL] $Name - $Uri"
    return $false
}

$frontendOk = Test-Endpoint -Name 'frontend' -Uri 'http://127.0.0.1:5173/'
$backendOk = Test-Endpoint -Name 'backend' -Uri 'http://127.0.0.1:8080/actuator/health'

if (-not ($frontendOk -and $backendOk)) {
    exit 1
}

try {
    $loginBody = @{ account = $SeedAccount; password = $SeedPassword } | ConvertTo-Json -Compress
    $login = Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:8080/api/v1/auth/login' -ContentType 'application/json' -Body $loginBody -TimeoutSec 8
    if (-not $login.ok -or -not $login.data.session_id) { throw 'login response did not contain a session_id' }
    $headers = @{ Authorization = "Bearer $($login.data.session_id)" }
    $me = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/api/v1/auth/me' -Headers $headers -TimeoutSec 8
    if (-not $me.ok -or $me.data.account -ne $SeedAccount) { throw 'backend /auth/me did not return the expected account' }
    $proxiedMe = Invoke-RestMethod -Uri 'http://127.0.0.1:5173/api/v1/auth/me' -Headers $headers -TimeoutSec 8
    if (-not $proxiedMe.ok -or $proxiedMe.data.account -ne $SeedAccount) { throw 'Vite /api proxy did not return the expected account' }
    Write-Host "[OK] auth session and Vite API proxy - $SeedAccount"
}
catch {
    Write-Host "[FAIL] auth session or Vite API proxy - $($_.Exception.Message)"
    exit 1
}
