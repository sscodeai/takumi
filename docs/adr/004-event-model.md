# ADR-004: Event Model (Unified AgentEvent Stream)

- **Date**: 2026-08-18
- **Status**: Accepted

## Context

Multiple Runtimes (Fake/Pi/future DeepSeek Harness/Codex) need to expose a unified execution process to the upper layers. Each Harness has a different internal event/tool-call structure (Pi has `agent_start/turn_start/message_update/tool_execution_start...`).

## Decision

- Unified event type (AgentEventType):
  `task.started / agent.message / tool.started / tool.completed / file.changed / command.started / command.completed / test.completed / artifact.created / approval.required / task.failed / task.completed`
- Each event carries: `id / taskId / type / timestamp / message? / name? / exitCode? / data? / trace?`
- **Do not** unify Harness-internal Tool Call details; tool-type events only retain `name` + `exitCode` + optional data
- The Runtime Adapter is responsible for mapping Harness events to AgentEvent (mapping lives inside the adapter, does not leak into Core)

## Alternatives

- Pass through Harness native events —— upper layers would need to know the details of each Harness, violating harness-agnostic
- Fully flattened (messages only) —— loses tool/command/test semantics, traceability cannot be established

## Trade-offs

- The mapping layer has information loss (Harness-specific fields go into the `data` escape hatch)
- The event schema needs to be stable —— this is the main workload of the adapter

## Consequences

- `runTaskAndCollect` consumes the event stream and aggregates conclusions (summary/usage/artifacts)
- The Pi adapter has already implemented the mapping (agent_start→agent.message, tool_execution_*→tool.*, message_update→agent.message, etc.)
- Future RPC mode (`pi --mode rpc`) events can be mapped to the same schema
