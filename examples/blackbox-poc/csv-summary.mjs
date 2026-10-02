#!/usr/bin/env node
// A REFERENCE deliverable for the black-box acceptance PoC (ADR-026), NOT production code.
//
// It exists so a forged judge has something real to judge: the judge runs THIS file, from outside
// the worktree, against fixtures it generated itself. The sibling file `csv-summary-broken.mjs`
// carries one plausible defect (it averages the ROUNDED per-row salaries and then sums those
// averages), which is what the metamorphic relations exist to catch.
//
// Contract (from docs/requirements/poc-blackbox-acceptance.yaml):
//   run: node csv-summary.mjs <csv>
//   output: "<department> <count> <total> <average>" per department, then "SKIPPED <count>",
//           then "TOTAL <count> <total>"
// Chosen options: malformed rows are skipped and counted (AMB-001); a duplicate employee_id is
// resolved by the latest start_date (AMB-002); averages are rounded half-up with no currency (AMB-004).

import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('usage: csv-summary.mjs <csv>');
  process.exit(2);
}

const [header, ...lines] = readFileSync(path, 'utf8').split(/\r?\n/);
const columns = (header ?? '').split(',').map((c) => c.trim());
const need = ['employee_id', 'name', 'department', 'start_date', 'annual_salary'];
if (!need.every((c) => columns.includes(c))) {
  console.error(`the CSV must have the columns ${need.join(', ')}`);
  process.exit(2);
}
const at = (cells, name) => cells[columns.indexOf(name)];

let skipped = 0;
const byId = new Map();
for (const line of lines) {
  if (line.trim() === '') continue;
  const cells = line.split(',');
  const salary = Number(at(cells, 'annual_salary'));
  const start = at(cells, 'start_date');
  const id = at(cells, 'employee_id');
  const department = at(cells, 'department');
  const malformed = cells.length !== columns.length || !id || !department || !Number.isFinite(salary) || !/^\d{4}-\d{2}-\d{2}$/.test(start ?? '');
  if (malformed) {
    skipped += 1;
    continue;
  }
  // A duplicate id is resolved by the latest start_date (AMB-002: the chosen option).
  const previous = byId.get(id);
  if (previous === undefined || String(start) > String(previous.start)) {
    byId.set(id, { department, salary, start });
  }
}

const departments = new Map();
for (const row of byId.values()) {
  const current = departments.get(row.department) ?? { count: 0, total: 0 };
  // Round half-up per row, then sum the rounded salaries (AMB-004: no currency, half-up).
  current.count += 1;
  current.total += Math.round(row.salary);
  departments.set(row.department, current);
}

let overallCount = 0;
let overallTotal = 0;
for (const [department, { count, total }] of [...departments.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
  console.log(`${department} ${count} ${total} ${Math.round(total / count)}`);
  overallCount += count;
  overallTotal += total;
}
console.log(`SKIPPED ${skipped}`);
console.log(`TOTAL ${overallCount} ${overallTotal}`);
