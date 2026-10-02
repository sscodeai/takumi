#!/usr/bin/env bash
# The metamorphic judge forge (ADR-026), now bound to the human's DECISIONS (ADR-028).
#
# A generator, run OUTSIDE the implementation worktree and WITHOUT the implementation: it reads the
# confirmed requirement document's `deliverable` block — how the thing is run, the output shape, the
# relations a judge must be able to check, and WHICH DECISION each relation exercises (`decides:`) —
# and writes a judge that runs the deliverable against FIXTURES IT GENERATES ITSELF and judges
# invariants rather than outputs.
#
# ADR-028 changed what a relation may be. A relation that exercises a decision (a `decides: <AMB-id>`
# line) derives its FIXTURE and its EXPECTED VALUES from that decision's `chosen` option, and the
# judge emits one `DEC-nnn` line per decision saying whether the implementation HONOURS the option the
# human recorded. Recording a decision and checking it are now the same act:
#
#   * a BLOCKING decision that no declared relation or anchor exercises is a REFUSAL;
#   * a `decides:` naming a decision the document does not contain is a REFUSAL;
#   * a `chosen` value this forge cannot mechanise is a REFUSAL, with the mechanisable values named;
#   * a decision that would need a rounding rule the document never decides is a REFUSAL, because the
#     alternative is a judge silently inventing one.
#
# Three further properties matter more than the checks themselves:
#
#   1. It refuses to build a judge it cannot fully implement. A relation id this forge does not know
#      is a FAILURE, not a skipped check: a gap nobody notices is exactly how an acceptance becomes
#      decoration.
#   2. It never reads the implementation. The judge it writes derives its fixtures and its expected
#      values from the requirement, so an implementation that happens to be wrong in a way the
#      fixtures share cannot pass by agreement.
#   3. An expectation is computed FROM THE FIXTURE by the judge itself (awk, in the judge), never
#      hard-coded here: a hard-coded number is a second bug report waiting to happen, and a number
#      computed from the fixture is a number the fixture can contradict.
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

# Quoting for a value that will be embedded in a single-quoted shell assignment.
sq() { printf '%s' "$1" | sed "s/'/'\\\\''/g"; }
# Case- and whitespace-insensitive form of a human's option text, for matching against the tables.
norm() { printf '%s' "$1" | tr 'A-Z' 'a-z' | tr -s '[:space:]' ' ' | sed 's/^ *//; s/ *$//'; }

# --- read the deliverable contract out of the requirement document -----------------------------

RUN_TEMPLATE=$(awk '/^[[:space:]]*run:[[:space:]]*/ { sub(/^[[:space:]]*run:[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit }' "$DOC")
if [ -z "$RUN_TEMPLATE" ]; then
  echo "the requirement document declares no deliverable.run, so there is no way to run the thing" >&2
  exit 1
fi

