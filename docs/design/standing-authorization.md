# A standing authorization: signed once, auditable afterwards (design)

Status: v1 (pin-only) is IMPLEMENTED and green — `packages/core/src/standing-authorization.ts`, the
`--authorization` path in `apps/cli/src/requirement-command.ts`, and ADR-045. §12 records the wider,
SELECTABLE scope — a family of documents by glob — which is now implemented as well. Sections 1–11 are
the design record for the operator; §12 is the one place the shipped shape and this design are reconciled.

Related: ADR-025 (a confirmed requirement and an acceptance bound to it), ADR-027 (a bounded-choice
confirmation), ADR-028 (a decision is only real if it is checked), ADR-029 (the failure comes back),
ADR-030 (answering a failure), ADR-031 (a decision must say what it means to a judge), ADR-032 (creating
a protected path is not changing one), ADR-034 (a refused delivery is repaired before it is returned),
ADR-036 (the confirmation is a checklist with a budget), ADR-038 (the check itself can be wrong). The run
record this design extends is `packages/core/src/run-record.ts`, added on branch `feat/run-record` (tip
`1f31243`) and not yet covered by an ADR.

## What is being added, and why

Today a run is bound to a requirement document that a human confirmed interactively (ADR-025, ADR-027),
and a NON-TTY confirmation is refused outright (`apps/cli/src/requirement-command.ts`, the
`if (!isTTY)` branch: *"a requirement confirmation must be interactive (stdin is not a TTY)"*). That
refusal is deliberate and it stays. But it means a person must be at the keyboard twice per run: to
write and confirm the requirement, and to adjudicate a failure afterwards (ADR-029, ADR-030, ADR-038).
The chain cannot run unattended while that is true.

This design adds the second way to produce the same token — a **standing authorization**: a human signs,
once, a committed policy that says which requirement documents, and which classes of decision inside
them, may be confirmed by the document's OWN default options without a person at the keyboard. The
confirmation still happens; the digest is still the token; the acceptance still binds to it (ADR-025).
What changes is who wrote the `chosen:` lines, and what the record says about it.

The invariant this must not break is ADR-025/ADR-027's: **the human gives the criteria and the machine
implements.** A standing authorization is the human giving the criteria in advance, for a bounded
family of documents, in a signed artefact — it is not a machine inventing criteria, and it is not a
rubber stamp on the front door.

## 1. What a standing authorization IS

A committed YAML file, `docs/authorizations/<SA-nnn>.yaml`, in the same family as the requirement
documents: hand-written, hashable, and the human's artefact.

```yaml
id: SA-001
signedBy: "moon"                       # git config user.name at signing; a NAME, not an identity (ADR-018)
signedAt: "2026-10-11T00:00:00Z"
expiresAt: "2026-11-11T00:00:00Z"      # required; an authorization that never expires is refused
revoked: false                         # set true (in a later commit) to revoke; the commit is the record
reason: "unattended intake for the station-summary family"
scope:
  documents:                           # which requirement documents this may confirm
    - "docs/requirements/intake.yaml"
    - "docs/requirements/poc-*.yaml"
  decisions:                           # which CLASSES it may default, and with which policy
    - class: duplicate-resolution
      policy: document-default
    - class: malformed-row-accounting
      policy: document-default
    - class: independent-aggregation
      policy: document-default
    - class: unmechanised              # a non-blocking decision no declared check exercises
      policy: document-default
  failures:
    - class: implementation-changes    # the ONLY failure closure it may act on (see §7)
      maxRounds: 1                     # 1..5, the same cap ADR-034 puts on a repair budget
```

- **The class vocabulary is the project's own.** `class` is a relation kind from
  `JUDGE_RELATION_VOCABULARY` (`packages/core/src/requirement-decisions.ts`), or the literal
  `unmechanised` for a decision no declared check exercises (which must be non-blocking — the validator
  already refuses a blocking decision nothing checks, ADR-028). A class outside that vocabulary is
  refused at load, the same way a document naming an unimplemented relation is refused (ADR-031).
- **The policy vocabulary is one word.** `document-default` means: accept the decision's own `default:`
  as its answer. There is no second policy in this design, and no policy that invents an answer. A
  decision with no `default:` cannot be licensed by it — a default is an argument, not an absence
  (ADR-036), and where there is no argument a human makes one.
