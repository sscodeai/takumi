#!/usr/bin/env bash
# The metamorphic judge forge (ADR-026), bound to the human's DECISIONS (ADR-028) and to the WORLD the
# requirement document DECLARES (ADR-033).
#
# A generator, run OUTSIDE the implementation worktree and WITHOUT the implementation: it reads the
# confirmed requirement document's `deliverable` block — how the thing is run, the world its input lives
# in (`input_format`), the shapes its output takes (`output_format`), the relations a judge must be able
# to check, and WHICH DECISION each relation exercises (`decides:`) — and writes a judge that runs the
# deliverable against FIXTURES IT GENERATES ITSELF and judges invariants rather than outputs.
#
# ADR-028 changed what a relation may be. A relation that exercises a decision (a `decides: <AMB-id>`
# line) derives its FIXTURE and its EXPECTED VALUES from that decision's `chosen` option, and the judge
# emits one `DEC-nnn` line per decision saying whether the implementation HONOURS the option the human
# recorded. Recording a decision and checking it are now the same act:
#
#   * a BLOCKING decision that no declared relation or anchor exercises is a REFUSAL;
#   * a `decides:` naming a decision the document does not contain is a REFUSAL;
#   * a `chosen` value this forge cannot mechanise is a REFUSAL, with the mechanisable values named;
#   * a decision that would need a rounding rule the document never decides is a REFUSAL, because the
#     alternative is a judge silently inventing one.
#
# ADR-033 changed WHERE the fixtures come from. Before it, this forge carried the fixture rows and the
# row-validity predicates inside itself, in one hard-coded employee/department world; a requirement about
# STATION TEMPERATURES was therefore judged with employee-salary fixtures, every relation failed for the
# wrong reason, and one relation passed because both of its sides were empty. Now the document declares
# its own world — typed `input_format.columns`, a `input_format.sample` of real rows, and
# `output_format` shapes whose `<placeholders>` carry positional ROLES (`id`, `count`, `min`, `mean`, …)
# — and the judge builds every fixture and computes every expectation in THAT world. A shape with no
# `fields` is a words-only line and is reported as `# not mechanised`, never as a pass. The judge also
# carries a VACUOUS-GREEN GUARD: output that no declared shape can parse fails every relation, because a
# relation must never pass by comparing two empty results.
#
# Three further properties matter more than the checks themselves:
#
#   1. It refuses to build a judge it cannot fully implement. A relation id this forge does not know, an
#      input world it cannot read, or a shape it cannot parse is a REFUSAL, not a skipped check: a gap
#      nobody notices is exactly how an acceptance becomes decoration.
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
refuse() { echo "$1" >&2; exit 1; }

# --- read the deliverable contract out of the requirement document -----------------------------

# The DIRECT child of `deliverable:` named $1, or empty. "Direct" is the indent rule this forge uses
# everywhere: the value has to sit exactly one indent step deeper than the `deliverable:` key, so a
# scenario's `run`/`url` or the mutation block's `timeoutMs` is never mistaken for the deliverable's.
# The OUTER quote pair (either kind) is the YAML quoting, not the value — `'"total"'` is the substring
# `"total"`, and reading it as `'"total"'` is how a body assertion searched for a string no response
# contains. A single quote cannot be written literally inside a shell-quoted awk program, so it is built
# from its byte code.
deliv_child() {
  awk -v k="$1" '
    function ind(s) { match(s, /^[ ]*/); return RLENGTH }
    function strip_outer(s,   c, n, SQ) {
      SQ = sprintf("%c", 39); n = length(s)
      if (n >= 2) { c = substr(s, 1, 1); if ((c == "\"" || c == SQ) && substr(s, n, 1) == c) return substr(s, 2, n - 2) }
      return s
    }
    /^[[:space:]]*deliverable:[[:space:]]*$/ { ind_d = 1; di = ind($0); next }
    ind_d && $0 ~ /^[[:space:]]*[a-zA-Z_]+:[[:space:]]*$/ && ind($0) <= di { ind_d = 0; next }
    ind_d && ind($0) == di + 2 && $0 ~ ("^[[:space:]]*" k ":[[:space:]]*") {
      v = $0; sub("^[[:space:]]*" k ":[[:space:]]*", "", v); print strip_outer(v); exit
    }
  ' "$DOC"
}

RUN_TEMPLATE=$(deliv_child run)
if [ -z "$RUN_TEMPLATE" ]; then
  refuse "the requirement document declares no deliverable.run, so there is no way to run the thing"
fi

# --- how a judge READS the report (ADR-047) -------------------------------------------------------
# A SCRIPT prints its report on stdout, so `run` alone is enough and this is empty. A SERVICE starts and
# serves: `run` prints NOTHING, so a judge that reads stdout finds no report at all and every
# output-shape relation reports "the judge did not exercise the deliverable" — the service shape could
# never pass, however correct it was. `read` is the command that FETCHES the report for the fixture
# `run` was started with, and `url` is the surface the judge waits for before it runs it. They go
# together, and one without the other is refused: a service whose report no judge can fetch is a
# delivery judged on nothing.
DELIV_READ=$(deliv_child read)
DELIV_URL=$(deliv_child url)
if [ -n "$DELIV_READ" ] && [ -z "$DELIV_URL" ]; then
  refuse "the deliverable block declares read but no url: a judge that has to fetch the report must know which surface to wait for before it fetches"
fi
if [ -n "$DELIV_URL" ] && [ -z "$DELIV_READ" ]; then
  refuse "the deliverable block declares url but no read: a service whose report the judge cannot fetch is judged on nothing — declare how one fixture's report is read (read: \"curl -fsS {url}\")"
fi

# --- the bound on ONE invocation of the deliverable (ADR-046) -------------------------------------
# A SERVICE-shaped `run` is a start-and-serve command that NEVER exits: without a bound the judge waits
# for ever. The bound is therefore unconditional — and it applies to the `read` that fetches the report
# as well, because a fetch that never returns is the same hang one step later. The floor and default live
# on their own lines so the TypeScript front door and this shell are kept honest by a test that parses
# both.
RUN_MIN_TIMEOUT_MS=1000
DEFAULT_RUN_TIMEOUT_MS=120000
RUN_TIMEOUT_MS=$(deliv_child timeoutMs)
if [ -n "$RUN_TIMEOUT_MS" ]; then
  case "$RUN_TIMEOUT_MS" in
    ''|*[!0-9]*) refuse "the deliverable block declares timeoutMs \"$RUN_TIMEOUT_MS\", which is not a whole number of milliseconds" ;;
  esac
  [ "$RUN_TIMEOUT_MS" -ge "$RUN_MIN_TIMEOUT_MS" ] || refuse "the deliverable block declares timeoutMs $RUN_TIMEOUT_MS, below the honest floor of ${RUN_MIN_TIMEOUT_MS}ms for one invocation of the deliverable"
fi
[ -n "$RUN_TIMEOUT_MS" ] || RUN_TIMEOUT_MS=$DEFAULT_RUN_TIMEOUT_MS
RUN_TIMEOUT_S=$(( RUN_TIMEOUT_MS / 1000 ))
[ "$RUN_TIMEOUT_S" -ge 1 ] || RUN_TIMEOUT_S=1

# --- the deliverable keys nothing reads (ADR-046) ------------------------------------------------
# `deliverable.build` and `deliverable.tests` are DEAD TEXT: the delivered project's own tests are run
# from the WORKFLOW's `testCommand`, and no install/build step exists anywhere in the chain. The front
# door refuses both; the forge refuses them too, so a document that reached a judge WITHOUT passing the
# front door cannot have a key silently ignored — a declaration that is never executed reads as
# compliance, which is the defect this refusal removes.
for deadkey in build tests; do
  if awk -v k="$deadkey" '
    function ind(s) { match(s, /^[ ]*/); return RLENGTH }
    /^[[:space:]]*deliverable:[[:space:]]*$/ { ind_d = 1; di = ind($0); next }
    ind_d && $0 ~ /^[[:space:]]*[a-zA-Z_]+:[[:space:]]*$/ && ind($0) <= di { ind_d = 0; next }
    ind_d && ind($0) == di + 2 && $0 ~ ("^[[:space:]]*" k ":[[:space:]]*") { f = 1 }
    END { exit f ? 0 : 1 }
  ' "$DOC"; then
    refuse "the deliverable block declares $deadkey, which nothing in the chain reads or runs: a declaration that is never executed reads as compliance, which is worse than a refusal — either wire it as a real step or remove it (the delivered project's own tests are run from the workflow's testCommand, not from deliverable.tests)"
  fi
done

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
  refuse "the requirement document declares no deliverable.relations: a judge with nothing to check is not a judge"
fi

# --- the declared scenarios (ADR-035) -----------------------------------------------------------
# Flat, line-wise: `id|run|expect|start|url|report|report_path|timeoutMs|decides|expect_status|
# expect_body`, one record per scenario, values joined with the unit separator so a command containing
# spaces survives.
SCENARIOS=$(awk '
  function flush() {
    if (id == "") return
    # TAB-separated, one scenario per line: `read -r` splits it back without treating the separator as a
    # regular expression, which is how the first attempt lost every field after the fourth.
    sep = "\t"
    print id sep run sep expect sep start sep url sep report sep rpath sep tmo sep decides sep status sep body
    id = ""; run = ""; expect = ""; start = ""; url = ""; report = ""; rpath = ""; tmo = ""; decides = ""; status = ""; body = ""
  }
  # The value of `key:` — with the YAML list marker stripped first. A scenario id is the one field that
  # arrives as `- id: SCN-001`, and `sub("^[[:space:]]*id:…")` cannot match it (the `- ` is not
  # whitespace), so the whole line would become the id and every later field would read as empty
  # (docs/bugs-fixed.md #41).
  function ind(s) { match(s, /^[ ]*/); return RLENGTH }
  function unmark(s) { sub(/^[[:space:]]*-[[:space:]]*/, "", s); return s }
  # The OUTER quote pair, whichever kind YAML used, is the quoting and not part of the value:
  # `expect_body: '"total"'` means the substring `"total"`, and `"station"` means `station`. Stripping
  # only double quotes read the first as `'"total"'` (single quotes included) and searched for a
  # substring no response contains — a check that fails for a reason the document never said.
  # A single quote cannot be written literally inside this shell-quoted awk program, so it is built.
  function strip_outer(s,   c, n, SQ) {
    SQ = sprintf("%c", 39); n = length(s)
    if (n >= 2) { c = substr(s, 1, 1); if ((c == "\"" || c == SQ) && substr(s, n, 1) == c) return substr(s, 2, n - 2) }
    return s
  }
  function val(s, k) { s = unmark(s); sub("^[[:space:]]*" k ":[[:space:]]*", "", s); return strip_outer(s) }
  /^[[:space:]]*scenarios:[[:space:]]*$/ { ins = 1; si = 2; next }
  # The section ends at the next key INDENTED NO FURTHER than the scenarios key itself. The previous
  # terminator only matched an unindented key, so a document declaring scenarios under deliverable never
  # left the block and the parser kept reading later keys (a decides: AMB-nnn far below became a
  # report field) — docs/bugs-fixed.md #41. Apostrophes and backticks are absent from these comments on
  # purpose: a single quote inside an unquoted shell context closes the program and the rest of the block
  # becomes shell syntax.
  ins && ind($0) <= si && $0 ~ /^[[:space:]]*[a-zA-Z_]+:[[:space:]]*$/ { flush(); ins = 0; next }
  ins && /^[[:space:]]*-[[:space:]]*id:[[:space:]]*SCN-/ { flush(); id = val($0, "id"); next }
  ins && /^[[:space:]]*run:[[:space:]]*/ { run = val($0, "run"); next }
  ins && /^[[:space:]]*expect:[[:space:]]*/ { expect = val($0, "expect"); next }
  ins && /^[[:space:]]*start:[[:space:]]*/ { start = val($0, "start"); next }
  ins && /^[[:space:]]*url:[[:space:]]*/ { url = val($0, "url"); next }
  ins && /^[[:space:]]*report:[[:space:]]*/ { report = val($0, "report"); next }
  ins && /^[[:space:]]*report_path:[[:space:]]*/ { rpath = val($0, "report_path"); next }
  ins && /^[[:space:]]*timeoutMs:[[:space:]]*/ { tmo = val($0, "timeoutMs"); next }
  ins && /^[[:space:]]*decides:[[:space:]]*/ { decides = val($0, "decides"); next }
  ins && /^[[:space:]]*expect_status:[[:space:]]*/ { status = val($0, "expect_status"); next }
  ins && /^[[:space:]]*expect_body:[[:space:]]*/ { body = val($0, "expect_body"); next }
  END { flush() }
' "$DOC")

SCENARIO_IDS=" $(printf '%s\n' "$SCENARIOS" | awk -F'\t' 'NF { printf "%s ", $1 }')"
scenario_field() { # $1 id, $2 field number
  # awk, and not `while IFS=$'\t' read -r f1 … f9`: TAB is an IFS WHITESPACE character, so `read` folds a
  # run of tabs into one separator and every field after an EMPTY one shifts left — a scenario with no
  # `run:` reported its own `expect:` text as its run (docs/bugs-fixed.md #41).
  printf '%s\n' "$SCENARIOS" | awk -F'\t' -v id="$1" -v n="$2" '$1 == id { print $n; exit }'
}
has_scenario() { case "$SCENARIO_IDS" in *" $1 "*) echo yes ;; *) echo no ;; esac; }

