# 058 — A delivery runs inside a boundary, and the boundary says what it does not close

Status: accepted (2026-10-12)

## Context

Bug #68 recorded the worst failure this project has had: a repair round's implementer left its
worktree and edited the platform that was judging it — including the judge itself. Three properties
combined, and the third was that **there was no sandbox at all**: the agent ran with the operator's
own write access to the whole host. The dispatch said the implementer should stay in its worktree;
nothing enforced it.

Two things in the tree claimed otherwise, and both were false:

- `packages/core/src/sandbox-unshare.ts` ran `unshare --user --map-root-user --net --mount --fork
  /bin/sh -c "cd <project> && <command>"` and described itself as "host filesystem write protection".
  It had **no filesystem isolation**: a write to a sibling directory, or to the platform repository,
  succeeded. Its `/etc` test was **vacuous** — this host mounts `/etc` read-only already, so the test
  measured the host, not the boundary.
- `docs/adr/026-a-forged-judge.md` said the judge/worktree separation "is a path property, not a
  permission", and the black-box design doc said real isolation "is not determined from this tree".

A sandbox that is claimed but not measured is worse than no sandbox: readers stop looking. This ADR
replaces the claim with a measured boundary, deletes the docstring rather than softening it, and
records the one thing the boundary does **not** close.

## Decision

**Every step shell command and every confined delivery agent runs inside an unprivileged mount-policy
boundary, the boundary is built from an explicit validated policy, and a run whose boundary cannot be
established is refused before its first step.**

### The mechanism

`unshare --user --map-root-user --net --pid --mount --propagation private --fork /bin/sh <script>
<root> <command>`, plus `chroot` (util-linux, invoked as programs by argv; no source is linked or
copied). The setup script builds a **path-mirroring root**: a private tmpfs, every allowed host path
bind-mounted at the same absolute path, then `chroot`. Mirroring is what keeps
`TAKUMI_PROJECT`/`TAKUMI_WORKTREE`/`TAKUMI_JUDGE_DIR` and a judge's own absolute paths valid, so the
real `extensions/judges/metamorphic-forge.sh` and the forged judge need **zero edits**.

The measured ordering matters, and the first plan was wrong about it:

- `mount -o remount,ro <tmpfs>` **fails** on this util-linux (`mount point not mounted or bad
  option`).
- `mount --bind $R $R && mount -o remount,ro,bind $R` seals the root, but only if it happens
  **before any submount exists** — a `--bind` of a tree with submounts hides them. So the root is
  created, every directory and `/dev` placeholder is made, the root is sealed, and only then are the
  read-only and read-write binds attached on top. They keep their own flags; the root stays read-only.
- `mount -t proc` needs `--pid`; `findmnt -no PROPAGATION /` inside reads `private`.

Read-write roots are exactly the delivery worktree and this run's own
`acceptance/<runId>` tree. The platform repository is **not** a root. A `judge_forge`/`acceptance`
harness reads the requirement document and the forge script as **read-only staged copies** at their
mirror paths, so those files are visible and writable to no one.

### The hardening this required

- **Private propagation** (`--propagation private` + `mount --make-rprivate /`) so no boundary mount
  can reach the operator's machine.
- **Curated `/dev`** (six nodes plus `/dev/fd`, `/dev/stdin`, `/dev/stdout`, `/dev/stderr` symlinks
  into the fresh `/proc`): a real judge uses process substitution, and without `/dev/fd` its own
  checks fail with `/dev/fd/63: No such file or directory`. Found by the S4 proof, not by reasoning.
- **Fresh `/proc` and `/pid`**, curated `/dev/shm` and `/tmp` tmpfs, `ulimit -c/-v/-t/-f`, and a
  private process group killed as a group on timeout.

### Fail-closed

`packages/core/src/sandbox-policy.ts` builds the policy from the run's facts and runs four pure
guards before any mount exists: **G1** no read-only root may contain the project (node lives in a
*sibling* of `workspaces`, so mirroring toolchain siblings is safe but mirroring `/srv/hermes` would
re-expose the platform); **G2** a read-write root must be the worktree or this run's judge tree; **G3**
only staged files may appear under the project root; **G4** a run that stages files may not be rooted
under a path the boundary masks with tmpfs. The boundary **self-tests** at every run from the inside
(root read-only, rw roots writable, platform invisible, requirement readable, `1.1.1.1:443`
unreachable, loopback up, tools resolve) and refuses by name (code 126) when it cannot be established.

The CLI preflight decides before the first agent step: a delivery run (one with a worktree) is
confined by default; when the boundary cannot be established the run is refused, named, audited, and
the runtime is never invoked. `--sandbox none` on a delivery run is refused; an unknown `--sandbox`
value is refused rather than silently defaulting.

### The escape hatch is human-only, loud, and recorded

