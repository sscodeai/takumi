# Bug ledger

Every defect found while building the board and delivery layers, with the symptom,
the root cause, the fix and the test that fails if it comes back. The commit labels
are the index; this file is the record, because two of these fixes were discovered
while building a feature and therefore live inside a `feat`/`refactor` commit whose
label does not say "bug".

Rule going forward: **a found defect gets its own `fix(scope):` commit**, never
folded into the feature commit that happened to be open when it was noticed — a
fix hidden inside `feat` is invisible to `git log --grep '^fix'`, to a release
note, and to whoever wonders later whether this class of bug was ever hit.

| # | Symptom | Root cause | Fix | Commit | Regression test |
|---|---|---|---|---|---|
| 1 | A board credential (`GITHUB_TOKEN`, `GITLAB_TOKEN`, …) was visible in `ps` while a request ran | The curl transport passed `-H "Authorization: Bearer …"` on the argv | Headers, body and URL moved into a `curl -K -` stdin config; only non-sensitive flags stay in argv | `26fb897` | `packages/core/src/test/board-transport.test.ts` asserts the token and the host are NOT in argv, and that a malicious header value cannot inject a second `url =` line |
| 2 | Four of the five board providers could not be discovered at all (`discoverExtensions` returned one board) | Their `manifest.yaml` never landed on disk: the writer validated the YAML, the unquoted `: ` in a `description` made it invalid, and the failure was swallowed while a normal path was returned | The four missing manifests written (GitLab's already existed) and verified on disk, plus a discovery test asserting every board is found by its manifest | `85409c3` | `apps/cli/src/test/board.test.ts` — "a board provider is found by its manifest" |
| 3 | A Redmine board showed `0 item(s)` while the instance held two issues | `listWork` swallowed (and dropped) any issue whose status the `statusMap` did not cover, so a missing mapping was indistinguishable from an empty queue | An unmapped status is now reported once, naming the statuses, an example issue, the fix and the statuses the instance actually has; `toWorkItemOrNull` deleted | `efe4d67` | `boards/redmine/src/test/redmine-board.test.ts` — "/\"Triage\" map to no delivery state/"; the mapped-but-unwanted case asserts a plain filter, no error |
| 4 | A delivery that could not be merged had nowhere to go: the item stayed in `pr_open` forever (review rounds exhausted, host refusing a conflicting head, base branch reconfigured) | The six-state transition table had no `pr_open → blocked` edge, so the only legal moves out of an open pull request were `merged` and `fix_needed` | The edge was added, documented in ADR-006, and the loop now blocks there when its round budget runs out | inside `c6b590f` (`feat(core): run the two ports as a delivery loop`) — **should have been its own `fix`** | `packages/core/src/test/board-state.test.ts` — "an open pull request can still be blocked" |
| 5 | A progress comment could carry a run marker that no reader could ever find; and a malformed run id escaped as a bare `Error` | Five adapters each had their own copy of the marker string, none of which validated the id, while the reader matches exactly eight lowercase hex characters; core's shared implementation validated but threw an unclassified `Error` | All boards call core's `renderRunMarker`; a malformed id fails as a classified `precondition`, surfaced through each port's own error family (`BoardError`) | inside `1056445` (`refactor(boards): one run-marker implementation…`) — **should have been its own `fix`** | `packages/core/src/test/run-marker.test.ts` asserts `ProviderError` + `kind === 'precondition'`; `boards/*/src/test/*` assert the marker string through the port |

| 6 | Every event was stored TWICE in the trail (the first test that read the trail back saw two copies of each) | The default sink appended to the same array `retain` appended to, so two mechanisms that each looked correct alone both ran | The default sink now writes nowhere; retention is the explicit push | inside `3a74c9d` (`feat(core): the pilot safety rails…`) — **should have been its own `fix`** | `packages/core/src/test/events.test.ts` — "records a known event with its timestamp, run id and message" |
| 7 | A message containing a newline came back from the log with an escaped backslash (`line one\\nline two` instead of a real newline) | Pre-escaping newlines before `JSON.stringify`, which escapes them anyway: the value was escaped twice and no longer round-tripped | The pre-escaping was removed; JSON guarantees the single line, and the value survives exactly | inside `3a74c9d` — **should have been its own `fix`** | `packages/core/src/test/events.test.ts` — "one line, stable key order, and a message that round-trips" |

## Classes worth remembering

- **Silent drop** (#3): a filter that cannot be honoured must fail, not shrink the
  result set. An empty queue and a misconfigured queue must never look alike.
- **Missing edge** (#4): a state machine without an escape hatch from a
  non-terminal state is a stall waiting to happen. Every non-terminal state needs a
  path to `blocked`.
- **Unattributable artefact** (#5): anything written for a machine reader must be
  validated by the writer. A marker that no reader can parse is worse than no
  marker, because it looks like evidence.
- **Swallowed failure** (#2): a helper that returns a normal-looking result after
  failing is how four manifests went missing while five reports said "written".
- **Two mechanisms, one effect** (#6): a default and an explicit path that both do
  the same thing look correct in isolation and duplicate in practice. Make one of
  them a no-op instead of assuming they are mutually exclusive.
- **Escaping twice** (#7): hand-rolling an escape that the serialiser already
  applies silently corrupts the value. Round-trip the value in a test, or do not
  escape at all.
