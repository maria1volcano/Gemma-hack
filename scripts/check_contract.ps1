#Requires -Version 5.1
<#
.SYNOPSIS
    Verifies that teammate A's backend speaks exactly the contract the KidGuard
    Chrome extension consumes. The backend is treated as a black box: this
    script only sends HTTP and reads the answers.

.DESCRIPTION
    Checks, in order:
      1. is anything listening on the backend host/port at all
      2. POST /decide with the four demo-page fixtures in scripts/fixtures/
         -> kid_message present, tool_calls is a list, every tool name known,
            every tool's args carry the fields the extension actually reads
      3. POST /coach -> reply + tool_calls
      4. GET /events -> JSON the parent dashboard can render
      5. CORS: GET /events with Origin http://127.0.0.1:8765 must come back with
         Access-Control-Allow-Origin, otherwise frontend/parent.html silently
         shows nothing (add FastAPI's CORSMiddleware).

    FAIL  = the extension breaks. Teammate A must fix it.
    WARN  = the extension survives (its normalizer is forgiving) but the shape
            is off-contract, or the classification is not the demo one.

.PARAMETER Strict
    Promote classification warnings (wrong tool for a page) to failures.

.EXAMPLE
    .\scripts\check_contract.ps1
    .\scripts\check_contract.ps1 -Strict -TimeoutSec 90

.NOTES
    Exit codes: 0 = all checks passed, 1 = contract failure,
                2 = backend not running, 3 = script/fixture problem.
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://127.0.0.1:8000',
    [string]$Origin = 'http://127.0.0.1:8765',
    [int]$TimeoutSec = 60,
    [string]$FixtureDir,
    [switch]$Strict
)

$ErrorActionPreference = 'Stop'

if (-not $FixtureDir) { $FixtureDir = Join-Path $PSScriptRoot 'fixtures' }
$BaseUrl = $BaseUrl.TrimEnd('/')

$script:Failures = 0
$script:Warnings = 0
$script:Checks = 0

function Write-Head([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
    Write-Host ('-' * $Text.Length) -ForegroundColor DarkGray
}

function Write-Pass([string]$Text) {
    $script:Checks++
    Write-Host "  [PASS] $Text" -ForegroundColor Green
}

function Write-Fail([string]$Text, [string]$Fix) {
    $script:Checks++
    $script:Failures++
    Write-Host "  [FAIL] $Text" -ForegroundColor Red
    if ($Fix) { Write-Host "         fix: $Fix" -ForegroundColor DarkYellow }
}

function Write-Warn([string]$Text, [string]$Fix) {
    $script:Checks++
    $script:Warnings++
    Write-Host "  [WARN] $Text" -ForegroundColor Yellow
    if ($Fix) { Write-Host "         fix: $Fix" -ForegroundColor DarkYellow }
}

function Write-Note([string]$Text) {
    Write-Host "  [INFO] $Text" -ForegroundColor Gray
}

# Soft failure: FAIL when -Strict, WARN otherwise.
function Write-Soft([string]$Text, [string]$Fix) {
    if ($Strict) { Write-Fail $Text $Fix } else { Write-Warn $Text $Fix }
}

# The leading comma matters: without it PowerShell unrolls a one-element array
# into a scalar and a valid single tool call looks like "not a list".
function Get-Prop($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    if ($Object -is [System.Collections.IDictionary]) {
        if ($Object.Contains($Name)) { return , $Object[$Name] }
        return $null
    }
    $prop = $Object.PSObject.Properties[$Name]
    if ($prop) { return , $prop.Value }
    return $null
}

function Get-FirstProp($Object, [string[]]$Names) {
    foreach ($n in $Names) {
        $v = Get-Prop $Object $n
        if ($null -ne $v) { return [pscustomobject]@{ Key = $n; Value = $v } }
    }
    return $null
}

function Test-NonEmptyString($Value) {
    return ($Value -is [string]) -and ($Value.Trim().Length -gt 0)
}

function ConvertTo-Array($Value) {
    if ($null -eq $Value) { return , @() }
    if ($Value -is [string]) { return , @() }
    if ($Value -is [System.Collections.IEnumerable]) { return , @($Value) }
    return , @()
}

function Test-IsList($Value) {
    if ($null -eq $Value) { return $false }
    if ($Value -is [string]) { return $false }
    return ($Value -is [array]) -or ($Value -is [System.Collections.IList])
}

<# ------------------------------------------------------------------ HTTP #>

function Invoke-Kg {
    param(
        [string]$Method,
        [string]$Url,
        [string]$JsonBody,
        [hashtable]$Headers,
        [int]$Timeout = $TimeoutSec
    )

    $out = [pscustomobject]@{
        Ok      = $false
        Status  = 0
        Raw     = ''
        Headers = $null
        Error   = ''
    }

    try {
        $params = @{
            Uri             = $Url
            Method          = $Method
            UseBasicParsing = $true
            TimeoutSec      = $Timeout
        }
        if ($Headers) { $params['Headers'] = $Headers }
        if ($JsonBody) {
            $params['ContentType'] = 'application/json; charset=utf-8'
            $params['Body'] = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)
        }
        $resp = Invoke-WebRequest @params
        $out.Ok = $true
        $out.Status = [int]$resp.StatusCode
        $out.Headers = $resp.Headers
        $content = $resp.Content
        if ($content -is [byte[]]) { $content = [System.Text.Encoding]::UTF8.GetString($content) }
        $out.Raw = [string]$content
    } catch {
        $ex = $_.Exception
        $resp = $null
        if ($ex.PSObject.Properties['Response']) { $resp = $ex.Response }
        if ($resp) {
            try { $out.Status = [int]$resp.StatusCode } catch { }
            try { $out.Headers = $resp.Headers } catch { }
            try {
                $stream = $resp.GetResponseStream()
                if ($stream) {
                    $reader = New-Object System.IO.StreamReader($stream)
                    $out.Raw = $reader.ReadToEnd()
                    $reader.Dispose()
                }
            } catch { }
        }
        $out.Error = $ex.Message
    }
    return $out
}

