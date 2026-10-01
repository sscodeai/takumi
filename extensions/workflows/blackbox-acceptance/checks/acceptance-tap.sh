#!/usr/bin/env bash
# The acceptance harness for the blackbox-acceptance workflow (ADR-025).
#
# A REAL fail-closed harness, not decoration. It runs with cwd = the project root, and it judges the
# artefact-level evidence the run produced. Two signals come out of it:
#
#   * TAP lines (`ok N - …` / `not ok N - …`) plus a `# tests/# pass/# fail` summary, so the shape of
#     the result is readable by both the engine's test-report parser and a human;
#   * one structured `ACCEPT_VERDICT: pass|fail` marker, which is the ONLY thing the acceptance step
#     reads as a verdict — the engine's prose decides nothing, and a missing marker fails the step.
#
# Scope, honestly stated: with the `fake` runtime the agent steps' artifacts are the prompt echoed
# back, so checks 4-6 prove the run's wiring and the harness's own fail-closed behaviour, not the
# quality of an intake. Checks 1-3 are about the CONFIRMED requirement document, which is a real
# human artefact. Replacing the fake runtime is what turns this into a behavioural acceptance; the
# step type, the digest binding and the refusal paths do not change when it is replaced.

set -u

REQ_DOC="docs/requirements/poc-blackbox-acceptance.yaml"
INTAKE_DOC=".takumi/artifacts/req/req_intake.md"
IMPL_DOC=".takumi/artifacts/implementation/implementation.md"
UNIT_DOC=".takumi/artifacts/unit/unit_and_integration_tests.md"

PASS=0
FAIL=0
N=0

ok() {
  N=$((N + 1))
  PASS=$((PASS + 1))
  printf 'ok %d - %s\n' "$N" "$1"
}

not_ok() {
  N=$((N + 1))
  FAIL=$((FAIL + 1))
  printf 'not ok %d - %s\n' "$N" "$1"
}

check_file() {
  if [ -f "$1" ]; then ok "$2"; else not_ok "$2 (missing: $1)"; fi
}

check_grep() {
  if grep -Eq "$1" "$2" 2>/dev/null; then ok "$3"; else not_ok "$3 (no match for /$1/ in $2)"; fi
}

# 1. the confirmed requirement document exists and is a structured requirement document.
check_file "$REQ_DOC" "the confirmed requirement document exists: $REQ_DOC"
check_grep '^[[:space:]]*requirements:[[:space:]]*$' "$REQ_DOC" "the requirement document has a requirements list"
check_grep '^[[:space:]]*-[[:space:]]*id:[[:space:]]*REQ-[0-9]+' "$REQ_DOC" "the requirement document carries REQ-nnn ids"

# 2. the open decisions are recorded, and 3. each one has a chosen option. An acceptance of a
#    document whose ambiguities were never decided accepts something nobody agreed to.
check_grep '^[[:space:]]*-[[:space:]]*id:[[:space:]]*AMB-[0-9]+' "$REQ_DOC" "the requirement document records its open decisions (AMB-nnn)"
AMB_COUNT=$(grep -Ec '^[[:space:]]*-[[:space:]]*id:[[:space:]]*AMB-[0-9]+' "$REQ_DOC" 2>/dev/null)
CHOSEN_COUNT=$(grep -Ec '^[[:space:]]*chosen:[[:space:]]*\S' "$REQ_DOC" 2>/dev/null)
if [ "$AMB_COUNT" -gt 0 ] && [ "$CHOSEN_COUNT" -ge "$AMB_COUNT" ]; then
  ok "every open decision has a chosen option ($CHOSEN_COUNT/$AMB_COUNT)"
else
  not_ok "not every open decision has a chosen option ($CHOSEN_COUNT/$AMB_COUNT)"
fi

# 4-6. the run's own artefacts exist. Wiring checks under the fake runtime; see the note above.
check_file "$INTAKE_DOC" "the intake artifact exists: $INTAKE_DOC"
check_file "$IMPL_DOC" "the implementation artifact exists: $IMPL_DOC"
check_file "$UNIT_DOC" "the unit and integration test artifact exists: $UNIT_DOC"

printf '# tests %d\n' "$N"
printf '# pass %d\n' "$PASS"
printf '# fail %d\n' "$FAIL"

if [ "$FAIL" -eq 0 ]; then
  printf 'ACCEPT_VERDICT: pass\n'
  exit 0
fi
printf 'ACCEPT_VERDICT: fail\n'
exit 1
