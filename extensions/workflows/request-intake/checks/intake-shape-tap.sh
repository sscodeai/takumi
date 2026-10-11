#!/usr/bin/env bash
# The intake's shape check, as TAP (the shape the quality gate recognises).
#
# Why this exists at all: an intake's output used to be prose in a conversation, and the flow had no way
# to tell a confirmable document from a plausible-looking one. Here the question is decided by the same
# validator the human's confirmation uses (`takumi requirement confirm --dry-run`, ADR-030): ids that do
# not line up, a decision with fewer than 2 or more than 4 options, a `default`/`chosen` value that is
# not one of its own options, a requirement with no acceptance criterion, a citation that names nothing,
# and a blocking decision nobody decided are all refusals — and a refusal is a failed check here, not a
# note in the transcript.
#
# The gate itself requires a test-summary shape, so this script has to speak TAP; the first version of
# this check just echoed the CLI's output and the gate failed it for "no known test summary" — which is
# the gate working, and the reason this file is TAP.
set -u

REF="${TAKUMI_INTAKE_DOC:-docs/requirements/intake.yaml}"
CLI="${TAKUMI_CLI:-apps/cli/dist/index.js}"

N=0; PASS=0; FAIL=0
ok() { N=$((N + 1)); PASS=$((PASS + 1)); printf 'ok %d - %s\n' "$N" "$1"; }
not_ok() { N=$((N + 1)); FAIL=$((FAIL + 1)); printf 'not ok %d - %s\n' "$N" "$1"; }

if [ ! -f "$REF" ]; then
  not_ok "the intake wrote $REF"
  printf '# the intake produced no document, so nothing downstream can be confirmed\n'
  printf '# tests %d\n# pass %d\n# fail %d\n' "$N" "$PASS" "$FAIL"
  exit 1
fi
ok "the intake wrote $REF"
printf '# %s bytes\n' "$(wc -c < "$REF" | tr -d ' ')"

if [ ! -f "$CLI" ]; then
  not_ok "the validator is present at $CLI"
  printf '# tests %d\n# pass %d\n# fail %d\n' "$N" "$PASS" "$FAIL"
  exit 1
fi

OUT=$(node "$CLI" requirement confirm "$REF" --dry-run 2>&1); STATUS=$?
printf '%s\n' "$OUT" | sed 's/^/# /'
if [ "$STATUS" -eq 0 ]; then
  ok "the document passes every rule the human's confirmation enforces"
else
  not_ok "the document passes every rule the human's confirmation enforces (exit $STATUS)"
fi

# ADR-031: the document must carry the contract a judge is forged from, or the acceptance after the
# implementation cannot be built at all. Presence is checked here; the content (invocation, vocabulary,
# coverage of every blocking decision) is checked by the validator above, which refuses in --dry-run.
if grep -qE '^deliverable:' "$REF" && grep -qE '^[[:space:]]+run:' "$REF" && grep -qE '^[[:space:]]*-[[:space:]]*id:[[:space:]]*REL-' "$REF"; then
  ok "the document declares a judge contract (run + relations)"
else
  not_ok "the document declares a judge contract (deliverable.run and at least one REL-nnn relation)"
fi

REQS=$(grep -cE '^[[:space:]]*-[[:space:]]*id:[[:space:]]*REQ-[0-9]+' "$REF" || true)
AMBS=$(grep -cE '^[[:space:]]*-[[:space:]]*id:[[:space:]]*AMB-[0-9]+' "$REF" || true)
if [ "$REQS" -ge 1 ]; then
  ok "the document records $REQS requirement(s) and $AMBS decision(s)"
else
  not_ok "the document records at least one requirement (found $REQS)"
fi

printf '# tests %d\n# pass %d\n# fail %d\n' "$N" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
