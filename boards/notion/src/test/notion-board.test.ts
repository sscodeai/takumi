import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BoardError,
  BoardStateError,
  BoardUnsupportedError,
  renderBoardStateRecord,
  runTaskBoardProviderContractSuite,
} from '@takumi/core';
import type { BoardHttpRequest, BoardHttpResponse, BoardRequestFn, BoardStateRecord } from '@takumi/core';
import { NotionBoardProvider, createNotionTransport, normalizeDatabaseId, plainText } from '../index.js';

/**
 * A tiny in-memory Notion: no network, no token. It answers exactly the
 * endpoints the adapter is allowed to use, records every request so the tests
 * can assert the real request shape, and returns Notion-shaped payloads
 * (properties typed as `select` + `rich_text`, pages with `last_edited_time`).
 */

interface SimPage {
  id: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, unknown>;
}

const DB_ID = '3f1a2b3c4d5e6f708192a3b4c5d6e7f8';

function rich(text: string) {
  return { type: 'rich_text', rich_text: [{ plain_text: text }] };
}

function title(text: string) {
  return { type: 'title', title: [{ plain_text: text }] };
}

function select(name: string) {
  return { type: 'select', select: { name } };
}

function statusProp(name: string) {
  return { type: 'status', status: { name } };
}

function makePage(id: string, columnName: string, extra: Record<string, unknown> = {}): SimPage {
  return {
    id,
    url: `https://www.notion.so/${id}`,
    last_edited_time: '2026-09-15T00:00:00.000Z',
    properties: {
      Name: title(`Item ${id}`),
      Status: select(columnName),
      ...extra,
    },
  };
}

function notionSimulator(pages: SimPage[], opts: { statusColumnType?: boolean } = {}) {
  const requests: BoardHttpRequest[] = [];
  const comments: Array<{ id: string; block_id: string; text: string; author: string }> = [];
  let commentSeq = 0;
  let clock = Date.parse('2026-09-15T00:00:00.000Z');

  const request: BoardRequestFn = async (req): Promise<BoardHttpResponse> => {
    requests.push(req);
    const path = req.url.replace('https://api.notion.com/v1', '');
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (req.method === 'POST' && path === `/databases/${DB_ID}/query`) {
      const wanted = optionsFromFilter(body['filter']);
      const results = pages.filter((p) => {
        if (wanted.length === 0) return true;
        const column = p.properties['Status'] as { select?: { name?: string }; status?: { name?: string } } | undefined;
        const name = column?.select?.name ?? column?.status?.name;
        return name !== undefined && wanted.includes(name);
      });
      return json({ results, object: 'list' });
    }
    if (req.method === 'GET' && path.startsWith('/pages/')) {
      const page = pages.find((p) => p.id === path.slice('/pages/'.length));
      return page ? json(page) : { status: 404, body: '{"object":"error","code":"object_not_found"}' };
    }
    if (req.method === 'PATCH' && path.startsWith('/pages/')) {
      const page = pages.find((p) => p.id === path.slice('/pages/'.length));
      if (!page) return { status: 404, body: '{"object":"error","code":"object_not_found"}' };
      const properties = (body['properties'] ?? {}) as Record<string, unknown>;
      for (const [name, value] of Object.entries(properties)) {
        // Notion echoes a written property back in its own READ shape (each
        // rich_text run carries a flattened `plain_text`) — the simulator must
        // do the same or the adapter would look broken against a working API.
        const echoed = opts.statusColumnType && name === 'Status' ? toStatus(value) : value;
        page.properties[name] = toNotionReadShape(echoed);
      }
      clock += 1000;
      page.last_edited_time = new Date(clock).toISOString();
      return json(page);
    }
    if (req.method === 'POST' && path === '/comments') {
      commentSeq += 1;
      const parent = body['parent'] as { page_id?: string } | undefined;
      const text = plainText(((body['rich_text'] ?? []) as Array<{ text?: { content?: string } }>).map((r) => ({
        plain_text: r.text?.content ?? '',
      })));
      const created = { id: `comment-${commentSeq}`, block_id: parent?.page_id ?? '', text, author: 'bot-user' };
      comments.push(created);
      return json({ object: 'comment', id: created.id, created_by: { id: created.author }, rich_text: [{ plain_text: text }] });
    }
    if (req.method === 'GET' && path.startsWith('/comments')) {
      return json({
        object: 'list',
        results: comments.map((c) => ({ id: c.id, created_by: { id: c.author }, rich_text: [{ plain_text: c.text }] })),
      });
    }
    return { status: 404, body: '{"object":"error","code":"not_found"}' };
  };

  return { request, requests, comments };
}