function Get-HeaderValue($Headers, [string]$Name) {
    if ($null -eq $Headers) { return $null }
    try {
        if ($Headers -is [System.Collections.IDictionary]) {
            foreach ($key in $Headers.Keys) {
                if ($key -and $key.ToString().ToLower() -eq $Name.ToLower()) {
                    $v = $Headers[$key]
                    if ($v -is [array]) { return ($v -join ', ') }
                    return [string]$v
                }
            }
            return $null
        }
        $v = $Headers[$Name]
        if ($v -is [array]) { return ($v -join ', ') }
        if ($v) { return [string]$v }
    } catch { }
    return $null
}

function Test-BackendReachable {
    $uri = [System.Uri]$BaseUrl
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($uri.Host, $uri.Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(1500)) { return $false }
        $client.EndConnect($async)
        return $client.Connected
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

<# ------------------------------------------------------- contract knowledge #>

# What the extension reads out of each tool's args (content.js).
$ToolRequired = @{
    'allow_page'          = @()
    'warn_kid'            = @('message')
    'block_page'          = @('reason', 'safer_alternative')
    'pause_session'       = @('reason')
    'highlight_element'   = @('text_or_css')
    'move_mascot'         = @()
    'notify_parent'       = @('summary')
    'suggest_alternative' = @('label', 'url')
    'navigate_hint'       = @('url')
}
$ToolAliases = @{
    'text_or_css' = @('selector', 'text')
}
$ToolNice = @{
    'warn_kid'    = @('reason')
    'move_mascot' = @('mood')
}
$KnownTools = @($ToolRequired.Keys | Sort-Object)
$Moods = @('idle', 'worry', 'happy', 'point')

# Returns @{ Tool; Args; Notes } or $null, mirroring normalizeToolCalls().
function Resolve-ToolCall($Entry, [string]$Where) {
    $notes = New-Object System.Collections.ArrayList

    if ($Entry -is [string]) {
        [void]$notes.Add("tool call given as a bare string")
        return [pscustomobject]@{ Tool = $Entry; Args = $null; Notes = $notes }
    }

    $fn = Get-Prop $Entry 'function'
    $nameHit = Get-FirstProp $Entry @('tool', 'name', 'action')
    if (-not $nameHit -and $fn) {
        $fnName = Get-Prop $fn 'name'
        if ($fnName) { $nameHit = [pscustomobject]@{ Key = 'function.name'; Value = $fnName } }
    }
    if (-not $nameHit) { return $null }
    if ($nameHit.Key -ne 'tool') {
        [void]$notes.Add("tool name sent as '$($nameHit.Key)' (canonical: 'tool')")
    }

    $argsHit = Get-FirstProp $Entry @('args', 'arguments', 'params', 'parameters')
    if (-not $argsHit -and $fn) {
        $fnArgs = Get-Prop $fn 'arguments'
        if ($null -ne $fnArgs) { $argsHit = [pscustomobject]@{ Key = 'function.arguments'; Value = $fnArgs } }
    }

    $argObj = $null
    if ($argsHit) {
        if ($argsHit.Key -ne 'args') {
            [void]$notes.Add("args sent as '$($argsHit.Key)' (canonical: 'args')")
        }
        $val = $argsHit.Value
        if ($val -is [string]) {
            [void]$notes.Add('args sent as a JSON string instead of an object')
            try { $argObj = $val | ConvertFrom-Json } catch { $argObj = $null }
        } else {
            $argObj = $val
        }
    } else {
        [void]$notes.Add('args flattened onto the tool-call object (no "args" key)')
        $argObj = $Entry
    }

    return [pscustomobject]@{ Tool = [string]$nameHit.Value; Args = $argObj; Notes = $notes }
}

function Test-ToolCalls {
    param($Data, [string]$Where)

    $listHit = Get-FirstProp $Data @('tool_calls', 'toolCalls', 'actions', 'tools')
    if (-not $listHit) {
        $flatAction = Get-Prop $Data 'action'
        if ($flatAction) {
            Write-Warn "$Where : no 'tool_calls' - single flat {action:...} object" `
                'return tool_calls: [{tool, args}] so every tool call survives, not just one'
            $listHit = [pscustomobject]@{ Key = 'action'; Value = @($Data) }
        } else {
            Write-Fail "$Where : field 'tool_calls' is missing" `
                'respond with {"kid_message": "...", "tool_calls": [{"tool": "...", "args": {...}}]}'
            return @()
        }
    } elseif ($listHit.Key -ne 'tool_calls') {
        Write-Warn "$Where : tool calls sent as '$($listHit.Key)'" `
            "rename the field to 'tool_calls' (the extension only tolerates '$($listHit.Key)' by accident)"
    }

    if (-not (Test-IsList $listHit.Value)) {
        Write-Fail "$Where : field '$($listHit.Key)' is not a list (got $($listHit.Value.GetType().Name))" `
            'tool_calls must be a JSON array, even when there is a single tool call'
        return @()
    }

    $entries = ConvertTo-Array $listHit.Value
    if ($entries.Count -eq 0) {
        Write-Fail "$Where : tool_calls is empty - the extension would paint nothing" `
            'always emit at least one tool (allow_page for a safe page)'
        return @()
    }

    $resolved = New-Object System.Collections.ArrayList
    $index = 0
    foreach ($entry in $entries) {
        # NB: not $where - PowerShell variable names are case-insensitive and
        # that would overwrite the $Where parameter on every iteration.
        $slot = "$Where tool_calls[$index]"
        $index++
        $call = Resolve-ToolCall $entry $slot
        if (-not $call) {
            Write-Fail "$slot : no tool name (looked for tool / name / action / function.name)" `
                'each entry needs {"tool": "<one of the frozen tool names>", "args": {...}}'
            continue
        }
        foreach ($note in $call.Notes) {
            Write-Warn "$slot : $note" 'the extension normalizer copes, but send the canonical shape'
        }
        if ($KnownTools -notcontains $call.Tool) {
            Write-Fail "$slot : unknown tool '$($call.Tool)' - the extension silently drops it" `
                ("use only: " + ($KnownTools -join ', '))
            continue
        }

        $failuresBefore = $script:Failures

        foreach ($field in $ToolRequired[$call.Tool]) {
            $value = Get-Prop $call.Args $field
            if (-not (Test-NonEmptyString $value)) {
                $aliasUsed = $null
                if ($ToolAliases.ContainsKey($field)) {
                    foreach ($alias in $ToolAliases[$field]) {
                        $av = Get-Prop $call.Args $alias
                        if (Test-NonEmptyString $av) { $aliasUsed = $alias; break }
                    }
                }
                if ($aliasUsed) {
                    Write-Warn "$slot ($($call.Tool)) : uses args.$aliasUsed instead of args.$field" `
                        "rename it to '$field' - that is the frozen arg name"
                } else {
                    Write-Fail "$slot ($($call.Tool)) : args.$field is missing or empty" `
                        ("$($call.Tool) needs: " + (($ToolRequired[$call.Tool]) -join ', '))
                }
            }
        }

        if ($ToolNice.ContainsKey($call.Tool)) {
            foreach ($field in $ToolNice[$call.Tool]) {
                $value = Get-Prop $call.Args $field
                if (-not (Test-NonEmptyString $value)) {
                    Write-Warn "$slot ($($call.Tool)) : args.$field missing (optional, the UI falls back)" ''
                }
            }
        }

        if ($call.Tool -eq 'move_mascot') {
            $mood = Get-Prop $call.Args 'mood'
            if ((Test-NonEmptyString $mood) -and ($Moods -notcontains ([string]$mood).ToLower())) {
                Write-Warn "$slot (move_mascot) : mood '$mood' unknown, the mascot falls back to idle" `
                    ("use one of: " + ($Moods -join ', '))
            }
        }

        [void]$resolved.Add($call)
        if ($script:Failures -eq $failuresBefore) { Write-Pass "$slot : $($call.Tool) OK" }
    }
    return , @($resolved.ToArray())
}

