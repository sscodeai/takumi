/**
 * `takumi loop` — run the MEA (Manage-Execute-Audit) loop against a task.
 * Uses the core runManagerLoop engine + real runtime host.
 */
import type { AgentRuntimeAdapter } from '@takumi/core';
import { runManagerLoop } from '@takumi/core';
import { resolveRuntime } from './commands.js';
import { makeLoopHost } from './loop-host.js';

export async function runLoop(opts: { cwd: string; task: string; runtimeId: string; maxRounds: number }): Promise<number> {
  console.log(`\n=== Takumi Loop (MEA) ===`);
  console.log(`task: ${opts.task}`);
  console.log(`runtime: ${opts.runtimeId} | max rounds: ${opts.maxRounds}\n`);

  const runtime = await resolveRuntime(opts.runtimeId);
  const host = makeLoopHost(runtime, opts.cwd);

  const res = await runManagerLoop(host, opts.task, { maxRounds: opts.maxRounds });

  console.log(`\n=== Loop finished: ${res.decision} after ${res.rounds} round(s) ===`);
  if (res.finalNote) console.log(`note: ${res.finalNote}`);
  console.log('\nTask state records:');
  for (const r of res.state.records) {
    console.log(`  [${r.status}] ${r.type} ${r.id}: ${r.description.slice(0, 80)}${r.evidence ? `\n    evidence: ${r.evidence.slice(0, 120)}` : ''}`);
  }
  console.log(`\naudit rounds: ${res.auditHistory.length}`);
  return 0;
}
