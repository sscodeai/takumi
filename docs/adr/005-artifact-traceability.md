# ADR-005: Artifact & Traceability

- **Date**: 2026-08-18
- **Status**: Accepted

## Context

Core requirement of Japanese SI delivery: a complete traceability chain of requirements → design → code → test → evidence. The discover phase confirmed this is a differentiation gap between Takumi and existing tools (e.g., Handoff AI).

## Decision

- **Artifact** model: `id / taskId / kind / path / contentType / sizeBytes / trace[] / createdAt / sha256`
  - kind: requirements / design / code / test / evidence / review / report
- **Trace links**: each artifact carries `trace: TraceId[]` (e.g., `["REQ-001", "DESIGN-001"]`)
- Metadata (including trace) is persisted to `<root>/.meta/<id>.json` and can be rebuilt after restart (list() reads meta first)
- **Traceability Matrix**: `renderTraceabilityMatrix(artifacts)` generates a Markdown matrix + uncovered REQ detection (the trace in the requirements source document itself does not count as coverage)
- ArtifactStore layout: `<root>/<kind>/<file>`

## Alternatives

- Store files only without trace — cannot generate the matrix, loses differentiation
- Store trace in git commits — depends on the git environment, unreliable

## Trade-offs

- The .meta directory is separate from artifact files; atomicity must be ensured (write the file first, then write meta)
- The matrix only detects REQ coverage, does not validate DESIGN→CODE completeness (future extension)

## Consequences

- Traceability Matrix is automatically output after `takumi run --workflow`
- Pi adapter will export finer-grained audit trails via the session tree (SessionManager) in the future
- Future Benchmark's Artifacts Quality metric can be based on this model
