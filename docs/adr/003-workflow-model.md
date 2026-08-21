# ADR-003: Workflow Model (Declarative YAML Workflow)

- **Date**: 2026-08-18
- **Status**: Accepted

## Context

Takumi needs to express the Japanese SI V-model process (requirements → design → approval → implementation → test → evidence) and a fast MVP process. Workflows must be declarative, versionable, composable, and not hard-coded in Core.

## Decision

- Workflows are defined **declaratively in YAML/JSON** (`extensions/workflows/<name>/workflow.yaml`)
- Each step: `id / type (agent|approval|tool) / prompt / skill / requires / dependsOn / retry`
- Execution order: `dependsOn` forms a DAG; steps without dependencies execute in declaration order (topo-sort)
- Approval gates are a **first-class step type** (`type: approval`), not an ad-hoc feature
- Workflows can declare global `requires` (runtime capabilities), validated before execution
- Custom lightweight state machine implementation (XState/LangGraph not introduced)

## Alternatives

- XState — mature but introduces a runtime dependency; the V-model has few states, so a custom implementation is sufficient
- LangGraph — Python dependency + low-level graph operations, violates the TS single-language principle
- Workflow defined in code — not declarative, cannot be consumed by CLI/UI

## Trade-offs

- The custom engine must handle retry/parallelism/failure semantics itself (implemented: attempt loop + backoff + skip on dependency failure)
- Declarative style limits expressiveness (complex conditional branching requires schema extensions)

## Consequences

- Adding a workflow only requires adding a YAML file, no Core changes needed (architecture invariant #6)
- Approval gates can be driven via CLI interaction (`[a]/[r]/[v]`) or automated callbacks
- Workflow visualization can be added in the future (YAML → graph)