# relations / anchors: `id relation` (the check ids, and what kind each one is) and, separately,
# `id decides` (which decision that check exercises).
RELATIONS=$(awk '
  /^[[:space:]]*relations:[[:space:]]*$/ { inb = 1; next }
  /^[[:space:]]*differential:[[:space:]]*$/ { inb = 1; next }
  /^[a-z_]+:[[:space:]]*$/ { if (inb) inb = 0 }
  inb && /^[[:space:]]*-[[:space:]]*id:[[:space:]]*/ { id = $3 }
  inb && /^[[:space:]]*relation:[[:space:]]*/ { t = $0; sub(/^[[:space:]]*relation:[[:space:]]*/, "", t); print id, t }
  inb && /^[[:space:]]*anchor:[[:space:]]*/ { t = $0; sub(/^[[:space:]]*anchor:[[:space:]]*/, "", t); print id, t }
' "$DOC")
DECIDES=$(awk '
  /^[[:space:]]*relations:[[:space:]]*$/ { inb = 1; next }
  /^[[:space:]]*differential:[[:space:]]*$/ { inb = 1; next }
  /^[a-z_]+:[[:space:]]*$/ { if (inb) inb = 0 }
  inb && /^[[:space:]]*-[[:space:]]*id:[[:space:]]*/ { id = $3 }
  inb && /^[[:space:]]*decides:[[:space:]]*/ { t = $0; sub(/^[[:space:]]*decides:[[:space:]]*/, "", t); print id, t }
' "$DOC")

if [ -z "$RELATIONS" ]; then
  echo "the requirement document declares no deliverable.relations: a judge with nothing to check is not a judge" >&2
  exit 1
fi

# The ambiguities: id|blocking|chosen|options (options joined by ';').
AMBIGUITIES=$(awk '
  /^[[:space:]]*ambiguities:[[:space:]]*$/ { ina = 1; next }
  /^[a-z_]+:[[:space:]]*$/ { ina = 0 }
  ina && /^[[:space:]]*-[[:space:]]*id:[[:space:]]*AMB-/ {
    if (id != "") print id "|" blocking "|" chosen "|" options
    id = $3; blocking = "false"; chosen = ""; options = ""; next
  }
  ina && /^[[:space:]]*chosen:[[:space:]]*/ { t = $0; sub(/^[[:space:]]*chosen:[[:space:]]*/, "", t); gsub(/^"|"$/, "", t); chosen = t; next }
  ina && /^[[:space:]]*blocking:[[:space:]]*/ { blocking = $2; next }
  ina && /^[[:space:]]*-[[:space:]]*"/ { t = $0; sub(/^[[:space:]]*-[[:space:]]*/, "", t); gsub(/^"|"$/, "", t); options = (options == "" ? t : options ";" t); next }
  END { if (id != "") print id "|" blocking "|" chosen "|" options }
' "$DOC")

# The ambiguity records are `id|blocking|chosen|options`, so the accessors are named rather than
# numbered: a numbered field is how a forge ends up matching a decision against its own `blocking` flag.
amb_exists() { printf '%s\n' "$AMBIGUITIES" | awk -F'|' -v id="$1" '$1 == id { f = 1 } END { print f ? "yes" : "no" }'; }
amb_blocking() { printf '%s\n' "$AMBIGUITIES" | awk -F'|' -v id="$1" '$1 == id { print $2; exit }'; }
amb_chosen() { printf '%s\n' "$AMBIGUITIES" | awk -F'|' -v id="$1" '$1 == id { print $3; exit }'; }
decides_of() { # $1 relation/anchor id -> the decision it exercises, or empty
  printf '%s\n' "$DECIDES" | awk -v id="$1" '$1 == id { print $2; exit }'
}

# Every declared relation must be one this forge implements: refusing beats a silent gap.
IMPLEMENTED=" row-order-invariance additivity duplicate-resolution malformed-row-accounting independent-aggregation "
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

# --- the decisions the judge will derive its expectations from (ADR-028) ------------------------

# Which decision each relation exercises must name a decision the document actually contains.
while read -r id amb; do
  [ -z "${amb:-}" ] && continue
  if [ "$(amb_exists "$amb")" = no ]; then
    echo "\"$id\" exercises \"$amb\", which is not a decision in this document: a check bound to nothing decides nothing" >&2
    exit 1
  fi
done <<EOF
$DECIDES
EOF

# A blocking decision nothing exercises is a decision that does not bind the implementation.
UNCOVERED=""
while IFS='|' read -r id blocking _chosen _options; do
  [ -z "${id:-}" ] && continue
  [ "$blocking" = "true" ] || continue
  case "$DECIDES" in
    *" $id"*) ;;
    *) UNCOVERED="$UNCOVERED $id" ;;
  esac
done <<EOF
$AMBIGUITIES
EOF
if [ -n "$UNCOVERED" ]; then
  echo "blocking decision(s)$UNCOVERED are exercised by no declared relation or anchor: add \"decides: AMB-nnn\" to the check that settles them — a blocking decision nothing checks does not bind the implementation" >&2
  exit 1
fi

# The mechanisable answers, per relation. A chosen option outside its table is a refusal, never a
# silently skipped check: the vocabulary below IS the honest scale of what this judge can decide.
DUPLICATE_VALUES="\"The row with the latest start_date wins\" \"First row wins\" \"Last row wins\" \"Treat it as an error\""
MALFORMED_VALUES="\"Skip the row, count it, and report the count\" \"Stop with an error\""
ROUNDING_VALUES="\"Half-up, no currency printed\" \"Truncate, no currency printed\""

duplicate_mode() { # $1 chosen option text -> mode, or empty
  case "$(norm "$1")" in
    "the row with the latest start_date wins") echo latest-start-date ;;
    "first row wins") echo first-row ;;
    "last row wins") echo last-row ;;
    "treat it as an error") echo error ;;
  esac
}
malformed_mode() { # $1 chosen option text -> mode, or empty
  case "$(norm "$1")" in
    "skip the row, count it, and report the count") echo skip-count ;;
    "stop with an error") echo stop-error ;;
  esac
}
rounding_mode() { # $1 chosen option text -> mode, or empty
  case "$(norm "$1")" in
    "half-up, no currency printed") echo half-up ;;
    "truncate, no currency printed") echo truncate ;;
  esac
}

