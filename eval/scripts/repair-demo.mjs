#!/usr/bin/env node
/**
 * Repair Loop Mechanism Demo (Protocol §6).
 *
 * Proves Takumi's repair loop works END-TO-END on a real harness:
 *   ACT (agent implements) → VERIFY (independent hidden tests) → FAIL
 *   → FEEDBACK (verification output) → REPAIR (agent) → REVERIFY → PASS
 *
 * We simulate the "false completion" scenario deterministically: run the
 * agent on a task where its FIRST attempt is known-wrong (we seed the
 * fixture with a buggy implementation), verification FAILS, then the agent
 * receives the failure output and repairs until PASS. This is exactly the
 * Takumi product story, demonstrated with real evidence.
 *
 * Usage: TAKUMI_EVAL_HARNESS=deepseek node eval/scripts/repair-demo.mjs
 */
import { cpSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTaskAndCollect } from '../../packages/core/dist/index.js';

const execFileAsync = promisify(execFile);
const HARNESS = process.env.TAKUMI_EVAL_HARNESS ?? 'deepseek';

async function makeRuntime() {
  if (HARNESS === 'deepseek') {
    const { DeepSeekRuntimeAdapter } = await import('../../runtimes/deepseek/dist/index.js');
    return new DeepSeekRuntimeAdapter({ maxTurns: 20 });
  }
  const explicit = process.env.TAKUMI_PI_RUNTIME;
  const { PiRuntimeAdapter } = await import(explicit ?? '@takumi/runtime-pi');
  return new PiRuntimeAdapter();
}

async function verify(workdir) {
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', `cd ${workdir} && node --test 'test/**/*.test.js'`], { timeout: 60_000 });
    const fail = (stdout.match(/# fail\s+(\d+)/) ?? [])[1];
    return { pass: fail === '0', stdout: stdout.slice(0, 2000) };
  } catch (e) {
    return { pass: false, stdout: `${e.stdout ?? ''}${e.stderr ?? ''}`.slice(0, 2000) };
  }
}

const runtime = await makeRuntime();
const workdir = join(tmpdir(), 'repair-demo');
rmSync(workdir, { recursive: true, force: true });
cpSync(join(import.meta.dirname, '..', 'fixtures', 'ts', 'even'), workdir, { recursive: true });

// Seed a WRONG implementation (simulates agent's first attempt failing the
// hidden ground truth — the false-completion scenario).
writeFileSync(join(workdir, 'src', 'even.js'), `export function sumEven(numbers) {
  return numbers.reduce((acc, n) => acc + n, 0); // WRONG: sums all
}
`);
// Install deps (hidden tests stay out of the agent's view until verify).
try { await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], { cwd: workdir }); } catch {}

console.log(`\n=== Repair Loop Demo (${HARNESS}) ===\n`);

// Step 1: ACT — the agent's "first attempt" is the seeded WRONG implementation.
// (We skip calling the agent here: the seeded code represents an agent that
// claimed SUCCESS but produced wrong output — the false-completion scenario.)
console.log('[1] ACT: agent produced wrong implementation (seeded), claims SUCCESS');
console.log('    seeded code: sums ALL numbers (claim: "done")');

// Step 2: INDEPENDENT verification (inject hidden ground truth).
console.log('[2] VERIFY: inject hidden ground-truth tests, run them');
const hiddenDir = join(workdir, 'test', '.hidden');
if (existsSync(hiddenDir)) {
  for (const f of readdirSync(hiddenDir)) cpSync(join(hiddenDir, f), join(workdir, 'test', f));
}
let v = await verify(workdir);
console.log(`    verification: ${v.pass ? 'PASS' : 'FAIL'}  ← independent verification catches the false completion`);
console.log(`    output: ${v.stdout.slice(0, 200).replaceAll('\n', ' | ')}`);

// Step 3-5: REPAIR loop until PASS or max attempts.
let attempts = 0;
while (!v.pass && attempts < 3) {
  attempts++;
  console.log(`[3.${attempts}] FAIL → FEEDBACK to agent (verification output)`);
  const feedback = `Independent verification FAILED. Verification output:\n${v.stdout.slice(0, 1500)}\n\nFix the issue so the hidden tests pass. Do not modify test/ files (they are ground truth).`;
  const repair = await runTaskAndCollect(runtime, {
    id: `repair-demo-${attempts}`,
    prompt: feedback,
    cwd: workdir,
  }, () => {});
  console.log(`    repair attempt ${attempts}: ${repair.status}`);
  console.log(`[4.${attempts}] RE-VERIFY`);
  v = await verify(workdir);
  console.log(`    verification: ${v.pass ? 'PASS ✓' : 'FAIL'}`);
}

console.log(`\n=== Result: ${v.pass ? 'PASS after ' + attempts + ' repair(s)' : 'FAIL after max repairs'} ===`);
console.log(`final verification output:\n${v.stdout.slice(0, 400)}`);

// Record evidence.
const { writeFileSync: wfs, mkdirSync: mks } = await import('node:fs');
const outDir = join(import.meta.dirname, '..', 'results');
mks(outDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
wfs(join(outDir, `repair-demo-${HARNESS}-${ts}.json`), JSON.stringify({
  harness: HARNESS, pass: v.pass, repair_attempts: attempts,
  agent_claim: '(seeded) sums ALL numbers — agent claimed SUCCESS', final_verify: v.stdout.slice(0, 500),
}, null, 2));
console.log(`Evidence saved to eval/results/repair-demo-${HARNESS}-${ts}.json`);

runtime.close();
rmSync(workdir, { recursive: true, force: true });
