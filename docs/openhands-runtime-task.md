# Task: Integrate OpenHands as a Takumi Agent Runtime

> Source: a ChatGPT-authored task prompt shared by Moon (2026-09-19), archived here in
> English per the repository's documentation language rule. Sections marked
> **[repo note]** were added by the takumi agent after reading the codebase — they are the
> places where the original prompt assumed something the repository does not (yet) say.

## Task

You are working on the Takumi repository.

Your goal is to add OpenHands as an execution runtime, while preserving Takumi's existing
architecture and invariants.

This is NOT a request to redesign Takumi around OpenHands.

OpenHands must be treated as an external execution engine behind the existing
`AgentRuntimeAdapter` boundary.

---

## 0. Core architectural rule

The ownership boundary is:

**Takumi owns**

- workflow
- board / delivery state
- scheduling
- retry semantics
- idempotency
- slot locking
- human approval
- quality gates
- verification
- evidence / audit
- delivery transitions

**OpenHands owns**

- one agent execution session
- agent reasoning loop
- tools
- shell / filesystem operations
- execution environment / sandbox
- session-local execution state

In short: **Takumi owns the software-engineering lifecycle. OpenHands owns an execution
session.**

OpenHands MUST NOT become a source of truth for delivery state. An OpenHands "completed"
response MUST NOT directly mean Takumi "DONE".

---

## 1. Read before changing code

Before implementation:

1. Inspect ADR-002 and the existing `AgentRuntimeAdapter`.
2. Inspect `runtimes/pi`, `runtimes/deepseek`, `resolveRuntime()`, and the existing
   `cli:<command>` runtime bridge.
3. Inspect ADR-009 / pilot execution semantics.
4. Inspect worktree lifecycle, commit boundary, retry classification, cancellation,
   timeout handling, artifact collection, and the runtime contract tests.

Do NOT start coding before understanding these boundaries. Produce a short architecture
note describing how OpenHands fits the existing contracts.

**[repo note] Exact locations, so this step costs minutes rather than an hour:**

| Thing | Where |
|---|---|
| Runtime port (ADR-002) | `packages/core/src/runtime.ts` — `run(task) → AsyncIterable<AgentEvent>`, `cancel`, `getStatus`, `getUsage`, `getArtifacts` |
| Runtime contract suite | `packages/core/src/contract.ts` — `runRuntimeContractSuite()` (event ordering, terminal status, usage, artifacts) |
| Runtime registry | `apps/cli/src/commands.ts` — `resolveRuntime(id, sandbox)`: `fake`, `pi`, `deepseek`, `cli:<command>` |
| A runtime that needs no credentials | `packages/core/src/test-utils.ts` — `TestRuntime` |
| Pilot agent seam (ADR-009) | `apps/cli/src/run-command.ts` — `pilot.agent.command` starts a child process in the worktree; exit code → classification; `SIGTERM` then `SIGKILL` on shutdown |
| Commit boundary | `packages/core/src/delivery-loop.ts` — an agent that leaves the worktree dirty ends the delivery as a `blocked` precondition; the review is bound to a frozen `headSha` |
| Worktrees | `packages/core/src/worktree.ts` — one worktree per item, cut from a frozen base sha; never deleted with uncommitted work |
| Delivery semantics (ADR-007) | `docs/adr/007-delivery-provider.md` |
| Pilot (ADR-009) | `docs/adr/009-pilot.md` |
| Newest ADRs | `docs/adr/010` (metrics/pacing), `011` (filing work), `012` (scoping a tick) |
| Defect-ledger convention | `docs/bugs-fixed.md` — a shipped defect gets its own `fix(scope):` commit and a four-part ledger row |

**[repo note] The one structural fact the original prompt does not say:** there are **two
different agent seams**, and they are not the same door.

1. **The runtime registry** (`resolveRuntime`, including `cli:<command>`) is used by the
   workflow/loop path — `takumi run`, `takumi loop`.
2. **The pilot** (ADR-009, the delivery lifecycle: select → slot lock → worktree → agent →
   deliver → review → board state) takes `pilot.agent.command`, a **raw command string**. It
   does not go through `resolveRuntime` at all.

So "OpenHands works through `cli:`" proves the *workflow* seam, not the *delivery* seam. The
result worth having is proof in the **pilot**, because that is where the commit boundary,
retry classification, slot lock and human review actually live. See §2.

---

## 2. First objective: integration spike

Before creating a dedicated runtime, determine whether OpenHands can already execute through
the existing seams:

- **`pilot.agent.command`** (the delivery lifecycle) — preferred, because that is where the
  invariants are enforced;
- **`cli:<command>`** (the workflow/loop path) — also worth proving, since the runtime
  registry is what a first-class adapter would plug into.

