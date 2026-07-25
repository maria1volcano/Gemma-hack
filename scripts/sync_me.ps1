<#
.SYNOPSIS
    Pull main into YOUR current branch, safely and repeatably.

.DESCRIPTION
    The mirror image of scripts/merge_all.ps1: merge_all pushes everybody's work
    INTO main, sync_me brings main back INTO the branch you are working on.

    Run it every 30 minutes or so. Integrating the team's work in small steps is
    what stops the afternoon from ending in one huge unresolvable conflict.

    Your branch is never left: no checkout happens in any code path.

.EXAMPLE
    .\scripts\sync_me.ps1 -DryRun
    Show what main has that you do not, and which files it would touch.

.EXAMPLE
    .\scripts\sync_me.ps1
    Merge origin/main into your current branch.

.EXAMPLE
    .\scripts\sync_me.ps1 -Stash -Push
    Park your uncommitted edits, sync, push the branch, restore your edits.
#>
[CmdletBinding()]
param(
    [switch]$DryRun,
    [switch]$Push,
    [switch]$Stash,
    [switch]$Rebase,
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
sync_me.ps1 - bring '$Remote/$MainBranch' into the branch you are working on

USAGE
    .\scripts\sync_me.ps1 [-DryRun] [-Rebase] [-Push] [-Stash] [-Help]

FLAGS
    -DryRun     Report how far behind '$Remote/$MainBranch' you are, list those
                commits and the files they touch, then stop. Changes nothing.
                (It does run 'git fetch $Remote $MainBranch --prune' so the
                report is accurate; that only updates $Remote/* tracking refs.)
    -Rebase     Rebase your branch onto $Remote/$MainBranch instead of merging.
                Cleaner history, but rewrites your commits - only use it if your
                branch is not shared, or be ready to force-push.
    -Push       Push your branch afterwards (sets the upstream on first push).
                Default: nothing is pushed.
    -Stash      Auto-stash uncommitted changes (including untracked files)
                instead of aborting, and restore them at the end.
    -Help       This text.

WHAT IT DOES
    1. Safety checks: inside a git repo, no merge/rebase in progress, clean tree,
       and you are NOT on '$MainBranch' (use merge_all.ps1 for that direction).
    2. git fetch $Remote $MainBranch --prune
    3. Exits straight away if you are already up to date - no empty merge commit.
    4. git merge --no-edit $Remote/$MainBranch   (or git rebase $Remote/$MainBranch)
    5. On conflict: leaves it in place for you to resolve, prints the exact
       commands to finish or to bail out, and exits non-zero.

    You stay on your own branch the whole time.
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

function Get-ConflictedFiles {
    @((Invoke-Git @('diff', '--name-only', '--diff-filter=U')).Lines | Where-Object { $_.Trim() })
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if ($Help) { Show-Help; exit 0 }

$branch           = $null
$stashRef         = $null
$conflictInPlace  = $false
$exitCode         = 0
$originalCwd      = (Get-Location).Path
$operation        = if ($Rebase) { 'rebase' } else { 'merge' }

function Show-StashReminder {
    if (-not $stashRef) { return }
    Write-Line ''
    Write-Line '  YOUR UNCOMMITTED WORK IS STILL IN THE STASH - it was not restored,' 'Yellow'
    Write-Line '  because dropping it on top of a conflicted tree would make things worse.' 'Yellow'
    Write-Line '  Once the conflict is resolved and committed:' 'Yellow'
    Write-Line '      git stash list      # your entry is the one labelled "sync_me auto-stash"' 'Yellow'
    Write-Line '      git stash pop' 'Yellow'
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
    Write-Line "sync_me - bringing '$Remote/$MainBranch' into your branch" 'White'
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

    $branch = Get-GitValue @('symbolic-ref', '--quiet', '--short', 'HEAD')
    if (-not $branch) {
        Write-Fail 'detached HEAD - you are not on a branch, so there is nothing to sync.'
        Write-Line "        Check out your branch first:  git checkout <your-branch>" 'Red'
        exit 2
    }

    if ($branch -eq $MainBranch) {
        Write-Fail "you are on '$MainBranch'. sync_me pulls $MainBranch INTO a feature branch."
        Write-Line '        To pull everyone else''s branches into main, use the other script:' 'Red'
        Write-Line '            .\scripts\merge_all.ps1 -DryRun     # preview' 'Red'
        Write-Line '            .\scripts\merge_all.ps1             # do it' 'Red'
        Write-Line "        Or switch to your own branch first:  git checkout <your-branch>" 'Red'
        exit 2
    }
    Write-Ok "current branch: $branch (never left by this script)"

    $dirty = @((Invoke-Git @('status', '--porcelain')).Lines | Where-Object { $_.Trim() })
    if ($dirty.Count -gt 0) {
        if ($DryRun) {
            Write-Warn ("working tree has {0} uncommitted change(s); a real run would abort (use -Stash)." -f $dirty.Count)
        } elseif ($Stash) {
            $before = Get-GitValue @('rev-parse', '--verify', '--quiet', 'refs/stash')
            $label  = "sync_me auto-stash $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
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

    Write-Section 'Fetching'
    $fetch = Invoke-Git @('fetch', $Remote, $MainBranch, '--prune')
    if ($fetch.Ok) {
        Write-Ok "git fetch $Remote $MainBranch --prune"
    } else {
        Write-Warn "fetch failed (offline?), using the $Remote/$MainBranch we already have:`n$($fetch.Text)"
    }

    $target = "$Remote/$MainBranch"
    if (-not (Test-RefExists $target)) {
        Write-Fail "$target does not exist - nothing to sync from."
        exit 2
    }

    Write-Section 'Status'
    $behind = [int](Get-GitValue @('rev-list', '--count', "HEAD..$target"))
    $ahead  = [int](Get-GitValue @('rev-list', '--count', "$target..HEAD"))
    Write-Info "$target is at $(Get-ShortCommit $target)"
    Write-Info "your branch '$branch' is $ahead commit(s) ahead, $behind commit(s) behind"

    if ($behind -eq 0) {
        Write-Line ''
        Write-Ok "'$branch' is already up to date with $target - nothing to do."
        Write-Line '  (no empty merge commit was created)' 'DarkGray'
        exit 0
    }

    if ($DryRun) {
        Write-Section "Dry run - what $operation would bring in"
        Write-Line "  $behind commit(s) from $target :" 'White'
        foreach ($l in (Invoke-Git @('log', '--oneline', "HEAD..$target")).Lines) {
            if ($l.Trim()) { Write-Line "      $l" 'Green' }
        }

        # Three-dot: what main gained since your branch left it, i.e. the files
        # the merge would actually bring in (not your own edits).
        $files = @((Invoke-Git @('diff', '--name-status', "HEAD...$target")).Lines | Where-Object { $_.Trim() })
        Write-Line ''
        Write-Line ("  {0} file(s) would be touched:" -f $files.Count) 'White'
        foreach ($f in $files) { Write-Line "      $f" 'Cyan' }

        Write-Line ''
        Write-Line '  Dry run: no merge, no rebase, no commit, no push was performed.' 'Yellow'
        Write-Line '  Run the same command without -DryRun to apply it.' 'Yellow'
        exit 0
    }

    Write-Section ("Syncing ({0})" -f $operation)
    if ($Rebase) {
        $result = Invoke-Git @('rebase', $target)
    } else {
        $result = Invoke-Git @('merge', '--no-edit', $target)
    }

    if ($result.Ok) {
        Write-Ok "$operation done - '$branch' now contains $target"
        Write-Info "HEAD is at $(Get-ShortCommit 'HEAD')"
    } else {
        $conflicts = Get-ConflictedFiles
        $exitCode = 1

        if ($conflicts.Count -gt 0) {
            $conflictInPlace = $true
            Write-Line ''
            Write-Line '  ###############################################################' 'Red'
            Write-Line ("  #  CONFLICT - {0} file(s) need your attention" -f $conflicts.Count) 'Red'
            foreach ($f in $conflicts) { Write-Line "  #    $f" 'Red' }
            Write-Line '  ###############################################################' 'Red'
            Write-Line ''
            Write-Line '  The conflict has been left in place on purpose - resolve it here:' 'Yellow'
            Write-Line '      git status                    # the conflicted files' 'Yellow'
            Write-Line '      <edit them, remove the <<<<<<< ======= >>>>>>> markers>' 'Yellow'
            Write-Line '      git add <files>' 'Yellow'
            if ($Rebase) {
                Write-Line '      git rebase --continue         # finishes the rebase' 'Yellow'
                Write-Line ''
                Write-Line '  Changed your mind? This puts you back exactly where you were:' 'Yellow'
                Write-Line "      git rebase --abort            # returns you to '$branch' untouched" 'Yellow'
                Write-Line '  (until then you are in a detached "rebase in progress" state - normal)' 'DarkGray'
            } else {
                Write-Line '      git commit                    # completes the merge' 'Yellow'
                Write-Line ''
                Write-Line '  Changed your mind? This puts you back exactly where you were:' 'Yellow'
                Write-Line "      git merge --abort             # returns '$branch' to its previous state" 'Yellow'
            }
            Show-StashReminder
        } else {
            Write-Fail "$operation failed:`n$($result.Text)"
            Write-Line '  Nothing was left half-done; check the message above.' 'Red'
        }
    }

    if ($Push -and -not $conflictInPlace -and $exitCode -eq 0) {
        Write-Section 'Pushing'
        $upstream = Get-GitValue @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')
        if ($upstream) {
            $p = Invoke-Git @('push', $Remote, $branch)
        } else {
            Write-Info "'$branch' has no upstream yet - setting it to $Remote/$branch"
            $p = Invoke-Git @('push', '--set-upstream', $Remote, $branch)
        }
        if ($p.Ok) {
            Write-Ok "pushed '$branch' to $Remote"
        } else {
            Write-Fail "push failed:`n$($p.Text)"
            if ($Rebase) {
                Write-Line '  A rebase rewrites commits, so an already-pushed branch will be rejected.' 'Yellow'
                Write-Line "  If you are the only one on '$branch':  git push --force-with-lease $Remote $branch" 'Yellow'
            }
            $exitCode = 1
        }
    } elseif ($Push) {
        Write-Warn 'not pushing: the sync did not complete cleanly.'
    }

    Write-Section 'Summary'
    if ($exitCode -eq 0) {
        Write-Line ("  {0,-14} {1}" -f 'branch', $branch) 'Green'
        Write-Line ("  {0,-14} {1}" -f $operation, "$target merged in ($behind commit(s))") 'Green'
        Write-Line ("  {0,-14} {1}" -f 'HEAD', (Get-ShortCommit 'HEAD')) 'Green'
        if (-not $Push) {
            Write-Line ''
            Write-Line "  Nothing was pushed. When you are ready:  git push $Remote $branch" 'Cyan'
        }
    } else {
        Write-Line ("  {0,-14} {1}" -f 'branch', $branch) 'Red'
        Write-Line ("  {0,-14} {1}" -f 'result', "$operation FAILED - see above") 'Red'
    }
}
finally {
    $popFailed = $false
    # The stash is only restored when the tree is in a fit state to receive it.
    if ($stashRef -and -not $conflictInPlace) {
        $pop = Invoke-Git @('stash', 'pop')
        Write-Line ''
        if ($pop.Ok) {
            Write-Line '  Stashed changes restored.' 'Cyan'
        } else {
            Write-Line '  ###############################################################' 'Red'
            Write-Line '  #  COULD NOT RESTORE YOUR STASH - your work is NOT lost.' 'Red'
            Write-Line '  ###############################################################' 'Red'
            Write-Line "  $($pop.Text)" 'Red'
            foreach ($f in (Get-ConflictedFiles)) { Write-Line "      conflicted: $f" 'Red' }
            Write-Line '  Recover it with:' 'Yellow'
            Write-Line '      git stash list                # your entry is "sync_me auto-stash ..."' 'Yellow'
            Write-Line '      git stash show -p stash@{0}   # see what is in it' 'Yellow'
            Write-Line '      git stash pop                 # retry, then resolve the conflicts' 'Yellow'
            Write-Line '      git checkout --theirs <file>  # or resolve them by hand' 'Yellow'
            $exitCode  = 1
            $popFailed = $true
        }
    }
    Set-Location -LiteralPath $originalCwd
    # The try block may have exited with 0 already (e.g. "already up to date");
    # a failed stash restore still has to be reported as a failure.
    if ($popFailed) { exit 1 }
}

exit $exitCode
