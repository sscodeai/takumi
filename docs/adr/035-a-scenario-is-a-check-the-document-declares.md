# ADR-035: a scenario is a check the document declares

Status: accepted (implemented; `packages/core/src/test/judge-forge-scenarios.test.ts`)
Related: ADR-025 (the acceptance is bound to the confirmed document), ADR-026 (the judge is forged outside
the implementer's context), ADR-031 (a decision says what it means to a judge), ADR-033 (the document
declares the world its judge checks)

## Context

Everything a forged judge could check until now was arithmetic over the deliverable's OUTPUT: rows
reshuffled, parts summed against the whole, repeated keys resolved, malformed rows accounted for, an
independent recomputation compared. Nothing could check the thing a person actually looks at — a page, a
CLI session, a service answering — and that is the half of "the delivery works" a human ends up verifying
by hand, which is exactly what the black-box mode exists to avoid.

The tempting move is to embed a browser. It is the wrong one for three reasons: the judge would stop being
independent of a large piece of third-party machinery; a headless browser needs a display stack, a
download or a container, so the judge would stop being something a shell script can run anywhere; and a
judge that talks to a real browser is a judge that can be made to pass by a page that looks right.

## Decision

A document may declare **scenarios**, and the judge runs them with the commands the document names:

```yaml
deliverable:
  scenarios:
    - id: SCN-001
      run: "bash e2e/check.sh"                    # required: exits 0 when the scenario holds
      expect: "the page lists one row per station" # required: the criterion in the human's words
      start: "python3 -m http.server 8731 -d site" # optional: the judge starts it
      url: "http://127.0.0.1:8731/index.html"      # optional: the judge waits for it before running
      report: ctrf                                 # optional: ctrf | junit | tap
      report_path: "e2e/report.json"                # required when `report` is given
      timeoutMs: 30000                              # optional
      decides: AMB-00n                              # optional: the decision this scenario settles
```

1. **The document's commands are the check.** A scenario is a `browser-scenario` relation in the
   vocabulary: it joins the same dispatch list as every other relation, so it is refused when undeclared,
   reported with its own `SCN-nnn` id against the `expect` the document wrote, bound to a decision when it
   says `decides:`, and reported as a `DEC-nnn` line exactly as a relation is.
2. **The judge brings the surface up and always takes it down.** `start` runs in the delivery worktree in
   its OWN process group (`setsid`), `url` is waited for with a bounded retry loop, and every path out of
   the judge — success, failure, timeout, or the exit trap — kills the group (TERM then KILL). A leaked
   server would answer the NEXT run's scenario, which is how a self-healing check silently becomes a check
   that always passes.
3. **Exit code and report are both evidence.** A non-zero exit fails the scenario, naming the code and the
   tail of the command's own output. An exit of 0 with a declared report fails when the report says a test
   failed (CTRF `"failed"` counters, JUnit `failures="N"`, TAP `not ok` lines) — the report is the
   evidence, not the exit code. **A report the judge cannot read (missing, unparseable, unknown shape)
   fails, naming the path**: a mutation check that could not run is never a pass.
4. **The front door refuses what cannot be judged** (before a human confirms, and again in
   `confirm --dry-run`): a scenario with no `run` or no `expect`; `report` without `report_path` or the
   reverse; a `report` outside the three formats; `url` with nothing to `start`; ids that are not
   `SCN-nnn` in order; an empty `scenarios:` list; a scenario settling a decision the document does not
   contain; a scenario id colliding with a relation id; a `timeoutMs` below a second.

## Consequences

- A black-box delivery can now be judged on a surface a person would otherwise have to open — without a
  browser in the judge, and without trusting a tool's exit code alone.
- The scenario is as strong as the command the document declares. A `run` that asserts nothing (bare
  `exit 0`) is worth nothing, and the structure cannot tell you that; it can only refuse a scenario that
  declares no command or no report. Documents should therefore have few scenarios, each naming the one
  thing a human would check.
- External E2E tools fit here without being trusted: Playwright, Midscene or a hand-written curl script are
  all "a command that exits 0 and writes a report", and the quality gate already reads CTRF (this is the
  seam the E2E research identified: the report format is the integration point, not the tool).
- A scenario costs a real server and a real wait, so it is the only relation with a startup failure mode:
  `wait_for_url` gives the surface 20 seconds, and the judge says so by name when it never answered.

## Evidence

`packages/core/src/test/judge-forge-scenarios.test.ts` (6 tests, real scripts, real HTTP surface):

- a passing scenario against the criterion the document wrote → `ok N - SCN-001 the summary page answers…`;
- a command exiting 3 → `not ok … — the scenario command exited 3: the page is missing the station table`;
- exit 0 with a CTRF report counting one failure → `not ok … — the CTRF report says 1 failing test(s)`;
- a declared JUnit report that does not exist → `not ok … — the report … report.xml does not exist`;
- `start` + `url` (a real `python3 -m http.server`) → `ok`, and `ps` finds NO leftover process afterwards;
- a scenario with no `run` → the forge refuses and no judge is written at all.

Hand-proven on the same forge build: `fd`-verified scenario run against a real `http.server` with a real
`curl` probe, and the process check (`ps -eo args | grep http.server`) empty after the run.
