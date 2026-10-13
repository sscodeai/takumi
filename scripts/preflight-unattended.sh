#!/usr/bin/env bash
# THE UNATTENDED CHAIN'S PREFLIGHT — the cheapest possible check that the ENVIRONMENT is healthy,
# so an unhealthy environment is never recorded as a delivery failure.
#
# Why this exists (ledger #76): a stale `runtimes/pi/dist` (gitignored build output of a package
# that is NOT a pnpm workspace member, so `pnpm -r build` never touches it and CI never compiles
# it) made three unattended runs die in ONE SECOND each. The operator read "the SDK is not
# installed", chased the wrong problem, and a 0-of-3 result was about to be written down as a
# statement about the chain's reliability. It was a statement about the machine.
#
# No model spend, no writes, no network. Exits:
#   0  healthy — the chain may be measured
#   3  refused — the environment would make the measurement meaningless (the message says which)
#
# Usage: scripts/preflight-unattended.sh
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PI_DIST=${TAKUMI_PI_RUNTIME:-$ROOT/runtimes/pi/dist/index.js}

fail() { printf 'PREFLIGHT FAIL: %s\n' "$*" >&2; exit 3; }

[ -f "$PI_DIST" ] || fail "the pi runtime dist is missing ($PI_DIST) — TAKUMI_PI_RUNTIME points at it, or run: (cd runtimes/pi && pnpm install && pnpm build)"
[ -f apps/cli/dist/index.js ] || fail "the CLI is not built (apps/cli/dist/index.js missing) — run: pnpm -r build"

# The import itself is the check: a dist that loads but exports nothing usable, or one built
# against a platform that has since moved (an export removed by a revert), fails HERE in under a
# second instead of killing three runs.
# NOTE: the exit status is read from the CONTENT, not from `$?`: after a pipeline `$?` is the
# status of `head`, which is always 0 — a guard that can never fire is worse than no guard.
# THE DELIVERY TARGET MUST BE WRITABLE BY THE CREDENTIAL THE RUN WILL USE.
#
# Measured 2026-10-13 (ledger #81): three runs (1.5 h) implemented a deliverable FROM SCRATCH against
# a fresh repository, passed their own quality gates, and were ACCEPTED by their forged judges — and
# then all three died at `publish` with
#   remote: Permission to sscodeai/takumi-delivery-demo-2.git denied to sscodeai.
# A fine-grained PAT is scoped to explicitly selected repositories, so a target that is not in that
# list is unusable — a fact that costs nothing to check and 1.5 h to discover.
delivery_repo() {
  # An EXPLICITLY SET variable wins even when empty: a test (or a caller with nothing to deliver to)
  # sets TAKUMI_DELIVERY_REPO='' to skip the target check hermetically, instead of inheriting whatever
  # the operator's gitignored takumi.local.yaml happens to point at.
  if [ -n "${TAKUMI_DELIVERY_REPO+set}" ]; then printf '%s' "$TAKUMI_DELIVERY_REPO"; return; fi
  for f in takumi.local.yaml takumi.yaml; do
    [ -f "$f" ] || continue
    line=$(awk '/^delivery:/{d=1;next} d&&/^[^ ]/{d=0} d&&/^[[:space:]]+repo:/{print $2;exit}' "$f")
    [ -n "$line" ] && { printf '%s' "$line"; return; }
  done
}
delivery_branch() {
  awk '/^delivery:/{d=1;next} d&&/^[^ ]/{d=0} d&&/^[[:space:]]+baseBranch:/{print $2;exit}' takumi.local.yaml 2>/dev/null || printf 'main'
}
REPO=$(delivery_repo)
if [ -n "$REPO" ]; then
  # A DRY-RUN PUSH, because the cheap API answer LIES here. `gh api repos/<r> --jq .permissions.push`
  # returned `true` for a repository this credential cannot push to — that field describes the USER's
  # permission, not what a fine-grained token was SELECTED for. Measured 2026-10-13: that false
  # positive would have passed the very case this check exists for. A dry-run push exercises the
  # credential and the transport the `publish` step actually uses, and it writes NOTHING on the host.
  # No credential appears on the command line: the helper is the same one the chain pushes with.
  probe_ref=refs/heads/takumi-preflight-probe
  if push_output=$(git -c credential.helper=store push --dry-run --quiet "https://github.com/$REPO.git" "HEAD:$probe_ref" 2>&1); then
    printf 'PREFLIGHT ok: a push to the delivery target %s is accepted by the host (dry run)\n' "$REPO"
  else
    fail "a push to $REPO was REFUSED by the host: ${push_output##*$'\n'}. A fine-grained token only reaches the repositories SELECTED for it, and this one is not in that list — add it, or point delivery.repo at a repository this credential already covers. Refused BEFORE an implementation is paid for (ledger #81)"
  fi
  BASE=$(delivery_branch); BASE=${BASE:-main}
  GH_TOKEN="${GITHUB_TOKEN:-}" gh api "repos/$REPO/branches/$BASE" --jq '.name' >/dev/null 2>&1 \
    || fail "the delivery target $REPO has no base branch \"$BASE\" (delivery.baseBranch): the chain would publish onto a branch the host does not have"
fi

keys=$(node -e "import(process.argv[1]).then(m=>console.log(Object.keys(m).join(','))).catch(e=>{console.log('IMPORT_FAILED: '+e.message);process.exit(1)})" "$PI_DIST" 2>&1 | head -1)
case "$keys" in
  IMPORT_FAILED:*) fail "the pi runtime does not load: ${keys#IMPORT_FAILED: }" ;;
esac
case "$keys" in
  *PiRuntimeAdapter*) printf 'PREFLIGHT ok: pi runtime loads and exports PiRuntimeAdapter; CLI and authorization are where the chain expects them\n' ;;
  *) fail "the pi runtime loaded but exports no PiRuntimeAdapter (got: $keys)" ;;
esac

[ -f docs/authorizations/SA-002.yaml ] || printf 'PREFLIGHT note: no standing authorization at docs/authorizations/SA-002.yaml — the chain will refuse at step 2 (a person signs that grant; ledger #76 is about the ENVIRONMENT, this is about the licence)\n'
exit 0
