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

## Hard rule

Every open decision point in the request becomes an `AMB-nnn` entry with 2-4
bounded options and a default. An intake that contains zero ambiguities is
valid only when the request genuinely leaves nothing undecided; an agent must
not silently resolve a decision point by picking an interpretation and omitting
it from `ambiguities[]`.

## Files

```
SKILL.md
manifest.yaml
prompts/intake.md     # request text -> requirement document
prompts/confirm.md    # render the document + sha256 for human confirmation
```