refuse_chosen() { # $1 relation id, $2 decision id, $3 chosen, $4 the values that are mechanisable
  echo "the decision $2 chose \"$3\", which the relation $1 cannot mechanise — this forge can decide $4: either change the option in the document or implement it in the forge, but a decision nobody can check is not a decision (refusing rather than accepting on an unchecked answer)" >&2
  exit 1
}

DUPLICATE_MODE=""
MALFORMED_MODE=""
ROUNDING_MODE=""
while read -r id relation; do
  [ -z "${relation:-}" ] && continue
  amb=$(decides_of "$id")
  [ -z "${amb:-}" ] && continue
  chosen=$(amb_chosen "$amb")
  if [ -z "${chosen:-}" ]; then
    echo "the relation $id exercises $amb, but $amb has no chosen option: the judge would be built from a decision nobody made" >&2
    exit 1
  fi
  case "$relation" in
    duplicate-resolution)
      mode=$(duplicate_mode "$chosen")
      [ -z "$mode" ] && refuse_chosen "$id" "$amb" "$chosen" "$DUPLICATE_VALUES"
      [ -n "$DUPLICATE_MODE" ] && [ "$DUPLICATE_MODE" != "$mode" ] && { echo "two relations disagree about $amb: $DUPLICATE_MODE vs $mode" >&2; exit 1; }
      DUPLICATE_MODE="$mode"
      ;;
    malformed-row-accounting)
      mode=$(malformed_mode "$chosen")
      [ -z "$mode" ] && refuse_chosen "$id" "$amb" "$chosen" "$MALFORMED_VALUES"
      MALFORMED_MODE="$mode"
      ;;
    independent-aggregation)
      mode=$(rounding_mode "$chosen")
      [ -z "$mode" ] && refuse_chosen "$id" "$amb" "$chosen" "$ROUNDING_VALUES"
      ROUNDING_MODE="$mode"
      ;;
  esac
done <<EOF
$RELATIONS
EOF

# The judge computes its expectations from the fixture, so it needs to know how salaries are rounded.
# Assuming one would be the judge inventing a requirement: refuse instead.
if [ -z "$ROUNDING_MODE" ]; then
  echo "no declared relation or anchor exercises a rounding decision, so the judge would have to assume how salaries are rounded: point a relation or anchor at the decision that settles it (\"decides: AMB-nnn\")" >&2
  exit 1
fi

blocking_note() { [ "$(amb_blocking "$1")" = "true" ] && printf ' (BLOCKING — the forge should have refused)' || printf ' (non-blocking decision)'; }
exercised_by() { printf '%s\n' "$DECIDES" | awk -v amb="$1" '$2 == amb { print $1; exit }'; }

# The DEC lines: one per exercised decision, in document order.
DEC_TABLE=""
n=0
while IFS='|' read -r id _blocking chosen _options; do
  [ -z "${id:-}" ] && continue
  rel=$(exercised_by "$id")
  [ -z "${rel:-}" ] && continue
  n=$((n + 1))
  DEC_TABLE="$DEC_TABLE$rel $id $(printf 'DEC-%03d' "$n") $chosen"$'\n'
done <<EOF
$AMBIGUITIES
EOF

# A decision no relation exercises is reported as a diagnostic (it can be non-blocking; a blocking
# one was refused above), never as a pass.
UNEXERCISED=$(while IFS='|' read -r id _blocking chosen _options; do
  [ -z "${id:-}" ] && continue
  [ -n "$(exercised_by "$id")" ] && continue
  printf '# not mechanised%s: %s "%s" is exercised by no declared relation or anchor\n' "$(blocking_note "$id")" "$id" "$chosen"
done <<EOF
$AMBIGUITIES
EOF
)

