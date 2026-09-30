# OpenHands as a takumi agent: spike report and integration decision

- **Date**: 2026-09-19
- **Scope**: prove OpenHands can be takumi's agent through an EXISTING seam, before any new
  abstraction (the Decision Gate in `docs/openhands-runtime-task.md`)
- **Verdict**: **Decision A — the existing seam is sufficient.** No core abstraction was
  added; the only core-adjacent change is the work item's text being passed to the agent
  command, which every real agent needs, not just OpenHands.

## 1. What the interface actually is (verified, not assumed)

| Fact | Value |
|---|---|
| Package | `openhands` 1.16.0 — "OpenHands CLI" (Python `==3.12.*`), depends on `openhands-sdk` 1.21.0 |
| Install | `uv tool install openhands --python 3.12` (installs `openhands` + `openhands-acp`) |
| Not this | `openhands-ai` (>=3.12,<3.14) is the full platform/GUI — a different package |
| Non-interactive entry | `openhands --headless -t "<task>"` (or `-f <file>`); `--headless` requires one of them |
| Approvals | `--always-approve` (a.k.a. `--yolo`) or `--llm-approve`; **without one, actions wait for a human** |
| LLM config | `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY` are **ignored unless `--override-with-envs`** is passed |
| Machine-readable events | `--headless --json` streams JSONL events |
| Working directory | the process's cwd — which is exactly the worktree takumi starts the command in |
| On completion | exit code 0 and a printed Conversation ID (resumable via `--resume <id>`) |
| Sandbox | Docker if available, otherwise the local host runtime |

**Docker is installed on this host but unusable** (`permission denied .../docker.sock`;
the `hermes` user is not in the `docker` group), so the runs below used the **local host
runtime**. Security consequence, stated plainly: the agent executed shell commands **as
`hermes`, on this host, with this host's environment** — no container boundary. That is
acceptable for a fixture repository and is a reason to want the container runtime (a
`docker` group membership or a rootless runtime) before pointing this at anything valuable.

## 2. Evidence

### 2.1 A real repo, a real commit

Task: "add `multiply(a, b)` to `calc.py`, add a unittest, run it, commit."

```
openhands --headless --override-with-envs --always-approve -t "<task>"
→ exit 0; "Ran 1 test ... OK"; created commit a0d0960; Conversation ID b87fd2bf…
```

The agent modified a real file, ran a real test, and produced a real git commit. It also
left `__pycache__/` **untracked** — see finding 2 below, which is the useful part.

### 2.2 A real takumi pilot tick with OpenHands as the agent

One `takumi pilot --once` on a fixture repository (real worktree, real base sha, board
seeded with a real task, agent = `examples/openhands-agent.sh`):

```
delivered OH-1: merged after 1 round(s)
  claim      OH-1 claimed by run b922fc00
  agent      round 1 finished; expecting a commit in /tmp/oh-pilot/worktrees/OH-1-b922fc00
  deliver    round 1: opened PR #1 push=plain head=61120ff546cd
  checks     none reported
  review     round 1: clean
  merge      PR #1 merged at 61120ff546cd (merge)
  transition OH-1 → merged
metrics: ticks=1, last=delivered

worktree /tmp/oh-pilot/worktrees/OH-1-b922fc00:
  c94c98d Add multiply(a, b) with unittest and gitignore     ← the agent's commit
  61120ff chore: initial fixture
  git status --porcelain → (empty: the tree is clean)
```

The agent read the task from the environment, added the function, added
`test_calc.py`, added `.gitignore` for `__pycache__/`, ran the test, and committed. takumi
selected the item, cut the worktree, ran the agent, drove the loop, and wrote the board
state back.

**[Honest limit of this run] The delivery adapter was `fake`** — the in-memory simulator
whose head is a configured value. That is why the events above say
`head=61120ff546cd`, the **base** sha, rather than the agent's `c94c98d`: the delivery step
was exercised structurally, not against a real host. Everything about the AGENT seam is
real; the DELIVERY claim in this run is not, and no report may imply otherwise. Closing
that gap is a delivery-side item (`deliveries/git`, still on the roadmap), not an OpenHands
item.

## 3. Findings (what the spike was for)

