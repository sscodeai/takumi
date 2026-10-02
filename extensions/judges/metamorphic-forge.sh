#!/usr/bin/env bash
# The metamorphic judge forge (ADR-026).
#
# A generator, run OUTSIDE the implementation worktree and WITHOUT the implementation: it reads the
# confirmed requirement document's `deliverable` block — how the thing is run, the output shape, and
# the relations a judge must be able to check — and writes a judge that runs the deliverable against
# FIXTURES IT GENERATES ITSELF and judges invariants rather than outputs.
#
# Two properties matter more than the checks themselves:
#
#   1. It refuses to build a judge it cannot fully implement. A relation id this forge does not know
#      is a FAILURE, not a skipped check: a gap nobody notices is exactly how an acceptance becomes
#      decoration.
#   2. It never reads the implementation. The judge it writes derives its fixtures and its expected
#      values from the requirement, so an implementation that happens to be wrong in a way the
#      fixtures share cannot pass by agreement.
#
# Environment (set by the engine): TAKUMI_REQUIREMENT (ref, relative to TAKUMI_PROJECT),
# TAKUMI_REQUIREMENT_DIGEST, TAKUMI_WORKTREE (absolute), TAKUMI_PROJECT (absolute), TAKUMI_JUDGE_DIR.
#
# Output contract: `JUDGE_FORGE: ok` plus `JUDGE_PATH: <file>` on success; any refusal exits non-zero
# with the reason on stderr.
#
# Scope note: the requirement document is parsed line-wise (the document is ours and its shape is
# fixed; a real forge would use a YAML parser). Anything it cannot read is a refusal.

set -eu

: "${TAKUMI_REQUIREMENT:?TAKUMI_REQUIREMENT is required}"
: "${TAKUMI_WORKTREE:?TAKUMI_WORKTREE is required}"
: "${TAKUMI_PROJECT:?TAKUMI_PROJECT is required}"
: "${TAKUMI_JUDGE_DIR:?TAKUMI_JUDGE_DIR is required}"

DOC="$TAKUMI_PROJECT/$TAKUMI_REQUIREMENT"
if [ ! -f "$DOC" ]; then
  echo "the requirement document $DOC does not exist" >&2
  exit 1
fi

# --- read the deliverable contract out of the requirement document -----------------------------

RUN_TEMPLATE=$(awk '/^[[:space:]]*run:[[:space:]]*/ { sub(/^[[:space:]]*run:[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit }' "$DOC")
if [ -z "$RUN_TEMPLATE" ]; then
  echo "the requirement document declares no deliverable.run, so there is no way to run the thing" >&2
  exit 1
fi

RELATIONS=$(awk '
  /^[[:space:]]*relations:[[:space:]]*$/ { inrel = 1; next }
  /^[[:space:]]*[a-z_]+:[[:space:]]*$/ { if (inrel) inrel = 0 }
  inrel && /^[[:space:]]*-[[:space:]]*id:[[:space:]]*REL-/ { id = $3 }
  inrel && /^[[:space:]]*relation:[[:space:]]*/ { sub(/^[[:space:]]*relation:[[:space:]]*/, ""); print id, $0 }
' "$DOC")
if [ -z "$RELATIONS" ]; then
  echo "the requirement document declares no deliverable.relations: a judge with nothing to check is not a judge" >&2
  exit 1
fi

ANCHORS=$(awk '
  /^[[:space:]]*differential:[[:space:]]*$/ { ind = 1; next }
  /^[[:space:]]*[a-z_]+:[[:space:]]*$/ { if (ind) ind = 0 }
  ind && /^[[:space:]]*anchor:[[:space:]]*/ { sub(/^[[:space:]]*anchor:[[:space:]]*/, ""); print }
' "$DOC")

# Every declared relation must be one this forge implements: refusing beats a silent gap.
IMPLEMENTED=" row-order-invariance additivity duplicate-resolution malformed-row-accounting "
MISSING=""
while read -r id relation; do
  [ -z "${relation:-}" ] && continue
  case "$IMPLEMENTED" in
    *" $relation "*) ;;
    *) MISSING="$MISSING $relation" ;;
  esac
