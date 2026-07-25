#!/usr/bin/env bash
#
# sync_me.sh - bring origin/main into the branch you are working on.
#
# The mirror image of scripts/merge_all.sh: merge_all pushes everybody's work
# INTO main, sync_me brings main back INTO your own branch. Run it every 30
# minutes so the team integrates in small steps instead of one huge conflict.
#
# Parity version of scripts/sync_me.ps1: same flags, same checks, same outcome,
# same exit codes. Written for bash 3.2 (the /bin/bash shipped with macOS): no
# associative arrays, no mapfile.

set -euo pipefail

MAIN_BRANCH="main"
REMOTE="origin"

DRY_RUN=0
DO_PUSH=0
DO_STASH=0
DO_REBASE=0

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
    C_RESET=$'\033[0m'
    C_RED=$'\033[1;31m'
    C_GREEN=$'\033[32m'
    C_YELLOW=$'\033[33m'
    C_CYAN=$'\033[36m'
    C_GREY=$'\033[90m'
    C_WHITE=$'\033[97m'
else
    C_RESET=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""; C_GREY=""; C_WHITE=""
fi

say()     { printf '%s\n' "$1"; }
colour()  { printf '%s%s%s\n' "$1" "$2" "$C_RESET"; }
section() { printf '\n%s== %s%s\n' "$C_CYAN" "$1" "$C_RESET"; }
ok()      { colour "$C_GREEN"  "  OK    $1"; }
info()    { colour "$C_GREY"   "  ..    $1"; }
warn()    { colour "$C_YELLOW" "  WARN  $1"; }
fail()    { colour "$C_RED"    "  FAIL  $1"; }

