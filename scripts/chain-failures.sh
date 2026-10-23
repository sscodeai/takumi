#!/usr/bin/env bash
# WHY DOES THE DELIVERY LOOP FAIL? — a taxonomy of refused deliveries, from the records.
#
# WHY THIS EXISTS. `scripts/chain-eval.sh` says the chain's first-attempt rate is 45%. That number is
# useless for deciding what to fix: "the delivery was refused" covers a judge doing its job on a bad
# implementation, a document no judge can be forged from, an infrastructure timeout, and a bug in the
# engine itself. Those want four different fixes and three of them are not the model's fault.
#
# This groups the refusals by WHICH STEP OF THE ATTEMPT failed, and reports each group with the run it
# came from, so "fix the biggest group" is a decision backed by records rather than by the loudest memory
# of the last failure.
#
# Usage:
#   scripts/chain-failures.sh [--since <YYYY-MM-DD>] [--json] [--dir <runs dir>]
#
# Exit: 0 always (a report), 2 when the runs directory cannot be read.
set -u
SINCE=""
JSON=0
DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since) SINCE="${2:-}"; shift 2 ;;
    --json) JSON=1; shift ;;
    --dir) DIR="${2:-}"; shift 2 ;;
    -h | --help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "chain-failures: unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$DIR" ]; then
  ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "chain-failures: not inside a git repository, and no --dir was given" >&2; exit 2; }
  DIR="$ROOT/.takumi/runs"
fi
[ -d "$DIR" ] || { echo "chain-failures: no runs directory at $DIR" >&2; exit 2; }

python3 - "$DIR" "$SINCE" "$JSON" <<'PY'
import glob, json, os, re, sys

runs_dir, since, as_json = sys.argv[1], sys.argv[2], sys.argv[3] == '1'

def load():
    out, bad = [], []
    for path in glob.glob(os.path.join(runs_dir, 'wf-*.json')):
        try:
            with open(path) as fh:
                out.append((path, json.load(fh)))
        except Exception as exc:                                   # noqa: BLE001
            bad.append((os.path.basename(path), str(exc)))
    return out, bad

# THE TAXONOMY. The ORDER is the whole design: a run can print several of these lines (the verdict, then
# each round's history), and the question this answers is WHO COULD HAVE PREVENTED IT, so a cause that no
# implementation could have fixed has to be claimed BEFORE a judge refusing a real implementation is.
#
# Measured 2026-10-23 while writing this: an earlier order put `acceptance FAILED` in the document group,
# which mislabelled three runs whose judge had legitimately refused a real implementation. The judge
# refusing is the loop WORKING; the document group is for runs where no implementation could ever pass.
GROUPS = [
    # No implementation could have prevented it: the forge could not build a judge, or the document
    # never reached one. Fixing this is intake/vocabulary work, never the model's.
    ('document',        re.compile(r'could not be forged|no verdict|the judge forge did not report|'
                                   r'judge forge for .* sha256|No such file or directory|'
                                   r'could not be read|intake_shape', re.I)),
    # The engine's own infrastructure: a clock, a transport, a missing marker, a missing ENV VAR the
    # run needed before it started. Fixed in the platform, never by the model.
    #
    # `missing env` earns its place here from measurement: three of the five `unclassified` refusals in
    # this repository's own history were `PiRuntimeAdapter: missing env OPENCODE_GO_API_KEY` (ledger #93)
    # and two were `the acceptance verdict marker ... was missing` (ledger #77). Both are engine faults
    # whose records name them plainly, and both cost full repair rounds on a cause no implementation
    # could reach.
    ('infrastructure',  re.compile(r'ACCEPT_VERDICT|timed out|SIGTERM|verdict marker|'
                                   r'missing env |transport|precondition failed', re.I)),
    # The judge refused a real implementation — the loop working exactly as designed.
    ('judge-refused',   re.compile(r'acceptance FAILED|failing checks|REL-\d|DEC-\d|DIFF-\d', re.I)),
    # The delivered project's own gate or a review rule caught it, earlier than the judge.
    ('own-tests-red',   re.compile(r'quality_gate FAILED|rule_review FAILED', re.I)),
]

def classify(msg, inner=None):
    """
    Which layer the refusal belongs to.

    THE REASON IS USUALLY ABOVE THE ROUND MARKERS, NOT BELOW. The engine writes the run's own verdict
    first ("delivery reached no verdict: the judge could not be forged ...") and THEN the per-round
    history. The first version of this classifier looked only at the text after the LAST marker and
    reported 53% unclassified — it was reading the history and throwing away the verdict.

    AND THE PARENT RECORD CAN LOSE THE REASON ENTIRELY (ledger #98): a run whose parent message is only
    "delivery refused after 2 of 2 attempt(s)" sends the reader to the CHILD attempt record, which is
    where the failing step and its message actually live. So when the parent says nothing usable, the
    child's failing-step summary is classified instead of being reported as unknown.
    """
    text = msg or ''
    if text.strip():
        for name, pat in GROUPS:
            if pat.search(text):
                return name
    if inner is not None:
        inner_text = ' '.join(
            (s.get('summary') or '') for s in inner.get('steps', []) if s.get('status') == 'failed'
        )
        for name, pat in GROUPS:
            if pat.search(inner_text):
                return name
    if not text.strip():
        return 'no-message'
    return 'unclassified'

