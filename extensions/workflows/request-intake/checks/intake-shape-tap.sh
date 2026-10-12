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

# ADR-056: HAVING a judge contract is not the same as a judge being forgeable from it, and the difference
# cost ~35 minutes of a real run (docs/bugs-fixed.md #69). On 2026-10-12 the third unattended chain
# produced a document this gate passed 5/5 — and `judge_forge` then refused it ("declares 0 output
# line(s) that are neither a per-id line nor a skipped line, where exactly one totals line is needed").
# The refusal is correct and the forge is the authority; what was wrong is WHERE it was discovered: the
# check above only asks whether the document HAS `deliverable.run` and a relation, and the validator
# above (`requirement confirm --dry-run`) knows nothing about forgeability — so the disagreement surfaced
# AFTER the implementation and the delivered tests had been paid for (1 047 s), and the repair round paid
# for it AGAIN, because a document does not change between attempts.
#
# So the gate asks the JUDGE'S OWN QUESTION here, before a human (or a signed grant) is asked to confirm
# anything: the forge is run against the document into a scratch judge directory and must answer
# `JUDGE_FORGE: ok`. A refusal becomes a failed check naming what the forge could not implement — the one
# place in the chain where fixing the document is still free. It runs the forge the run itself will run
# (`extensions/judges/metamorphic-forge.sh`), not a re-implementation of it, so the two cannot drift: a
# rule added to the forge is enforced here the same day, and no vocabulary list is maintained twice.
#
# `TAKUMI_WORKTREE` is a scratch directory, and that is deliberate: forging takes the document alone
# (ADR-026) and no implementation exists yet — the forge refuses a judge that hard-codes the worktree it
# was TOLD about, so a scratch path is the honest input and a real one would be a lie.
#
# The document is forged AS THE CONFIRMATION WILL LEAVE IT, not as the intake wrote it. The forge reads
# `chosen:` and the intake is forbidden to write it (rule 4b), so forging the raw intake document would
# refuse every document in the chain for a reason that is not about the contract at all ("$AMB has no
# chosen option: the judge would be built from a decision nobody made"). So every decision that has no
# `chosen:` is answered with its own `default:` first — which is exactly the answer a signed standing
# authorization takes (`confirmation.defaulted` records each one), and exactly what the human is offered
# as a bounded choice.
FORGE="${TAKUMI_FORGE:-extensions/judges/metamorphic-forge.sh}"
if [ ! -f "$FORGE" ]; then
  not_ok "the judge forge is present at $FORGE"
else
  mkdir -p "$PWD/.takumi"
  GATE_DIR=$(mktemp -d "$PWD/.takumi/gate-XXXXXX")
  AS_CONFIRMED="$GATE_DIR/intake-as-confirmed.yaml"
  awk '
    function flush() { if (pend) { print indent "chosen: " defval; pend = 0 } }
    {
      if (pend && $0 !~ /^[[:space:]]*chosen:[[:space:]]/) flush()
      print
      if ($0 ~ /^[[:space:]]*default:[[:space:]]/) {
        pend = 1; defval = $0; sub(/^[[:space:]]*default:[[:space:]]*/, "", defval)
        indent = $0; sub(/[^[:space:]].*$/, "", indent)
      } else if ($0 ~ /^[[:space:]]*chosen:[[:space:]]*/) { pend = 0 }
    }
    END { flush() }
  ' "$REF" > "$AS_CONFIRMED"
  JUDGE_TMP=$(mktemp -d)
  WORK_TMP=$(mktemp -d)
  FORGE_OUT=$(TAKUMI_REQUIREMENT="${AS_CONFIRMED#"$PWD"/}" TAKUMI_REQUIREMENT_DIGEST="sha256:gate" \
    TAKUMI_PROJECT="$PWD" TAKUMI_JUDGE_DIR="$JUDGE_TMP" TAKUMI_WORKTREE="$WORK_TMP" \
    timeout 120 bash "$FORGE" 2>&1)
  FORGE_STATUS=$?
  rm -rf "$JUDGE_TMP" "$WORK_TMP" "$GATE_DIR"
  printf '%s\n' "$FORGE_OUT" | sed 's/^/# /'
  if [ "$FORGE_STATUS" -eq 0 ] && printf '%s\n' "$FORGE_OUT" | grep -qE '^[[:space:]]*JUDGE_FORGE[[:space:]]*[:=][[:space:]]*ok[[:space:]]*$'; then
    ok "a judge can be forged from the document as the confirmation will leave it"
  else
    not_ok "a judge can be forged from the document as the confirmation will leave it (exit $FORGE_STATUS: no delivery could be judged against this document)"
  fi
fi

REQS=$(grep -cE '^[[:space:]]*-[[:space:]]*id:[[:space:]]*REQ-[0-9]+' "$REF" || true)
AMBS=$(grep -cE '^[[:space:]]*-[[:space:]]*id:[[:space:]]*AMB-[0-9]+' "$REF" || true)
if [ "$REQS" -ge 1 ]; then
  ok "the document records $REQS requirement(s) and $AMBS decision(s)"
else
  not_ok "the document records at least one requirement (found $REQS)"
fi

# The intake PROPOSES; the confirmation DECIDES. An intake that writes `chosen:` answers its own
# questions, and the confirmation then reports "0 decision(s) would be defaulted" — because there is
# nothing left for it to answer — so a reviewer sees an EMPTY `defaulted:` list while every decision was
# in fact taken by a machine. That list is the only place a machine's answers are meant to be visible
# (ADR-025, ADR-045), so a document that pre-chooses them is refused here rather than confirmed later.
#
# Scoped on purpose: a document that carries an actual `confirmation:` block HAS a record of who chose
# (a person, or a signed standing authorization), and re-confirming it is legitimate.
CHOSEN=$(grep -cE '^[[:space:]]+chosen:[[:space:]]' "$REF" || true)
if [ "$CHOSEN" -gt 0 ] && ! grep -qE '^confirmation:' "$REF"; then
  not_ok "the document arrives with $CHOSEN answer(s) already chosen and no record of who chose them"
  printf '# `chosen:` is the confirmation'"'"'s to write, not the intake'"'"'s: an intake PROPOSES a `default:`.\n'
  printf '# With the answers already taken, the confirmation defaults 0 decisions and its `defaulted:` list —\n'
  printf '# the one place a machine'"'"'s answers are visible to a reviewer — comes out EMPTY.\n'
else
  ok "the document leaves its answers to the confirmation ($CHOSEN pre-chosen, confirmation block: $(grep -qE '^confirmation:' "$REF" && echo present || echo absent))"
fi

printf '# tests %d\n# pass %d\n# fail %d\n' "$N" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
