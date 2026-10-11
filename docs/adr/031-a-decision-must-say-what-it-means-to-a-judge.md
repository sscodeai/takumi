# ADR-031: A Decision Must Say What It Means To A Judge

- **Date**: 2026-10-05
- **Status**: Accepted (`JUDGE_DECISION_MODES` and `JUDGE_RELATION_VOCABULARY` in
  `packages/core/src/requirement-decisions.ts`; `checkedAs` on the `AMB-nnn` entry; the
  `DUPLICATE_MODES`/`MALFORMED_MODES`/`ROUNDING_MODES` tables in
  `extensions/judges/metamorphic-forge.sh`; the validator's refusals in
  `validateRequirementDocument`; tests in `packages/core/src/test/judge-vocabulary.test.ts`)
- **Related**: ADR-028 (a decision is only real if it is checked), ADR-025 (the confirmed requirement),
  ADR-027 (the bounded-choice confirmation, whose honest-limits section named this vocabulary as the
  bottleneck), ADR-030 (answering a failure), ADR-033 (the document declares its own world)

## Context

ADR-028 bound a decision to the check that exercises it (`decides: AMB-nnn`) and made the check's
expectation a function of the human's answer. What ADR-028 did NOT settle was what the answer MEANS.
The expectation was matched against the option's TEXT — normalised, but still a sentence — and the
forge's own documentation called that out as a maintenance cost shared by the document and the forge.

The first real end-to-end run showed what the cost actually is. The intake wrote, for the rounding
decision:

```
  - id: AMB-005
    question: "How is the one-decimal rounding of min, max and mean performed?"
    options:
      - "Round half up to one decimal place."
      ...
    default: "Round half up to one decimal place."
```

(`/tmp/i2-intake.log`, lines 142-149). The forge's rounding table wanted a token -- in the
employee/department world it was `Half-up, no currency printed`. "Round half up to one decimal place"
and "Half-up" describe the same behaviour, and the run was refused anyway: the option was outside
what the forge could match, and the forge treats an unmatched option as unmechanisable rather than
guessing (ADR-028, decision 3).

Two things were wrong with that. First, a human wrote a correct, readable sentence and the mechanism
rejected it, because the mechanism was reading prose. Second, the vocabulary existed in two places --
the validator that has to refuse a document before a human confirms it, and the shell forge that
actually implements the checks -- and nothing compared them.

## Decision

1. **Prose is for humans; `checkedAs` is what a judge acts on.** A decision that a mode-carrying
   relation exercises must carry `checkedAs: <mode>` on the `AMB-nnn` entry, beside `chosen`. The
   mode is a token drawn from a closed list, and it is what the judge builds its fixture and its
   expectation from. The prose `chosen` and `options` stay readable and stay the human's record; they
   are no longer what the machine matches on.

2. **The vocabulary lives in exactly two places, and a test keeps them equal.**
   `JUDGE_DECISION_MODES` in `packages/core/src/requirement-decisions.ts` is the validator's copy:

   ```ts
   export const JUDGE_DECISION_MODES: Record<string, readonly string[]> = {
     'duplicate-resolution': ['first-row', 'last-row', 'latest-start-date', 'merge', 'error'],
     'malformed-row-accounting': ['skip-count', 'skip-silent', 'stop-error'],
     'independent-aggregation': ['half-up', 'truncate'],
   };
   ```

   `extensions/judges/metamorphic-forge.sh` keeps the same three lists on one line each
   (`DUPLICATE_MODES="first-row last-row latest-start-date merge error"`, etc.).
   `packages/core/src/test/judge-vocabulary.test.ts` reads the forge, parses its `IMPLEMENTED=` and
   `*_MODES=` lines, and asserts they equal the TypeScript constants -- including that the intake
   prompt offers exactly the relations the validator accepts. A drift becomes a test failure instead
   of a document that passes the front door and is refused at acceptance, after the implementation
   has been paid for.

3. **The validator refuses a missing or unknown mode BEFORE a human confirms.** In
   `validateRequirementDocument`, a binding whose relation carries modes must find a `checkedAs` on
   the decision it settles:

   ```
   REL-003 settles AMB-002 with "duplicate-resolution", so AMB-002 must say what its answer MEANS
   to a judge: add checkedAs: <first-row | last-row | latest-start-date | merge | error> (prose
   alone is not checkable)
   ```

   and an unknown mode is refused with the implemented list named. The forge refuses the same two
   cases again at acceptance time
   (`the decision $2 is settled by $1, and the relation needs to know what its answer MEANS: give it
   "checkedAs: <$4>" — prose is for humans, and a judge that has to guess is a judge you cannot
   trust`). Defence in depth, the same way `requirementRef` is validated at both ends.

