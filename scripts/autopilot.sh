#!/usr/bin/env bash
# takumi autopilot — ONE sentence in, a delivered change out, with nobody at the keyboard.
#
# Three acts a person used to perform by hand. None of them is new; what was missing was the ORDER, the
# fail-closed hand-off between them, and the one licensed human act:
#
#   1. INTAKE        one sentence becomes a structured requirement document        (request-intake)
#   2. CONFIRMATION  the document is licensed from a signed standing authorization (ADR-045). This is
#                    the ONE human act in the flow — and it happened when the grant was SIGNED, not
#                    now. With no matching grant this step REFUSES: there is no TTY here, and a digest
#                    a machine invented for itself is not a confirmation (ADR-025, ADR-027).
#   3. DELIVERY      the confirmed document is implemented, judged, published, checked by the host's own
#                    pipeline and merged                                    (request-to-delivery)
#
# What is deliberately NOT here: any way to confirm a document without a signed grant, any retry that
# spends an agent's money without being asked, and any tolerance for "the intake maybe worked". Every
# step must be able to say it succeeded, or the chain stops and names the step that failed.
#
# Usage:
#   scripts/autopilot.sh "<one sentence>" [--authorization docs/authorizations/SA-002.yaml]
#   scripts/autopilot.sh "<one sentence>" --dry-run     # print the three commands, run nothing
#   scripts/autopilot.sh "<one sentence>" --deliverable docs/requirements/other.yaml
#
# Exit codes: 0 the delivery was accepted AND merged. 1 a step refused; the message names which one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

REQUEST=""
AUTHORIZATION="docs/authorizations/SA-002.yaml"
DELIVERABLE="docs/requirements/intake.yaml"
RUNTIME="${TAKUMI_RUNTIME:-pi}"
DRY_RUN=0
CLI=(node apps/cli/dist/index.js)

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --authorization) AUTHORIZATION="$2"; shift 2 ;;
    --deliverable) DELIVERABLE="$2"; shift 2 ;;
    --runtime) RUNTIME="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage ;;
    --*) echo "unknown option: $1" >&2; usage ;;
    *) REQUEST="$1"; shift ;;
  esac
done

if [ -z "$REQUEST" ]; then usage; fi

if [ "$DRY_RUN" -eq 0 ] && [ ! -f "apps/cli/dist/index.js" ]; then
  echo "the CLI is not built: run 'pnpm -r build' first (looked for apps/cli/dist/index.js)" >&2
  exit 1
fi

step() { printf '\n== %s\n' "$*"; }

if [ "$DRY_RUN" -eq 1 ]; then
  step "dry run — nothing is executed, these are the three commands"
  echo "1/3 intake      : ${CLI[*]} run '<request>' --workflow request-intake --runtime $RUNTIME"
  echo "2/3 confirm     : ${CLI[*]} requirement confirm $DELIVERABLE --authorization $AUTHORIZATION"
  echo "3/3 delivery    : ${CLI[*]} run $DELIVERABLE --workflow request-to-delivery --runtime $RUNTIME \\"
  echo "                    --requirement $DELIVERABLE --confirmed-requirement sha256:<from step 2>"
  exit 0
fi

# ---- 0. the licence is checked BEFORE anything is spent --------------------------------------------
# An agent turn costs money and minutes, and the confirmation is the step that decides whether the
# document may be built at all. Discovering at step 2 that no signed grant covers it would throw away
# step 1 entirely — the same reasoning as the delivery front door (ADR-037, ADR-051).
if [ ! -f "$AUTHORIZATION" ]; then
  echo "refusing: no standing authorization at $AUTHORIZATION." >&2
  echo "This flow's ONE human act is signing that grant (ADR-045): it licenses the NON-INTERACTIVE" >&2
  echo "confirmation of the documents its scope names, and nothing else. Start from" >&2
  echo "docs/authorizations/SA-002.template.yaml — review the scope and the decision classes, then sign." >&2
  exit 1
