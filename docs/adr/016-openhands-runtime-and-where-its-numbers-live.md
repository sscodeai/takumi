# ADR-016: OpenHands as a Runtime (and Where Its Numbers Actually Live)

- **Date**: 2026-09-19
- **Status**: Accepted (`runtimes/openhands`, registered in `pnpm-workspace.yaml`)
- **Related**: ADR-010 (Decision A/B — the `cli:` seam vs a runtime adapter), the OpenHands spike
  report, and the runtime contract suite (`packages/core/src/contract.ts`)

## Context

`pilot.agent.command` can already point at the OpenHands CLI (`examples/openhands-agent.sh`). That
is Decision A, and it is enough to get work done — but it cannot answer what a task COST. The
runtime port has `getUsage`/`getArtifacts`/`getStatus`; Decision B named the reason to promote
OpenHands to a runtime: per-task tokens, cost and artifacts from its `--json` event stream.

**The stated reason turned out to be half wrong, and measuring found the other half.**

## What a real run actually emits (measured 2026-09-19, not assumed)

1. **The `--json` stream carries NO token or cost accounting.** A real capture contains
   `ActionEvent` / `ObservationEvent` / `MessageEvent` objects — `tool_name`, `llm_message`,
   `critique` — and nothing about tokens. Anyone building `getUsage` on this stream would have to
   invent the numbers.
2. **The accounting exists, in the conversation's own state**: `<home>/conversations/<id>/base_state.json`,
   under `stats.usage_to_metrics.<usageId>`:
   - `model_name`
   - `accumulated_cost`
   - `accumulated_token_usage.{prompt,completion,cache_read,reasoning}_tokens`
   - a per-call `token_usages[]` list
   - plus `execution_status` at the top level.
   Real numbers from one task: `prompt 70347`, `completion 890`, `cache_read 58752`,
   `reasoning 14`, `cost 0.0`, `execution_status finished`.
3. **The stream is not pure JSON**: human-facing prose ("Initializing agent...", "Agent is
   working", "Agent finished", a conversation summary) is interleaved with the events. A parser
   that assumes JSONL fails on the CLI's own banner.
4. **A test run is not distinguishable from any other command** in the stream.

## Decision

1. **Events come from the stream; usage comes from the conversation's accounting.** The adapter
   reads `base_state.json` and reports `promptTokens`/`completionTokens`/`totalTokens`/`costUsd`
   **as recorded**, with `cache_read_tokens`, `reasoning_tokens`, the per-usage breakdown, the
   model and `execution_status` in `extra`.
2. **Cost is reported as recorded, never estimated.** An OpenAI-compatible endpoint that publishes
   no pricing records `0.0`; the adapter passes that through and carries the caveat
   (`extra.costNote`). A number that looks like "this task was free" must be impossible to read by
   accident.
3. **An unavailable accounting is NOT a zero.** When the file cannot be read, the tokens are zeros
   **with the reason in `extra.usageUnavailable`** — the same rule as the delivery side: an unknown
   is never a yes, and an unknown cost is never a free task.
4. **Non-JSON lines are skipped and counted**, and the count travels in the completion event: the
   adapter reports what it could not read rather than pretending the stream was clean.
5. **No `test.completed` is ever emitted** from a heuristic: the stream does not distinguish a test
   run, so claiming it would be a guess wearing the clothes of an observation.
6. **Nothing is written into the worktree.** The verbatim transcript is stored under the runtime's
   own home (`<home>/takumi-runs/<taskId>.jsonl`) and reported as an `evidence` artifact; the
   delivery's "the runner never commits / never dirties the tree" rule stays intact.
7. **`extraArgs` are passed BEFORE the CLI flags.** Found by a failing test: a wrapper binary
   (or `node` in a test) must receive its own arguments before they are parsed as the CLI's.

## Consequences

- `runtimes/openhands` passes the shared runtime contract suite with a REAL run (not
  `skipRealRun`), so the port is proven for a third, independent harness.
- Per-task cost is now answerable for OpenHands tasks **from the tool's own books**. It is honest
  where it is empty, which is the useful part: a `0` cost is labelled as "no pricing published",
  not as "free".
- **Still open, and named**: the PILOT does not yet consume the runtime, so a tick's trail still
  reports no tokens. `pilot.agent.runtime: openhands` (the tick runs the adapter, then emits a
  usage event from `getUsage`) is the next slice — the adapter is what makes it possible, and the
  numbers above are what it will carry.
- The adapter does not commit: an agent that edits files without committing is correct behaviour
  for a RUNTIME (it is a session), and the pilot's contract — a commit, a clean tree — is enforced
  where it belongs, at the delivery boundary.