records, unreadable = load()
# child attempt records, to name the step that actually failed inside the loop
attempts = {}
for path, d in records:
    if d.get('workflow') == 'request-to-delivery-attempt':
        attempts[path] = (os.path.getmtime(path), d)

def nearest_attempt(mtime):
    best = None
    for path, (mt, d) in attempts.items():
        dt = abs(mt - mtime)
        if best is None or dt < best[0]:
            best = (dt, path, d)
    return best[2] if best and best[0] < 900 else None      # within 15 minutes of the parent

rows = []
for path, d in records:
    if d.get('workflow') != 'request-to-delivery':
        continue
    if (d.get('failure') or {}).get('stepId') != 'delivery_attempt':
        continue
    finished = d.get('finishedAt') or ''
    if since and finished < since:
        continue
    msg = (d.get('failure') or {}).get('message') or ''
    inner = nearest_attempt(os.path.getmtime(path))
    group = classify(msg, inner)
    inner_step = None
    if inner is not None:
        failed = [s for s in inner.get('steps', []) if s.get('status') == 'failed']
        inner_step = failed[0]['id'] if failed else inner.get('outcome')
    rows.append({
        'run': d.get('runId'), 'finishedAt': finished, 'group': group,
        'innerStep': inner_step,
        'rounds': len(re.findall(r'--- (?:attempt|repair round) \d+ of \d+', msg)),
    })

n = len(rows)
groups = {}
for r in rows:
    groups.setdefault(r['group'], []).append(r)

report = {
    'subject': 'delivery-loop refusals',
    'source': runs_dir,
    'since': since or None,
    'refused': n,
    'unreadable_records': len(unreadable),
    'by_group': {g: {'count': len(v), 'runs': [r['run'] for r in v]} for g, v in sorted(groups.items(), key=lambda kv: -len(kv[1]))},
    'by_inner_step': {},
}
for r in rows:
    if r['innerStep']:
        report['by_inner_step'][r['innerStep']] = report['by_inner_step'].get(r['innerStep'], 0) + 1

if as_json:
    print(json.dumps(report, indent=2))
    sys.exit(0)

print(f"delivery-loop refusals — {n} run(s)" + (f" since {since}" if since else '') + f", from {runs_dir}")
if unreadable:
    print(f"  ⚠ {len(unreadable)} record(s) unreadable and NOT counted")
if n == 0:
    print("  none: no delivery loop was refused in this window")
    sys.exit(0)
print()
print("  WHOSE FAULT IS IT — the question that decides what to fix:")
print()
for g, v in sorted(groups.items(), key=lambda kv: -len(kv[1])):
    blame = {
        'document':       'the DOCUMENT (or the forge): no implementation could have passed — fix intake/the judge vocabulary',
        'infrastructure': 'the ENGINE: a clock, a transport, a missing marker — fix the platform, not the model',
        'judge-refused':  'the IMPLEMENTATION, and the loop working: the judge caught a real defect',
        'own-tests-red':  'the IMPLEMENTATION, caught earlier than the judge (its own gate or a review rule)',
        'no-message':     'UNKNOWN: the record carries no reason, which is itself a defect',
        'unclassified':   'UNKNOWN: the record says only "refused" — it lost the reason (ledger #98)',
    }.get(g, g)
    print(f"  {g:<16} {len(v):>2}  ({len(v) * 100 // n}%)  {blame}")
    for r in v:
        extra = f" [inner: {r['innerStep']}]" if r['innerStep'] else ' [no child record]'
        print(f"      {r['run']}  {r['finishedAt'][:10]}  rounds={r['rounds']}{extra}")
print()
lost = len(groups.get('unclassified', [])) + len(groups.get('no-message', []))
if lost:
    print(f"  ⚠ {lost} refusal(s) cannot be attributed: the PARENT record says only \"refused\" and there is no")
    print("    child attempt record to ask. That is a RECORDING defect (ledger #98), not a model failure —")
    print("    a run whose reason is lost cannot be learned from, and these numbers are a floor on the")
    print("    engine's share rather than a ceiling.")
if report['by_inner_step']:
    print("  failing step INSIDE the attempt: " + ', '.join(f'{k} {v}' for k, v in sorted(report['by_inner_step'].items(), key=lambda kv: -kv[1])))
    print()
if n < 20:
    print(f"  ⚠ {n} refusals is a SMALL SAMPLE — treat the percentages as a description of these runs.")
PY
