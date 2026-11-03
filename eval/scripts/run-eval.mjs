#!/usr/bin/env node
/**
 * Takumi Agent Eval runner (Protocol §2-§6).
 *
 * For each task:
 *   1. copy fixture → workdir, install deps
 *   2. agent executes (real harness: pi | deepseek)
 *   3. agent CLAIMS success (self-report captured verbatim)
 *   4. INDEPENDENT verification: move hidden ground-truth tests in, run verify
 *      command — actual exit code + stdout are the ground truth
 *   5. if FAIL → repair loop: feedback (verification output) → agent repairs →
 *      re-verify (up to max_repair_attempts)
 *   6. record: first-pass, claimed, false-completion, repair, final, latency,
 *      token usage (when available)
 *
 * Metrics definitions (Protocol §4):
 *   first_pass_rate   = tasks PASS at first verification / all tasks
 *   claimed_rate      = tasks agent claimed SUCCESS / all tasks
 *   false_completion  = (claimed SUCCESS AND verified FAIL) / claimed SUCCESS
 *   repair_success    = tasks that FAILED first verify then PASSED after repair
 *                       / tasks that entered repair
 *   final_success     = tasks PASS after all allowed repairs / all tasks
 *
 * Usage:
 *   TAKUMI_EVAL_HARNESS=deepseek node eval/scripts/run-eval.mjs [--tasks ts-*]
 *   TAKUMI_EVAL_HARNESS=pi node eval/scripts/run-eval.mjs
 * Env: COMMANDCODE_API_KEY (deepseek) / OPENCODE_GO_API_KEY (pi)
 *      TAKUMI_PI_RUNTIME (pi path)
 */
import { mkdirSync, cpSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runTaskAndCollect } from '../../packages/core/dist/index.js';

const execFileAsync = promisify(execFile);

const HARNESS = process.env.TAKUMI_EVAL_HARNESS ?? 'deepseek';
const MAX_TASKS = Number(process.env.TAKUMI_EVAL_MAX_TASKS ?? 6);
const OUT_DIR = join(import.meta.dirname, '..', 'results');
mkdirSync(OUT_DIR, { recursive: true });

// ---- harness resolution ----
async function makeRuntime() {
  const model = process.env.TAKUMI_EVAL_MODEL;
  if (HARNESS === 'deepseek') {
    const { DeepSeekRuntimeAdapter } = await import('../../runtimes/deepseek/dist/index.js');
    return new DeepSeekRuntimeAdapter({ maxTurns: 20, ...(model ? { model } : {}) });
  }
  if (HARNESS === 'pi') {
    const explicit = process.env.TAKUMI_PI_RUNTIME;
    const mod = explicit ?? '@takumi/runtime-pi';
    const { PiRuntimeAdapter } = await import(mod);
    // Passing model keeps provider and tools constant while model strength
    // varies — required for an honest weak-model vs strong-model comparison.
    return new PiRuntimeAdapter(model ? { model } : {});
  }
  throw new Error(`unknown harness ${HARNESS} (deepseek | pi)`);
}

// ---- task loading ----
async function loadTasks(filter) {
  // tasks defined in TS — compile-free: load the .ts via a tiny loader? No —
  // import the compiled JS from eval/dist if built, else inline the 6 tasks.
  // Simplest robust approach: read tasks/tasks.json if present.
  const jsonPath = join(import.meta.dirname, '..', 'tasks', 'tasks.json');
  if (existsSync(jsonPath)) {
    const all = JSON.parse(readFileSync(jsonPath, 'utf8'));
    return filter ? all.filter((t) => t.task_id.startsWith(filter)) : all.slice(0, MAX_TASKS);
  }
  throw new Error('eval/tasks/tasks.json missing — run node eval/scripts/build-tasks.mjs first');
}

// ---- verification (ground truth) ----
// HARD RULE: verification runs ONLY the hidden ground-truth tests that this
// harness injects. Agent-authored tests under test/ must never decide PASS —
// an agent can always make its own (weak) test green while the implementation
// is wrong. Before this rule existed, a broken implementation plus a trivial
// `assert.ok(true)` test produced a green `npm test` and a FALSE PASS.
const GROUND_TRUTH_SUFFIX = '.ground-truth.test.js';

