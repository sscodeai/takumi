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
  #
  # TWO DIFFERENT FAILURES WEAR THE SAME FACE (ledger #89). This check used to report EVERY failed dry
  # run as "the token does not select this repository", which is one of two causes and was measured to
  # be the WRONG one on this machine. A push can be refused because
  #   (a) the HOST rejected the credential — `remote: Invalid username or token. Password
  #       authentication is not supported for Git operations.` / `fatal: Authentication failed`. The
  #       credential in `~/.git-credentials` is not usable for HTTP git at all, and NO repository is
  #       reachable this way: measured 2026-10-18 by a controlled triple — the same token pushed with
  #       `http.extraheader` to BOTH the fresh target and the working target (exit 0, exit 0) while the
  #       credential-helper path failed for BOTH (exit 128). Two successes and one failure isolated the
  #       credential, not the repository.
  #   (b) the credential is VALID and this repository was not granted to it —
  #       `remote: Permission to <repo>.git denied to <user>`, which is ledger #81's case.
  # Reporting (a) as (b) sends the operator to the GitHub UI to add a repository that is already
  # selected, while the real fault is the credential transport. The messages below therefore NAME the
  # cause and the fix for the one they saw.
  probe_ref=refs/heads/takumi-preflight-probe
  if push_output=$(git -c credential.helper=store push --dry-run --quiet "https://github.com/$REPO.git" "HEAD:$probe_ref" 2>&1); then
    printf 'PREFLIGHT ok: a push to the delivery target %s is accepted by the host (dry run)\n' "$REPO"
  else
    last="${push_output##*$'\n'}"
    case "$push_output" in
      *"Invalid username or token"* | *"Authentication failed"* | *"could not read Username"* | *"terminal prompts disabled"*)
        # (a) The host refused the CREDENTIAL. No repository is reachable on this transport, so this
        # says nothing about $REPO — do NOT send the operator to the token's repository list.
        #
        # WHERE THE CREDENTIAL COMES FROM is not this script's business to assert: measured
        # 2026-10-18, `~/.git-credentials` held a VALID token while a URL-scoped helper
        # (`[credential "https://github.com"] helper = !gh auth git-credential` in ~/.gitconfig)
        # replaced `store` for github.com, so git sent a DIFFERENT, EXPIRED token from
        # `~/.config/gh/hosts.yml` on every push. The file this message used to name was innocent.
        # It therefore names the FETCH, not the file: `git config --show-origin --get-all
        # credential.helper` is what reveals an override like that one.
        fail "the host REJECTED the credential this repository hands to git, so this run could not push to ANY repository (not a statement about $REPO): $last. The chain's publish step pushes with plain 'git push', so an unusable credential stops a delivery AFTER its implementation has been paid for (ledger #89). WHICH credential that is, is a config question, not a file question: run 'git config --show-origin --get-all credential.helper' — a URL-scoped 'credential.https://github.com.helper' REPLACES the global store, so ~/.git-credentials (and the valid token inside it) is never read (measured 2026-10-18: that override pointed git at an expired token in ~/.config/gh/hosts.yml). Verify the fix with: git -c credential.helper=store push --dry-run https://github.com/$REPO.git HEAD:$probe_ref"
        ;;
      *)
        fail "a push to $REPO was REFUSED by the host: $last. The credential AUTHENTICATED and this repository was not granted to it: a fine-grained token only reaches the repositories SELECTED for it, and this one is not in that list — add it, or point delivery.repo at a repository this credential already covers. Refused BEFORE an implementation is paid for (ledger #81)"
        ;;
    esac
  fi
  BASE=$(delivery_branch); BASE=${BASE:-main}
  GH_TOKEN="${GITHUB_TOKEN:-}" gh api "repos/$REPO/branches/$BASE" --jq '.name' >/dev/null 2>&1 \
    || fail "the delivery target $REPO has no base branch \"$BASE\" (delivery.baseBranch): the chain would publish onto a branch the host does not have"
fi

# A STALE BUILD LOOKS EXACTLY LIKE A GOOD ONE UNTIL THE MODEL USES THE TOOLS IT LACKS.
#
# runtimes/pi is NOT a pnpm workspace member (its @earendil-works/pi-coding-agent SDK is an
# unpublished peer dependency) and dist/ is gitignored, so neither `pnpm -r build` nor CI ever
# rebuilds it. On 2026-10-13 the source carried the confined tools from 00:48 JST but the artifact
# on disk was the 2026-10-12 20:20 build, so every delivery run handed the model the SDK's BUILTIN
# tools while its record said `sandbox: unshare` (ledger #88). The checks below cannot see this:
# a stale build EXISTS and LOADS FINE. Refuse it by its AGE instead — a dist older than the newest
# file under its sibling `src/` is a boundary that is not there.
PI_PKG_DIR=$(cd "$(dirname "$PI_DIST")/.." 2>/dev/null && pwd) || PI_PKG_DIR=""
if [ -n "$PI_PKG_DIR" ] && [ -d "$PI_PKG_DIR/src" ]; then
  newest_src=$(find "$PI_PKG_DIR/src" -type f -newer "$PI_DIST" -print -quit 2>/dev/null)
  [ -n "$newest_src" ] && fail "the pi runtime dist is OLDER than its source: $newest_src is newer than $PI_DIST. runtimes/pi is not a pnpm workspace member (its SDK is an unpublished peer dependency), so pnpm -r build and CI never rebuild it, and a stale dist loads fine while silently giving the model the builtin tools (ledger #88). Rebuild: (cd runtimes/pi && pnpm build)"
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