# --- emit the judge -----------------------------------------------------------------------------

JUDGE="$TAKUMI_JUDGE_DIR/judge.sh"
{
  cat <<'HEADER'
#!/usr/bin/env bash
# A FORGED judge (ADR-026 + ADR-028). Generated from the requirement document's deliverable contract,
# outside the implementation worktree, without reading the implementation. It runs the deliverable
# against fixtures it generates itself and judges INVARIANTS, not outputs.
#
# ADR-028: every expectation below is a function of the options the human CHOSE, and every decision a
# relation exercises is reported as its own DEC-nnn line — so an implementation that recorded a
# decision and then did the opposite of it fails here, not in review.
#
# Its own digest is recorded in the ACCEPT artifact, so what was judged is bound to what ran.
set -u

WORKTREE="${TAKUMI_WORKTREE:?the judge needs TAKUMI_WORKTREE}"
JUDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
FIX="$JUDGE_DIR/fixtures"
mkdir -p "$FIX"

N=0; PASS=0; FAIL=0
declare -A REL_STATUS=()
ok() { N=$((N + 1)); PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$N" "$1"; }
not_ok() { N=$((N + 1)); FAIL=$((FAIL + 1)); printf 'not ok %d - %s\n' "$N" "$1"; }
relation() { # $1 ok|not_ok, $2 id, $3 text, $4 detail
  REL_STATUS["$2"]="$1"
  if [ "$1" = ok ]; then ok "$2 $3"; else not_ok "$2 $3 — $4"; fi
}
decide() { # $1 relation id, $2 decision id, $3 line id, $4 the chosen option
  local st="${REL_STATUS[$1]:-fail}"
  if [ "$st" = ok ]; then
    ok "$3 $2 honoured: \"$4\" (checked by $1)"
  else
    not_ok "$3 $2 NOT honoured: \"$4\" (checked by $1, which failed)"
  fi
}

RUN_OUT=""; RUN_STATUS=0
run_tool() { # $1 = absolute csv path; leaves the tool's combined output in RUN_OUT and its status in RUN_STATUS
  local csv="$1" cmd
  cmd=$(printf '%s' "$RUN_TEMPLATE" | sed "s|{csv}|$csv|g")
  RUN_OUT=$( ( cd "$WORKTREE" && sh -c "$cmd" ) 2>&1 ); RUN_STATUS=$?
}
dept_fields() { # $1 output, $2 department -> "count total average"
  printf '%s\n' "$1" | awk -v d="$2" '$1 == d && NF >= 4 { print $2, $3, $4; exit }'
}
overall_fields() { printf '%s\n' "$1" | awk '$1 == "TOTAL" { print $2, $3; exit }'; }
skipped_count() { printf '%s\n' "$1" | awk '$1 == "SKIPPED" { print $2; exit }'; }

# The judge's OWN recomputation: given a fixture, a duplicate rule and a rounding rule, print
# "DEPT <dep> <count> <total>" per department and "TOTAL <count> <total>", or ERROR_DUPLICATE. Both
# the duplicate check and the differential anchor compare against THIS, so an expectation can never
# drift from the fixture it is checked against. A row is valid only if it has all five columns, a
# numeric salary and a date-shaped start_date — the three malformed shapes the requirement names.
aggregate() { # $1 fixture, $2 first|last|latest|error, $3 half-up|truncate
  awk -F, -v rule="$2" -v rounding="$3" '
    function rnd(s) { return rounding == "half-up" ? int(s + 0.5) : int(s) }
    NR > 1 {
      if (NF != 5) next
      if ($5 !~ /^-?[0-9]+(\.[0-9]+)?$/) next
      if ($4 !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) next
      n++; rid[n] = $1; rdept[n] = $3; rstart[n] = $4; rsal[n] = $5
    }
    END {
      for (i = 1; i <= n; i++) {
        id = rid[i]
        if (!(id in chosen)) { chosen[id] = i; continue }
        if (rule == "error") { print "ERROR_DUPLICATE"; exit }
        if (rule == "first") continue
        if (rule == "last") { chosen[id] = i; continue }
        if (rule == "latest" && rstart[i] >= rstart[chosen[id]]) chosen[id] = i
      }
      for (id in chosen) {
        i = chosen[id]; d = rdept[i]; s = rnd(rsal[i])
        cnt[d]++; tot[d] += s; total += s; hc++
      }
      for (d in cnt) printf "DEPT %s %d %d\n", d, cnt[d], tot[d]
      printf "TOTAL %d %d\n", hc, total
    }
  ' "$1"
}
HEADER

  printf '\nRUN_TEMPLATE=%s\n' "'$(sq "$RUN_TEMPLATE")'"
  printf 'REQUIREMENT_REF=%s\n' "'$(sq "$TAKUMI_REQUIREMENT")'"
  printf 'DUPLICATE_MODE=%s\n' "'$(sq "$DUPLICATE_MODE")'"
  printf 'MALFORMED_MODE=%s\n' "'$(sq "$MALFORMED_MODE")'"
  printf 'ROUNDING_MODE=%s\n' "'$(sq "$ROUNDING_MODE")'"

  cat <<'BODY'

case "$DUPLICATE_MODE" in
  latest-start-date) DUP_RULE=latest ;;
  first-row) DUP_RULE=first ;;
  last-row) DUP_RULE=last ;;
  error) DUP_RULE=error ;;
  *) printf '# the forged judge got an unknown duplicate mode "%s"\n' "$DUPLICATE_MODE"; DUP_RULE=none ;;