<# ------------------------------------------------------------------- checks #>

function Test-DecideFixture {
    param($Fixture, [string]$FileName)

    $name = Get-Prop $Fixture 'name'
    if (-not $name) { $name = [System.IO.Path]::GetFileNameWithoutExtension($FileName) }
    $label = Get-Prop $Fixture 'label'
    $payload = Get-Prop $Fixture 'payload'
    if (-not $payload) { $payload = $Fixture }  # allow a bare payload file

    Write-Head ("POST /decide  ->  $name" + $(if ($label) { "  ($label)" } else { '' }))

    $body = $payload | ConvertTo-Json -Depth 6 -Compress
    $res = Invoke-Kg -Method 'POST' -Url "$BaseUrl/decide" -JsonBody $body

    if ($res.Status -eq 0) {
        Write-Fail "$name : no HTTP response ($($res.Error))" 'is the /decide route registered on this port?'
        return
    }
    if ($res.Status -ne 200) {
        $snippet = ($res.Raw -replace '\s+', ' ')
        if ($snippet.Length -gt 200) { $snippet = $snippet.Substring(0, 200) + '...' }
        Write-Fail "$name : HTTP $($res.Status) from /decide" `
            "the extension treats any non-200 as backend_unreachable. Body: $snippet"
        return
    }
    Write-Pass "$name : HTTP 200"

    $data = $null
    try { $data = $res.Raw | ConvertFrom-Json } catch { $data = $null }
    if ($null -eq $data) {
        Write-Fail "$name : response body is not JSON" 'return application/json, not HTML or a bare string'
        return
    }

    $kidHit = Get-FirstProp $data @('kid_message', 'message')
    if (-not $kidHit) {
        Write-Fail "$name : field 'kid_message' is missing" 'add kid_message: one short kid-friendly sentence'
    } elseif ($kidHit.Key -ne 'kid_message') {
        Write-Warn "$name : kid message sent as '$($kidHit.Key)'" "rename it to 'kid_message'"
    } elseif (-not (Test-NonEmptyString $kidHit.Value)) {
        Write-Fail "$name : 'kid_message' is empty" 'kid_message must be a non-empty string'
    } else {
        Write-Pass "$name : kid_message present"
    }

    $calls = Test-ToolCalls -Data $data -Where $name
    $toolNames = @()
    foreach ($c in $calls) { $toolNames += $c.Tool }

    $expect = Get-Prop $Fixture 'expect'
    if ($expect) {
        $why = [string](Get-Prop $expect 'why')
        $any = ConvertTo-Array (Get-Prop $expect 'tools_any')
        if ($any.Count -gt 0) {
            $matched = @($any | Where-Object { $toolNames -contains $_ })
            if ($matched.Count -gt 0) {
                Write-Pass "$name : classified as $($matched -join '/') as expected"
            } else {
                Write-Soft "$name : expected one of [$($any -join ', ')] but got [$($toolNames -join ', ')]" `
                    "$why - tune the prompt/policy in backend/policy.py"
            }
        }
        foreach ($needed in (ConvertTo-Array (Get-Prop $expect 'tools_all'))) {
            if ($toolNames -notcontains $needed) {
                Write-Soft "$name : expected tool '$needed' in the answer" $why
            }
        }
    }
}

