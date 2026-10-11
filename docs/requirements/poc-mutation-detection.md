# Raw request: a station temperature summary whose OWN TESTS must be able to fail

I want the small command-line summary tool we keep rebuilding, but this time the point is the
test suite rather than the output.

The tool reads a CSV of daily temperature readings (`date,station,temperature_c`) and prints, for
each station, one line `<station> <count> <min> <max> <mean>` with the values rounded to one
decimal place, then a `TOTAL <count>` line. Rows that cannot be parsed must not crash the tool: they
are skipped, excluded from every aggregate, and reported on a `SKIPPED <count>` line. The mean is
rounded half away from zero.

What I actually care about is this: **the tests that ship with the tool must be able to fail.** A
green suite that would also be green for a wrong implementation is worthless, and that is exactly
the failure we have hit before — the tool ran, the tests passed, and they asserted nothing that a
wrong implementation would have contradicted.

So the delivery must include a mutation check: a tool that injects small faults into the delivered
source, runs the delivered tests against the broken copy, and reports the faults the tests did NOT
catch (the survivors). The acceptance must read that report and refuse the delivery when any
survivor remains: if the delivered tests cannot detect a deliberately broken implementation, the
green suite means nothing.

Notes for whoever writes the requirement document:
- the tool is the deliverer's choice, but the acceptance reads a report the document names, in a
  format it declares, against a declared survivor budget;
- a mutation run that could not run at all, produced no mutants, or wrote a report nobody can read
  must FAIL the acceptance, not pass it — "the check could not run" is never a green;
- the mutation check sits BESIDE the output checks (row-order invariance, additivity, malformed-row
  accounting, an independent recomputation), it does not replace them.