esac

# --- fixtures (generated here, from the requirement and the decisions, never copied from the
# implementation) -------------------------------------------------------------------------------
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

# Two duplicate fixtures, because one cannot separate "last row wins" from "latest start_date wins":
#   dup-late-date : 1003 repeated with a LATER start_date (file order and date agree)
#   dup-early-date: 1003 repeated with an EARLIER start_date (file order and date disagree)
cp "$FIX/base.csv" "$FIX/dup-late-date.csv"
echo "1003,Carol,Engineering,2023-05-05,200" >> "$FIX/dup-late-date.csv"
cp "$FIX/base.csv" "$FIX/dup-early-date.csv"
echo "1003,Carol,Engineering,2019-01-02,200" >> "$FIX/dup-early-date.csv"

# Three malformed rows: a missing column, a non-numeric salary, an unparseable date.
cp "$FIX/base.csv" "$FIX/malformed.csv"
echo "1005,Bad,Engineering,2021-01-01" >> "$FIX/malformed.csv"
echo "1006,Bad,Sales,2021-01-01,abc" >> "$FIX/malformed.csv"
echo "1007,Bad,Sales,not-a-date,120" >> "$FIX/malformed.csv"

valid_rows() { # $1 fixture -> the number of rows a judge would count as valid
  aggregate "$1" first "$ROUNDING_MODE" | awk '$1 == "TOTAL" { print $2; exit }'
}
expected_total() { # $1 fixture, $2 duplicate rule -> the total the tool must print
  aggregate "$1" "$2" "$ROUNDING_MODE" | awk '$1 == "TOTAL" { print $3; exit }'
}
expected_headcount() { # $1 fixture, $2 duplicate rule -> the headcount the tool must print
  aggregate "$1" "$2" "$ROUNDING_MODE" | awk '$1 == "TOTAL" { print $2; exit }'
}

# --- the relations (one per id the requirement declared) ----------------------------------------

run_tool "$FIX/base.csv"
base_output="$RUN_OUT"
base_status="$RUN_STATUS"
if [ -z "$base_output" ]; then
  printf '# the deliverable produced no output at all (exit %s)\n' "$base_status"
fi
base_overall=$(overall_fields "$base_output")
base_headcount=$(printf '%s' "$base_overall" | awk '{print $1}')
base_total=$(printf '%s' "$base_overall" | awk '{print $2}')

# REL-001 row-order-invariance: reshuffling the input must not move a single number.
run_tool "$FIX/base-reversed.csv"
reversed_output="$RUN_OUT"
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

