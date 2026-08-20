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
  if (HARNESS === 'deepseek') {
    const { DeepSeekRuntimeAdapter } = await import('../../runtimes/deepseek/dist/index.js');
    return new DeepSeekRuntimeAdapter({ maxTurns: 20 });
  }
  if (HARNESS === 'pi') {
    const explicit = process.env.TAKUMI_PI_RUNTIME;
    const mod = explicit ?? '@takumi/runtime-pi';
    const { PiRuntimeAdapter } = await import(mod);
    return new PiRuntimeAdapter();
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
async function verify(task, workdir) {
  // Move hidden tests into place (they are the independent ground truth).
  const hiddenDir = join(workdir, 'test', '.hidden');
  if (existsSync(hiddenDir)) {
    for (const f of readdirSync(hiddenDir)) {
      cpSync(join(hiddenDir, f), join(workdir, 'test', f), { recursive: true });
    }
  }
  const cmd = task.verify.command.replaceAll('{workdir}', workdir);
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', cmd], { cwd: workdir, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
    const pass = !task.verify.expect_stdout || stdout.includes(task.verify.expect_stdout);
    return { pass, stdout: stdout.slice(0, 3000), exitCode: 0 };
  } catch (e) {
    return { pass: false, stdout: `${e.stdout ?? ''}\n${e.stderr ?? ''}`.slice(0, 3000), exitCode: e.code ?? 1 };
  }
}

// ---- main ----
const tasks = await loadTasks(process.argv.find((a) => a.startsWith('--tasks='))?.slice(8));
console.log(`\n=== Takumi Agent Eval — harness=${HARNESS}, tasks=${tasks.length} ===\n`);

const runtime = await makeRuntime();
const results = [];

for (const task of tasks) {
  const t0 = Date.now();
  const workdir = join(tmpdir(), `takumi-eval-${task.task_id}`);
  rmSync(workdir, { recursive: true, force: true });
  cpSync(join(import.meta.dirname, '..', 'fixtures', task.fixture), workdir, { recursive: true });
  // Install deps (no hidden tests visible during agent work — they stay in .hidden)
  try { await execFileAsync('npm', ['install', '--no-audit', '--no-fund'], { cwd: workdir, timeout: 120_000 }); } catch {}

  console.log(`\n[${task.task_id}] starting (${HARNESS})…`);
  const row = {
    task_id: task.task_id,
    harness: HARNESS,
    claimed: null, first_pass: null, final: null,
    repair_attempts: 0, latency_ms: 0,
    agent_claim: '', first_verify_stdout: '', final_verify_stdout: '',
    false_completion: false, entered_repair: false,
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

  // 2. independent verification
  let v = await verify(task, workdir);
  row.first_verify_stdout = v.stdout.slice(0, 500);
  row.first_pass = v.pass;

  // 3. repair loop
  if (!v.pass && task.max_repair_attempts > 0) {
    row.entered_repair = true;
    for (let attempt = 1; attempt <= task.max_repair_attempts; attempt++) {
      row.repair_attempts = attempt;
      const feedback = `Independent verification FAILED. Verification command output:\n${v.stdout.slice(0, 2000)}\n\nFix the issue so the verification passes. Do not modify or remove the test files in test/ (they are the ground truth).`;
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
      v = await verify(task, workdir);
      row.final_verify_stdout = v.stdout.slice(0, 500);
      if (v.pass) break;
    }
  }

  row.final = v.pass;
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

const report = {
  harness: HARNESS,
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
    token_usage: 'not captured (harness does not expose per-task usage reliably)',
  },
  raw: results,
};
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = join(OUT_DIR, `${HARNESS}-${ts}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(`\n=== Results (${HARNESS}, n=${n}) ===`);
console.log(`first_pass_rate:   ${(report.metrics.first_pass_rate * 100).toFixed(0)}% (${firstPass}/${n})`);
console.log(`claimed_rate:      ${(report.metrics.claimed_success_rate * 100).toFixed(0)}% (${claimed}/${n})`);
console.log(`false_completion:  ${(report.metrics.false_completion_rate * 100).toFixed(0)}% (${falseComp}/${claimed})`);
console.log(`repair_success:    ${report.metrics.repair_success_rate === null ? 'n/a' : (report.metrics.repair_success_rate * 100).toFixed(0) + '%'} (${repairOk}/${enteredRepair})`);
console.log(`final_success:     ${(report.metrics.final_success_rate * 100).toFixed(0)}% (${finalPass}/${n})`);
console.log(`avg latency:       ${(avgLatency / 1000).toFixed(1)}s`);
console.log(`\nSaved: ${outPath}`);
