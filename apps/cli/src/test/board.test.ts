import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeBoardProvider } from '@takumi/board-fake';
import { createBoardProvider, parseBoardArgs, renderBoard, runBoardCommand } from '../board-command.js';

/**
 * The board command is READ-ONLY by construction: it only lists. These tests
 * pin that down (no claim/transition call exists to make), plus the argument
 * handling, which must reject an unknown flag instead of ignoring it.
 */

function captureStdout(fn: () => Promise<number> | number): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  return Promise.resolve()
    .then(fn)
    .then(
      (code) => ({ code, out: chunks.join('\n') }),
      (err: unknown) => {
        throw err;
      },
    )
    .finally(() => {
      console.log = original;
    });
}

test('parseBoardArgs: defaults to the fake provider and no state filter', () => {
  assert.deepEqual(parseBoardArgs([]), { providerId: 'fake', providerOptions: {}, json: false });
});

test('parseBoardArgs: accepts both "--flag value" and "--flag=value"', () => {
  const spaced = parseBoardArgs(['--provider', 'github', '--repo', 'owner/name', '--states', 'ready,claimed']);
  assert.equal(spaced.providerId, 'github');
  assert.equal(spaced.providerOptions['repo'], 'owner/name');
  assert.deepEqual(spaced.states, ['ready', 'claimed']);

  const inline = parseBoardArgs(['--provider=jira', '--base-url=https://x.atlassian.net', '--project-key=ABC', '--json']);
  assert.equal(inline.providerId, 'jira');
  assert.equal(inline.providerOptions['baseUrl'], 'https://x.atlassian.net');
  assert.equal(inline.providerOptions['projectKey'], 'ABC');
  assert.equal(inline.json, true);
});

test('parseBoardArgs: an unknown option is an error, never ignored', () => {
  assert.throws(() => parseBoardArgs(['--nope']), /unknown option for "takumi board": --nope/);
});

test('createBoardProvider: a provider without its required option fails fast', async () => {
  await assert.rejects(() => createBoardProvider({ providerId: 'github', providerOptions: {}, json: false }), /needs --repo owner\/name/);
  await assert.rejects(() => createBoardProvider({ providerId: 'notion', providerOptions: {}, json: false }), /needs --database/);
  await assert.rejects(
    () => createBoardProvider({ providerId: 'jira', providerOptions: {}, json: false }),
    /needs --base-url/,
  );
  await assert.rejects(() => createBoardProvider({ providerId: 'trello', providerOptions: {}, json: false }), /unknown board provider: trello/);
});

test('renderBoard: groups by state and prints the honest capability line', async () => {
  const provider = new FakeBoardProvider({
    items: [
      { id: 'A-1', state: 'ready', title: 'first' },
      { id: 'A-2', state: 'ready', title: 'second' },
      { id: 'A-3', state: 'pr_open', title: 'in review' },
    ],
  });
  const items = await provider.listWork();
  const out = renderBoard(provider, items, ['ready', 'pr_open', 'merged']);
  assert.match(out, /Takumi board — Fake Board \(fake 0\.1\.0\)/);
  assert.match(out, /ready \(2\)/);
  assert.match(out, /pr_open \(1\)/);
  assert.match(out, /merged \(0\)/);
  assert.match(out, /A-1\s+first/);
  assert.match(out, /atomicClaim=true/);
  assert.match(out, /delivery=\[pr,ci,merge\]/);
  assert.match(out, /3 item\(s\)\. Read-only view/);
});

test('renderBoard: a board with no delivery capability says "none" instead of staying silent', async () => {
  const provider = new FakeBoardProvider({
    items: [{ id: 'N-1', state: 'ready', title: 'a notion page' }],
    capabilities: { delivery: { canOpenPullRequest: false, canRunChecks: false, canMerge: false } },
  });
  const out = renderBoard(provider, await provider.listWork(), ['ready']);
  assert.match(out, /delivery=\[none\]/);
});

test('runBoardCommand: renders the demo board and exits 0', async () => {
  const { code, out } = await captureStdout(() => runBoardCommand(['--provider', 'fake']));
  assert.equal(code, 0);
  assert.match(out, /Takumi board — Fake Board/);
  assert.match(out, /DEMO-1/);
});

test('runBoardCommand: --json emits the provider, capabilities and items', async () => {
  const { code, out } = await captureStdout(() => runBoardCommand(['--provider', 'fake', '--json']));
  assert.equal(code, 0);
  const parsed = JSON.parse(out) as {
    provider: { id: string };
    capabilities: { states: string[] };
    items: Array<{ id: string; state: string }>;
  };
  assert.equal(parsed.provider.id, 'fake');
  assert.ok(parsed.capabilities.states.includes('merged'));
  assert.ok(parsed.items.some((i) => i.id === 'DEMO-1'));
});

test('runBoardCommand: --help documents the providers and stays read-only', async () => {
  const { code, out } = await captureStdout(() => runBoardCommand(['--help']));
  assert.equal(code, 0);
  assert.match(out, /usage: takumi board/);
  assert.match(out, /Read-only: takumi never claims, transitions or comments/);
  for (const provider of ['fake', 'github', 'gitlab', 'jira', 'notion']) {
    assert.ok(out.includes(provider), `help must mention ${provider}`);
  }
});

test('runBoardCommand: an unknown state is rejected against the provider declaration', async () => {
  await assert.rejects(() => runBoardCommand(['--provider', 'fake', '--states', 'done']), /unknown state: done/);
  await assert.rejects(
    () => runBoardCommand(['--provider', 'fake', '--states', 'merged,not-a-state']),
    /unknown state: not-a-state/,
  );
});

test('runBoardCommand: a filtered state list is honoured', async () => {
  const { out } = await captureStdout(() => runBoardCommand(['--provider', 'fake', '--states', 'pr_open']));
  assert.match(out, /pr_open \(1\)/);
  assert.doesNotMatch(out, /ready \(/);
});