Test a real OpenHands headless / non-interactive execution against a temporary Takumi
worktree.

The spike MUST verify:

```
Takumi task
    ↓
existing seam (pilot agent command, or cli: runtime)
    ↓
OpenHands
    ↓
modify repository
    ↓
run tests
    ↓
create Git commit
    ↓
return control
    ↓
Takumi verifies commit
```

Verify explicitly: task/prompt transport · working-directory behaviour · non-interactive
execution · stdout/stderr behaviour · exit behaviour · timeout · cancellation · filesystem
modifications · Git commit creation · artifact accessibility · failure behaviour.

Do not assume OpenHands CLI semantics. Verify them against the actual installed / current
OpenHands interface. Record the result as an artifact.

---

## 3. Decision Gate

After the spike, make one of two decisions.

**A — the existing seam is sufficient.** If the existing CLI seam can satisfy the Takumi
runtime contract without OpenHands-specific behaviour: DO NOT create unnecessary
abstractions. Add only configuration, documentation, tests, an example, and compatibility
verification. Prefer the smallest implementation.

**B — a dedicated adapter is justified.** Only if OpenHands-specific lifecycle / event /
session behaviour provides concrete value that cannot cleanly pass through the CLI seam:
implement `runtimes/openhands` behind the existing `AgentRuntimeAdapter`. Do NOT modify core
interfaces merely to mirror OpenHands APIs.

---

## 4. OpenHands adapter contract (only if B)

Normalize OpenHands semantics into Takumi semantics:

```
OpenHands native events/results → OpenHandsRuntimeAdapter → Takumi AgentEvent / RuntimeResult
```

Takumi core MUST NOT know: OpenHands exit-code conventions, session ids, internal event
names, container implementation, or OpenHands-specific retry semantics. Those belong inside
the adapter.

Support the existing runtime capabilities where applicable: `run(task)`, `cancel`,
`getStatus`, `getUsage`, `getArtifacts`, streaming events. Use capability negotiation for
optional features. Do not fake unsupported capabilities.

---

## 5. Hard invariant: agent boundary = Git commit

A successful agent execution MUST leave a Git commit in the assigned Takumi worktree.

```
Agent execution → Git commit exists → Takumi verification → tests/evidence/gates → candidate delivery transition
```

This invariant MUST remain true: **agent output ≠ Takumi completion.** Takumi MUST NEVER
silently create the agent's commit on behalf of OpenHands. If the agent claims success but no
valid commit exists: execution result = NOT successful; classify it according to the existing
Takumi failure model.

**[repo note] Where this stands today, honestly:**

- The **dirty worktree** case is already refused (`blocked` precondition) — an agent that
  leaves uncommitted changes cannot pass.
- The **"no commit at all"** case is already covered at the PILOT seam: the delivery adapters
  refuse a branch whose HEAD is still the frozen base, and
  `packages/core/src/test/pilot.test.ts` asserts "an agent that commits nothing is a blocked
  precondition, not a silent idle".
- It is **not** covered by the runtime contract suite (`contract.ts`), and structurally cannot
  be: that suite asserts event ordering, terminal status, usage and artifacts, and knows
  nothing about git — its happy path requires `status = completed`, which a session can reach
  without ever committing. So a dedicated runtime adapter must be paired with a pilot-level
  test; the runtime suite must never be read as proof of the commit invariant.
  (Corrected after reading `pilot.test.ts` during the spike — see
  `docs/openhands-spike-report.md`.)
- Therefore the §9 "false completion" case must be asserted **where the invariant lives**
  (the pilot / delivery-loop seam). It is already asserted there for the existing runtimes —
  what this task owes is the same assertion for whatever path OpenHands takes, and no claim
  that the runtime suite covers it.

---

## 6. Preserve failure ownership

Normalize failures into the existing Takumi classifications. At minimum distinguish:
SUCCESS · BLOCKED / EXECUTION_FAILURE · TRANSPORT_FAILURE · TIMEOUT · CANCELLED.

Do NOT blindly map `exit 0 = delivery success` and `exit != 0 = permanent failure`.
Exit / process / session semantics must be interpreted by the adapter. The existing Takumi
retry policy remains authoritative. OpenHands MUST NOT introduce an independent outer retry
loop that conflicts with Takumi scheduling.

**[repo note] The pilot's existing classification (`apps/cli/src/run-command.ts`), which the
adapter must feed rather than replace:**

- exit `0` → the agent is expected to have committed; the loop then owns everything after it.
- non-zero exit → the item is **blocked for a human** (no silent retry).
- killed / timed out / command missing → `transport` → the next tick retries.
- retries that do happen are TRANSPORT-only, and the retry wrapper emits only
  `agent.retry` — the loop already emits `agent.started` / `agent.finished`, and emitting
  those twice was a real defect once (`docs/bugs-fixed.md`: "two mechanisms, one effect").