- **It lives in a committed file, and the signing act is a commit.** The design does NOT grow a
  signature verifier. What binds is (a) the authorization's own digest, computed by the SAME
  `requirementDigest` canonicalisation the requirement documents use (CRLF→LF, trailing whitespace
  stripped — `packages/core/src/review-digest.ts:70`), so there is one hash function and one notion of
  "the same text", and (b) the git history, which is where a `git commit -S` signature would live if
  the operator wants one. `signedBy` is a name, not an identity (ADR-018); the honest statement is that
  the file digest plus the commit is what a later reader checks, and verifying the signature is out of
  band (§10).
- **Revocation is a commit too.** `revoked: true`, a deleted file, or an `expiresAt` in the past — a run
  or a confirmation refuses each by name. Because the file is committed, revocation is as auditable as
  the grant.
- **An authorization may only NARROW the licensable set, never widen it.** The licensable set is fixed
  in code (§4); the authorization is a filter over it. A field that would add to it — `allowProtectedPaths`,
  `anyDecision`, `override` — is refused at load, by name. This is what makes §4 a rule rather than a
  list somebody maintains.

### How it binds to the digest machinery

A run references it exactly the way it references a confirmation today:

```
takumi run --requirement docs/requirements/intake.yaml --authorization docs/authorizations/SA-001.yaml
takumi run --requirement docs/requirements/intake.yaml \
           --authorization docs/authorizations/SA-001.yaml@sha256:<digest>   # optional pin
```

The `@digest` form is optional; when it is given, a mismatch is refused by name with both digests and
the ref — the same "refused by name" shape as ADR-025's *"is not the one that was confirmed"*. When it
is omitted the run reads the file and records its digest.

The confirmation cites it in the document's `confirmation:` block, which ADR-027 already writes:

```yaml
confirmation:
  by: "moon"                                     # the SIGNER, not the process that ran the command
  at: "2026-10-11T09:17:13.940Z"
  method: standing-authorization                 # was: bounded-choice
  authorization: "docs/authorizations/SA-001.yaml@sha256:<digest>"
  defaulted: [AMB-001, AMB-003]                  # which answers nobody looked at
```

The token is unchanged: it is the digest of the document the command just wrote, and it is what the
acceptance binds to (ADR-025). The authorization does not touch that binding. What it does is let a
non-interactive invocation produce the document that hashes to it, and say so in the block.

## 2. What it may license

`takumi requirement confirm <ref> --authorization <ref>` is permitted ONLY when, for EVERY open
decision in the document, all of the following hold:

1. the document path matches `scope.documents`;
2. the decision's class (the relation kind that settles it, via `decides:`; or `unmechanised`) is in
   `scope.decisions`, and that class has a policy;
3. the policy resolves to an answer: `document-default` requires the decision to carry a `default:`
   (which the validator already guarantees is one of its own options);
4. the decision is not caught by any rule in §4;
5. every open `feedback:` entry is licensed too — its closure class is `implementation-changes` and in
   `scope.failures` (§7). A document carrying a failure the authorization does not cover is not
   confirmable.

When all five hold, the command writes, for each decision with no `chosen:` yet, `chosen: <its own
default>`, appends the `confirmation:` block above, recomputes the digest and prints the token — the
same token an interactive confirmation would print for the same text.

Two deliberate narrowings:

- **It fills blanks; it never overwrites an answer.** A decision that already carries a `chosen:` is a
  human's answer and is left exactly as it is. The authorization has no path that rewrites a recorded
  answer.
- **It is all-or-nothing.** As in ADR-027's rule 3, nothing is written unless the last check passes; a
  document that fails any of the five conditions is left byte-identical and prints no token.

## 3. What it may NEVER license (fail-closed, as a rule)

**The rule: a standing authorization licenses an ANSWER THE DOCUMENT ALREADY OFFERS; it never licenses a
CHANGE THE DOCUMENT DOES NOT CONTAIN.**

The complete set of writes it permits is therefore: (a) `chosen:` filled from the decision's own
`default:`, (b) the `confirmation:` block, and (c) a `feedback:` closure of kind `implementation-changes`
(§7). Anything else is a refusal, and the refusal is structural rather than a list of forbidden cases:

- **The deliverable CONTRACT is never touched.** The authorization never writes the `deliverable:`
  block — `relations`, `differential`, `scenarios`, `input_format`, `output_format`, `mutation`, `run`.
  Choosing inside the contract is licensable; changing the contract is not. This is the same reason
  ADR-028 makes a blocking decision no check exercises a refusal rather than a warning: a contract
  nobody signed is not a contract.