function Test-Coach {
    Write-Head 'POST /coach'
    $body = '{"message":"can I go to classroom?"}'
    $res = Invoke-Kg -Method 'POST' -Url "$BaseUrl/coach" -JsonBody $body

    if ($res.Status -eq 0) {
        Write-Fail "/coach : no HTTP response ($($res.Error))" 'register POST /coach'
        return
    }
    if ($res.Status -ne 200) {
        Write-Fail "/coach : HTTP $($res.Status)" 'the side-panel chat shows "my buddy is offline" on any non-200'
        return
    }
    Write-Pass '/coach : HTTP 200'

    $data = $null
    try { $data = $res.Raw | ConvertFrom-Json } catch { $data = $null }
    if ($null -eq $data) {
        Write-Fail '/coach : response body is not JSON' 'return application/json'
        return
    }

    $replyHit = Get-FirstProp $data @('reply', 'kid_message', 'message')
    if (-not $replyHit) {
        Write-Fail "/coach : field 'reply' is missing" 'respond with {"reply": "...", "tool_calls": []}'
    } elseif ($replyHit.Key -ne 'reply') {
        Write-Warn "/coach : reply sent as '$($replyHit.Key)'" "rename it to 'reply'"
    } elseif (-not (Test-NonEmptyString $replyHit.Value)) {
        Write-Fail "/coach : 'reply' is empty" 'reply must be a non-empty string'
    } else {
        Write-Pass '/coach : reply present'
    }

    $listHit = Get-FirstProp $data @('tool_calls', 'toolCalls', 'actions', 'tools')
    if (-not $listHit) {
        Write-Warn '/coach : no tool_calls field' 'send tool_calls: [] when the coach has nothing to do'
    } else {
        [void](Test-ToolCalls -Data $data -Where '/coach')
    }
}

