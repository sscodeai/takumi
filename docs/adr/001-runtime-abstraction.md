# ADR-001: Technology Stack Selection

- **Date**: 2026-08-18
- **Status**: Accepted

## Context

Takumi needs to support: cross-platform CLI, in-process Runtime adapters (Pi SDK), artifact rendering (Excel/Word/PDF in the future), Web Dashboard (long-term), and language-agnostic RPC adapters (isolated fan-out). The discover reconnaissance confirmed that the Pi SDK is TypeScript.

## Decision

- **Language**: TypeScript / Node.js ≥ 20 (Node 22.23.2 available on this machine)
- **Package manager**: pnpm workspaces (Monorepo)
- **CLI**: Node native + `commander` (or a hand-written arg parser, keeping zero-dependency priority)
- **Testing**: `node:test` (built-in, zero dependencies) or vitest
- **Workflow engine**: custom lightweight JSON state machine (do not adopt XState; decide in Phase 4 based on complexity)
- **Not used**: LangGraph (Python dependency), Swarms (immature), OpenHands sandbox (Pi already handles tool execution)

## Alternatives

- Python + LangGraph — rejected: the Pi SDK is TS, so in-process adaptation is cleanest; a single language spans orchestration/artifacts/UI
- Go — rejected: the Pi SDK has no Go bindings, so in-process adaptation is not viable

## Trade-offs

- TS-ecosystem agent harnesses (such as the Claude Agent SDK) are also TS, providing high reference value
- A custom state machine requires handling retries/parallelism ourselves, in exchange for zero runtime dependencies

## Consequences

- Core uses strict TS types for Task/Event/Artifact/Result
- The RuntimeAdapter contract language = TS interface; future RPC/other-language runtimes adapt via JSON-RPC
- The first PiRuntimeAdapter = an in-process SDK implementation

---

# ADR-002: Runtime Abstraction (AgentRuntimeAdapter Contract)

- **Date**: 2026-08-18
- **Status**: Accepted

## Context

Takumi must prove "Harness-agnostic": the same AgentTask and Workflow switch from FakeRuntime → PiRuntime purely via configuration, without modifying Core/Workflow source code. This is the key acceptance criterion for Phase 3.

## Decision

Core contract (typescript):

```typescript
interface AgentRuntimeAdapter {
  metadata(): RuntimeMetadata;
  capabilities(): RuntimeCapabilities;
  run(task: AgentTask): AsyncIterable<AgentEvent>;
  cancel(taskId: string): Promise<void>;
  getStatus(taskId: string): Promise<TaskStatus>;
  getUsage(taskId: string): Promise<Usage>;
  getArtifacts(taskId: string): Promise<Artifact[]>;
}
```

- Do not unify Harness-internal Tool Calls; unify Task → Events → Result → Artifacts → Usage
- RuntimeCapabilities: streaming / filesystem / shell / subagents / browser / resume / usageTracking / sandbox / parallelExecution
- Workflow declares `requires: [filesystem, shell]`, and Core validates against runtime.capabilities() before execution
- First-version implementations: FakeRuntime (testing/development) → PiRuntimeAdapter (SDK in-process) → PiRpcRuntimeAdapter (subprocess)

## Alternatives

- Unifying low-level tool calls (readFile/execShell etc.) — rejected: each Harness has a different Tool System, and forced unification would produce fragile adapters

## Trade-offs

- The event stream protocol must be defined and stabilized by ourselves — this is the core workload of the adapter
- Higher layers cannot directly access Harness-specific features (except via an escape hatch)

## Consequences

- Core is forbidden from importing any Pi-specific package (Architecture Invariant #1, enforced via an ESLint rule or import review)
- Subsequent adapters: Goose (Apache 2.0, proving vendor neutrality), DeepSeek Harness, Codex (CLI bridge)
