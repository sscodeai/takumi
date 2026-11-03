#!/usr/bin/env bash
# Is the delivery worktree ready to be judged? Two questions, both cheap, both answered here rather
# than at the end of the chain.
#
# WHY THIS EXISTS (ledger #106, #118). Both defects were found by the most expensive step available:
#
#   2026-10-29 (`wf-a46dd47e`): ci_config wrote .github/workflows/ci.yml, the implementer committed
#   everything else and left that one UNCOMMITTED. quality_gate passed (it runs tests, it does not read
#   git status), rule_review passed, judge_forge forged, artifact_acceptance passed 4/4 — and publish
#   refused at the very end. A whole implementation and a forged judge were spent proving a delivery
#   that `git status` answers in the first second.
#
#   2026-11-03 (`wf-0a7781cf`): the document declared `mutation.run: bash run-mutation.sh`, the file was
#   not in the worktree at the moment acceptance read it, and the judge aborted with "the mutation
#   command could not run (exit 127)". Run by hand in that same worktree immediately afterwards it
#   succeeds — 18 mutants, 0 survivors — so the run HAD produced it.
#
# So: a clean tree, and every entry point the document declares actually present. Neither is a
# substitute for the judge; both are what the judge would otherwise be the first to discover.
#
# Usage: worktree-ready.sh <requirement-file>
# Exit: 0 ready, 1 not ready (names what is wrong), 2 the inputs could not be read.
set -u

REQ="${1:-}"
[ -n "$REQ" ] || { echo "worktree-ready: needs the requirement document path" >&2; exit 2; }
[ -f "$REQ" ] || { echo "worktree-ready: the requirement document '$REQ' does not exist" >&2; exit 2; }

# --- 1. nothing left uncommitted -----------------------------------------------------------------
# The agent's boundary IS the commit, so an uncommitted file was never delivered. takumi must never
# `git add -A` here: a runner that commits for the agent launders an unfinished attempt.
left=$(git status --porcelain 2>&1) || {
  echo "worktree-ready: git status could not be read:" >&2
  printf '%s\n' "$left" >&2
  exit 2
}
if [ -n "$left" ]; then
  echo "the implementation left uncommitted change(s) — the agent's boundary IS the commit, so these were never delivered:" >&2
  printf '%s\n' "$left" | sed 's/^/  /' >&2
  echo "commit them (ci_config's pipeline file is written BEFORE the implementer commits, so it belongs in that commit), or delete what you did not mean to create." >&2
  exit 1
fi

# --- 2. every declared entry point exists --------------------------------------------------------
# `read_field <dotted-path>` prints the value at that path, or nothing.
#
# The path is DOTTED and means NESTING, because the document nests: `mutation.run` lives UNDER
# `deliverable:`, not at the top level (measured on the real document from `wf-0a7781cf`, where
# `mutation:` sits at two-space indent inside the deliverable block). A reader that only looked at
# top-level keys silently found nothing and the check passed while the file was missing — which is
# exactly the failure mode this whole script exists to prevent, so it must not have it either.
read_field() {
  awk -v path="$1" '
    function lead(s) { match(s, /^ */); return RLENGTH }
    function key(s) { k = s; sub(/^[ ]*/, "", k); sub(/:.*$/, "", k); return k }
    { sub(/\r$/, "") }
    BEGIN { n = split(path, want, "."); depth = 0; cur = 0 }
    # Blank and comment lines never change the path.
    /^[ ]*$/ { next }
    /^[ ]*#/ { next }
    {
      # A key line: how deep is it, and does it match the next element of the path?
      if ($0 ~ /^[ ]*[A-Za-z_][A-Za-z0-9_]*:/) {
        ind = lead($0)
        # Leaving a level: anything at or above the depth we were matching pops back.
        while (cur > 0 && ind <= wantind[cur]) cur = 0
        if (key($0) == want[cur + 1]) {
          cur++
          wantind[cur] = ind
          if (cur == n) {
            v = $0; sub(/^[ ]*[^:]*:[ ]*/, "", v)
            gsub(/^["'"'"']/, "", v); gsub(/["'"'"'][ ]*$/, "", v)
            print v; exit
          }
        }
      }
    }
  ' "$REQ"
}

# The script is the first argument after an interpreter word, when there is one.
script_of() {
  printf '%s\n' "$1" | awk '{
    for (i = 1; i <= NF; i++) if ($i ~ /^(bash|sh|python3?|node)$/) { print $(i + 1); exit }
  }'
}

missing=""
for key in deliverable.run deliverable.mutation.run; do
  cmd=$(read_field "$key")
  [ -n "$cmd" ] || continue
  script=$(script_of "$cmd")
  # No interpreter word (a bare command) or a template placeholder: nothing checkable here.
  [ -n "$script" ] || continue
  case "$script" in *'{'*) continue ;; esac
  if [ ! -f "$script" ]; then
    missing="${missing}  ${key}: ${cmd}  ->  '${script}' is not in the worktree
"
  fi
done

if [ -n "$missing" ]; then
  echo "every command the document declares must run, or the judge cannot check anything it promises:" >&2
  printf '%s' "$missing" >&2
  echo "create the missing file and commit it — a declared entry point that does not exist is a delivery that cannot be judged." >&2
  exit 1
fi

echo "the worktree is clean, and every entry point the document declares exists"