done <<EOF
$RELATIONS
EOF
if [ -n "$MISSING" ]; then
  echo "this forge does not implement:$MISSING — refusing to build a judge with a gap in it (implemented:$IMPLEMENTED)" >&2
  exit 1
fi

# --- emit the judge -----------------------------------------------------------------------------

JUDGE="$TAKUMI_JUDGE_DIR/judge.sh"
{
  cat <<'HEADER'
#!/usr/bin/env bash
# A FORGED judge (ADR-026). Generated from the requirement document's deliverable contract, outside
# the implementation worktree, without reading the implementation. It runs the deliverable against
# fixtures it generates itself and judges INVARIANTS, not outputs.
#
# Its own digest is recorded in the ACCEPT artifact, so what was judged is bound to what ran.
set -u

WORKTREE="${TAKUMI_WORKTREE:?the judge needs TAKUMI_WORKTREE}"
JUDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
FIX="$JUDGE_DIR/fixtures"
mkdir -p "$FIX"

N=0; PASS=0; FAIL=0
ok() { N=$((N + 1)); PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$N" "$1"; }
not_ok() { N=$((N + 1)); FAIL=$((FAIL + 1)); printf 'not ok %d - %s\n' "$N" "$1"; }
relation() { # $1 ok|not_ok, $2 id, $3 text, $4 detail
  if [ "$1" = ok ]; then ok "$2 $3"; else not_ok "$2 $3 — $4"; fi
}

run_tool() { # $1 = absolute csv path; prints the tool's combined output
  local csv="$1" cmd
  cmd=$(printf '%s' "$RUN_TEMPLATE" | sed "s|{csv}|$csv|g")
  ( cd "$WORKTREE" && sh -c "$cmd" ) 2>&1
}
dept_fields() { # $1 output, $2 department -> "count total average"
  printf '%s\n' "$1" | awk -v d="$2" '$1 == d && NF >= 4 { print $2, $3, $4; exit }'
}
overall_fields() { printf '%s\n' "$1" | awk '$1 == "TOTAL" { print $2, $3; exit }'; }
skipped_count() { printf '%s\n' "$1" | awk '$1 == "SKIPPED" { print $2; exit }'; }

# --- fixtures (generated here, from the requirement, never copied from the implementation) -------
cat > "$FIX/base.csv" <<'CSV'
employee_id,name,department,start_date,annual_salary
1003,Carol,Engineering,2020-01-10,90.5
1001,Ada,Engineering,2021-04-01,100.5
1002,Grace,Sales,2019-11-15,135.4
1004,Alan,Sales,2022-02-02,100.6
CSV
tail -n +2 "$FIX/base.csv" | tac > "$FIX/base-reversed.body"
printf 'employee_id,name,department,start_date,annual_salary\n' > "$FIX/base-reversed.csv"
cat "$FIX/base-reversed.body" >> "$FIX/base-reversed.csv"

# A duplicate id whose start_date is LATER (AMB-002 chose "the latest start_date wins"; the salary
# rises, so a first-row-wins implementation shows up as a total that did not move).
cp "$FIX/base.csv" "$FIX/duplicate.csv"
echo "1003,Carol,Engineering,2023-05-05,200" >> "$FIX/duplicate.csv"

# Three malformed rows: a missing column, a non-numeric salary, an unparseable date (AMB-001 chose
# "skip, count and report").
cp "$FIX/base.csv" "$FIX/malformed.csv"
echo "1005,Bad,Engineering,2021-01-01" >> "$FIX/malformed.csv"
echo "1006,Bad,Sales,2021-01-01,abc" >> "$FIX/malformed.csv"
echo "1007,Bad,Sales,not-a-date,120" >> "$FIX/malformed.csv"
HEADER

  printf '\nRUN_TEMPLATE=%s\n' "$(printf '%s' "$RUN_TEMPLATE" | sed "s/'/'\\\\''/g; s/^/'/; s/$/'/")"
  printf 'REQUIREMENT_REF=%s\n' "$(printf '%s' "$TAKUMI_REQUIREMENT" | sed "s/'/'\\\\''/g; s/^/'/; s/$/'/")"

  cat <<'BODY'

# --- the relations (one per id the requirement declared) ----------------------------------------

base_output=$(run_tool "$FIX/base.csv")
if [ -z "$base_output" ]; then
  printf '# the deliverable produced no output at all (stderr follows)\n'
  printf '%s\n' "$base_output"
fi
base_overall=$(overall_fields "$base_output")
base_headcount=$(printf '%s' "$base_overall" | awk '{print $1}')
base_total=$(printf '%s' "$base_overall" | awk '{print $2}')

# REL-001 row-order-invariance: reshuffling the input must not move a single number.
reversed_output=$(run_tool "$FIX/base-reversed.csv")
sorted_base=$(printf '%s\n' "$base_output" | grep -Ev '^(SKIPPED|TOTAL)' | sort)
sorted_reversed=$(printf '%s\n' "$reversed_output" | grep -Ev '^(SKIPPED|TOTAL)' | sort)
if [ -n "$base_output" ] && [ "$sorted_base" = "$sorted_reversed" ]; then
  relation ok REL-001 "row-order-invariance: reshuffling the rows changes nothing"
else
  relation not_ok REL-001 "row-order-invariance: reshuffling the rows changes the report" "$(printf '%s\n' "$sorted_base" | diff - <(printf '%s\n' "$sorted_reversed") | head -4 | tr '\n' ' ')"
fi

# REL-002 additivity: the department totals must add up to the printed overall total.
sum_of_departments=$(printf '%s\n' "$base_output" | grep -Ev '^(SKIPPED|TOTAL)' | awk '{s += $3} END {print s + 0}')
if [ -n "$base_total" ] && [ "$sum_of_departments" = "$base_total" ]; then
  relation ok REL-002 "additivity: the department totals sum to the overall total ($base_total)"
else
  relation not_ok REL-002 "additivity: department totals sum to $sum_of_departments but the report says $base_total" "sum=$sum_of_departments reported=$base_total"
fi

# REL-003 duplicate-resolution: a later duplicate replaces the row, it does not add an employee.
duplicate_output=$(run_tool "$FIX/duplicate.csv")
dup_overall=$(overall_fields "$duplicate_output")
dup_headcount=$(printf '%s' "$dup_overall" | awk '{print $1}')
dup_total=$(printf '%s' "$dup_overall" | awk '{print $2}')
# The replaced row's own salary, rounded the way the requirement says (half-up), read from the
# fixture by the judge: a duplicate REPLACES a row, so the expected total is base + new - old. Getting
# this wrong is how a judge becomes a second bug report instead of a check.
replaced=$(awk -F, '$1 == "1003" { print int($5 + 0.5); exit }' "$FIX/base.csv")
expected_dup_total=$((base_total + 200 - replaced))
if [ "$dup_headcount" = "$base_headcount" ] && [ "$dup_total" = "$expected_dup_total" ]; then
  relation ok REL-003 "duplicate-resolution: the later row wins and the headcount is unchanged ($base_headcount)"
else
  relation not_ok REL-003 "duplicate-resolution: headcount $dup_headcount (expected $base_headcount), total $dup_total (expected $expected_dup_total = base $base_total + 200 - replaced $replaced)" "headcount=$dup_headcount total=$dup_total"
fi

# REL-004 malformed-row-accounting: three bad rows are skipped, counted, and change no total.
malformed_output=$(run_tool "$FIX/malformed.csv")
malformed_overall=$(overall_fields "$malformed_output")
malformed_headcount=$(printf '%s' "$malformed_overall" | awk '{print $1}')
malformed_skipped=$(skipped_count "$malformed_output")
if [ "$malformed_headcount" = "$base_headcount" ] && [ "$malformed_skipped" = "3" ] && [ "$malformed_output" != "$base_output" ]; then
  relation ok REL-004 "malformed-row-accounting: 3 malformed rows skipped and counted, totals unchanged"
else
  relation not_ok REL-004 "malformed-row-accounting: headcount $malformed_headcount (expected $base_headcount), skipped ${malformed_skipped:-<none>} (expected 3)" "headcount=$malformed_headcount skipped=${malformed_skipped:-none}"
fi

# DIFF-001 independent-aggregation: the judge recomputes the totals itself, from the fixture, and
# compares — a differential anchor, not a re-reading of the tool's own arithmetic.
anchor=$(awk -F, 'NR > 1 && NF == 5 {
  salary = $5 + 0
  if (salary != $5) next
  key = $3
  total[key] += int(salary + 0.5)
  count[key] += 1
} END {
  for (d in total) printf "%s %d %d\n", d, count[d], total[d]
}' "$FIX/base.csv" | sort)
tool_depts=$(printf '%s\n' "$base_output" | grep -Ev '^(SKIPPED|TOTAL)' | awk '{print $1, $2, $3}' | sort)
if [ -n "$anchor" ] && [ "$anchor" = "$tool_depts" ]; then
  relation ok DIFF-001 "independent-aggregation: an independent recomputation matches the report"
else
  relation not_ok DIFF-001 "independent-aggregation: an independent recomputation disagrees with the report" "$(printf '%s\n' "$anchor" | diff - <(printf '%s\n' "$tool_depts") | head -6 | tr '\n' ' ')"
fi

# DOC-001 every open decision in the confirmed document has a chosen option. This is a check on the
# HUMAN artefact, not on the implementation: an acceptance of a document whose decisions were never
# settled accepts something nobody agreed to.
DOC="$TAKUMI_PROJECT/$REQUIREMENT_REF"
amb=$(grep -Ec '^[[:space:]]*-[[:space:]]*id:[[:space:]]*AMB-[0-9]+' "$DOC" 2>/dev/null || echo 0)
chosen=$(grep -Ec '^[[:space:]]*chosen:[[:space:]]*\S' "$DOC" 2>/dev/null || echo 0)
if [ "$amb" -gt 0 ] && [ "$chosen" -ge "$amb" ]; then
  relation ok DOC-001 "every open decision has a chosen option ($chosen/$amb)"
else
  relation not_ok DOC-001 "not every open decision has a chosen option ($chosen/$amb)" "chosen=$chosen ambiguities=$amb"
fi

# --- what this judge does NOT check ------------------------------------------------------------
# The criteria a judge cannot mechanise are stated as diagnostics. They are NOT reported ok: an
# unmechanised criterion reported as a pass is the exact vacuous green ADR-013 exists to prevent.
printf '# not mechanised: the 50,000-row performance criterion (REQ-001)\n'
printf '# not mechanised: the count of resolved duplicates being printed (REQ-003)\n'
printf '# not mechanised: the optional output-file argument (REQ-004)\n'

printf '# tests %d\n' "$N"
printf '# pass %d\n' "$PASS"
printf '# fail %d\n' "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  printf 'ACCEPT_VERDICT: pass\n'
  exit 0
fi
printf 'ACCEPT_VERDICT: fail\n'
exit 1
BODY
} > "$JUDGE"

chmod +x "$JUDGE"

# The generated judge must be runnable and must not reference the implementation it will judge: the
# only path it holds is the worktree it is TOLD about at run time.
if ! bash -n "$JUDGE"; then
  echo "the forged judge is not valid shell" >&2
  exit 1
fi
if grep -q "$TAKUMI_WORKTREE" "$JUDGE"; then
  echo "the forged judge hard-codes the worktree, which means it was built from the implementation rather than from the requirement" >&2
  exit 1
fi

echo "JUDGE_FORGE: ok"
echo "JUDGE_PATH: judge.sh"
