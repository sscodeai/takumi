import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_WORK_ITEM_STATES,
  BoardError,
  BoardStateError,
  renderBoardStateRecord,
  runTaskBoardProviderContractSuite,
} from '@takumi/core';
import type { BoardHttpRequest, BoardHttpResponse, BoardRequestFn, BoardStateRecord } from '@takumi/core';
import { createGitHubBoardProvider, GitHubBoardProvider, runMarker } from '../index.js';

/**
 * An in-memory GitHub: no network, no token. It answers exactly the endpoints
 * the adapter is allowed to use and records every request, so the tests can
 * assert the REAL request shape (not that "a call happened somewhere").
 */

interface SimIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: string;
  labels: string[];
  assignees: string[];
  updated_at: string;
  pull_request?: unknown;
}

interface SimComment {
  id: number;
  body: string;
  author_association: string;
  /** GitHub returns an OBJECT here: `user.login` is how the adapter recognizes
   * its own comments. A plain string would hide a real bug. */
  user: { login: string };
  html_url: string;
}

const REPO = 'acme/widgets';

function issue(number: number, labels: string[], extra: Partial<SimIssue> = {}): SimIssue {
  return {
    number,
    title: `Issue ${number}`,
    body: 'please do the thing',
    html_url: `https://github.com/${REPO}/issues/${number}`,
    state: 'open',
    labels,
    assignees: [],
    updated_at: '2026-09-15T00:00:00.000Z',
    ...extra,
  };
}

function githubSimulator(seedIssues: SimIssue[], seedComments: SimComment[] = [], seedLabels: string[] = []) {
  const issues = seedIssues;
  const comments = seedComments;
  /** Repository labels: what `bootstrapStates` lists and creates. */
  const labels = seedLabels;
  const requests: BoardHttpRequest[] = [];
  let commentSeq = 1000;

  const json = (payload: unknown, status = 200): BoardHttpResponse => ({ status, body: JSON.stringify(payload) });
  const notFound = () => json({ message: 'Not Found' }, 404);

  const request: BoardRequestFn = async (req) => {
    requests.push(req);
    const url = new URL(req.url);
    const path = url.pathname;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const issueMatch = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(path);
    const labelMatch = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/labels(?:\/(.+))?$/.exec(path);
    const commentsMatch = /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/.exec(path);
    const commentPatch = /^\/repos\/([^/]+)\/([^/]+)\/issues\/comments\/(\d+)$/.exec(path);

    if (req.method === 'GET' && path === '/user') return json({ login: 'bot-user' });

    // Repository labels: what bootstrapStates lists and creates.
    const repoLabels = /^\/repos\/([^/]+)\/([^/]+)\/labels$/.exec(path);
    if (req.method === 'GET' && repoLabels) {
      return json(labels.map((name) => ({ name, color: 'ededed' })));
    }
    if (req.method === 'POST' && repoLabels) {
      const name = String(body['name'] ?? '');
      labels.push(name);
      return json({ name, color: body['color'] }, 201);
    }

    if (req.method === 'GET' && path.endsWith('/issues')) {
      const wanted = url.searchParams.get('labels');
      const filtered = issues.filter((i) => (wanted === null ? true : i.labels.includes(wanted)));
      return json(filtered);
    }
    if (req.method === 'GET' && issueMatch) {
      const found = issues.find((i) => String(i.number) === issueMatch[3]);
      return found ? json(found) : notFound();
    }
    if (req.method === 'POST' && labelMatch && labelMatch[4] === undefined) {
      const found = issues.find((i) => String(i.number) === labelMatch[3]);
      if (!found) return notFound();
      for (const label of (body['labels'] ?? []) as string[]) {
        if (!found.labels.includes(label)) found.labels.push(label);
      }
      return json(found.labels);
    }
    if (req.method === 'DELETE' && labelMatch && labelMatch[4] !== undefined) {
      const found = issues.find((i) => String(i.number) === labelMatch[3]);
      if (!found) return notFound();
      const name = decodeURIComponent(labelMatch[4]);
      const before = found.labels.length;
      found.labels = found.labels.filter((l) => l !== name);
      return before === found.labels.length ? notFound() : json(found.labels);
    }
    if (req.method === 'GET' && commentsMatch) {
      const forIssue = comments.filter((c) => c.html_url.includes(`/issues/${commentsMatch[3]}#`));
      return json(forIssue);
    }
    if (req.method === 'POST' && commentsMatch) {
      commentSeq += 1;
      const created: SimComment = {
        id: commentSeq,
        body: String(body['body'] ?? ''),
        author_association: 'MEMBER',
        user: { login: 'bot-user' },
        html_url: `https://github.com/${REPO}/issues/${commentsMatch[3]}#issuecomment-${commentSeq}`,
      };
      comments.push(created);
      return json(created, 201);
    }
    if (req.method === 'PATCH' && commentPatch) {
      const found = comments.find((c) => String(c.id) === commentPatch[3]);
      if (!found) return notFound();
      found.body = String(body['body'] ?? '');
      return json(found);
    }
    return notFound();
  };

  return { request, requests, issues, comments, labels };
}

