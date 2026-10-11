# PoC fixture: employee CSV summary report

This file is a **PoC fixture** for the black-box acceptance flow. It is the
natural-language request fed to the `blackbox-acceptance` workflow's
`req_intake` step. It is deliberately under-specified so the intake step has
real ambiguity to surface.

The canonical requirement document format and location are **undecided** (see
open question 2 in `docs/design/blackbox-acceptance-scout.md`). This fixture is
an input request, not that canonical document.

## Request

We need a small command-line tool that reads a CSV export of employee records
and prints a summary report we can paste into a weekly status email.

Input columns are `employee_id,name,department,start_date,annual_salary`.
Example rows:

```csv
employee_id,name,department,start_date,annual_salary
1001,Ada Lovelace,Engineering,2021-04-01,120000
1002,Grace Hopper,Engineering,2019-11-15,135000
```

For each department the report must show the number of employees, the total
annual salary, and the average annual salary rounded to whole currency units.
It must also show the overall headcount and total salary.

The tool must run on a developer laptop with no services or network access.
It must be usable by any engineer on the team, and it must finish on a
50,000-row file in a few seconds.

## What is left open

The request above does not settle several decisions, and the tool's behaviour
changes depending on the answers:

- **Malformed rows.** Rows can have a missing column, a non-numeric
  `annual_salary`, or an unparseable `start_date`. It is not stated whether the
  tool should stop with an error, skip the bad row and report the count, or
  write the bad rows somewhere for later inspection.
- **Duplicate `employee_id`.** The export is known to occasionally contain the
  same employee twice, for example when someone changed departments mid-year.
  It is not stated whether the first row, the last row, or an error wins.
- **Output destination.** "Prints a summary report" could mean stdout only, or
  stdout by default with an optional file path argument. The weekly email
  workflow suggests a file might be wanted, but the request does not say.
- **Salary currency and rounding.** "Currency units" is not named, and it is
  not stated whether the average is rounded half-up or truncated before the
  per-department totals are summed.

A correct intake must turn each of these into a bounded choice with a default,
so a human can confirm the behaviour before any code is written.
