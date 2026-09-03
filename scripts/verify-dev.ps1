[CmdletBinding()]
param()

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