- **The protected paths are never touched, ever.** A change to CI configuration
  (`.github/workflows/`, `.gitlab-ci.yml`), a dependency manifest (`package.json`,
  `pnpm-lock.yaml`, `package-lock.json`, `go.mod`/`go.sum`, `requirements*.txt`, `pyproject.toml`,
  `pom.xml`, `build.gradle*`, `Cargo.toml`/`Cargo.lock`), a container build (`Dockerfile*`), or
  takumi's own configuration (`takumi.yaml`, `.takumi/`) is a `human` finding in `rule_review`
  (`packages/core/src/review-rules.ts`, `DEFAULT_PROTECTED_PATTERNS`; ADR-032). **An authorization never
  lowers a protected path's severity and never licenses a delivery past one.** The design extends the
  protected set with `docs/authorizations/` — a run may never author, edit or revoke its own
  authorization — and that extension is the reason the rule is stated as a rule: the authorization's
  scope is over decisions in a requirement document, and a repository write outside that is not a
  decision, so it is out of scope by construction.
- **Any decision that changes the deliverable contract rather than choosing inside it.** If the right
  answer is not among a decision's own options, the answer needs a widened option list (ADR-030's honest
  limit) — a human's edit. The authorization has no field for widening options.
- **Anything the document marks as requiring a human.** A decision carrying `human: true` (proposed
  here as a new field on the `AMB-nnn` entry, extending ADR-027's decision block), and any blocking
  decision with no `default:` — which the front door already refuses to confirm without a human.
- **Anything outside the scope.** A document path not in `scope.documents`, a class not in
  `scope.decisions`, a failure class other than `implementation-changes`, an `expiresAt` in the past, a
  `revoked: true`.
- **The other two failure closures, and the legacy one.** `answer-wrong`, `check-at-fault` and
  `addressed` are not licensable classes; an authorization naming any of them is refused at load (§7).

## 4. The audit trail: telling a human's confirmation from a defaulted one

The field that carries it is **`requirement.confirmation`**: the run record's existing `requirement`
field (`packages/core/src/run-record.ts`, currently `{ ref, digest } | null`) is extended to
`{ ref, digest, confirmation }`. Keeping the confirmation INSIDE the requirement binding is deliberate —
it makes it impossible to read which document a run was bound to without also reading HOW it was
confirmed. (A sibling top-level `authorization` field was rejected: `null` there would be
indistinguishable from "forgotten", which is the same reason ADR-025's `NO_REQUIREMENT` is a real value
rather than an absent field.)

```jsonc
"requirement": {
  "ref": "docs/requirements/intake.yaml",
  "digest": "…",
  "confirmation": {
    "mode": "interactive" | "standing-authorization" | "digest-only",
    "by": "moon",                          // the human who confirmed, or the SIGNER of the authorization
    "at": "2026-10-11T09:17:13.940Z",
    "method": "bounded-choice" | "standing-authorization" | null,
    "authorization": {                     // null exactly when mode is not standing-authorization
      "ref": "docs/authorizations/SA-001.yaml",
      "digest": "sha256:…",                // the authorization's own digest at the moment of use
      "signedBy": "moon",
      "signedAt": "2026-10-11T00:00:00Z",
      "expiresAt": "2026-11-11T00:00:00Z"
    },
    "defaulted": [                          // empty exactly when mode is not standing-authorization
      { "id": "AMB-001", "question": "How are unparseable rows handled?",
        "chosen": "skip-count: …", "class": "malformed-row-accounting",
        "policy": "document-default", "checkedAs": "skip-count" }
    ]
  }
}
```

- **The three modes are distinguishable and the two that matter are disjoint.**
  `mode: interactive` ⟺ `authorization: null` ∧ `defaulted: []`; `mode: standing-authorization` ⟺
  `authorization` present ∧ `defaulted` names every decision the authorization answered. A later reader
  can always tell "a human confirmed this" from "an authorization defaulted it", and can name WHICH
  decisions nobody looked at.
- **`by` is the signer, not the runner.** In the standing case `by` is the human who signed the
  authorization, not the CI process that ran the command — the audit trail must point at the person who
  made the call, not the machine that acted on it.
- **`mode: digest-only`** is the honest third case: a run given `--requirement` + `--confirmed-requirement`
  whose document carries no `confirmation:` block (a digest approved out of band, ADR-025). `by` and
  `method` are null and the reason is stated, rather than folding it into one of the other two.
- **The engine reads it from the document, which the digest has already bound.** The run copies the
  document's `confirmation:` block into the record (the engine already reads that document at the
  acceptance step); the digest check guarantees the block it copies is the one the confirmation wrote.
  One new cross-check: a run handed an authorization whose digest differs from the one cited in the
  document's `confirmation:` block refuses by name.
