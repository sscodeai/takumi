#!/usr/bin/env bash
# Run the WHOLE unattended chain with the boundary ON, and read the result out of the run record.
#
# Why this exists (ledger #75): the boundary was merged once after its own tests passed 12/12 while
# the CHAIN was dead — the boundary had been tested, the chain never ran with it. Any change to the
# boundary must pass THIS, on a machine whose kernel grants unprivileged user namespaces, before it
# may merge. CI cannot do it (GitHub-hosted runners refuse the namespace), which is exactly why it
# has to be a script someone can run rather than a step in a pipeline nobody watches.
#
# Usage: scripts/verify-boundary-chain.sh ["<one sentence>"]
# Exit:  0  the chain merged a delivery WITH the boundary in force
#        3  refused (unhealthy environment, or the unsafe override was set — the check would be
#           meaningless, since an unconfined run says nothing about the boundary)
#        1  ran, but the record does not say the boundary was in force / the delivery was accepted
#
# Credentials are read into variables and never printed (see scripts/autopilot.sh's header).
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$PWD"

SENTENCE=${1:-"I want a small command-line tool that reads a CSV of daily station temperatures and prints one line per station with the count, minimum, maximum and mean temperature, skipping malformed rows and reporting how many it skipped."}

echo "== 0. the check must be about the boundary =="
if [ -n "${TAKUMI_UNSAFE_NO_SANDBOX:-}" ]; then
  echo "refusing: TAKUMI_UNSAFE_NO_SANDBOX is set, so the run would NOT be confined and this check" >&2
  echo "would say nothing about the boundary. Unset it (or run the chain directly) instead." >&2
  exit 3
fi
bash "${ROOT}/scripts/preflight-unattended.sh" || { echo "refusing: the environment is not healthy" >&2; exit 3; }

echo "== 1. the chain, boundary ON =="
BEFORE=$(ls -1t "${ROOT}/.takumi/runs" 2>/dev/null | head -1 || true)
bash "${ROOT}/scripts/autopilot.sh" "$SENTENCE"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "the chain FAILED (exit $rc) with the boundary ON — that is the finding, not a flake." >&2
  exit 1
fi

echo "== 2. the record, not the prose =="
LATEST=$(ls -1t "${ROOT}/.takumi/runs"/*.json 2>/dev/null | head -1)
[ -n "${LATEST:-}" ] || { echo "no run record was written" >&2; exit 1; }
python3 - "$LATEST" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
steps = {s["id"]: s["status"] for s in d.get("steps", [])}
print(f"record  : {sys.argv[1]}")
print(f"outcome : {d.get('outcome')}   accepted: {d.get('accepted')}   sandbox: {d.get('sandbox')}")
print(f"steps   : {steps}")
problems = []
if d.get("sandbox") != "unshare":
    problems.append(f"the run record says sandbox={d.get('sandbox')!r}: the boundary was NOT in force, so this proves nothing")
if d.get("accepted") is not True:
    problems.append("the delivery was not accepted")
if steps.get("merge") != "done":
    problems.append("the merge step did not complete")
if problems:
    for p in problems:
        print(f"FAIL: {p}", file=sys.stderr)
    sys.exit(1)
print("OK: the chain merged a delivery with the boundary in force")
PY