/** Notion answers a select-typed column with a `status` value when asked to. */
function toStatus(value: unknown): unknown {
  const name = (value as { select?: { name?: string } }).select?.name;
  return name === undefined ? value : statusProp(name);
}

/** Rewrite a written property into the shape Notion returns on a read. */
function toNotionReadShape(value: unknown): unknown {
  const property = value as {
    rich_text?: Array<{ text?: { content?: string } }>;
    title?: Array<{ text?: { content?: string } }>;
    select?: unknown;
    status?: unknown;
  };
  if (Array.isArray(property.rich_text)) {
    return {
      type: 'rich_text',
      rich_text: property.rich_text.map((run) => ({
        type: 'text',
        plain_text: run.text?.content ?? '',
        text: run.text,
      })),
    };
  }
  if (Array.isArray(property.title)) {
    return {
      type: 'title',
      title: property.title.map((run) => ({
        type: 'text',
        plain_text: run.text?.content ?? '',
        text: run.text,
      })),
    };
  }
  if (property.select !== undefined) return { type: 'select', select: property.select };
  if (property.status !== undefined) return { type: 'status', status: property.status };
  return value;
}

function json(payload: unknown): BoardHttpResponse {
  return { status: 200, body: JSON.stringify(payload) };
}

function optionsFromFilter(filter: unknown): string[] {
  if (filter === undefined || filter === null || typeof filter !== 'object') return [];
  const f = filter as Record<string, unknown>;
  if (Array.isArray(f['or'])) return (f['or'] as unknown[]).flatMap(optionsFromFilter);
  const selectName = (f['select'] as { equals?: string } | undefined)?.equals;
  if (selectName !== undefined) return [selectName];
  const statusName = (f['status'] as { equals?: string } | undefined)?.equals;
  return statusName === undefined ? [] : [statusName];
}

function provider(sim: ReturnType<typeof notionSimulator>, extra: Record<string, unknown> = {}) {
  return new NotionBoardProvider({ databaseId: DB_ID, request: sim.request, ...extra });
}

const RUN = 'c0ffee01';

test('NotionBoardProvider: shared task-board contract suite', async () => {
  const sim = notionSimulator([makePage('page-1', 'ready')]);
  const out = await runTaskBoardProviderContractSuite(provider(sim), { id: 'notion', itemId: 'page-1' });
  assert.equal(out.gate, 'task-board-contract');
  // Notion honestly gates two checks: comments are append-only and it exposes no
  // author role signal. A PASS_WITH_NOT_RUN here is the honest result, and the
  // notes must say which parts were skipped and why.
  assert.equal(out.result, 'PASS_WITH_NOT_RUN');
  assert.ok(out.notes.some((n) => n.startsWith('comment: PARTIAL')), out.notes.join('\n'));
  assert.ok(out.notes.some((n) => n.includes('trustedAuthorFilter=false')), out.notes.join('\n'));
  assert.ok(out.notes.some((n) => n.startsWith('claim: PASS')));
  assert.ok(out.notes.some((n) => n.startsWith('terminal: PASS')));
});

test('capabilities: the delivery claims are all false and the gates are honest', () => {
  const sim = notionSimulator([makePage('page-1', 'ready')]);
  const caps = provider(sim).capabilities();
  assert.deepEqual(caps.delivery, { canOpenPullRequest: false, canRunChecks: false, canMerge: false });
  assert.equal(caps.comments, true);
  assert.equal(caps.editableComment, false);
  assert.equal(caps.trustedAuthorFilter, false);
  assert.equal(caps.machineReadableState, true);
  assert.equal(caps.atomicClaim, false);
});