- **The record answers the operator's question.** `takumi runs` can now report "N of M runs were
  confirmed by an authorization, K decisions defaulted" — which is exactly what an operator should be
  able to ask about a chain that runs without them. That is the point of putting the defaulted list in
  the record rather than only in the document.

## 5. The refusal behaviour

**A decision outside the scope STOPS the confirmation and asks; it never falls back to a default.**

The check happens in the confirmation path — the same place that refuses a non-TTY confirmation today
(`apps/cli/src/requirement-command.ts`, the `if (!isTTY)` branch). The design NARROWS that refusal; it
does not remove it. The rule stays *"a confirmation nobody read is not a confirmation"*, and the
authorization is the thing that was read and signed.

```
refused: a requirement confirmation must be interactive (stdin is not a TTY).
  This document is not covered by docs/authorizations/SA-001.yaml@sha256:<digest>:
    AMB-003 (independent-aggregation) — class not in scope.decisions
    AMB-005 — blocking, no default: a human must decide it
    AMB-004 — marked human: true
  A human confirms from a terminal, or the authorization is widened in a signed commit.
  --dry-run lists what is still undecided without confirming anything.
```

The message NAMES: the decision(s) that blocked it (`AMB-nnn` and the question), WHY each is out of
scope (class not granted, no default, marked human, document not in scope, failure not covered), the
authorization it was checked against (`ref@digest`), and the two ways forward (a terminal, or a widened
authorization — a human's edit, in a commit).

The same check runs under `--dry-run`, so CI can see the refusal and exit non-zero without ever
confirming anything (ADR-027's rule 5, ADR-036's budget). And the check happens BEFORE any write:
nothing is written and no token is printed. Defence in depth is unchanged: the forge refuses the same
document again at acceptance time (an unexercised blocking decision, an unknown `checkedAs`, ADR-028 /
ADR-031), so an authorization cannot get a document past the judge that a human could not.

## 6. The second moment: which failure closures a machine may close

There are three closures, and only one of them is a machine's to make (ADR-030, ADR-038):

| closure | may a standing authorization apply it? | why |
| --- | --- | --- |
| `implementation-changes` | **yes**, and only through the repair rounds, bounded | it changes the implementation, never the requirement (ADR-034) |
| `answer-wrong` | **never** | it re-decides a decision — it changes the criteria the human gave |
| `check-at-fault` | **never** | it is a CLAIM by a human, with a basis, and it repairs nothing (ADR-038) |
| `addressed` (legacy, no-decision path) | **never** | an undifferentiated "somebody said so" is the record ADR-030 replaced |

- **`implementation-changes` maps to the repair rounds, and the authorization only extends their
  budget.** ADR-034 already lets a run spend its own `maxRounds` of repair before a human is asked: the
  failure goes back with the judge's `not ok` lines, the attempt chain re-runs, and the document is left
  byte-identical when the repair succeeds. When those rounds are exhausted and one `FB-nnn` is written,
  a standing authorization may spend one more round — `scope.failures[class: implementation-changes].maxRounds`,
  bounded 1..5, the same cap ADR-034 puts on a repair budget, and only for a failure whose checks
  exercise a decision inside the authorized decision scope. Beyond the bound it stops and asks.
  **An authorization never makes an unbounded spend** — ADR-034's own reasoning ("an unbounded one is an
  unattended agent spending money until it feels done").
- **Applying `implementation-changes` does NOT write a resolution.** It re-enters the repair loop with
  the recorded answer standing. Marking an `FB-nnn` resolved while leaving the implementation unchanged
  would be the loop spinning; the authorization may not do it. If the extra rounds are spent and the
  check still fails, the failure is written back (one `FB-nnn`, as ADR-034 specifies) and the run STOPS
  and asks. This narrows ADR-034 without changing it: repair still changes the implementation, never the
  requirement.
- **`answer-wrong` always goes to a human.** It re-decides a decision, i.e. it changes the criteria. A
  machine applying it on its own would be inventing a new answer, which ADR-029 refuses in as many
  words: *"a machine-written decision would be a decision nobody made."* ADR-030's `[2]` also refuses an
  unchanged answer, so a machine could only "apply" it by inventing content. Refused at load as a
  licensable class.
- **`check-at-fault` always goes to a human, and a machine must never declare it.** ADR-038 is explicit
  that this closure is *"a CLAIM by a human, with the basis stated in the resolution note"*, that *"the
  machine cannot tell whether the check was at fault any more than ADR-030 could tell whether the
  implementation or the answer was"*, and that closing a failure this way *"repairs nothing — the next
  acceptance still runs the same check."* If a machine could declare it, every failing check would be
  auto-dismissed, which is exactly the vacuous green ADR-013 exists to prevent. So `check-at-fault` is
  refused at load as a licensable class, and the authorization path cannot even present it: the
  machine has no path that writes `resolvedKind: check-at-fault`. This CONTRADICTS nothing in ADR-038;
  it hardens it — ADR-038 says a human must make the claim, and this design makes the machine unable to.
- A failure whose checks exercise a decision OUTSIDE the authorized scope is never auto-closed either:
  it stops the confirmation, per §5.

## 7. Intake automation, and the `checkedAs` defect

For one sentence to become a confirmable document, the intake must produce a document that passes
`validateRequirementDocument` at the front door — the same gate a human's confirmation passes:
sequential `REQ-`/`AMB-`/`SCN-` ids; 2–4 options per decision; `default`/`chosen` drawn from the
decision's own options; at most `MAX_OPEN_DECISIONS` (5) decisions; a `deliverable` block with a `run`,
an `input_format` (typed columns, exactly one `id`, exactly one `measure`, ≥3 sample rows, ≥2 distinct
ids, numeric measures), an `output_format` whose machine-readable shapes name their field roles
positionally, relations from `JUDGE_RELATION_VOCABULARY`, every blocking decision settled by `decides:`,
and a `checkedAs` mode from `JUDGE_DECISION_MODES` wherever a mode-carrying relation settles a decision.

**The `checkedAs` defect is the gap that blocks this today.** `checkedAs` must be written on the
`AMB-nnn` ENTRY (beside `chosen`), because that is where `parseRequirements` reads it
(`packages/core/src/requirement-decisions.ts:266`) and where the validator looks for it (line 484). A
`checkedAs` on the relation is invisible to both. The intake agent does not reliably do this: the
prompt's rule 12 says *"ON THE `AMB-nnn` ENTRY … NEVER on a relation"*, and the prompt itself records
that *"the first real run of this prompt put all three on the relations and the gate refused the
document."* The committed documents show the habit — `docs/requirements/intake.yaml` (REL-003, REL-004,
DIFF-001) and `docs/requirements/poc-mutation-detection.yaml` (REL-003, REL-004, DIFF-001) carry
`checkedAs` on the relation node beside `decides:`, and only a human's edit put it on AMB-001/002/003
where it is read. **So a generated document is refused at the front door until a person moves the
line — which is exactly the interactive moment a standing authorization is supposed to remove.** The
authorization cannot close the intake gap by itself; the intake contract has to be fixed first (§11,
decision 4). Two honest ways: (a) teach the intake to co-locate `decides:` and `checkedAs:` correctly
and prove it with a test that asserts the mode lands on the decision; or (b) accept `checkedAs` beside
`decides:` on the relation as an alternative reading — rejected here, because two places for one fact is
the drift ADR-031's sync test exists to prevent.

