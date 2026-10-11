import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BoardError, createKeyOf } from '@takumi/core';
import type { BoardHttpRequest, BoardHttpResponse, BoardRequestFn } from '@takumi/core';
import { NotionDeliveryBoard, createNotionDeliveryBoard } from '../index.js';

/**
 * NotionDeliveryBoard (ADR-044) — the write-only delivery board.
 *
 * No network, no token: an in-memory Notion answers exactly the four endpoints the adapter may use
 * (`POST /databases/:id/query`, `GET /databases/:id`, `POST /pages`, `PATCH /pages/:id`) and records
 * every request, so what these tests read is the REAL request shape the adapter sends.
 *
 * What is pinned is the port's contract: ONE row per run id (a re-run updates, never files a second),
 * labels ACCUMULATE, the state column's type is learned rather than assumed, a label the board cannot
 * record is refused BEFORE anything is written, a page that merely MENTIONS the run id is never adopted,
 * and a detail over Notion's rich_text limit is refused rather than truncated.
 */

/**
 * The database id in the NORMALIZED form the adapter sends (`normalizeDatabaseId` strips the dashes,
 * the same canonical form `notion-board.test.ts` uses). The simulator below keys its routes on it, so
 * it must match the URL the adapter actually builds — a dashed literal here would 400 every route.
 */
const DB_ID = '3dec1a0253fb8129965cd7cbe18d38b6';

type ReadProp = Record<string, unknown>;

interface SimPage {
  id: string;
  url: string;
  properties: Record<string, ReadProp>;
}

/** A write-shaped property value (what the adapter SENDS) turned into the read shape Notion ANSWERS with. */
function toReadShape(value: Record<string, unknown>): ReadProp {
  if (Array.isArray(value['title'])) {
    const text = (value['title'] as Array<{ text?: { content?: string } }>).map((r) => r.text?.content ?? '').join('');
    return { type: 'title', title: [{ plain_text: text }] };
  }
  if (Array.isArray(value['rich_text'])) {
    const text = (value['rich_text'] as Array<{ text?: { content?: string } }>).map((r) => r.text?.content ?? '').join('');
    return { type: 'rich_text', rich_text: [{ plain_text: text }] };
  }
  if (typeof value['select'] === 'object' && value['select'] !== null) {
    return { type: 'select', select: { name: (value['select'] as { name?: string }).name ?? '' } };
  }
  if (typeof value['status'] === 'object' && value['status'] !== null) {
    return { type: 'status', status: { name: (value['status'] as { name?: string }).name ?? '' } };
  }
  if (Array.isArray(value['multi_select'])) {
    return { type: 'multi_select', multi_select: (value['multi_select'] as Array<{ name?: string }>).map((o) => ({ name: o.name ?? '' })) };
  }
  return {};
}

/** The read text of a page's property (`''` when absent). Reads every shape a property can take, so a
 * `Status` column written as `select` or `status` reads back as its name just like rich_text does. */
function textOf(page: SimPage, property: string): string {
  const p = page.properties[property];
  if (p === undefined) return '';
  const rich = (p['rich_text'] ?? p['title'] ?? []) as Array<{ plain_text?: string }>;
  const text = rich.map((r) => r.plain_text ?? '').join('');
  if (text.length > 0) return text;
  const sel = (p['select'] ?? p['status']) as { name?: string } | undefined;
  return sel?.name ?? '';
}

interface Sim {
  request: BoardRequestFn;
  requests: BoardHttpRequest[];
  pages: SimPage[];
}

/**
 * An in-memory Notion. `columnType` is what the DATABASE reports for `Status`, which is what the adapter
 * learns before it writes (Notion refuses a `select` value on a `status` property and vice versa).
 */