# REL-003 duplicate-resolution — the expectation comes from the CHOSEN option (ADR-028), on both
# fixtures: the late-date one separates "latest date" from "first row", the early-date one separates
# "latest date" from "last row".
dup_late=$(expected_total "$FIX/dup-late-date.csv" "$DUP_RULE")
dup_early=$(expected_total "$FIX/dup-early-date.csv" "$DUP_RULE")
dup_head=$(expected_headcount "$FIX/dup-late-date.csv" "$DUP_RULE")
if [ "$DUP_RULE" = error ]; then
  run_tool "$FIX/dup-late-date.csv"
  dup_status="$RUN_STATUS"; dup_output="$RUN_OUT"
  if [ "$dup_status" != 0 ]; then
    relation ok REL-003 "duplicate-resolution: a repeated id is an error, and the tool failed ($dup_status) as chosen"
  else
    relation not_ok REL-003 "duplicate-resolution: the chosen option is \"treat it as an error\" and the tool exited 0 with a summary" "exit=$dup_status output=$(printf '%s' "$dup_output" | head -2 | tr '\n' ' ')"
  fi
elif [ "$DUP_RULE" = none ]; then
  relation not_ok REL-003 "duplicate-resolution: the forged judge has no duplicate rule" "mode=$DUPLICATE_MODE"
else
  run_tool "$FIX/dup-late-date.csv"
  late_output="$RUN_OUT"; late_status="$RUN_STATUS"
  late_overall=$(overall_fields "$late_output")
  late_head=$(printf '%s' "$late_overall" | awk '{print $1}')
  late_total=$(printf '%s' "$late_overall" | awk '{print $2}')
  run_tool "$FIX/dup-early-date.csv"
  early_output="$RUN_OUT"
  early_total=$(overall_fields "$early_output" | awk '{print $2}')
  if [ -n "$late_total" ] && [ "$late_head" = "$dup_head" ] && [ "$late_total" = "$dup_late" ] && [ "$early_total" = "$dup_early" ]; then
    relation ok REL-003 "duplicate-resolution: \"$DUPLICATE_MODE\" holds on both duplicate fixtures (headcount $dup_head, totals $dup_late / $dup_early)"
  else
    relation not_ok REL-003 "duplicate-resolution: the chosen option \"$DUPLICATE_MODE\" does not hold (headcount $late_head want $dup_head, late-date total $late_total want $dup_late, early-date total $early_total want $dup_early)" "headcount=$late_head/$dup_head totals=$late_total/$dup_late,$early_total/$dup_early"
  fi
fi

# REL-004 malformed-row-accounting — also a function of the chosen option: skip-and-count must
# report the count and keep the totals, stop-with-an-error must fail.
run_tool "$FIX/malformed.csv"
malformed_output="$RUN_OUT"; malformed_status="$RUN_STATUS"
valid=$(valid_rows "$FIX/malformed.csv")
if [ "$MALFORMED_MODE" = skip-count ]; then
  malformed_head=$(overall_fields "$malformed_output" | awk '{print $1}')
  malformed_skipped=$(skipped_count "$malformed_output")
  if [ "$malformed_status" = 0 ] && [ "$malformed_head" = "$valid" ] && [ "$malformed_skipped" = "3" ]; then
    relation ok REL-004 "malformed-row-accounting: 3 malformed rows skipped and counted, $valid valid rows still reports a summary"
  else
    relation not_ok REL-004 "malformed-row-accounting: exit $malformed_status, headcount ${malformed_head:-<none>} (expected $valid), skipped ${malformed_skipped:-<none>} (expected 3)" "exit=$malformed_status headcount=${malformed_head:-none} skipped=${malformed_skipped:-none}"
  fi
elif [ "$MALFORMED_MODE" = stop-error ]; then
  if [ "$malformed_status" != 0 ]; then
    relation ok REL-004 "malformed-row-accounting: a malformed row is an error, and the tool failed ($malformed_status) as chosen"
  else
    relation not_ok REL-004 "malformed-row-accounting: the chosen option is \"stop with an error\" and the tool exited 0 on a malformed input" "exit=$malformed_status"
  fi
else
  relation not_ok REL-004 "malformed-row-accounting: the forged judge has no malformed-row rule" "mode=$MALFORMED_MODE"
fi