SCENARIO_REPORT_MODES="ctrf junit tap"
# The declared scenarios are checks too (ADR-035): they join the dispatch list as
# `<SCN-id> browser-scenario`, so the loop that runs every relation runs them as well and every downstream
# rule (a blocking decision must be exercised, DEC-nnn lines, the check-id sets) sees them like any other.
for sid in $SCENARIO_IDS; do
  [ -z "$sid" ] && continue
  # The separator is a LEADING newline: `$RELATIONS` does not end in one (command substitution strips
  # trailing newlines), and appending `$(printf '%s\n' …)` also strips it — which glued the last relation
  # and the first scenario into one unparseable record.
  RELATIONS="$RELATIONS$(printf '\n%s browser-scenario' "$sid")"
done

while read -r sid; do
  [ -z "${sid:-}" ] && continue
  srun=$(scenario_field "$sid" 2)
  [ -n "$srun" ] || refuse "the scenario $sid declares no run: a scenario with no command to run is not a check"
  [ -n "$(scenario_field "$sid" 3)" ] || refuse "the scenario $sid declares no expect: the criterion has to be in words a human can read"
  sreport=$(scenario_field "$sid" 6)
  srpath=$(scenario_field "$sid" 7)
  [ -n "$sreport" ] || [ -z "$srpath" ] || refuse "the scenario $sid declares report_path but no report: the judge would read a file without being told what wrote it (report: $SCENARIO_REPORT_MODES)"
  [ -z "$sreport" ] || [ -n "$srpath" ] || refuse "the scenario $sid declares report \"$sreport\" but no report_path: a report the judge cannot find is not evidence"
  # Only a DECLARED report is checked: a scenario that judges by exit code alone is complete without one,
  # and matching `""` against the format list refused every such scenario (docs/bugs-fixed.md #41).
  if [ -n "$sreport" ]; then
    case " $SCENARIO_REPORT_MODES " in
      *" $sreport "*) ;;
      *) refuse "the scenario $sid declares the report format \"$sreport\", which no judge can read (implemented: $SCENARIO_REPORT_MODES)" ;;
    esac
  fi
  # ADR-046: a scenario that reaches an HTTP surface (a `url` to wait for, a `start` to bring up) has to
  # SAY WHAT IT ASSERTS about the response. Without an assertion the scenario's `run` only has to exit 0,
  # so a command that reaches the surface but never looks at it passes whatever the surface said — the
  # vacuous green this project treats as the worst kind of defect. A service scenario with neither
  # `expect_status` nor `expect_body` is REFUSED, and a declared assertion has to be one the judge can
  # apply: an HTTP status 100..599, or a non-empty substring of the body.
  sstart=$(scenario_field "$sid" 4)
  surl=$(scenario_field "$sid" 5)
  sstatus=$(scenario_field "$sid" 10)
  sbody=$(scenario_field "$sid" 11)
  if [ -n "$surl" ] || [ -n "$sstart" ]; then
    if [ -z "$sstatus" ] && [ -z "$sbody" ]; then
      refuse "the scenario $sid declares a url/start but neither expect_status nor expect_body: a scenario that reaches a surface without asserting anything about the response passes without ever looking at it, so the check is vacuous — declare expect_status: <100-599> and/or expect_body: <substring of the response body>"
    fi
  fi
  if [ -n "$sstatus" ]; then
    case "$sstatus" in
      ''|*[!0-9]*) refuse "the scenario $sid declares expect_status \"$sstatus\", which is not an HTTP status code (an integer from 100 to 599): the judge would compare the surface's answer against a number it cannot mean" ;;
    esac
    [ "$sstatus" -ge 100 ] && [ "$sstatus" -le 599 ] || refuse "the scenario $sid declares expect_status $sstatus, which is not an HTTP status code (an integer from 100 to 599): the judge would compare the surface's answer against a number it cannot mean"
  fi
  if [ -n "$sbody" ]; then
    [ -n "$(printf '%s' "$sbody" | tr -d '[:space:]')" ] || refuse "the scenario $sid declares expect_body \"$sbody\", which is not a non-empty string: a body assertion the judge cannot search for asserts nothing"
  fi
done <<EOF
$SCENARIO_IDS
EOF

# --- the declared mutation block (ADR-039) ------------------------------------------------------
# The mutation relation's tool configuration, flat and line-wise: `run|report_path|format|max_survivors|
# timeoutMs` in one TAB-separated record, so a command containing spaces survives. This block is not a
# check itself: it configures the `mutation-detection` relation the document declares in `relations:`,
# which the dispatch loop already walks like any other relation. The section ends at the next key INDENTED
# NO FURTHER than the mutation key, the same rule the scenarios parser learned the hard way.
MUTATION=$(awk '
  function ind(s) { match(s, /^[ ]*/); return RLENGTH }
  function unmark(s) { sub(/^[[:space:]]*-[[:space:]]*/, "", s); return s }
  # The outer quote pair is the quoting, not the value (see the scenarios parser): a single quote is
  # built from its byte code because it cannot be written inside this shell-quoted program.
  function strip_outer(s,   c, n, SQ) {
    SQ = sprintf("%c", 39); n = length(s)
    if (n >= 2) { c = substr(s, 1, 1); if ((c == "\"" || c == SQ) && substr(s, n, 1) == c) return substr(s, 2, n - 2) }
    return s
  }
  function val(s, k) { s = unmark(s); sub("^[[:space:]]*" k ":[[:space:]]*", "", s); return strip_outer(s) }
  /^[[:space:]]*mutation:[[:space:]]*$/ { inm = 1; mi = ind($0); next }
  inm && ind($0) <= mi && $0 ~ /^[[:space:]]*[a-zA-Z_]+:[[:space:]]*$/ { inm = 0; next }
  inm && /^[[:space:]]*run:[[:space:]]*/ { mrun = val($0, "run"); next }
  inm && /^[[:space:]]*report_path:[[:space:]]*/ { mrpath = val($0, "report_path"); next }
  inm && /^[[:space:]]*format:[[:space:]]*/ { mfmt = val($0, "format"); next }
  inm && /^[[:space:]]*max_survivors:[[:space:]]*/ { mmax = val($0, "max_survivors"); next }
  inm && /^[[:space:]]*timeoutMs:[[:space:]]*/ { mtmo = val($0, "timeoutMs"); next }
  END { if (mrun != "" || mrpath != "" || mfmt != "" || mmax != "" || mtmo != "") print mrun "\t" mrpath "\t" mfmt "\t" mmax "\t" mtmo }
' "$DOC")

MUTATION_FORMATS="survivors-json"
MUTATION_MIN_TIMEOUT_MS=5000
MUT_RUN=""; MUT_REPORT_PATH=""; MUT_FORMAT=""; MUT_MAX_SURVIVORS=""; MUT_TIMEOUT_MS=""
if [ -n "$MUTATION" ]; then
  MUT_RUN=$(printf '%s\n' "$MUTATION" | awk -F'\t' '{ print $1 }')
  MUT_REPORT_PATH=$(printf '%s\n' "$MUTATION" | awk -F'\t' '{ print $2 }')
  MUT_FORMAT=$(printf '%s\n' "$MUTATION" | awk -F'\t' '{ print $3 }')
  MUT_MAX_SURVIVORS=$(printf '%s\n' "$MUTATION" | awk -F'\t' '{ print $4 }')
  MUT_TIMEOUT_MS=$(printf '%s\n' "$MUTATION" | awk -F'\t' '{ print $5 }')
fi

# How many relations the mutation block configures: one block, one check. A mutation run is the most
# expensive check in the vocabulary, so a second relation re-running it is a cost with no second check.
MUT_REL_COUNT=$(printf '%s\n' "$RELATIONS" | awk '$2 == "mutation-detection" { n++ } END { print n + 0 }')
MUT_REL_IDS="$(printf '%s\n' "$RELATIONS" | awk '$2 == "mutation-detection" { printf "%s ", $1 }')"

if [ "$MUT_REL_COUNT" -gt 1 ]; then
  refuse "the document declares $MUT_REL_COUNT mutation-detection relations ($MUT_REL_IDS): one mutation block configures one check, and running the tool once per relation is the same run paid for twice"
fi
if [ "$MUT_REL_COUNT" -ge 1 ] && [ -z "$MUTATION" ]; then
  refuse "a mutation-detection relation is declared with no mutation block: a check with nothing to run is not a check"
fi
if [ -n "$MUTATION" ] && [ "$MUT_REL_COUNT" -eq 0 ]; then
  refuse "the document declares a mutation block, but no relation uses it: a tool nobody checks with is cost with no check"
fi
if [ -n "$MUTATION" ]; then
  [ -n "$MUT_RUN" ] || refuse "the mutation block declares no run: a mutation check with no command to run is not a check"
  [ -n "$MUT_REPORT_PATH" ] || refuse "the mutation block declares no report_path: a report the judge cannot find is not evidence"
  [ -n "$MUT_FORMAT" ] || refuse "the mutation block declares no format: the judge would read a file without being told what wrote it (implemented: $MUTATION_FORMATS)"
  case " $MUTATION_FORMATS " in
    *" $MUT_FORMAT "*) ;;
    *) refuse "the mutation block declares the format \"$MUT_FORMAT\", which no judge can read (implemented: $MUTATION_FORMATS)" ;;
  esac
  case "$MUT_MAX_SURVIVORS" in
    ''|*[!0-9]*) refuse "the mutation block declares max_survivors \"$MUT_MAX_SURVIVORS\", which is not a non-negative integer: the budget is how many uncaught mutants are tolerated" ;;
  esac
  if [ -n "$MUT_TIMEOUT_MS" ]; then
    case "$MUT_TIMEOUT_MS" in
      ''|*[!0-9]*) refuse "the mutation block declares timeoutMs \"$MUT_TIMEOUT_MS\", which is not a whole number of milliseconds" ;;
    esac
    [ "$MUT_TIMEOUT_MS" -ge "$MUTATION_MIN_TIMEOUT_MS" ] || refuse "the mutation block declares timeoutMs $MUT_TIMEOUT_MS, below the honest floor of ${MUTATION_MIN_TIMEOUT_MS}ms for a tool that runs the delivered suite once per mutant"
  fi
fi
# A mutation run is many test runs: the bound is declared, not assumed, and the default is generous.
[ -n "$MUT_TIMEOUT_MS" ] || MUT_TIMEOUT_MS=900000
MUT_TIMEOUT_S=$((MUT_TIMEOUT_MS / 1000))
[ -n "$MUT_MAX_SURVIVORS" ] || MUT_MAX_SURVIVORS=0

