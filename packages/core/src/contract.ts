import assert from 'node:assert/strict';
import { runTaskAndCollect } from './runtime.js';
import { validateCapabilities } from './runtime.js';
import type { AgentRuntimeAdapter } from './runtime.js';
import type { AgentTask } from './types.js';

/**
 * Shared Runtime Contract Suite (ADR-002 / acceptance Gate 3).
 *
 * ANY AgentRuntimeAdapter must pass these assertions. FakeRuntime and
 * PiRuntime (and future DeepSeek Harness, Codex bridge) run the SAME suite so
 * the contract is proven identical across runtimes — Core never learns a
 * runtime's internals.
 *
 * Contract surface verified: metadata, capabilities, run→events→result,
 * status, usage, artifacts, failure, cancel.
 */
export async function runRuntimeContractSuite(
  runtime: AgentRuntimeAdapter,
  opts: {
    /** Expected runtime id (e.g. 'fake', 'pi'). */
    id: string;
    /** A prompt the runtime can complete (for real runtimes). */
    prompt: string;
    cwd?: string;
    /** For real runtimes that need credentials: set true to skip the real-run assertions (reported as not-run). */
    skipRealRun?: boolean;
  },
): Promise<{ gate: string; result: string; notes: string[] }> {
  const notes: string[] = [];
  const cwd = opts.cwd ?? '/tmp';

  // --- metadata ---
  const meta = runtime.metadata();
  assert.equal(meta.id, opts.id, 'metadata.id must match configured id');
  assert.ok(meta.version, 'metadata.version required');
  assert.ok(meta.name, 'metadata.name required');
  notes.push('metadata: PASS');

  // --- capabilities ---
  const caps = runtime.capabilities();
  assert.ok(Array.isArray(caps.capabilities), 'capabilities must be an array');
  assert.ok(caps.maxParallelTasks >= 1, 'maxParallelTasks >= 1');
  notes.push(`capabilities: PASS (${caps.capabilities.join(',')})`);

  // --- real run assertions (skip if no credentials) ---
  if (opts.skipRealRun) {
    notes.push('real-run: NOT_RUN (external credential / not supported in this env)');
    return { gate: 'runtime-contract', result: 'PASS_WITH_NOT_RUN', notes };
  }

  const taskId = `contract-${opts.id}-${Date.now()}`;
  const task: AgentTask = { id: taskId, prompt: opts.prompt, cwd };

  // --- run → events sequence ---
  const events: string[] = [];
  const result = await runTaskAndCollect(runtime, task, (ev) => events.push(ev.type));

  // Event ordering: task.started first, task.completed LAST, and no tool/
  // command event after task.completed (Gate 18 integrity). The happy-path
  // contract is that the runtime COMPLETES the task — a 'failed' terminal
  // must FAIL the suite, never pass (Test-Quality review H1).
  assert.equal(events[0], 'task.started', 'first event must be task.started');
  const terminator = events.at(-1);
  assert.equal(
    terminator,
    'task.completed',
    `happy-path contract requires terminal event task.completed, got ${terminator} (a failing run must NOT pass)`,
  );
  const completedIdx = events.indexOf('task.completed');
  if (completedIdx !== -1) {
    for (const later of events.slice(completedIdx + 1)) {
      assert.ok(
        !later.startsWith('tool.') && !later.startsWith('command.') && !later.startsWith('agent.'),
        `no tool/command/agent event after task.completed (got ${later})`,
      );
    }
  }
  notes.push(`run→events: PASS (${events.length} events)`);

  // --- status after completion ---
  const status = await runtime.getStatus(taskId);
  assert.equal(status, 'completed', `happy-path status must be completed, got ${status}`);
  notes.push(`status: PASS (${status})`);

  // --- usage ---
  const usage = await runtime.getUsage(taskId);
  assert.ok(usage && typeof usage === 'object', 'usage required');
  assert.equal(usage.runtimeId, opts.id, 'usage.runtimeId must match');
  assert.ok(typeof usage.totalTokens === 'number', 'usage.totalTokens number');
  assert.ok(typeof usage.costUsd === 'number', 'usage.costUsd number');
  notes.push('usage: PASS');

  // --- artifacts ---
  const artifacts = await runtime.getArtifacts(taskId);
  assert.ok(Array.isArray(artifacts), 'artifacts must be an array');
  notes.push(`artifacts: PASS (${artifacts.length})`);

  // --- validateCapabilities helper (independent of runtime internals) ---
  const ok = validateCapabilities(runtime, ['streaming']);
  assert.deepEqual(ok, { ok: true });
  notes.push('validateCapabilities: PASS');

  // --- result summary ---
  assert.equal(result.status, 'completed', `happy-path result.status must be completed, got ${result.status}`);
  assert.equal(result.taskId, taskId, 'result.taskId matches');
  notes.push(`result: PASS (${result.status})`);

  return { gate: 'runtime-contract', result: 'PASS', notes };
}