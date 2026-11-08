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

# ---------------------------------------------------------------- 0. the document must be YAML at all
# LEDGER #137: this script EDITS the document. Measured 2026-11-08: a real run handed it a document whose
# `source:` value contained an unescaped quote, so the YAML did not parse — and a text-matching repair on a
# broken document can silently make it worse (it edits lines it thinks it understands). The validator runs
# right after this step and reports "not valid YAML", but by then the repair has already touched the file.
# Refusing early is both safer and clearer, and it needs no YAML parser of its own: the project's own CLI
# already answers this question.
def parses(text):
    import subprocess, tempfile, os
    # The CLI resolves the ref RELATIVE TO ITS CWD, so the temp file goes beside the document and the
    # ref is its basename — an absolute path would be reported as "does not exist in <cwd>", which is a
    # different failure and would have masked a genuinely broken document.
    # The CLI is at a path relative to the PROJECT and resolves its ref from that same root, so the
    # probe file goes under the project's own `.takumi/` and the ref is relative to the root.
    root = os.environ.get('TAKUMI_PROJECT') or os.getcwd()
    probe_dir = os.path.join(root, '.takumi')
    os.makedirs(probe_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(suffix='.yaml', prefix='yaml-probe-', dir=probe_dir)
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        fh.write(text)
    ref = os.path.relpath(tmp, root)
    try:
        r = subprocess.run(
            ['node', 'apps/cli/dist/index.js', 'requirement', 'confirm', ref, '--dry-run'],
            capture_output=True, text=True, timeout=60, cwd=root,
        )
        # `confirm --dry-run` reports a broken document in its OUTPUT and still exits 0, so the verdict is
        # in the text. `digest` cannot be used: it hashes whatever it is given, valid or not.
        out = (r.stderr or '') + (r.stdout or '')
        if 'not valid YAML' in out:
            return (False, out.strip())
        return (True, '')
    except Exception as exc:  # noqa: BLE001 - any failure to ask is a refusal to repair
        return (False, str(exc))
    finally:
        os.unlink(tmp)


ok_yaml, why = parses(text)
if not ok_yaml:
    print('intake-repair: refused — the document is not valid YAML, so there is nothing safe to repair:', file=sys.stderr)
    print('  ' + why.splitlines()[0] if why else '  (no detail)', file=sys.stderr)
    print('  A text repair on a document that does not parse can silently make it worse. Fix the YAML first.', file=sys.stderr)
    sys.exit(1)

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

# ---------------------------------------------------------------- 5. a blocking decision no check exercises
# LEDGER #138: the forge refuses `blocking decision(s) AMB-NNN are exercised by no declared relation or
# anchor`. Measured 2026-11-09 — this was the single most common remaining failure, twice in a row.
#
# It is NOT a guess which relation owns a decision, because the document ALREADY SAYS what the answer
# means: `checkedAs:`. The forge's own table maps a mode to the relations that can verify it —
#   skip-count | skip-silent | stop-error                -> malformed-row-accounting
#   first-row | last-row | latest-start-date | merge | error -> duplicate-resolution
#   half-up | truncate                                  -> derived-ratio | independent-aggregation
# So a decision whose mode is `half-up` and which no relation names can only be settled by a rounding
# relation — and if exactly one such relation is declared, that is where `decides:` belongs. This is
# derived from two fields the document already carries, not invented.
#
# It refuses when the inference is not unique: two rounding relations and no way to tell them apart, or
# no relation of the needed kind at all. A wrong `decides:` would have the judge verify a decision the
# document never meant, which is worse than the refusal.
MODE_TO_RELATION = {
    'skip-count': 'malformed-row-accounting',
    'skip-silent': 'malformed-row-accounting',
    'stop-error': 'malformed-row-accounting',
    'first-row': 'duplicate-resolution',
    'last-row': 'duplicate-resolution',
    'latest-start-date': 'duplicate-resolution',
    'merge': 'duplicate-resolution',
    'error': 'duplicate-resolution',
    'half-up': None,
    'truncate': None,
}
ROUNDING_KINDS = ('derived-ratio', 'independent-aggregation')
ROUNDING_MODES = ('half-up', 'truncate')

if True:
    text = '\n'.join(lines)
    # decisions that exist, with their mode and whether they are blocking
    ambs = {}
    for m in re.finditer(r'^( *)- id: (AMB-\d+)\s*\n((?:\1 +.*\n|\s*\n)*)', text, re.M):
        body = m.group(3)
        mode = re.search(r'^\s*checkedAs:\s*([a-z-]+)\s*$', body, re.M)
        blocking = re.search(r'^\s*blocking:\s*true\s*$', body, re.M)
        ambs[m.group(2)] = (mode.group(1) if mode else None, bool(blocking))
    # relations that exist, with their kind and what they already decide
    rels = []
    for m in re.finditer(r'^( *)- id: ([A-Z]+-\d+)\s*\n((?:\1 +.*\n|\s*\n)*)', text, re.M):
        body = m.group(3)
        kind = re.search(r'^\s*relation:\s*([a-z-]+)\s*$', body, re.M)
        decides = re.search(r'^\s*decides:\s*(AMB-\d+)\s*$', body, re.M)
        if kind:
            rels.append((m.group(2), kind.group(1), decides.group(1) if decides else None))

    covered = {d for (_rid, _k, d) in rels if d}
    for amb_id, (mode, blocking) in sorted(ambs.items()):
        if not blocking or amb_id in covered:
            continue
        if mode is None:
            continue  # no mode: nothing in the document says what would check it
        # `mode` is a MODE (`half-up`), `ROUNDING_KINDS` are RELATION KINDS (`derived-ratio`) — the two
        # vocabularies must not be compared to each other.
        need = MODE_TO_RELATION.get(mode)
        if mode in ROUNDING_MODES:
            candidates = [(rid, kind) for (rid, kind, decided) in rels if kind in ROUNDING_KINDS and not decided]
        elif need is not None:
            candidates = [(rid, kind) for (rid, kind, decided) in rels if kind == need and not decided]
        else:
            candidates = []
        if len(candidates) == 1:
            rid, kind = candidates[0]
            # Named groups: the back-reference must point at the INDENT group, and inside an f-string
            # `\1` would be renumbered by the braces around `rid`.
            pat = re.compile(
                rf'^(?P<ind> *)- id: {re.escape(rid)}\s*\n(?:(?P=ind) +.*\n|\s*\n)*?(?=^ *- id: |\Z)',
                re.M,
            )
            m = pat.search('\n'.join(lines))
            if m:
                entry = m.group(0)
                indent = ' ' * 6
                entry_new = entry.rstrip('\n') + f'\n{indent}decides: {amb_id}\n'
                joined = '\n'.join(lines).replace(entry, entry_new, 1)
                lines = joined.split('\n')
                covered.add(amb_id)
                notes.append(
                    f'{amb_id} (blocking, checkedAs: {mode}) had no check; `decides: {amb_id}` added to {rid} '
                    f'({kind}) — the only declared relation whose kind can verify that mode'
                )
        elif len(candidates) == 0:
            # LEDGER #140: nothing the document may declare can verify this decision, so it must GO.
            #
            # Measured 2026-11-09, twice: a ratio document kept recording "what happens to a repeated id"
            # (`merge`) and "what happens to a malformed row" (`skip-count`) as blocking ambiguities, while
            # its ALLOWED_RELATIONS — correctly, see #139 — contains neither `duplicate-resolution` nor
            # `malformed-row-accounting` because both read a `count` role a ratio totals line no longer
            # carries (#108). #139's prompt said not to write them; the model wrote them anyway, which is
            # the fifth rule to fail that way.
            #
            # The decision is DETERMINISTICALLY unusable: no vocabulary the document may use can check it.
            # So it is removed and its chosen behaviour is moved into the requirement text, where it is a
            # plain instruction to the implementer — what the prompt asked for, done by code instead.
            verb = MODE_TO_RELATION.get(mode)
            if verb is None:
                refusals.append(
                    f'{amb_id} is blocking with `checkedAs: {mode}`, and no relation can verify a rounding mode '
                    f'here — this is not a decision the repair can place'
                )
                continue
            # Line-level removal: the block regexes above have to tolerate two-space and four-space
            # nesting, and a block that failed to match would silently leave the decision in place —
            # which is exactly the state that blocks the run. Walking the lines cannot miss.
            src = '\n'.join(lines).split('\n')
            out_lines = []
            i = 0
            removed = False
            while i < len(src):
                mm = re.match(rf'^( *)- id: {re.escape(amb_id)}\s*$', src[i])
                if not mm:
                    out_lines.append(src[i])
                    i += 1
                    continue
                indent = mm.group(1)
                entry = [src[i]]
                j = i + 1
                while j < len(src):
                    follow = src[j]
                    if re.match(rf'^{indent}- ', follow) or (follow.strip() and not follow.startswith(indent + ' ')):
                        break
                    entry.append(follow)
                    j += 1
                chosen = None
                for ln in entry:
                    cm = re.search(r'^\s*(?:chosen|default):\s*"?(.*?)"?\s*$', ln)
                    if cm:
                        chosen = cm.group(1)
                        break
                behaviour = chosen if chosen else mode
                removed = True
                i = j
            if removed:
                lines = '\n'.join(out_lines).split('\n')
                notes.append(
                    f'removed {amb_id} (blocking, checkedAs: {mode}): no relation this document may declare can verify '
                    f'that mode, so the decision would block the run forever. Its answer — "{behaviour}" — belongs in '
                    f'the requirement text as an instruction, not as a decision nothing can check'
                )
        else:
            refusals.append(
                f'{amb_id} is blocking with `checkedAs: {mode}`, and MORE THAN ONE declared relation could verify '
                f'it ({", ".join(r for r, _ in candidates)}). Which one is meant is a judgment, not a repair'
            )

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
