import { test } from 'node:test';
import assert from 'node:assert/strict';

// Contract-level unit tests for DeepSeekRuntimeAdapter metadata/capabilities.
// (Real integration requires COMMANDCODE_API_KEY — gated, not faked.)

test('DeepSeekRuntimeAdapter: metadata and capabilities contract', async () => {
  const { DeepSeekRuntimeAdapter } = await import('../index.js');
  const r = new DeepSeekRuntimeAdapter();
  const meta = r.metadata();
  assert.equal(meta.id, 'deepseek');
  assert.ok(meta.version);
  assert.equal(r.capabilities().capabilities.includes('shell'), true);
  assert.equal(r.capabilities().capabilities.includes('filesystem'), true);
  assert.ok(r.capabilities().maxParallelTasks >= 1);
  r.close();
});

test('DeepSeekRuntimeAdapter: run without API key fails honestly (no fake completion)', async () => {
  const { DeepSeekRuntimeAdapter } = await import('../index.js');
  const r = new DeepSeekRuntimeAdapter({ apiKey: '' });
  const events: string[] = [];
  for await (const ev of r.run({ id: 'no-key', prompt: 'x', cwd: '/tmp' })) {
    events.push(ev.type);
  }
  assert.ok(events.includes('task.failed'), 'expected honest task.failed without key');
  assert.equal(await r.getStatus('no-key'), 'failed');
  r.close();
});

test('DeepSeekRuntimeAdapter: shared runtime contract suite (real API, gated on key)', async () => {
  const { DeepSeekRuntimeAdapter } = await import('../index.js');
  const { runRuntimeContractSuite } = await import('@takumi/core');
  const apiKey = process.env.COMMANDCODE_API_KEY;
  const runtime = new DeepSeekRuntimeAdapter({ apiKey });
  try {
    const out = await runRuntimeContractSuite(runtime, {
      id: 'deepseek',
      prompt: 'Reply with exactly: CONTRACT_OK',
      cwd: '/tmp',
      skipRealRun: !apiKey,
    });
    if (!apiKey) {
      assert.equal(out.result, 'PASS_WITH_NOT_RUN');
    } else {
      assert.equal(out.result, 'PASS');
    }
  } finally {
    runtime.close();
  }
});
