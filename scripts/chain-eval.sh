#!/usr/bin/env bash
# WHAT IS THE CHAIN'S RELIABILITY, MEASURED FROM ITS OWN RECORDS?
#
# WHY THIS EXISTS. The reliability of the coding AGENT is measured by `eval/` (23 held-out SWE tasks,
# four metric names defined in eval/RESULTS.md). The reliability of the unattended CHAIN — intake,
# confirmation, delivery, judge, publish, wait, merge — has only ever been measured BY HAND: thirteen
# rounds written up in docs/unattended-chain-measurements.md, each one an afternoon of running the
# thing three times and reading the logs. That does not accumulate, it does not notice regressions, and
# it costs a person every time.
#
# Meanwhile every run already writes `.takumi/runs/<run-id>.json` with the facts the four metrics need:
# `accepted`, the step statuses, the published merge sha, `durationMs`. The measurement was there all
# along; nobody was aggregating it.
#
# THE METRICS ARE THE SAME FOUR NAMES AS eval/, ON PURPOSE. Two number sets that cannot be compared
# are two number sets nobody trusts:
#
#   first-attempt rate   the delivery was accepted on attempt 1 of the repair loop
#   false-completion     the run claimed DONE and its judge refused (or it never merged)
#   repair-rescue rate   runs whose first attempt was refused and a later round delivered it
#   final rate           the delivery was accepted AND merged
#
# Usage:
#   scripts/chain-eval.sh [--since <YYYY-MM-DD>] [--json] [--dir <runs dir>]
#
# Exit: always 0 unless the runs directory cannot be read. This REPORTS; it does not gate. A metric
# that stopped a build would be a metric people learn to work around.
set -u
# THE RUNS DIRECTORY IS THE SUBJECT, NOT THE REPOSITORY. An explicit `--dir` may point anywhere — a CI
# artifact, another checkout, a copied directory a test built — so requiring a git repo first would
# refuse exactly the case the option exists for (measured: all seven tests failed with "not inside a git
# repository" before this was reordered). The git lookup is only the DEFAULT location.
SINCE=""
JSON=0
DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="${2:-}"; shift 2 ;;
    --json) JSON=1; shift ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    -h | --help) sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "chain-eval: unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$DIR" ]; then
  ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "chain-eval: not inside a git repository, and no --dir was given" >&2; exit 2; }
  DIR="$ROOT/.takumi/runs"
fi

[ -d "$DIR" ] || { echo "chain-eval: no runs directory at $DIR (nothing has run yet)" >&2; exit 2; }

python3 - "$DIR" "$SINCE" "$JSON" <<'PY'
import glob, json, os, sys

runs_dir, since, as_json = sys.argv[1], sys.argv[2], sys.argv[3] == '1'

DELIVERY_WORKFLOW = 'request-to-delivery'

def load():
    """Every run record we can parse. A record we cannot read is COUNTED, not skipped silently."""
    out, unreadable = [], []
    for path in glob.glob(os.path.join(runs_dir, 'wf-*.json')):
        try:
            with open(path) as fh:
                out.append(json.load(fh))
        except Exception as exc:                                  # noqa: BLE001 - a broken record is data
            unreadable.append((os.path.basename(path), str(exc)))
    return out, unreadable

def attempt_of(step_summary):
    """
    Which repair round accepted the delivery, or None.

    The engine states it in words ('delivery accepted on the first attempt' / '... on attempt 2 of 2'),
    and the words are the only place the ROUND appears: the step status is 'done' either way. Parsing
    prose is not ideal, but the alternative — inferring the round — is guessing, and a metric built on a
    guess is worse than one built on a string the engine is deliberately printing.
    """
    if not step_summary:
        return None
    if 'delivery accepted on the first attempt' in step_summary:
        return 1
    marker = 'delivery accepted on attempt '
    i = step_summary.find(marker)
    if i < 0:
        return None
    rest = step_summary[i + len(marker):]
    digits = ''
    for ch in rest:
        if ch.isdigit():
            digits += ch
        else:
            break
    return int(digits) if digits else None

def classify(run):
    """One row per DELIVERY run. Non-delivery workflows are not this metric's subject."""
    steps = {s.get('id'): s for s in run.get('steps', [])}
    attempt_step = steps.get('delivery_attempt') or {}
    round_accepted = attempt_of(attempt_step.get('summary'))
    merged = bool((run.get('published') or {}).get('mergedSha'))
    accepted = run.get('accepted') is True
    # `claimed` is what the run says about ITSELF before anyone checks: outcome completed.
    claimed = run.get('outcome') == 'completed'
    return {
        'run': run.get('runId'),
        'workflow': run.get('workflow'),
        'finishedAt': run.get('finishedAt'),
        'outcome': run.get('outcome'),
        'accepted': accepted,
        'claimed': claimed,
        'merged': merged,
        'round': round_accepted,
        'durationMs': run.get('durationMs') or 0,
        'agentTools': ((run.get('boundaries') or {}).get('agentTools')),
        'failureStep': (run.get('failure') or {}).get('stepId'),
    }

records, unreadable = load()
rows = [classify(r) for r in records if r.get('workflow') == DELIVERY_WORKFLOW]

