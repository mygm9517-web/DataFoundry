param([ValidateSet('start', 'stop', 'status', 'logs')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot 'storage\local-runtime'
$pidFile = Join-Path $runtimeDir 'stack.pid'
$stdoutFile = Join-Path $runtimeDir 'stdout.log'
$stderrFile = Join-Path $runtimeDir 'stderr.log'

function Get-ManagedProcess {
    if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
    $managedId = [int](Get-Content -LiteralPath $pidFile -Raw)
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId = $managedId" -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.Name -eq 'node.exe' -and $candidate.CommandLine.Contains((Join-Path $PSScriptRoot 'start.mjs'))) { return $candidate }
    return $null
}

switch ($Action) {
    'start' {
        $running = Get-ManagedProcess
        if ($running) { Write-Output "Already running. PID=$($running.ProcessId)"; break }
        foreach ($port in @(3000, 8787)) {
            if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw "Port $port is occupied. Update the runtime configuration before starting." }
        }
        if (-not (Test-Path (Join-Path $projectRoot 'apps\web\.next\BUILD_ID'))) { throw 'Run npm run build and npm run build:web first.' }
        [void](New-Item -ItemType Directory -Path $runtimeDir -Force)
        $nodePath = (Get-Command node.exe).Source
        $process = Start-Process -FilePath $nodePath -ArgumentList @('"' + (Join-Path $PSScriptRoot 'start.mjs') + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile -PassThru
        [System.IO.File]::WriteAllText($pidFile, [string]$process.Id)
        Write-Output "Started DataFoundry. PID=$($process.Id). Web: http://127.0.0.1:3000/login"
    }
    'stop' {
        $running = Get-ManagedProcess
        if ($running) { & taskkill.exe /PID $running.ProcessId /T /F } else { Write-Output 'No managed process is running.' }
    }
    'status' {
        $running = Get-ManagedProcess
        Write-Output "Managed process running: $([bool]$running)"
        foreach ($url in @('http://127.0.0.1:8787/healthz', 'http://127.0.0.1:8787/ready', 'http://127.0.0.1:3000/login')) {
            try { $response = Invoke-WebRequest -Uri $url -TimeoutSec 5 -UseBasicParsing; Write-Output "$url -> HTTP $($response.StatusCode)" }
            catch { Write-Output "$url -> unavailable" }
        }
    }
    'logs' {
        if (Test-Path $stdoutFile) { Get-Content -LiteralPath $stdoutFile -Tail 50 }
        if (Test-Path $stderrFile) { Get-Content -LiteralPath $stderrFile -Tail 30 }
    }
}
