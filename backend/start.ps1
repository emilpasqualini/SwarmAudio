param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Arguments
)

# Windows 11 equivalent of start.sh. Run from PowerShell with: .\start.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$dev = $false
$open = $true
$vision = $true
$visionOnly = $false
$visionArguments = [System.Collections.Generic.List[string]]::new()
$index = 0

while ($index -lt $Arguments.Count) {
    $argument = $Arguments[$index]
    switch -Regex ($argument) {
        '^--sim$' {
            if ($index + 1 -ge $Arguments.Count) { throw '--sim needs a device count' }
            $env:HIVE_SIMULATE = $Arguments[++$index]
        }
        '^--sim=(.+)$' { $env:HIVE_SIMULATE = $Matches[1] }
        '^--dev$' { $dev = $true }
        '^--no-open$' { $open = $false }
        '^--no-vision$' { $vision = $false }
        '^--vision$' {
            $visionOnly = $true
            $visionArguments.AddRange($Arguments[($index + 1)..($Arguments.Count - 1)])
            break
        }
        '^-h$|^--help$' {
            @'
Usage: .\start.ps1 [options]

  .\start.ps1                 start the server
  .\start.ps1 --sim 3         start with three fake phones
  .\start.ps1 --dev            rebuild the phone app on every save
  .\start.ps1 --no-open        do not open the dashboard
  .\start.ps1 --no-vision      do not start the camera process
  .\start.ps1 --vision [args]  run the camera only; args go to hive_vision.py
  .\start.ps1 --help

Ports use HIVE_HTTPS_PORT (8443) and HIVE_HTTP_PORT (8080).
'@
            exit 0
        }
        default { throw "unknown option: $argument (try --help)" }
    }
    if ($argument -eq '--vision') { break }
    $index++
}

function Get-CommandPath([string]$name) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($null -eq $command) { return $null }
    return $command.Source
}

function Test-PortInUse([int]$port) {
    try {
        return $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1)
    } catch {
        return $false
    }
}

function Initialize-Vision {
    $python = Get-CommandPath 'python'
    if ($null -eq $python) { throw 'Python is not installed. Install Python 3.10 or newer.' }
    $visionDirectory = Join-Path $PSScriptRoot 'vision'
    $venvPython = Join-Path $visionDirectory '.venv\Scripts\python.exe'
    if (-not (Test-Path $venvPython)) {
        Write-Host 'Creating the Python camera environment'
        & $python -m venv (Join-Path $visionDirectory '.venv')
    }
    $installedMarker = Join-Path $visionDirectory '.venv\.installed'
    $requirements = Join-Path $visionDirectory 'requirements.txt'
    if (-not (Test-Path $installedMarker) -or (Get-Item $requirements).LastWriteTime -gt (Get-Item $installedMarker).LastWriteTime) {
        Write-Host 'Installing camera dependencies'
        & $venvPython -m pip install --quiet --upgrade pip
        & $venvPython -m pip install --quiet -r $requirements
        New-Item -ItemType File -Force $installedMarker | Out-Null
    }
    & $venvPython -c 'import numpy, cv2, torch, ultralytics, websockets'
    return @($venvPython, (Join-Path $visionDirectory 'hive_vision.py'))
}

$node = Get-CommandPath 'node'
if ($null -eq $node) { throw 'Node.js is not installed. Install Node.js 20 or newer, then reopen PowerShell.' }
$nodeMajor = [int](& $node -p 'process.versions.node.split(".")[0]')
if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is needed; found $(& $node --version)." }

$npm = Get-CommandPath 'npm'
if ($null -eq $npm) { throw 'npm was not found. Reinstall Node.js or reopen PowerShell.' }

$packageLockMarker = Join-Path $PSScriptRoot 'node_modules\.package-lock.json'
$needsInstall = -not (Test-Path 'node_modules') -or
    -not (Test-Path $packageLockMarker) -or
    (Get-Item 'package-lock.json').LastWriteTime -gt (Get-Item $packageLockMarker).LastWriteTime
if ($needsInstall) {
    Write-Host 'Installing dependencies'
    & $npm install --no-audit --no-fund
}

$httpsPort = if ($env:HIVE_HTTPS_PORT) { [int]$env:HIVE_HTTPS_PORT } else { 8443 }
$httpPort = if ($env:HIVE_HTTP_PORT) { [int]$env:HIVE_HTTP_PORT } else { 8080 }
foreach ($port in @($httpsPort, $httpPort)) {
    if (Test-PortInUse $port) { throw "Port $port is already in use. Stop the process using it or choose another port." }
}

if (-not $dev) {
    Write-Host 'Building the phone app'
    & $npm exec -- vite build --logLevel warn
}

$visionProcess = $null
$openJob = $null
try {
    if ($visionOnly) {
        $visionCommand = Initialize-Vision
        & $visionCommand[0] $visionCommand[1] @visionArguments
        exit $LASTEXITCODE
    }

    if ($vision) {
        $visionCommand = Initialize-Vision
        $visionProcess = Start-Process -FilePath $visionCommand[0] -ArgumentList @($visionCommand[1]) -WorkingDirectory (Join-Path $PSScriptRoot 'vision') -NoNewWindow -PassThru
    }

    if ($open) {
        $openJob = Start-Job -ArgumentList $httpPort -ScriptBlock {
            param([int]$port)
            for ($attempt = 0; $attempt -lt 40; $attempt++) {
                try {
                    Invoke-WebRequest "http://localhost:$port/api/health" -UseBasicParsing -TimeoutSec 1 | Out-Null
                    Start-Process "http://localhost:$port/monitor"
                    break
                } catch {
                    Start-Sleep -Milliseconds 250
                }
            }
        }
    }

    if ($dev) {
        & $npm run dev
    } else {
        & $npm exec -- tsx server/index.ts
    }
} finally {
    if ($null -ne $visionProcess -and -not $visionProcess.HasExited) { Stop-Process -Id $visionProcess.Id -Force }
    if ($null -ne $openJob) { Stop-Job $openJob -ErrorAction SilentlyContinue; Remove-Job $openJob -Force -ErrorAction SilentlyContinue }
}