// Every fixture ships exactly one hidden ground-truth test. Check a fixture
// BEFORE the agent touches it: if the hidden test is missing there is nothing
// that can verify the task, so the task must never be scored. Also record how
// many assertions the ground truth actually contains, so a truncated or
// stubbed-out copy is detected later.
function assertGroundTruthPresent(task) {
  const hiddenDir = join(import.meta.dirname, '..', 'fixtures', task.fixture, 'test', '.hidden');
  const files = existsSync(hiddenDir)
    ? readdirSync(hiddenDir).filter((f) => f.endsWith(GROUND_TRUTH_SUFFIX))
    : [];
  if (files.length !== 1) {
    throw new Error(
      `[${task.task_id}] expected exactly 1 hidden test (*${GROUND_TRUTH_SUFFIX}) in ` +
        `eval/fixtures/${task.fixture}/test/.hidden, found ${files.length}`,
    );
  }
  const src = readFileSync(join(hiddenDir, files[0]), 'utf8');
  const expectedTests = (src.match(/^\s*test\s*\(/gm) ?? []).length;
  if (expectedTests === 0) {
    throw new Error(`[${task.task_id}] ground-truth file declares no test() calls — nothing can verify it`);
  }
  return { file: files[0], expectedTests };
}

// Parse node --test TAP summary counts.
function tapCounts(stdout) {
  const num = (re) => Number((stdout.match(re) ?? [])[1] ?? 0);
  return {
    tests: num(/# tests (\d+)/),
    pass: num(/# pass (\d+)/),
    fail: num(/# fail (\d+)/),
    skipped: num(/# skipped (\d+)/),
  };
}

// Inject the ground truth from the harness cache, run it, then remove it again.
// The agent never has it on disk while it works, and it is taken away before any
// repair attempt starts.
async function verify(task, staged, expectedTests) {
  const { workdir, gtName, cachedPath } = staged;
  mkdirSync(join(workdir, 'test'), { recursive: true });
  const target = join(workdir, 'test', gtName);
  cpSync(cachedPath, target);

  // The injected copy must contain the expected number of assertions; a stale
  // or truncated cache entry means the measurement is invalid, not passing.
  const gtFiles = readdirSync(join(workdir, 'test')).filter((f) => f.endsWith(GROUND_TRUTH_SUFFIX));
  if (gtFiles.length !== 1) {
    rmSync(target, { force: true });
    return {
      pass: false,
      tampered: true,
      stdout: `verification invalid: expected 1 ground-truth test in test/, found ${gtFiles.length}`,
      exitCode: 1,
    };
  }

  // Run ONLY the injected ground truth. Agent-authored test files are ignored.
  const cmd = `cd ${JSON.stringify(workdir)} && node --test ${JSON.stringify(`test/${gtName}`)}`;
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', cmd], { cwd: workdir, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    const c = tapCounts(stdout);
    // An emptied test file is still "1 test, 1 pass" to Node 22 (the file itself
    // counts as a subtest), so compare against the fixture's real assertion count.
    const tampered = c.tests < expectedTests;
    const pass = c.fail === 0 && c.pass > 0 && c.skipped === 0 && !tampered;
    return { pass, tampered, stdout: stdout.slice(0, 3000), exitCode: 0, counts: c };
  } catch (e) {
    return { pass: false, tampered: false, stdout: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.slice(0, 3000), exitCode: e.code ?? 1 };
  } finally {
    // Always take the answer key back, including on the repair path.
    rmSync(target, { force: true });
  }
}

// ---- main ----
// MODE=harness   agent runs inside Takumi (verification + repair loop)
// MODE=baseline  agent runs bare: one shot, no independent verification, no
//                repair loop. The agent's own self-report is the only judge.
//                This is the control group for the A/B comparison.
const MODE = process.env.TAKUMI_EVAL_MODE === 'baseline' ? 'baseline' : 'harness';
const tasks = await loadTasks(process.argv.find((a) => a.startsWith('--tasks='))?.slice(8));

// Fail closed: no hidden ground truth ⇒ nothing can verify ⇒ refuse to score.
const gtInfo = new Map(tasks.map((t) => [t.task_id, assertGroundTruthPresent(t)]));

console.log(`\n=== Takumi Agent Eval — harness=${HARNESS}, mode=${MODE}, tasks=${tasks.length} ===\n`);
if (MODE === 'baseline') {
  console.log('BASELINE: agent self-report is the only judge (no verification, no repair).\n');
}

const runtime = await makeRuntime();
const results = [];

// Ground truth is COPIED OUT of the fixture before the agent ever runs, and the
// copy inside the workdir is deleted. "It stays in test/.hidden so the agent
// cannot see it" was false: the agent has bash and read, so `cat
// test/.hidden/*` revealed the assertions. Measured on 2026-11-02 — a weak model
// that scored 21/23 blind scored 23/23 with the harness, and its own summary
// said "satisfies the ground-truth test's ordering expectation". It had read the
// answer key. Verification must be able to read the truth; the agent must not.
const truthDir = join(import.meta.dirname, '..', '.ground-truth-cache');
mkdirSync(truthDir, { recursive: true });

function stageFixture(task) {
  const workdir = join(tmpdir(), `takumi-eval-${task.task_id}`);
  const fixturePath = join(import.meta.dirname, '..', 'fixtures', task.fixture);
  const src = join(fixturePath, 'test', '.hidden');
  const files = existsSync(src) ? readdirSync(src).filter((f) => f.endsWith(GROUND_TRUTH_SUFFIX)) : [];
  if (files.length !== 1) {
    throw new Error(`[${task.task_id}] expected exactly 1 hidden test in eval/fixtures/${task.fixture}/test/.hidden, found ${files.length}`);
  }
  rmSync(workdir, { recursive: true, force: true });
  cpSync(fixturePath, workdir, { recursive: true });

  // Move the ground truth out of reach: copy it to the harness cache, then
  // remove BOTH the staged copy and the .hidden directory from the workdir.
  const gtName = files[0];
  const cachedPath = join(truthDir, `${task.task_id}--${gtName}`);
  cpSync(join(src, gtName), cachedPath);
  rmSync(join(workdir, 'test', '.hidden'), { recursive: true, force: true });
  return { workdir, gtName, cachedPath };
}

for (const task of tasks) {
  const t0 = Date.now();
  const staged = stageFixture(task);
  const workdir = staged.workdir;
  // Install deps. The ground truth is NOT in the workdir at this point.
  try { await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], { cwd: workdir, timeout: 120_000 }); } catch {}

  console.log(`\n[${task.task_id}] starting (${HARNESS})…`);
  const row = {
    task_id: task.task_id,
    harness: HARNESS,
    mode: MODE,
    claimed: null, first_pass: null, final: null,
    repair_attempts: 0, latency_ms: 0,
    agent_claim: '', first_verify_stdout: '', final_verify_stdout: '',
    false_completion: false, entered_repair: false, tampered: false,
    error: null,
  };

  // 1. agent executes
  let agentRes;
  try {
    agentRes = await runTaskAndCollect(runtime, {
      id: `eval-${task.task_id}`,
      prompt: task.description,
      cwd: workdir,
    }, () => {});
  } catch (e) {
    row.error = e instanceof Error ? e.message : String(e);
    row.final = false;
    results.push(row);
    continue;
  }
  row.agent_claim = agentRes.summary?.slice(0, 500) ?? '';
  row.claimed = agentRes.status === 'completed';

  // 2. independent verification — ALWAYS run, even in baseline mode, because
  //    the measurement ("was the claim true?") must never depend on the
  //    treatment. What differs is whether the agent is *told* and may repair.
  const expectedTests = gtInfo.get(task.task_id).expectedTests;
  let v = await verify(task, staged, expectedTests);
  row.first_verify_stdout = v.stdout.slice(0, 500);
  row.first_pass = v.pass;
  row.tampered = v.tampered === true;

  // 3. repair loop — harness mode only. Baseline gets one shot and is sampled
  //    exactly as a real developer using the bare model would be.
  if (MODE === 'harness' && !v.pass && task.max_repair_attempts > 0) {
    row.entered_repair = true;
    for (let attempt = 1; attempt <= task.max_repair_attempts; attempt++) {
      row.repair_attempts = attempt;
      // Only the verification OUTPUT is shared with the agent — never the test
      // source, never a path to it. Telling the agent "do not modify test/" was
      // both unenforceable and a hint that an answer key existed.
      const feedback = `Independent verification by a held-out test suite FAILED. Output of that verification run:\n${v.stdout.slice(0, 2000)}\n\nFix the implementation so it passes. You cannot see the held-out tests and they are not in this project.`;
      try {
        await runTaskAndCollect(runtime, {
          id: `eval-${task.task_id}-repair-${attempt}`,
          prompt: feedback,
          cwd: workdir,
        }, () => {});
      } catch (e) {
        row.error = `repair ${attempt}: ${e instanceof Error ? e.message : String(e)}`;
        break;
      }
      v = await verify(task, staged, expectedTests);
      row.final_verify_stdout = v.stdout.slice(0, 500);
      row.tampered = row.tampered || v.tampered === true;
      if (v.pass) break;
    }
  }

  row.final = v.pass;
  // False completion = the agent said "done" and independent verification says
  // the work is not correct. This is the metric the whole harness exists for.
  row.false_completion = row.claimed === true && v.pass === false;
  row.latency_ms = Date.now() - t0;
  results.push(row);
  console.log(`[${task.task_id}] claimed=${row.claimed} first_pass=${row.first_pass} final=${row.final} repairs=${row.repair_attempts} latency=${(row.latency_ms / 1000).toFixed(1)}s ${row.false_completion ? '⚠️ FALSE COMPLETION' : ''}`);

  // cleanup
  rmSync(workdir, { recursive: true, force: true });
}

runtime.close();

// ---- metrics ----
const n = results.length;
const firstPass = results.filter((r) => r.first_pass).length;
const claimed = results.filter((r) => r.claimed).length;
const falseComp = results.filter((r) => r.false_completion).length;
const enteredRepair = results.filter((r) => r.entered_repair).length;
const repairOk = results.filter((r) => r.entered_repair && r.final).length;
const finalPass = results.filter((r) => r.final).length;
const avgLatency = results.reduce((s, r) => s + r.latency_ms, 0) / n;

const tampered = results.filter((r) => r.tampered).length;
const report = {
  harness: HARNESS,
  mode: MODE,
  model: process.env.TAKUMI_EVAL_MODEL ?? 'default',
  generated_at: new Date().toISOString(),
  sample_size: n,
  metrics: {
    first_pass_rate: n ? firstPass / n : 0,
    claimed_success_rate: n ? claimed / n : 0,
    false_completion_rate: claimed ? falseComp / claimed : 0,
    repair_success_rate: enteredRepair ? repairOk / enteredRepair : null,
    final_success_rate: n ? finalPass / n : 0,
    average_repair_attempts: results.reduce((s, r) => s + r.repair_attempts, 0) / n,
    average_latency_ms: avgLatency,
    ground_truth_tampered: tampered,
    token_usage: 'not captured (harness does not expose per-task usage reliably)',
  },
  raw: results,
};
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(OUT_DIR, `${HARNESS}-${ts}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(`\n=== Results (${HARNESS}, mode=${MODE}, n=${n}) ===`);
console.log(`first_pass_rate:   ${(report.metrics.first_pass_rate * 100).toFixed(0)}% (${firstPass}/${n})`);
console.log(`claimed_rate:      ${(report.metrics.claimed_success_rate * 100).toFixed(0)}% (${claimed}/${n})`);
console.log(`false_completion:  ${(report.metrics.false_completion_rate * 100).toFixed(0)}% (${falseComp}/${claimed})`);
console.log(`repair_success:    ${report.metrics.repair_success_rate === null ? 'n/a' : (report.metrics.repair_success_rate * 100).toFixed(0) + '%'} (${repairOk}/${enteredRepair})`);
console.log(`final_success:     ${(report.metrics.final_success_rate * 100).toFixed(0)}% (${finalPass}/${n})`);
console.log(`avg latency:       ${(avgLatency / 1000).toFixed(1)}s`);
console.log(`ground truth touched: ${tampered}/${n}`);
console.log(`\nSaved: ${outPath}`);