# The ambiguities: id|blocking|chosen|checkedAs|options (options joined by ';').
AMBIGUITIES=$(awk '
  /^[[:space:]]*ambiguities:[[:space:]]*$/ { ina = 1; next }
  /^[a-z_]+:[[:space:]]*$/ { ina = 0 }
  ina && /^[[:space:]]*-[[:space:]]*id:[[:space:]]*AMB-/ {
    if (id != "") print id "|" blocking "|" chosen "|" checkedAs "|" options
    id = $3; blocking = "false"; chosen = ""; checkedAs = ""; options = ""; next
  }
  ina && /^[[:space:]]*chosen:[[:space:]]*/ { t = $0; sub(/^[[:space:]]*chosen:[[:space:]]*/, "", t); gsub(/^"|"$/, "", t); chosen = t; next }
  ina && /^[[:space:]]*checkedAs:[[:space:]]*/ { t = $0; sub(/^[[:space:]]*checkedAs:[[:space:]]*/, "", t); gsub(/^"|"$/, "", t); checkedAs = t; next }
  ina && /^[[:space:]]*blocking:[[:space:]]*/ { blocking = $2; next }
  ina && /^[[:space:]]*-[[:space:]]*"/ { t = $0; sub(/^[[:space:]]*-[[:space:]]*/, "", t); gsub(/^"|"$/, "", t); options = (options == "" ? t : options ";" t); next }
  END { if (id != "") print id "|" blocking "|" chosen "|" checkedAs "|" options }
' "$DOC")

# The ambiguity records are `id|blocking|chosen|checkedAs|options`, so the accessors are named rather
# than numbered: a numbered field is how a forge ends up matching a decision against its own `blocking`.
amb_exists() { printf '%s\n' "$AMBIGUITIES" | awk -F'|' -v id="$1" '$1 == id { f = 1 } END { print f ? "yes" : "no" }'; }
amb_blocking() { printf '%s\n' "$AMBIGUITIES" | awk -F'|' -v id="$1" '$1 == id { print $2; exit }'; }
amb_chosen() { printf '%s\n' "$AMBIGUITIES" | awk -F'|' -v id="$1" '$1 == id { print $3; exit }'; }
amb_mode() { printf '%s\n' "$AMBIGUITIES" | awk -F'|' -v id="$1" '$1 == id { print $4; exit }'; }
decides_of() { # $1 relation/anchor id -> the decision it exercises, or empty
  printf '%s\n' "$DECIDES" | awk -v id="$1" '$1 == id { print $2; exit }'
}
has_rel() { printf '%s\n' "$RELATIONS" | awk -v r="$1" '$2 == r { f = 1 } END { print f ? "yes" : "no" }'; }

# Every declared relation must be one this forge implements: refusing beats a silent gap.
IMPLEMENTED=" row-order-invariance additivity duplicate-resolution malformed-row-accounting independent-aggregation browser-scenario mutation-detection "
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
  refuse "this forge does not implement:$MISSING — refusing to build a judge with a gap in it (implemented:$IMPLEMENTED)"
fi

# --- the decisions the judge will derive its expectations from (ADR-028) ------------------------

# Which decision each relation exercises must name a decision the document actually contains.
while read -r id amb; do
  [ -z "${amb:-}" ] && continue
  if [ "$(amb_exists "$amb")" = no ]; then
    refuse "\"$id\" exercises \"$amb\", which is not a decision in this document: a check bound to nothing decides nothing"
  fi
done <<EOF
$DECIDES
EOF

# A decision may say which failure it came from (ADR-030). A citation that names nothing is a claim
# nobody can check, so it is refused the same way a `decides:` naming nothing is.
FEEDBACK_IDS=" $(grep -E '^[[:space:]]*-[[:space:]]*id:[[:space:]]*FB-[0-9]+' "$DOC" | sed 's/^[[:space:]]*-[[:space:]]*id:[[:space:]]*//' | tr '\n' ' ')"
CITATIONS=$(awk '/^[[:space:]]*fromFeedback:[[:space:]]*/ { t = $0; sub(/^[[:space:]]*fromFeedback:[[:space:]]*/, "", t); gsub(/^"|"$/, "", t); print t }' "$DOC")
while read -r cited; do
  [ -z "${cited:-}" ] && continue
  case "$FEEDBACK_IDS" in
    *" $cited "*) ;;
    *)
      refuse "a decision cites \"$cited\", which this document does not record as a failure (recorded:$FEEDBACK_IDS): a citation that names nothing is a claim nobody can check"
      ;;
  esac
done <<EOF
$CITATIONS
EOF

# A blocking decision nothing exercises is a decision that does not bind the implementation.
UNCOVERED=""
while IFS='|' read -r id blocking _chosen _checkedAs _options; do
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
  refuse "blocking decision(s)$UNCOVERED are exercised by no declared relation or anchor: add \"decides: AMB-nnn\" to the check that settles them — a blocking decision nothing checks does not bind the implementation"
fi

# The mechanisable answers, per relation. A chosen option outside its table is a refusal, never a
# silently skipped check: the vocabulary below IS the honest scale of what this judge can decide.
DUPLICATE_MODES="first-row last-row latest-start-date merge error"
MALFORMED_MODES="skip-count skip-silent stop-error"
ROUNDING_MODES="half-up truncate"

refuse_mode() { # $1 relation id, $2 decision id, $3 what the document said (or nothing), $4 the modes
  if [ -z "${3:-}" ]; then
    echo "the decision $2 is settled by $1, and the relation needs to know what its answer MEANS: give it \"checkedAs: <$4>\" — prose is for humans, and a judge that has to guess is a judge you cannot trust" >&2
  else
    echo "the decision $2 says checkedAs: \"$3\", which $1 cannot act on (implemented: $4): either change it in the document or implement it in the forge, but a decision nobody can check is not a decision" >&2
  fi
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
    refuse "the relation $id exercises $amb, but $amb has no chosen option: the judge would be built from a decision nobody made"
  fi
  mode=$(amb_mode "$amb")
  # Only the relations that have a meaning to check need one: `row-order-invariance` and `additivity` are
  # properties of the output, not answers to a question.
  wants=""
  case "$relation" in
    duplicate-resolution) wants="$DUPLICATE_MODES" ;;
    malformed-row-accounting) wants="$MALFORMED_MODES" ;;
    independent-aggregation) wants="$ROUNDING_MODES" ;;
  esac
  if [ -n "$wants" ]; then
    case " $wants " in
      *" $mode "*) ;;
      *) refuse_mode "$id" "$amb" "$mode" "$wants" ;;
    esac
  fi
  case "$relation" in
    duplicate-resolution)
      [ -n "$DUPLICATE_MODE" ] && [ "$DUPLICATE_MODE" != "$mode" ] && { refuse "two relations disagree about $amb: $DUPLICATE_MODE vs $mode"; }
      DUPLICATE_MODE="$mode"
      ;;
    malformed-row-accounting) MALFORMED_MODE="$mode" ;;
    independent-aggregation) ROUNDING_MODE="$mode" ;;
  esac
done <<EOF
$RELATIONS
EOF

# The judge computes its expectations from the fixture, so it needs to know how values are rounded.
# Assuming one would be the judge inventing a requirement: refuse instead.
if [ -z "$ROUNDING_MODE" ]; then
  refuse "no declared relation or anchor exercises a rounding decision, so the judge would have to assume how salaries are rounded: point a relation or anchor at the decision that settles it (\"decides: AMB-nnn\")"
fi

blocking_note() { [ "$(amb_blocking "$1")" = "true" ] && printf ' (BLOCKING — the forge should have refused)' || printf ' (non-blocking decision)'; }
exercised_by() { printf '%s\n' "$DECIDES" | awk -v amb="$1" '$2 == amb { print $1; exit }'; }

# The DEC lines: one per exercised decision, in document order.
DEC_TABLE=""
n=0
while IFS='|' read -r id _blocking chosen _checkedAs _options; do
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
UNEXERCISED=$(while IFS='|' read -r id _blocking chosen _checkedAs _options; do
  [ -z "${id:-}" ] && continue
  [ -n "$(exercised_by "$id")" ] && continue
  printf '# not mechanised%s: %s "%s" is exercised by no declared relation or anchor\n' "$(blocking_note "$id")" "$id" "$chosen"
done <<EOF
$AMBIGUITIES
EOF
)

# --- the declared world (ADR-033): the columns, the sample, and the output shapes ---------------

