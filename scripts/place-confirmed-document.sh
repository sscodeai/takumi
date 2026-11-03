#!/usr/bin/env bash
# Put the CONFIRMED requirement document where the implementer can see it.
#
# WHY THIS EXISTS (ledger #120). Measured 2026-11-04 on `wf-b4760a89`, three files were in play at
# once:
#
#   the confirmed digest — what the confirmation licensed, and what every GATE reads  sha256:cdda0c7b…
#   the worktree's docs/requirements/intake.yaml — what the AGENT read                 sha256:12dfd7f2…
#       (that file came from `27b8f14 feat: deliver per-region revenue summary`, a PREVIOUS request)
#   the project's copy at the end of the run                                          sha256:3ab28b75…
#
# The request asked for a `suite,passed,total` pass percentage. The implementer built a per-region
# revenue summary — faithfully, from the document it could see. Telling it to "use THIS requirement
# document" (#114) is advice about a file it never had.
#
# The delivery worktree is CLONED from the delivery repository, whose `main` can hold a different
# document at the same path. So the confirmed document is written into the worktree, its digest is
# checked against the one the confirmation licensed, and the placement is COMMITTED — an uncommitted
# copy would be refused by worktree-ready (#106) and would never reach the host.
#
# Usage:
#   place-confirmed-document.sh --project <dir> --worktree <dir> --ref <path> --digest <sha256>
#
# Exit: 0 placed (or already correct), 1 refused (names why), 2 the inputs could not be read.
set -u

PROJECT=""; WORKTREE=""; REF=""; DIGEST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --worktree) WORKTREE="${2:-}"; shift 2 ;;
    --ref) REF="${2:-}"; shift 2 ;;
    --digest) DIGEST="${2:-}"; shift 2 ;;
    *) echo "place-confirmed-document: unknown option '$1'" >&2; exit 2 ;;
  esac
done
for need in PROJECT WORKTREE REF DIGEST; do
  eval "v=\$$need"
  [ -n "$v" ] || { echo "place-confirmed-document: --$(printf '%s' "$need" | tr 'A-Z_' 'a-z-') is required" >&2; exit 2; }
done
case "$DIGEST" in
  sha256:*) DIGEST="${DIGEST#sha256:}" ;;
esac

SRC="$PROJECT/$REF"
[ -f "$SRC" ] || { echo "place-confirmed-document: the project has no '$REF'" >&2; exit 2; }
[ -d "$WORKTREE" ] || { echo "place-confirmed-document: the worktree '$WORKTREE' does not exist" >&2; exit 2; }

# The document on disk must be the one the confirmation licensed. If it is not, the project copy
# changed after the confirmation and placing it would deliver a document nobody signed.
actual=$(sha256sum "$SRC" | awk '{ print $1 }')
if [ "$actual" != "$DIGEST" ]; then
  echo "place-confirmed-document: the project's '$REF' does not match the confirmed digest." >&2
  echo "  confirmed: $DIGEST" >&2
  echo "  on disk:   $actual" >&2
  echo "  The document changed after it was confirmed, so its confirmation no longer applies. Re-confirm it." >&2
  exit 1
fi

DST="$WORKTREE/$REF"
if [ -f "$DST" ]; then
  dst_actual=$(sha256sum "$DST" | awk '{ print $1 }')
  if [ "$dst_actual" = "$DIGEST" ]; then
    echo "the worktree already holds the confirmed document ($REF sha256:${DIGEST%"${DIGEST#???????}"})"
    exit 0
  fi
  echo "the worktree held a DIFFERENT document at $REF (sha256:${dst_actual%"${dst_actual#???????}"}) — replacing it with the confirmed one"
fi

mkdir -p "$(dirname "$DST")"
cp "$SRC" "$DST"

placed=$(sha256sum "$DST" | awk '{ print $1 }')
if [ "$placed" != "$DIGEST" ]; then
  echo "place-confirmed-document: the copy did not land byte-for-byte (expected $DIGEST, got $placed)" >&2
  exit 1
fi

# COMMITTED, because the agent's boundary is the commit: takumi never commits the deliverable, and an
# uncommitted document would be refused at the next step and never reach the host.
if [ -d "$WORKTREE/.git" ] || git -C "$WORKTREE" rev-parse --git-dir >/dev/null 2>&1; then
  git -C "$WORKTREE" add -- "$REF" || {
    echo "place-confirmed-document: could not stage $REF" >&2
    exit 1
  }
  if ! git -C "$WORKTREE" diff --cached --quiet -- "$REF"; then
    git -C "$WORKTREE" \
      -c user.name="${TAKUMI_GIT_NAME:-takumi}" \
      -c user.email="${TAKUMI_GIT_EMAIL:-takumi@localhost}" \
      commit -q -m "docs: place the confirmed requirement document

The delivery worktree is cloned from the delivery repository, whose main may hold a
different document at $REF. The implementation step reads the file in its own
directory, so the confirmed one is placed here and committed with the delivery
(ledger #120)." -- "$REF" || {
      echo "place-confirmed-document: could not commit $REF" >&2
      exit 1
    }
  fi
fi

echo "placed the confirmed document at $REF (sha256:${DIGEST%"${DIGEST#???????}"}) and committed it"
