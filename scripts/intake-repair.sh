#!/usr/bin/env bash
# REPAIR THE DOCUMENT FROM WHAT STEP 1 ALREADY DECIDED (ledger #129).
#
# WHY THIS EXISTS. The intake's first attempt passes its own gate about one time in three (measured
# 2026-11-08: 1 of 3, twice). The failures are not mysterious any more — #126/#128 made the forge's own
# words visible — and they are almost all the SAME SHAPE: a decision step 1 already made correctly is
# missing from the document.
#
#   * `checkedAs:` absent on the decision a derived-ratio / independent-aggregation relation settles,
#     while step 1 answered `ROUNDING_MEANS: half-up`.
#   * `deliverable.run` absent or different, while step 1 answered `ENTRY_POINT: bash x.sh {csv}`.
#   * a per-id line carrying BOTH an aggregate field and a ratio field, while step 1 answered
#     `ANSWER_SHAPE: QUOTIENT` and `ALLOWED_RELATIONS:` lists what is checkable.
#
# Every one of those is DETERMINISTIC: the answer is already known, and the document merely failed to
# carry it. Asking the model to write the whole document again to fix a missing word is how the rate
# stayed at 1 in 3 through four rounds of prompt rules (#102, #107, #121, #127). This repairs the
# document from step 1's own answers instead, and refuses when step 1 did not decide the thing.
#
# It NEVER invents a decision: `ROUNDING_MEANS: NONE` means there is no rounding answer to record, so a
# relation that settles one is refused rather than given a mode nobody chose.
#
# Usage:
#   intake-repair.sh --doc <path> (--shape <file> | --shape-text "<step 1 answer>") [--dry-run]
#
# The shape file is the text step 1 wrote (ANSWER_SHAPE / ENTRY_POINT / ALLOWED_RELATIONS /
# ROUNDING_MEANS lines). Exit: 0 repaired or already correct, 1 refusal (names why), 2 bad inputs.
set -u

DOC=""; SHAPE=""; DRY=0; SHAPE_IS_TEXT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --doc) DOC="${2:-}"; shift 2 ;;
    --shape) SHAPE="${2:-}"; shift 2 ;;
    --shape-text) SHAPE="${2:-}"; SHAPE_IS_TEXT=1; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "intake-repair: unknown option '$1'" >&2; exit 2 ;;
  esac
done
[ -n "$DOC" ] || { echo "intake-repair: --doc is required" >&2; exit 2; }
[ -n "$SHAPE" ] || { echo "intake-repair: --shape is required" >&2; exit 2; }
[ -f "$DOC" ] || { echo "intake-repair: '$DOC' does not exist" >&2; exit 2; }
if [ "${SHAPE_IS_TEXT:-0}" != 1 ]; then
  [ -f "$SHAPE" ] || { echo "intake-repair: the shape decision '$SHAPE' does not exist" >&2; exit 2; }
  SHAPE_FILE="$SHAPE"
else
  # Step 1's answer arrives as TEXT through the engine's per-step vars, so it is written to a temp file
  # here rather than requiring the manifest to name a path that does not exist.
  SHAPE_FILE=$(mktemp)
  printf '%s\n' "$SHAPE" > "$SHAPE_FILE"
  trap 'rm -f "$SHAPE_FILE"' EXIT
fi
SHAPE="$SHAPE_FILE"

# Step 1 answers inside a ``` fence (the prompt shows a code block), so the fence lines and any
# indentation are stripped before a key is read. Measured 2026-11-08: `{step.shape_decision}` began with
# a fence, `sed -n "s/^KEY://p"` matched nothing, and every repair refused with "no ANSWER_SHAPE" for a
# second, unrelated reason.
field() { # $1 key, prints the value or nothing
  sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$SHAPE" \
    | sed -n "s/^$1:[[:space:]]*//p" \
    | head -1
}

ANSWER=$(field ANSWER_SHAPE)
ENTRY=$(field ENTRY_POINT)
ROUNDING=$(field ROUNDING_MEANS)
ALLOWED=$(field ALLOWED_RELATIONS)

[ -n "$ANSWER" ] || { echo "intake-repair: step 1 recorded no ANSWER_SHAPE, so there is nothing to repair FROM" >&2; exit 2; }

