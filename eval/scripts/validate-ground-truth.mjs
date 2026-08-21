#!/usr/bin/env node
/**
 * Validate that every eval fixture's hidden ground-truth tests are effective:
 *   - BUG implementation  → hidden tests FAIL (catch the bug)
 *   - CORRECT implementation → hidden tests PASS
 *
 * Run: node eval/scripts/validate-ground-truth.mjs
 */
import { cpSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const FIX_ROOTS = [join(import.meta.dirname, '..', 'fixtures', 'ts'), join(import.meta.dirname, '..', 'fixtures', 'hard')];
const CORRECT_CODE = {
  'even': `export function sumEven(numbers) {\n  return numbers.reduce((acc, n) => (n % 2 === 0 ? acc + n : acc), 0);\n}\n`,
  'money': `export function formatMoney(n) {\n  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });\n}\n`,
  'flatten': `export function flatten(nested) {\n  return nested.flat(1);\n}\n`,
  'sort': `export function sortDesc(numbers) {\n  return [...numbers].sort((a, b) => b - a);\n}\n`,
  'counter': null, // implementation already correct — task is to write tests
  'api': `export async function getUser(id, fetchFn = fetch) {\n  const res = await fetchFn('https://api.example.com/users/' + id);\n  if (!res.ok) throw new Error('not found');\n  return res.json();\n}\n`,
  // hard
  'order': `export function applyDiscount(price, discountPercent) {\n  return price * (1 - discountPercent / 100);\n}\nexport function calculateTotal(items) {\n  return items.reduce((sum, it) => sum + applyDiscount(it.price, it.discount), 0);\n}\n`,
  'password': `export function isValidPassword(pw) {\n  if (typeof pw !== 'string' || pw.length < 8) return false;\n  if (!/[A-Z]/.test(pw)) return false;\n  if (!/[a-z]/.test(pw)) return false;\n  if (!/[0-9]/.test(pw)) return false;\n  if (pw.toLowerCase().includes('password')) return false;\n  return true;\n}\n`,
  'integration': `export const records = [];\nexport function saveRecord(record) {\n  records.push(record);\n  return true;\n}\n`,
  'parse': `export function parseInput(raw) {\n  if (raw === '' || raw === null || raw === undefined) return 'invalid';\n  const n = Number(raw);\n  return Number.isNaN(n) ? 'invalid' : n;\n}\n`,
};
const SRC_FILE = {
  'even': 'src/even.js', 'money': 'src/format.js', 'flatten': 'src/flatten.js',
  'sort': 'src/sort.js', 'counter': null, 'api': 'src/api.js',
  'order': 'src/order.js', 'password': 'src/validate.js', 'integration': 'src/db.js',
  'parse': 'src/legacy.js',
};

function runHidden(fixture, applyFix) {
  const wd = join(tmpdir(), `gt-${applyFix ? 'fix' : 'bug'}-${fixture}`);
  rmSync(wd, { recursive: true, force: true });
  // Find the fixture in either root (ts/ or hard/)
  const srcRoot = FIX_ROOTS.find((r) => existsSync(join(r, fixture)));
  if (!srcRoot) { console.log(`  !! fixture not found: ${fixture}`); return { pass: false, failCount: 1 }; }
  cpSync(join(srcRoot, fixture), wd, { recursive: true });
  // Apply fix BEFORE install (if requested)
  if (applyFix && CORRECT_CODE[fixture] && SRC_FILE[fixture]) {
    writeFileSync(join(wd, SRC_FILE[fixture]), CORRECT_CODE[fixture]);
  }
  // Move hidden tests into test/ (independent ground truth)
  const hiddenDir = join(wd, 'test', '.hidden');
  if (existsSync(hiddenDir)) {
    for (const f of readdirSync(hiddenDir)) {
      cpSync(join(hiddenDir, f), join(wd, 'test', f));
    }
  }
  try { execFileSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: wd, stdio: 'pipe' }); } catch {}
  try {
    const out = execFileSync('npm', ['test'], { cwd: wd, encoding: 'utf8' });
    const fail = (out.match(/# fail\s+(\d+)/) ?? [])[1];
    return { pass: fail === '0', failCount: Number(fail ?? 1) };
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    const fail = (out.match(/# fail\s+(\d+)/) ?? [])[1];
    return { pass: false, failCount: Number(fail ?? 1) };
  }
}

console.log('Validating ground truth for all fixtures...\n');
const allFixtures = FIX_ROOTS.flatMap((r) => readdirSync(r));
for (const fixture of allFixtures) {
  const bugResult = runHidden(fixture, false);
  const fixResult = runHidden(fixture, true);
  // counter task: implementation is already correct; ground truth must PASS on
  // bug state (since the bug is "no tests written"). So for counter, "bug"
  // means hidden tests fail only if agent wrote nothing — but agent writes
  // tests; the ground truth checks the counter WORKS. Treat counter specially:
  // hidden tests must pass on the given implementation.
  const bugCatches = fixture === 'counter' ? bugResult.pass : bugResult.failCount > 0;
  const fixPasses = fixResult.pass;
  const ok = bugCatches && fixPasses;
  console.log(`${fixture.padEnd(9)} bug→${bugCatches ? (fixture === 'counter' ? 'PASS(impl ok ✓)' : 'FAIL(caught ✓)') : '??'}  fix→${fixPasses ? 'PASS ✓' : 'FAIL ✗'}  ${ok ? 'OK' : '!! GROUND TRUTH BROKEN'}`);
  rmSync(join(tmpdir(), `gt-bug-${fixture}`), { recursive: true, force: true });
  rmSync(join(tmpdir(), `gt-fix-${fixture}`), { recursive: true, force: true });
}