INPUT_COLUMNS=$(awk '
  /^[[:space:]]*columns:[[:space:]]*/ {
    t = $0; sub(/^[[:space:]]*columns:[[:space:]]*/, "", t); gsub(/^"|"$/, "", t); print t; exit
  }' "$DOC")
if [ -z "${INPUT_COLUMNS:-}" ]; then
  refuse "the deliverable block declares no input_format.columns: a judge with no declared world builds its own fixtures and judges a scenario nobody asked for (add input_format with typed columns)"
fi

SAMPLE=$(awk '
  function ind(s) { match(s, /^[ ]*/); return RLENGTH }
  function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
  BEGIN { ins = 0; si = -1 }
  {
    if (!ins && $0 ~ /^[[:space:]]*sample:[[:space:]]*([|>].*)?$/) { ins = 1; si = ind($0); next }
    if (ins) {
      if ($0 ~ /^[[:space:]]*$/) next
      if (ind($0) <= si) { ins = 0; next }
      print trim($0)
    }
  }
' "$DOC")
if [ -z "${SAMPLE:-}" ]; then
  refuse "the deliverable block declares no input_format.sample: a judge needs at least three real rows to build a base, a reshuffled and a duplicated fixture"
fi

OUTPUT_LINES=$(awk '
  function ind(s) { match(s, /^[ ]*/); return RLENGTH }
  function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
  # The OUTER quote pair, whichever kind YAML used, is the quoting and NOT part of the shape: the
  # spike document writes `shape: '{"station":...}'`, which IS the JSON object. Stripping only double
  # quotes kept the single quotes, so the forged regex became `^'\{...}'$` — a pattern demanding a
  # literal quote at BOTH ends — and an implementation that served the declared shape correctly failed
  # every relation with "nothing in its output matched a declared output shape": a check failing for a
  # reason the document never said (ADR-038, the same class as docs/bugs-fixed.md #56).
  # A single quote cannot be written literally inside this shell-quoted awk program, so it is built.
  function strip_outer(s,   c, n, SQ) {
    SQ = sprintf("%c", 39); n = length(s)
    if (n >= 2) { c = substr(s, 1, 1); if ((c == "\"" || c == SQ) && substr(s, n, 1) == c) return substr(s, 2, n - 2) }
    return s
  }
  function flush() {
    if (key == "") return
    print key "|" shape "|" fields
    key = ""; shape = ""; fields = ""
  }
  {
    if ($0 ~ /^[[:space:]]*output_format:[[:space:]]*$/) {
      flush(); ino = 1; oi = ind($0); ei = -1; next
    }
    if (!ino) next
    if ($0 ~ /^[[:space:]]*$/) next
    li = ind($0)
    if (li <= oi) { flush(); ino = 0; next }
    if (ei == -1) ei = li
    t = trim($0)
    if (li == ei) {
      flush()
      ci = index(t, ":")
      if (ci == 0) next
      key = substr(t, 1, ci - 1)
      val = trim(substr(t, ci + 1))
      if (val != "") shape = strip_outer(val)
      next
    }
    ci = index(t, ":")
    if (ci == 0) next
    k = substr(t, 1, ci - 1); v = trim(substr(t, ci + 1))
    if (k == "shape") shape = strip_outer(v)
    else if (k == "fields") { gsub(/^\[|\]$/, "", v); gsub(/[[:space:]]/, "", v); fields = v }
    next
  }
  END { flush() }
' "$DOC")

if [ -z "${OUTPUT_LINES:-}" ]; then
  refuse "the deliverable block declares no output_format: a judge with no declared shape cannot read the deliverable's output (add output_format with a shape and its fields)"
fi

# typed columns: name<TAB>role, one per line
COLS_TABLE=$(printf '%s' "$INPUT_COLUMNS" | awk -F, '
  { for (i = 1; i <= NF; i++) {
      f = $i; gsub(/^[ \t]+|[ \t]+$/, "", f); if (f == "") continue
      at = index(f, ":")
      if (at == 0) print f "\t"
      else print substr(f, 1, at - 1) "\t" substr(f, at + 1)
    } }')
cols_meta=$(printf '%s\n' "$COLS_TABLE" | awk -F'\t' '
  { n++; names[n] = $1; roles[n] = $2
    if ($2 == "id") { nid++; idc = n }
    else if ($2 == "measure") { nm++; mc = n }
    else if ($2 == "date") { nd++; dc = n }
    else if ($2 != "other") bad = bad " " $1 ":" $2
  }
  END {
    hdr = ""
    for (i = 1; i <= n; i++) hdr = hdr (i > 1 ? "," : "") names[i]
    printf "%d %d %d %d %d %d %d %s %s", n, nid, nm, nd, idc + 0, mc + 0, dc + 0, hdr, bad
  }')
read -r NCOLS NID NMEAS NDATE COL_ID COL_MEASURE COL_DATE HEADER_ROW BAD_ROLES <<EOF || true
$cols_meta
EOF

[ "${NCOLS:-0}" -ge 1 ] || refuse "input_format.columns is empty: a judge cannot build a fixture in a world with no columns"
[ "${NID:-0}" = 1 ] || refuse "input_format declares ${NID:-0} column(s) with role id where exactly one is needed: the judge groups rows by the id column"
[ "${NMEAS:-0}" = 1 ] || refuse "input_format declares ${NMEAS:-0} column(s) with role measure where exactly one is needed: the judge computes every expectation from it"
[ "${NDATE:-0}" -le 1 ] || refuse "input_format declares ${NDATE:-0} column(s) with role date where at most one is usable: the judge would not know which one orders the rows"
[ -z "${BAD_ROLES:-}" ] || refuse "input_format column(s)${BAD_ROLES} declare a role a judge cannot use (implemented: id measure date other)"

# The sample must be one the judge itself can read: one field per declared column, a numeric measure,
# at least three rows and at least two distinct ids (or there is nothing for additivity to separate).
sample_problem=$(printf '%s\n' "$SAMPLE" | awk -F, -v ncols="$NCOLS" -v idc="$COL_ID" -v mc="$COL_MEASURE" -v dc="$COL_DATE" '
  NF == 0 { next }
  {
    rows++
    if (NF != ncols) { print "input_format.sample has a row with " NF " field(s) where the declared columns have " ncols ": a fixture the document itself cannot read is not a fixture"; stop = 1; exit }
    idv = $(idc); gsub(/^[ \t]+|[ \t]+$/, "", idv); ids[idv] = 1
    mv = $(mc)
    if (mv !~ /^-?[0-9]+(\.[0-9]+)?$/) { print "input_format.sample has \"" mv "\" in the measure column: the judge computes its expectations from those values, and one it cannot add is one it cannot check"; stop = 1; exit }
    if (dc > 0) { dv = $(dc); if (dv !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) { print "input_format.sample has \"" dv "\" in the date column: the judge needs ISO dates (YYYY-MM-DD) to build a separated duplicate fixture"; stop = 1; exit } }
  }
  END {
    if (stop) exit
    if (rows < 3) print "input_format.sample has " rows " row(s): a judge needs at least three to build a base, a reshuffled and a duplicated fixture"
    else if (length(ids) < 2) print "input_format.sample names " length(ids) " distinct id(s): with one id there is nothing for additivity or an independent recomputation to separate"
  }')
[ -z "${sample_problem:-}" ] || refuse "$sample_problem"

# The scale the measure values live at, so the judge can aggregate with exact integer arithmetic.
DEC_SCALE=$(printf '%s\n' "$SAMPLE" | awk -F, -v mc="$COL_MEASURE" '
  NF == 0 { next }
  { v = $(mc); p = index(v, "."); d = (p == 0 ? 0 : length(v) - p); if (d > maxd) maxd = d }
  END { print maxd + 0 }')

# classify the declared output shapes by the ROLES of their placeholders.
entries=$(printf '%s\n' "$OUTPUT_LINES" | awk -F'|' -v OFS='|' '{ r = $3; gsub(/,/, " ", r); gsub(/^ +| +$/, "", r); print $1, $2, r }')

count_placeholders() {
  printf '%s' "$1" | awk '{ n = 0; while (match($0, /<[^<>]*>/)) { n++; $0 = substr($0, RSTART + RLENGTH) } print n }'
}

GROUP_COUNT=$(printf '%s\n' "$entries" | awk -F'|' '{ c = split($3, a, " "); for (i = 1; i <= c; i++) if (a[i] == "id") { n++; break } } END { print n + 0 }')
SC_COUNT=$(printf '%s\n' "$entries" | awk -F'|' '{ c = split($3, a, " "); for (i = 1; i <= c; i++) if (a[i] == "skipped-count") { n++; break } } END { print n + 0 }')
# the totals line: neither the per-id line nor the skipped line
TOTAL_COUNT=$(printf '%s\n' "$entries" | awk -F'|' '
  { c = split($3, a, " "); isid = 0; isskip = 0
    for (i = 1; i <= c; i++) { if (a[i] == "id") isid = 1; if (a[i] == "skipped-count") isskip = 1 }
    if (!isid && !isskip) n++ }
  END { print n + 0 }')

GROUP_LINE=$(printf '%s\n' "$entries" | awk -F'|' -v OFS='|' '{ c = split($3, a, " "); for (i = 1; i <= c; i++) if (a[i] == "id") { print; exit } }')
TOTAL_LINE=$(printf '%s\n' "$entries" | awk -F'|' -v OFS='|' '
  { c = split($3, a, " "); isid = 0; isskip = 0
    for (i = 1; i <= c; i++) { if (a[i] == "id") isid = 1; if (a[i] == "skipped-count") isskip = 1 }
    if (!isid && !isskip) { print; exit } }')
SKIP_LINE=$(printf '%s\n' "$entries" | awk -F'|' -v OFS='|' '{ c = split($3, a, " "); for (i = 1; i <= c; i++) if (a[i] == "skipped-count") { print; exit } }')

GROUP_SHAPE=$(printf '%s' "$GROUP_LINE" | cut -d'|' -f2)
GROUP_FIELDS=$(printf '%s' "$GROUP_LINE" | cut -d'|' -f3)
TOTAL_SHAPE=$(printf '%s' "$TOTAL_LINE" | cut -d'|' -f2)
TOTAL_FIELDS=$(printf '%s' "$TOTAL_LINE" | cut -d'|' -f3)
SKIP_SHAPE=$(printf '%s' "$SKIP_LINE" | cut -d'|' -f2)
SKIP_FIELDS=$(printf '%s' "$SKIP_LINE" | cut -d'|' -f3)
WORDS_ONLY=$(printf '%s\n' "$entries" | awk -F'|' -v OFS='|' '$3 == "" { print $1 "|" $2 }')

[ "${GROUP_COUNT:-0}" = 1 ] || refuse "the deliverable block declares ${GROUP_COUNT:-0} output line(s) carrying a role \"id\" where exactly one is needed: the judge reports one line per group and would not know which one that is"
[ "${TOTAL_COUNT:-0}" = 1 ] || refuse "the deliverable block declares ${TOTAL_COUNT:-0} output line(s) that are neither a per-id line nor a skipped line, where exactly one totals line is needed: additivity and the independent recomputation both compare against it"
[ "${SC_COUNT:-0}" -le 1 ] || refuse "the deliverable block declares ${SC_COUNT:-0} output line(s) carrying a role \"skipped-count\" where at most one is usable"
[ -n "${GROUP_SHAPE:-}" ] || refuse "the per-id output line declares no shape"
[ -n "${TOTAL_SHAPE:-}" ] || refuse "the totals output line declares no shape"

# the placeholder roles must line up, and every role must be one the judge can compute.
check_fields() { # $1 what, $2 shape, $3 roles
  local what="$1" shape="$2" roles="$3" ph nf role
  ph=$(count_placeholders "$shape")
  nf=0
  for role in $roles; do nf=$((nf + 1)); done
  [ "$ph" = "$nf" ] || refuse "the $what declares $nf field role(s) for $ph placeholder(s) in \"$shape\": the roles are positional, so they must line up"
}
check_fields "per-id output line" "$GROUP_SHAPE" "$GROUP_FIELDS"
check_fields "totals output line" "$TOTAL_SHAPE" "$TOTAL_FIELDS"
for role in $GROUP_FIELDS; do
  case "$role" in
    id|count|sum|min|max|mean) ;;
    *) refuse "the per-id output line declares the field role \"$role\", which a judge cannot compute (implemented: id count sum min max mean)" ;;
  esac
done
for role in $TOTAL_FIELDS; do
  case "$role" in
    count|sum) ;;
    *) refuse "the totals output line declares the field role \"$role\", which a judge cannot compute (implemented: count sum)" ;;
  esac
done
if [ -n "${SKIP_SHAPE:-}" ]; then
  check_fields "skipped output line" "$SKIP_SHAPE" "$SKIP_FIELDS"
  for role in $SKIP_FIELDS; do
    [ "$role" = "skipped-count" ] || refuse "the skipped output line declares the field role \"$role\" where only skipped-count is usable"
  done
fi

# --- what each declared relation needs from the declared world ----------------------------------

ADD_ROLES=""
for role in count sum; do
  case " $GROUP_FIELDS " in *" $role "*) case " $TOTAL_FIELDS " in *" $role "*) ADD_ROLES="$ADD_ROLES $role" ;; esac ;; esac
done
ADD_ROLES="${ADD_ROLES# }"

if [ "$(has_rel additivity)" = yes ] && [ -z "$ADD_ROLES" ]; then
  refuse "additivity is declared, but no field role is printed on both the per-id line and the totals line, so the judge cannot check that the parts sum to the whole (share \"count\" or \"sum\")"
fi
if [ "$(has_rel malformed-row-accounting)" = yes ] && [ "$MALFORMED_MODE" = skip-count ]; then
  [ -n "${SKIP_SHAPE:-}" ] || refuse "malformed-row-accounting is decided \"skip-count\", but no output line declares a role \"skipped-count\": the judge cannot check the count the decision promises (add a skipped_line with fields: [skipped-count])"
fi
if [ "$DUPLICATE_MODE" = "latest-start-date" ] && [ "${COL_DATE:-0}" = 0 ]; then
  refuse "a decision says checkedAs: \"latest-start-date\", which picks the row with the latest date, but input_format declares no column with role date: the judge has nothing to order by"
fi

# Build the ERE that matches each declared shape: every <placeholder> becomes a positional capture.
shape_re() {
  printf '%s' "$1" | awk '
    function esc(t) { gsub(/[][(){}.+*?^$|\\]/, "\\\\&", t); return t }
    { s = $0; out = ""
      while (match(s, /<[^<>]*>/)) {
        out = out esc(substr(s, 1, RSTART - 1)) "([^ ]+)"
        s = substr(s, RSTART + RLENGTH)
      }
      out = out esc(s)
      print "^" out "$"
    }'
}
GROUP_RE=$(shape_re "$GROUP_SHAPE")
TOTAL_RE=$(shape_re "$TOTAL_SHAPE")
SKIP_RE=""
[ -n "${SKIP_SHAPE:-}" ] && SKIP_RE=$(shape_re "$SKIP_SHAPE")

# --- fixtures, built in the declared world from the declared sample -----------------------------

SAMPLE_ROWS="$SAMPLE"
FIRST_ROW=$(printf '%s\n' "$SAMPLE" | head -1)

set_row_field() { # $1 row, $2 column (1-based), $3 value
  printf '%s' "$1" | awk -F, -v OFS=, -v c="$2" -v v="$3" '{ if (c > 0) $c = v; print }'
}

NEW_MEASURE=$(printf '%s\n' "$SAMPLE" | awk -F, -v mc="$COL_MEASURE" -v d="$DEC_SCALE" 'NF { v = $(mc) + 0; if (v > mx) mx = v } END { printf "%.*f", d, mx + 1 }')
DUP_BASE=$(set_row_field "$FIRST_ROW" "$COL_MEASURE" "$NEW_MEASURE")
DUP_ROW_LATE="$DUP_BASE"
DUP_ROW_EARLY="$DUP_BASE"
if [ "${COL_DATE:-0}" -gt 0 ]; then
  MAX_DATE=$(printf '%s\n' "$SAMPLE" | awk -F, -v dc="$COL_DATE" 'NF { print $(dc) }' | sort | tail -1)
  MIN_DATE=$(printf '%s\n' "$SAMPLE" | awk -F, -v dc="$COL_DATE" 'NF { print $(dc) }' | sort | head -1)
  DUP_LATE_DATE=$(date -d "$MAX_DATE +1 day" +%F 2>/dev/null) || refuse "the judge cannot build a later-date duplicate fixture: the declared date \"$MAX_DATE\" is not one this machine can add a day to"
  DUP_EARLY_DATE=$(date -d "$MIN_DATE -1 day" +%F 2>/dev/null) || refuse "the judge cannot build an earlier-date duplicate fixture: the declared date \"$MIN_DATE\" is not one this machine can subtract a day from"
  DUP_ROW_LATE=$(set_row_field "$DUP_BASE" "$COL_DATE" "$DUP_LATE_DATE")
  DUP_ROW_EARLY=$(set_row_field "$DUP_BASE" "$COL_DATE" "$DUP_EARLY_DATE")
fi

MALFIELD_COUNT=$(printf '%s' "$FIRST_ROW" | awk -F, '{ print (NF > 1 ? NF - 1 : 1) }')
MAL1=$(printf '%s' "$FIRST_ROW" | awk -F, -v OFS=, '{ n = NF; if (n > 1) NF = n - 1; print }')
MAL2=$(set_row_field "$FIRST_ROW" "$COL_MEASURE" "abc")
MALFORMED_COUNT=2
MAL_CONTENT="$MAL1
$MAL2"
if [ "${COL_DATE:-0}" -gt 0 ]; then
  MAL3=$(set_row_field "$FIRST_ROW" "$COL_DATE" "not-a-date")
  MALFORMED_COUNT=3
  MAL_CONTENT="$MAL_CONTENT
$MAL3"
fi

# One occurrence per id: the fixture a row-order check can be INVARIANT on when the declared duplicate
# rule resolves a repeated id by its POSITION (first-row/last-row) or rejects it (error). Without this,
# "reshuffling changes nothing" would silently be a second test of the duplicate decision (REL-003),
# and a document that declares row-order-invariance AND a position-dependent duplicate rule would be
# judged on a fixture where the two contradict each other.
PROJ_SAMPLE=$(printf '%s\n' "$SAMPLE_ROWS" | awk -F, -v idc="$COL_ID" -v OFS=, '{ k = $(idc); if (k in seen) next; seen[k] = 1; print }')
SAMPLE_HAS_DUP=$(printf '%s\n' "$SAMPLE_ROWS" | awk -F, -v idc="$COL_ID" '{ c[$(idc)]++ } END { for (k in c) if (c[k] > 1) { print "yes"; exit } print "no" }')

ROW_ORDER_NOTE=""
BASE_SAMPLE="$SAMPLE_ROWS"
ORDER_SAMPLE="$SAMPLE_ROWS"
if [ "$DUPLICATE_MODE" != "merge" ]; then
  ORDER_SAMPLE="$PROJ_SAMPLE"
  ROW_ORDER_NOTE="row-order-invariance is judged on one occurrence per id: the chosen duplicate rule \"$DUPLICATE_MODE\" resolves a repeated id by its position, so the duplicate decision owns the repeated rows and this relation owns the aggregation order"
fi
if [ "$DUPLICATE_MODE" = "error" ] && [ "$SAMPLE_HAS_DUP" = yes ]; then
  BASE_SAMPLE="$PROJ_SAMPLE"
  ROW_ORDER_NOTE="the declared duplicate rule \"error\" makes the repeated id in the sample an error, so the shared fixtures keep one occurrence per id; the duplicate decision is judged on the dedicated duplicate fixtures"
fi

BASE_CONTENT=$(printf '%s\n%s' "$HEADER_ROW" "$BASE_SAMPLE")
ORD_CONTENT=$(printf '%s\n%s' "$HEADER_ROW" "$ORDER_SAMPLE")
ORD_REV_CONTENT=$(printf '%s\n%s' "$HEADER_ROW" "$(printf '%s\n' "$ORDER_SAMPLE" | tac)")
DUP_LATE_CONTENT=$(printf '%s\n%s' "$BASE_CONTENT" "$DUP_ROW_LATE")
DUP_EARLY_CONTENT=$(printf '%s\n%s' "$BASE_CONTENT" "$DUP_ROW_EARLY")
FULL_MAL_CONTENT=$(printf '%s\n%s' "$BASE_CONTENT" "$MAL_CONTENT")

# --- emit the judge -----------------------------------------------------------------------------

JUDGE="$TAKUMI_JUDGE_DIR/judge.sh"
{
  cat <<'HEADER'
#!/usr/bin/env bash
# A FORGED judge (ADR-026 + ADR-028 + ADR-033). Generated from the requirement document's deliverable
# contract, outside the implementation worktree, without reading the implementation. It builds its
# fixtures in the world the DOCUMENT declares, runs the deliverable against them, and judges
# INVARIANTS, not outputs.
#
# ADR-028: every expectation below is a function of the options the human CHOSE, and every decision a
# relation exercises is reported as its own DEC-nnn line — so an implementation that recorded a
# decision and then did the opposite of it fails here, not in review.
# ADR-033: the fixture rows and the row-validity rules come from the document's input_format, and every
# output line is read through the roles the document declares; nothing in this judge knows what the
# document's columns MEAN beyond the roles it declared.
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

RUN_OUT=""; RUN_STATUS=0; RUN_CMD=""

# --- reading the report of ONE fixture (ADR-046 + ADR-047) ---------------------------------------
# Three placeholders are resolved EVERYWHERE the document declares a command to run — `run`, `read`, and
# a scenario's `start`/`url`/`run`: `{csv}` is the fixture, `{port}` is a port the JUDGE allocated for
# this invocation, and `{url}` is the document's url with `{port}` resolved. So no document hard-codes a
# port, and two runs (or two fixtures) cannot answer for each other.
subst() { # $1 template, $2 csv, $3 port, $4 url
  printf '%s' "$1" | sed -e "s|{csv}|$2|g" -e "s|{port}|$3|g" -e "s|{url}|$4|g"
}
# A port allocated by PROBING, never assumed: the first port in a range nothing answers on. Pure bash
# (`/dev/tcp`), because the judge deliberately depends on awk + curl only.
alloc_port() {
  local p
  for p in $(seq 20000 20100); do
    if ! (exec 3<>/dev/tcp/127.0.0.1/"$p") 2>/dev/null; then printf '%s' "$p"; return 0; fi
  done
  return 1
}

# The report for ONE fixture, however the document says the deliverable produces it. A SCRIPT: `run`
# prints the report and the bound catches a run that never returns. A SERVICE (`read` declared): `run`
# STARTS the thing on this fixture, the declared url is health-gated, `read` FETCHES the report under the
# same bound, and the surface is killed on EVERY path — a leaked service answers the NEXT fixture, which
# is how a check turns into one that always passes.
run_tool() { # $1 = absolute csv path; leaves the report in RUN_OUT, its status in RUN_STATUS
  local csv="$1" cmd port url start_cmd read_cmd p waited_ms
  if [ -z "$READ_TEMPLATE" ]; then
    cmd=$(subst "$RUN_TEMPLATE" "$csv" "" "$DELIV_URL")
    RUN_CMD="$cmd"
    # THE SCRIPT SHAPE, with the SAME teardown a surface gets. One invocation, report on stdout — but a
    # deliverable may BACKGROUND a surface before it returns (the spike's own `serve.sh` does exactly
    # that, so a pipe-reading judge finishes instead of hanging on a long-running server), and that
    # surface outlives the invocation. Observed live: a `station_service.py` still bound to 8787 after
    # the run ended, and a leaked listener answers the NEXT fixture, which is how a check turns into one
    # that always passes (bug #57). So the invocation is a started surface like any other: its OWN
    # process group, bounded, and the group torn down on EVERY path. A bound that was hit stays a
    # FAILURE (status 124) that names the command, exactly as the `timeout` it replaces did.
    start_scenario_surface "deliverable-script" "$cmd"
    p="$SCENARIO_PID"
    waited_ms=0
    while kill -0 "$p" 2>/dev/null; do
      [ "$waited_ms" -ge "$((RUN_TIMEOUT_S * 1000))" ] && break
      sleep 0.2
      waited_ms=$((waited_ms + 200))
    done
    RUN_OUT=$(cat "$JUDGE_DIR/deliverable-script-surface.log" 2>/dev/null || true)
    if kill -0 "$p" 2>/dev/null; then
      RUN_STATUS=124
    else
      RUN_STATUS=0
      wait "$p" 2>/dev/null || RUN_STATUS=$?
    fi
    kill_scenario_surfaces
    return 0
  fi
  port=$(alloc_port) || { RUN_OUT=""; RUN_STATUS=1; printf '# the judge found no free port to start the deliverable on, so this fixture produced no report\n' >&2; return 0; }
  url=$(subst "$DELIV_URL" "$csv" "$port" "$DELIV_URL")
  start_cmd=$(subst "$RUN_TEMPLATE" "$csv" "$port" "$url")
  read_cmd=$(subst "$READ_TEMPLATE" "$csv" "$port" "$url")
  RUN_CMD="$read_cmd"
  start_scenario_surface "deliverable" "$start_cmd"
  if ! wait_for_url "$url" 20; then
    kill_scenario_surfaces
    RUN_OUT=""; RUN_STATUS=1
    printf '# the deliverable did not answer on %s within 20s of starting (%s), so this fixture produced no report\n' "$url" "$start_cmd" >&2
    return 0
  fi
  RUN_OUT=$( ( cd "$WORKTREE" && timeout "$RUN_TIMEOUT_S" sh -c "$read_cmd" ) 2>&1 ); RUN_STATUS=$?
  kill_scenario_surfaces
}

# --- declared scenarios (ADR-035) ---------------------------------------------------------------
# The judge runs the document's OWN commands: it starts what the document says to start, waits for the
# surface the document names, ASSERTS what the document declares about the response, runs the scenario
# command, reads the report the document names, and ALWAYS kills what it started — on success, on
# failure and on the report path. No browser, no framework and no network assumption lives here: an
# unreadable report is a failure, never a pass.
#
# The listening-process model is deliberately minimal: the judge ALLOCATES the port for every surface it
# starts (`{port}`), `start` brings the process up in its own process group, the url is health-gated, the
# declared response assertion is applied, and the process is torn down on every path. A document that
# hard-codes a port instead of `{port}` gives that isolation up (ADR-047), and no sandboxing is modelled.
SCENARIO_PIDS=""
# `{csv}`, `{port}` and `{url}` in a scenario's commands resolve through the same `subst` the deliverable
# uses: `{csv}` to the judge's own base fixture (the world the relations run against), `{port}` to a port
# the judge allocated for THIS scenario's surface. Before this a `start: "bash serve.sh {csv}"` tried to
# serve a file literally named `{csv}`, and a hard-coded port let one run answer for another.
SCENARIO_CSV=""
start_scenario_surface() { # $1 scenario id, $2 command -> pid in SCENARIO_PID (its own process group leader)
  SCENARIO_PID=""
  [ -n "$2" ] || return 0
  # `setsid` makes the started surface the leader of its OWN process group, so the kill below reaches the
  # real server and not just the `sh -c` wrapper that started it. Without it a leaked `python3 -m
  # http.server` keeps answering and the NEXT run's scenario passes for the wrong reason (bug #41).
  setsid sh -c "cd '$WORKTREE' && exec sh -c '$2'" >"$JUDGE_DIR/$1-surface.log" 2>&1 &
  SCENARIO_PID=$!
  SCENARIO_PIDS="$SCENARIO_PIDS $SCENARIO_PID"
}
kill_scenario_surfaces() {
  local p
  for p in $SCENARIO_PIDS; do
    # Negative pid = the whole process group. TERM first, then KILL for anything that ignores it.
    kill -TERM "-$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null || true
    sleep 1
    kill -KILL "-$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null || true
    wait "$p" 2>/dev/null || true
  done
  SCENARIO_PIDS=""
}
wait_for_url() { # $1 url, $2 seconds -> 0 when the surface ANSWERED (any HTTP status)
  local i=0 max="$2" code rc
  while [ "$i" -lt "$max" ]; do
    # ADR-046: the health gate waits for the surface to ANSWER, not for it to answer 2xx. `curl -f`
    # treated a 4xx/5xx as "not up", so a surface that answers 500 was reported as "did not answer
    # within 20s" — a failure for the wrong reason, and one that would have hidden the declared
    # `expect_status` behind a timeout. Whether the answer is the RIGHT one is the assertion's job.
    # `curl` still PRINTS `000` when it cannot connect, so the exit status is what decides: a non-zero
    # status is "not yet", never "answered".
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 2 "$1" 2>/dev/null); rc=$?
    [ "$rc" = 0 ] && [ "$code" != "000" ] && return 0
    i=$((i + 1)); sleep 1
  done
  return 1
}
scenario_report_failures() { # $1 format, $2 path -> prints a reason, or nothing when the report is clean
  local fmt="$1" path="$2"
  [ -f "$path" ] || { printf 'the report %s does not exist' "$path"; return 0; }
  case "$fmt" in
    ctrf)
      grep -q '"reportFormat"[[:space:]]*:[[:space:]]*"CTRF"' "$path" || { printf '%s does not look like a CTRF report' "$path"; return 0; }
      awk '
        { if (match($0, /"failed"[[:space:]]*:[[:space:]]*[0-9]+/)) { m = substr($0, RSTART, RLENGTH); sub(/.*:[[:space:]]*/, "", m); if (m + 0 > 0) { print "the CTRF report says " m " failing test(s)"; found = 1 } } }
        END { if (!found) exit 0 }
      ' "$path"
      ;;
    junit)
      grep -qiE '<testsuites|<testsuite' "$path" || { printf '%s does not look like a JUnit report' "$path"; return 0; }
      n=$(grep -oE 'failures="[0-9]+"' "$path" | grep -oE '[0-9]+' | awk '{ s += $1 } END { print s + 0 }')
      [ "${n:-0}" -eq 0 ] || printf 'the JUnit report counts %s failing test(s)' "$n"
      ;;
    tap)
      n=$(grep -cE '^not ok' "$path" || true)
      [ "${n:-0}" -eq 0 ] || printf 'the TAP report has %s not-ok line(s)' "$n"
      ;;
    *) printf 'the judge does not implement the report format "%s"' "$fmt" ;;
  esac
}

