#!/usr/bin/env bash
# IS `main` KEEPING UP WITH `dev`?
#
# WHY THIS EXISTS. On 2026-10-20 `main` was found 131 commits behind `dev` — fourteen days of work,
# including five ledgers of fixes, sitting on the integration line while `main` still said
# 2026-10-12. Nothing was broken, and that is exactly the problem: a divergence like that is
# invisible until someone decides to release or to branch from `main`, and by then "merge dev into
# main" is a 10,000-line review that nobody reads. A release branch that is always ONE PR behind is
# reviewable; one that is a fortnight behind is a formality.
#
# The check is deliberately about the DISTANCE, not about the content: whether the commits are good
# is what CI on the PR is for. This only answers "has the release line been left behind?", so the
# answer fits in one number.
#
# Usage:
#   scripts/check-main-lag.sh [--max <n>] [--max-age <days>] [--fetch]
#     --max <n>         how many commits `main` may lag `dev` before this fails (default 40)
#     --max-age <days>  how many DAYS the oldest unmerged commit may sit before this fails (default 14)
#     --fetch           fetch both refs first (CI checks out one ref; a local run usually wants this)
#
# WHY THERE IS AN AGE BOUND AS WELL AS A COUNT BOUND (2026-10-27). The count was the wrong shape of
# number. Measured on this repository: 11, 34 and 155 commits in three consecutive weeks. A count
# bound calibrated in a quiet week (40) waves through two months of a busy one, and the same bound
# calibrated in a busy week fails during a quiet one — the number describes the author's throughput,
# not the thing that actually hurts. What hurts is TIME: this file already said it, "one that is a
# fortnight behind is a formality". So the contract is that sentence, two weeks, and the count stays
# only as a cheap second opinion.
#
# Exit: 0 within the bounds (prints the measurements), 1 beyond either, 2 the refs could not be read
#       at all (a check that cannot see the refs proves nothing).
set -u
# THE REPO IS THE CALLER'S, NOT THIS SCRIPT'S. `cd "$(dirname $BASH_SOURCE)/.."` would make the check
# answer about the takumi checkout it happens to live in — measured 2026-10-20: run from a scratch
# repository it reported TAKUMI's main/dev distance and cheerfully passed. A check that silently
# measures a different repository than the one you asked about is worse than no check.
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || {
  echo "check-main-lag: not inside a git repository" >&2
  exit 2
}
cd "$ROOT"

MAX=40
MAX_AGE=14
FETCH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max) MAX="${2:-}"; shift 2 ;;
    --max-age) MAX_AGE="${2:-}"; shift 2 ;;
    --fetch) FETCH=1; shift ;;
    -h | --help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$MAX" in '' | *[!0-9]*) echo "check-main-lag: --max wants a whole number, got '$MAX'" >&2; exit 2 ;; esac
case "$MAX_AGE" in '' | *[!0-9]*) echo "check-main-lag: --max-age wants a whole number of days, got '$MAX_AGE'" >&2; exit 2 ;; esac

if [ "$FETCH" -eq 1 ]; then
  git fetch --quiet origin main dev 2>/dev/null || git fetch --quiet github main dev 2>/dev/null || true
fi

# Prefer the remote-tracking refs: a local `main` nobody pulled is a worse answer than none.
pick() {
  for ref in "github/$1" "origin/$1" "$1"; do
    if git rev-parse --verify --quiet "$ref" >/dev/null; then printf '%s' "$ref"; return 0; fi
  done
  return 1
}
MAIN=$(pick main) || { echo "check-main-lag: no 'main' ref to compare (tried github/main, origin/main, main)" >&2; exit 2; }
DEV=$(pick dev) || { echo "check-main-lag: no 'dev' ref to compare (tried github/dev, origin/dev, dev)" >&2; exit 2; }

AHEAD=$(git rev-list --count "$MAIN..$DEV")
BEHIND=$(git rev-list --count "$DEV..$MAIN")

# `dev` behind `main` is the normal state right after a release merge, and it is not a lag. Only
# commits that exist on `dev` and not on `main` are.
#
# THE AGE OF THE OLDEST UNMERGED COMMIT, in whole days. This is the measurement that actually means
# something: a burst of 155 commits that all land on `main` within a day is a release, and a single
# commit forgotten for three weeks is the failure this script exists to name.
OLDEST_AGE=0
OLDEST_SUBJECT=''
OLDEST_SHA=''
if [ "$AHEAD" -gt 0 ]; then
  OLDEST_SHA=$(git rev-list --reverse "$MAIN..$DEV" | head -1)
  OLDEST_EPOCH=$(git log -1 --format=%ct "$OLDEST_SHA")
  NOW_EPOCH=$(date +%s)
  OLDEST_AGE=$(( (NOW_EPOCH - OLDEST_EPOCH) / 86400 ))
  OLDEST_SUBJECT=$(git log -1 --format=%s "$OLDEST_SHA")
fi

FAILED=0
[ "$AHEAD" -le "$MAX" ] || FAILED=1
[ "$OLDEST_AGE" -le "$MAX_AGE" ] || FAILED=1

if [ "$FAILED" -eq 0 ]; then
  printf 'check-main-lag OK: %s lags %s by %d commit(s) (bound %d)' "$MAIN" "$DEV" "$AHEAD" "$MAX"
  printf '; oldest unmerged commit is %d day(s) old (bound %d)' "$OLDEST_AGE" "$MAX_AGE"
  [ "$BEHIND" -eq 0 ] || printf '; %s also carries %d commit(s) not on %s' "$MAIN" "$BEHIND" "$DEV"
  printf '\n'
  exit 0
fi

if [ "$AHEAD" -gt "$MAX" ]; then
  echo "check-main-lag FAILED: $MAIN lags $DEV by $AHEAD commits (bound $MAX)." >&2
  echo "A release line that far behind turns 'merge dev into main' into a review nobody reads." >&2
else
  echo "check-main-lag FAILED: the oldest unmerged commit has sat on $DEV for $OLDEST_AGE day(s) (bound $MAX_AGE)." >&2
  echo "The count is within bounds ($AHEAD commit(s)), and that is the point: a release line that is" >&2
  echo "ALWAYS a fortnight behind is a formality, however few commits are in it." >&2
fi
echo "  oldest: ${OLDEST_SHA:0:7} ${OLDEST_SUBJECT}" >&2
echo "The oldest of them:" >&2
git log --format='  %h %ad %s' --date=short "$MAIN..$DEV" | tail -5 >&2
exit 1
