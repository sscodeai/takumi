import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRuntimeContractSuite, runTaskAndCollect, type AgentEvent } from '@takumi/core';
import { OpenHandsRuntimeAdapter } from '../index.js';

/**
 * The stub is a STAND-IN FOR THE CLI, and its output is a FIXTURE OF A REAL CAPTURE: the JSON
 * shapes below (ActionEvent / ObservationEvent / MessageEvent, and the prose the CLI interleaves)
 * were copied from a real `openhands --headless --json` run on 2026-09-16, and the accounting in
 * `base_state.json` mirrors the real path `stats.usage_to_metrics.agent.accumulated_token_usage`.
 * Nothing here exercises the network: the point is what the adapter does with what the CLI emits.
 */
const STUB = `
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const promptIndex = argv.indexOf('-t');
const prompt = promptIndex === -1 ? '' : (argv[promptIndex + 1] ?? '');
const home = process.env.OPENHANDS_HOME ?? '';
const conversationId = '4f2a1c9e77b04c8fa1d5e6b7c8d9e0f1';
const fail = process.env.STUB_FAIL === '1';
const noAccounting = process.env.STUB_NO_ACCOUNTING === '1';

const line = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
// The prose the real CLI prints around the JSON: the parser must skip it, not choke on it.
process.stdout.write('OpenHands CLI terminal UI may not work correctly in this environment\\n');
process.stdout.write('Initializing agent...\\n');
process.stdout.write('✓ Agent initialized with model: openai/deepseek/deepseek-v4-flash\\n');
process.stdout.write('Agent is working\\n');

line({ id: 'e1', timestamp: '2026-09-16T16:11:31.840517', source: 'user', kind: 'MessageEvent',
  llm_message: { role: 'user', content: [{ type: 'text', text: prompt }] }, llm_response_id: null });
line({ id: 'e2', timestamp: '2026-09-16T16:11:40.000000', source: 'agent', kind: 'ActionEvent',
  tool_name: 'execute_bash', tool_call_id: 'call_1', llm_response_id: 'resp_1',
  action: { command: 'python3 -m unittest -v' } });
line({ id: 'e3', timestamp: '2026-09-16T16:11:41.000000', source: 'environment', kind: 'ObservationEvent',
  tool_name: 'execute_bash', tool_call_id: 'call_1', observation: { output: 'OK\\nRan 3 tests' } });
line({ id: 'e4', timestamp: '2026-09-16T16:11:45.000000', source: 'agent', kind: 'ActionEvent',
  tool_name: 'file_editor', tool_call_id: 'call_2', action: { command: 'create', path: 'subtract.py' } });
line({ id: 'e5', timestamp: '2026-09-16T16:11:50.000000', source: 'agent', kind: 'MessageEvent',
  llm_message: { role: 'assistant', content: [{ type: 'text', text: 'Added subtract(a, b) and a unittest.' }] } });

if (!noAccounting) {
  mkdirSync(join(home, 'conversations', conversationId), { recursive: true });
  writeFileSync(join(home, 'conversations', conversationId, 'base_state.json'), JSON.stringify({
    id: conversationId,
    execution_status: 'finished',
    stats: {
      usage_to_metrics: {
        agent: {
          model_name: 'openai/deepseek/deepseek-v4-flash',
          accumulated_cost: 0.0,
          accumulated_token_usage: { prompt_tokens: 71044, completion_tokens: 983, cache_read_tokens: 58752, reasoning_tokens: 17 },
          token_usages: [{ prompt_tokens: 13242, completion_tokens: 254 }],
        },
        condenser: {
          model_name: 'openai/deepseek/deepseek-v4-flash',
          accumulated_cost: 0.0,
          accumulated_token_usage: { prompt_tokens: 0, completion_tokens: 0, cache_read_tokens: 0, reasoning_tokens: 0 },
        },
      },
    },
  }, null, 2));
}

process.stdout.write('Agent finished\\n');
process.stdout.write('CONVERSATION SUMMARY\\nNumber of agent messages: 3\\nConversation ID:\\n' + conversationId + '\\n');
process.exit(fail ? 1 : 0);
`;