# --- the mutation report (ADR-039) --------------------------------------------------------------
# `survivors-json` is the tool-agnostic report the design chose first: `{"total": <int>, "survivors":
# [{"file": "...", "line": <int>, "description": "..."}, ...]}`. It is read by a small strict JSON reader,
# not by a general parser: it accepts EXACTLY the declared shape (keys `total` and `survivors`, and each
# survivor carrying `file`, `line` and `description`) and refuses anything else — a report the judge cannot
# read is never a pass. It is deliberately dependency-free (awk only), so the judge stays a shell script.
mutation_report_failures() { # $1 format, $2 path, $3 max_survivors -> a reason, or nothing when clean
  local fmt="$1" path="$2" budget="$3" res first total count names
  case "$fmt" in
    survivors-json)
      res=$(awk '
        function skip_ws(   c) { while (I <= L) { c = substr(S, I, 1); if (c == " " || c == "\t" || c == "\n" || c == "\r") I++; else break } }
        function read_str(   c, out) {
          if (substr(S, I, 1) != "\"") { BAD = "a value that is not a string"; return "" }
          I++; out = ""
          while (I <= L) {
            c = substr(S, I, 1)
            if (c == "\\") { out = out substr(S, I, 2); I += 2; continue }
            if (c == "\"") { I++; return out }
            out = out c; I++
          }
          BAD = "an unterminated string"; return ""
        }
        function read_int(   v, c) {
          if (match(substr(S, I), /^-?[0-9]+/)) {
            v = substr(S, I, RLENGTH); I += RLENGTH; c = substr(S, I, 1)
            if (c == "." || c == "e" || c == "E") { BAD = "a number that is not an integer"; return "" }
            return v
          }
          BAD = "a value that is not an integer"; return ""
        }
        function read_survivor(   c, k, f, l, d) {
          skip_ws()
          if (substr(S, I, 1) != "{") { BAD = "a survivor that is not an object"; return "" }
          I++; f = ""; l = ""; d = ""
          skip_ws()
          if (substr(S, I, 1) == "}") { I++ }
          else while (1) {
            skip_ws(); k = read_str(); if (BAD != "") return ""
            skip_ws(); if (substr(S, I, 1) != ":") { BAD = "a survivor field without a value"; return "" }
            I++; skip_ws()
            if (k == "file") { f = read_str(); if (BAD != "") return "" }
            else if (k == "line") { l = read_int(); if (BAD != "") return "" }
            else if (k == "description") { d = read_str(); if (BAD != "") return "" }
            else { BAD = "a survivor declaring the key \"" k "\""; return "" }
            skip_ws(); c = substr(S, I, 1)
            if (c == ",") { I++; continue }
            if (c == "}") { I++; break }
            BAD = "a survivor that is not valid JSON"; return ""
          }
          if (f == "" || l == "" || d == "") { BAD = "a survivor without file, line and description"; return "" }
          return f "\t" l "\t" d
        }
        function read_survivors(   c, one) {
          if (substr(S, I, 1) != "[") { BAD = "a survivors value that is not an array"; return -1 }
          I++; n = 0; LIST = ""
          skip_ws()
          if (substr(S, I, 1) == "]") { I++; return 0 }
          while (1) {
            skip_ws(); one = read_survivor(); if (BAD != "") return -1
            n++; LIST = LIST one "\n"
            skip_ws(); c = substr(S, I, 1)
            if (c == ",") { I++; continue }
            if (c == "]") { I++; break }
            BAD = "a survivors array that is not valid JSON"; return -1
          }
          return n
        }
        { S = S $0 "\n" }
        END {
          I = 1; L = length(S); BAD = ""; LIST = ""; TOTAL = -1; COUNT = -1
          skip_ws()
          if (substr(S, I, 1) != "{") { print "ERROR the report is not a JSON object"; exit }
          I++; skip_ws()
          if (substr(S, I, 1) == "}") { I++ }
          else while (1) {
            skip_ws(); k = read_str(); if (BAD != "") { print "ERROR " BAD; exit }
            skip_ws(); if (substr(S, I, 1) != ":") { print "ERROR the report is not valid JSON"; exit }
            I++; skip_ws()
            if (k == "total") { v = read_int(); if (BAD != "") { print "ERROR " BAD; exit }; TOTAL = v + 0 }
            else if (k == "survivors") { COUNT = read_survivors(); if (BAD != "") { print "ERROR " BAD; exit } }
            else { print "ERROR the report declares the key \"" k "\" where the declared shape has only total and survivors"; exit }
            skip_ws(); c = substr(S, I, 1)
            if (c == ",") { I++; continue }
            if (c == "}") { I++; break }
            print "ERROR the report is not valid JSON"; exit
          }
          skip_ws()
          if (I <= L) { print "ERROR the report has content after the JSON object"; exit }
          if (TOTAL < 0) { print "ERROR the report declares no total"; exit }
          if (COUNT < 0) { print "ERROR the report declares no survivors array"; exit }
          print "OK " TOTAL " " COUNT
          if (LIST != "") printf "%s", LIST
        }
      ' "$path" 2>/dev/null)
      first=$(printf '%s\n' "$res" | head -n 1)
      case "$first" in
        OK\ *) ;;
        ERROR\ *) printf 'the report %s is not the declared survivors-json shape: %s' "$path" "${first#ERROR }"; return 0 ;;
        *) printf 'the report %s cannot be read as survivors-json' "$path"; return 0 ;;
      esac
      total=$(printf '%s' "$first" | awk '{ print $2 }')
      count=$(printf '%s' "$first" | awk '{ print $3 }')
      case "$count" in ''|*[!0-9]*) printf 'the report %s reports a survivors count the judge cannot read' "$path"; return 0 ;; esac
      if [ "${total:-0}" -le 0 ]; then
        printf 'the report %s measured %s mutant(s): a mutation run that measured nothing cannot fail a test, so it is not a pass' "$path" "${total:-0}"
        return 0
      fi
      if [ "$count" -gt "$budget" ]; then
        names=$(printf '%s\n' "$res" | tail -n +2 | head -n 3 | awk -F'\t' '{ printf "%s:%s (%s); ", $1, $2, $3 }')
        printf '%s survivor(s) over the budget of %s (of %s mutant(s) measured): %s' "$count" "$budget" "$total" "$names"
        return 0
      fi
      ;;
    *) printf 'the judge does not implement the mutation report format "%s"' "$fmt" ;;
  esac
}
HEADER

  printf '\nRUN_TEMPLATE=%s\n' "'$(sq "$RUN_TEMPLATE")'"
  # ADR-047: how a judge READS the report of one fixture. Empty for a SCRIPT (stdout is the report); a
  # command for a SERVICE, with `{csv}`/`{port}`/`{url}` resolved by the judge.
  printf 'READ_TEMPLATE=%s\n' "'$(sq "$DELIV_READ")'"
  printf 'DELIV_URL=%s\n' "'$(sq "$DELIV_URL")'"
  # ADR-046: the bound on one invocation of the deliverable, as declared (or the default) and in whole
  # seconds for `timeout`. Emitted as its own lines so the generated judge reads a number, never a guess.
  printf 'RUN_TIMEOUT_MS=%s\n' "$RUN_TIMEOUT_MS"
  printf 'RUN_TIMEOUT_S=%s\n' "$RUN_TIMEOUT_S"
  printf 'REQUIREMENT_REF=%s\n' "'$(sq "$TAKUMI_REQUIREMENT")'"
  printf 'DUPLICATE_MODE=%s\n' "'$(sq "$DUPLICATE_MODE")'"
  printf 'MALFORMED_MODE=%s\n' "'$(sq "$MALFORMED_MODE")'"
  printf 'ROUNDING_MODE=%s\n' "'$(sq "$ROUNDING_MODE")'"
  printf 'NCOLS=%s\n' "$NCOLS"
  printf 'COL_ID=%s\n' "$COL_ID"
  printf 'COL_MEASURE=%s\n' "$COL_MEASURE"
  printf 'COL_DATE=%s\n' "$COL_DATE"
  printf 'DEC_SCALE=%s\n' "$DEC_SCALE"
  printf 'MALFORMED_COUNT=%s\n' "$MALFORMED_COUNT"
  printf 'ADD_ROLES=%s\n' "'$(sq "$ADD_ROLES")'"
  printf 'GROUP_FIELDS=%s\n' "'$(sq "$GROUP_FIELDS")'"
  printf 'TOTAL_FIELDS=%s\n' "'$(sq "$TOTAL_FIELDS")'"
  printf 'SKIP_FIELDS=%s\n' "'$(sq "$SKIP_FIELDS")'"
  printf 'GROUP_RE=%s\n' "'$(sq "$GROUP_RE")'"
  printf 'TOTAL_RE=%s\n' "'$(sq "$TOTAL_RE")'"
  printf 'SKIP_RE=%s\n' "'$(sq "$SKIP_RE")'"
  printf 'ROW_ORDER_NOTE=%s\n' "'$(sq "$ROW_ORDER_NOTE")'"
  # The scenarios, as records the judge reads back (unit-separated, so a command with spaces survives).
  printf '\nSCENARIOS=%s\n' "'$(sq "$SCENARIOS")'"
  # The reader is emitted as ONE printf with a quoted TAB in the field separator. `read -r` in a pipeline
  # subshell cannot stop the loop on a match (`return` only leaves the subshell, and the loop then reads the
  # NEXT record), which returned another record's field — how a scenario's report came back as `AMB-002`.
  printf 'scenario_field() { # $1 id, $2 field number\n'
  printf '  printf "%%s\\n" "$SCENARIOS" | awk -F"\t" -v id="$1" -v n="$2" '"'"'$1 == id { print $n; exit }'"'"'\n'
  printf '}\n'

  # The mutation tool configuration (ADR-039). The relation is dispatched like any other; these are the
  # fields its branch reads. The report path is relative to the worktree, so the judge never holds an
  # absolute path built from the implementation.
  printf '\nMUT_RUN=%s\n' "'$(sq "$MUT_RUN")'"
  printf 'MUT_REPORT_PATH=%s\n' "'$(sq "$MUT_REPORT_PATH")'"
  printf 'MUT_FORMAT=%s\n' "'$(sq "$MUT_FORMAT")'"
  printf 'MUT_MAX_SURVIVORS=%s\n' "${MUT_MAX_SURVIVORS:-0}"
  printf 'MUT_TIMEOUT_MS=%s\n' "${MUT_TIMEOUT_MS:-900000}"
  printf 'MUT_TIMEOUT_S=%s\n' "$(( ${MUT_TIMEOUT_MS:-900000} / 1000 ))"

  emit_fixture() { # $1 filename, $2 content
    printf 'cat > "$FIX/%s" <<%sTAKUMI_FIXTURE%s\n%s\nTAKUMI_FIXTURE\n' "$1" "'" "'" "$2"
  }

  printf '\n# --- fixtures, generated from the document'\''s declared world, never copied from the implementation ---\n'
  emit_fixture base.csv "$BASE_CONTENT"
  emit_fixture ord-base.csv "$ORD_CONTENT"
  emit_fixture ord-reversed.csv "$ORD_REV_CONTENT"
  emit_fixture dup-late-date.csv "$DUP_LATE_CONTENT"
  emit_fixture dup-early-date.csv "$DUP_EARLY_CONTENT"
  emit_fixture malformed.csv "$FULL_MAL_CONTENT"

  cat <<'BODY'

