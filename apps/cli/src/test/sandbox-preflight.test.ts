import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentRuntimeAdapter, WorkflowDefinition } from '@takumi/core';
import { sandboxCapability } from '@takumi/core';
import { FakeRuntime } from '@takumi/runtime-fake';
import { initProject } from '../init.js';
import {
  UNSAFE_NO_SANDBOX_ENV,
  collectStagedRefs,
  decideSandbox,
  loadConfig,
  runTask,
  unsafeNoSandboxSet,
} from '../commands.js';

// S3 (ADR-058): the preflight is fail-closed, the only bypass is the human-only
// environment override, and the escape hatch is loud and recorded.

// The boundary cannot mirror a project root under `/tmp` (guard G4), so the
// live fixtures live outside it, exactly like the core boundary tests.
const SCRATCH_ROOT = join(homedir(), '.cache', 'takumi-cli-sandbox-tests');

function makeProject(): string {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const dir = mkdtempSync(join(SCRATCH_ROOT, 'cli-sbx-'));
  initProject(dir);
  return dir;
}

function writeWorkflow(dir: string, name: string, body: string[]): void {
  const wfDir = join(dir, 'extensions/workflows', name);
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, 'workflow.yaml'), body.concat(['']).join('\n'));
}

function runRecords(dir: string): Array<Record<string, unknown>> {
  const runDir = join(dir, '.takumi/runs');
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(runDir, f), 'utf8')) as Record<string, unknown>);
}

function auditRecords(dir: string): Array<Record<string, unknown>> {
  const auditDir = join(dir, '.takumi/audit');
  if (!existsSync(auditDir)) return [];
  return readdirSync(auditDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(auditDir, f), 'utf8')) as Record<string, unknown>);
}

