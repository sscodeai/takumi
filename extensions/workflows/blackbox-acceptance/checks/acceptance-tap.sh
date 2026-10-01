#!/usr/bin/env bash
# PoC-1 acceptance stand-in harness for the blackbox-acceptance workflow.
#
# This is a REAL fail-closed harness, not decoration. It runs with cwd = the
# project root and prints TAP so the quality_gate step that invokes it can parse
# the result. Every check prints `ok N - ...` or `not ok N - ...`, and the run
# exits non-zero if any check fails. Unknown or unreadable state is a failure.
#
# It is the PoC-1 stand-in for the first-class `acceptance` step type that
# PoC-2 adds; that step will bind the verdict to a requirement digest.

set -u

REQ_DOC=".takumi/artifacts/req/req_intake.md"
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

# (a) the requirement intake artifact exists.
if [ -f "$REQ_DOC" ]; then
  ok "requirement intake artifact exists: $REQ_DOC"
else
  not_ok "requirement intake artifact is missing: $REQ_DOC"
fi

# (b) the requirement document records open ambiguities. A document with no
# `ambiguities` key is not a structured requirement document.
if grep -Eq '^[[:space:]]*ambiguities[[:space:]]*:' "$REQ_DOC" 2>/dev/null; then
  ok "requirement document contains an ambiguities key"
else
  not_ok "requirement document has no ambiguities key: $REQ_DOC"
fi

# (c) the requirement document carries at least one requirement id.
if grep -Eq 'REQ-[0-9]+' "$REQ_DOC" 2>/dev/null; then
  ok "requirement document contains at least one REQ- id"
else
  not_ok "requirement document contains no REQ- id: $REQ_DOC"
fi

# (d) the implementation artifact exists.
if [ -f "$IMPL_DOC" ]; then
  ok "implementation artifact exists: $IMPL_DOC"
else
  not_ok "implementation artifact is missing: $IMPL_DOC"
fi

# (e) the unit and integration test artifact exists.
if [ -f "$UNIT_DOC" ]; then
  ok "unit and integration test artifact exists: $UNIT_DOC"
else
  not_ok "unit and integration test artifact is missing: $UNIT_DOC"
fi

printf '# tests 5\n'
printf '# pass %d\n' "$PASS"
printf '# fail %d\n' "$FAIL"

if [ "$FAIL" -eq 0 ]; then
  exit 0
fi
exit 1