**A generated document is REVIEWED before it is confirmed.** This is the rule that keeps the
authorization from being a rubber stamp: a standing authorization confirms a document BY DEFAULT, so the
defaults have to be read by a person at least once. The flow is: intake generates → a human reviews the
document (the `requirements:` block, every `AMB-nnn` question and its default, the deliverable contract)
→ the human signs an authorization whose scope covers it → the confirmation defaults it. The review is
the human's act and it is where the criteria come from; the authorization is the record that they came.
What makes a document confirmable by default is not "a machine wrote it" but "a human signed an
authorization whose scope covers it" — the generation is the machine's, the authorization is the
human's. The scope names documents and classes, so the human signing it is signing a POLICY over a
family of documents; later documents in that family are defaulted without a fresh read, which is the
point — and it is why §3's rule and §4's `defaulted:` list carry the weight they do.

## 8. The tests this will need

Described, not written:

- **A covered document confirms non-interactively.** A document whose every open decision is in scope
  and carries a default: `confirm --authorization` exits 0, writes `chosen:` for each, appends the
  `confirmation:` block with `method: standing-authorization` and the `defaulted:` list, and prints a
  token equal to `takumi requirement digest` of the written file (the token is the document's,
  unchanged).
- **Out of scope stops, never defaults.** The same document with one decision outside the scope (class
  not granted, no default, `human: true`, document not in `scope.documents`) → exit 1, NOTHING written
  (the document is byte-identical), no token, and the message names that decision and why. This is the
  load-bearing test: the refusal is the feature.