python3 - "$DOC" "$ANSWER" "$ENTRY" "$ROUNDING" "$ALLOWED" "$DRY" <<'PYEOF'
import re, sys

doc_path, answer, entry, rounding, allowed, dry = sys.argv[1:7]
dry = dry == '1'
allowed = [x.strip() for x in re.split(r'[,\s]+', allowed) if x.strip()]
text = open(doc_path, encoding='utf-8').read()
original = text
notes = []
refusals = []

# ---------------------------------------------------------------- split into top-level blocks
lines = text.split('\n')


def block_bounds(name):
    """(start, end) line indices of a top-level `name:` block, end exclusive."""
    start = None
    for i, line in enumerate(lines):
        if re.match(rf'^{re.escape(name)}:\s*$', line):
            start = i
            break
    if start is None:
        return None
    end = len(lines)
    for j in range(start + 1, len(lines)):
        if re.match(r'^[A-Za-z_][A-Za-z0-9_]*:', lines[j]):
            end = j
            break
    return (start, end)


# ---------------------------------------------------------------- 1. deliverable.run
if entry:
    bounds = block_bounds('deliverable')
    if bounds is None:
        refusals.append('the document has no `deliverable` block, so there is nowhere to put the entry point step 1 decided')
    else:
        start, end = bounds
        run_at = None
        for i in range(start + 1, end):
            if re.match(r'^  run:', lines[i]):
                run_at = i
                break
        want = f'  run: "{entry}"'
        if run_at is None:
            lines.insert(start + 1, want)
            notes.append(f'added `deliverable.run: {entry}` (step 1 decided the entry point and the document had none)')
        else:
            have = lines[run_at]
            if have.strip() != want.strip():
                lines[run_at] = want
                notes.append(f'replaced `{have.strip()}` with `{want.strip()}` (step 1 decided the entry point)')

# ---------------------------------------------------------------- 2. checkedAs on a decision a ratio relation settles
# Which decisions are settled by a relation that needs `checkedAs`? A relation whose kind is
# derived-ratio or independent-aggregation names its decision with `decides:`.
text = '\n'.join(lines)
needs = set()
for m in re.finditer(r'-\s+id:\s*(REL-\d+)\s*\n(?:.*\n)*?\s+relation:\s*([a-z-]+)\s*\n(?:.*\n)*?\s+decides:\s*(AMB-\d+)', text):
    _rel, kind, amb = m.group(1), m.group(2), m.group(3)
    if kind in ('derived-ratio', 'independent-aggregation'):
        needs.add((amb, kind))

if needs:
    if not rounding or rounding.upper() == 'NONE':
        for amb, kind in sorted(needs):
            refusals.append(
                f'{amb} is settled by a {kind} relation, which needs `checkedAs:`, and step 1 answered '
                f'ROUNDING_MEANS: {rounding or "(nothing)"} — there is no rounding answer to record, so the '
                f'document either settled the wrong decision or declared the wrong relation'
            )
    else:
        for amb, kind in sorted(needs):
            # Find the AMB block and add checkedAs next to its default (or after its options, when there
            # is no default) — the placement the forge documents.
            pat = re.compile(rf'(^([ ]*)- id: {re.escape(amb)}\s*\n(?:.*\n)*?)(?=^\2?- id: |\Z)', re.M)
            m = pat.search('\n'.join(lines))
            if not m:
                refusals.append(f'{amb} is named by a relation but has no entry in `ambiguities`')
                continue
            body = m.group(1)
            if re.search(r'^\s+checkedAs:', body, re.M):
                continue
            body_lines = body.rstrip('\n').split('\n')
            indent = re.match(r'^([ ]*)', body_lines[1]).group(1) if len(body_lines) > 1 else '    '
            insert_at = None
            for i, line in enumerate(body_lines):
                if re.match(r'\s+(default|chosen):', line):
                    insert_at = i + 1
            if insert_at is None:
                insert_at = len(body_lines)
            body_lines.insert(insert_at, f'{indent}checkedAs: {rounding}')
            repaired = '\n'.join(body_lines) + '\n'
            joined = '\n'.join(lines)
            joined = joined.replace(body, repaired, 1)
            lines = joined.split('\n')
            notes.append(f'added `checkedAs: {rounding}` to {amb} (step 1 decided ROUNDING_MEANS: {rounding})')

