#Requires -Version 5.1
<#
.SYNOPSIS
    One-command KidGuard demo: static server on 8765 (demo pages + parent
    dashboard) plus the FastAPI backend on 8000 when it exists.
#>
[CmdletBinding()]
param(
    [int]$StaticPort = 8765,
    [int]$ApiPort = 8000
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Started = New-Object System.Collections.ArrayList

function Get-PythonCommand {
    foreach ($candidate in @(
        @{ Exe = 'python'; Args = @() },
        @{ Exe = 'python3'; Args = @() },
        @{ Exe = 'py';      Args = @('-3') }
    )) {
        $cmd = Get-Command $candidate.Exe -ErrorAction SilentlyContinue
        if ($cmd) { return $candidate }
    }
    return $null
}

function Test-PortInUse {
    param([int]$PortNumber)
    $listener = $null
    try {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $PortNumber)
        $listener.Start()
        return $false
    } catch {
        return $true
    } finally {
        if ($listener) { try { $listener.Stop() } catch { } }
    }
}

function Stop-StartedProcesses {
    foreach ($proc in $Started) {
        try {
            if ($proc -and -not $proc.HasExited) {
                Write-Host "Stopping PID $($proc.Id)..." -ForegroundColor DarkGray
                Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            }
        } catch { }
    }
    $Started.Clear()
}

$python = Get-PythonCommand
if (-not $python) {
    Write-Host 'ERROR: Python was not found on PATH (tried python, python3, py -3).' -ForegroundColor Red
    exit 1
}

Write-Host ''
Write-Host '=== KidGuard demo ===' -ForegroundColor Cyan
Write-Host "Repo root: $RepoRoot"

try {
    # --- static server -----------------------------------------------------
    if (Test-PortInUse -PortNumber $StaticPort) {
        Write-Host "NOTE: port $StaticPort is already in use - assuming a static server is already running." -ForegroundColor Yellow
    } else {
        $staticArgs = @($python.Args) + @('-m', 'http.server', "$StaticPort", '--bind', '127.0.0.1', '--directory', $RepoRoot)
        $staticProc = Start-Process -FilePath $python.Exe -ArgumentList $staticArgs -WorkingDirectory $RepoRoot -PassThru -NoNewWindow
        [void]$Started.Add($staticProc)
        Write-Host "Static server started on http://127.0.0.1:$StaticPort (PID $($staticProc.Id))" -ForegroundColor Green
    }

    # --- backend -----------------------------------------------------------
    $backendMain = Join-Path $RepoRoot 'backend\main.py'
    if (Test-Path $backendMain) {
        if (Test-PortInUse -PortNumber $ApiPort) {
            Write-Host "NOTE: port $ApiPort is already in use - assuming the backend is already running." -ForegroundColor Yellow
        } else {
            $apiArgs = @($python.Args) + @('-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', "$ApiPort", '--reload')
            $apiProc = Start-Process -FilePath $python.Exe -ArgumentList $apiArgs -WorkingDirectory $RepoRoot -PassThru -NoNewWindow
            [void]$Started.Add($apiProc)
            Write-Host "Backend starting on http://127.0.0.1:$ApiPort (PID $($apiProc.Id))" -ForegroundColor Green
        }
    } else {
        Write-Host 'backend/main.py not found - running in extension MOCK mode' -ForegroundColor Yellow
    }

    # --- what to open ------------------------------------------------------
    $base = "http://127.0.0.1:$StaticPort"
    Write-Host ''
    Write-Host 'Demo URLs:' -ForegroundColor Cyan
    foreach ($path in @(
        '/demo_sites/index.html',
        '/demo_sites/ok_school.html',
        '/demo_sites/clickbait.html',
        '/demo_sites/phishing.html',
        '/demo_sites/classroom.html',
        '/frontend/parent.html'
    )) {
        Write-Host "  $base$path"
    }

    Write-Host ''
    Write-Host 'Load the Chrome extension:' -ForegroundColor Cyan
    Write-Host '  1. Open chrome://extensions'
    Write-Host '  2. Turn on "Developer mode" (top right)'
    Write-Host '  3. Click "Load unpacked"'
    Write-Host "  4. Select the folder: $(Join-Path $RepoRoot 'extension')"
    Write-Host ''
    Write-Host 'Press Ctrl+C to stop everything this script started.' -ForegroundColor DarkGray

    while ($true) {
        Start-Sleep -Seconds 1
        foreach ($proc in @($Started)) {
            if ($proc -and $proc.HasExited) {
                Write-Host "Process $($proc.Id) exited with code $($proc.ExitCode)." -ForegroundColor Yellow
                $Started.Remove($proc)
            }
        }
        if ($Started.Count -eq 0) {
            Write-Host 'Nothing left running that this script started. Exiting.' -ForegroundColor Yellow
            break
        }
    }
} finally {
    Write-Host ''
    Write-Host 'Cleaning up...' -ForegroundColor DarkGray
    Stop-StartedProcesses
}