1. **The pilot did not tell the agent what to do.** The agent command received only the
   item's *identity* (`TAKUMI_ITEM_ID`, `TAKUMI_RUN_ID`, `TAKUMI_BRANCH`, `TAKUMI_ROUND`).
   A real agent — a command with no board access — was handed a task it could not read.
   **Fixed**: `TAKUMI_ITEM_TITLE`, `TAKUMI_ITEM_BODY`, `TAKUMI_ITEM_URL` are now passed,
   with a test asserting the child receives them.

2. **The dirty-tree guard is load-bearing, and the task text is what satisfies it.** The
   first smoke left `__pycache__/` untracked; every delivery adapter refuses that
   (`git status --porcelain` non-empty → "the worktree has uncommitted changes; the runner
   never commits them"). In the pilot run the agent added `.gitignore` **because the task
   text told it to leave the tree clean**. So the integration contract is three-sided:
   the agent commits, the agent keeps the tree clean, and takumi refuses otherwise. An
   operator who writes a sloppy task text gets a blocked item — correctly.

3. **The fake board could not describe real work.** Its demo items had hardcoded titles
   ("A ready item (the fake board is a demo)"), so a real agent had nothing to do.
   **Fixed**: the fake board accepts seeded items as JSON, validated fail-closed against
   the six states.

4. **False completion is already impossible at the pilot seam** — and cannot be tested at
   the runtime seam. `delivery-loop` / the delivery adapters refuse a branch whose HEAD is
   still the frozen base, and `packages/core/src/test/pilot.test.ts` already asserts "an
   agent that commits nothing is a blocked precondition, not a silent idle". The runtime
   contract suite (`contract.ts`) does **not** cover this and structurally cannot: it
   asserts events, status, usage and artifacts, and knows nothing about git — a session can
   report `completed` without ever committing. So a dedicated runtime adapter must be
   paired with a pilot-level test, never trusted on its own.

5. **`cli:<command>` can bridge OpenHands only through a wrapper.** The bridge appends the
   task as the command's last argument, and OpenHands needs its own flags around it
   (`--headless --override-with-envs --always-approve -t <task>`), so the bridge would call
   `openhands "<task>"`, which is not a valid invocation. A one-line wrapper (as
   `examples/openhands-agent.sh`) resolves it with zero core changes. The workflow/loop
   seam was **not** exercised in this spike; the pilot seam — where the invariants live —
   was.

## 4. Decision

**A — the existing seam is sufficient.** Delivered as: `examples/openhands-agent.sh`
(configuration, not core), this report (compatibility verification), the item-text change
plus tests, and the fake-board seeding option. No `runtimes/openhands` package, no new port,
no core interface change.

OpenHands **owns**: one execution session, its reasoning loop, its tools, its sandbox.
takumi **still owns**: the workflow, board and delivery state, scheduling, retry semantics,
idempotency, slot locking, human approval, quality gates, verification, and every delivery
transition.

**What would justify Decision B later** (a dedicated `runtimes/openhands` adapter): usage
and artifacts. `openhands --headless --json` streams JSONL events, which is where token
cost, tool calls and produced artifacts live — the runtime port has `getUsage`,
`getArtifacts` and `getStatus` today and the pilot path cannot reach them. That is a real,
concrete gain (ADR-010's metrics go from tick counters to per-task cost), and it is a
separate slice with its own contract tests.

## 5. Invariants, confirmed

- [x] takumi still owns delivery state — OpenHands never touched the board.
- [x] takumi still owns retries — retries are TRANSPORT-only, in the pilot's wrapper.
- [x] takumi still owns verification — the review bound to a frozen head, the merge of the
      reviewed head only.
- [x] takumi still owns human gates — `reviewMode` decides, not the agent.
- [x] the agent boundary remains a Git commit: the run above is delivered *because* a commit
      existed, and a run with no commit is a blocked precondition (tested).
- [x] OpenHands cannot mark a delivery DONE: it has no path to board or delivery state.

## 6. Remaining limitations

- The delivery step in the pilot run above was simulated (`deliveries/fake`); **no real
  remote was pushed to** in this spike. `deliveries/git` (bare remote, no review surface) is
  the missing piece.
- The workflow/loop `cli:` seam was not exercised.
- No container boundary: the agent ran as the host user, unsandboxed (Docker unusable here).
- OpenHands' `--json` event stream is not consumed yet, so no per-task usage or artifacts.
- Nothing here was run against a board adapter with a real host (GitHub/GitLab) yet.
