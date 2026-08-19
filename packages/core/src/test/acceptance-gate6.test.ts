import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, executeWorkflow, WorkflowDefinition } from '../index.js';
import { FakeRuntime } from '@takumi/runtime-fake';
import { CliRuntimeAdapter } from '@takumi/runtime-cli';

// Acceptance Gate 6 — Runtime Capability Negotiation.
// A workflow declaring `requires: [shell]` must be REJECTED BEFORE EXECUTION
// by a runtime that lacks `shell` (clear error), and START cleanly on a
// runtime that has it. No mid-run random failure.

const NEEDS_SHELL: WorkflowDefinition = {
  name: 'needs-shell',
  version: '0.1.0',
  description: 'workflow that needs shell',
  requires: ['filesystem', 'shell'],
  steps: [{ id: 'run', type: 'agent', prompt: 'do work' }],
};

function env() {
  const dir = mkdtempSync(join(tmpdir(), 'gate6-'));
  return { dir, artifacts: new ArtifactStore(join(dir, 'artifacts')) };
}

// Runtime A: FakeRuntime supports shell.
const runtimeSupportsShell = new FakeRuntime((t) => `[A] ${t.prompt}`);

// Runtime B: CliRuntimeAdapter with capabilities restricted to streaming ONLY
// (does NOT advertise shell) — this is the "does not support shell" runtime.
const runtimeNoShell = new CliRuntimeAdapter({
  id: 'no-shell',
  name: 'No Shell Runtime',
  command: 'echo',
  capabilities: ['streaming'],
});

test('Gate 6: runtime with shell → workflow starts and completes', async () => {
  const { dir, artifacts } = env();
  try {
    const res = await executeWorkflow(NEEDS_SHELL, {
      cwd: dir,
      runtime: runtimeSupportsShell,
      artifacts,
      onApproval: () => true,
    });
    assert.equal(res.status, 'completed', 'workflow should complete on a shell-capable runtime');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Gate 6: runtime WITHOUT shell → rejected BEFORE execution, clear error', async () => {
  const { dir, artifacts } = env();
  try {
    await assert.rejects(
      () =>
        executeWorkflow(NEEDS_SHELL, {
          cwd: dir,
          runtime: runtimeNoShell,
          artifacts,
          onApproval: () => true,
        }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Error must name the missing capability and the runtime, clearly.
        assert.ok(msg.includes('shell'), `error should mention missing capability 'shell': ${msg}`);
        assert.ok(msg.includes('no-shell'), `error should name runtime 'no-shell': ${msg}`);
        return true;
      },
    );
    // Also: no step should have started (rejected before execution).
    const art = await artifacts.list();
    assert.equal(art.length, 0, 'no artifacts should be produced when rejected pre-execution');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});