case "$DUPLICATE_MODE" in
  latest-start-date) DUP_RULE=latest ;;
  first-row) DUP_RULE=first ;;
  last-row) DUP_RULE=last ;;
  merge) DUP_RULE=merge ;;
  error) DUP_RULE=error ;;
  *) printf '# the forged judge got an unknown duplicate mode "%s"\n' "$DUPLICATE_MODE"; DUP_RULE=none ;;
esac

# --- the judge's own recomputation, in the document's declared world ----------------------------
# A row is valid in the declared world when it has one field per declared column, a non-empty id, a
# numeric measure and (when a date column is declared) an ISO date. The expectation is computed from
# the fixture by scaling every measure to an integer at the declared scale, so the half-up/truncate
# rule is exact rather than subject to binary floating point.
aggregate() { # $1 fixture, $2 latest|first|last|merge|error, $3 half-up|truncate
  awk -F, -v idc="$COL_ID" -v mc="$COL_MEASURE" -v dc="$COL_DATE" -v ncols="$NCOLS" -v rule="$2" -v rounding="$3" -v D="$DEC_SCALE" '
    function powten(k,   r, i) { r = 1; for (i = 0; i < k; i++) r *= 10; return r }
    # round a scaled value (units of 10^-D) to k decimal places, in the declared rounding mode
    function roundto(sv, k,   unit, neg, av, h, rem) {
      unit = powten(D - k)
      neg = (sv < 0); av = (sv < 0) ? -sv : sv
      h = int(av / unit); rem = av - h * unit
      if (rounding != "truncate" && rem * 2 >= unit) h++
      return neg ? -h * unit : h * unit
    }
    function scaled(s,   neg, p, ip, fp, c) {
      neg = 0
      if (substr(s, 1, 1) == "-") { neg = 1; s = substr(s, 2) }
      else if (substr(s, 1, 1) == "+") { s = substr(s, 2) }
      p = index(s, ".")
      if (p == 0) { ip = s; fp = "" } else { ip = substr(s, 1, p - 1); fp = substr(s, p + 1) }
      if (ip == "") ip = "0"
      fp = substr(fp "000000000000", 1, D)
      c = ip * powten(D) + (fp == "" ? 0 : fp + 0)
      return neg ? -c : c
    }
    function isnum(s) { return s ~ /^-?[0-9]+(\.[0-9]+)?$/ }
    function isdate(s) { return s ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]([T ].*)?$/ }
    NR == 1 { next }
    NF != ncols { next }
    {
      id = $(idc)
      if (id == "") next
      if (!isnum($(mc))) next
      if (dc > 0 && !isdate($(dc))) next
      n++; rid[n] = id; rval[n] = scaled($(mc)); rdate[n] = (dc > 0 ? $(dc) : "")
    }
    END {
      for (i = 1; i <= n; i++) {
        id = rid[i]
        if (!(id in chosen)) { chosen[id] = i; continue }
        if (rule == "error") { print "ERROR_DUPLICATE"; exit }
        if (rule == "first") continue
        if (rule == "last") { chosen[id] = i; continue }
        if (rule == "latest" && rdate[i] >= rdate[chosen[id]]) chosen[id] = i
      }
      if (rule == "merge") { for (i = 1; i <= n; i++) counts[i] = 1 }
      else { for (id in chosen) counts[chosen[id]] = 1 }
      for (i = 1; i <= n; i++) {
        if (!counts[i]) continue
        id = rid[i]; v = rval[i]
        if (!(id in gcnt)) { gcnt[id] = 1; gsum[id] = v; gmin[id] = v; gmax[id] = v; gord[++gk] = id }
        else { gcnt[id]++; gsum[id] += v; if (v < gmin[id]) gmin[id] = v; if (v > gmax[id]) gmax[id] = v }
        tcnt++; tsum += v
        # the sum of the per-row values ROUNDED at each precision 0..D (in units of 10^-D): the `sum`
        # role is the sum of the rounded readings, the way a per-row rounding rule composes with a total
        for (k = 0; k <= D; k++) { rr = roundto(v, k); grsum[id SUBSEP k] += rr; trsum[k] += rr }
      }
      for (j = 1; j <= gk; j++) {
        id = gord[j]
        printf "ID %s %d %d %d %d", id, gcnt[id], gsum[id], gmin[id], gmax[id]
        for (k = 0; k <= D; k++) printf " %d", grsum[id SUBSEP k] + 0
        printf "\n"
      }
      printf "TOT %d %d", tcnt, tsum
      for (k = 0; k <= D; k++) printf " %d", trsum[k] + 0
      printf "\n"
    }
  ' "$1"
}

