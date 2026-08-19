import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from '../init.js';
import { loadConfig, resolveRuntime, runTask } from '../commands.js';

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