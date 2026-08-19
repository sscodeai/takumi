# Contributing

Thanks for your interest in Takumi. This project is in **Developer Preview**
and follows a lightweight contribution loop.

## How to contribute

1. **Open an issue / discuss first** for non-trivial changes (architecture,
   API, behavior changes).
2. **Single-focus commits**: one logical change per commit, typed as
   `feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:`, with a body
   explaining **why**.
3. **Tests with code**: any behavior change ships with or updates its tests.
   Full suite must stay green (`pnpm test`, all packages).
4. **Honesty (Gate 22)**: do not add unverified "Enterprise / Production
   Ready / Secure / HA / Scalable" claims to README or docs. Mark things
   `Planned` / `Experimental` unless genuinely done.

## Architecture invariants (please preserve)

- **Core is harness-agnostic**: `packages/core` must not import any runtime
  (Pi / DeepSeek / Codex) and must not branch on a runtime id. Runtimes live
  under `runtimes/*`.
- **Extensions are discovered, not hardcoded**: skills/tools/workflows/
  runtimes are added by dropping a `manifest.yaml` into a registry dir — Core
  is not edited.
- **Real behavior over demo**: tests assert observable outcomes (statuses,
  on-disk artifacts, event sequences, error strings), not implementation
  details.

## Environment

- Node ≥ 20, pnpm. `pnpm install` + `pnpm build` + `pnpm test`.
- The Pi runtime is opt-in (depends on an unpublished SDK); see README.
