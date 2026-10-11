# 045. A standing authorization licenses exactly one document

Status: accepted (v1: pin only).

## The moment this changes

A run is bound to a requirement document that a human confirmed, and a non-TTY
confirmation is refused (027, 036). That invariant stays: the human gives the
criteria and the machine implements. But it puts a person at the keyboard twice --
writing and confirming the document, and adjudicating a failure afterwards.

A standing authorization moves the first of those moments EARLIER rather than away.
The human signs once; the machine then runs from a signed document to a landed
delivery without anyone at the keyboard.

## What an authorization is

`docs/authorizations/<SA-nnn>.yaml`, committed, with: `signedBy` (a name, not an
identity -- 018), `signedAt`, an `expiresAt`, an optional `revokedAt`, the ambiguity
classes it may answer and the policy it answers them with, and a `pin`:
`{ref, digest}` naming ONE document revision.

The signature is the commit that adds the file. The run cites the file, and the
authorization's own digest is checked against the pin: if the document has changed
by a single byte, the pin is stale and the authorization does not apply.

## What it licenses, and what it may never license

It licenses confirming a document by the document's OWN defaults, and only when
every open decision falls inside the authorized classes. It may never license:

- the protected paths (CI configuration, dependency manifests, container builds,
  takumi's own configuration) -- those need a human, and are never handed back to
  the agent to "fix";
- a decision that changes the deliverable contract rather than choosing inside it;
- a decision the document marks `human: true`;
- anything outside the declared scope.

The rule, not the list: an authorization licenses only choices INSIDE a contract
the human already accepted. Widening the contract is a human act.

The refusal is a stop, never a fallback: a decision outside the scope halts the run
and the message names the decision and the reason.

## The audit trail

The run record (workstream 3) carries which authorization, signed by whom, the
document digest, and WHICH decisions were defaulted rather than answered. A record
that cannot distinguish "a human confirmed this" from "an authorization defaulted
it" would recreate the problem this design exists to solve.

## The second moment: which failures a machine may close

Only `implementation-changes` may be applied automatically, and within the existing
bounded repair rounds -- an authorization may not buy extra rounds in v1, because
that is spending without a person.

`answer-wrong` and `check-at-fault` always go to a human. A machine must never be
able to declare that the check itself was wrong: that is the one claim which, if
the machine could make it alone, would let it dismiss any evidence against its own
work.

## The self-referential guard

A delivery may not edit or revoke the authorization that let it run. An
authorization cannot be widened by the thing it authorizes.

## Modes are a choice, not two products

The scope of what the human signed selects the mode. A `pin` licenses one document:
"signed once". A wider scope -- a class of requirements with a default policy --
licenses "unattended", with the same hard exclusions above. One mechanism, two
modes, chosen by the human.

## What this does not do

It does not widen itself (v1 is pin-only). It does not fix the intake agent's
inability to write `checkedAs` at the correct node -- that is fixed separately, in
the prompt, and a generated document is not the confirmed document until a human or
an authorization confirms it. It does not make a failure disappear: a run whose
failure falls outside the authorized class still stops and asks.

## References

027 (the confirmation), 028 (a decision only counts when it is checked), 031
(`checkedAs`), 034 (repair rounds), 036 (the checklist with a budget), 038 (the
third closure), 018 (a name, not an identity).