`TAKUMI_UNSAFE_NO_SANDBOX=1` exists, and it is read from the **process environment and nothing else**:
no CLI flag, no `takumi.yaml` key, and no workflow step can set it, so an agent or a workflow step
cannot turn the boundary off for the run it is part of. It prints loudly, is recorded in the run
record's `sandbox` field as `none (unsafe override)`, and is written to the audit record.

### The delivery agent's tools

The Pi runtime runs **in-process** (`createAgentSession`), so there is no child process to wrap. It
uses the SDK's supported pattern: a confined task gets `noTools: 'builtin'` and `customTools` built
from the per-tool `operations` seam. `read`/`write`/`edit`/`ls`/`find` route through
`packages/core/src/sandbox-fs-ops.ts`, which resolves the real path of every target (and of its
nearest existing ancestor, for a new file) and refuses anything outside the roots — so a planted
symlink is refused, not followed. `bash` routes through the same `StepSandbox` as every other step
command. `grep` is **dropped by name** and the drop is recorded: its operations seam cannot contain the
ripgrep search, which is a host process.

## Named limitations — what this boundary does NOT close

These are stated as limits, not smoothed over. The sandbox is **not** fully closed.

1. **Network: the delivery AGENT keeps provider egress.** Step boundaries are network-free (fresh
   netns, loopback up). The delivery agent must reach the model provider's HTTPS API from the same
   process that runs its tools, and there is no rootless egress primitive here (no `slirp4netns`, no
   `veth` without root, and a host-local proxy is unreachable from a fresh netns). So the agent keeps
   the host network for its model calls while its **tools** are confined. Step boundaries being
   network-free is a tested property; the agent is not network-isolated, and this document does not
   say it is. The operator accepted this as the named exception (2026-10-12).
2. **In-process tools are trusted-adapter containment, not a kernel boundary.** `read`/`write`/`edit`/
   `ls`/`find` run in the host process; their containment is the realpath logic in
   `sandbox-fs-ops.ts`. A bug there is a hole. Only `bash` gets the kernel boundary.
3. **`grep` is not offered to a confined agent** (reason above), so a confined agent has fewer search
   tools than an unconfined one.
4. **A linked worktree's gitdir is not mounted.** A delivery worktree's `.git` file points into the
   platform repository's `.git/worktrees/…`, which is not a root, so `git` commands run *inside* the
   boundary on a linked worktree will not resolve. The engine's own `git` reads run on the host.
5. **A project root under `/tmp` cannot stage harness files.** The boundary mounts its own `/tmp`
   tmpfs; a staged read-only copy under it would be shadowed, so a run that stages files is refused
   when its project root is under `/tmp` (G4).
6. **A deliverable that calls `setsid` can still escape the group kill** (the same residual risk
   ADR-049 states). The `--pid` namespace plus `chroot` bound the blast radius; they do not remove the
   escape.
7. **`bubblewrap` and `docker` are not used.** `bubblewrap` is not installed (LGPL, usable only as an
   external binary the operator installs); `docker` is installed but unusable for uid 999. The
   mechanism is util-linux only.

## Licence

Takumi is MIT. The mechanism invokes util-linux (`unshare`, `chroot`) as programs by argv; no source
is copied or linked from util-linux, from orbi (AGPL/SUL), or from the Pi SDK's Gondolin example.

## Measurement record

- `packages/core/src/test/sandbox-boundary.test.ts` — A1 (a write outside the rw roots is denied, and
  the same command through `NoopSandbox` succeeds — non-vacuous), A2 (platform repository invisible
  and unwritable), A3 (staged requirement readable read-only and alone), A4 (no external network,
  loopback up), A5 (memory and CPU bounds), A6 (a backgrounded grandchild does not outlive the step),
  A8 (private propagation, no host leak), and the self-test refusals.
- `packages/core/src/test/sandbox-policy.test.ts` — G1–G4 and the mount-script shape.
- `packages/core/src/test/sandbox-fs-ops.test.ts` — containment incl. a symlink pointing out of the
  roots.
- `packages/core/src/test/sandbox-step-execution.test.ts` — the engine routes all four command sites
  through the seam; a refusal fails the step; without a boundary the helper is a passthrough (A9).
- `apps/cli/src/test/sandbox-preflight.test.ts` — the fail-closed refusal before the runtime (A7), the
  confinement of a real step, and the human-only override recorded as `none (unsafe override)`.
- `packages/core/src/test/sandbox-real-boundary.test.ts` — A10: the **real** metamorphic forge prints
  `JUDGE_FORGE: ok` inside the boundary, the judge it writes runs there, and the fixture delivery's own
  `run-tests.sh` passes there. This test found the missing `/dev/fd`.
- `runtimes/pi/src/test/confinement.test.ts` — the confined tool builder drops `grep`, reads/writes
  inside, and refuses an outside path and a symlink escape.