- **The rule of §3, as a rule.** Cases: a decision marked `human: true`; a blocking decision with no
  default; a document path not in scope; an authorization naming `answer-wrong`, `check-at-fault` or
  `addressed` as a failure class; an authorization carrying a widening field (`allowProtectedPaths`,
  `override`) — each refused at load, by name.
- **Protected paths.** A delivery that modifies a protected path is still a `human` finding with a
  standing authorization in play (an extension of `packages/core/src/test/review-rules.test.ts`); and
  `docs/authorizations/` is protected (a delivery that edits an authorization is a `human` finding).
- **Expiry and revocation.** An `expiresAt` in the past, `revoked: true`, or a hand-edited
  authorization whose digest does not match the one the document's `confirmation:` block cites → refused
  by name.
- **The digest ratchet is untouched.** Editing a decision after an authorization-confirmed run
  invalidates the acceptance exactly as ADR-025's interactive case does (*"is not the one that was
  confirmed"*).
- **The audit trail.** A run confirmed by an authorization writes `requirement.confirmation.mode =
  standing-authorization`, the signer's name, the authorization ref+digest, and one `defaulted` entry
  per defaulted decision; an interactive run writes `mode = interactive`, `authorization: null`,
  `defaulted: []`. The pair is the test that the two are distinguishable.
- **The second moment.** An exhausted repair round with an authorization in scope for
  `implementation-changes` re-enters the repair loop (bounded) instead of stopping; the same failure
  with an authorization naming `check-at-fault` is refused at load; and a machine path that would write
  `resolvedKind: check-at-fault` does not exist (assert the authorization path cannot produce that
  field).
- **`checkedAs` placement.** A test that the intake's output has `checkedAs` on the `AMB-nnn` entry —
  the fix that unblocks intake automation — alongside the existing `judge-vocabulary.test.ts` sync tests.
- **The cross-check.** A run handed an authorization whose digest differs from the one cited in the
  document's `confirmation:` block refuses by name.
- **The selectable scope (§12).** A `scope` (family) authorization loads and licenses a document its globs
  reach; a document outside them is refused with the file byte-identical; both forms declared together, or
  neither, is refused by name; a glob that leaves the repository or reaches `docs/authorizations/` is
  refused by name; and every exclusion in this list holds for the family form exactly as for the pin.

## 9. Where this extends or contradicts an existing ADR

- **ADR-027 (bounded-choice confirmation): EXTENDS.** The `confirmation:` block gains
  `method: standing-authorization`, an `authorization:` citation and a `defaulted:` list. The non-TTY
  refusal is NARROWED — it gains exactly one exception, an authorization covering every open decision.
  The rule *"a confirmation nobody read is not a confirmation"* is preserved by making the
  authorization the thing that was read and signed.
- **ADR-028 / ADR-031 (a decision is only real if it is checked; `checkedAs`): UNCHANGED**, and the
  source of the class vocabulary. The forge still refuses an unexercised blocking decision and an
  unknown mode at acceptance, whatever confirmed the document.
- **ADR-029 (the failure comes back): EXTENDS.** An open `feedback:` entry is part of what an
  authorization must cover; a failure outside the scope refuses. ADR-029's *"a machine-written decision
  would be a decision nobody made"* is the reason `answer-wrong` is never licensable.