fi

# ---- 0b. the environment is checked BEFORE anything is spent ---------------------------------------
# Act 1 spends an agent's money and minutes, so an environment that cannot possibly finish the
# chain must be refused first. This is not hypothetical: three runs of this script each died in
# ONE SECOND on a stale build output, and the only clue was a message about an unpublished SDK
# (ledger #76). A refused measurement says nothing about the chain's reliability, so the chain
# refuses to BE measured until its own machine is healthy.
if ! bash "$ROOT/scripts/preflight-unattended.sh"; then
  echo "refusing to start: the environment is not healthy (see PREFLIGHT above)." >&2
  echo "This is not a delivery failure and must not be recorded as one (ledger #76): fix the" >&2
  echo "environment, then measure. The chain has spent nothing." >&2
  exit 1
fi

# ---- 1. intake: a document, or a refusal that says so ----------------------------------------------
step "1/3 intake — one sentence becomes a requirement document"
if ! "${CLI[@]}" run "$REQUEST" --workflow request-intake --runtime "$RUNTIME"; then
  echo "refusing to continue: the intake did not complete." >&2
  echo "The step that failed is named above. This chain does not grade a document the run did not" >&2
  echo "produce (ADR-053): either the agent wrote nothing, or what it wrote did not pass its own" >&2
  echo "machine-checked contract. Fix that step; do not confirm the document by hand to get past it." >&2
  exit 1
fi

if [ ! -f "$DELIVERABLE" ]; then
  echo "refusing: the intake reported success but $DELIVERABLE does not exist." >&2
  exit 1
fi
echo "document: $DELIVERABLE ($(wc -c < "$DELIVERABLE" | tr -d ' ') bytes, sha256:$(sha256sum "$DELIVERABLE" | cut -c1-12)…)"

# ---- 2. confirmation, licensed and non-interactive -------------------------------------------------
step "2/3 confirmation — licensed by $AUTHORIZATION"
CONFIRM_OUT="$("${CLI[@]}" requirement confirm "$DELIVERABLE" --authorization "$AUTHORIZATION" 2>&1)" || {
  printf '%s\n' "$CONFIRM_OUT" >&2
  echo "refusing: the confirmation was not licensed. The document is NOT confirmed and nothing is built." >&2
  exit 1
}
printf '%s\n' "$CONFIRM_OUT"
TOKEN="$(printf '%s\n' "$CONFIRM_OUT" | grep -oE 'sha256:[0-9a-f]{64}' | tail -1)"
if [ -z "$TOKEN" ]; then
  echo "refusing: the confirmation produced no token, so there is nothing to bind the delivery to." >&2
  exit 1
fi
echo "confirmation token: $TOKEN"

# ---- 3. delivery: implement, judge, publish, check, merge -------------------------------------------
step "3/3 delivery — implement, judge, publish, wait for the host's pipeline, merge"
if ! "${CLI[@]}" run "$DELIVERABLE" --workflow request-to-delivery --runtime "$RUNTIME" \
  --requirement "$DELIVERABLE" --confirmed-requirement "$TOKEN"; then
  echo "the delivery did NOT land. Nothing was merged; the failing step is named above." >&2
  exit 1
fi

# ---- the delivery face: what a reader checks, taken from the run record -----------------------------
step "delivered — the evidence, read from the run record rather than from this script's prose"
RECORD="$(ls -t .takumi/runs/*.json | head -1)"
node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
console.log("run        :", r.runId, "|", r.outcome, "|", (r.durationMs / 1000).toFixed(0) + "s");
const pr = r.published && r.published.pullRequest;
if (pr) console.log("pull request:", pr.url ?? pr.number);
if (r.merged && r.merged.headSha) console.log("merged head:", r.merged.headSha);
console.log("record     :", process.argv[1]);
' "$RECORD"

echo
echo "autopilot: done."