function sim(opts: { columnType?: 'select' | 'status'; seed?: Array<{ id: string; stateText: string; labels?: string[] }> } = {}): Sim {
  const columnType = opts.columnType ?? 'select';
  const simState: Sim = {
    requests: [],
    pages: (opts.seed ?? []).map((s) => ({
      id: s.id,
      url: `https://www.notion.so/${s.id}`,
      properties: {
        Name: { type: 'title', title: [{ plain_text: `seeded ${s.id}` }] },
        Status: columnType === 'status' ? { type: 'status', status: { name: 'ready' } } : { type: 'select', select: { name: 'ready' } },
        'Takumi State': { type: 'rich_text', rich_text: [{ plain_text: s.stateText }] },
        ...(s.labels === undefined ? {} : { Labels: { type: 'multi_select', multi_select: s.labels.map((name) => ({ name })) } }),
      },
    })),
    request: async (req: BoardHttpRequest): Promise<BoardHttpResponse> => {
      simState.requests.push(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const ok = (value: unknown): BoardHttpResponse => ({ status: 200, body: JSON.stringify(value) });

      if (req.method === 'GET' && req.url.endsWith(`/databases/${DB_ID}`)) {
        return ok({ properties: { Status: { type: columnType }, Name: { type: 'title' } } });
      }
      if (req.method === 'POST' && req.url.endsWith(`/databases/${DB_ID}/query`)) {
        const filter = (body['filter'] ?? {}) as { property?: string; rich_text?: { contains?: string } };
        const property = filter.property ?? '';
        const contains = filter.rich_text?.contains ?? '';
        const results = simState.pages.filter((p) => textOf(p, property).includes(contains));
        return ok({ results: results.map((p) => ({ id: p.id, url: p.url, properties: p.properties })), has_more: false });
      }
      if (req.method === 'POST' && req.url.endsWith('/pages')) {
        const id = `page-${simState.pages.length + 1}`;
        const properties: Record<string, ReadProp> = {};
        for (const [name, value] of Object.entries((body['properties'] ?? {}) as Record<string, Record<string, unknown>>)) {
          properties[name] = toReadShape(value);
        }
        const page: SimPage = { id, url: `https://www.notion.so/${id}`, properties };
        simState.pages.push(page);
        return ok({ id, url: page.url, properties });
      }
      const patch = /\/pages\/([^/]+)$/.exec(req.url);
      if (req.method === 'PATCH' && patch !== null) {
        const id = patch[1]!;
        const page = simState.pages.find((p) => p.id === id);
        if (page === undefined) return { status: 404, body: JSON.stringify({ message: 'not found' }) };
        for (const [name, value] of Object.entries((body['properties'] ?? {}) as Record<string, Record<string, unknown>>)) {
          page.properties[name] = toReadShape(value);
        }
        return ok({ id, url: page.url, properties: page.properties });
      }
      return { status: 400, body: JSON.stringify({ message: `unexpected ${req.method} ${req.url}` }) };
    },
  };
  return simState;
}

const build = (s: Sim, extra: Partial<Parameters<typeof createNotionDeliveryBoard>[0]> = {}): NotionDeliveryBoard =>
  createNotionDeliveryBoard({ databaseId: DB_ID, labelsProperty: 'Labels', request: s.request, ...extra });

// ---------------------------------------------------------------------------------------------
// (a) one row per run, keyed by the run id
// ---------------------------------------------------------------------------------------------

test('project: a new run CREATES one row carrying the marker, the title, the state and the detail', async () => {
  const s = sim();
  const board = build(s);
  const ref = await board.project({ runId: 'wf-abc123', title: 'docs/requirements/x.yaml', state: 'claimed', detail: 'publish: pull request 7 opened' });

  assert.equal(ref.created, true);
  assert.equal(s.pages.length, 1);
  const page = s.pages[0]!;
  assert.equal(textOf(page, 'Name'), 'docs/requirements/x.yaml');
  assert.equal(textOf(page, 'Status'), 'claimed');
  // The machine property carries the create marker AND the reader-facing detail line.
  const state = textOf(page, 'Takumi State');
  assert.equal(createKeyOf(state), 'wf-abc123');
  assert.match(state, /publish: pull request 7 opened/);
});

test('project: a re-run of the SAME run id UPDATES the row it wrote — it never files a second one', async () => {
  const s = sim();
  const board = build(s);
  const first = await board.project({ runId: 'wf-same', title: 't', state: 'claimed' });
  const second = await board.project({ runId: 'wf-same', title: 't', state: 'fix_needed' });

  assert.equal(first.created, true);
  assert.equal(second.created, false, 'the second call updates, it does not create');
  assert.equal(first.id, second.id, 'the SAME page is written');
  assert.equal(s.pages.length, 1, 'ONE row per delivery run');
  assert.equal(textOf(s.pages[0]!, 'Status'), 'fix_needed', 'the state moved');
});

test('project: labels ACCUMULATE — nothing an earlier step set is cleared', async () => {
  const s = sim();
  const board = build(s);
  await board.project({ runId: 'wf-labels', title: 't', state: 'pr_open', labels: ['takumi-approved'] });
  await board.project({ runId: 'wf-labels', title: 't', state: 'merged', labels: ['takumi-merged'] });

  assert.deepEqual(
    (s.pages[0]!.properties['Labels']!['multi_select'] as Array<{ name: string }>).map((o) => o.name),
    ['takumi-approved', 'takumi-merged'],
    'the row accumulates the verdicts of the steps that moved it',
  );
});

// ---------------------------------------------------------------------------------------------
// (b) the column type is LEARNED, not assumed
// ---------------------------------------------------------------------------------------------

test('project: a `status`-typed column is written as status, not select (the type is read from the database)', async () => {
  const s = sim({ columnType: 'status' });
  const board = build(s);
  await board.project({ runId: 'wf-status', title: 't', state: 'merged' });

  const patch = s.requests.find((r) => r.method === 'POST' && r.url.endsWith('/pages'));
  const props = (patch?.body as { properties: Record<string, Record<string, unknown>> }).properties;
  assert.ok(props['Status']!['status'] !== undefined, 'a status column is patched with `status`');
  assert.equal(props['Status']!['select'], undefined, 'and NOT with `select`, which Notion would refuse');
  assert.deepEqual(props['Status']!['status'], { name: 'merged' });
});

test('project: a `select`-typed column is written as select (the documented default)', async () => {
  const s = sim({ columnType: 'select' });
  const board = build(s);
  await board.project({ runId: 'wf-select', title: 't', state: 'claimed' });
  const patch = s.requests.find((r) => r.method === 'POST' && r.url.endsWith('/pages'));
  const props = (patch?.body as { properties: Record<string, Record<string, unknown>> }).properties;
  assert.deepEqual(props['Status']!['select'], { name: 'claimed' });
});

// ---------------------------------------------------------------------------------------------
// (c) refusals that must happen BEFORE anything is written
// ---------------------------------------------------------------------------------------------

test('project: a label with no labelsProperty configured is REFUSED before the board is touched', async () => {
  const s = sim();
  const board = createNotionDeliveryBoard({ databaseId: DB_ID, request: s.request });
  await assert.rejects(
    () => board.project({ runId: 'wf-nolabels', title: 't', state: 'pr_open', labels: ['takumi-approved'] }),
    (e: unknown) => e instanceof BoardError && e.kind === 'precondition' && /labelsProperty/.test(e.message),
  );
  assert.equal(s.requests.length, 0, 'a refusal writes nothing');
  assert.equal(s.pages.length, 0);
});

test('project: a detail over Notion\'s rich_text limit is REFUSED rather than truncated', async () => {
  const s = sim();
  const board = build(s);
  await assert.rejects(
    () => board.project({ runId: 'wf-long', title: 't', state: 'claimed', detail: 'x'.repeat(2500) }),
    (e: unknown) => e instanceof BoardError && e.kind === 'precondition' && /rich_text limit/.test(e.message),
  );
  assert.equal(s.pages.length, 0, 'the detail is refused, never silently shortened');
});

// ---------------------------------------------------------------------------------------------
// (d) the marker is the identity — a page that merely MENTIONS the run id is not adopted
// ---------------------------------------------------------------------------------------------

test('project: a page whose text merely MENTIONS the run id is NOT adopted — a new row is filed', async () => {
  // The filter (`rich_text contains <marker>`) MATCHES this page, but its FIRST create marker is another key,
  // so `createKeyOf` does not confirm it and the run must not be confused with someone else's row.
  const s = sim({
    seed: [{ id: 'seeded-1', stateText: '<!-- takumi:created=wf-other --> mentions <!-- takumi:created=wf-target -->' }],
  });
  const board = build(s);
  const ref = await board.project({ runId: 'wf-target', title: 't', state: 'claimed' });

  assert.equal(ref.created, true, 'the run files its OWN row');
  assert.equal(ref.id, 'page-2');
  assert.equal(s.pages.length, 2, 'the seeded page is untouched');
  assert.equal(textOf(s.pages[0]!, 'Takumi State'), '<!-- takumi:created=wf-other --> mentions <!-- takumi:created=wf-target -->');
});

test('project: a page carrying THIS run id is adopted, and updated in place', async () => {
  const s = sim({ seed: [{ id: 'seeded-2', stateText: '<!-- takumi:created=wf-mine -->', labels: ['takumi-approved'] }] });
  const board = build(s);
  const ref = await board.project({ runId: 'wf-mine', title: 't', state: 'merged', labels: ['takumi-merged'] });
  assert.equal(ref.created, false);
  assert.equal(ref.id, 'seeded-2');
  assert.equal(s.pages.length, 1, 'no second row');
  assert.deepEqual(
    (s.pages[0]!.properties['Labels']!['multi_select'] as Array<{ name: string }>).map((o) => o.name),
    ['takumi-approved', 'takumi-merged'],
  );
});

// ---------------------------------------------------------------------------------------------
// (e) fail closed with no transport
// ---------------------------------------------------------------------------------------------

test('project: with no token and no injected transport it FAILS CLOSED (auth), never an unauthenticated write', async () => {
  const board = createNotionDeliveryBoard({ databaseId: DB_ID, labelsProperty: 'Labels', token: '' });
  await assert.rejects(
    () => board.project({ runId: 'wf-notoken', title: 't', state: 'claimed' }),
    (e: unknown) => e instanceof BoardError && e.kind === 'auth',
  );
});

test('metadata: the board names itself, so a run can record WHICH board it projected onto', () => {
  const board = createNotionDeliveryBoard({ databaseId: DB_ID, token: '' });
  const md = board.metadata();
  assert.equal(md.id, 'notion');
  assert.equal(md.name, 'Notion Delivery Board');
});