- **ADR-030 (answering a failure): EXTENDS.** `implementation-changes` may be applied by an
  authorization (bounded, re-entering ADR-034's repair loop); `answer-wrong` may not. The two-sided
  question is unchanged for a human.
- **ADR-034 (repair rounds): EXTENDS and NARROWS.** The authorization extends the repair budget when the
  run's own rounds are exhausted, bounded by `scope.failures.maxRounds` (1..5, the same cap); it never
  makes the loop unbounded, and repair still changes the implementation, never the requirement.
- **ADR-036 (checklist with a budget): EXTENDS.** Round 1 asks every decision; the authorization is the
  record that a round-1 sweep was NOT performed, so `defaulted:` is the checklist a reviewer reads
  instead. `MAX_OPEN_DECISIONS` is unchanged.
- **ADR-038 (the check itself can be wrong): HARDENS.** `check-at-fault` stays a human's claim, and the
  authorization path makes it impossible for a machine to make it.
- **ADR-032 / `review-rules.ts` (protected paths): EXTENDS.** `docs/authorizations/` joins the protected
  paths; an authorization never lowers a protected path's severity.
- **ADR-025 (confirmed requirement, acceptance bound to it): UNCHANGED.** The token is still the
  document digest and the acceptance still refuses a mismatch by name. The run record's `requirement`
  field is EXTENDED with `confirmation`.
- **The run record** (no ADR yet; `packages/core/src/run-record.ts`, branch tip `1f31243`): EXTENDS with
  `requirement.confirmation`.

## 10. What this design deliberately does NOT solve

- **It does not verify the signature.** `signedBy` is a name, not an identity (ADR-018); what binds is
  the file digest and the git history. Verifying a GPG/SSH signature is out of band and out of scope.
- **It does not read the document for you.** A defaulted decision is accepted unread; `defaulted:` says
  which ones, and the review before signing is the human's act — nothing checks that the review happened.
- **It does not make a bad default safe.** If the intake writes a defensible-looking default that is
  wrong, the authorization waves it. The judge will fail it at acceptance (the default is an input to
  the judge, ADR-028 / ADR-031) and the failure comes back — but the first run is spent. Widening the
  scope is widening what the loop accepts, deliberately (the same limit ADR-031 records for the
  vocabulary).
- **It does not touch the acceptance.** ADR-025's binding is unchanged. The authorization's only effect
  on a run is that it let a non-interactive confirmation produce the digest, and that it is recorded.
- **It does not close `answer-wrong` or `check-at-fault`,** deliberately (§6).
- **It does not bound the number of runs** an authorization may confirm — only the extra repair rounds
  per failure. A cron running the chain hourly under one authorization is N runs, each with its own
  record; the budget is per failure, not per authorization. An authorization-level run budget is a
  plausible next step, not this one.
- **It does not fix the intake's `checkedAs` defect.** The defect is a prerequisite (§7); this design
  names it and refuses to paper over it.
- **It does not make the intake's judgement right.** What is reviewed is a document, not the reasoning
  that produced it (ADR-030's own limit).
- **It does not retire the interactive confirmation.** A terminal is still the only way to answer a
  decision with no default, a `human: true` decision, `answer-wrong`, and `check-at-fault`. The mode's
  promise — two human touchpoints — becomes, for a covered family, one: the signing.
- **It does not cover the `addressed` closure** (the no-decision path, ADR-038), or a decision class
  outside `JUDGE_RELATION_VOCABULARY` ∪ `{unmechanised}`.

## 11. The decisions the operator must make

1. **Where the authorization lives and how it is signed.** A committed `docs/authorizations/<SA-nnn>.yaml`
   whose binding is its own digest plus the git history (a `git commit -S` commit as the signing act),
   with `signedBy` a name and not an identity (ADR-018) — OR a stricter form that also pins one document
   digest (`pin: {ref, digest}`), so an authorization licenses exactly one document and never a family.
   The scope form is what makes the chain unattended; the pin form is what makes it safest. Which ships?
   **DECIDED: both ship, and the human selects (§12).** v1 landed the `pin` form; §12 adds the `scope`
   form and makes the choice explicit in the file — exactly one of `pin` / `scope`, never both, never
   neither. The form written IS the mode.
2. **Which failure classes an authorization may act on.** This design licenses `implementation-changes`
   only, mapped to ADR-034's repair loop with a bounded extra-round budget, and refuses `answer-wrong`
   and `check-at-fault` at load. Confirm that split — and decide whether an authorization may spend extra
   repair rounds at all, or may only re-run the chain (the run stops and a human re-triggers), because
   "an authorization may spend money without a human" is the decision with the largest cost surface.
3. **What "requires a human" is marked by.** The design proposes a new `human: true` marker on an
   `AMB-nnn` entry, plus the existing "blocking with no default". Is a new document field acceptable, or
   is "blocking with no default" enough — in which case a document cannot mark a *defaulted* decision as
   human-only?
4. **The `checkedAs` fix.** Intake automation is blocked by the defect in §7: the generated document puts
   `checkedAs` on the relation and the front door refuses it until a human moves it to the `AMB-nnn`
   entry (evidence: `docs/requirements/intake.yaml` and `docs/requirements/poc-mutation-detection.yaml`
   carry it on both nodes). Fix the intake prompt and prove it with a test, or accept the mode on the
   relation as a second reading (rejected here — two places for one fact)? Nothing in this design runs
   unattended until this is chosen.

## 12. The wider scope: a family of documents, selectable (implemented)

§11's first decision is closed: the authorization is not pin-only. It has two scope forms, the human
SELECTS one, and the form written in the file IS the mode — one mechanism, two forms, no flag, no second
command, no second validator. This is the one section where the SHIPPED shape is stated exactly, because
the implementation (§1's `scope:` sketch, flattened) and the design have to agree.

```yaml
# Form 1 — a PIN: one revision of one document ("signed once").
pin:
  ref: "docs/requirements/intake.yaml"
  digest: "sha256:…"          # the revision a human read; a byte changed after signing is refused

# Form 2 — a SCOPE: a family of requirement documents ("unattended").
scope:
  documents:
    - "docs/requirements/intake.yaml"
    - "docs/requirements/poc-*.yaml"
```

`decisions` and `failures` are unchanged and sit BESIDE whichever form is chosen; they are not nested
inside `scope` (the §1 sketch nested them, and the implementation flattened them — this is the
reconciliation, and it is the shipped shape).

- **Exactly one form, never both, never neither.** A file declaring both `pin` and `scope` is refused at
  load — *"it selects exactly ONE scope form"* — and so is a file declaring neither. The refusal is by
  name, because a grant whose edges a reader cannot see is a grant they cannot revoke with confidence.
- **The glob vocabulary is tiny and predictable**, because a scope a human cannot predict is a scope they
  cannot sign: `*` matches any run of characters EXCEPT `/` (so `poc-*.yaml` stays inside one directory);
  `**` matches any run INCLUDING `/`; `?` matches exactly one character except `/`; every other character
  is literal. There is no dependency and no hidden syntax.
- **A glob may only name a requirement document inside the repository.** A pattern that is absolute, walks
  out with `..`, carries a backslash, does not end in `.yaml`/`.yml`, or reaches `docs/authorizations/` is
  refused at load, BY NAME. The last is §3's self-referential guard: an authorization may not confirm
  another authorization, so a scope that could reach one is refused rather than trusted.
- **The exclusions are IDENTICAL for both forms.** §3's rule — it licenses an ANSWER THE DOCUMENT ALREADY
  OFFERS, never a CHANGE THE DOCUMENT DOES NOT CONTAIN — is untouched. A `human: true` decision, a
  blocking decision with no `default:`, a class outside the vocabulary, a refused failure closure, an open
  acceptance failure, an expired or revoked grant: each refuses the confirmation the SAME way under a
  `scope` as under a `pin`. The wider form widens WHICH DOCUMENTS are in reach, never what may be written
  into one.
- **The trade-off, stated plainly.** A `pin` binds a REVISION: a document changed by a byte after signing
  is refused, so the exact text a human read is the exact text that gets defaulted. A `scope` binds a
  CLASS of documents: there is no per-document digest to pin, so a document edited after signing is still
  confirmable. What binds the run in BOTH cases is the document's OWN confirmation token (ADR-025) — the
  digest the acceptance checks — and under a `scope` the review before signing (§7) is the human's act.
  This is exactly why §11 called the pin form "safest" and the scope form "unattended"; the human chooses
  which one they are signing, and the file says which.
- **The audit trail is unchanged.** The `confirmation:` block still cites the authorization's own
  `ref@sha256:<digest>` (§4); the form is readable from the file that digest names, so a later reader can
  tell a pin from a family without a new field. `defaulted:` still names every answer nobody read. The
  record's job — telling a human's confirmation from an authorization's, and naming what nobody read — is
  identical for both forms.

### What the tests pin (all of it driving the real confirmation path)

- A family authorization loads, and `documentMatchesScope` answers for it: a matching path is in, a
  non-matching path is out, and `*` does not cross a `/`.
- Declaring BOTH forms, or NEITHER, is refused by name; the `scope` block is a closed shape (an unknown
  or widening key inside it is refused by name).
- A scope glob that is absolute, walks out with `..`, is not YAML, or reaches `docs/authorizations/` is
  refused by name.
- **The real path.** `takumi requirement confirm <ref> --authorization <scope-file>` with a NON-TTY stdin
  confirms a document its globs reach — it writes each decision's own `default:`, appends the same
  `confirmation:` block, and prints the document's own token — and refuses a document outside the globs
  with the file BYTE-IDENTICAL and no token. `--dry-run` runs the same check and writes nothing.
- **The same fail-closed exclusions** (class not granted, `human: true`, no default, open failure, expiry,
  revocation) hold under the family form exactly as under the pin — the wider form is wider only in WHICH
  DOCUMENTS it reaches.