function Test-Events {
    Write-Head 'GET /events (+ CORS for frontend/parent.html)'
    $res = Invoke-Kg -Method 'GET' -Url "$BaseUrl/events" -Headers @{ 'Origin' = $Origin } -Timeout 15

    if ($res.Status -eq 0) {
        Write-Fail "/events : no HTTP response ($($res.Error))" 'register GET /events'
        return
    }
    if ($res.Status -ne 200) {
        Write-Fail "/events : HTTP $($res.Status)" 'the parent dashboard polls this route every few seconds'
        return
    }
    Write-Pass '/events : HTTP 200'

    # CORS first: it is the failure that silently empties the parent dashboard.
    $acao = Get-HeaderValue $res.Headers 'Access-Control-Allow-Origin'
    if (-not $acao) {
        Write-Fail "/events : no Access-Control-Allow-Origin for Origin $Origin" `
            'add fastapi.middleware.cors.CORSMiddleware with allow_origins=["*"] - without it parent.html shows an empty feed and no error'
    } elseif ($acao -eq '*' -or $acao.TrimEnd('/') -eq $Origin.TrimEnd('/')) {
        Write-Pass "/events : Access-Control-Allow-Origin = $acao"
    } else {
        Write-Fail "/events : Access-Control-Allow-Origin = $acao (does not cover $Origin)" `
            'allow_origins=["*"] is simplest for the demo'
    }

    $data = $null
    try { $data = $res.Raw | ConvertFrom-Json } catch { $data = $null }
    if ($null -eq $data) {
        Write-Fail '/events : response body is not JSON' 'return a JSON array of events'
        return
    }

    $list = $null
    if (Test-IsList $data) {
        $list = ConvertTo-Array $data
        Write-Pass '/events : JSON array'
    } else {
        $inner = Get-Prop $data 'events'
        if (Test-IsList $inner) {
            $list = ConvertTo-Array $inner
            Write-Warn '/events : array wrapped in {"events": [...]}' 'parent.html accepts it, a bare array is the contract'
        } else {
            Write-Fail '/events : neither a JSON array nor {"events": [...]}' 'return [] when there is no event yet'
            return
        }
    }

    if ($list.Count -eq 0) {
        Write-Note '/events : empty list (fine before the first decision)'
    } else {
        $first = $list[0]
        $hasAction = Get-FirstProp $first @('action', 'tool', 'type', 'event')
        $hasText = Get-FirstProp $first @('summary', 'message', 'detail', 'kid_message', 'reason', 'text')
        $hasTs = Get-FirstProp $first @('ts', 'time', 'timestamp', 'created_at')
        if ($hasAction) { Write-Pass "/events : item has '$($hasAction.Key)'" }
        else { Write-Warn "/events : item has no action/tool field" 'the dashboard badge falls back to "event"' }
        if ($hasText) { Write-Pass "/events : item has '$($hasText.Key)'" }
        else { Write-Warn '/events : item has no summary/message field' 'the row would read "(no details provided)"' }
        if ($hasTs) { Write-Pass "/events : item has '$($hasTs.Key)'" }
        else { Write-Warn '/events : item has no timestamp field' 'add ts (ISO string or epoch) so the feed can sort' }
    }
}