# ---------------------------------------------------------------- 3. a per-id line mixing the two field models
AGG = {'count', 'sum', 'min', 'max', 'mean'}
RATIO = {'numerator', 'denominator', 'ratio'}
text = '\n'.join(lines)
for m in re.finditer(r'( +)fields:\s*\[([^\]]*)\]', text):
    roles = [r.strip() for r in m.group(2).split(',')]
    roleset = set(roles)
    has_agg, has_ratio = bool(roleset & AGG), bool(roleset & RATIO)
    if not (has_agg and has_ratio):
        continue
    if answer == 'QUOTIENT':
        keep = roleset & (RATIO | {'id', 'skipped-count'})
        notes.append(
            'a line declared both field models; step 1 answered QUOTIENT, so the aggregate roles cannot be '
            'dropped automatically — the line shapes and the requirement text must be rewritten to match'
        )
    else:
        notes.append(
            'a line declared both field models; step 1 answered AGGREGATE, so the ratio roles cannot be dropped '
            'automatically — the line shapes and the requirement text must be rewritten to match'
        )
    refusals.append(
        'the per-id output line mixes the two field models (it declares both an aggregate field and a ratio '
        'field). Step 1 answered '
        + answer
        + ', but a field list cannot be repaired without rewriting the line shapes and the requirement text that '
        'quote them — that is a rewrite, not a repair, so it is refused here instead of guessed at'
    )

# ---------------------------------------------------------------- 4. a relation step 1 did not allow
# LEDGER #136: step 1 emits `ALLOWED_RELATIONS` for the shape it chose, and #121 tells the document step
# that `relations:` must be a SUBSET of it — the model still wrote `independent-aggregation` on a ratio
# document, and the forge refused the run with "it recomputes COUNTS or SUMS from the fixture and a ratio
# line carries none". Step 1 had already said so. A relation outside the list is DROPPED here, because
# leaving it in refuses the run and keeping it silently would be a document that declares a check it
# cannot have.
if allowed:
    text = '\n'.join(lines)
    out_lines = []
    dropped = []
    i = 0
    src = text.split('\n')
    while i < len(src):
        line = src[i]
        m = re.match(r'^( *)- id:\s*([A-Z]+-\d+)\s*$', line)
        if not m:
            out_lines.append(line)
            i += 1
            continue
        indent, rel_id = m.group(1), m.group(2)
        # Collect the whole entry: it runs until a line at or above its own indent that starts a new item.
        j = i + 1
        while j < len(src):
            follow = src[j]
            if re.match(rf'^{indent}- ', follow) or (follow.strip() and not follow.startswith(indent + ' ')):
                break
            j += 1
        entry = src[i:j]
        kind = None
        for ln in entry:
            km = re.match(r'^\s*relation:\s*([a-z-]+)\s*$', ln)
            if km:
                kind = km.group(1)
                break
        if kind and kind not in allowed:
            dropped.append((rel_id, kind))
        else:
            out_lines.extend(entry)
        i = j
    if dropped:
        for rel_id, kind in dropped:
            notes.append(
                f'dropped {rel_id} ({kind}): step 1 answered ALLOWED_RELATIONS without it, and a relation that '
                f'cannot read this report refuses the whole document'
            )
        lines = '\n'.join(out_lines).split('\n')

# ---------------------------------------------------------------- refusals win over notes
if refusals:
    print('intake-repair: refused —', file=sys.stderr)
    for r in refusals:
        print(f'  * {r}', file=sys.stderr)
    sys.exit(1)

if not notes:
    print('intake-repair: nothing to repair — the document already carries what step 1 decided')
    sys.exit(0)

if not dry:
    open(doc_path, 'w', encoding='utf-8').write('\n'.join(lines))
for n in notes:
    print(f'intake-repair: {n}')
print('intake-repair: ' + ('would write (dry run)' if dry else 'wrote') + f' {doc_path}')
PYEOF