show_help() {
    cat <<EOF
sync_me.sh - bring '$REMOTE/$MAIN_BRANCH' into the branch you are working on

USAGE
    ./scripts/sync_me.sh [--dry-run] [--rebase] [--push] [--stash] [--help]

FLAGS
    --dry-run   Report how far behind '$REMOTE/$MAIN_BRANCH' you are, list those
                commits and the files they touch, then stop. Changes nothing.
                (It does run 'git fetch $REMOTE $MAIN_BRANCH --prune' so the
                report is accurate; that only updates $REMOTE/* tracking refs.)
    --rebase    Rebase your branch onto $REMOTE/$MAIN_BRANCH instead of merging.
                Cleaner history, but rewrites your commits - only use it if your
                branch is not shared, or be ready to force-push.
    --push      Push your branch afterwards (sets the upstream on first push).
                Default: nothing is pushed.
    --stash     Auto-stash uncommitted changes (including untracked files)
                instead of aborting, and restore them at the end.
    -h, --help  This text.

WHAT IT DOES
    1. Safety checks: inside a git repo, no merge/rebase in progress, clean tree,
       and you are NOT on '$MAIN_BRANCH' (use merge_all.sh for that direction).
    2. git fetch $REMOTE $MAIN_BRANCH --prune
    3. Exits straight away if you are already up to date - no empty merge commit.
    4. git merge --no-edit $REMOTE/$MAIN_BRANCH  (or git rebase $REMOTE/$MAIN_BRANCH)
    5. On conflict: leaves it in place for you to resolve, prints the exact
       commands to finish or to bail out, and exits non-zero.

    You stay on your own branch the whole time.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)  DRY_RUN=1 ;;
        --rebase)   DO_REBASE=1 ;;
        --push)     DO_PUSH=1 ;;
        --stash)    DO_STASH=1 ;;
        -h|--help)  show_help; exit 0 ;;
        *)
            fail "unknown option: $1"
            say ""
            show_help
            exit 2
            ;;
    esac
    shift
done

OPERATION="merge"
if [ "$DO_REBASE" -eq 1 ]; then OPERATION="rebase"; fi

# ---------------------------------------------------------------------------
# git plumbing - git returns non-zero for expected situations (conflict, "not
# an ancestor", ...), so exit codes are inspected instead of letting set -e fire.
# ---------------------------------------------------------------------------

GIT_OUT=""
GIT_RC=0

git_run() {
    set +e
    GIT_OUT="$(git "$@" 2>&1)"
    GIT_RC=$?
    set -e
}

git_value() {
    git_run "$@"
    if [ "$GIT_RC" -eq 0 ]; then
        printf '%s' "$GIT_OUT"
    fi
}

ref_exists()   { git_run rev-parse --verify --quiet "$1^{commit}"; return $GIT_RC; }
short_commit() { git_value log -1 --format='%h %s' "$1"; }
conflicted_files() { git_value diff --name-only --diff-filter=U; }

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

ORIGINAL_CWD="$(pwd)"
BRANCH=""
STASH_REF=""
CONFLICT_IN_PLACE=0
EXIT_CODE=0
TARGET="$REMOTE/$MAIN_BRANCH"

stash_reminder() {
    if [ -z "$STASH_REF" ]; then return 0; fi
    say ""
    colour "$C_YELLOW" "  YOUR UNCOMMITTED WORK IS STILL IN THE STASH - it was not restored,"
    colour "$C_YELLOW" "  because dropping it on top of a conflicted tree would make things worse."
    colour "$C_YELLOW" "  Once the conflict is resolved and committed:"
    colour "$C_YELLOW" "      git stash list      # your entry is the one labelled \"sync_me auto-stash\""
    colour "$C_YELLOW" "      git stash pop"
}

cleanup() {
    local rc=$?
    # The stash is only restored when the tree is in a fit state to receive it.
    if [ -n "$STASH_REF" ] && [ "$CONFLICT_IN_PLACE" -eq 0 ]; then
        git_run stash pop
        say ""
        if [ "$GIT_RC" -eq 0 ]; then
            colour "$C_CYAN" "  Stashed changes restored."
        else
            colour "$C_RED" "  ###############################################################"
            colour "$C_RED" "  #  COULD NOT RESTORE YOUR STASH - your work is NOT lost."
            colour "$C_RED" "  ###############################################################"
            colour "$C_RED" "  $GIT_OUT"
            conflicted_files | while IFS= read -r f; do
                if [ -n "$f" ]; then colour "$C_RED" "      conflicted: $f"; fi
            done || true
            colour "$C_YELLOW" "  Recover it with:"
            colour "$C_YELLOW" "      git stash list                # your entry is \"sync_me auto-stash ...\""
            colour "$C_YELLOW" "      git stash show -p stash@{0}   # see what is in it"
            colour "$C_YELLOW" "      git stash pop                 # retry, then resolve the conflicts"
            colour "$C_YELLOW" "      git checkout --theirs <file>  # or resolve them by hand"
            rc=1
        fi
    fi
    cd "$ORIGINAL_CWD" 2>/dev/null || true
    exit $rc
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if ! command -v git >/dev/null 2>&1; then
    fail "git is not on PATH."
    exit 2
fi

if [ "$(git_value rev-parse --is-inside-work-tree)" != "true" ]; then
    fail "Not inside a git repository ($ORIGINAL_CWD)."
    exit 2
fi

REPO_ROOT="$(git_value rev-parse --show-toplevel)"
if [ -n "$REPO_ROOT" ]; then cd "$REPO_ROOT"; fi

say ""
colour "$C_WHITE" "sync_me - bringing '$TARGET' into your branch"
colour "$C_GREY"  "repository: $REPO_ROOT"
if [ "$DRY_RUN" -eq 1 ]; then colour "$C_YELLOW" "MODE: DRY RUN - nothing will be modified"; fi

section "Pre-flight checks"

GIT_DIR="$(git_value rev-parse --git-dir)"
IN_PROGRESS=""
if [ -e "$GIT_DIR/MERGE_HEAD" ];       then IN_PROGRESS="A merge"; fi
if [ -e "$GIT_DIR/rebase-merge" ];     then IN_PROGRESS="A rebase"; fi
if [ -e "$GIT_DIR/rebase-apply" ];     then IN_PROGRESS="A rebase/am"; fi
if [ -e "$GIT_DIR/CHERRY_PICK_HEAD" ]; then IN_PROGRESS="A cherry-pick"; fi
if [ -e "$GIT_DIR/REVERT_HEAD" ];      then IN_PROGRESS="A revert"; fi

if [ -n "$IN_PROGRESS" ]; then
    fail "$IN_PROGRESS is already in progress in this repository."
    colour "$C_RED" "        Finish it or abort it first:"
    colour "$C_RED" "            git status"
    colour "$C_RED" "            git merge --abort      # or: git rebase --abort"
    exit 2
fi
ok "no merge/rebase in progress"

BRANCH="$(git_value symbolic-ref --quiet --short HEAD)"
if [ -z "$BRANCH" ]; then
    fail "detached HEAD - you are not on a branch, so there is nothing to sync."
    colour "$C_RED" "        Check out your branch first:  git checkout <your-branch>"
    exit 2
fi

if [ "$BRANCH" = "$MAIN_BRANCH" ]; then
    fail "you are on '$MAIN_BRANCH'. sync_me pulls $MAIN_BRANCH INTO a feature branch."
    colour "$C_RED" "        To pull everyone else's branches into main, use the other script:"
    colour "$C_RED" "            ./scripts/merge_all.sh --dry-run     # preview"
    colour "$C_RED" "            ./scripts/merge_all.sh               # do it"
    colour "$C_RED" "        Or switch to your own branch first:  git checkout <your-branch>"
    exit 2
fi
ok "current branch: $BRANCH (never left by this script)"

DIRTY="$(git_value status --porcelain)"
DIRTY_COUNT=0
if [ -n "$DIRTY" ]; then DIRTY_COUNT="$(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ')"; fi

if [ "$DIRTY_COUNT" -gt 0 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
        warn "working tree has $DIRTY_COUNT uncommitted change(s); a real run would abort (use --stash)."
    elif [ "$DO_STASH" -eq 1 ]; then
        STASH_BEFORE="$(git_value rev-parse --verify --quiet refs/stash)"
        git_run stash push --include-untracked --message "sync_me auto-stash $(date '+%Y-%m-%d %H:%M:%S')"
        if [ "$GIT_RC" -ne 0 ]; then
            fail "could not stash local changes:"
            say "$GIT_OUT"
            exit 2
        fi
        STASH_AFTER="$(git_value rev-parse --verify --quiet refs/stash)"
        if [ -n "$STASH_AFTER" ] && [ "$STASH_AFTER" != "$STASH_BEFORE" ]; then
            STASH_REF="$STASH_AFTER"
            ok "stashed $DIRTY_COUNT local change(s); they will be restored at the end"
        fi
    else
        fail "working tree is dirty - $DIRTY_COUNT uncommitted change(s)."
        printf '%s\n' "$DIRTY" | head -n 10 | while IFS= read -r l; do colour "$C_RED" "          $l"; done || true
        colour "$C_RED" "        Commit them, or re-run with --stash to park them automatically."
        exit 2
    fi
else
    ok "working tree is clean"
fi

section "Fetching"
git_run fetch "$REMOTE" "$MAIN_BRANCH" --prune
if [ "$GIT_RC" -eq 0 ]; then
    ok "git fetch $REMOTE $MAIN_BRANCH --prune"
else
    warn "fetch failed (offline?), using the $TARGET we already have:"
    say "$GIT_OUT"
fi

if ! ref_exists "$TARGET"; then
    fail "$TARGET does not exist - nothing to sync from."
    exit 2
fi

section "Status"
BEHIND="$(git_value rev-list --count "HEAD..$TARGET")"
AHEAD="$(git_value rev-list --count "$TARGET..HEAD")"
if [ -z "$BEHIND" ]; then BEHIND=0; fi
if [ -z "$AHEAD" ]; then AHEAD=0; fi
info "$TARGET is at $(short_commit "$TARGET")"
info "your branch '$BRANCH' is $AHEAD commit(s) ahead, $BEHIND commit(s) behind"

if [ "$BEHIND" -eq 0 ]; then
    say ""
    ok "'$BRANCH' is already up to date with $TARGET - nothing to do."
    colour "$C_GREY" "  (no empty merge commit was created)"
    exit 0
fi

if [ "$DRY_RUN" -eq 1 ]; then
    section "Dry run - what $OPERATION would bring in"
    colour "$C_WHITE" "  $BEHIND commit(s) from $TARGET :"
    git_value log --oneline "HEAD..$TARGET" | while IFS= read -r l; do
        if [ -n "$l" ]; then colour "$C_GREEN" "      $l"; fi
    done || true

    # Three-dot: what main gained since your branch left it, i.e. the files the
    # merge would actually bring in (not your own edits).
    FILES="$(git_value diff --name-status "HEAD...$TARGET")"
    FILE_COUNT=0
    if [ -n "$FILES" ]; then FILE_COUNT="$(printf '%s\n' "$FILES" | wc -l | tr -d ' ')"; fi
    say ""
    colour "$C_WHITE" "  $FILE_COUNT file(s) would be touched:"
    if [ -n "$FILES" ]; then
        printf '%s\n' "$FILES" | while IFS= read -r f; do colour "$C_CYAN" "      $f"; done || true
    fi

    say ""
    colour "$C_YELLOW" "  Dry run: no merge, no rebase, no commit, no push was performed."
    colour "$C_YELLOW" "  Run the same command without --dry-run to apply it."
    exit 0
fi

section "Syncing ($OPERATION)"
if [ "$DO_REBASE" -eq 1 ]; then
    git_run rebase "$TARGET"
else
    git_run merge --no-edit "$TARGET"
fi
SYNC_RC=$GIT_RC
SYNC_OUT="$GIT_OUT"

if [ "$SYNC_RC" -eq 0 ]; then
    ok "$OPERATION done - '$BRANCH' now contains $TARGET"
    info "HEAD is at $(short_commit HEAD)"
else
    EXIT_CODE=1
    CONFLICTS="$(conflicted_files)"
    if [ -n "$CONFLICTS" ]; then
        CONFLICT_IN_PLACE=1
        CONFLICT_COUNT="$(printf '%s\n' "$CONFLICTS" | wc -l | tr -d ' ')"
        say ""
        colour "$C_RED" "  ###############################################################"
        colour "$C_RED" "  #  CONFLICT - $CONFLICT_COUNT file(s) need your attention"
        printf '%s\n' "$CONFLICTS" | while IFS= read -r f; do colour "$C_RED" "  #    $f"; done || true
        colour "$C_RED" "  ###############################################################"
        say ""
        colour "$C_YELLOW" "  The conflict has been left in place on purpose - resolve it here:"
        colour "$C_YELLOW" "      git status                    # the conflicted files"
        colour "$C_YELLOW" "      <edit them, remove the <<<<<<< ======= >>>>>>> markers>"
        colour "$C_YELLOW" "      git add <files>"
        if [ "$DO_REBASE" -eq 1 ]; then
            colour "$C_YELLOW" "      git rebase --continue         # finishes the rebase"
            say ""
            colour "$C_YELLOW" "  Changed your mind? This puts you back exactly where you were:"
            colour "$C_YELLOW" "      git rebase --abort            # returns you to '$BRANCH' untouched"
            colour "$C_GREY"   "  (until then you are in a detached \"rebase in progress\" state - normal)"
        else
            colour "$C_YELLOW" "      git commit                    # completes the merge"
            say ""
            colour "$C_YELLOW" "  Changed your mind? This puts you back exactly where you were:"
            colour "$C_YELLOW" "      git merge --abort             # returns '$BRANCH' to its previous state"
        fi
        stash_reminder
    else
        fail "$OPERATION failed:"
        say "$SYNC_OUT"
        colour "$C_RED" "  Nothing was left half-done; check the message above."
    fi
fi

if [ "$DO_PUSH" -eq 1 ] && [ "$CONFLICT_IN_PLACE" -eq 0 ] && [ "$EXIT_CODE" -eq 0 ]; then
    section "Pushing"
    UPSTREAM="$(git_value rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')"
    if [ -n "$UPSTREAM" ]; then
        git_run push "$REMOTE" "$BRANCH"
    else
        info "'$BRANCH' has no upstream yet - setting it to $REMOTE/$BRANCH"
        git_run push --set-upstream "$REMOTE" "$BRANCH"
    fi
    if [ "$GIT_RC" -eq 0 ]; then
        ok "pushed '$BRANCH' to $REMOTE"
    else
        fail "push failed:"
        say "$GIT_OUT"
        if [ "$DO_REBASE" -eq 1 ]; then
            colour "$C_YELLOW" "  A rebase rewrites commits, so an already-pushed branch will be rejected."
            colour "$C_YELLOW" "  If you are the only one on '$BRANCH':  git push --force-with-lease $REMOTE $BRANCH"
        fi
        EXIT_CODE=1
    fi
elif [ "$DO_PUSH" -eq 1 ]; then
    warn "not pushing: the sync did not complete cleanly."
fi

section "Summary"
if [ "$EXIT_CODE" -eq 0 ]; then
    colour "$C_GREEN" "$(printf '  %-14s %s' 'branch' "$BRANCH")"
    colour "$C_GREEN" "$(printf '  %-14s %s' "$OPERATION" "$TARGET merged in ($BEHIND commit(s))")"
    colour "$C_GREEN" "$(printf '  %-14s %s' 'HEAD' "$(short_commit HEAD)")"
    if [ "$DO_PUSH" -eq 0 ]; then
        say ""
        colour "$C_CYAN" "  Nothing was pushed. When you are ready:  git push $REMOTE $BRANCH"
    fi
else
    colour "$C_RED" "$(printf '  %-14s %s' 'branch' "$BRANCH")"
    colour "$C_RED" "$(printf '  %-14s %s' 'result' "$OPERATION FAILED - see above")"
fi

exit $EXIT_CODE