<# --------------------------------------------------------------------- main #>

Write-Host ''
Write-Host 'KidGuard backend contract check' -ForegroundColor White
Write-Host "  backend : $BaseUrl"
Write-Host "  fixtures: $FixtureDir"
Write-Host "  origin  : $Origin (frontend/parent.html)"

if (-not (Test-Path $FixtureDir)) {
    Write-Host ''
    Write-Host "ERROR: fixture folder not found: $FixtureDir" -ForegroundColor Red
    Write-Host 'Expected JSON files like scripts/fixtures/03_phishing.json'
    exit 3
}

$fixtureFiles = @(Get-ChildItem -Path $FixtureDir -Filter '*.json' -File | Sort-Object Name)
if ($fixtureFiles.Count -eq 0) {
    Write-Host ''
    Write-Host "ERROR: no *.json fixtures in $FixtureDir" -ForegroundColor Red
    exit 3
}

if (-not (Test-BackendReachable)) {
    Write-Host ''
    Write-Host "Backend not running yet on $BaseUrl - nothing to check." -ForegroundColor Yellow
    Write-Host ''
    Write-Host 'Start it (teammate A / D), then run this script again:' -ForegroundColor DarkGray
    Write-Host '  python -m uvicorn backend.main:app --port 8000 --reload'
    Write-Host ''
    Write-Host 'Meanwhile the extension demo still works: keep MOCK mode on.' -ForegroundColor DarkGray
    exit 2
}
Write-Host ''
Write-Host "Backend is listening on $BaseUrl" -ForegroundColor Green

foreach ($file in $fixtureFiles) {
    $fixture = $null
    try {
        $fixture = Get-Content -Path $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        Write-Head "fixture $($file.Name)"
        Write-Fail "$($file.Name) : not valid JSON ($($_.Exception.Message))" 'fix the fixture file'
        continue
    }
    Test-DecideFixture -Fixture $fixture -FileName $file.Name
}

Test-Coach
Test-Events

Write-Host ''
Write-Host ('=' * 58) -ForegroundColor DarkGray
if ($script:Failures -gt 0) {
    Write-Host "RESULT: FAIL - $($script:Failures) failure(s), $($script:Warnings) warning(s), $($script:Checks) checks" -ForegroundColor Red
    Write-Host 'Every [FAIL] above names the exact field the extension cannot work without.'
    exit 1
}
if ($script:Warnings -gt 0) {
    Write-Host "RESULT: PASS with $($script:Warnings) warning(s) - $($script:Checks) checks" -ForegroundColor Yellow
    Write-Host 'Warnings are survivable: the extension normalizer or a UI fallback covers them.'
    exit 0
}
Write-Host "RESULT: PASS - $($script:Checks) checks, contract clean" -ForegroundColor Green
exit 0
