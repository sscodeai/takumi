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