test('request shapes: listWork queries the database, getWork reads the page', async () => {
  const sim = notionSimulator([makePage('page-1', 'ready'), makePage('page-2', 'claimed')]);
  const board = provider(sim);

  const listed = await board.listWork();
  assert.equal(sim.requests[0]?.method, 'POST');
  assert.equal(sim.requests[0]?.url, `https://api.notion.com/v1/databases/${DB_ID}/query`);
  assert.deepEqual(sim.requests[0]?.body, {
    page_size: 100,
    filter: { property: 'Status', select: { equals: 'ready' } },
  });
  assert.deepEqual(listed.map((i) => i.id), ['page-1']);
  assert.equal(listed[0]?.state, 'ready');
  assert.equal(listed[0]?.title, 'Item page-1');

  const fetched = await board.getWork('page-2');
  assert.equal(sim.requests[1]?.method, 'GET');
  assert.equal(sim.requests[1]?.url, 'https://api.notion.com/v1/pages/page-2');
  assert.equal(fetched.state, 'claimed');
});

test('request shapes: listWork sends an `or` filter for several states', async () => {
  const sim = notionSimulator([makePage('page-1', 'ready'), makePage('page-2', 'claimed')]);
  await provider(sim).listWork({ states: ['ready', 'claimed'] });
  assert.deepEqual(sim.requests[0]?.body, {
    page_size: 100,
    filter: {
      or: [
        { property: 'Status', select: { equals: 'ready' } },
        { property: 'Status', select: { equals: 'claimed' } },
      ],
    },
  });
});

test('claim: writes the column and the state record, then verifies the re-read', async () => {
  const sim = notionSimulator([makePage('page-1', 'ready')]);
  const board = provider(sim);
  const result = await board.claim('page-1', RUN);
  assert.deepEqual(result, { item: 'page-1', runId: RUN, claimed: true });

  const patches = sim.requests.filter((r) => r.method === 'PATCH');
  assert.equal(patches.length, 2, 'one patch for the column, one for the state record');
  assert.deepEqual(patches[0]?.body, { properties: { Status: { select: { name: 'claimed' } } } });
  const record = (await board.readState('page-1')) as BoardStateRecord;
  assert.equal(record.runId, RUN);
  assert.equal(record.schema, 1);
});

test('claim: a second run is refused with a reason (no silent reclaim)', async () => {
  const sim = notionSimulator([makePage('page-1', 'ready')]);
  const board = provider(sim);
  await board.claim('page-1', RUN);
  const second = await board.claim('page-1', 'deadbeef');
  assert.equal(second.claimed, false);
  assert.match(second.reason ?? '', /already claimed by c0ffee01/);
});

test('transition: an illegal transition throws BoardStateError and writes nothing', async () => {
  const sim = notionSimulator([makePage('page-1', 'merged')]);
  const board = provider(sim);
  await assert.rejects(() => board.transition('page-1', 'claimed', { runId: RUN }), BoardStateError);
  // Reading the current state is allowed (the table needs it); MUTATING is not.
  assert.deepEqual(
    sim.requests.map((r) => r.method),
    ['GET'],
    'an illegal transition must never send a write',
  );
});

test('transition: a legal move patches the column and preserves the record identity', async () => {
  const sim = notionSimulator([makePage('page-1', 'ready')]);
  const board = provider(sim);
  await board.claim('page-1', RUN);
  await board.transition('page-1', 'pr_open', { runId: RUN, note: 'PR #7' });
  const record = (await board.readState('page-1')) as BoardStateRecord;
  assert.equal(record.runId, RUN, 'a transition must not start a new run id');
  assert.equal(record.note, 'PR #7');
  assert.equal((await board.getWork('page-1')).state, 'pr_open');
});

test('comment: appends one comment carrying the run marker, and editing is gated', async () => {
  const sim = notionSimulator([makePage('page-1', 'ready')]);
  const board = provider(sim);
  const ref = await board.comment('page-1', 'plan ready', { runId: RUN });
  assert.equal(ref.runId, RUN);
  assert.match(sim.comments[0]?.text ?? '', /plan ready[\s\S]*<!-- takumi:run=c0ffee01 -->/);
  // Append-only: a second call appends (never edits), and updateComment is a
  // hard error rather than a silent no-op.
  await board.comment('page-1', 'tests passed', { runId: RUN });
  assert.equal(sim.comments.length, 2);
  await assert.rejects(() => board.updateComment(ref, 'rewritten'), BoardUnsupportedError);
});