# Render an exact scaled value at the precision the tool itself printed, with the chosen rounding.
render_exact() { # $1 numerator (scaled), $2 denominator, $3 precision
  awk -v num="$1" -v den="$2" -v D="$DEC_SCALE" -v p="$3" -v mode="$ROUNDING_MODE" '
    function powten(k,   r, i) { r = 1; for (i = 0; i < k; i++) r *= 10; return r }
    BEGIN {
      Dn = den * powten(D)
      X = num * powten(p)
      if (Dn == 0) { print "NaN"; exit }
      neg = (X < 0); ax = (X < 0) ? -X : X
      q = int(ax / Dn); r = ax - q * Dn
      if (r < 0) { q--; r += Dn }
      if (mode != "truncate" && r * 2 >= Dn) q++
      if (neg) q = -q
      if (p == 0) { printf "%d", q; exit }
      pw = powten(p)
      ip = int(q / pw); fp = q - ip * pw; if (fp < 0) fp = -fp
      printf "%d.%0*d", ip, p, fp
    }'
}

# read a declared line through one shape: the <placeholders> become positional roles.
match_fields() { # $1 line, $2 regex, $3 roles -> "role=value role=value", empty when it does not match
  local line="$1" re="$2" roles="$3" i=0 out="" role
  if [[ $line =~ $re ]]; then
    for role in $roles; do i=$((i + 1)); out="$out $role=${BASH_REMATCH[$i]}"; done
    printf '%s' "${out# }"
  fi
}
fieldval() { # $1 pairs, $2 role
  local p
  for p in $1; do case "$p" in "$2="*) printf '%s' "${p#"$2="}"; return ;; esac; done
}

# classify the tool's output through the DECLARED shapes — no hard-coded line names, no hard-coded
# column positions. Anything matching none of them is "X" (unrecognised).
classify() { # $1 output -> "<G|T|S|X>\t<line>"
  local line
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    if [ -n "$SKIP_RE" ] && [[ $line =~ $SKIP_RE ]]; then printf 'S\t%s\n' "$line"; continue; fi
    if [[ $line =~ $TOTAL_RE ]]; then printf 'T\t%s\n' "$line"; continue; fi
    if [[ $line =~ $GROUP_RE ]]; then printf 'G\t%s\n' "$line"; continue; fi
    printf 'X\t%s\n' "$line"
  done <<EOF
$1
EOF
}
group_lines() { classify "$1" | awk -F'\t' '$1 == "G" { print $2 }'; }
total_line() { classify "$1" | awk -F'\t' '$1 == "T" { print $2; exit }'; }
skip_line() { classify "$1" | awk -F'\t' '$1 == "S" { print $2; exit }'; }

decimals_in() { local t="$1"; case "$t" in *.*) t="${t#*.}"; printf '%s' "${#t}" ;; *) printf '0' ;; esac; }
# The expected token for one declared role, at the precision the tool itself printed. `count` is exact;
# `sum` is the sum of the per-row values rounded at that precision (the rounding rule composes per row);
# min/max are single values; `mean` is the exact mean of the surviving values, rounded.
role_token() { # $1 role, $2 cnt, $3 sumScaled, $4 min, $5 max, $6 token, $7.. per-precision rounded sums
  local role="$1" cnt="$2" ssum="$3" smin="$4" smax="$5" tok="$6" p idx
  shift 6
  local -a rsum=("$@")
  case "$role" in
    count) printf '%s' "$cnt" ;;
    sum)
      p=$(decimals_in "$tok"); idx="$p"; [ "$idx" -gt "$DEC_SCALE" ] && idx="$DEC_SCALE"
      render_exact "${rsum[$idx]:-0}" 1 "$p"
      ;;
    min) render_exact "$smin" 1 "$(decimals_in "$tok")" ;;
    max) render_exact "$smax" 1 "$(decimals_in "$tok")" ;;
    mean) render_exact "$ssum" "$cnt" "$(decimals_in "$tok")" ;;
    *) printf '?' ;;
  esac
}

# compare_report: recompute the fixture and compare it to the tool's report. Prints "" when they agree,
# otherwise a description of the first disagreement. A line the declared shapes cannot match is a
# failure of the read, never a silent zero.
check_report() { # $1 fixture, $2 output, $3 dup rule
  local fixture="$1" out="$2" rule="$3" exp msg="" line fv role tok want id cnt ssum smin smax tl tfv tcnt tsum tool_ids exp_ids
  exp=$(aggregate "$fixture" "$rule" "$ROUNDING_MODE")
  case "$exp" in ERROR_DUPLICATE*) printf 'the judge expected a duplicate error and the tool did not treat the id as one'; return ;; esac
  if [ -z "$exp" ]; then printf 'the judge recomputed nothing from the fixture'; return; fi
  while read -r line; do
    set -- $line
    [ "$1" = ID ] || continue
    id="$2"; cnt="$3"; ssum="$4"; smin="$5"; smax="$6"; shift 6
    local -a rsum=("$@")
    local fline
    fline=$(group_lines "$out" | while IFS= read -r l; do
      fv=$(match_fields "$l" "$GROUP_RE" "$GROUP_FIELDS")
      if [ -n "$fv" ] && [ "$(fieldval "$fv" id)" = "$id" ]; then printf '%s' "$l"; break; fi
    done)
    if [ -z "$fline" ]; then msg="$msg; no output line matched the declared per-id shape for id $id"; continue; fi
    fv=$(match_fields "$fline" "$GROUP_RE" "$GROUP_FIELDS")
    for role in $GROUP_FIELDS; do
      [ "$role" = id ] && continue
      tok=$(fieldval "$fv" "$role")
      want=$(role_token "$role" "$cnt" "$ssum" "$smin" "$smax" "$tok" "${rsum[@]}")
      [ "$tok" = "$want" ] || msg="$msg; id $id $role=$tok want $want"
    done
  done < <(printf '%s\n' "$exp" | grep '^ID ')
  tl=$(total_line "$out")
  if [ -z "$tl" ]; then
    msg="$msg; no output line matched the declared totals shape $TOTAL_RE"
  else
    tfv=$(match_fields "$tl" "$TOTAL_RE" "$TOTAL_FIELDS")
    set -- $(printf '%s\n' "$exp" | grep '^TOT ')
    tcnt="$2"; tsum="$3"; shift 3
    local -a trsum=("$@")
    for role in $TOTAL_FIELDS; do
      tok=$(fieldval "$tfv" "$role")
      want=$(role_token "$role" "$tcnt" "$tsum" 0 0 "$tok" "${trsum[@]}")
      [ "$tok" = "$want" ] || msg="$msg; totals $role=$tok want $want"
    done
  fi
  tool_ids=$(group_lines "$out" | while IFS= read -r l; do fv=$(match_fields "$l" "$GROUP_RE" "$GROUP_FIELDS"); printf '%s\n' "$(fieldval "$fv" id)"; done | sort -u | tr '\n' ' ')
  exp_ids=$(printf '%s\n' "$exp" | awk '$1 == "ID" { print $2 }' | sort -u | tr '\n' ' ')
  [ "$tool_ids" = "$exp_ids" ] || msg="$msg; the set of ids differs (tool: ${tool_ids:-none}; want: ${exp_ids:-none})"
  printf '%s' "${msg#; }"
}
BODY

  cat <<'RUNS'

# Whatever the judge started, it kills — including when a scenario fails or the run ends early. A leaked
# server would make the NEXT run's scenario pass for the wrong reason (the surface from this run still
# answering), which is the kind of rot that never announces itself.
trap 'kill_scenario_surfaces' EXIT INT TERM

# --- the relations (one check per id the document declared) --------------------------------------
# `{csv}` in a scenario's start/run resolves to the same base fixture the relations run against, so the
# surface a scenario starts and the world the judge judges are one and the same file.
SCENARIO_CSV="$FIX/base.csv"
run_tool "$FIX/base.csv"
base_output="$RUN_OUT"
base_status="$RUN_STATUS"
base_cmd="$RUN_CMD"
# ADR-046: a bound that was hit is a FAILURE that names the command, never a pass and never a silent
# "no output". The message mirrors the mutation relation's wording, so one kind of timeout reads the
# same wherever it is hit.
BASE_TIMEOUT_DETAIL=""
if [ "$base_status" = 124 ]; then
  BASE_TIMEOUT_DETAIL="the deliverable command timed out after ${RUN_TIMEOUT_MS}ms, so the deliverable was never exercised: ${base_cmd}"
  printf '# %s\n' "$BASE_TIMEOUT_DETAIL"
fi
if [ -z "$base_output" ]; then
  printf '# the deliverable produced no output at all (exit %s)\n' "$base_status"
fi
base_groups=$(group_lines "$base_output" | grep -c . || true)
base_total=$(total_line "$base_output")
base_parsed=$(classify "$base_output" | grep -cE '^[GTS]' || true)
alive=0
[ "${base_parsed:-0}" -ge 1 ] && alive=1

# The vacuous-green guard (ADR-013/ADR-033): if the deliverable produced nothing the declared shapes
# can parse, then NO relation was exercised, so none of them may pass — a relation must never pass by
# comparing two empty results. A bound that was hit is reported as its own failure, naming the command,
# because "exit 124" alone reads as a mystery rather than as a command that hung.
guard_fail() { # $1 relation id, $2 text
  if [ -n "$BASE_TIMEOUT_DETAIL" ]; then
    relation not_ok "$1" "$2" "$BASE_TIMEOUT_DETAIL"
  else
    relation not_ok "$1" "$2" "the judge did not exercise the deliverable: nothing in its output (exit ${base_status}) matched a declared output shape, so this relation is unproven"
  fi
}
RUNS

  while read -r rid rkind; do
    [ -z "${rkind:-}" ] && continue
    case "$rkind" in
      row-order-invariance)
        cat <<'REL001' | sed "s/@RID@/$rid/g"
run_tool "$FIX/ord-base.csv"
ord_base="$RUN_OUT"
run_tool "$FIX/ord-reversed.csv"
reversed_output="$RUN_OUT"
[ -n "$ROW_ORDER_NOTE" ] && printf '# %s\n' "$ROW_ORDER_NOTE"
if [ "$alive" != 1 ] || [ "${base_groups:-0}" -eq 0 ]; then
  guard_fail @RID@ "row-order-invariance: reshuffling the rows changes nothing"
else
  sorted_base=$(printf '%s\n' "$ord_base" | sort)
  sorted_reversed=$(printf '%s\n' "$reversed_output" | sort)
  if [ -n "$base_output" ] && [ "$sorted_base" = "$sorted_reversed" ]; then
    relation ok @RID@ "row-order-invariance: reshuffling the rows changes nothing"
  else
    relation not_ok @RID@ "row-order-invariance: reshuffling the rows changes the report" "$(printf '%s\n' "$sorted_base" | diff - <(printf '%s\n' "$sorted_reversed") | head -4 | tr '\n' ' ')"
  fi
fi
REL001
        ;;
      additivity)
        cat <<'REL002' | sed "s/@RID@/$rid/g"
if [ "$alive" != 1 ]; then
  guard_fail @RID@ "additivity: the parts sum to the whole the tool printed"