function spyRuntime(flag: { ran: boolean }): AgentRuntimeAdapter {
  const base = new FakeRuntime();
  return new Proxy(base, {
    get(target, prop) {
      if (prop === 'run') {
        return (...args: unknown[]) => {
          flag.ran = true;
          return (target.run as (...a: unknown[]) => unknown)(...args);
        };
      }
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as AgentRuntimeAdapter;
}

// ---------------------------------------------------------------------------
// decideSandbox — the pure fail-closed rule
// ---------------------------------------------------------------------------

test('preflight: a delivery run is confined by default and refused when the boundary is unavailable', () => {
  const refused = decideSandbox({
    worktree: '/w',
    sandbox: undefined,
    capability: { available: false, reason: 'no_userns' },
    unsafeOverride: false,
  });
  assert.equal(refused.mode, 'refused');
  if (refused.mode === 'refused') assert.match(refused.message, /no_userns/);

  const allowed = decideSandbox({
    worktree: '/w',
    sandbox: undefined,
    capability: { available: true },
    unsafeOverride: false,
  });
  assert.equal(allowed.mode, 'unshare');
});

test('preflight: --sandbox none is refused on a delivery run', () => {
  const decision = decideSandbox({
    worktree: '/w',
    sandbox: 'none',
    capability: { available: true },
    unsafeOverride: false,
  });
  assert.equal(decision.mode, 'refused');
  if (decision.mode === 'refused') assert.match(decision.message, /--sandbox none is not permitted/);
});

test('preflight: the environment override is the only bypass and it is named', () => {
  const decision = decideSandbox({
    worktree: '/w',
    sandbox: 'none',
    capability: { available: false, reason: 'no_userns' },
    unsafeOverride: true,
  });
  assert.equal(decision.mode, 'unsafe-override');
  if (decision.mode === 'unsafe-override') {
    assert.equal(decision.note, 'none (unsafe override)');
    assert.match(decision.warning, new RegExp(UNSAFE_NO_SANDBOX_ENV));
  }
});

test('preflight: a run without a worktree stays unconfined unless --sandbox unshare', () => {
  assert.equal(decideSandbox({ capability: { available: true }, unsafeOverride: false }).mode, 'none');
  assert.equal(
    decideSandbox({ sandbox: 'unshare', capability: { available: true }, unsafeOverride: false }).mode,
    'unshare',
  );
});

test('preflight: an explicit --sandbox unshare is honoured even when the override is set', () => {
  // The override is the fallback for a run that would otherwise be refused; it
  // must not silently drop a boundary that was asked for and is available.
  const requested = decideSandbox({
    worktree: '/w',
    sandbox: 'unshare',
    capability: { available: true },
    unsafeOverride: true,
  });
  assert.equal(requested.mode, 'unshare');
  const fallback = decideSandbox({
    sandbox: 'unshare',
    capability: { available: false, reason: 'no_userns' },
    unsafeOverride: true,
  });
  assert.equal(fallback.mode, 'unsafe-override');
});

test('preflight: only the exact literal 1 in the environment is the override', () => {
  assert.equal(unsafeNoSandboxSet({ [UNSAFE_NO_SANDBOX_ENV]: '1' }), true);
  assert.equal(unsafeNoSandboxSet({ [UNSAFE_NO_SANDBOX_ENV]: 'true' }), false);
  assert.equal(unsafeNoSandboxSet({ [UNSAFE_NO_SANDBOX_ENV]: '0' }), false);
  assert.equal(unsafeNoSandboxSet({}), false);
});

// ---------------------------------------------------------------------------
// Staging the harness refs
// ---------------------------------------------------------------------------

test('preflight: harness refs are staged read-only and placeholders are left to the run', () => {
  const dir = makeProject();
  try {
    mkdirSync(join(dir, 'extensions/judges'), { recursive: true });
    writeFileSync(join(dir, 'extensions/judges/forge.sh'), '#!/bin/sh\n');
    writeFileSync(join(dir, 'req.md'), '# requirement\n');
    const wf: WorkflowDefinition = {
      name: 'staged',
      version: '0.1.0',
      description: '',
      steps: [
        { id: 'forge', type: 'judge_forge', requirementRef: '{requirement}', forgeRef: 'extensions/judges/forge.sh' },
        { id: 'accept', type: 'acceptance', requirementRef: '{requirement}', acceptanceRef: '{judgePath} --worktree {worktree}' },
        { id: 'missing', type: 'judge_forge', requirementRef: 'nope.md', forgeRef: 'extensions/judges/absent.sh' },
      ],
    };
    const staged = collectStagedRefs(wf, { ref: 'req.md' }, dir).map((s) => s.ref).sort();
    assert.deepEqual(staged, ['extensions/judges/forge.sh', 'req.md']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End to end: confinement actually runs the step, and the record says so
// ---------------------------------------------------------------------------

test('preflight (A7): a delivery run with --sandbox none is refused before the runtime is invoked and audited', async () => {
  const dir = makeProject();
  try {
    writeWorkflow(dir, 'tools', [
      'name: tools',
      'version: 0.1.0',
      'description: one tool step',
      'steps:',
      '  - id: tool_step',
      '    type: tool',
      "    prompt: 'echo should-not-run'",
    ]);
    const cfg = loadConfig(dir);
    const flag = { ran: false };
    const out = await runTask({
      cwd: dir,
      prompt: 'x',
      runtimeId: 'fake',
      runtime: spyRuntime(flag),
      workflow: 'tools',
      worktree: join(dir, 'worktree'),
      sandbox: 'none',
      config: cfg,
    });
    assert.equal(out.status, 'failed');
    assert.equal(flag.ran, false, 'the runtime must not be invoked after a refusal');
    const audits = auditRecords(dir);
    assert.ok(audits.length >= 1, 'the refusal is audited');
    assert.deepEqual(audits[0]?.sandbox, { mode: 'refused', reason: 'explicit_none_on_delivery_run' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight (H2): a policy guard failure is refused and audited, with no judge directory left behind', async () => {
  // A project root under /tmp that stages a harness file violates G4. The failure
  // must arrive as the SAME audited refusal as an unavailable boundary, not as an
  // unaudited throw, and no empty judge tree may be left behind.
  const dir = mkdtempSync(join(tmpdir(), 'takumi-guard-'));
  try {
    initProject(dir);
    writeFileSync(join(dir, 'req.md'), '# requirement\n');
    writeWorkflow(dir, 'forge', [
      'name: forge',
      'version: 0.1.0',
      'description: a forge step',
      'steps:',
      '  - id: judge_forge',
      '    type: judge_forge',
      "    requirementRef: 'req.md'",
      "    forgeRef: 'forge.sh'",
    ]);
    writeFileSync(join(dir, 'forge.sh'), '#!/bin/sh\n');
    const cfg = loadConfig(dir);
    const flag = { ran: false };
    const out = await runTask({
      cwd: dir,
      prompt: 'x',
      runtimeId: 'fake',
      runtime: spyRuntime(flag),
      workflow: 'forge',
      worktree: join(dir, 'worktree'),
      sandbox: 'unshare',
      confirmedRequirement: { ref: 'req.md', digest: 'abc' },
      config: cfg,
    });
    assert.equal(out.status, 'failed');
    assert.equal(flag.ran, false);
    const audits = auditRecords(dir);
    assert.ok(audits.length >= 1, 'the guard failure is audited');
    assert.equal((audits[0]?.sandbox as { mode?: string } | undefined)?.mode, 'refused');
    assert.equal((audits[0]?.sandbox as { reason?: string } | undefined)?.reason, 'G4');
    assert.equal(existsSync(join(dir, '.takumi/acceptance')), false, 'no empty judge tree is left behind');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight: a confined run executes its step inside the boundary and records it', async (t) => {
  const capability = await sandboxCapability();
  if (!capability.available) {
    t.skip(`the boundary cannot be established on this host: ${capability.reason ?? 'unknown'}`);
    return;
  }
  const dir = makeProject();
  try {
    writeWorkflow(dir, 'tools', [
      'name: tools',
      'version: 0.1.0',
      'description: one tool step',
      'steps:',
      '  - id: tool_step',
      '    type: tool',
      "    prompt: 'echo confined-ok'",
    ]);
    const cfg = loadConfig(dir);
    const out = await runTask({
      cwd: dir,
      prompt: 'x',
      runtimeId: 'fake',
      workflow: 'tools',
      sandbox: 'unshare',
      config: cfg,
    });
    assert.equal(out.status, 'completed', out.events.join('\n'));
    assert.ok(out.events.some((e) => e.startsWith('step tool_step: completed') && e.includes('confined-ok')));
    const records = runRecords(dir);
    assert.equal(records.length, 1);
    // Step commands are confined on every runtime; the fake runtime's agent is
    // not, so the record says which of the two this run got (ADR-058 limitation 8).
    assert.match(String(records[0]?.sandbox), /^unshare/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight: the human-only override runs unconfined and is recorded', async () => {
  const dir = makeProject();
  const previous = process.env[UNSAFE_NO_SANDBOX_ENV];
  try {
    writeWorkflow(dir, 'tools', [
      'name: tools',
      'version: 0.1.0',
      'description: one tool step',
      'steps:',
      '  - id: tool_step',
      '    type: tool',
      "    prompt: 'echo override-ok'",
    ]);
    process.env[UNSAFE_NO_SANDBOX_ENV] = '1';
    mkdirSync(join(dir, 'worktree'), { recursive: true });
    const cfg = loadConfig(dir);
    const out = await runTask({
      cwd: dir,
      prompt: 'x',
      runtimeId: 'fake',
      workflow: 'tools',
      worktree: join(dir, 'worktree'),
      sandbox: 'none',
      config: cfg,
    });
    assert.equal(out.status, 'completed', out.events.join('\n'));
    assert.ok(out.events.some((e) => e.includes('running WITHOUT a sandbox boundary')));
    const records = runRecords(dir);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.sandbox, 'none (unsafe override)');
  } finally {
    if (previous === undefined) delete process.env[UNSAFE_NO_SANDBOX_ENV];
    else process.env[UNSAFE_NO_SANDBOX_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});
