# req-intake

English requirement-intake skill for the black-box acceptance flow. It turns a
natural-language request into ONE structured requirement document that a human
can confirm before any implementation starts.

## Purpose

- Separate what the request actually states from what it leaves undecided.
- Give every undecided point a bounded choice, not a free-form question.
- Produce a document whose text can be hashed, so a confirmation is about
  CONTENT rather than about a step name.

## Emitted document schema

The skill emits exactly one YAML document with these two top-level keys:

```yaml
requirements:
  - id: REQ-001            # REQ-nnn, sequential, unique
    title: "..."           # short imperative title
    description: "..."     # what must hold, in behavioural terms
    acceptance_criteria:   # at least one, each independently checkable
      - "..."
    priority: High         # High | Medium | Low
    source: "..."          # where in the request this comes from
ambiguities:
  - id: AMB-001            # AMB-nnn, sequential, unique
    question: "..."        # the decision that is still open
    options:               # 2 to 4 bounded, mutually exclusive options
      - "..."
      - "..."
    default: "..."         # one of the options above
    blocking: true         # true = implementation must not start undecided
    chosen: "..."          # written by `takumi requirement confirm`, not by the intake
    fromFeedback: FB-001   # optional (ADR-030): the acceptance failure this decision answers
```

Rules for the fields:

- `requirements[]` is never empty for a non-empty request. Each requirement has
  at least one acceptance criterion written so a third party could check it
  without reading the implementation.
- `ambiguities[]` lists every decision point the request does not settle. Each
  entry has 2-4 `options`, and `default` must be exactly one of them.
- `blocking: true` marks an ambiguity that must be decided before
  implementation. `blocking: false` marks a decision that can be deferred but
  must still be recorded.
- `fromFeedback` is written only on a re-pass, and only with the id of an
  acceptance failure the document records. A decision that cites a failure the
  document does not contain is refused by `takumi requirement confirm`.

## Hard rule

Every open decision point in the request becomes an `AMB-nnn` entry with 2-4
bounded options and a default. An intake that contains zero ambiguities is
valid only when the request genuinely leaves nothing undecided; an agent must
not silently resolve a decision point by picking an interpretation and omitting
it from `ambiguities[]`.

## The re-pass (ADR-030)

The intake runs a second time when an acceptance has failed and the failure has been written back into
the document (ADR-029) — that is, when the request carries a
`## Acceptance feedback (written back by the machine)` block, which `takumi requirement brief <ref>`
prints. In that pass:

- the document under revision is `docs/requirements/<the same file>`; the intake KEEPS every existing
  requirement, decision and `feedback:` entry, and revises rather than rewrites;
- a failing check that already exercises a decision is NOT given a new decision — the human's choice
  is between "the implementation changes" and "the answer changes", and the confirmation asks for it;
- a failing check that exercises NO decision is a failure of the implementation (or of a piece of the
  requirement no decision covers). The intake proposes a new decision only when the requirement truly
  left the point undecided, and every such decision carries `fromFeedback: FB-nnn` so the document
  records which failure it answers;
- a new blocking decision must be bound to a check (`decides: AMB-nnn` on a relation or anchor), and
  the answer must be inside the forge's vocabulary — otherwise the judge is not built and the run
  stops. That boundary is stated in the prompt on purpose.

`takumi requirement confirm <ref>` refuses a document whose decision cites a failure the document does
not record, or whose check settles a decision that is not there, so a sloppy revision is caught before
a human is asked to confirm it.

## Files

```
SKILL.md
manifest.yaml
prompts/intake.md     # request text -> requirement document
prompts/confirm.md    # render the document + sha256 for human confirmation
prompts/revise.md     # re-pass: a failed document + the machine's brief -> the revised document
```
