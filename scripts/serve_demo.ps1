#Requires -Version 5.1
<#
.SYNOPSIS
    Serves the KidGuard repo root over HTTP on port 8765 so the demo pages and
    the parent dashboard are both reachable from the extension.
#>
[CmdletBinding()]
param(
    [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

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

function Write-DemoUrls {
    param([int]$PortNumber)
    $base = "http://127.0.0.1:$PortNumber"
    Write-Host ''
    Write-Host 'KidGuard demo URLs:' -ForegroundColor Cyan
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
}

$python = Get-PythonCommand
if (-not $python) {
    Write-Host 'ERROR: Python was not found on PATH (tried python, python3, py -3).' -ForegroundColor Red
    Write-Host 'Install Python 3 from https://www.python.org/downloads/ and try again.'
    exit 1
}

if (Test-PortInUse -PortNumber $Port) {
    Write-Host "ERROR: port $Port is already in use." -ForegroundColor Red
    Write-Host 'Another static server is probably already running. Either use it, or free the port:'
    Write-Host "  Get-NetTCPConnection -LocalPort $Port | Select-Object OwningProcess"
    Write-Host '  Stop-Process -Id <OwningProcess>'
    exit 1
}

Write-Host "Serving $RepoRoot on http://127.0.0.1:$Port" -ForegroundColor Green
Write-DemoUrls -PortNumber $Port
Write-Host 'Press Ctrl+C to stop.' -ForegroundColor DarkGray

$argList = @($python.Args) + @('-m', 'http.server', "$Port", '--bind', '127.0.0.1', '--directory', $RepoRoot)
& $python.Exe @argList
