#!/usr/bin/env bash
# An OpenHands agent, as a takumi pilot agent command.
#
#     pilot:
#       agent:
#         command: /abs/path/to/examples/openhands-agent.sh
#         timeoutSeconds: 2700
#
# WHY a wrapper at all: takumi's agent seam is a COMMAND, not a model API (ADR-009). It
# starts this in the item's worktree with the item's identity and text in the environment,
# and the command's only obligations are: do the work, COMMIT it, leave the tree clean.
# OpenHands needs its own flags to run non-interactively, so this file is where that
# translation lives — in the operator's configuration, not inside takumi.
#
# WHAT TAKUMI PROVIDES (see apps/cli/src/run-command.ts):
#   TAKUMI_ITEM_ID, TAKUMI_ITEM_TITLE, TAKUMI_ITEM_BODY, TAKUMI_ITEM_URL,
#   TAKUMI_RUN_ID, TAKUMI_BRANCH, TAKUMI_ROUND
# The worktree is already the working directory.
#
# WHAT YOU PROVIDE (OpenHands' own configuration):
#   LLM_MODEL, LLM_BASE_URL, LLM_API_KEY   — e.g. an OpenAI-compatible endpoint.
#   OpenHands IGNORES these environment variables unless --override-with-envs is passed,
#   which is why it is here and not left to chance.
set -uo pipefail

: "${TAKUMI_ITEM_ID:?this command is started by takumi's pilot, which sets TAKUMI_ITEM_ID}"
: "${TAKUMI_ITEM_TITLE:?takumi must pass the work item's title; without it the agent has no task}"

export PATH="$HOME/.local/bin:$PATH"
export OPENHANDS_SUPPRESS_BANNER=1

# The task is composed from the BOARD's item, not from anything hardcoded here: the same
# wrapper serves every item.
read -r -d '' task <<EOF || true
Work item ${TAKUMI_ITEM_ID}: ${TAKUMI_ITEM_TITLE}

${TAKUMI_ITEM_BODY:-}

Rules for this worktree, which takumi enforces after you exit:
 1. Do the work here, in this repository, and nothing else.
 2. Verify it: run the test command the item names, and make it pass.
 3. COMMIT your work (git add the files that matter, then git commit). takumi never
    commits on your behalf, and a run with no commit is refused as a failed delivery.
 4. Leave the working tree CLEAN: anything you do not commit must be ignored by git
    (add it to .gitignore) or removed. takumi refuses to deliver a dirty tree.
 5. Do not push, and do not touch any remote. Delivery is takumi's job.
EOF

# --headless        : no UI, requires a task
# --override-with-envs: honour LLM_MODEL/LLM_BASE_URL/LLM_API_KEY (ignored otherwise)
# --always-approve  : no human is present to confirm actions; this is the explicit opt-in
#                     to unattended execution. See the report's security note: with no
#                     container runtime the agent runs as YOU, on this host.
exec openhands --headless --override-with-envs --always-approve -t "$task"
