#!/usr/bin/env bash
#
# merge_all.sh - merge every team branch (local + origin/*) into main.
#
# Parity version of scripts/merge_all.ps1 for macOS / Linux teammates: same
# flags, same checks, same outcome, same exit codes.
#
# Written for bash 3.2 (the /bin/bash shipped with macOS): no associative
# arrays, no mapfile, explicit element counters instead of "${arr[@]}".

set -euo pipefail

MAIN_BRANCH="main"
REMOTE="origin"

DRY_RUN=0
DO_PUSH=0
DO_STASH=0
STOP_ON_CONFLICT=0

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

say()      { printf '%s\n' "$1"; }
colour()   { printf '%s%s%s\n' "$1" "$2" "$C_RESET"; }
section()  { printf '\n%s== %s%s\n' "$C_CYAN" "$1" "$C_RESET"; }
ok()       { colour "$C_GREEN"  "  OK    $1"; }
info()     { colour "$C_GREY"   "  ..    $1"; }
warn()     { colour "$C_YELLOW" "  WARN  $1"; }
fail()     { colour "$C_RED"    "  FAIL  $1"; }

show_help() {
    cat <<EOF
merge_all.sh - merge every branch into '$MAIN_BRANCH'

USAGE
    ./scripts/merge_all.sh [--dry-run] [--push] [--stash] [--stop-on-conflict] [--help]

FLAGS
    --dry-run           Show exactly which branches would be merged and stop.
                        No checkout, no merge, no commit, no push.
                        (It does run 'git fetch --all --prune' so the preview
                        includes branches your teammates pushed since last time;
                        that only updates $REMOTE/* tracking refs.)
    --push              Push the resulting '$MAIN_BRANCH' to '$REMOTE' at the end.
                        Default: nothing is pushed.
    --stash             Auto-stash uncommitted changes (including untracked
                        files) instead of aborting, and restore them at the end.
    --stop-on-conflict  Stop at the first conflict and leave it in the working
                        tree for manual resolution. Default: abort that one
                        merge, record it as failed, carry on with the others.
    -h, --help          This text.

WHAT IT DOES
    1. Safety checks: inside a git repo, no merge/rebase in progress, clean tree.
    2. Remembers the branch you were on and returns you to it at the end.
    3. git fetch --all --prune
    4. Collects every local branch and every $REMOTE/* branch except
       '$MAIN_BRANCH' and $REMOTE/HEAD, de-duplicated.
    5. Fast-forwards '$MAIN_BRANCH' from $REMOTE/$MAIN_BRANCH.
    6. git merge --no-ff --no-edit <branch> for each remaining branch.
    7. Prints a summary table and exits non-zero if anything failed.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)          DRY_RUN=1 ;;
        --push)             DO_PUSH=1 ;;
        --stash)            DO_STASH=1 ;;
        --stop-on-conflict) STOP_ON_CONFLICT=1 ;;
        -h|--help)          show_help; exit 0 ;;
        *)
            fail "unknown option: $1"
            say ""
            show_help
            exit 2
            ;;
    esac
    shift
done

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

ref_exists()  { git_run rev-parse --verify --quiet "$1^{commit}"; return $GIT_RC; }
is_ancestor() { git_run merge-base --is-ancestor "$1" "$2"; return $GIT_RC; }
short_commit() { git_value log -1 --format='%h %s' "$1"; }

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

ORIGINAL_CWD="$(pwd)"
STARTING_BRANCH=""
STASH_REF=""
LEAVE_AS_IS=0
EXIT_CODE=0
GIT_DIR=""

RES_NAME=(); RES_STATUS=(); RES_DETAIL=(); RES_COUNT=0
add_result() {
    RES_NAME[$RES_COUNT]="$1"
    RES_STATUS[$RES_COUNT]="$2"
    RES_DETAIL[$RES_COUNT]="$3"
    RES_COUNT=$((RES_COUNT + 1))
}

show_summary() {
    section "Summary"
    if [ "$RES_COUNT" -eq 0 ]; then
        colour "$C_GREY" "  (no branches to process)"
    fi

    local i=0 c failed=0
    while [ $i -lt "$RES_COUNT" ]; do
        case "${RES_STATUS[$i]}" in
            merged|"would merge") c="$C_GREEN" ;;
            "up to date")         c="$C_GREY" ;;
            conflict|error)       c="$C_RED"; failed=$((failed + 1)) ;;
            *)                    c="$C_YELLOW" ;;
        esac
        printf '%s  %-32s %-14s %s%s\n' "$c" "${RES_NAME[$i]}" "${RES_STATUS[$i]}" "${RES_DETAIL[$i]}" "$C_RESET"
        i=$((i + 1))
    done

    say ""
    if ref_exists "$MAIN_BRANCH"; then
        colour "$C_CYAN" "  $MAIN_BRANCH is now at: $(short_commit "$MAIN_BRANCH")"
    fi

    if [ "$failed" -gt 0 ]; then
        say ""
        colour "$C_RED" "  ###############################################################"
        colour "$C_RED" "  #  $failed BRANCH(ES) DID NOT MAKE IT INTO $MAIN_BRANCH"
        i=0
        while [ $i -lt "$RES_COUNT" ]; do
            case "${RES_STATUS[$i]}" in
                conflict|error) colour "$C_RED" "  #    - ${RES_NAME[$i]} (${RES_STATUS[$i]})" ;;
            esac
            i=$((i + 1))
        done
        colour "$C_RED" "  #  Fix them manually:  git merge <branch>   then resolve"
        colour "$C_RED" "  ###############################################################"
    elif [ "$DRY_RUN" -eq 0 ]; then
        colour "$C_GREEN" "  All branches are in main."
    fi
}

cleanup() {
    local rc=$?
    if [ "$DRY_RUN" -eq 0 ] && [ "$LEAVE_AS_IS" -eq 0 ]; then
        if [ -n "$STARTING_BRANCH" ] && [ "$(git_value symbolic-ref --quiet --short HEAD)" != "$STARTING_BRANCH" ]; then
            git_run checkout "$STARTING_BRANCH"
            say ""
            if [ "$GIT_RC" -eq 0 ]; then
                colour "$C_CYAN" "  Back on '$STARTING_BRANCH'."
            else
                colour "$C_RED" "  Could not return to '$STARTING_BRANCH':"
                colour "$C_RED" "  $GIT_OUT"
            fi
        fi
        if [ -n "$STASH_REF" ]; then
            git_run stash pop
            if [ "$GIT_RC" -eq 0 ]; then
                colour "$C_CYAN" "  Stashed changes restored."
            else
                colour "$C_RED" "  Could not restore your stash automatically - it is safe in 'git stash list':"
                colour "$C_RED" "  $GIT_OUT"
            fi
        fi
    fi
    cd "$ORIGINAL_CWD" 2>/dev/null || true
    return $rc
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Branch discovery
# ---------------------------------------------------------------------------

REMOTE_SHORT=(); REMOTE_REF=(); REMOTE_COUNT=0
CAND_NAME=(); CAND_REF=(); CAND_SRC=(); CAND_COUNT=0
CONSUMED=""

is_consumed() { case "$CONSUMED" in *"|$1|"*) return 0 ;; *) return 1 ;; esac; }

lookup_remote() {
    local i=0
    while [ $i -lt "$REMOTE_COUNT" ]; do
        if [ "${REMOTE_SHORT[$i]}" = "$1" ]; then
            printf '%s' "${REMOTE_REF[$i]}"
            return 0
        fi
        i=$((i + 1))
    done
}

add_candidate() {
    CAND_NAME[$CAND_COUNT]="$1"
    CAND_REF[$CAND_COUNT]="$2"
    CAND_SRC[$CAND_COUNT]="$3"
    CAND_COUNT=$((CAND_COUNT + 1))
}

discover_branches() {
    local ref short local_branch upstream remote_ref line i

    while IFS= read -r ref; do
        [ -n "$ref" ] || continue
        short="${ref#$REMOTE/}"
        if [ "$short" = "HEAD" ] || [ "$short" = "$MAIN_BRANCH" ]; then continue; fi
        REMOTE_SHORT[$REMOTE_COUNT]="$short"
        REMOTE_REF[$REMOTE_COUNT]="$ref"
        REMOTE_COUNT=$((REMOTE_COUNT + 1))
    done < <(git for-each-ref --format='%(refname:short)' "refs/remotes/$REMOTE")

    while IFS= read -r line; do
        [ -n "$line" ] || continue
        local_branch="${line%%	*}"
        upstream="${line#*	}"
        [ "$upstream" = "$line" ] && upstream=""
        [ "$local_branch" = "$MAIN_BRANCH" ] && continue

        # A branch usually exists twice (Kat and origin/Kat). Merging both would
        # create a pointless extra merge commit, so pick one: the remote-tracking
        # ref when it already contains the local tip (teammate pushed newer work),
        # otherwise the local ref (we have commits that were never pushed).
        remote_ref=""
        case "$upstream" in
            "$REMOTE"/*)
                if [ -n "$(lookup_remote "${upstream#$REMOTE/}")" ]; then
                    remote_ref="$upstream"
                fi
                ;;
        esac
        if [ -z "$remote_ref" ]; then
            remote_ref="$(lookup_remote "$local_branch")"
        fi

        if [ -n "$remote_ref" ]; then
            CONSUMED="$CONSUMED|$remote_ref|"
            if is_ancestor "$local_branch" "$remote_ref"; then
                add_candidate "$local_branch" "$remote_ref" "remote"
                continue
            fi
        fi
        add_candidate "$local_branch" "$local_branch" "local"
    done < <(git for-each-ref --format='%(refname:short)%09%(upstream:short)' refs/heads)

    i=0
    while [ $i -lt "$REMOTE_COUNT" ]; do
        if ! is_consumed "${REMOTE_REF[$i]}"; then
            add_candidate "${REMOTE_SHORT[$i]}" "${REMOTE_REF[$i]}" "remote-only"
        fi
        i=$((i + 1))
    done
}

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
[ -n "$REPO_ROOT" ] && cd "$REPO_ROOT"

say ""
colour "$C_WHITE" "merge_all - merging every branch into '$MAIN_BRANCH'"
colour "$C_GREY"  "repository: $REPO_ROOT"
[ "$DRY_RUN" -eq 1 ] && colour "$C_YELLOW" "MODE: DRY RUN - nothing will be modified"

section "Pre-flight checks"

GIT_DIR="$(git_value rev-parse --git-dir)"
IN_PROGRESS=""
[ -e "$GIT_DIR/MERGE_HEAD" ]       && IN_PROGRESS="A merge"
[ -e "$GIT_DIR/rebase-merge" ]     && IN_PROGRESS="A rebase"
[ -e "$GIT_DIR/rebase-apply" ]     && IN_PROGRESS="A rebase/am"
[ -e "$GIT_DIR/CHERRY_PICK_HEAD" ] && IN_PROGRESS="A cherry-pick"
[ -e "$GIT_DIR/REVERT_HEAD" ]      && IN_PROGRESS="A revert"

if [ -n "$IN_PROGRESS" ]; then
    fail "$IN_PROGRESS is already in progress in this repository."
    colour "$C_RED" "        Finish it or abort it first:"
    colour "$C_RED" "            git status"
    colour "$C_RED" "            git merge --abort      # or: git rebase --abort"
    exit 2
fi
ok "no merge/rebase in progress"

DIRTY="$(git_value status --porcelain)"
DIRTY_COUNT=0
[ -n "$DIRTY" ] && DIRTY_COUNT="$(printf '%s\n' "$DIRTY" | wc -l | tr -d ' ')"

if [ "$DIRTY_COUNT" -gt 0 ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
        warn "working tree has $DIRTY_COUNT uncommitted change(s); a real run would abort (use --stash)."
    elif [ "$DO_STASH" -eq 1 ]; then
        STASH_BEFORE="$(git_value rev-parse --verify --quiet refs/stash)"
        git_run stash push --include-untracked --message "merge_all auto-stash $(date '+%Y-%m-%d %H:%M:%S')"
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

STARTING_BRANCH="$(git_value symbolic-ref --quiet --short HEAD)"
if [ -z "$STARTING_BRANCH" ]; then
    STARTING_BRANCH="$(git_value rev-parse HEAD)"
    warn "detached HEAD; will return to commit $STARTING_BRANCH"
else
    ok "starting branch recorded: $STARTING_BRANCH"
fi

section "Fetching"
git_run fetch --all --prune
if [ "$GIT_RC" -eq 0 ]; then
    ok "git fetch --all --prune"
else
    warn "fetch failed (offline?), continuing with what is already local:"
    say "$GIT_OUT"
fi

# main may not exist locally yet on a fresh clone of someone else's fork.
if ! ref_exists "$MAIN_BRANCH"; then
    if ref_exists "$REMOTE/$MAIN_BRANCH"; then
        if [ "$DRY_RUN" -eq 1 ]; then
            warn "local '$MAIN_BRANCH' does not exist; a real run would create it from $REMOTE/$MAIN_BRANCH"
        else
            git_run branch "$MAIN_BRANCH" "$REMOTE/$MAIN_BRANCH"
            if [ "$GIT_RC" -ne 0 ]; then
                fail "could not create '$MAIN_BRANCH':"
                say "$GIT_OUT"
                exit 2
            fi
            ok "created local '$MAIN_BRANCH' from $REMOTE/$MAIN_BRANCH"
        fi
    else
        fail "no '$MAIN_BRANCH' branch locally or on $REMOTE."
        exit 2
    fi
fi

section "Branches to merge"
discover_branches
if [ "$CAND_COUNT" -eq 0 ]; then
    info "nothing but '$MAIN_BRANCH' exists - nothing to do."
fi
i=0
while [ $i -lt "$CAND_COUNT" ]; do
    info "$(printf '%-32s -> %s' "${CAND_REF[$i]}" "${CAND_SRC[$i]}")"
    i=$((i + 1))
done

if [ "$DRY_RUN" -eq 1 ]; then
    section "Dry run plan"

    # Preview against the tip main *would* have after the fast-forward.
    BASE_TIP="$MAIN_BRANCH"
    if ref_exists "$REMOTE/$MAIN_BRANCH" && is_ancestor "$MAIN_BRANCH" "$REMOTE/$MAIN_BRANCH"; then
        BASE_TIP="$REMOTE/$MAIN_BRANCH"
        info "$MAIN_BRANCH would fast-forward to $REMOTE/$MAIN_BRANCH ($(short_commit "$BASE_TIP"))"
    fi

    PLANNED=(); PLANNED_COUNT=0
    i=0
    while [ $i -lt "$CAND_COUNT" ]; do
        if is_ancestor "${CAND_REF[$i]}" "$BASE_TIP"; then
            add_result "${CAND_NAME[$i]}" "up to date" "already in main"
        else
            # A branch contained in one we are about to merge will be up to date
            # by the time its turn comes, so report it the same way.
            swallowed=0
            j=0
            while [ $j -lt "$PLANNED_COUNT" ]; do
                if is_ancestor "${CAND_REF[$i]}" "${PLANNED[$j]}"; then swallowed=1; break; fi
                j=$((j + 1))
            done
            if [ "$swallowed" -eq 1 ]; then
                add_result "${CAND_NAME[$i]}" "up to date" "contained in another branch being merged"
            else
                PLANNED[$PLANNED_COUNT]="${CAND_REF[$i]}"
                PLANNED_COUNT=$((PLANNED_COUNT + 1))
                add_result "${CAND_NAME[$i]}" "would merge" "$(short_commit "${CAND_REF[$i]}")"
            fi
        fi
        i=$((i + 1))
    done

    show_summary
    say ""
    colour "$C_YELLOW" "  Dry run: no checkout, no merge, no push was performed."
    colour "$C_YELLOW" "  Run the same command without --dry-run to apply it."
    exit 0
fi

section "Preparing '$MAIN_BRANCH'"
git_run checkout "$MAIN_BRANCH"
if [ "$GIT_RC" -ne 0 ]; then
    fail "could not checkout '$MAIN_BRANCH':"
    say "$GIT_OUT"
    exit 2
fi
ok "on '$MAIN_BRANCH'"

git_run pull --ff-only "$REMOTE" "$MAIN_BRANCH"
if [ "$GIT_RC" -eq 0 ]; then
    ok "fast-forwarded from $REMOTE/$MAIN_BRANCH"
else
    # Expected when the remote has no main yet, or when local main already
    # carries commits that were never pushed. Neither should stop the merges.
    warn "could not fast-forward from $REMOTE/$MAIN_BRANCH (continuing):"
    say "$GIT_OUT"
fi

section "Merging"
i=0
while [ $i -lt "$CAND_COUNT" ]; do
    name="${CAND_NAME[$i]}"
    ref="${CAND_REF[$i]}"
    i=$((i + 1))

    if is_ancestor "$ref" "$MAIN_BRANCH"; then
        colour "$C_GREY" "$(printf '  --    %-32s already up to date' "$ref")"
        add_result "$name" "up to date" "already in main"
        continue
    fi

    info "merging $ref ..."
    git_run merge --no-ff --no-edit "$ref"
    if [ "$GIT_RC" -eq 0 ]; then
        ok "$ref merged -> $(short_commit "$MAIN_BRANCH")"
        add_result "$name" "merged" "$(short_commit "$MAIN_BRANCH")"
        continue
    fi
    MERGE_OUT="$GIT_OUT"

    CONFLICTS="$(git_value diff --name-only --diff-filter=U)"
    if [ -n "$CONFLICTS" ]; then
        CONFLICT_COUNT="$(printf '%s\n' "$CONFLICTS" | wc -l | tr -d ' ')"
        fail "CONFLICT merging $ref - $CONFLICT_COUNT file(s):"
        printf '%s\n' "$CONFLICTS" | while IFS= read -r f; do colour "$C_RED" "          $f"; done || true

        if [ "$STOP_ON_CONFLICT" -eq 1 ]; then
            say ""
            colour "$C_YELLOW" "  Stopping here (--stop-on-conflict). The conflict is left in place."
            colour "$C_YELLOW" "  To finish by hand:"
            colour "$C_YELLOW" "      git status                       # see the conflicted files"
            colour "$C_YELLOW" "      <edit files, remove <<<< ==== >>>> markers>"
            colour "$C_YELLOW" "      git add <files>"
            colour "$C_YELLOW" "      git commit                       # completes the merge"
            colour "$C_YELLOW" "  Or give up on this one:  git merge --abort"
            if [ -n "$STASH_REF" ]; then
                colour "$C_YELLOW" "  NOTE: your stashed changes are still stashed - 'git stash pop' when done."
            fi
            colour "$C_YELLOW" "  You are on '$MAIN_BRANCH' (started on '$STARTING_BRANCH')."
            add_result "$name" "conflict" "$CONFLICT_COUNT file(s), left for manual resolution"
            LEAVE_AS_IS=1
            EXIT_CODE=1
            break
        fi

        git_run merge --abort
        if [ "$GIT_RC" -eq 0 ]; then
            warn "merge of $ref aborted; continuing with the other branches"
        else
            fail "could not abort the merge of $ref:"
            say "$GIT_OUT"
            add_result "$name" "error" "merge --abort failed - repo needs manual attention"
            LEAVE_AS_IS=1
            EXIT_CODE=1
            break
        fi
        add_result "$name" "conflict" "$CONFLICT_COUNT: $(printf '%s' "$CONFLICTS" | tr '\n' ' ')"
        EXIT_CODE=1
        continue
    fi

    fail "merge of $ref failed:"
    say "$MERGE_OUT"
    if [ -e "$GIT_DIR/MERGE_HEAD" ]; then git_run merge --abort; fi
    add_result "$name" "error" "$(printf '%s' "$MERGE_OUT" | head -n 1 || true)"
    EXIT_CODE=1
done

if [ "$DO_PUSH" -eq 1 ] && [ "$LEAVE_AS_IS" -eq 0 ]; then
    section "Pushing"
    if [ "$EXIT_CODE" -ne 0 ]; then
        warn "some branches failed; pushing the successful merges anyway"
    fi
    git_run push "$REMOTE" "$MAIN_BRANCH"
    if [ "$GIT_RC" -eq 0 ]; then
        ok "pushed $MAIN_BRANCH to $REMOTE"
    else
        fail "push failed:"
        say "$GIT_OUT"
        EXIT_CODE=1
    fi
elif [ "$DO_PUSH" -eq 1 ]; then
    warn "not pushing: the repository was left mid-merge on purpose."
fi

show_summary
if [ "$DO_PUSH" -eq 0 ] && [ "$LEAVE_AS_IS" -eq 0 ]; then
    say ""
    colour "$C_CYAN" "  Nothing was pushed. When you are happy:  git push $REMOTE $MAIN_BRANCH"
fi

exit $EXIT_CODE
