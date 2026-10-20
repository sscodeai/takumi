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
#   scripts/check-main-lag.sh [--max <n>] [--fetch]
#     --max <n>   how many commits `main` may lag `dev` before this fails (default 40)
#     --fetch     fetch both refs first (CI checks out one ref; a local run usually wants this)
#
# Exit: 0 within the bound (prints the number), 1 beyond it (names the number and the commits),
#       2 the refs could not be read at all (a check that cannot see the refs proves nothing).
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
FETCH=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max) MAX="${2:-}"; shift 2 ;;
    --fetch) FETCH=1; shift ;;
    -h | --help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$MAX" in '' | *[!0-9]*) echo "check-main-lag: --max wants a whole number, got '$MAX'" >&2; exit 2 ;; esac

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
if [ "$AHEAD" -le "$MAX" ]; then
  printf 'check-main-lag OK: %s lags %s by %d commit(s) (bound %d)' "$MAIN" "$DEV" "$AHEAD" "$MAX"
  [ "$BEHIND" -eq 0 ] || printf '; %s also carries %d commit(s) not on %s' "$MAIN" "$BEHIND" "$DEV"
  printf '\n'
  exit 0
fi

echo "check-main-lag FAILED: $MAIN lags $DEV by $AHEAD commits (bound $MAX)." >&2
echo "A release line that far behind turns 'merge dev into main' into a review nobody reads." >&2
echo "The oldest of them:" >&2
git log --format='  %h %ad %s' --date=short "$MAIN..$DEV" | tail -5 >&2
exit 1