test('state record: a foreign-authored comment cannot inject state (the record lives in a property)', async () => {
  const hostile: BoardStateRecord = {
    schema: 1,
    runId: 'badbadba',
    item: 'page-1',
    reviewRound: 0,
    updatedAt: '2030-01-01T00:00:00.000Z',
  };
  const sim = notionSimulator([makePage('page-1', 'ready')]);
  // Someone posts a comment whose text carries a valid-looking record block.
  sim.comments.push({ id: 'comment-x', block_id: 'page-1', text: renderBoardStateRecord(hostile), author: 'stranger' });
  const board = provider(sim);
  assert.equal(await board.readState('page-1'), null, 'a comment must never be read as the run state');
  await board.claim('page-1', RUN);
  assert.equal((await board.readState('page-1'))?.runId, RUN);
});

test('errors: an unknown page is not_found, a rejected request is classified', async () => {
  const sim = notionSimulator([makePage('page-1', 'ready')]);
  const board = provider(sim);
  await assert.rejects(
    () => board.getWork('page-9'),
    (e: unknown) => e instanceof BoardError && e.kind === 'not_found',
  );

  const unauthorized = new NotionBoardProvider({
    databaseId: DB_ID,
    request: async () => ({ status: 403, body: '{"code":"unauthorized"}' }),
  });
  await assert.rejects(
    () => unauthorized.getWork('page-1'),
    (e: unknown) => e instanceof BoardError && e.kind === 'auth',
  );
});

test('columns: a status-typed column is patched with `status`, not `select`', async () => {
  // A Notion `status` property is a different type from `select`; the adapter
  // must patch the type the page actually carries, not the one it assumed.
  const statusPage = {
    id: 'page-1',
    url: 'https://www.notion.so/page-1',
    last_edited_time: '2026-09-15T00:00:00.000Z',
    properties: { Name: title('Item page-1'), Status: statusProp('ready') },
  };
  const statusSim = notionSimulator([statusPage], { statusColumnType: true });
  const board = provider(statusSim);
  await board.claim('page-1', RUN);
  const patch = statusSim.requests.find((r) => r.method === 'PATCH');
  assert.deepEqual(patch?.body, { properties: { Status: { status: { name: 'claimed' } } } });
});

test('columns: an option outside the state map is a precondition error, not a guess', async () => {
  const sim = notionSimulator([makePage('page-1', 'In Review')]);
  await assert.rejects(
    () => provider(sim).getWork('page-1'),
    (e: unknown) => e instanceof BoardError && e.kind === 'precondition',
  );
});

test('normalizeDatabaseId / plainText: input handling', () => {
  assert.equal(normalizeDatabaseId(DB_ID), DB_ID);
  assert.equal(normalizeDatabaseId('3f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8'), DB_ID);
  assert.equal(normalizeDatabaseId(`https://www.notion.so/ws/${DB_ID}?v=abc`), DB_ID);
  assert.throws(() => normalizeDatabaseId('not-a-database'), BoardError);
  assert.equal(plainText([{ plain_text: 'a' }, { plain_text: 'b' }]), 'ab');
  assert.equal(plainText(undefined), '');
});

test('createNotionTransport: builds a transport (headers are exercised in the core transport test)', () => {
  const prev = process.env['NOTION_TOKEN'];
  process.env['NOTION_TOKEN'] = 'secret-token';
  try {
    const fn = createNotionTransport({ apiBase: 'https://api.notion.com/v1' });
    assert.equal(typeof fn, 'function');
  } finally {
    if (prev === undefined) delete process.env['NOTION_TOKEN'];
    else process.env['NOTION_TOKEN'] = prev;
  }
});

test('fail closed without credentials: no token and no injected transport means NO call at all', async () => {
  const prev = process.env['NOTION_TOKEN'];
  delete process.env['NOTION_TOKEN'];
  try {
    const board = new NotionBoardProvider({ databaseId: DB_ID });
    await assert.rejects(
      () => board.getWork('page-1'),
      (e: unknown) => e instanceof BoardError && e.kind === 'auth' && /no request transport configured/.test(e.message),
    );
  } finally {
    if (prev !== undefined) process.env['NOTION_TOKEN'] = prev;
  }
});