interface Harness {
  root: string;
  home: string;
  cwd: string;
  stub: string;
  make: (env?: Record<string, string>) => OpenHandsRuntimeAdapter;
  cleanup: () => void;
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'takumi-openhands-'));
  const home = join(root, 'openhands-home');
  const cwd = join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const stub = join(root, 'openhands-stub.mjs');
  writeFileSync(stub, STUB);
  // A real git worktree, so the file artifacts come from git and not from a self-report.
  const git = (args: string[]) =>
    execFileSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', ...args], { cwd, encoding: 'utf8' });
  git(['init', '--initial-branch=main']);
  writeFileSync(join(cwd, 'calc.py'), 'def add(a, b):\n    return a + b\n');
  git(['add', '.']);
  git(['commit', '-m', 'chore: fixture']);
  // The task's own change, which the adapter must report as a file artifact.
  writeFileSync(join(cwd, 'subtract.py'), 'def subtract(a, b):\n    return a - b\n');
  return {
    root,
    home,
    cwd,
    stub,
    make: (env = {}) =>
      new OpenHandsRuntimeAdapter({
        command: process.execPath,
        extraArgs: [stub],
        home,
        env: { OPENHANDS_HOME: home, ...env },
        timeoutSeconds: 60,
      }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('OpenHands runtime: the shared Runtime Contract Suite passes with a real run', async () => {
  const h = harness();
  try {
    const result = await runRuntimeContractSuite(h.make(), {
      id: 'openhands',
      prompt: 'Add subtract(a, b) and a unittest for it.',
      cwd: h.cwd,
    });
    assert.equal(result.gate, 'runtime-contract');
    assert.equal(result.result, 'PASS', result.notes.join(' | '));
    assert.ok(result.notes.some((n) => n.startsWith('usage: PASS')), result.notes.join(' | '));
  } finally {
    h.cleanup();
  }
});

test('OpenHands runtime: the JSON stream becomes events, and the prose is skipped', async () => {
  const h = harness();
  try {
    const runtime = h.make();
    const events: AgentEvent[] = [];
    const result = await runTaskAndCollect(runtime, { id: 't-map', prompt: 'do the thing', cwd: h.cwd }, (ev) =>
      events.push(ev),
    );
    assert.equal(result.status, 'completed');
    assert.equal(events[0]?.type, 'task.started');
    assert.equal(events.at(-1)?.type, 'task.completed');
    const types = events.map((e) => e.type);
    assert.ok(types.includes('command.started'), `the bash action must be a command: ${types.join(',')}`);
    assert.ok(types.includes('command.completed'), `its observation must close the command: ${types.join(',')}`);
    assert.ok(types.includes('tool.started'), `the file edit must be a tool: ${types.join(',')}`);
    assert.ok(types.includes('agent.message'), 'the assistant message must surface');
    assert.equal(
      types.includes('test.completed'),
      false,
      'a test run is not distinguishable in the stream, so it must NOT be claimed',
    );
    // The skipped prose is reported, not hidden.
    const completed = events.at(-1);
    assert.ok(Number((completed?.data as { skippedLines?: number })?.skippedLines ?? 0) >= 4);
  } finally {
    h.cleanup();
  }
});

test('OpenHands runtime: usage comes from the conversation accounting, as recorded', async () => {
  const h = harness();
  try {
    const runtime = h.make();
    await runTaskAndCollect(runtime, { id: 't-usage', prompt: 'p', cwd: h.cwd });
    const usage = await runtime.getUsage('t-usage');
    assert.equal(usage.runtimeId, 'openhands');
    assert.equal(usage.promptTokens, 71044);
    assert.equal(usage.completionTokens, 983);
    assert.equal(usage.totalTokens, 72027);
    assert.equal(usage.costUsd, 0, 'cost is reported AS RECORDED — an endpoint with no pricing records 0.0');
    assert.equal(usage.model, 'openai/deepseek/deepseek-v4-flash');
    const extra = usage.extra as { cacheReadTokens: number; conversationId: string; costNote?: string };
    assert.equal(extra.cacheReadTokens, 58752);
    assert.equal(extra.conversationId, '4f2a1c9e77b04c8fa1d5e6b7c8d9e0f1');
    assert.ok((extra.costNote ?? '').length > 0, 'the cost caveat must travel with the number');
    assert.ok(usage.durationMs >= 0);
  } finally {
    h.cleanup();
  }
});

test('OpenHands runtime: artifacts are the transcript and the files git reports, never the worktree', async () => {
  const h = harness();
  try {
    const runtime = h.make();
    await runTaskAndCollect(runtime, { id: 't-art', prompt: 'p', cwd: h.cwd });
    const artifacts = await runtime.getArtifacts('t-art');
    const kinds = artifacts.map((a) => a.kind);
    assert.ok(kinds.includes('evidence'), `the transcript must be evidence: ${JSON.stringify(artifacts)}`);
    assert.ok(kinds.includes('code'), 'the changed file must be reported as code');
    const code = artifacts.find((a) => a.kind === 'code');
    assert.equal(code?.path, 'subtract.py');
    const transcript = artifacts.find((a) => a.contentType === 'application/x-ndjson');
    assert.ok(transcript !== undefined && transcript.sizeBytes !== undefined && transcript.sizeBytes > 0);
    // The invariant that matters for delivery: the transcript is NOT inside the worktree.
    assert.equal(transcript?.path.includes(h.cwd), false, 'the transcript must not dirty the worktree');
    assert.equal(existsSync(join(h.cwd, 'takumi-runs')), false);
  } finally {
    h.cleanup();
  }
});

test('OpenHands runtime: a missing accounting is an UNAVAILABLE usage, never a free task', async () => {
  const h = harness();
  try {
    const runtime = h.make({ STUB_NO_ACCOUNTING: '1' });
    await runTaskAndCollect(runtime, { id: 't-noacct', prompt: 'p', cwd: h.cwd });
    const usage = await runtime.getUsage('t-noacct');
    assert.equal(usage.totalTokens, 0);
    const extra = usage.extra as { usageUnavailable?: string };
    assert.ok((extra.usageUnavailable ?? '').length > 0, 'zeros must carry the reason they are zeros');
  } finally {
    h.cleanup();
  }
});

test('OpenHands runtime: a failing run is task.failed and status failed, not a quiet completion', async () => {
  const h = harness();
  try {
    const runtime = h.make({ STUB_FAIL: '1' });
    const events: AgentEvent[] = [];
    const result = await runTaskAndCollect(runtime, { id: 't-fail', prompt: 'p', cwd: h.cwd }, (ev) => events.push(ev));
    assert.equal(events.at(-1)?.type, 'task.failed');
    assert.equal(result.status, 'failed');
    assert.equal(await runtime.getStatus('t-fail'), 'failed');
  } finally {
    h.cleanup();
  }
});

test('OpenHands runtime: the task prompt is handed to the CLI as -t <prompt>', async () => {
  const h = harness();
  try {
    const runtime = h.make();
    await runTaskAndCollect(runtime, { id: 't-prompt', prompt: 'the exact instruction', cwd: h.cwd });
    const transcript = (await runtime.getArtifacts('t-prompt')).find((a) => a.contentType === 'application/x-ndjson');
    assert.ok(transcript !== undefined);
    const text = execFileSync('cat', [transcript.path], { encoding: 'utf8' });
    assert.match(text, /the exact instruction/, 'the agent must receive the work, not just an id');
  } finally {
    h.cleanup();
  }
});
