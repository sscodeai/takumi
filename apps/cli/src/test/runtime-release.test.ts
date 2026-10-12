/**
 * A RUNTIME THAT IS NEVER RELEASED OUTLIVES ITS OWN WORKFLOW.
 *
 * Measured on a real machine, 2026-10-12: a `request-intake` run against the real pi runtime COMPLETED
 * at 01:23:10Z — run record written, artifact written, summary printed — and the CLI process was still
 * alive at 01:25:30Z (2.5 minutes later), long enough that an earlier foreground invocation had to be
 * killed at 600 s. The pi adapter POOLS a live `AgentSession` (that is what makes a retry cheap), and
 * NOTHING on the run path ever closed it: the pooled session kept the process's event loop alive, so a
 * process that had finished its work did not exit.
 *
 * For an unattended chain that is not cosmetic. A supervisor waits for a process to exit to know that a
 * run is over; a run that never exits is a run a pilot cannot sequence, retry, or even measure. The
 * runtime is created BY the run (the CLI resolves it from `runtimeId`), so the run is what must release
 * it — on the success path AND on the failure path, because "it failed" is exactly when the operator
 * wants the process back.
 *
 * These tests inject a runtime (the `runtime` seam on RunOptions) and count the `close()` calls, so the
 * contract is asserted directly rather than inferred from a process that happens to exit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntimeAdapter } from '@takumi/core';
import { FakeRuntime } from '@takumi/runtime-fake';
import { initProject } from '../init.js';
import { loadConfig, runTask, type RunOptions } from '../commands.js';

/** A project with one workflow written into its registry. */
function projectWith(workflow: string, steps: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-runtime-release-'));
  initProject(dir);
  const wfDir = join(dir, 'extensions/workflows', workflow);
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(
    join(wfDir, 'workflow.yaml'),
    ['name: ' + workflow, 'version: 0.1.0', 'description: fixture', 'steps:', ...steps, ''].join('\n'),
  );
  return dir;
}

/** A runtime that records its own release, wrapping the fake one. */
function recording(): { runtime: AgentRuntimeAdapter; closed: string[] } {
  const closed: string[] = [];
  const fake = new FakeRuntime(() => 'done');
  const runtime = Object.assign(fake, {
    close: () => {
      closed.push('closed');
    },
  });
  return { runtime, closed };
}

test('runTask releases the runtime it used — on the success path AND on the failure path', async () => {
  // A workflow that passes: one tool step, nothing to fail.
  const okDir = projectWith('simple', ['  - id: say', '    type: tool', '    prompt: echo hello']);
  // A workflow that cannot pass: the gate exits non-zero, so the step fails and the run stops.
  const failDir = projectWith('failing-gate', [
    '  - id: gate',
    '    type: quality_gate',
    '    prompt: echo "# tests 1"; echo "# pass 0"; echo "# fail 1"; exit 1',
  ]);
  try {
    const ok = recording();
    const okOut = await runTask({
      cwd: okDir,
      prompt: 'say hello',
      runtimeId: 'fake',
      workflow: 'simple',
      config: loadConfig(okDir),
      runtime: ok.runtime,
    } as unknown as RunOptions);

    assert.equal(okOut.status, 'completed');
    assert.deepEqual(ok.closed, ['closed'], 'a finished run releases the runtime it used, so the process can exit');

    const bad = recording();
    const badOut = await runTask({
      cwd: failDir,
      prompt: 'ship it',
      runtimeId: 'fake',
      workflow: 'failing-gate',
      config: loadConfig(failDir),
      runtime: bad.runtime,
    } as unknown as RunOptions);

    assert.equal(badOut.status, 'failed');
    assert.deepEqual(
      bad.closed,
      ['closed'],
      'a FAILED run releases the runtime too — a failure is exactly when the operator wants the process back',
    );
  } finally {
    rmSync(okDir, { recursive: true, force: true });
    rmSync(failDir, { recursive: true, force: true });
  }
});
