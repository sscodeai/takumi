#!/usr/bin/env bash
# MEASURE THE INTAKE'S FIRST-ATTEMPT RATE (ledger #105).
#
# `docs/limitations.yaml` carries `intake-reliability`: "The intake is REPAIRED, not made reliable:
# a bad document costs another attempt instead of losing the run, and the first-attempt rate is not
# something the chain claims." It closes when "the first attempt produces a confirmable document at
# a measured rate the operator accepts."
#
# That sentence was written before ledger #102 split the shape decision out of the document. After
# #102 exactly ONE unattended run exists (wf-d0b45699), so nothing can be said either way — and
# editing the limitation to match a sample of one would be the same mistake as leaving a stale claim
# in it. This script is how the number gets collected instead of guessed.
#
# It runs N requests and reports, per run:
#   - whether the intake's FIRST attempt passed its own shape gate (no `--- attempt 1 of 2: refused`)
#   - whether the run delivered
#   - how long it took
#
# Usage: scripts/measure-intake-rate.sh <runs> [--logdir <dir>]
#
# Exit: 0 always when it finished measuring (the number is the output, not the exit code),
#       2 on a usage error. A failed RUN is data, not a script failure.
set -u
ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "not inside a git repository" >&2; exit 2; }
cd "$ROOT" || exit 2

N=${1:-}
[ -n "$N" ] || { echo "usage: scripts/measure-intake-rate.sh <runs> [--logdir <dir>]" >&2; exit 2; }
case "$N" in '' | *[!0-9]*) echo "wants a run count, got '$N'" >&2; exit 2 ;; esac
shift || true
LOGDIR=/tmp/intake-rate
while [ $# -gt 0 ]; do
  case "$1" in
    --logdir) LOGDIR="${2:-}"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$LOGDIR"

# THREE REQUESTS OF DIFFERENT SHAPES, so the sample is not three copies of the one request that was
# already known to work. Each names its shape in the log so the report can break the rate down.
REQS=(
  "ratio|I want a command-line tool that reads a CSV of test run records and prints one line per suite with the pass percentage rounded to one decimal place. The CSV has a header row with columns: suite, passed, total."
  "aggregate|I want a command-line tool that reads a CSV of sales records and prints the total revenue and the average order value per region. The CSV has a header row with columns: region, amount."
  "counts|I want a command-line tool that reads a CSV of support tickets and prints how many tickets each assignee has open and closed. The CSV has a header row with columns: assignee, status."
)

# shellcheck disable=SC1091
set -a; . /srv/hermes/.env; set +a

FIRST_OK=0
TOTAL=0
printf 'shape\trun\tfirst_attempt_ok\tdelivered\tseconds\n' > "$LOGDIR/report.tsv"

for i in $(seq 1 "$N"); do
  req="${REQS[$(( (i - 1) % ${#REQS[@]} ))]}"
  shape="${req%%|*}"
  text="${req#*|}"
  log="$LOGDIR/run-${i}-${shape}.log"
  started=$(date +%s)
  env -u GITHUB_TOKEN -u TAKUMI_PI_RUNTIME bash scripts/autopilot.sh "$text" >"$log" 2>&1
  elapsed=$(( $(date +%s) - started ))

  run_id=$(grep -oE 'run *: wf-[a-f0-9]+' "$log" | tail -1 | grep -oE 'wf-[a-f0-9]+')
  # The repair wrapper writes `--- attempt 1 of 2: refused ---` when the FIRST attempt was refused.
  if grep -q -- '--- attempt 1 of 2: refused ---' "$log"; then first=no; else first=yes; fi
  if grep -qE '^== delivered' "$log"; then delivered=yes; else delivered=no; fi
  [ "$first" = yes ] && FIRST_OK=$((FIRST_OK + 1))
  TOTAL=$((TOTAL + 1))
  printf '%s\t%s\t%s\t%s\t%s\n' "$shape" "${run_id:-?}" "$first" "$delivered" "$elapsed" >> "$LOGDIR/report.tsv"
  echo "  [$i/$N] $shape ${run_id:-?} first=$first delivered=$delivered ${elapsed}s" >&2
done

echo
echo "MEASURED: the intake's first attempt passed its own gate in $FIRST_OK of $TOTAL run(s)."
echo "A first attempt that failed still delivered through the repair round — that is the REPAIR"
echo "working, and it is not the same claim as the intake being reliable on the first try."
echo "report: $LOGDIR/report.tsv"