function provider(sim: ReturnType<typeof githubSimulator>, extra: Record<string, unknown> = {}) {
  return createGitHubBoardProvider({ repo: REPO, request: sim.request, ...extra });
}

const RUN = 'c0ffee01';

test('bootstrapStates: creates the six state labels, and a dry run creates nothing', async () => {
  const sim = githubSimulator([issue(7, [])], [], []);
  const board = provider(sim);

  const dry = await board.bootstrapStates(BOARD_WORK_ITEM_STATES, { dryRun: true });
  assert.equal(dry.applied, false);
  assert.deepEqual(dry.actions.map((a) => a.outcome), ['would-create', 'would-create', 'would-create', 'would-create', 'would-create', 'would-create']);
  assert.deepEqual(dry.actions.map((a) => a.name), ['takumi-ready', 'takumi-claimed', 'takumi-pr-open', 'takumi-fix-needed', 'takumi-merged', 'takumi-blocked']);
  assert.equal(
    sim.requests.some((r) => r.method === 'POST'),
    false,
    'a dry run must not create anything',
  );
  assert.deepEqual(sim.labels, []);

  const applied = await board.bootstrapStates(BOARD_WORK_ITEM_STATES);
  assert.equal(applied.applied, true);
  assert.equal(applied.actions.every((a) => a.outcome === 'created'), true);
  assert.deepEqual(sim.labels, ['takumi-ready', 'takumi-claimed', 'takumi-pr-open', 'takumi-fix-needed', 'takumi-merged', 'takumi-blocked']);
  const create = sim.requests.find((r) => r.method === 'POST');
  assert.equal((create?.body as Record<string, unknown>)['color'], '1f6feb');

  // Idempotent: a second call changes nothing and reports what exists.
  const again = await board.bootstrapStates(BOARD_WORK_ITEM_STATES);
  assert.equal(again.applied, false);
  assert.equal(again.actions.every((a) => a.outcome === 'exists'), true);
  assert.equal(sim.labels.length, 6, 'the second call must not duplicate labels');
});

test('bootstrapStates: reports the labels the repository already has, and honours a custom prefix', async () => {
  const sim = githubSimulator([issue(7, [])], [], ['takumi-ready', 'unrelated']);
  const board = provider(sim);
  const report = await board.bootstrapStates(['ready', 'merged']);
  assert.deepEqual(report.actions, [
    { state: 'ready', name: 'takumi-ready', outcome: 'exists' },
    { state: 'merged', name: 'takumi-merged', outcome: 'created' },
  ]);
  assert.deepEqual(sim.labels, ['takumi-ready', 'unrelated', 'takumi-merged']);

  const prefixed = githubSimulator([issue(7, [])], [], []);
  const custom = provider(prefixed, { labelPrefix: 'tk-' });
  const customReport = await custom.bootstrapStates(['ready']);
  assert.equal(customReport.actions[0]?.name, 'tk-ready');
  assert.deepEqual(prefixed.labels, ['tk-ready']);
});

