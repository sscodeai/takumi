import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BoardError,
  BoardStateError,
  BoardUnsupportedError,
  renderBoardStateRecord,
  runTaskBoardProviderContractSuite,
} from '@takumi/core';
import type {
  BoardCapabilities,
  BoardHttpRequest,
  BoardHttpResponse,
  BoardRequestFn,
  BoardStateRecord,
  BoardWorkItemState,
} from '@takumi/core';
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

/**
 * The database the adapter reads: its column property carries the option names
 * `bootstrapStates` reports on. `options` defaults to the six delivery states, so
 * a suite run sees a fully configured board; a test passes its own list to model a
 * board that is missing one.
 */
function databasePayload(columnOptions: string[], columnType: 'select' | 'status' = 'select') {
  return {
    object: 'database',
    id: DB_ID,
    properties: {
      Name: { type: 'title', title: {} },
      Status: {
        type: columnType,
        [columnType]: { options: columnOptions.map((name) => ({ name })) },
      },
      'Takumi State': { type: 'rich_text', rich_text: {} },
    },
  };
}

const ALL_STATES: BoardWorkItemState[] = ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked'];

function notionSimulator(pages: SimPage[], opts: { statusColumnType?: boolean; columnOptions?: string[] } = {}) {
  const requests: BoardHttpRequest[] = [];
  const columnOptions = opts.columnOptions ?? ALL_STATES;
  const comments: Array<{ id: string; block_id: string; text: string; author: string }> = [];
  let commentSeq = 0;
  let pageSeq = 0;
  let clock = Date.parse('2026-09-15T00:00:00.000Z');

  const request: BoardRequestFn = async (req): Promise<BoardHttpResponse> => {
    requests.push(req);
    const path = req.url.replace('https://api.notion.com/v1', '');
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (req.method === 'GET' && path === `/databases/${DB_ID}`) {
      return json(databasePayload(columnOptions, opts.statusColumnType === true ? 'status' : 'select'));
    }
    if (req.method === 'POST' && path === `/databases/${DB_ID}/query`) {
      // THREE filter shapes reach this route: the column filter `listWork` builds, the
      // machine-property `rich_text contains` filter `createWork` searches with, and the
      // `title contains` scope `listWork` adds when the caller passes a `query` (wrapped
      // together with the column filter in one `and`, exactly as Notion documents it).
      const filter = body['filter'];
      const contains = richTextContains(filter);
      const titleTerm = titleContains(filter);
      const wanted = optionsFromFilter(filter);
      const results = pages.filter((p) => {
        if (contains !== undefined) return propertyText(p, contains.property).includes(contains.value);
        // `title contains` searches the TITLE property only — which is exactly the
        // restriction the adapter declares in `capabilities().canTextSearch`.
        if (
          titleTerm !== undefined &&
          !propertyTitle(p, titleTerm.property).toLowerCase().includes(titleTerm.value.toLowerCase())
        ) {
          return false;
        }
        if (wanted.length === 0) return true;
        const column = p.properties['Status'] as { select?: { name?: string }; status?: { name?: string } } | undefined;
        const name = column?.select?.name ?? column?.status?.name;
        return name !== undefined && wanted.includes(name);
      });
      return json({ results, object: 'list' });
    }
    if (req.method === 'POST' && path === '/pages') {
      // Notion creates a database ROW: `parent.database_id` says where, `properties` is
      // the write shape, and the response is the page in its READ shape.
      const parent = body['parent'] as { database_id?: string } | undefined;
      if (parent?.database_id !== DB_ID) return { status: 400, body: '{"code":"validation_error"}' };
      const written = (body['properties'] ?? {}) as Record<string, unknown>;
      const properties: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(written)) properties[name] = toNotionReadShape(value);
      pageSeq += 1;
      clock += 1000;
      const page: SimPage = {
        id: `page-new-${pageSeq}`,
        url: `https://www.notion.so/page-new-${pageSeq}`,
        last_edited_time: new Date(clock).toISOString(),
        properties,
      };
      pages.push(page);
      return json(page);
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

  return { request, requests, comments, pages };
}

/** The `rich_text contains` condition of a query filter, when that is the shape. */
function richTextContains(filter: unknown): { property: string; value: string } | undefined {
  if (filter === undefined || filter === null || typeof filter !== 'object') return undefined;
  const f = filter as Record<string, unknown>;
  const property = f['property'];
  const condition = f['rich_text'] as { contains?: unknown } | undefined;
  if (typeof property !== 'string' || typeof condition?.contains !== 'string') return undefined;
  return { property, value: condition.contains };
}

/**
 * Walk a Notion filter, `and`/`or` compounds included, visiting every leaf condition.
 *
 * The walk is needed because the adapter nests its column filter WHOLE inside an `and`
 * when a text scope is present, so a stand-in that only read the top level would model a
 * board the adapter does not talk to.
 */
function walkFilter(filter: unknown, visit: (condition: Record<string, unknown>) => void): void {
  if (filter === undefined || filter === null || typeof filter !== 'object') return;
  const f = filter as Record<string, unknown>;
  for (const key of ['and', 'or']) {
    const parts = f[key];
    if (Array.isArray(parts)) for (const part of parts) walkFilter(part, visit);
  }
  visit(f);
}

/** The `title contains` condition of a query filter, wherever it sits, when that is the shape. */
function titleContains(filter: unknown): { property: string; value: string } | undefined {
  let found: { property: string; value: string } | undefined;
  walkFilter(filter, (condition) => {
    if (found !== undefined) return;
    const property = condition['property'];
    const title = condition['title'] as { contains?: unknown } | undefined;
    if (typeof property === 'string' && typeof title?.contains === 'string') {
      found = { property, value: title.contains };
    }
  });
  return found;
}

/** The text a page carries in one rich_text property, in Notion's READ shape. */
function propertyText(page: SimPage, property: string): string {
  const value = page.properties[property] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  return plainText(value?.rich_text);
}

/** The text a page carries in its TITLE property, in Notion's READ shape. */
function propertyTitle(page: SimPage, property: string): string {
  const value = page.properties[property] as { title?: Array<{ plain_text?: string }> } | undefined;
  return plainText(value?.title);
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
  const names: string[] = [];
  walkFilter(filter, (condition) => {
    const selectName = (condition['select'] as { equals?: string } | undefined)?.equals;
    if (selectName !== undefined) names.push(selectName);
    const statusName = (condition['status'] as { equals?: string } | undefined)?.equals;
    if (statusName !== undefined) names.push(statusName);
  });
  return names;
}

function provider(sim: ReturnType<typeof notionSimulator>, extra: Record<string, unknown> = {}) {
  return new NotionBoardProvider({ databaseId: DB_ID, request: sim.request, ...extra });
}

const RUN = 'c0ffee01';

test('bootstrapStates: a READ-ONLY report — a missing option gets the exact UI step', async () => {
  const sim = notionSimulator([], { columnOptions: ['ready', 'claimed'] });
  const board = provider(sim);

  const report = await board.bootstrapStates(ALL_STATES);
  assert.equal(report.applied, false, 'this adapter creates nothing, so it never claims to have applied');
  assert.equal(report.provider, 'notion');
  assert.deepEqual(report.actions.map((a) => a.outcome), [
    'exists',
    'exists',
    'not-creatable',
    'not-creatable',
    'not-creatable',
    'not-creatable',
  ]);
  const missing = report.actions.filter((a) => a.outcome === 'not-creatable');
  for (const action of missing) {
    // The whole value of the report: a human is told the option name and the step.
    assert.match(action.instruction ?? '', /add an option named/);
    assert.match(action.instruction ?? '', /Notion UI/);
    assert.ok((action.instruction ?? '').includes(JSON.stringify(action.name)));
  }
  assert.equal(
    sim.requests.some((r) => r.method !== 'GET'),
    false,
    'a report-only bootstrap must not write anything',
  );
});

test('bootstrapStates: a missing PROPERTY gets a different instruction than a missing option', async () => {
  const sim = notionSimulator([]);
  const board = provider(sim, { columnProperty: 'Not A Column' });
  const report = await board.bootstrapStates(['ready']);
  assert.equal(report.actions[0]?.outcome, 'not-creatable');
  assert.match(report.actions[0]?.instruction ?? '', /create a select property/);
});

test('bootstrapStates: an unknown delivery state is reported, and a dry run equals a real call', async () => {
  const sim = notionSimulator([]);
  const board = provider(sim);
  const dry = await board.bootstrapStates(ALL_STATES, { dryRun: true });
  const real = await board.bootstrapStates(ALL_STATES);
  // Nothing is written, so the two reports are the same report: state is in the
  // database, not in this call.
  assert.deepEqual(dry, real);
  assert.deepEqual(dry.actions.map((a) => a.name), ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked']);
});

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
  // The suite files a page of its own: `canCreateWork: true` is a promise, and the hard
  // half of it (one page per idempotency key, claimable afterwards) is checked there.
  assert.ok(out.notes.some((n) => n.startsWith('createWork: PASS')), out.notes.join('\n'));
  // The suite searches FOR REAL: it files a probe whose TITLE carries a distinctive term,
  // requires the adapter to find it, then requires a term nothing carries to find nothing.
  // That pair is what proves the scope is applied rather than quietly dropped — and on this
  // board it is answered by the title filter the adapter adds (`canTextSearch: true`).
  assert.ok(out.notes.some((n) => n.startsWith('query: PASS')), out.notes.join('\n'));
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
  assert.equal(caps.canCreateWork, true, 'a database row is creatable, so a failure can be filed');
  assert.equal(
    caps.canTextSearch,
    true,
    'the adapter can filter the title property — narrower than everything, and the class doc says so',
  );
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

// --- listWork: the free-text scope is a TITLE filter, and nothing wider -----

test('listWork: a text scope is a TITLE filter — a term the page carries elsewhere is not a hit', async () => {
  const epic = makePage('page-epic', 'ready');
  epic.properties['Name'] = title('Epic alpha takuepicalpha: ship the intake');
  const other = makePage('page-other', 'ready');
  // The SAME term, carried by the page's machine property instead of its title. Notion
  // lets this adapter filter a TITLE and offers no search over page bodies (or over other
  // properties), so this page must NOT come back: the declared capability is narrower than
  // "everything", and a caller must be able to rely on WHICH text was searched.
  other.properties['Takumi State'] = rich('notes about takuepicalpha live over here');
  const sim = notionSimulator([epic, other]);
  const board = provider(sim);

  // (1) the scope REACHES the query body, ANDed with the column filter in one `and`.
  const hit = await board.listWork({ states: ['ready'], query: 'takuepicalpha' });
  assert.equal(sim.requests[0]?.method, 'POST');
  assert.equal(sim.requests[0]?.url, `https://api.notion.com/v1/databases/${DB_ID}/query`);
  assert.deepEqual(sim.requests[0]?.body, {
    page_size: 100,
    filter: {
      and: [
        { property: 'Status', select: { equals: 'ready' } },
        { property: 'Name', title: { contains: 'takuepicalpha' } },
      ],
    },
  });
  assert.deepEqual(hit.map((i) => i.id), ['page-epic'], 'the item whose TITLE carries the term is returned');

  // (2) a term NOTHING carries returns nothing — and, just as important, the column filter
  // was not quietly dropped either.
  const miss = await board.listWork({ states: ['ready'], query: 'takunothingcarriesthis' });
  assert.deepEqual(sim.requests[1]?.body, {
    page_size: 100,
    filter: {
      and: [
        { property: 'Status', select: { equals: 'ready' } },
        { property: 'Name', title: { contains: 'takunothingcarriesthis' } },
      ],
    },
  });
  assert.deepEqual(miss, [], 'a term no page title carries must find nothing, never the whole column');

  // (3) the column scope survives beside the text scope: an `or` over states stays intact
  // inside the `and`, so scoping by BOTH state and text asks one question, once.
  const both = await board.listWork({ states: ['ready', 'claimed'], query: 'takuepicalpha' });
  assert.deepEqual(sim.requests[2]?.body, {
    page_size: 100,
    filter: {
      and: [
        {
          or: [
            { property: 'Status', select: { equals: 'ready' } },
            { property: 'Status', select: { equals: 'claimed' } },
          ],
        },
        { property: 'Name', title: { contains: 'takuepicalpha' } },
      ],
    },
  });
  assert.deepEqual(both.map((i) => i.id), ['page-epic']);

  // (4) a BLANK term sends NO text filter at all: `title.contains ''` would match every
  // page — a scope that looks applied and is not, which is the silent widening this contract
  // forbids. The request is byte-identical to an unscoped one.
  await board.listWork({ query: '   ' });
  assert.deepEqual(sim.requests[3]?.body, {
    page_size: 100,
    filter: { property: 'Status', select: { equals: 'ready' } },
  });
  assert.equal(board.capabilities().canTextSearch, true);
});

// --- createWork: filing a failure as work, exactly once ---------------------

const CREATE_KEY = 'ci:red:notion:7';
const CREATE_MARKER = `<!-- takumi:created=${CREATE_KEY} -->`;
const PAGES_URL = 'https://api.notion.com/v1/pages';

/** The create requests a simulator recorded, so a test can prove one did NOT happen. */
function creates(sim: ReturnType<typeof notionSimulator>): BoardHttpRequest[] {
  return sim.requests.filter((r) => r.method === 'POST' && r.url === PAGES_URL);
}

test('createWork: the exact create request, the marker in the machine property, and a retry that files nothing', async () => {
  const sim = notionSimulator([]);
  const board = provider(sim);

  const first = await board.createWork({ title: 'Pipeline red', idempotencyKey: CREATE_KEY });

  // --- the search: a database query filtered on the adapter's OWN machine property ---
  assert.equal(sim.requests[0]?.method, 'POST');
  assert.equal(sim.requests[0]?.url, `https://api.notion.com/v1/databases/${DB_ID}/query`);
  assert.deepEqual(sim.requests[0]?.body, {
    page_size: 100,
    filter: { property: 'Takumi State', rich_text: { contains: CREATE_MARKER } },
  });
  // The column's type is learned BEFORE it is written: a `status` board rejects `select`.
  assert.equal(sim.requests[1]?.url, `https://api.notion.com/v1/databases/${DB_ID}`);

  // --- the create: one POST /v1/pages, parented to the DATABASE ---
  const create = creates(sim)[0];
  assert.ok(create !== undefined, 'a create must reach POST /v1/pages');
  assert.deepEqual(create.body, {
    parent: { database_id: DB_ID },
    properties: {
      Name: { title: [{ type: 'text', text: { content: 'Pipeline red' } }] },
      Status: { select: { name: 'ready' } },
      'Takumi State': { rich_text: [{ type: 'text', text: { content: CREATE_MARKER } }] },
    },
  });

  // --- the result: a real, ready item, with no run invented for it ---
  assert.equal(first.created, true);
  assert.equal(first.item.id, 'page-new-1');
  assert.equal(first.item.title, 'Pipeline red');
  assert.equal(first.item.state, 'ready', 'the column option IS the delivery state, so a filed page starts ready');
  assert.equal(first.item.body, '', 'a page has no body field, and the adapter returns "" rather than inventing one');
  assert.equal(await board.readState(first.item.id), null, 'the marker is NOT a record: no run has started yet');
  assert.deepEqual((await board.listWork({ states: ['ready'] })).map((i) => i.id), ['page-new-1']);

  // --- the retry: the query answers, and nothing is created ---
  const before = sim.requests.length;
  const second = await board.createWork({ title: 'Pipeline red', idempotencyKey: CREATE_KEY });
  assert.equal(second.created, false, 'a repeated key must not report a creation');
  assert.equal(second.item.id, first.item.id, 'the FIRST page comes back');
  assert.equal(creates(sim).length, 1, 'a repeated key must never reach POST /v1/pages again');
  assert.equal(sim.requests.length, before + 1, 'the retry costs exactly one search query');
});

test('createWork: the key survives a claim and a transition (the record write carries the marker forward)', async () => {
  const sim = notionSimulator([]);
  const board = provider(sim);
  const filed = await board.createWork({ title: 'Flaky test', idempotencyKey: CREATE_KEY });

  assert.equal((await board.claim(filed.item.id, RUN)).claimed, true);
  await board.transition(filed.item.id, 'pr_open', { runId: RUN, note: 'PR #7' });

  // Notion replaces a rich_text value wholesale, so this is where the marker would be
  // lost — and a retried tick would then file a SECOND page for the same failure.
  const patch = sim.requests.filter((r) => r.method === 'PATCH').at(-1);
  const written = (patch?.body as { properties: Record<string, { rich_text?: unknown[] }> }).properties['Takumi State'];
  assert.equal(written?.rich_text?.length, 2, 'the marker keeps its own run, in front of the record');
  assert.deepEqual(written?.rich_text?.[0], { type: 'text', text: { content: CREATE_MARKER } });
  assert.equal((await board.readState(filed.item.id))?.runId, RUN, 'and the record still parses beside it');

  const again = await board.createWork({ title: 'Flaky test', idempotencyKey: CREATE_KEY });
  assert.equal(again.created, false, 'a retried tick must not re-file work that is already in review');
  assert.equal(again.item.id, filed.item.id);
  assert.equal(again.item.state, 'pr_open', "the returned item is the board's CURRENT view of it");
});

test('createWork: a page that merely quotes the marker is not adopted as ours', async () => {
  // Notion's `rich_text contains` is a SUBSTRING match, so the query returns any page
  // whose text carries the marker — including one created for a different key that has
  // since quoted ours. `createKeyOf` takes the FIRST marker in the text, which is the
  // page's own creation, so the quoted one cannot impersonate it.
  const quoting = makePage('page-other', 'ready');
  quoting.properties['Takumi State'] = rich(`<!-- takumi:created=other:key --> quotes ${CREATE_MARKER}`);
  const sim = notionSimulator([quoting]);
  const board = provider(sim);

  const filed = await board.createWork({ title: 'Pipeline red', idempotencyKey: CREATE_KEY });
  assert.equal(filed.created, true, "another page's creation must not be adopted as ours");
  assert.notEqual(filed.item.id, 'page-other');
  assert.equal(creates(sim).length, 1);
});

test('createWork: labels need a property to live in, and a missing one is refused before any request', async () => {
  const sim = notionSimulator([]);
  const labelled = provider(sim, { labelsProperty: 'Tags' });
  const filed = await labelled.createWork({ title: 'Labelled', labels: ['ci', 'flaky'], idempotencyKey: 'k:1' });
  assert.deepEqual(filed.item.labels, ['ci', 'flaky']);
  assert.deepEqual(
    (creates(sim)[0]?.body as { properties: Record<string, unknown> }).properties['Tags'],
    { multi_select: [{ name: 'ci' }, { name: 'flaky' }] },
  );

  // A board with no labels property cannot record them: that is an error the caller can
  // fix (a construction option), never a silent drop of what they asked for.
  const sim2 = notionSimulator([]);
  await assert.rejects(
    () => provider(sim2).createWork({ title: 'Labelled', labels: ['ci'] }),
    (e: unknown) =>
      e instanceof BoardError && e.kind === 'precondition' && /labelsProperty/.test(e.message),
  );
  assert.deepEqual(sim2.requests, [], 'it must fail before touching the board');

  // ...and a create with no labels does not demand one.
  const plain = await provider(sim2).createWork({ title: 'No labels' });
  assert.deepEqual(plain.item.labels, []);
  const body = creates(sim2)[0]?.body as { properties: Record<string, unknown> };
  assert.equal('Tags' in body.properties, false, 'no labels property is written when there is nothing to write');
});

test('createWork: a status-typed column is written as `status`, learned from the database', async () => {
  const sim = notionSimulator([], { statusColumnType: true });
  const filed = await provider(sim).createWork({ title: 'Status board', state: 'blocked' });
  const body = creates(sim)[0]?.body as { properties: Record<string, unknown> };
  assert.deepEqual(body.properties['Status'], { status: { name: 'blocked' } });
  assert.equal(filed.item.state, 'blocked');
});

test('createWork: a rejected create is classified, and the message names what to fix', async () => {
  const sim = notionSimulator([]);
  const refusing: BoardRequestFn = async (req) =>
    req.method === 'POST' && req.url.endsWith('/pages')
      ? { status: 400, body: '{"object":"error","code":"validation_error","message":"Status is expected to be select."}' }
      : sim.request(req);

  await assert.rejects(
    () => new NotionBoardProvider({ databaseId: DB_ID, request: refusing }).createWork({ title: 'Rejected', idempotencyKey: 'x:1' }),
    (e: unknown) => {
      assert.ok(e instanceof BoardError, 'a rejected create must be a classified board error');
      assert.equal(e.kind, 'precondition', 'retrying a refused create changes nothing');
      assert.equal(e.retriable, false);
      assert.match(e.message, /validation_error/);
      assert.match(e.message, /"ready"/, 'the option it tried to write is named');
      assert.match(e.message, /takumi board --check/, 'and so is the step that fixes it');
      return true;
    },
  );
  assert.deepEqual(sim.pages, [], 'nothing was filed, and nothing is pretended to have been');
});

test('createWork: a malformed idempotency key fails before any request', async () => {
  const sim = notionSimulator([]);
  await assert.rejects(
    () => provider(sim).createWork({ title: 'x', idempotencyKey: 'not a key!' }),
    (e: unknown) => e instanceof BoardError && e.kind === 'precondition' && /invalid idempotency key/.test(e.message),
  );
  assert.deepEqual(sim.requests, []);
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