---

## 7. Do not give OpenHands these responsibilities

OpenHands MUST NOT: mutate board state directly · transition delivery state · own scheduling ·
own retry policy · own slot locking · decide human approval · bypass quality gates · mark
delivery DONE · become Takumi's persistence layer · become Takumi's workflow engine.

No OpenHands event may directly trigger `delivery = DONE` without Takumi verification.

---

## 8. Workspace contract

For phase 1, prefer:

```
Takumi-created host worktree
        ↓
OpenHands executes inside it
```

Do NOT introduce remote / container workspace synchronization unless required.

However, document the future requirement for a **Workspace Accessibility Contract** covering
at minimum: workspace identity · base revision · execution access · verification access · SCM
access · commit visibility · artifact visibility.

A future remote OpenHands runtime must preserve:

```
OpenHands commit → visible to Takumi → Takumi independently verifies it
```

Do NOT solve this future problem prematurely.

---

## 9. Contract tests

OpenHands integration MUST pass the same behavioural runtime contract as other runtimes
where capabilities overlap. Create / extend contract tests for:

| Case | Setup | Expected |
|---|---|---|
| Success | task → modify file → test → commit → return | Takumi observes the commit |
| **False completion** | agent reports completion but produces no commit | Takumi rejects completion |
| Test failure | agent produces code/commit but verification fails | delivery does not become DONE |
| Timeout | execution exceeds the configured timeout | cancel/terminate → classify TIMEOUT/transport per the existing contract → no false completion |
| Cancellation | Takumi cancels execution | OpenHands stops → CANCELLED → no delivery transition |
| Agent failure | OpenHands fails internally | normalised Takumi failure → evidence retained → no silent fallback |

---

## 10. Real-runtime E2E

After unit / contract tests, execute ONE minimal real OpenHands E2E against a tiny fixture
repository. Example task: add a function `sum(a, b)`, add tests, run them, commit the change.

Acceptance criteria:

- [ ] Real OpenHands process/session executed
- [ ] Real repository modified
- [ ] Tests actually executed
- [ ] Git commit actually created
- [ ] Takumi detected the commit
- [ ] Takumi independently verified the result
- [ ] Runtime events/evidence persisted
- [ ] No board state was directly mutated by OpenHands
- [ ] No delivery state was directly mutated by OpenHands

This must not be a mocked E2E.

---

## 11. Architecture constraints

Do NOT: redesign Takumi · introduce another workflow engine · another scheduler · another
state database · duplicate OpenHands internals · duplicate existing Takumi runtime
abstractions · couple Takumi core to OpenHands types · add speculative abstractions · add a
Web UI for this feature · implement GitHub/Jira/board changes · implement remote OpenHands
server integration unless required for the minimal contract · weaken existing tests.

Prefer: existing abstraction + small adapter + contract tests + one real E2E — over new
infrastructure.

**[repo note] Repository conventions this work must follow** (not in the original prompt):

- TypeScript, ESM, `node:test`; **zero new dependencies** unless unavoidable.
- English only in code, comments, docs and commit messages.
- One logical change per commit; a defect found on the way gets its **own** `fix(scope):`
  commit and a row in `docs/bugs-fixed.md` (never folded into a `feat`).
- Never rewrite history; never `--force` anything.
- No "tests pass" without the command and its output; a claim that is not observed is
  reported as unverified.
- Tests must be offline (injected transports / recorded runners); no network, no credentials.
- Do not use real `sleep` in tests — inject the clock/sleep seam.

---

## 12. Required final report

- **Architecture** — where OpenHands sits; what Takumi owns; what OpenHands owns.
- **Integration decision** — CLI seam sufficient, or dedicated adapter required, with the
  evidence that decided it.
- **Files changed** — every meaningful file.
- **Tests** — exact commands and results. Do not say "tests pass" without showing what ran.
- **Real E2E** — task, runtime, workspace, commit SHA, tests executed, result, evidence
  location.
- **Invariants** — explicitly confirm: Takumi still owns delivery state · retries ·
  verification · human gates; the agent boundary remains a Git commit; OpenHands cannot mark
  delivery DONE.
- **Remaining limitations** — state them explicitly.

## Definition of Done

This task is DONE only when:

1. OpenHands has been exercised for real.
2. Its correct architectural boundary has been demonstrated.
3. Existing Takumi invariants remain intact.
4. Runtime contract behaviour is tested.
5. **False completion is impossible through this integration.**
6. A real commit produced through OpenHands is independently observed / verified by Takumi.
7. No unnecessary OpenHands-specific architecture leaked into Takumi core.

Do not optimise for feature count. Optimise for proving: **OpenHands can be replaced
tomorrow without changing Takumi's software-engineering semantics.**
