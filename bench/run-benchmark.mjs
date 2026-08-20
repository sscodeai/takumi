#!/usr/bin/env node
/**
 * Takumi Agent Eval / Benchmark — P0-2
 *
 * Quantifies the core execution pipeline:
 *   B1. Workflow execution reliability  — N runs of a workflow, step success/fail/timeout
 *   B2. Quality Gate effectiveness      — red/green/zero tests correctly classified
 *   B3. Artifact completeness           — every completed step produced its artifact
 *   B4. Runtime parity                  — same workflow across TestRuntime/FakeRuntime (and Pi if TAKUMI_PI_RUNTIME set)
 *
 * Usage:
 *   node bench/run-benchmark.mjs                 # TestRuntime + FakeRuntime baselines
 *   TAKUMI_PI_RUNTIME=... node bench/run-benchmark.mjs   # + real Pi (key via env)
 *
 * Output: bench/results/<timestamp>.json + .md (quantified, honest)
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Relative dist imports (workspace package resolution doesn't apply from bench/)
import { executeWorkflow, ArtifactStore } from '../packages/core/dist/index.js';
import { FakeRuntime } from '../runtimes/fake/dist/index.js';

const N_RUNS = 10; // workflow reliability iterations
const OUT_DIR = join(import.meta.dirname, 'results');
mkdirSync(OUT_DIR, { recursive: true });

// A small representative workflow (agent steps + quality gate + delivery).
const wf = {
  name: 'bench-wf',
  version: '0.1.0',
  description: 'benchmark workflow',
  steps: [
    { id: 'a1', type: 'agent', prompt: 'analyze {input}', dependsOn: [] },
    { id: 'a2', type: 'agent', prompt: 'design from {a1}', dependsOn: ['a1'] },
    { id: 'gate', type: 'quality_gate', prompt: 'echo "# tests 3"; echo "# pass 3"; echo "# fail 0"', dependsOn: ['a2'], timeoutMs: 30000 },
    { id: 'a3', type: 'agent', prompt: 'implement from {a2}', dependsOn: ['gate'] },
    { id: 'deliv', type: 'delivery', prompt: 'bundle', dependsOn: ['a3'] },
  ],
};

function makeCtx(runtime, label) {
  const dir = mkdtempSync(join(tmpdir(), `bench-${label}-`));
  return { cwd: dir, runtime, artifacts: new ArtifactStore(join(dir, 'a')), onApproval: () => true };
}

function fmt(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`; }

async function runOnce(runtime, label) {
  const t0 = performance.now();
  const res = await executeWorkflow(wf, makeCtx(runtime, label), { input: 'REQ-001' });
  const dt = performance.now() - t0;
  return { status: res.status, durationMs: dt, steps: res.steps.map((s) => s.stepId + ':' + s.status).join(' ') };
}

async function benchReliability(runtime, label) {
  const runs = [];
  for (let i = 0; i < N_RUNS; i++) runs.push(await runOnce(runtime, label));
  const ok = runs.filter((r) => r.status === 'completed').length;
  const avg = runs.reduce((s, r) => s + r.durationMs, 0) / runs.length;
  const min = Math.min(...runs.map((r) => r.durationMs));
  const max = Math.max(...runs.map((r) => r.durationMs));
  return { label, runs: N_RUNS, completed: ok, successRate: ok / N_RUNS, avgMs: avg, minMs: min, maxMs: max, statuses: runs.map((r) => r.status) };
}

async function benchQualityGate(runtime, label) {
  // green / red / zero tests must be classified correctly
  const cases = [
    { name: 'green', prompt: 'echo "# tests 3"; echo "# pass 3"; echo "# fail 0"', expect: 'completed' },
    { name: 'red', prompt: 'echo "# tests 3"; echo "# pass 2"; echo "# fail 1"; exit 1', expect: 'failed' },
    { name: 'zero', prompt: 'echo "# tests 0"; echo "# pass 0"; echo "# fail 0"; exit 0', expect: 'failed' },
    { name: 'maven-green', prompt: 'echo "Tests run: 5, Failures: 0, Errors: 0, Skipped: 0"; echo "BUILD SUCCESS"', expect: 'completed' },
    { name: 'maven-red', prompt: 'echo "Tests run: 5, Failures: 2, Errors: 1, Skipped: 0"; echo "BUILD FAILURE"', expect: 'failed' },
  ];
  const results = [];
  for (const c of cases) {
    const w = { name: 'qg', version: '0.1.0', description: '', steps: [{ id: 'gate', type: 'quality_gate', prompt: c.prompt, dependsOn: [], timeoutMs: 30000 }] };
    const res = await executeWorkflow(w, makeCtx(runtime, label), {});
    const gate = res.steps.find((s) => s.stepId === 'gate');
    const pass = (gate?.status === 'completed') === (c.expect === 'completed');
    results.push({ name: c.name, got: gate?.status, expect: c.expect, pass });
  }
  return { label, results, score: results.filter((r) => r.pass).length / results.length };
}

async function benchArtifacts(runtime, label) {
  const dir = mkdtempSync(join(tmpdir(), `bench-art-${label}-`));
  const store = new ArtifactStore(join(dir, 'a'));
  const res = await executeWorkflow(wf, { cwd: dir, runtime, artifacts: store, onApproval: () => true }, { input: 'REQ-002' });
  const steps = res.steps;
  const completedAgentSteps = steps.filter((s) => s.status === 'completed' && ['a1', 'a2', 'a3'].includes(s.stepId)).length;
  // Real check: count artifact files actually on disk under the store
  const { readdirSync, existsSync } = await import('node:fs');
  const artRoot = join(dir, 'a');
  let files = 0;
  if (existsSync(artRoot)) {
    const walk = (p) => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        const full = join(p, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name !== '.meta' && !e.name.endsWith('.json')) files++;
      }
    };
    walk(artRoot);
  }
  return {
    label,
    completedSteps: steps.length,
    completedAgentSteps,
    artifactFilesOnDisk: files,
    artifactCoverage: completedAgentSteps > 0 ? files / completedAgentSteps : 0,
  };
}

// ---------------------------------------------------------------- main
const report = { generatedAt: new Date().toISOString(), tool: 'Takumi Agent Eval / Benchmark', dimensions: {} };

// TestRuntime is exported from core's test-utils (not the public entry). Use it via relative import if available.
import { TestRuntime } from '../packages/core/dist/test-utils.js';

const pool = [
  { id: 'test', rt: new TestRuntime((t) => 'ok: ' + t.prompt?.slice(0, 20), { capabilities: ['streaming', 'shell'], maxParallelTasks: 4 }, 'bench') },
  { id: 'fake', rt: new FakeRuntime() },
];

// B1 reliability
const rel = [];
for (const { id, rt } of pool) rel.push(await benchReliability(rt, id));
report.dimensions.B1_reliability = rel;

// B2 quality gate
const qg = [];
for (const { id, rt } of pool) qg.push(await benchQualityGate(rt, id));
report.dimensions.B2_qualityGate = qg;

// B3 artifacts
const art = [];
for (const { id, rt } of pool) art.push(await benchArtifacts(rt, id));
report.dimensions.B3_artifacts = art;

// B4 runtime parity: same workflow on TestRuntime vs FakeRuntime must yield
// identical step status sequences (harness-agnostic core).
async function benchParity() {
  const rt1 = new TestRuntime((t) => 'ok: ' + t.prompt?.slice(0, 20), { capabilities: ['streaming', 'shell'], maxParallelTasks: 4 }, 'bench');
  const rt2 = new FakeRuntime();
  const runSteps = async (rt) => {
    const dir = mkdtempSync(join(tmpdir(), 'bench-parity-'));
    const res = await executeWorkflow(wf, { cwd: dir, runtime: rt, artifacts: new ArtifactStore(join(dir, 'a')), onApproval: () => true }, { input: 'REQ-003' });
    return { status: res.status, steps: res.steps.map((s) => `${s.stepId}:${s.status}`) };
  };
  const a = await runSteps(rt1);
  const b = await runSteps(rt2);
  return {
    test: a, fake: b,
    identicalStatusSequence: JSON.stringify(a.steps) === JSON.stringify(b.steps),
    identicalFinalStatus: a.status === b.status,
  };
}
report.dimensions.B4_runtimeParity = await benchParity();

// Optional real Pi
if (process.env.TAKUMI_PI_RUNTIME) {
  const { PiRuntimeAdapter } = await import(process.env.TAKUMI_PI_RUNTIME);
  const pi = new PiRuntimeAdapter();
  report.dimensions.B4_runtimeParity.real = await benchReliability(pi, 'pi');
  pi.close();
}

// Markdown report
function md(report) {
  const L = [];
  L.push('# Takumi Agent Eval / Benchmark');
  L.push('');
  L.push(`- Generated: ${report.generatedAt}`);
  L.push(`- Tool: ${report.tool}`);
  L.push('');
  L.push('## B1 — Workflow execution reliability');
  L.push('');
  L.push('| runtime | runs | completed | success rate | avg | min | max |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of report.dimensions.B1_reliability) {
    L.push(`| ${r.label} | ${r.runs} | ${r.completed} | ${(r.successRate * 100).toFixed(0)}% | ${r.avgMs.toFixed(1)}ms | ${r.minMs.toFixed(1)}ms | ${r.maxMs.toFixed(1)}ms |`);
  }
  L.push('');
  L.push('## B2 — Quality Gate effectiveness');
  L.push('');
  for (const q of report.dimensions.B2_qualityGate) {
    L.push(`### ${q.label} — score ${(q.score * 100).toFixed(0)}%`);
    L.push('');
    L.push('| case | got | expect | pass |');
    L.push('|---|---|---|---|');
    for (const r of q.results) L.push(`| ${r.name} | ${r.got} | ${r.expect} | ${r.pass ? '✅' : '❌'} |`);
    L.push('');
  }
  L.push('## B3 — Artifact completeness');
  L.push('');
  L.push('| runtime | steps | agent steps | artifact files on disk | coverage |');
  L.push('|---|---|---|---|---|');
  for (const a of report.dimensions.B3_artifacts) {
    L.push(`| ${a.label} | ${a.completedSteps} | ${a.completedAgentSteps} | ${a.artifactFilesOnDisk} | ${a.artifactCoverage.toFixed(2)} |`);
  }
  L.push('');
  L.push('## B4 — Runtime parity');
  L.push('');
  const p = report.dimensions.B4_runtimeParity;
  L.push(`- identical step status sequence: **${p.identicalStatusSequence}**`);
  L.push(`- identical final status: **${p.identicalFinalStatus}**`);
  if (p.real) L.push(`- real Pi: ${p.real.completed}/${p.real.runs} completed (${(p.real.successRate * 100).toFixed(0)}%)`);
  L.push('');
  return L.join('\n');
}
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const mdPath = join(OUT_DIR, `${ts}.md`);
writeFileSync(mdPath, md(report));

// Write outputs
const jsonPath = join(OUT_DIR, `${ts}.json`);
writeFileSync(jsonPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\nSaved: ${jsonPath}\nSaved: ${mdPath}`);
