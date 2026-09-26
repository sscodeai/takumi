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

| 8 | An item could be left CLAIMED by a run that had stopped — not waiting, not retrying: invisible, because the runner only ever selects `ready` items | On a pending check the loop returned `retriable` and left the item owned; on a transport failure after the claim it did the same. The comment claimed "another tick will read it again", and no tick ever did | Checks are now WAITED for inside the tick (bounded, poll-counted), and any failure after the claim blocks the item with the instruction that resumes it — a state a human can see and act on | `e15c62b` (`fix(core): an item we own is never parked where automation cannot find it`) | `packages/core/src/test/delivery-loop.test.ts` — "pending checks are waited for INSIDE the tick", "checks that never settle block the item", "a retriable failure still refuses to strand the item" |
| 9 | A claim held by a process that was killed stayed claimed for ever, and the item was invisible to the next ticks | Automation had no way back: nothing selects a `claimed` item, and the claim cannot be re-taken by a different run id | Each tick now SWEEPS the in-flight items: it reports them (`pilot.in_flight`), and with `blockStaleClaims` opted in it hands a stale claim back to a human — the proof being the SLOT it had to take, and the action being `blocked`, never a silent takeover | `e15c62b` (sweep), `packages/core/src/test/pilot.test.ts` — "a stale claim is handed to a human", "a fresh claim is reported but never touched", "an open pull request is never swept" |

| 10 | `pilot.metricsFile` was read from takumi.yaml and never written; the pacing knobs (`checksWaitSeconds`, `blockStaleClaims`, …) were accepted and dropped on the floor | The command built a `PilotConfig` from the file field by field, and the later fields were simply not in the list — while the pilot never handed those policy fields to the loop either | Every field is now passed, and the wiring is covered by a test that drives the real command: the metrics file must EXIST, and a policy budget must appear as the number in the block message | `ada3262` (`fix(cli): the pilot command read options it never passed on`) | `apps/cli/src/test/run.test.ts` — "the pilot section of takumi.yaml is wired through, metrics included"; `packages/core/src/test/pilot.test.ts` — "the policy's pacing knobs reach the delivery loop" |

| 11 | The same `pilot.policy.scopeQuery` behaved differently on each board: a whitespace-only scope was DROPPED on GitLab/Notion (returning the whole board while looking scoped), REFUSED on Jira, and a double quote in the term was silently STRIPPED on GitHub | Each adapter had decided for itself what an unrepresentable scope means, and each decision looked defensible alone; the rule was never stated once | `assertScopeQuery` in core states the rule (carry the scope faithfully or refuse it) and every adapter calls it; the contract suite now asserts, per adapter, that a blank scope fails `precondition` and that a quoted term is either refused or narrowed faithfully — never widened | `a18b7f5` (`fix(boards): one scope rule in core, enforced on every adapter`) | the shared suite's `scopeValidation: PASS` note, plus `boards/{gitlab,notion}/src/test/*` where the tests that encoded the old behaviour now assert the refusal |

| 12 | The shipped `examples/openhands-agent.sh` was committed mode 100644, so `pilot.agent.command` — which starts the file directly — failed with `spawn ... EACCES`; the OpenHands integration could never have run from the documentation | The example was written by a tool that creates files 644 and committed without a mode check, and no test starts the shipped file: the suite builds its own agent commands | The executable bit is now committed (git tracks it, so a plain `chmod` would leave the defect for the next clone), and the first real pilot run against gitlab.com is what found it | `bf24a9a` (`fix(examples): the OpenHands agent command was not executable`) | the real run: `retriable 1: ... spawn ... EACCES` → `blocked` with "no runner can resume a held claim", plus the state record and `takumi-blocked` label landing on the real issue |

| 13 | The GitLab delivery adapter read the commit-statuses endpoint's 404 as `not_found`, while gitlab.com answers **404 for a commit that exists and has no statuses** — so on a project with no CI/CD a real, mergeable merge request was blocked and left unmerged | The offline double answered `200 []` where the host answers 404, so the fallback branch had never once been exercised against the response a real instance sends; the adapter had no way to tell "nothing published" from "unknown commit" | The two facts are separated: on a 404 from `/commits/:sha/statuses`, the adapter asks the host about the commit (`/repository/commits/:sha`) — commit exists ⇒ an empty check list ("no checks reported"), commit unknown ⇒ the original `not_found` stands. The double now answers 404 like the host, and both directions are tested | `40ee497` (`fix(deliveries/gitlab): a commit with no statuses is not an unknown commit`) | first real run against gitlab.com: `blocked 1: list the commit statuses of fe6ff94… failed with HTTP 404`, with MR !1 open and mergeable on the instance |

| 14 | A run that claimed an item and then died left the item **unrecoverable**: every adapter refused a later claim whenever ANY state record named another run — checked BEFORE the board's own state — so the operator's documented recovery ("move it back to ready") changed nothing and only hand-deleting takumi's note could unstick it | The record was treated as a lock rather than as evidence: five adapters each decided that order for themselves, and every one of them looked defensible alone (the ledger's #11 pattern, this time with a way out missing) | The rule is stated once in core (`decideClaim`): the board's STATE decides whether an item is held, the record only says who worked it last; all six implementations call it, a takeover is reported (`takeoverFrom`) and written into the record, and the shared suite asserts the recovery path for every board — NOT_RUN where a board keeps no records | `7cf6599` (`fix(boards): the board's state decides a claim, not a dead run's record`) | the first real run: `claim refused: issue 1 is already claimed by run fc936000 (state record on the board)` after following the block message's own instruction; the fix was then exercised against gitlab.com |

