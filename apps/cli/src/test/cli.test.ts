import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, chmodSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../init.js';
import { loadConfig, loadWorkflow, requirementConfirmation, resolveRuntime, runTask, workflowExitCode } from '../commands.js';

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-cli-test-'));
  initProject(dir);
  // Give the workflow registry a real workflow extension to list.
  mkdirSync(join(dir, 'extensions/workflows/jp-si-standard'), { recursive: true });
  writeFileSync(
    join(dir, 'extensions/workflows/jp-si-standard/manifest.yaml'),
    'name: jp-si-standard\nkind: workflow\nversion: 0.1.0\ndescription: Japanese SI standard V-model flow\n',
  );
  return dir;
}

test('initProject creates takumi.yaml + registry dirs', () => {
  const dir = makeProject();
  try {
    assert.ok(existsSync(join(dir, 'takumi.yaml')));
    assert.ok(existsSync(join(dir, '.takumi/artifacts')));
    assert.ok(existsSync(join(dir, 'extensions/skills')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('initProject is idempotent (second call creates nothing)', () => {
  const dir = makeProject();
  try {
    const second = initProject(dir);
    assert.deepEqual(second, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig parses takumi.yaml', () => {
  const dir = makeProject();
  try {
    const cfg = loadConfig(dir);
    assert.equal(cfg.runtime, 'fake');
    assert.equal(cfg.registry.skills, 'extensions/skills');
    assert.equal(cfg.artifacts, '.takumi/artifacts');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runTask: fake runtime full chain produces event stream + summary', async () => {
  const dir = makeProject();
  try {
    const cfg = loadConfig(dir);
    const out = await runTask({
      cwd: dir,
      prompt: 'Implement employee CRUD API',
      runtimeId: 'fake',
      config: cfg,
    });
    assert.ok(out.events.includes('task.started'));
    assert.ok(out.events.some((e) => e.startsWith('task.completed')));
    assert.ok(out.summary.includes('employee CRUD API'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveRuntime: fake works, unknown throws', async () => {
  const r = await resolveRuntime('fake');
  assert.equal(r.metadata().id, 'fake');
  await assert.rejects(() => resolveRuntime('nope'), /unknown runtime/);
});

// The loader is the reader of the step-type contract: a manifest that names a
// type the engine cannot execute fails at load, and `rule_review` is a
// first-class type the CLI loads and runs.
test('loadWorkflow: rule_review is accepted, an unknown step type is refused', async () => {
  const dir = makeProject();
  try {
    const cfg = loadConfig(dir);
    const wfDir = join(dir, 'extensions/workflows/rule-check');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      ['name: rule-check', 'version: 0.1.0', 'description: deterministic rules', 'steps:', '  - id: rules', '    type: rule_review', '    baseRef: HEAD', ''].join('\n'),
    );
    const loaded = await loadWorkflow(dir, cfg, 'rule-check');
    assert.equal(loaded.steps[0]?.type, 'rule_review');

    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      ['name: rule-check', 'version: 0.1.0', 'description: broken', 'steps:', '  - id: rules', '    type: not_a_step', ''].join('\n'),
    );
    await assert.rejects(() => loadWorkflow(dir, cfg, 'rule-check'), /unknown type "not_a_step"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runTask: a workflow containing rule_review runs to completion over a real repository', async () => {
  const dir = makeProject();
  try {
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.invalid',
    };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env: gitEnv });
    writeFileSync(join(dir, 'README.md'), '# fixture\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, env: gitEnv });
    execFileSync('git', ['commit', '-q', '-m', 'chore: fixture'], { cwd: dir, env: gitEnv });

    const wfDir = join(dir, 'extensions/workflows/rule-check');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      ['name: rule-check', 'version: 0.1.0', 'description: deterministic rules', 'steps:', '  - id: rules', '    type: rule_review', '    baseRef: HEAD', '    headRef: HEAD', ''].join('\n'),
    );
    const cfg = loadConfig(dir);
    const out = await runTask({ cwd: dir, prompt: 'review the change', runtimeId: 'fake', workflow: 'rule-check', config: cfg });
    assert.match(out.summary, /workflow "rule-check" completed/);
    assert.ok(out.artifacts.some((path) => path.endsWith('rules.md')), `the findings artifact is in the delivery (${out.artifacts.join(', ')})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The exit code is the only thing a CI job can read. Before this fix the CLI
// printed `✓ workflow "..." failed` and exited 0, so a failed delivery (and a
// failed black-box acceptance) was indistinguishable from a green one.
test('runTask: a failed workflow reports its status, and the CLI exit code follows it', async () => {
  const dir = makeProject();
  try {
    writeFileSync(join(dir, 'gate.sh'), '#!/bin/sh\necho "# tests 1"\necho "# pass 0"\necho "# fail 1"\nexit 1\n');
    const wfDir = join(dir, 'extensions/workflows/failing-gate');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      [
        'name: failing-gate',
        'version: 0.1.0',
        'description: a gate that cannot pass',
        'steps:',
        '  - id: gate',
        '    type: quality_gate',
        '    prompt: sh gate.sh',
        '  - id: ship',
        '    type: delivery',
        '    prompt: ship the delivery',
        '    dependsOn: [gate]',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    const out = await runTask({ cwd: dir, prompt: 'ship it', runtimeId: 'fake', workflow: 'failing-gate', config: cfg });

    assert.equal(out.status, 'failed', 'the workflow outcome must reach the caller');
    assert.match(out.summary, /workflow "failing-gate" failed/);
    assert.equal(workflowExitCode(out.status), 1, 'a failed workflow must not exit 0');
    assert.ok(
      !out.artifacts.some((p) => p.includes('delivery')),
      `nothing may be delivered after a failed gate (${out.artifacts.join(', ')})`,
    );

    assert.equal(workflowExitCode(undefined), 0, 'the plain path has no workflow outcome');
    assert.equal(workflowExitCode('completed'), 0);
    assert.equal(workflowExitCode('cancelled'), 1, 'a rejected approval is not a success either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ADR-025 through the CLI: the confirmation token, the acceptance step, and a refusal that names an
// edited requirement.
const ACCEPT_REQUIREMENT = [
  'requirements:',
  '  - id: REQ-001',
  '    title: Summarise the CSV',
  'ambiguities:',
  '  - id: AMB-001',
  '    question: What happens to a malformed row?',
  '    options: ["stop", "skip and count"]',
  '    default: "skip and count"',
  '    blocking: true',
  '',
].join('\n');

function acceptProject(): string {
  const dir = makeProject();
  mkdirSync(join(dir, 'docs/requirements'), { recursive: true });
  mkdirSync(join(dir, 'checks'), { recursive: true });
  writeFileSync(join(dir, 'docs/requirements/feature.yaml'), ACCEPT_REQUIREMENT);
  writeFileSync(join(dir, 'checks/accept.sh'), '#!/bin/sh\necho "ok 1 - the summary has one row per department"\necho "ACCEPT_VERDICT: pass"\nexit 0\n');
  chmodSync(join(dir, 'checks/accept.sh'), 0o755);
  mkdirSync(join(dir, 'extensions/workflows/accept-flow'), { recursive: true });
  writeFileSync(
    join(dir, 'extensions/workflows/accept-flow/workflow.yaml'),
    [
      'name: accept-flow',
      'version: 0.1.0',
      'description: an acceptance step over a confirmed requirement',
      'steps:',
      '  - id: accept',
      '    type: acceptance',
      '    requirementRef: docs/requirements/feature.yaml',
      '    acceptanceRef: checks/accept.sh',
      '  - id: ship',
      '    type: delivery',
      '    prompt: ship the delivery',
      '    dependsOn: [accept]',
      '',
    ].join('\n'),
  );
  return dir;
}

test('requirement digest: the confirmation token is stable, and an edit changes it', () => {
  const dir = acceptProject();
  try {
    const token = requirementConfirmation(dir, 'docs/requirements/feature.yaml');
    assert.equal(token.ref, 'docs/requirements/feature.yaml');
    assert.match(token.digest, /^[0-9a-f]{64}$/);
    assert.equal(requirementConfirmation(dir, 'docs/requirements/feature.yaml').digest, token.digest);
    writeFileSync(join(dir, 'docs/requirements/feature.yaml'), ACCEPT_REQUIREMENT.replace('skip and count"]', 'stop"]'));
    assert.notEqual(requirementConfirmation(dir, 'docs/requirements/feature.yaml').digest, token.digest, 'an edited document is a different token');
    assert.throws(() => requirementConfirmation(dir, 'docs/requirements/nope.yaml'), /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runTask: an acceptance workflow completes on the confirmed document, and refuses an edited one', async () => {
  const dir = acceptProject();
  try {
    const cfg = loadConfig(dir);
    const confirmed = requirementConfirmation(dir, 'docs/requirements/feature.yaml');

    const ok = await runTask({ cwd: dir, prompt: 'ship it', runtimeId: 'fake', workflow: 'accept-flow', config: cfg, confirmedRequirement: confirmed });
    assert.equal(ok.status, 'completed', `the acceptance passes on the confirmed document (${ok.events.join(' | ')})`);
    assert.ok(
      ok.artifacts.some((p) => p.includes('acceptance/ACCEPT-001.md')),
      `the ACCEPT artifact is part of the run (${ok.artifacts.join(', ')})`,
    );

    // The document is edited after the confirmation: the acceptance refuses, by name, and nothing ships.
    writeFileSync(join(dir, 'docs/requirements/feature.yaml'), ACCEPT_REQUIREMENT.replace('skip and count"]', 'stop"]'));
    const stale = await runTask({ cwd: dir, prompt: 'ship it', runtimeId: 'fake', workflow: 'accept-flow', config: cfg, confirmedRequirement: confirmed });
    assert.equal(stale.status, 'failed');
    assert.match(stale.events.join('\n'), /is not the one that was confirmed/);
    assert.ok(!stale.artifacts.some((p) => p.includes('delivery-manifest')), 'a refused acceptance delivers nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runTask: an acceptance with no confirmation on record fails instead of accepting itself', async () => {
  const dir = acceptProject();
  try {
    const cfg = loadConfig(dir);
    const res = await runTask({ cwd: dir, prompt: 'ship it', runtimeId: 'fake', workflow: 'accept-flow', config: cfg });
    assert.equal(res.status, 'failed');
    assert.match(res.events.join('\n'), /no confirmed requirement is on record/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadWorkflow: an acceptance step with no requirementRef is refused at load', async () => {
  const dir = acceptProject();
  try {
    writeFileSync(
      join(dir, 'extensions/workflows/accept-flow/workflow.yaml'),
      ['name: accept-flow', 'version: 0.1.0', 'description: broken', 'steps:', '  - id: accept', '    type: acceptance', '    acceptanceRef: checks/accept.sh', ''].join('\n'),
    );
    await assert.rejects(
      () => loadWorkflow(dir, loadConfig(dir), 'accept-flow'),
      /requires a non-empty requirementRef/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Gate 24/31: a THIRD runtime (external harness CLI) is resolvable by config
// via the cli:<command> scheme — proving runtime change is config-only, and
// the CLI does not hardcode fake/pi.
test('resolveRuntime: cli:<command> bridges an external harness CLI (Gate 24/31)', async () => {
  const r = await resolveRuntime('cli:echo');
  assert.equal(r.metadata().name, 'CLI (echo)');
  // pi is opt-in: without the Pi SDK installed it reports BLOCKED (never a fake).
  if (!process.env.OPENCODE_GO_API_KEY) {
    await assert.rejects(() => resolveRuntime('pi'), /BLOCKED_BY_EXTERNAL_DEPENDENCY/);
  }
});