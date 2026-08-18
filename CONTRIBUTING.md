# Contributing to Takumi

Thanks for your interest! Takumi is an open-source Agentic Software Engineering Platform. Contributions of all kinds are welcome: code, docs, Japanese SI skills, benchmark tasks, bug reports.

## Development setup

```bash
git clone <your-fork> && cd takumi
pnpm install
pnpm build        # sequential build (core → runtimes → cli)
pnpm test         # run all package tests
```

## Repository layout

- `packages/core/` — orchestration primitives, runtime abstraction, workflow engine, artifact store, traceability. **No runtime-specific or Japanese-SI-specific code.**
- `runtimes/` — runtime adapters implementing `AgentRuntimeAdapter` (fake, pi).
- `extensions/` — first-party extensions (skills, tools, workflows).
- `apps/cli/` — the `takumi` CLI.

## Architecture invariants (must hold in every PR)

1. Core imports no Pi-specific package.
2. Core imports no Japanese-SI-specific implementation.
3. Runtime adapters stay harness-agnostic.
4. Skills and Tools are independent of runtime implementations.
5. Workflow definitions don't require a specific runtime unless explicitly configured.
6. Artifact/traceability models don't depend on Japanese-specific artifact types.
7. Runtime capabilities are validated before execution.
8. Extension discovery never hardcodes extension names.

## Adding a Japanese SI skill

Create `extensions/skills/<name>/` with `SKILL.md`, `manifest.yaml`, and optional `prompts/`, `checklists/`, `schemas/`. See existing skills for the format.

## Testing

Every Core feature must have tests (runtime adapter contract tests, workflow execution tests, plugin discovery tests, capability validation tests, artifact tests, traceability tests). Run `pnpm test`.

## Commit conventions

- Logical slices: `feat:`, `fix:`, `docs:`, `test:`, `chore:`
- Reference ADRs when changing architecture: `docs/adr/`

## Questions

Open an issue or discussion. For architecture decisions, prefer adding an ADR over chat-only decisions.