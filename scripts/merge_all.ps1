<#
.SYNOPSIS
    Merge every team branch (local + origin/*) into main, safely and repeatably.

.DESCRIPTION
    Built for a 4-person hackathon where everyone works on their own branch and
    main has to be re-integrated several times an afternoon.

    Run it as often as you like: branches already contained in main are reported
    as "already up to date" instead of being merged again, and a conflicting
    branch is skipped (merge aborted) so the other branches still get in.

.EXAMPLE
    .\scripts\merge_all.ps1 -DryRun
    Preview only. Nothing is checked out, merged or pushed.

.EXAMPLE
    .\scripts\merge_all.ps1
    Merge everything into main locally.

.EXAMPLE
    .\scripts\merge_all.ps1 -Stash -Push
    Auto-stash local edits, merge everything, push main, restore the stash.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Push,
    [switch]$Stash,
    [switch]$StopOnConflict,
    [Alias('h')][switch]$Help
)

$ErrorActionPreference = 'Stop'
# PowerShell 7.3+ turns a non-zero native exit code into a terminating error.
# git returns non-zero for perfectly expected situations (conflict, "not an
# ancestor", ...), so we inspect exit codes ourselves instead.
$PSNativeCommandUseErrorActionPreference = $false

$MainBranch = 'main'
$Remote     = 'origin'

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

function Write-Line {
    param([string]$Text = '', [string]$Colour)
    if ($Colour) { Write-Host $Text -ForegroundColor $Colour } else { Write-Host $Text }
}

function Write-Section {
    param([string]$Text)
    Write-Line ''
    Write-Line "== $Text" 'Cyan'
}

function Write-Ok    { param([string]$Text) Write-Line "  OK    $Text" 'Green' }
function Write-Info  { param([string]$Text) Write-Line "  ..    $Text" 'Gray' }
function Write-Warn  { param([string]$Text) Write-Line "  WARN  $Text" 'Yellow' }
function Write-Fail  { param([string]$Text) Write-Line "  FAIL  $Text" 'Red' }

function Show-Help {
    @"
merge_all.ps1 - merge every branch into '$MainBranch'

USAGE
    .\scripts\merge_all.ps1 [-DryRun] [-Push] [-Stash] [-StopOnConflict] [-Help]

FLAGS
    -DryRun           Show exactly which branches would be merged and stop.
                      No checkout, no merge, no commit, no push.
                      (It does run 'git fetch --all --prune' so the preview
                      includes branches your teammates pushed since last time;
                      that only updates $Remote/* tracking refs.)
    -Push             Push the resulting '$MainBranch' to '$Remote' at the end.
                      Default: nothing is pushed.
    -Stash            Auto-stash uncommitted changes (including untracked files)
                      instead of aborting, and restore them at the end.
    -StopOnConflict   Stop at the first conflict and leave it in the working
                      tree for manual resolution. Default: abort that one merge,
                      record it as failed and carry on with the other branches.
    -Help             This text.

WHAT IT DOES
    1. Safety checks: inside a git repo, no merge/rebase in progress, clean tree.
    2. Remembers the branch you were on and returns you to it at the end.
    3. git fetch --all --prune
    4. Collects every local branch and every $Remote/* branch except
       '$MainBranch' and $Remote/HEAD, de-duplicated.
    5. Fast-forwards '$MainBranch' from $Remote/$MainBranch.
    6. git merge --no-ff --no-edit <branch> for each remaining branch.
    7. Prints a summary table and exits non-zero if anything failed.
"@ | Write-Host
}

# ---------------------------------------------------------------------------
# git plumbing
# ---------------------------------------------------------------------------

function Invoke-Git {
    param([Parameter(Mandatory)][string[]]$Arguments)

    # git writes progress and warnings to stderr; merging the streams while
    # $ErrorActionPreference is 'Stop' would raise a NativeCommandError, so the
    # preference is relaxed for the duration of the call only.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & git @Arguments 2>&1 | ForEach-Object { [string]$_ }
        $code   = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }

    [pscustomobject]@{
        ExitCode = $code
        Ok       = ($code -eq 0)
        Lines    = @($output)
        Text     = (@($output) -join [Environment]::NewLine)
    }
}

function Get-GitValue {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $r = Invoke-Git $Arguments
    if (-not $r.Ok) { return $null }
    return ($r.Text).Trim()
}

function Test-RefExists {
    param([Parameter(Mandatory)][string]$Ref)
    (Invoke-Git @('rev-parse', '--verify', '--quiet', "$Ref^{commit}")).Ok
}

function Test-IsAncestor {
    param([Parameter(Mandatory)][string]$Ancestor, [Parameter(Mandatory)][string]$Descendant)
    (Invoke-Git @('merge-base', '--is-ancestor', $Ancestor, $Descendant)).ExitCode -eq 0
}

function Get-ShortCommit {
    param([Parameter(Mandatory)][string]$Ref)
    Get-GitValue @('log', '-1', '--format=%h %s', $Ref)
}

# ---------------------------------------------------------------------------
# Branch discovery
# ---------------------------------------------------------------------------

function Get-Candidates {
    $remoteRefs = @{}
    foreach ($line in (Invoke-Git @('for-each-ref', '--format=%(refname:short)', "refs/remotes/$Remote")).Lines) {
        $ref = $line.Trim()
        if (-not $ref) { continue }
        $short = $ref.Substring($Remote.Length + 1)
        if ($short -eq 'HEAD' -or $short -eq $MainBranch) { continue }
        $remoteRefs[$short] = $ref
    }

    $consumed  = New-Object System.Collections.Generic.HashSet[string]
    $candidates = New-Object System.Collections.Generic.List[object]

    foreach ($line in (Invoke-Git @('for-each-ref', '--format=%(refname:short)%09%(upstream:short)', 'refs/heads')).Lines) {
        if (-not $line.Trim()) { continue }
        $parts    = $line -split "`t", 2
        $local    = $parts[0].Trim()
        $upstream = if ($parts.Count -gt 1) { $parts[1].Trim() } else { '' }
        if ($local -eq $MainBranch) { continue }

        # A branch usually exists twice (Kat and origin/Kat). Merging both would
        # create a pointless extra merge commit, so pick one: the remote-tracking
        # ref when it already contains the local tip (teammate pushed newer work),
        # otherwise the local ref (we have commits not pushed yet).
        $remoteRef = $null
        if ($upstream -and $upstream.StartsWith("$Remote/") -and $remoteRefs.ContainsKey($upstream.Substring($Remote.Length + 1))) {
            $remoteRef = $upstream
        } elseif ($remoteRefs.ContainsKey($local)) {
            $remoteRef = $remoteRefs[$local]
        }

        if ($remoteRef) {
            [void]$consumed.Add($remoteRef)
            if (Test-IsAncestor -Ancestor $local -Descendant $remoteRef) {
                $candidates.Add([pscustomobject]@{ Name = $local; Ref = $remoteRef; Source = 'remote' })
                continue
            }
        }
        $candidates.Add([pscustomobject]@{ Name = $local; Ref = $local; Source = 'local' })
    }

    foreach ($short in ($remoteRefs.Keys | Sort-Object)) {
        $ref = $remoteRefs[$short]
        if ($consumed.Contains($ref)) { continue }
        $candidates.Add([pscustomobject]@{ Name = $short; Ref = $ref; Source = 'remote-only' })
    }

    return $candidates
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if ($Help) { Show-Help; exit 0 }

$results        = New-Object System.Collections.Generic.List[object]
$startingBranch = $null
$stashRef       = $null
$leaveRepoAsIs  = $false
$exitCode       = 0
$originalCwd    = (Get-Location).Path

function Add-Result {
    param([string]$Name, [string]$Ref, [string]$Status, [string]$Detail = '')
    $results.Add([pscustomobject]@{ Name = $Name; Ref = $Ref; Status = $Status; Detail = $Detail })
}

function Show-Summary {
    Write-Section 'Summary'
    if ($results.Count -eq 0) {
        Write-Line '  (no branches to process)' 'Gray'
    }
    foreach ($r in $results) {
        $colour = switch ($r.Status) {
            'merged'         { 'Green' }
            'would merge'    { 'Green' }
            'up to date'     { 'DarkGray' }
            'conflict'       { 'Red' }
            'error'          { 'Red' }
            default          { 'Yellow' }
        }
        Write-Line ('  {0,-32} {1,-14} {2}' -f $r.Name, $r.Status, $r.Detail) $colour
    }

    $failed = @($results | Where-Object { $_.Status -in @('conflict', 'error') })
    Write-Line ''
    if (Test-RefExists $MainBranch) {
        Write-Line ("  $MainBranch is now at: " + (Get-ShortCommit $MainBranch)) 'Cyan'
    }
    if ($failed.Count -gt 0) {
        Write-Line ''
        Write-Line '  ###############################################################' 'Red'
        Write-Line ("  #  {0} BRANCH(ES) DID NOT MAKE IT INTO $MainBranch" -f $failed.Count) 'Red'
        foreach ($f in $failed) { Write-Line ("  #    - {0} ({1})" -f $f.Name, $f.Status) 'Red' }
        Write-Line '  #  Fix them manually:  git merge <branch>   then resolve' 'Red'
        Write-Line '  ###############################################################' 'Red'
    } elseif (-not $DryRun) {
        Write-Line '  All branches are in main.' 'Green'
    }
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Fail 'git is not on PATH.'
        exit 2
    }

    if ((Get-GitValue @('rev-parse', '--is-inside-work-tree')) -ne 'true') {
        Write-Fail "Not inside a git repository ($originalCwd)."
        exit 2
    }

    $repoRoot = Get-GitValue @('rev-parse', '--show-toplevel')
    if ($repoRoot) { Set-Location -LiteralPath $repoRoot }

    Write-Line ''
    Write-Line "merge_all - merging every branch into '$MainBranch'" 'White'
    Write-Line "repository: $repoRoot" 'DarkGray'
    if ($DryRun) { Write-Line 'MODE: DRY RUN - nothing will be modified' 'Yellow' }

    Write-Section 'Pre-flight checks'

    $gitDir = Get-GitValue @('rev-parse', '--git-dir')
    $inProgress = @(
        @(
            @{ Path = 'MERGE_HEAD';       What = 'A merge' },
            @{ Path = 'rebase-merge';     What = 'A rebase' },
            @{ Path = 'rebase-apply';     What = 'A rebase/am' },
            @{ Path = 'CHERRY_PICK_HEAD'; What = 'A cherry-pick' },
            @{ Path = 'REVERT_HEAD';      What = 'A revert' }
        ) | Where-Object { Test-Path -LiteralPath (Join-Path $gitDir $_.Path) }
    )

    if ($inProgress.Count -gt 0) {
        Write-Fail ("{0} is already in progress in this repository." -f $inProgress[0].What)
        Write-Line '        Finish it or abort it first:' 'Red'
        Write-Line '            git status' 'Red'
        Write-Line '            git merge --abort      # or: git rebase --abort' 'Red'
        exit 2
    }
    Write-Ok 'no merge/rebase in progress'

    $dirty = @((Invoke-Git @('status', '--porcelain')).Lines | Where-Object { $_.Trim() })
    if ($dirty.Count -gt 0) {
        if ($DryRun) {
            Write-Warn ("working tree has {0} uncommitted change(s); a real run would abort (use -Stash)." -f $dirty.Count)
        } elseif ($Stash) {
            $before = Get-GitValue @('rev-parse', '--verify', '--quiet', 'refs/stash')
            $label  = "merge_all auto-stash $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
            $r = Invoke-Git @('stash', 'push', '--include-untracked', '--message', $label)
            if (-not $r.Ok) {
                Write-Fail "could not stash local changes:`n$($r.Text)"
                exit 2
            }
            $after = Get-GitValue @('rev-parse', '--verify', '--quiet', 'refs/stash')
            if ($after -and $after -ne $before) {
                $stashRef = $after
                Write-Ok "stashed $($dirty.Count) local change(s); they will be restored at the end"
            }
        } else {
            Write-Fail "working tree is dirty - $($dirty.Count) uncommitted change(s)."
            foreach ($d in ($dirty | Select-Object -First 10)) { Write-Line "          $d" 'Red' }
            if ($dirty.Count -gt 10) { Write-Line ('          ... and {0} more' -f ($dirty.Count - 10)) 'Red' }
            Write-Line '        Commit them, or re-run with -Stash to park them automatically.' 'Red'
            exit 2
        }
    } else {
        Write-Ok 'working tree is clean'
    }

    $startingBranch = Get-GitValue @('symbolic-ref', '--quiet', '--short', 'HEAD')
    if (-not $startingBranch) {
        $startingBranch = Get-GitValue @('rev-parse', 'HEAD')
        Write-Warn "detached HEAD; will return to commit $startingBranch"
    } else {
        Write-Ok "starting branch recorded: $startingBranch"
    }

    Write-Section 'Fetching'
    $fetch = Invoke-Git @('fetch', '--all', '--prune')
    if ($fetch.Ok) {
        Write-Ok 'git fetch --all --prune'
    } else {
        Write-Warn "fetch failed (offline?), continuing with what is already local:`n$($fetch.Text)"
    }

    # main may not exist locally yet on a fresh clone of someone else's fork.
    if (-not (Test-RefExists $MainBranch)) {
        if (Test-RefExists "$Remote/$MainBranch") {
            if ($DryRun) {
                Write-Warn "local '$MainBranch' does not exist; a real run would create it from $Remote/$MainBranch"
            } else {
                $r = Invoke-Git @('branch', $MainBranch, "$Remote/$MainBranch")
                if (-not $r.Ok) { Write-Fail "could not create '$MainBranch':`n$($r.Text)"; exit 2 }
                Write-Ok "created local '$MainBranch' from $Remote/$MainBranch"
            }
        } else {
            Write-Fail "no '$MainBranch' branch locally or on $Remote."
            exit 2
        }
    }

    Write-Section 'Branches to merge'
    $candidates = @(Get-Candidates)
    if ($candidates.Count -eq 0) {
        Write-Info "nothing but '$MainBranch' exists - nothing to do."
    }
    foreach ($c in $candidates) {
        Write-Info ("{0,-32} -> {1}" -f $c.Ref, $c.Source)
    }

    if ($DryRun) {
        Write-Section 'Dry run plan'

        # Preview against the tip main *would* have after the fast-forward.
        $baseTip = $MainBranch
        if ((Test-RefExists "$Remote/$MainBranch") -and (Test-IsAncestor -Ancestor $MainBranch -Descendant "$Remote/$MainBranch")) {
            $baseTip = "$Remote/$MainBranch"
            Write-Info "$MainBranch would fast-forward to $Remote/$MainBranch ($(Get-ShortCommit $baseTip))"
        }

        $planned = New-Object System.Collections.Generic.List[string]
        foreach ($c in $candidates) {
            if (Test-IsAncestor -Ancestor $c.Ref -Descendant $baseTip) {
                Add-Result -Name $c.Name -Ref $c.Ref -Status 'up to date' -Detail 'already in main'
                continue
            }
            # A branch contained in one we are about to merge will be up to date
            # by the time its turn comes, so report it the same way.
            $swallowed = $false
            foreach ($p in $planned) {
                if (Test-IsAncestor -Ancestor $c.Ref -Descendant $p) { $swallowed = $true; break }
            }
            if ($swallowed) {
                Add-Result -Name $c.Name -Ref $c.Ref -Status 'up to date' -Detail 'contained in another branch being merged'
            } else {
                $planned.Add($c.Ref)
                Add-Result -Name $c.Name -Ref $c.Ref -Status 'would merge' -Detail (Get-ShortCommit $c.Ref)
            }
        }

        Show-Summary
        Write-Line ''
        Write-Line '  Dry run: no checkout, no merge, no push was performed.' 'Yellow'
        Write-Line '  Run the same command without -DryRun to apply it.' 'Yellow'
        exit 0
    }

    Write-Section "Preparing '$MainBranch'"
    $co = Invoke-Git @('checkout', $MainBranch)
    if (-not $co.Ok) {
        Write-Fail "could not checkout '$MainBranch':`n$($co.Text)"
        exit 2
    }
    Write-Ok "on '$MainBranch'"

    $pull = Invoke-Git @('pull', '--ff-only', $Remote, $MainBranch)
    if ($pull.Ok) {
        Write-Ok "fast-forwarded from $Remote/$MainBranch"
    } else {
        # Expected when the remote has no main yet, or when local main already
        # carries commits that were never pushed. Neither should stop the merges.
        Write-Warn "could not fast-forward from $Remote/$MainBranch (continuing):`n$($pull.Text)"
    }

    Write-Section 'Merging'
    foreach ($c in $candidates) {
        if (Test-IsAncestor -Ancestor $c.Ref -Descendant $MainBranch) {
            Write-Line ("  --    {0,-32} already up to date" -f $c.Ref) 'DarkGray'
            Add-Result -Name $c.Name -Ref $c.Ref -Status 'up to date' -Detail 'already in main'
            continue
        }

        Write-Info "merging $($c.Ref) ..."
        $merge = Invoke-Git @('merge', '--no-ff', '--no-edit', $c.Ref)
        if ($merge.Ok) {
            Write-Ok "$($c.Ref) merged -> $(Get-ShortCommit $MainBranch)"
            Add-Result -Name $c.Name -Ref $c.Ref -Status 'merged' -Detail (Get-ShortCommit $MainBranch)
            continue
        }

        $conflicts = @((Invoke-Git @('diff', '--name-only', '--diff-filter=U')).Lines | Where-Object { $_.Trim() })
        if ($conflicts.Count -gt 0) {
            Write-Fail "CONFLICT merging $($c.Ref) - $($conflicts.Count) file(s):"
            foreach ($f in $conflicts) { Write-Line "          $f" 'Red' }

            if ($StopOnConflict) {
                Write-Line ''
                Write-Line '  Stopping here (-StopOnConflict). The conflict is left in place.' 'Yellow'
                Write-Line '  To finish by hand:' 'Yellow'
                Write-Line '      git status                       # see the conflicted files' 'Yellow'
                Write-Line '      <edit files, remove <<<< ==== >>>> markers>' 'Yellow'
                Write-Line '      git add <files>' 'Yellow'
                Write-Line '      git commit                       # completes the merge' 'Yellow'
                Write-Line '  Or give up on this one:  git merge --abort' 'Yellow'
                if ($stashRef) {
                    Write-Line "  NOTE: your stashed changes are still stashed - 'git stash pop' when done." 'Yellow'
                }
                Write-Line "  You are on '$MainBranch' (started on '$startingBranch')." 'Yellow'
                Add-Result -Name $c.Name -Ref $c.Ref -Status 'conflict' -Detail "$($conflicts.Count) file(s), left for manual resolution"
                $leaveRepoAsIs = $true
                $exitCode = 1
                break
            }

            $abort = Invoke-Git @('merge', '--abort')
            if ($abort.Ok) {
                Write-Warn "merge of $($c.Ref) aborted; continuing with the other branches"
            } else {
                Write-Fail "could not abort the merge of $($c.Ref):`n$($abort.Text)"
                Add-Result -Name $c.Name -Ref $c.Ref -Status 'error' -Detail 'merge --abort failed - repo needs manual attention'
                $leaveRepoAsIs = $true
                $exitCode = 1
                break
            }
            Add-Result -Name $c.Name -Ref $c.Ref -Status 'conflict' -Detail ("{0}: {1}" -f $conflicts.Count, ($conflicts -join ', '))
            $exitCode = 1
            continue
        }

        Write-Fail "merge of $($c.Ref) failed:`n$($merge.Text)"
        if (Test-Path -LiteralPath (Join-Path $gitDir 'MERGE_HEAD')) { [void](Invoke-Git @('merge', '--abort')) }
        Add-Result -Name $c.Name -Ref $c.Ref -Status 'error' -Detail ($merge.Lines | Select-Object -First 1)
        $exitCode = 1
    }

    if ($results | Where-Object { $_.Status -in @('conflict', 'error') }) { $exitCode = 1 }

    if ($Push -and -not $leaveRepoAsIs) {
        Write-Section 'Pushing'
        if ($exitCode -ne 0) {
            Write-Warn 'some branches failed; pushing the successful merges anyway'
        }
        $p = Invoke-Git @('push', $Remote, $MainBranch)
        if ($p.Ok) {
            Write-Ok "pushed $MainBranch to $Remote"
        } else {
            Write-Fail "push failed:`n$($p.Text)"
            $exitCode = 1
        }
    } elseif ($Push) {
        Write-Warn 'not pushing: the repository was left mid-merge on purpose.'
    }

    Show-Summary
    if (-not $Push -and -not $leaveRepoAsIs) {
        Write-Line ''
        Write-Line "  Nothing was pushed. When you are happy:  git push $Remote $MainBranch" 'Cyan'
    }
}
finally {
    if (-not $DryRun -and -not $leaveRepoAsIs) {
        if ($startingBranch -and (Get-GitValue @('symbolic-ref', '--quiet', '--short', 'HEAD')) -ne $startingBranch) {
            $back = Invoke-Git @('checkout', $startingBranch)
            if ($back.Ok) {
                Write-Line ''
                Write-Line "  Back on '$startingBranch'." 'Cyan'
            } else {
                Write-Line ''
                Write-Line "  Could not return to '$startingBranch':`n$($back.Text)" 'Red'
            }
        }
        if ($stashRef) {
            $pop = Invoke-Git @('stash', 'pop')
            if ($pop.Ok) {
                Write-Line '  Stashed changes restored.' 'Cyan'
            } else {
                Write-Line "  Could not restore your stash automatically - it is safe in 'git stash list':" 'Red'
                Write-Line "  $($pop.Text)" 'Red'
            }
        }
    }
    Set-Location -LiteralPath $originalCwd
}

exit $exitCode
