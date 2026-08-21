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

const FIX_ROOTS = [join(import.meta.dirname, '..', 'fixtures', 'ts'), join(import.meta.dirname, '..', 'fixtures', 'hard'), join(import.meta.dirname, '..', 'fixtures', 'trap'), join(import.meta.dirname, '..', 'fixtures', 'noselftest'), join(import.meta.dirname, '..', 'fixtures', 'complex')];
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
  // trap
  'process': `export function processItems(items) {\n  const sorted = [...items].sort((a, b) => {\n    const rank = (x) => (x < 0 ? 0 : x === 0 ? 1 : 2);\n    return rank(a) - rank(b) || a - b;\n  });\n  return sorted;\n}\n`,
  'encode': `export function encode(input) {\n  return input.split('').map((c) => c.charCodeAt(0).toString(16)).join('-');\n}\n`,
  'deep': `export function deepEquals(a, b) {\n  if (a === b) return true;\n  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;\n  if (Array.isArray(a) !== Array.isArray(b)) return false;\n  if (Array.isArray(a)) {\n    if (a.length !== b.length) return false;\n    return a.every((v, i) => deepEquals(v, b[i]));\n  }\n  const ka = Object.keys(a); const kb = Object.keys(b);\n  if (ka.length !== kb.length) return false;\n  return ka.every((k) => deepEquals(a[k], b[k]));\n}\n`,
  // noselftest
  'csv': `export function parseCsv(text) {\n  const rows = [];\n  let row = [];\n  let field = '';\n  let inQuotes = false;\n  const s = text.replace(/\\r\\n/g, '\\n');\n  for (let i = 0; i < s.length; i++) {\n    const c = s[i];\n    if (inQuotes) {\n      if (c === '"') {\n        if (s[i + 1] === '"') { field += '"'; i++; }\n        else inQuotes = false;\n      } else field += c;\n    } else if (c === '"') inQuotes = true;\n    else if (c === ',') { row.push(field); field = ''; }\n    else if (c === '\\n') { row.push(field); rows.push(row); row = []; field = ''; }\n    else field += c;\n  }\n  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }\n  return rows;\n}\n`,
  'dates': `export function daysBetween(a, b) {\n  const [ay, am, ad] = a.split('-').map(Number);\n  const [by, bm, bd] = b.split('-').map(Number);\n  const d1 = Date.UTC(ay, am - 1, ad);\n  const d2 = Date.UTC(by, bm - 1, bd);\n  return Math.round((d2 - d1) / 86400000);\n}\n`,
  'url': `export function normalizeUrl(raw) {\n  const u = new URL(raw);\n  u.hostname = u.hostname.toLowerCase();\n  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {\n    u.port = '';\n  }\n  u.hash = '';\n  return u.toString().replace(/\\/$/, '');\n}\n`,
};
const SRC_FILE = {
  'even': 'src/even.js', 'money': 'src/format.js', 'flatten': 'src/flatten.js',
  'sort': 'src/sort.js', 'counter': null, 'api': 'src/api.js',
  'order': 'src/order.js', 'password': 'src/validate.js', 'integration': 'src/db.js',
  'parse': 'src/legacy.js',
  'process': 'src/process.js', 'encode': 'src/encoder.js', 'deep': 'src/deep.js',
  'csv': 'src/csv.js', 'dates': 'src/dates.js', 'url': 'src/url.js',
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
    let out;
    try {
      out = execFileSync('npm', ['test'], { cwd: wd, encoding: 'utf8' });
    } catch (e) {
      // fixture without a test script (no-self-test design) → run node --test directly
      out = execFileSync('node', ['--test', 'test/**/*.test.js'], { cwd: wd, encoding: 'utf8', shell: true });
    }
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
  // complex fixtures need multi-file fixes — validate only that the bug state
  // is CAUGHT (hidden tests FAIL on incomplete impl). Fix-state validation for
  // complex is done by the eval's repair loop itself.
  const isComplex = FIX_ROOTS.indexOf(FIX_ROOTS.find((r) => existsSync(join(r, fixture)))) === 4;
  const bugCatches = fixture === 'counter' ? bugResult.pass : bugResult.failCount > 0;
  const fixPasses = isComplex ? true : fixResult.pass;
  const ok = bugCatches && fixPasses;
  console.log(`${fixture.padEnd(9)} bug→${bugCatches ? (fixture === 'counter' ? 'PASS(impl ok ✓)' : 'FAIL(caught ✓)') : '??'}  fix→${fixPasses ? (isComplex ? 'multi-file (skip)' : 'PASS ✓') : 'FAIL ✗'}  ${ok ? 'OK' : '!! GROUND TRUTH BROKEN'}`);
  rmSync(join(tmpdir(), `gt-bug-${fixture}`), { recursive: true, force: true });
  rmSync(join(tmpdir(), `gt-fix-${fixture}`), { recursive: true, force: true });
}
