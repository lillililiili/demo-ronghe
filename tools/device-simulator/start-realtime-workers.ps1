param([string]$Proxy = 'http://127.0.0.1:8766')
$ErrorActionPreference = 'Stop'
$endpoint = [Uri]$Proxy
if ($endpoint.Scheme -ne 'http' -or $endpoint.Host -notin @('localhost', '127.0.0.1') -or $endpoint.UserInfo) {
    throw 'Only a local simulator HTTP endpoint is supported.'
}
# The simulator owns both transports. Configure it and log in through its UI first.
$result = Invoke-RestMethod -Uri ($Proxy.TrimEnd('/') + '/api/realtime/control') -Method Post `
    -ContentType 'application/json' -Body '{"action":"start"}' -TimeoutSec 60
Write-Host "Realtime receiver state: $($result.state)"
Write-Host "TCP listening: $($result.countermeasure.listening)"
Write-Host 'Start the scenario in the simulator to publish observations. Stop all through the simulator UI.'
