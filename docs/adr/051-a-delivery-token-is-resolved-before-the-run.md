# ADR-051: A Delivery Token Is Resolved Before The Run, Not After It

- **Date**: 2026-10-11
- **Status**: Accepted. Implemented in `apps/cli/src/delivery-command.ts` (`DEFAULT_TOKEN_ENV`,
  `deliveryToken`, `assertDeliveryToken`, `tokenEnv` as a configurable option) and
  `apps/cli/src/index.ts` (`createProviders`, the run path). Tests in
  `apps/cli/src/test/delivery-token.test.ts` and `apps/cli/src/test/delivery.test.ts`.
- **Related**: ADR-037 (a run publishes through a provider it was handed), ADR-045 (a standing
  authorization), docs/bugs-fixed.md #62

## Context

The GitHub delivery adapter is handed a repository and nothing else: it reads `process.env.GITHUB_TOKEN`
itself, and with no token it uses a fail-closed request function that refuses every call
(`no request transport configured … — inject one (tests) or provide credentials`). That design is right
— an unauthenticated request is never sent — but it discovers the problem at the **publish** step.

Measured on 2026-10-11: a `request-to-delivery` run against the service-shaped spike document accepted
its delivery **11/11 on the first attempt**, and was then refused at `publish` because `GITHUB_TOKEN` was
not in the environment. The operator had paid for the whole chain — the implementation, the delivered
tests, the quality gate, the rule review and the acceptance — before hearing about a variable. The
config had no way to say WHERE the token lives either: `token` is (rightly) refused as a config value, and
there was no key naming an alternative variable.

## Decision

1. **The token is resolved BEFORE the run starts.** `createDeliveryProvider` (the factory the delivery
   subcommands and the run path share) resolves it up front and refuses by name when the provider cannot
   work without one. `github` and `gitlab` are in that class; **`forgejo` is not** — its transport reads
   the token lazily and sends the request without one, which is legitimate against a host that allows it.
   The difference is stated rather than left to be discovered.
2. **`delivery.tokenEnv` names the variable.** It is CONFIGURATION because it is a NAME
   (`delivery: { tokenEnv: MY_GITHUB_TOKEN }`); the secret stays an environment value, because a secret in
   a config file is one commit away from a secret in a repository. The named variable WINS over the
   provider's default, and the refusal names the variable the operator actually wrote.
3. **The refusal says what the silence costs**, so the reason for failing up front is legible: without a
   token the publish step is refused *after* the implementation, the delivered tests and the acceptance
   have all run.
4. The option mappers still run FIRST, so a malformed section (no `repo`) says so before the token
   question is asked.

## Consequences

- A missing token costs one sentence instead of a whole chain. On the real path this is measurable: the
  run is refused at construction, before the worktree, the agent or the acceptance.
- The token the provider uses is now the one the operator NAMED, not whatever happened to be in the
  ambient environment under a fixed name.
- **What this does not do**: it does not verify the token (a wrong token still fails at the host), it does
  not manage rotation, and `forgejo` still discovers a missing token late — deliberately, because a
  Forgejo host may legitimately accept an unauthenticated request.

## Evidence (RED then GREEN)

- RED: `delivery-token.test.ts` — `error: 'Missing expected rejection.'` (a missing token was NOT refused
  before the run) and `github: unknown option "tokenEnv" — this adapter reads repo, apiBase, remote`.
- GREEN: the same file 5/5; `@takumi/cli` **169 tests, 169 pass, 0 fail**. The two tests that pinned the
  LATE failure (`run: a configured github/gitlab delivery reaches ctx.delivery`) were rewritten into a
  pair each: the run is refused up front naming the variable, and — with a token — the run reaches
  `publish` and the failure is the HOST's, which is how `ctx.delivery` is still proven to be the provider
  the config selected.
- Real machine: the 2026-10-11 16:38 run's failure (`no request transport configured`) is now unreachable
  from the CLI: the same command with no `GITHUB_TOKEN` refuses before the run.
