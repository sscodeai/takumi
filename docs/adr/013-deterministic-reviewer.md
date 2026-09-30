# ADR-013: The Deterministic Reviewer (rules over the real change set)

- **Date**: 2026-09-19
- **Status**: Accepted (`reviewMode: 'rules'`, `packages/core/src/review-rules.ts`, `review.ts`)
- **Related**: ADR-006 (boards), ADR-007 (delivery), ADR-009 (the pilot), ADR-010 (metrics), ADR-011 (filing), ADR-012 (scoping)

## Context

The pilot had a complete review conveyor — rounds, `fix_needed`, a review bound to a frozen
head, `maxReviewRounds`, `awaiting-human` that burns no round — and **nothing on it**.

`reviewMode: checks-only` merged as soon as the checks were green; `reviewMode: label` waited
for a human; and the `deps.review` seam, the one place a real reviewer could stand, was
**never supplied by the CLI in production**. So the shipped behaviour was: review returns
`clean`, always. Two consequences, both real:

1. **A repository with no pipeline merged unverified.** "Green checks" of an empty list is
   indistinguishable from "checked".
2. **A pipeline can be satisfied by weakening the tests it runs.** An agent that deletes the
   failing test, adds `.skip`, or drops an assertion turns CI green while making the
   repository worse — and no CI can catch that, because CI is what is being gamed.

## Decision

### 1. A reviewer made of RULES, not a model

`runReviewRules(input, rules)` is a pure function: the change set in, findings out. No
network, no credentials, no token budget, no clock — so every rule is exhaustible by tests
and the reviewer's failure mode is a fact about the diff rather than a mood.

A model reviewer is a second opinion whose failure mode is "it said it was fine". It may
come later, behind the same seam, with the same fail-closed posture. It is not first because
the checks-only gap is not a subtlety that needs judgement: it is arithmetic about the diff.

### 2. Three severities, because "found something" is three different things

| Severity | Meaning | Verdict |
|---|---|---|
| `block` | a defect the AGENT must answer (it weakened a test; it can restore it) | `findings` → a fix round |
| `human` | a decision no machine may make and no agent may undo (a dependency bump, a CI tweak) — telling the agent to "fix" it would mean reverting legitimate work | `awaiting-human` → waits, no round burned, no merge |
| `note` | an observation that gates nothing | `clean` **with a note**, so it still reaches the board comment |

`ReviewOutcome.clean` gained an optional `note` for exactly that last case: an observation
is not a defect, and forcing it into `findings` would spend a fix round on work that may be
precisely what the item asked for ("write tests for X").

### 3. The rules of v1

- **`test-weakening/deleted`** — a test file present at the base is gone at the head.
- **`test-weakening/skipped`** — skip markers increased (`.skip`, `xit(`, `@Ignore`,
  `pytest.mark.skip`, `t.Skip(`, `SkipTest`, `xfail`, …).
- **`test-weakening/assertions-removed`** — the assertion-marker count dropped between the
  two sides of a file that exists in both. Deliberately a heuristic: it cannot prove a test
  still means what it meant, but losing assertions while gaining a green pipeline is the
  shape of the failure worth catching, and the finding is answerable rather than final.
- **`test-only-change`** (note by default) — nothing outside the tests changed. This is the
  ambiguous case: legitimate when the item IS the tests, the signature of a bought pipeline
  when it is not. A note puts the item title next to the fact; the operator can make it a
  `block` or `ignore` it. It is **not** added when a weakening finding already exists — that
  would be noise stacked on a defect.
- **`protected-path`** (`human`) — CI configuration, dependency manifests, the container
  build, and takumi's own configuration. A machine must not wave these through, and an agent
  must not "fix" a legitimate change by reverting it.

### 4. FAIL CLOSED is the whole point

A reviewer that cannot run must never be read as `clean`. `collectReviewInput` throws
`ProviderError('transport')` when git will not answer, when a revision is unreadable, or
when the change set exceeds a size no rule should judge. The delivery loop does not catch
it; the tick's outer handler records `retriable` and **nothing merges**. No new outcome was
invented for this — the throwing seam already existed and already had the right semantics.

The same rule covers expected absences: whether `git show <rev>:<path>` "failing" means the
file was absent is decided by the **recorded status**, never by the exit code. Reading an
exit code as absence would silently weaken every rule that reads content.

### 5. The reviewer is wired by the mode that promises it

`reviewMode: 'rules'` and a real reviewer are built together in the CLI, and an operator who
asks for the mode gets the gate. A mode that promises a gate and ships a rubber stamp is the
same class of defect as a configuration field nothing reads (the ledger's #10), and it was
the state of `deps.review` in production before this ADR.

`ReviewContext` gained `worktree` and `baseSha` for the same reason: a reviewer handed a list
of file names can say "the CI config changed" and not "this test lost three assertions", and
a reviewer that has to reconstruct the base elsewhere is a reviewer with a second source of
truth.

### 6. How an operator turns it on

```yaml
pilot:
  policy:
    reviewMode: rules          # checks-only | label | rules
    maxReviewRounds: 2         # how many times the agent may answer a finding
    reviewRules:               # all optional: absent means the defaults above
      forbidTestWeakening: true
      testOnlyChange: note     # note | block | ignore
      protectedPaths:          # ADDED to the defaults
        - '(^|/)infra/'
      # replaceProtectedPaths: true   # use ONLY the list above
      # testPathPatterns: ['_spec\\.rb$']  # ADDED to the defaults
```

Failing checks are still handled before the reviewer runs, so `rules` means "CI green AND
the change is what it claims to be". With `reviewMode: rules` on a repository that has no
pipeline at all, the reviewer is the only gate — which is strictly better than the previous
"empty check list counts as green".

## Consequences

- Unattended merging becomes defensible: the pipeline's verdict is checked against the change
  that produced it, and the one thing a green pipeline cannot see — its own proof being
  weakened — is now a blocking finding.
- An item whose delivery touches a protected path **stops** and waits for a person instead of
  merging or bouncing between the agent and the reviewer.
- Costs and limits, stated rather than discovered later:
  - the assertion count is marker-based, so a helper refactor can raise a finding the agent
    must answer (it is a fix round, not a permanent block);
  - test detection is path-based — a missed pattern means a missed finding, the same posture
    as CI itself, and extra patterns are configurable;
  - the reviewer reads git, so it needs the base object present (a full clone, not a shallow
    one);
  - a change set larger than the limit is refused rather than skimmed;
  - no model review yet. If a second opinion is added, it belongs behind the same seam, with
    the same fail-closed rule, and never as the only gate.
