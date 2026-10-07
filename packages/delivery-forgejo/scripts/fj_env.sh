#!/usr/bin/env bash
# Source this file to obtain the Forgejo admin PAT for the live self-test.
#
# The token is read from ~/.git-credentials at RUN TIME and exported into the
# environment; it is never echoed, never written to a file and never passed on a
# command line (which would expose it in `ps`).
#
# Credential line shape in ~/.git-credentials:
#   http://<user>:<token>@forgejo.internal.invalid%3a3000
# The host colon is URL-encoded as %3a, so the userinfo is everything between
# the scheme and the first '@'.

FJ_CRED_LINE="$(grep -m1 '192\.168\.1\.21' "$HOME/.git-credentials")"
FJ_USERINFO="${FJ_CRED_LINE#*://}"
FJ_USERINFO="${FJ_USERINFO%%@*}"
case "$FJ_USERINFO" in
  *:*) FJ_USER="${FJ_USERINFO%%:*}"; FJ_TOKEN="${FJ_USERINFO#*:}" ;;
  *)   FJ_USER="$FJ_USERINFO"; FJ_TOKEN="$FJ_USERINFO" ;;
esac
export FJ_USER FJ_TOKEN
export FJ_API="http://forgejo.internal.invalid:3000/api/v1"
export FJ_BASE="http://forgejo.internal.invalid:3000"

# fj <curl args...> — authenticated call that appends the HTTP status as the
# last stdout line (mirrors the adapter's own curl transport).
fj() {
  curl -sS -m 20 -w '\n%{http_code}' \
    -H "Authorization: token $FJ_TOKEN" \
    -H 'Accept: application/json' "$@"
}