if since:
    # Lexicographic comparison works on ISO-8601 timestamps; the records are written with toISOString().
    rows = [r for r in rows if (r['finishedAt'] or '') >= since]

n = len(rows)
if n == 0:
    # AN EMPTY WINDOW IS A FACT, AND `--json` MUST STILL BE JSON. The early return used to print prose
    # whatever the flag said, so a caller piping `--json` into a parser got a syntax error instead of an
    # empty report — the one case where a machine-readable mode matters most, because it is what a CI
    # step runs on a quiet week (found by the test for `--since`).
    if as_json:
        print(json.dumps({
            'subject': 'the unattended chain (delivery runs)',
            'source': runs_dir,
            'since': since or None,
            'runs': 0,
            'unreadable_records': len(unreadable),
            'metrics': None,
            'counts': {},
            'note': 'no delivery runs in this window: no rate can be computed, and none is claimed',
        }, indent=2))
        sys.exit(0)
    print(f'chain-eval: no delivery runs in {runs_dir}' + (f' since {since}' if since else ''))
    sys.exit(0)

first_pass = [r for r in rows if r['round'] == 1]
repaired = [r for r in rows if r['round'] is not None and r['round'] > 1]
entered_repair = [r for r in rows if (r['round'] or 0) > 1 or (r['round'] is None and not r['accepted'])]
final = [r for r in rows if r['accepted'] and r['merged']]
# FALSE COMPLETION, in the sense eval/RESULTS.md defines: the run CLAIMED success and it did not hold.
false_completion = [r for r in rows if r['claimed'] and not (r['accepted'] and r['merged'])]

def pct(a, b):
    return f'{100.0 * a / b:.0f}%' if b else 'n/a'

report = {
    'subject': 'the unattended chain (delivery runs)',
    'source': runs_dir,
    'since': since or None,
    'runs': n,
    'unreadable_records': len(unreadable),
    'metrics': {
        'first_attempt_rate': (len(first_pass) / n if n else 0),
        'false_completion_rate': (len(false_completion) / max(1, len([r for r in rows if r['claimed']]))),
        'repair_rescue_rate': (len(repaired) / max(1, len(entered_repair))),
        'final_success_rate': (len(final) / n if n else 0),
    },
    'counts': {
        'first_attempt': len(first_pass),
        'repaired_then_accepted': len(repaired),
        'entered_repair': len(entered_repair),
        'merged': len(final),
        'false_completion': len(false_completion),
    },
    'wall_clock_ms': {'median': sorted(r['durationMs'] for r in rows)[n // 2], 'max': max(r['durationMs'] for r in rows)},
    'agent_tools': {k: sum(1 for r in rows if r['agentTools'] == k) for k in ('confined', 'open', 'mixed', 'none') if any(r['agentTools'] == k for r in rows)},
    'failures_by_step': {s: sum(1 for r in rows if r['failureStep'] == s) for s in sorted({r['failureStep'] for r in rows if r['failureStep']})},
}

if as_json:
    print(json.dumps(report, indent=2))
    if unreadable:
        print(json.dumps({'unreadable': unreadable}, indent=2), file=sys.stderr)
    sys.exit(0)

print(f"the unattended chain — {n} delivery run(s)" + (f" since {since}" if since else '') + f", from {runs_dir}")
if unreadable:
    print(f"  ⚠ {len(unreadable)} record(s) could not be read and are NOT in these numbers:")
    for name, why in unreadable[:5]:
        print(f"      {name}: {why}")
print()
print(f"  first-attempt rate   {pct(len(first_pass), n):>5}  ({len(first_pass)}/{n} accepted on attempt 1)")
print(f"  false-completion     {pct(len(false_completion), max(1, len([r for r in rows if r['claimed']]))):>5}  "
      f"({len(false_completion)}/{len([r for r in rows if r['claimed']])} claimed success and did not land)")
print(f"  repair-rescue rate   {pct(len(repaired), max(1, len(entered_repair))):>5}  "
      f"({len(repaired)}/{len(entered_repair)} entered the repair loop and came out delivered)")
print(f"  final success rate   {pct(len(final), n):>5}  ({len(final)}/{n} accepted AND merged)")
print()
clock = report['wall_clock_ms']
print(f"  wall clock           median {clock['median']/60000:.0f} min, max {clock['max']/60000:.0f} min")
if report['agent_tools']:
    print(f"  agent tools          " + ', '.join(f"{k} {v}" for k, v in report['agent_tools'].items()))
if report['failures_by_step']:
    print(f"  refused at           " + ', '.join(f"{k} {v}" for k, v in report['failures_by_step'].items()))
print()
print("  NOTE: 'first-attempt' counts the DELIVERY's repair loop only. The intake has its own repair")
print("        loop, and a run whose intake needed two attempts can still show first-attempt=yes here.")
# A RATE OVER FIVE RUNS IS NOT A RATE. Saying so is the difference between a metric and a mood.
if n < 20:
    print()
    print(f"  ⚠ {n} run(s) is a SMALL SAMPLE: these four numbers move by 10-20 points from one run.")
    print(f"     Treat them as a description of these {n} runs, not as the chain's reliability. The")
    print("     thresholds worth believing are documented in docs/unattended-chain-measurements.md,")
    print("     where each round states its own n.")
PY
