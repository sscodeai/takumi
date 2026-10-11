# ADR-043: An explicit null in takumi.local.yaml clears an inherited key

Status: accepted (implemented in `apps/cli/src/commands.ts`)
Related: ADR-007 (the delivery port) — the config that names the provider and its endpoint

## Context

`takumi.yaml` is the SHAREABLE example: it names placeholder hosts (`forgejo.internal.invalid`). An
operator keeps the real endpoints in `takumi.local.yaml` (gitignored), merged OVER the committed file
before the config is used. The merge is PER KEY: objects merge recursively, scalars and arrays are
replaced by the local value, and OMITTING a key leaves the committed value in place.

That last property is right for "change one thing" and a trap for "remove one thing". Two live runs (i16,
i17) failed closed at the worktree-clone step against the committed Forgejo placeholder `apiBase`: the
operator had switched the provider to `github` and wrote a local file WITHOUT `apiBase`, believing the
omission dropped it — and inherited the placeholder instead, because omitting a key does not clear it
(docs/bugs-fixed.md #47). The run also printed only "local override applied", so the transcript did not
say which values were the committed ones.

## Decision

1. **An explicit `null` CLEARS the key.** In the local file, `apiBase: null` removes `delivery.apiBase`
   from the merged config entirely — the key is ABSENT, not `null`-valued — so nothing (a placeholder, or
   a provider default a leftover value would shadow) survives behind the operator's back. `null` is how
   one says "there is no such key", which YAML already spells naturally as a bare `apiBase:`.
2. **Omitting a key still inherits it.** The per-key merge is unchanged for every key the local file does
   not mention; only an explicit `null` removes one. The two intents are now distinguishable in the file
   itself rather than only in the operator's head.
3. **The loader reports WHICH keys the override set or cleared.** The single line it already printed
   (exactly one, naming the file — kept) now also names the keys: `set delivery.provider, delivery.repo;
   cleared delivery.apiBase`, or `no keys changed`. A run's transcript then records not only that the
   effective config was not the committed one but which parts of it came from where.

## Consequences

- A local override can now express both "change this" and "drop this", and the dropped key really leaves
  the config: `apiBase: null` yields the provider's own git host rather than an inherited endpoint.
- The report is a list of dotted paths, sorted within each kind, so two runs with the same local file
  print the same line.
- The line stays a SINGLE line: the "exactly one line" property (a transcript marker that the effective
  config is not the committed one) is preserved, with the detail appended.
- Nothing else changed: a local file that names only the one endpoint it wants to change still keeps the
  rest of the committed section, and a local file that cannot be read as a mapping still fails loudly.

## Evidence

- `apps/cli/src/commands.ts`: `mergeConfigWithChanges` / `mergeInto` (the `null` → delete rule, with the
  change list), `mergeConfig` (unchanged signature, now the plain entry point), `describeOverrideChanges`,
  and `loadConfig`'s one-line report.
- `apps/cli/src/test/local-override.test.ts`: `apiBase: null` clears the inherited placeholder (the key is
  ABSENT) while the rest of the section survives and the line names both the set and the cleared key; a
  two-key override prints every changed key, sorted; an empty override (`{}`) changes nothing and says
  `no keys changed`; and the pre-existing cases (override one key, inherit the rest, malformed file fails
  loudly, no local file is silent) are unchanged.