4. **A relation that checks a PROPERTY, not a meaning, carries no mode.** `row-order-invariance` and
   `additivity` check a property of the output and take no `checkedAs`; `decisionModesFor` returns
   undefined for them and the validator skips them. The coupling that IS checkable is checked: a
   `checkedAs: latest-start-date` with no `date` column is refused, because the judge would have
   nothing to order by.

## Consequences

- A decision that a judge cannot mechanise must be non-blocking, and the document has to say so in
  prose. AMB-004 in `docs/requirements/intake.yaml` ("In what order are the station lines printed?")
  is `blocking: false` and carries no `checkedAs`; the judge reports it as
  `# not mechanised (non-blocking decision): AMB-004 "ascending station id, byte-wise lexicographic"
  is exercised by no declared relation or anchor` and never as `ok`. That is the honest place for a
  criterion nothing can check — the alternative (a blocking decision with no meaning) is a refusal.
- The same behaviour can now be written in the document in whatever words the intake chooses; only
  the mode token is load-bearing. The first real green run's DEC-003 line reads
  `ok 9 - DEC-003 AMB-003 honoured: "half-up: round half away from zero" (checked by DIFF-001)`,
  where the option text is the document's own sentence and the `checkedAs: half-up` is what the
  judge matched.
- **The modes are a hand-written vocabulary in two languages, and the sync test is the only thing
  keeping them equal.** That is a real limit, not a solved problem. Adding a mode means editing the
  TypeScript constant, the forge's line, and (for a new relation) the intake prompt; the test fails
  until all of them agree, but nothing derives one from the other. When the two languages are shell
  and TypeScript, a generated constant is the direction this should move, and it has not moved yet.
- The vocabulary is also the ceiling on what a decision may say. An answer outside the list — "Ask
  the user at runtime", for the duplicate rule — is refused by the forge:
  `the decision AMB-002 chose "Ask the user at runtime", which the relation REL-003 cannot mechanise
  — this forge can decide "The row with the latest start_date wins" "First row wins" "Last row wins"
  "Treat it as an error": either change the option in the document or implement it in the forge, but
  a decision nobody can check is not a decision`. Widening the vocabulary is widening what the whole
  loop can accept, and it is deliberate work, not a configuration change.

## Evidence

- `packages/core/src/test/judge-vocabulary.test.ts` (3 tests): the forge implements exactly the
  relations the validator accepts, exactly the decision modes the validator accepts, and the intake
  prompt offers exactly the relations the validator accepts. These tests read
  `extensions/judges/metamorphic-forge.sh` and `extensions/skills/req-intake/prompts/intake.md` and
  compare them against `JUDGE_RELATION_VOCABULARY` / `JUDGE_DECISION_MODES`.
- `packages/core/src/test/judge-forge-decisions.test.ts` — `decisions: a checkedAs the forge cannot
  act on is refused, with the modes named` (asserts the refusal names the modes), `decisions: the
  judge refuses to guess a rounding rule the document never decides`,
  `decisions: a checkedAs written on the RELATION instead of the decision is refused`.
- The refusal, reproduced by deleting the `checkedAs: merge` line from a copy of
  `docs/requirements/intake.yaml` and running the real CLI:

  ```
  $ node apps/cli/dist/index.js requirement confirm docs/requirements/<the copy> --dry-run
  docs/requirements/<the copy>: the document does not hold together — 1 issue(s):
    REL-003 settles AMB-002 with "duplicate-resolution", so AMB-002 must say what its answer MEANS
    to a judge: add checkedAs: <first-row | last-row | latest-start-date | merge | error> (prose
    alone is not checkable)
  Nothing was written. Fix the document first (a decision that came from a failure must name one).
  EXIT=1
  ```

  (The closing line is a fixed suffix the command prints regardless of the issue; it is a wording
  wart, recorded here rather than smoothed over, and the refusal itself is the point.)
- The i7/i8 runs (`/tmp/i7-delivery.log`, `/tmp/i8-delivery.log`) carry the `DEC-001..DEC-004` lines
  the modes produce, each naming the option text and the relation that checked it.