elif [ -z "$base_total" ]; then
  relation not_ok @RID@ "additivity: no line matched the declared totals shape, so the whole cannot be checked" "totals_re=$TOTAL_RE"
else
  add_bad=""
  for role in $ADD_ROLES; do
    gsum=0
    while IFS= read -r l; do
      fv=$(match_fields "$l" "$GROUP_RE" "$GROUP_FIELDS"); v=$(fieldval "$fv" "$role")
      [ -n "$v" ] && gsum=$(awk -v a="$gsum" -v b="$v" 'BEGIN { printf "%.10g", a + b }')
    done < <(group_lines "$base_output")
    tv=$(fieldval "$(match_fields "$base_total" "$TOTAL_RE" "$TOTAL_FIELDS")" "$role")
    if [ -z "$tv" ]; then add_bad="$add_bad the totals line declares no $role;"; continue; fi
    [ "$(awk -v a="$gsum" -v b="$tv" 'BEGIN { print (a == b) ? "y" : "n" }')" = y ] || add_bad="$add_bad the $role values sum to $gsum but the totals line says $tv;"
  done
  if [ -z "$add_bad" ]; then
    relation ok @RID@ "additivity: the parts sum to the whole the tool printed ($(printf '%s' $ADD_ROLES | tr ' ' '/'))"
  else
    relation not_ok @RID@ "additivity:${add_bad}" "roles=$ADD_ROLES sums=$(printf '%s' $ADD_ROLES | tr ' ' ',')"
  fi
fi
REL002
        ;;
      duplicate-resolution)
        cat <<'REL003' | sed "s/@RID@/$rid/g"
if [ "$alive" != 1 ]; then
  guard_fail @RID@ "duplicate-resolution: the repeated-id rule \"$DUPLICATE_MODE\" holds"
else
  case "$DUP_RULE" in
    none)
      relation not_ok @RID@ "duplicate-resolution: the forged judge has no duplicate rule" "mode=$DUPLICATE_MODE"
      ;;
    error)
      run_tool "$FIX/dup-late-date.csv"
      dup_status="$RUN_STATUS"
      if [ "$dup_status" != 0 ]; then
        relation ok @RID@ "duplicate-resolution: a repeated id is an error, and the tool failed ($dup_status) as chosen"
      else
        relation not_ok @RID@ "duplicate-resolution: the chosen option is \"treat it as an error\" and the tool exited 0 with a summary" "exit=$dup_status output=$(printf '%s' "$RUN_OUT" | head -2 | tr '\n' ' ')"
      fi
      ;;
    *)
      run_tool "$FIX/dup-late-date.csv"
      late_out="$RUN_OUT"
      run_tool "$FIX/dup-early-date.csv"
      early_out="$RUN_OUT"
      ml=$(check_report "$FIX/dup-late-date.csv" "$late_out" "$DUP_RULE")
      me=$(check_report "$FIX/dup-early-date.csv" "$early_out" "$DUP_RULE")
      if [ -z "$ml" ] && [ -z "$me" ]; then
        relation ok @RID@ "duplicate-resolution: the chosen option \"$DUPLICATE_MODE\" holds on both duplicate fixtures"
      else
        relation not_ok @RID@ "duplicate-resolution: the chosen option \"$DUPLICATE_MODE\" does not hold (late-date: ${ml:-agrees}; early-date: ${me:-agrees})" "late=${ml:-ok} early=${me:-ok}"
      fi
      ;;
  esac
fi
REL003
        ;;
      malformed-row-accounting)
        cat <<'REL004' | sed "s/@RID@/$rid/g"
run_tool "$FIX/malformed.csv"
mal_out="$RUN_OUT"
mal_status="$RUN_STATUS"
valid=$(aggregate "$FIX/malformed.csv" "$DUP_RULE" "$ROUNDING_MODE" | awk '$1 == "TOT" { print $2 }')
if [ "$MALFORMED_MODE" = skip-count ] || [ "$MALFORMED_MODE" = skip-silent ]; then
  if [ "$alive" != 1 ]; then
    guard_fail @RID@ "malformed-row-accounting: the bad rows are out of the aggregates"
  else
    wants_count=0
    [ "$MALFORMED_MODE" = skip-count ] && wants_count=1
    mal_head=$(fieldval "$(match_fields "$(total_line "$mal_out")" "$TOTAL_RE" "$TOTAL_FIELDS")" count)
    mal_skipped=$(fieldval "$(match_fields "$(skip_line "$mal_out")" "$SKIP_RE" "$SKIP_FIELDS")" skipped-count)
    count_ok=yes
    [ "$wants_count" = 1 ] && { [ "$mal_skipped" = "$MALFORMED_COUNT" ] || count_ok=no; }
    if [ "$mal_status" = 0 ] && [ "$mal_head" = "$valid" ] && [ "$count_ok" = yes ]; then
      relation ok @RID@ "malformed-row-accounting: $MALFORMED_COUNT malformed rows are out of the aggregates, $valid valid rows still report a summary ($MALFORMED_MODE)"
    else
      relation not_ok @RID@ "malformed-row-accounting: exit $mal_status, headcount ${mal_head:-<none>} (expected $valid), skipped ${mal_skipped:-<none>} ($MALFORMED_MODE wants $([ "$wants_count" = 1 ] && echo "the count $MALFORMED_COUNT" || echo "no count line"))" "exit=$mal_status headcount=${mal_head:-none} skipped=${mal_skipped:-none} want=$valid"
    fi
  fi
elif [ "$MALFORMED_MODE" = stop-error ]; then
  if [ "$mal_status" != 0 ]; then
    relation ok @RID@ "malformed-row-accounting: a malformed row is an error, and the tool failed ($mal_status) as chosen"
  else
    relation not_ok @RID@ "malformed-row-accounting: the chosen option is \"stop with an error\" and the tool exited 0 on a malformed input" "exit=$mal_status"
  fi
else
  relation not_ok @RID@ "malformed-row-accounting: the forged judge has no malformed-row rule" "mode=$MALFORMED_MODE"
fi
REL004
        ;;
      independent-aggregation)
        cat <<'DIFF001' | sed "s/@RID@/$rid/g"
if [ "$alive" != 1 ]; then
  guard_fail @RID@ "independent-aggregation: an independent recomputation matches the report"
else
  diffbad=$(check_report "$FIX/base.csv" "$base_output" "$DUP_RULE")
  if [ -z "$diffbad" ]; then
    relation ok @RID@ "independent-aggregation: an independent recomputation (rounding: $ROUNDING_MODE) matches the report"
  else
    relation not_ok @RID@ "independent-aggregation: an independent recomputation (rounding: $ROUNDING_MODE) disagrees with the report" "$diffbad"
  fi
fi
DIFF001
        ;;
      browser-scenario)
        cat <<'SCN' | sed "s/@RID@/$rid/g"
sid="@RID@"
sport=$(alloc_port)
surl=$(subst "$(scenario_field "$sid" 5)" "$SCENARIO_CSV" "$sport" "")
srun=$(subst "$(scenario_field "$sid" 2)" "$SCENARIO_CSV" "$sport" "$surl")
sexpect=$(scenario_field "$sid" 3)
sstart=$(subst "$(scenario_field "$sid" 4)" "$SCENARIO_CSV" "$sport" "$surl")
sreport=$(scenario_field "$sid" 6)
srpath=$(scenario_field "$sid" 7)
stmo=$(scenario_field "$sid" 8)
sstatus=$(scenario_field "$sid" 10)
sbody=$(scenario_field "$sid" 11)
[ -n "$stmo" ] || stmo=60
if [ -z "$srun" ]; then
  relation not_ok "$sid" "browser-scenario: $sexpect" "the forged judge has no run for this scenario"
else
  reason=""
  scn_out=""; scn_status=0
  start_scenario_surface "$sid" "$sstart"
  if [ -n "$surl" ]; then
    if ! wait_for_url "$surl" 20; then
      reason="the surface the document declares ($surl) did not answer within 20s of starting \"$sstart\""
    fi
  fi
  if [ -z "$reason" ]; then
    # ADR-046: LOOK AT THE RESPONSE. The document declares what the surface must answer with, and the
    # judge applies that assertion ITSELF — so a scenario cannot pass by running a command that merely
    # reaches the surface and exits 0 whatever the surface said. A url/start with neither assertion is
    # refused before the judge is forged, so at least one of these is set for a service scenario.
    sbody_file="$JUDGE_DIR/$sid-response.txt"
    if [ -n "$sstatus" ] || [ -n "$sbody" ]; then
      actual=$(curl -sS -o "$sbody_file" -w '%{http_code}' --max-time 5 "$surl" 2>/dev/null); curl_rc=$?
      [ "$curl_rc" = 0 ] || actual="000"
      if [ -n "$sstatus" ] && [ "$actual" != "$sstatus" ]; then
        reason="the surface answered HTTP $actual where the document declares expect_status $sstatus"
      elif [ -n "$sbody" ] && ! grep -qF -- "$sbody" "$sbody_file" 2>/dev/null; then
        reason="the response body does not contain the declared expect_body \"$sbody\" (the surface answered HTTP $actual)"
      fi
    fi
    scn_out=$( ( cd "$WORKTREE" && timeout "$stmo" sh -c "$srun" ) 2>&1 )
    scn_status=$?
    if [ -z "$reason" ]; then
      if [ "$scn_status" != 0 ]; then
        [ "$scn_status" = 124 ] && reason="the scenario command timed out after ${stmo}s" || reason="the scenario command exited $scn_status"
      elif [ -n "$sreport" ]; then
        reason=$(scenario_report_failures "$sreport" "$WORKTREE/$srpath")
      fi
    fi
  fi
  kill_scenario_surfaces
  if [ -z "$reason" ]; then
    relation ok "$sid" "$sexpect"
  else
    relation not_ok "$sid" "$sexpect" "$reason: $(printf '%s' "$scn_out" | tail -3 | tr '\n' ' ')"
  fi
fi
SCN
        ;;
      mutation-detection)
        cat <<'MUT' | sed "s/@RID@/$rid/g"
# ADR-039: the delivered TESTS must be able to fail. The judge runs the mutation tool the document
# declares, reads the report it writes, and compares the survivors to the declared budget. Every path
# where the tool did not actually run fails CLOSED: not-run is not a pass.
if [ -z "$MUT_RUN" ]; then
  relation not_ok @RID@ "mutation-detection: the delivered tests fail when the delivered behaviour is mutated" "the forged judge has no mutation run for this relation"
else
  mut_out=$( ( cd "$WORKTREE" && timeout "$MUT_TIMEOUT_S" sh -c "$MUT_RUN" ) 2>&1 )
  mut_status=$?
  mpath="$WORKTREE/$MUT_REPORT_PATH"
  mut_reason=""
  if [ "$mut_status" = 124 ]; then
    mut_reason="the mutation command timed out after ${MUT_TIMEOUT_MS}ms, so the tests were never exercised: $MUT_RUN"
  elif [ "$mut_status" = 127 ]; then
    mut_reason="the mutation command could not run (exit 127), so the tests were never exercised: $MUT_RUN"
  elif [ ! -f "$mpath" ]; then
    mut_reason="the report $mpath does not exist (the command exited $mut_status): a mutation run whose report the judge cannot read is not a pass"
  else
    mut_reason=$(mutation_report_failures "$MUT_FORMAT" "$mpath" "$MUT_MAX_SURVIVORS")
  fi
  if [ -z "$mut_reason" ]; then
    relation ok @RID@ "mutation-detection: the delivered tests fail when the delivered behaviour is mutated ($(printf '%s' "$MUT_MAX_SURVIVORS") survivor(s) tolerated)"
  else
    relation not_ok @RID@ "mutation-detection: the delivered tests fail when the delivered behaviour is mutated" "$mut_reason"
  fi
fi
MUT
        ;;
    esac
  done <<EOF
$RELATIONS
EOF

  cat <<'DOC001'

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
DOC001

  # The decision lines, generated from the document: one per decision a relation or anchor exercises.
  # `decide` reads the exercised relation's own verdict, so a decision can never be reported honoured by
  # a check that failed.
  #
  # `emit_print` writes a PRINT statement into the judge rather than a bare `#` line: a `#` line in the
  # generated file is a comment to the judge too, which is how a "not mechanised" note disappears from
  # a report without anyone noticing.
  emit_print() { printf "printf '%%s\\\\n' '%s'\n" "$(sq "$1")"; }
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
  emit_print "# not mechanised: acceptance criteria no declared relation covers (performance, file size, presentation) are not checked by this judge"
  if [ -n "${WORDS_ONLY:-}" ]; then
    printf '%s\n' "$WORDS_ONLY" | while IFS='|' read -r wkey wshape; do
      [ -z "${wshape:-}" ] && continue
      emit_print "# not mechanised: the output line \"$wshape\" ($wkey) declares no fields, so no declared shape can say which number is which"
    done
  fi
  if [ -n "${UNEXERCISED:-}" ]; then
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