test('GitHubBoardProvider: the shared task-board contract suite over an injected transport', async () => {
  const sim = githubSimulator([issue(7, ['takumi-ready'])]);
  const out = await runTaskBoardProviderContractSuite(provider(sim), { id: 'github', itemId: '7' });
  assert.equal(out.gate, 'task-board-contract');
  // GitHub passes everything except the trust-boundary check, which needs a
  // foreign write this adapter cannot perform (it always writes as itself):
  // the read filter is proven by the dedicated test below instead.
  assert.equal(out.result, 'PASS_WITH_NOT_RUN');
  assert.ok(out.notes.some((n) => n.includes('no writeUntrustedRecord injection point')), out.notes.join('\n'));
  assert.ok(out.notes.some((n) => n.startsWith('claim: PASS')));
  assert.ok(out.notes.some((n) => n.startsWith('terminal: PASS')));
});

test('capabilities: honest about the one thing GitHub cannot do atomically', () => {
  const caps = new GitHubBoardProvider({ repo: REPO, request: async () => ({ status: 200, body: '{}' }) }).capabilities();
  assert.equal(caps.atomicClaim, false);
  assert.equal(caps.trustedAuthorFilter, true);
  assert.equal(caps.machineReadableState, true);
  assert.deepEqual(caps.delivery, { canOpenPullRequest: true, canRunChecks: true, canMerge: true });
  assert.deepEqual(caps.states, ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked']);
});

test('request shapes: one label-filtered list per state, pull requests dropped', async () => {
  const sim = githubSimulator([
    issue(7, ['takumi-ready']),
    issue(8, ['takumi-claimed']),
    issue(9, ['takumi-ready'], { pull_request: { url: 'https://api.github.com/…/pulls/9' } }),
    issue(10, ['docs']),
  ]);
  const board = provider(sim);

  const ready = await board.listWork();
  assert.equal(sim.requests[0]?.method, 'GET');
  assert.match(String(sim.requests[0]?.url), /\/repos\/acme\/widgets\/issues\?state=open&per_page=100&labels=takumi-ready$/);
  assert.deepEqual(ready.map((i) => i.id), ['7'], 'a PR and an untagged issue must not be work items');

  const two = await board.listWork({ states: ['ready', 'claimed'] });
  assert.equal(sim.requests.length, 3, 'one request per state: the labels parameter is AND, not OR');
  assert.deepEqual(two.map((i) => i.id).sort(), ['7', '8']);
});

test('getWork: an unresolvable item is a not_found / precondition error, never a guess', async () => {
  const sim = githubSimulator([issue(7, ['takumi-ready'])]);
  const board = provider(sim);
  await assert.rejects(
    () => board.getWork('404'),
    (e: unknown) => e instanceof BoardError && e.kind === 'not_found',
  );
  await assert.rejects(
    () => provider(githubSimulator([issue(11, ['bug'])])).getWork('11'),
    /carries no takumi-\* label/,
  );
});

test('state resolution: several state labels resolve to the furthest-along delivery', async () => {
  const sim = githubSimulator([issue(12, ['takumi-ready', 'takumi-pr-open', 'takumi-claimed'])]);
  assert.equal((await provider(sim).getWork('12')).state, 'pr_open');
});

test('claim: adds the claimed label, drops ready, writes the record and verifies the re-read', async () => {
  const sim = githubSimulator([issue(7, ['takumi-ready'])]);
  const board = provider(sim);
  const result = await board.claim('7', RUN);
  assert.deepEqual(result, { item: '7', runId: RUN, claimed: true });

  const writes = sim.requests.filter((r) => r.method === 'POST' || r.method === 'DELETE');
  assert.deepEqual(writes[0]?.body, { labels: ['takumi-claimed'] });
  assert.match(String(writes[1]?.url), /labels\/takumi-ready$/);
  assert.equal(sim.issues[0]?.labels.includes('takumi-claimed'), true);
  assert.equal(sim.issues[0]?.labels.includes('takumi-ready'), false);

  const record = (await board.readState('7')) as BoardStateRecord;
  assert.equal(record.runId, RUN);
  assert.equal(record.schema, 1);
});

test('claim: a second run is refused with a reason', async () => {
  const sim = githubSimulator([issue(7, ['takumi-ready'])]);
  const board = provider(sim);
  await board.claim('7', RUN);
  const second = await board.claim('7', 'deadbeef');
  assert.equal(second.claimed, false);
  assert.match(second.reason ?? '', /already claimed by c0ffee01/);
});

test('claim: losing a concurrent race is reported, not accepted', async () => {
  const sim = githubSimulator([issue(7, ['takumi-ready'])]);
  // A rival run (a second maintainer's token) claims the item between our read
  // and our re-read: its record is newer, so our re-read must see it and refuse.
  const racing: BoardRequestFn = async (req) => {
    if (req.method === 'POST' && String(req.url).includes('/labels')) {
      sim.comments.push({
        id: 999,
        body: renderBoardStateRecord({
          schema: 1,
          runId: 'rival123',
          item: '7',
          reviewRound: 0,
          updatedAt: '2030-01-01T00:00:00.000Z',
        }),
        author_association: 'MEMBER',
        user: { login: 'rival-bot' },
        html_url: `https://github.com/${REPO}/issues/7#issuecomment-999`,
      });
    }
    return sim.request(req);
  };
  const result = await createGitHubBoardProvider({ repo: REPO, request: racing }).claim('7', RUN);
  assert.equal(result.claimed, false);
  assert.match(result.reason ?? '', /lost a concurrent claim to rival123/);
});

test('claim: DOCUMENTED LIMITATION — two runs sharing one GitHub account can both believe they won', async () => {
  // This test asserts the limitation on purpose (ADR-006, `atomicClaim: false`).
  // GitHub has no compare-and-set for labels or comments, so when the rival run
  // writes AS THE SAME ACCOUNT, the second writer's record wins, both re-reads
  // see "their own" record and BOTH claims look successful. Nothing in the API
  // can close that window, which is exactly why the caller must serialize
  // claims locally (one runner per item — a slot lock, not a board feature).
  // If this behaviour ever changes, this test fails and the ADR must be updated.
  const sim = githubSimulator([issue(7, ['takumi-ready'])]);
  const racing: BoardRequestFn = async (req) => {
    if (req.method === 'POST' && String(req.url).includes('/labels')) {
      sim.comments.push({
        id: 998,
        body: renderBoardStateRecord({
          schema: 1,
          runId: 'rival456',
          item: '7',
          reviewRound: 0,
          updatedAt: '2026-09-15T00:00:00.000Z',
        }),
        author_association: 'MEMBER',
        user: { login: 'bot-user' },
        html_url: `https://github.com/${REPO}/issues/7#issuecomment-998`,
      });
    }
    return sim.request(req);
  };
  const result = await createGitHubBoardProvider({ repo: REPO, request: racing }).claim('7', RUN);
  assert.equal(result.claimed, true, 'same-account races are not detectable — hence the local slot lock');
  assert.equal((await provider(sim).readState('7'))?.runId, RUN);
});

test('transition: an illegal transition throws BoardStateError and writes nothing', async () => {
  const sim = githubSimulator([issue(7, ['takumi-merged'])]);
  const board = provider(sim);
  await assert.rejects(() => board.transition('7', 'claimed', { runId: RUN }), BoardStateError);
  assert.deepEqual(sim.requests.map((r) => r.method), ['GET'], 'only the state read is allowed');
});

test('transition: a legal move swaps the labels and keeps the run id', async () => {
  const sim = githubSimulator([issue(7, ['takumi-ready'])]);
  const board = provider(sim);
  await board.claim('7', RUN);
  await board.transition('7', 'pr_open', { runId: RUN, note: 'PR #7' });
  assert.equal(sim.issues[0]?.labels.includes('takumi-pr-open'), true);
  assert.equal(sim.issues[0]?.labels.includes('takumi-claimed'), false);
  const record = (await board.readState('7')) as BoardStateRecord;
  assert.equal(record.runId, RUN);
  assert.equal(record.note, 'PR #7');
});

test('comments: one progress comment per run, patched in place, marker present', async () => {
  const sim = githubSimulator([issue(7, ['takumi-ready'])]);
  const board = provider(sim);
  const first = await board.comment('7', 'starting', { runId: RUN });
  assert.match(sim.comments[0]?.body ?? '', new RegExp(`${RUN} -->`));
  assert.match(sim.comments[0]?.body ?? '', new RegExp(runMarker(RUN)));

  const second = await board.comment('7', 'still working', { runId: RUN });
  assert.equal(second.comment, first.comment, 'the same run must keep ONE progress comment');
  assert.equal(sim.comments.length, 1);
  assert.match(sim.comments[0]?.body ?? '', /^still working/);

  const other = await board.comment('7', 'another run', { runId: 'deadbeef' });
  assert.notEqual(other.comment, first.comment);
  assert.equal(sim.comments.length, 2);
});

test('comments: patching an unknown comment id fails loudly', async () => {
  const sim = githubSimulator([issue(7, ['takumi-ready'])]);
  const board = provider(sim);
  const ref = await board.comment('7', 'starting', { runId: RUN });
  await assert.rejects(
    () => board.updateComment({ ...ref, comment: '424242' }, 'nope'),
    (e: unknown) => e instanceof BoardError && e.kind === 'not_found',
  );
});

test('trust: a state block written by an untrusted author is ignored', async () => {
  const hostile: BoardStateRecord = {
    schema: 1,
    runId: 'badbadba',
    item: '7',
    reviewRound: 0,
    updatedAt: '2030-01-01T00:00:00.000Z',
  };
  const sim = githubSimulator(
    [issue(7, ['takumi-ready'])],
    [
      {
        id: 1,
        body: renderBoardStateRecord(hostile),
        author_association: 'NONE',
        user: { login: 'drive-by' },
        html_url: `https://github.com/${REPO}/issues/7#issuecomment-1`,
      },
    ],
  );
  const board = provider(sim);
  assert.equal(await board.readState('7'), null, "a stranger's block must not become the run");

  // The same block from a maintainer IS the run state.
  sim.comments[0]!.author_association = 'OWNER';
  assert.equal((await board.readState('7'))?.runId, 'badbadba');
});

test('errors: HTTP statuses map onto the taxonomy', async () => {
  const statuses: Array<[number, BoardError['kind']]> = [
    [403, 'auth'],
    [404, 'not_found'],
    [422, 'precondition'],
    [500, 'transport'],
    [429, 'transport'],
  ];
  for (const [status, kind] of statuses) {
    const board = new GitHubBoardProvider({ repo: REPO, request: async () => ({ status, body: '{"message":"x"}' }) });
    await assert.rejects(
      () => board.getWork('7'),
      (e: unknown) => e instanceof BoardError && e.kind === kind,
      `HTTP ${status} must map to ${kind}`,
    );
  }
});

test('fail closed without a transport: a missing token is an auth error, not a hang', async () => {
  const previous = process.env['GITHUB_TOKEN'];
  delete process.env['GITHUB_TOKEN'];
  try {
    const board = createGitHubBoardProvider({ repo: REPO });
    await assert.rejects(
      () => board.getWork('7'),
      (e: unknown) => e instanceof BoardError && e.kind === 'auth',
    );
  } finally {
    if (previous !== undefined) process.env['GITHUB_TOKEN'] = previous;
  }
});

test('options: a malformed repo is rejected at construction', () => {
  assert.throws(() => new GitHubBoardProvider({ repo: 'no-slash', request: async () => ({ status: 200, body: '{}' }) }), /owner\/name/);
});