| 15 | Reading mergeability ONCE treated an asynchronous host's "not computed yet" as a verdict: GitLab answers `mergeable: null` for a moment after a merge request opens, so a finished, reviewed delivery was returned as `retriable` — which left the item in `pr_open`, where the pilot (which selects `ready` work) never looks again. A transient hiccup at merge time stranded the delivery silently | The host was treated as synchronous; and `retriable` was used where the pending-checks path already refuses to use it, so the same "an item left in review is a silent stall" principle had two different behaviours | The unknown is re-read inside a bounded window (5 reads, 3s apart, head re-verified on every attempt, each wait visible as `merge.mergeability_waited`), and a window that ends still ends in "no" — the item is BLOCKED with the way back in its comment, which the claim fix now honours | `0aed164` (`fix(core): an asynchronous "mergeability unknown" is waited for, then blocked visibly`) | the real run: `retriable 2: mergeability is not known yet — an unknown is not a yes`, issue 2 left at `takumi-pr-open` with MR !3 open and nobody to finish it |

| 16 | A delivery that REUSED an existing pull request in round 0 never moved the item to `pr_open` — the loop read that off `delivered.created` — so the merge that followed was refused as an illegal transition (`claimed → merged`) and the item blocked on the state machine instead of on anything real | The post-delivery state was derived from who opened the pull request rather than from what the item IS (delivered and under review); every path that created its own pull request hid it, and the only paths that reuse one are round-0 re-runs and resumes — neither of which existed when the line was written | The rule reads the state itself: after delivering, an item not already in `pr_open` is moved there, and one already there is left alone | `37ead68` (`fix(core): a reused delivery in round 0 never reached pr_open, so it could not merge`) | the resume test in the CLI, on a real repository: `illegal board transition claimed → merged: allowed from claimed: pr_open, blocked` |

| 17 | A RESUMED tick's event trail announced `agent.started` / `agent.finished` for an agent that never ran: the branch history held no commit that tick could have made, so the log — the artefact whose purpose is to be the record — described a run that did not exist | The loop emitted those two events unconditionally around the agent hook, and the CLI's hook returns immediately when the run is finishing an existing delivery (ADR-014). The hook knew; the loop did not; so the narration described a STEP instead of a FACT | The plan carries `resumed`; a resumed round 0 runs no agent and reports `agent.skipped`, naming where the work already is. A LATER round of the same run still runs the agent — the fix round after findings is work that does not exist yet | `1ba710b` (`fix(core): a resumed run must not report an agent it did not run`) | `packages/core/src/test/delivery-loop.test.ts` — "a resumed round 0 runs NO agent, and the trail says so instead of claiming one"; "a FIX round inside a resumed run DOES run the agent" |

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
- **A comment describing behaviour nobody implements** (#8): "another tick will read
  it again" was true of no code path. A comment is not a mechanism; if a state is
  meant to be picked up later, the test must show the pick-up happening.
- **A state automation cannot return from** (#9): before adding a state, ask which
  code path selects it. `claimed` was selected by nothing, so a claim left by a dead
  process was indistinguishable from a claim being worked on.
- **Configuration with no reader** (#10): a field parsed from a config file and never
  used is silence, not a default. Test the EFFECT of a setting (a file that must exist,
  a number that must appear), because a test that asserts the object was passed along
  passes whether or not anything downstream looks at it.
- **N implementations, N semantics** (#11): when an abstraction has several adapters, any
  rule left to each adapter drifts — and the drift is invisible until the same
  configuration meets two different boards. Put the rule in the shared layer and assert it
  per adapter in the contract suite.
- **The shipped artifact nobody starts** (#12): an example, script or config that the tests
  never execute is documentation that can be wrong forever. A file mode, a shebang, a flag —
  none of them are exercised by a unit test that builds its own version of the same thing.
- **The double that answers more kindly than the host** (#13): a fixture returning `200 []`
  where the real API returns `404` does not just fail to catch a bug, it certifies the wrong
  behaviour on every run. When a real host is finally used, every "impossible" branch the
  fixtures never produced is where the bugs are.
- **A state derived from an event instead of from the thing itself** (#16): "the pull request was
  created, so the item is under review" is true only while every delivery creates one. The moment
  a path reuses an existing pull request (a re-run, a resume) the derivation silently disagrees
  with reality — and the symptom appears somewhere else entirely, as an illegal transition.
- **A "no" that was a "not yet"** (#15): a transient, misunderstood as a verdict, both is wrong
  and — worse — gets recorded in a terminal-looking place (`retriable` on an item nothing
  re-selects). When a check refuses on an unknown, the refusal has to end somewhere a human or
  the next tick will look; a refusal that parks work where nothing looks is a silent stall with
  extra steps.
- **Evidence treated as a lock** (#14): a record that says "run X worked this" was read as "run
  X owns this", so the moment a run died the item could never be taken again — and the automated
  message told the operator to do something that could not work. When a message names a recovery
  path, that path is part of the contract and belongs in the shared suite; and a guard should be
  re-derived from the authority that owns the fact (here: the board's state), never from a
  byproduct of a previous attempt.
- **A step narrated as a fact** (#17): when a layer writes the record ("agent started"), it must know
  whether the step happened. Here the hook knew and the loop did not, so the trail described the
  shape of the code rather than the shape of the run — and it was found by reading the branch history
  against the log, not by any test. Anything that narrates a stage needs the stage's own condition
  passed to it, or a design in which skipping is impossible.