# DIFF-001 independent-aggregation: the judge recomputes the aggregates itself, from the fixture,
# with the chosen duplicate rule and the chosen rounding — a differential anchor, not a re-reading of
# the tool's own arithmetic.
anchor=$(aggregate "$FIX/base.csv" "$DUP_RULE" "$ROUNDING_MODE" | grep '^DEPT' | awk '{print $2, $3, $4}' | sort)
tool_depts=$(printf '%s\n' "$base_output" | grep -Ev '^(SKIPPED|TOTAL)' | awk '{print $1, $2, $3}' | sort)
if [ -n "$anchor" ] && [ "$anchor" = "$tool_depts" ]; then
  relation ok DIFF-001 "independent-aggregation: an independent recomputation (rounding: $ROUNDING_MODE) matches the report"
else
  relation not_ok DIFF-001 "independent-aggregation: an independent recomputation (rounding: $ROUNDING_MODE) disagrees with the report" "$(printf '%s\n' "$anchor" | diff - <(printf '%s\n' "$tool_depts") | head -6 | tr '\n' ' ')"
fi

# DOC-001 every open decision in the confirmed document has a chosen option. This is a check on the
# HUMAN artefact, not on the implementation: an acceptance of a document whose decisions were never
# settled accepts something nobody agreed to.
DOC="$TAKUMI_PROJECT/$REQUIREMENT_REF"
amb=$(grep -Ec '^[[:space:]]*-[[:space:]]*id:[[:space:]]*AMB-[0-9]+' "$DOC" 2>/dev/null || echo 0)
chosen=$(grep -Ec '^[[:space:]]*chosen:[[:space:]]*[^[:space:]]' "$DOC" 2>/dev/null || echo 0)
if [ "$amb" -gt 0 ] && [ "$chosen" -ge "$amb" ]; then
  relation ok DOC-001 "every open decision has a chosen option ($chosen/$amb)"
else
  relation not_ok DOC-001 "not every open decision has a chosen option ($chosen/$amb)" "chosen=$chosen ambiguities=$amb"
fi
BODY

  # The decision lines, generated from the document: one per decision a relation or anchor exercises.
  # `decide` is defined in the judge's header and reads the exercised relation's own verdict, so a
  # decision can never be reported honoured by a check that failed.
  #
  # `emit_print` writes a PRINT statement into the judge rather than a bare `#` line: a `#` line in the
  # generated file is a comment to the judge too, which is how a "not mechanised" note disappears from
  # a report without anyone noticing.
  emit_print() { printf "printf '%%s\\n' '%s'\n" "$(sq "$1")"; }
  printf '\n'
  emit_print '# --- the decisions (ADR-028): the option the human CHOSE, checked by the relation bound to it --'
  printf '%s\n' "$DEC_TABLE" | while read -r rel amb dec chosen; do
    [ -z "${rel:-}" ] && continue
    printf 'decide %s %s %s %s\n' "$rel" "$amb" "$dec" "'$(sq "$chosen")'"
  done
  emit_print "# decisions declared here: $(printf '%s\n' "$DEC_TABLE" | awk 'NF { printf "%s->%s ", $3, $2 }')"

  printf '\n'
  emit_print '# --- what this judge does NOT check ------------------------------------------------------------'
  emit_print '# The criteria a judge cannot mechanise are stated as diagnostics. They are NOT reported ok: an'
  emit_print '# unmechanised criterion reported as a pass is the exact vacuous green ADR-013 exists to prevent.'
  emit_print '# not mechanised: the 50,000-row performance criterion (REQ-001)'
  emit_print '# not mechanised: the count of resolved duplicates being printed (REQ-003)'
  emit_print '# not mechanised: the optional output-file argument (REQ-004)'
  if [ -n "$UNEXERCISED" ]; then
    printf '%s\n' "$UNEXERCISED" | while read -r line; do
      [ -z "${line:-}" ] && continue
      emit_print "$line"
    done
  fi

  cat <<'FOOTER'

printf '# tests %d\n' "$N"
printf '# pass %d\n' "$PASS"
printf '# fail %d\n' "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  printf 'ACCEPT_VERDICT: pass\n'
  exit 0
fi
printf 'ACCEPT_VERDICT: fail\n'
exit 1
FOOTER
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
