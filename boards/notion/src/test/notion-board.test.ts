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
import {
  NotionBoardProvider,
  blocksToText,
  bodyBlocks,
  createNotionTransport,
  normalizeDatabaseId,
  plainText,
} from '../index.js';

/**
 * A tiny in-memory Notion: no network, no token. It answers exactly the
 * endpoints the adapter is allowed to use, records every request so the tests
 * can assert the real request shape, and returns Notion-shaped payloads
 * (properties typed as `select` + `rich_text`, pages with `last_edited_time`).
 */

interface SimBlock {
  object: 'block';
  id: string;
  type: string;
  paragraph?: { rich_text: Array<{ plain_text: string }> };
}

interface SimPage {
  id: string;
  url: string;
  last_edited_time: string;
  properties: Record<string, unknown>;
  /** The page's CONTENT, in the read shape the blocks API answers with. */
  blocks: SimBlock[];
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
    // A page a test hands in starts with NO content, which is what a real page filed by an
    // adapter that did not carry bodies looks like — so a read of it reads as empty.
    blocks: [],
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

function notionSimulator(
  pages: SimPage[],
  // `refuseContent` is MUTABLE on purpose: a test can refuse a content write, watch the
  // adapter report it, then let the next call through and watch the repair happen — which is
  // the whole point of the append-only repair rule.
  opts: { statusColumnType?: boolean; columnOptions?: string[]; refuseContent?: 'create' | 'append' } = {},
) {
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
      const children = (body['children'] ?? []) as unknown[];
      // A page is filed with its content in ONE request, so the same two limits apply —
      // and the simulator enforces them exactly as Notion does, so an adapter that tried to
      // send 101 blocks or a 3000-char run would be refused here, not in production.
      const refusal = opts.refuseContent === 'create' ? 'the host refused this content' : childrenRefusal(children);
      if (refusal !== null) return { status: 400, body: JSON.stringify({ object: 'error', code: 'validation_error', message: refusal }) };
      pageSeq += 1;
      clock += 1000;
      const page: SimPage = {
        id: `page-new-${pageSeq}`,
        url: `https://www.notion.so/page-new-${pageSeq}`,
        last_edited_time: new Date(clock).toISOString(),
        properties,
        blocks: children.flatMap((child, index) => {
          const read = toBlockReadShape(child, `page-new-${pageSeq}-block-${index + 1}`);
          return read === null ? [] : [read];
        }),
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
    // The CONTENT of a page: a body is not a property, so it is its own endpoint — one page
    // of at most 100 blocks per call, with `has_more`/`next_cursor` for the rest, exactly as
    // Notion paginates. A write is refused for the same reasons Notion refuses one.
    const [bare, search] = path.split('?');
    if (bare !== undefined && bare.startsWith('/blocks/') && bare.endsWith('/children')) {
      const pageId = bare.slice('/blocks/'.length, -'/children'.length);
      const page = pages.find((p) => p.id === pageId);
      if (page === undefined) return { status: 404, body: '{"object":"error","code":"object_not_found"}' };
      if (req.method === 'GET') {
        const query = new URLSearchParams(search ?? '');
        const size = Math.min(Number(query.get('page_size') ?? '') || 100, 100);
        const from = Number(query.get('start_cursor') ?? '') || 0;
        const slice = page.blocks.slice(from, from + size);
        const more = from + size < page.blocks.length;
        return json({
          object: 'list',
          results: slice,
          has_more: more,
          next_cursor: more ? String(from + size) : null,
        });
      }
      if (req.method === 'PATCH') {
        const refusal = opts.refuseContent === 'append' ? 'the host refused this content' : childrenRefusal((body['children'] ?? []) as unknown[]);
        if (refusal !== null) {
          return { status: 400, body: JSON.stringify({ object: 'error', code: 'validation_error', message: refusal }) };
        }
        for (const [index, child] of ((body['children'] ?? []) as unknown[]).entries()) {
          const read = toBlockReadShape(child, `${pageId}-block-${page.blocks.length + index + 1}`);
          if (read !== null) page.blocks.push(read);
        }
        return json({ object: 'list', results: page.blocks });
      }
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

/**
 * What Notion refuses about a `children` write, or `null` when it accepts it.
 *
 * The simulator refuses the SAME two things the real API does — more than 100 blocks in one
 * request, and a rich_text run over 2000 characters — because those limits are precisely
 * what the adapter has to chunk around: a simulator that accepted anything would let a
 * "write the body as one block" implementation pass here and fail on the first long body.
 */
function childrenRefusal(children: unknown[]): string | null {
  if (children.length > 100) return 'number of blocks exceeds the limit of 100';
  for (const child of children) {
    const block = child as { type?: string; paragraph?: { rich_text?: Array<{ text?: { content?: string } }> } };
    if (block.type !== 'paragraph') return 'unsupported block type';
    for (const run of block.paragraph?.rich_text ?? []) {
      if ((run.text?.content ?? '').length > 2000) return 'rich_text content exceeds 2000 characters';
    }
  }
  return null;
}

/** A written block in Notion's READ shape: the same paragraph, runs echoed with `plain_text`. */
function toBlockReadShape(block: unknown, id: string): SimBlock | null {
  const written = block as { type?: string; paragraph?: { rich_text?: Array<{ text?: { content?: string } }> } };
  if (written.type !== 'paragraph') return null;
  return {
    object: 'block',
    id,
    type: 'paragraph',
    paragraph: {
      rich_text: (written.paragraph?.rich_text ?? []).map((run) => ({
        plain_text: run.text?.content ?? '',
      })),
    },
  };
}

/** The text a page's CONTENT spells, as a person reading the page would see it. */
function pageContentText(page: SimPage): string {
  return page.blocks
    .flatMap((block) => (block.type === 'paragraph' ? [plainText(block.paragraph?.rich_text)] : []))
    .join('\n');
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
  // By URL, not by index: a read now costs a page read AND a content read, and an index
  // would pin the order of two requests that are both about the same item.
  const pageRead = sim.requests.find((r) => r.url === 'https://api.notion.com/v1/pages/page-2');
  assert.equal(pageRead?.method, 'GET');
  assert.equal(fetched.state, 'claimed');
  // The property read cannot carry a body: Notion answers a body from the blocks endpoint,
  // and the adapter asks for it. `page-2` has no content, so the body is `''` — because the
  // page is empty, not because the adapter does not look.
  assert.ok(
    sim.requests.some((r) => r.url === 'https://api.notion.com/v1/blocks/page-2/children?page_size=100'),
    'a read must ask for the page content, or a body could never be told from an empty one',
  );
  assert.equal(fetched.body, '');
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

/** The database QUERY requests the simulator recorded, in order. */
function queries(sim: ReturnType<typeof notionSimulator>): BoardHttpRequest[] {
  return sim.requests.filter(
    (r) => r.method === 'POST' && r.url === `https://api.notion.com/v1/databases/${DB_ID}/query`,
  );
}

test('listWork: a text scope is a TITLE filter — a term the page carries elsewhere is not a hit', async () => {
  const epic = makePage('page-epic', 'ready');
  epic.properties['Name'] = title('Epic alpha takuepicalpha: ship the intake');
  const other = makePage('page-other', 'ready');
  // The SAME term, carried by the page's machine property instead of its title. Notion
  // lets this adapter filter a TITLE and offers no search over page bodies (or over other
  // properties), so this page must NOT come back: the declared capability is narrower than
  // "everything", and a caller must be able to rely on WHICH text was searched.
  other.properties['Takumi State'] = rich('notes about takuepicalpha live over here');
  const inContent = makePage('page-content', 'ready');
  // And the term in the page's CONTENT — the surface this adapter now WRITES and READS.
  // Reading a body back is not searching it: the query filter has no such condition, and a
  // scope that matched on content would be a different (and uncomparable) promise.
  inContent.blocks = [
    { object: 'block', id: 'page-content-block-1', type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'takuepicalpha is discussed in this page body' }] } },
  ];
  const sim = notionSimulator([epic, other, inContent]);
  const board = provider(sim);

  // (1) the scope REACHES the query body, ANDed with the column filter in one `and`.
  const hit = await board.listWork({ states: ['ready'], query: 'takuepicalpha' });
  // The query of the call that just happened, not "request number N": a list also reads
  // content, so counting requests from zero would pin an order nothing promises.
  const scopedQuery = queries(sim).at(-1);
  assert.equal(scopedQuery?.method, 'POST');
  assert.equal(scopedQuery?.url, `https://api.notion.com/v1/databases/${DB_ID}/query`);
  assert.deepEqual(scopedQuery?.body, {
    page_size: 100,
    filter: {
      and: [
        { property: 'Status', select: { equals: 'ready' } },
        { property: 'Name', title: { contains: 'takuepicalpha' } },
      ],
    },
  });
  assert.deepEqual(hit.map((i) => i.id), ['page-epic'], 'the item whose TITLE carries the term is returned');
  // ...and the content the scope is NOT searched on is still CARRIED BACK: the page whose body
  // holds the term reaches a caller with that body, in the same kind of call. Reading a body
  // and searching a body are different promises, and only the first one is made.
  const listed = await board.listWork({ states: ['ready'] });
  assert.equal(
    listed.find((i) => i.id === 'page-content')?.body,
    'takuepicalpha is discussed in this page body',
  );
  assert.equal(hit.some((i) => i.id === 'page-content'), false, 'a body is read, never matched on');

  // (2) a term NOTHING carries returns nothing — and, just as important, the column filter
  // was not quietly dropped either.
  const miss = await board.listWork({ states: ['ready'], query: 'takunothingcarriesthis' });
  assert.deepEqual(queries(sim).at(-1)?.body, {
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
  assert.deepEqual(queries(sim).at(-1)?.body, {
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

  // (4) a BLANK term is REFUSED. This test used to assert the opposite — "no text filter is
  // sent, so the request is byte-identical to an unscoped one" — which is precisely the
  // silent widening the core rule forbids: the caller asked to narrow and received the whole
  // board, with the dropped scope invisible. Nothing may reach the host.
  const before = sim.requests.length;
  await assert.rejects(
    () => board.listWork({ query: '   ' }),
    (e: unknown) => {
      assert.ok(e instanceof BoardError);
      assert.equal(e.kind, 'precondition');
      return true;
    },
  );
  assert.equal(sim.requests.length, before, 'a refused scope must not be sent');
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
  assert.equal(first.item.body, '', 'a create with no body files a page with no content, so the body reads as empty');
  assert.equal(await board.readState(first.item.id), null, 'the marker is NOT a record: no run has started yet');
  assert.deepEqual((await board.listWork({ states: ['ready'] })).map((i) => i.id), ['page-new-1']);

  // --- the retry: the query answers, and nothing is created ---
  const before = sim.requests.length;
  const second = await board.createWork({ title: 'Pipeline red', idempotencyKey: CREATE_KEY });
  assert.equal(second.created, false, 'a repeated key must not report a creation');
  assert.equal(second.item.id, first.item.id, 'the FIRST page comes back');
  assert.equal(creates(sim).length, 1, 'a repeated key must never reach POST /v1/pages again');
  // The retry is a search plus a content read: the search is what finds the page, and the
  // read is what lets the page be REPAIRED rather than merely reported (see the body tests).
  assert.deepEqual(
    sim.requests.slice(before).map((r) => `${r.method} ${r.url.replace('https://api.notion.com/v1', '')}`),
    [`POST /databases/${DB_ID}/query`, 'GET /blocks/page-new-1/children?page_size=100'],
    'the retry costs one search query and one content read, and never a create',
  );
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
    blocks: [],
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

// --- a body is page CONTENT: written as paragraphs, read back whole -----------------
//
// A Notion page has no body FIELD. The port's `body` therefore travels as CONTENT, and the
// pair below is the whole contract of that: what is written is what a person sees on the
// page, and what a caller reads back is the same text — not a summary of it, not a
// truncated one.

/** A paragraph block in the read shape a content read answers with. */
function paragraph(text: string): SimBlock {
  return {
    object: 'block',
    id: `block-${text.length}-${text.slice(0, 3)}`,
    type: 'paragraph',
    paragraph: { rich_text: [{ plain_text: text }] },
  };
}

/** The page a simulator filed for an id (the read-back path a test asserts against). */
function pageOf(sim: ReturnType<typeof notionSimulator>, id: string): SimPage {
  const page = sim.pages.find((p) => p.id === id);
  assert.ok(page !== undefined, `the simulator has no page ${id}`);
  return page;
}

/** The `children` of a recorded content write. */
function childrenOf(request: BoardHttpRequest | undefined): Array<{ type?: string; paragraph?: { rich_text?: Array<{ text?: { content?: string } }> } }> {
  return ((request?.body as { children?: unknown[] } | undefined)?.children ?? []) as Array<{
    type?: string;
    paragraph?: { rich_text?: Array<{ text?: { content?: string } }> };
  }>;
}

test('a body is page CONTENT: written as one paragraph per line, read back byte for byte', async () => {
  const sim = notionSimulator([]);
  const board = provider(sim);
  // One body that exercises everything the round trip must survive: blank lines, a trailing
  // newline, a line PAST Notion's 2000-character rich_text ceiling (which must become
  // several runs of the SAME paragraph, or the line would be split into two paragraphs and
  // the read-back would grow a newline), and non-ASCII text.
  const long = 'x'.repeat(2500);
  const body = `first line\n\nthird line with 日本語 and an emoji 🚀\n${long}\nlast\n`;

  const filed = await board.createWork({ title: 'Carried', body, idempotencyKey: 'k:body' });

  const create = creates(sim)[0];
  const children = childrenOf(create);
  // Six lines: the blank one, and the empty line a TRAILING newline implies. The count is
  // the line count of the body — that is what makes the read-back exact.
  assert.equal(body.split('\n').length, 6);
  assert.equal(children.length, 6, 'one block per line, the blank and the trailing gap included');
  assert.deepEqual(children.map((b) => b.type), Array(6).fill('paragraph'));
  assert.equal(children[1]?.paragraph?.rich_text?.length, 0, 'a blank line is a paragraph with no runs');
  assert.equal(
    children[3]?.paragraph?.rich_text?.length,
    2,
    'a line past the ceiling is 2 runs of ONE paragraph, never two paragraphs',
  );
  assert.equal(children[3]?.paragraph?.rich_text?.[0]?.text?.content?.length, 2000);
  assert.equal(children[3]?.paragraph?.rich_text?.[1]?.text?.content?.length, 500);
  assert.equal(children[5]?.paragraph?.rich_text?.length, 0, 'the trailing newline is an empty paragraph, not a lost one');

  // What a person reading the page sees, and what the caller gets back: the same text.
  assert.equal(pageContentText(pageOf(sim, filed.item.id)), body);
  assert.equal(filed.item.body, body);
  assert.equal((await board.getWork(filed.item.id)).body, body);
});

test('a body longer than one request: 100 blocks ride the create, the rest are appended, nothing is lost', async () => {
  const sim = notionSimulator([]);
  const board = provider(sim);
  const lines = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`);
  const body = lines.join('\n');

  const filed = await board.createWork({ title: 'Long', body, idempotencyKey: 'k:long' });

  // The simulator refuses >100 blocks in one request exactly as Notion does, so this test
  // fails loudly if the adapter ever posts the whole body in one call.
  assert.equal(childrenOf(creates(sim)[0]).length, 100, 'the create carries what the host accepts');
  const appends = sim.requests.filter((r) => r.method === 'PATCH' && r.url.endsWith(`/blocks/${filed.item.id}/children`));
  assert.deepEqual(
    appends.map((r) => childrenOf(r).length),
    [100, 50],
    'the rest is appended in batches, in order',
  );
  assert.equal(pageContentText(pageOf(sim, filed.item.id)), body);
  assert.equal(filed.item.body, body);
});

test('readContent: false — the body is still WRITTEN; only the read is switched off, and it says so', async () => {
  const sim = notionSimulator([]);
  const board = provider(sim, { readContent: false });

  const filed = await board.createWork({ title: 'Written anyway', body: 'a description', idempotencyKey: 'k:off' });
  assert.equal(pageContentText(pageOf(sim, filed.item.id)), 'a description', 'text is never dropped by a read option');
  assert.equal(filed.item.body, '', 'and the item is honest: it did not read the content');
  assert.equal(sim.requests.some((r) => r.url.includes('/blocks/')), false, 'no content request is made at all');
  const listed = await board.listWork();
  assert.equal(listed.find((i) => i.id === filed.item.id)?.body, '');
});

test('reading content: `has_more` is followed, so a body past one page of blocks comes back whole', async () => {
  const page = makePage('page-big', 'merged');
  const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`);
  page.blocks = lines.map(paragraph);
  const sim = notionSimulator([page]);

  const item = await provider(sim).getWork('page-big');

  assert.equal(item.body, lines.join('\n'));
  const reads = sim.requests.filter((r) => r.url.includes('/blocks/page-big/children'));
  assert.equal(reads.length, 2, 'one request per page of 100 blocks');
  assert.equal(reads[1]?.url.includes('start_cursor=100'), true, 'the cursor is the host\'s, not an offset this adapter invented');
});

test('a re-create REPAIRS a body, and never rewrites content it did not write', async () => {
  // (a) the page exists with NO content: a projection filed before this adapter carried
  // bodies. The same create key is how a tick (and `pilot --resync`) asks for it, so the
  // repair has to happen HERE — rebuilding the page instead would lose its comments.
  const empty = makePage('page-old', 'merged');
  empty.properties['Takumi State'] = rich(`<!-- takumi:created=k:old -->`);
  const sim = notionSimulator([empty]);
  const adopted = await provider(sim).createWork({
    title: 'Item page-old',
    body: 'line one\nline two',
    idempotencyKey: 'k:old',
  });
  assert.equal(adopted.created, false, 'the page exists: nothing is filed a second time');
  assert.equal(adopted.item.id, 'page-old');
  assert.equal(pageContentText(empty), 'line one\nline two', 'the missing body is appended to the page');
  assert.equal(adopted.item.body, 'line one\nline two', 'and the item returned states the page as it now is');
  assert.equal(creates(sim).length, 0, 'a repair appends; it never creates a page');

  // (b) an interrupted append: the page carries a PREFIX of the spec's text, so only the
  // missing lines are added — never a second copy of the ones already there.
  const partial = makePage('page-partial', 'merged');
  partial.properties['Takumi State'] = rich('<!-- takumi:created=k:part -->');
  partial.blocks = [paragraph('one'), paragraph('two')];
  const sim2 = notionSimulator([partial]);
  await provider(sim2).createWork({ title: 'Item page-partial', body: 'one\ntwo\nthree', idempotencyKey: 'k:part' });
  assert.equal(pageContentText(partial), 'one\ntwo\nthree');
  const repairs = sim2.requests.filter((r) => r.method === 'PATCH');
  assert.equal(repairs.length, 1);
  assert.deepEqual(childrenOf(repairs[0]).map((b) => b.paragraph?.rich_text?.[0]?.text?.content), ['three']);

  // (c) a page a PERSON filled in: its content is not a prefix of the spec's text, so it is
  // left exactly as it is — and the returned item carries the page's real text, not a
  // comforting fiction about what this adapter would have written.
  const human = makePage('page-human', 'merged');
  human.properties['Takumi State'] = rich('<!-- takumi:created=k:human -->');
  human.blocks = [paragraph('please do not touch this')];
  const sim3 = notionSimulator([human]);
  const untouched = await provider(sim3).createWork({
    title: 'Item page-human',
    body: 'something else entirely',
    idempotencyKey: 'k:human',
  });
  assert.equal(pageContentText(human), 'please do not touch this');
  assert.equal(untouched.item.body, 'please do not touch this');
  assert.equal(sim3.requests.filter((r) => r.method === 'PATCH').length, 0, 'nothing is written over a human\'s page');
});

test('a content write the host refuses: classified, named, and repairable by the same key', async () => {
  // The append is the half that can fail AFTER a page exists, and that is the state a caller
  // must not have to guess at: "filed" and "complete" are different facts.
  const scenario: { refuseContent?: 'create' | 'append' } = { refuseContent: 'append' };
  const lines = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`);
  const sim = notionSimulator([], scenario);
  const board = provider(sim);

  await assert.rejects(
    () => board.createWork({ title: 'Refused append', body: lines.join('\n'), idempotencyKey: 'k:append' }),
    (e: unknown) => {
      assert.ok(e instanceof BoardError, String(e));
      assert.equal(e.kind, 'precondition');
      assert.match(e.message, /was filed, but its content is incomplete/);
      assert.match(e.message, /0 of 20 block\(s\) were appended/, 'the count is of the blocks this call was appending');
      assert.match(e.message, /Re-running the same create key appends the missing lines/);
      return true;
    },
  );

  // The promise that message makes is kept: the next call with the SAME key appends what is
  // missing, and files nothing twice. (This is also what makes `resync` a real rebuild.)
  delete scenario.refuseContent;
  const healed = await board.createWork({ title: 'Refused append', body: lines.join('\n'), idempotencyKey: 'k:append' });
  assert.equal(healed.created, false);
  assert.equal(pageContentText(pageOf(sim, healed.item.id)), lines.join('\n'));
  assert.equal(creates(sim).length, 1, 'the page existed: the repair created nothing');
});

test('a create whose CONTENT is refused is not reported as a missing column option', async () => {
  // Notion answers 400 for both, and the operator's next move differs: editing a column
  // versus reading what the host said about the page. The message has to allow for both.
  const sim = notionSimulator([], { refuseContent: 'create' });
  await assert.rejects(
    () => provider(sim).createWork({ title: 'Refused', body: 'a line', idempotencyKey: 'k:refused' }),
    (e: unknown) => {
      assert.ok(e instanceof BoardError);
      assert.equal(e.kind, 'precondition');
      assert.match(e.message, /the host refused this content/, "the host's own message is quoted");
      assert.match(e.message, /CONTENT the host refused/, 'and the instruction does not send them to a column that is fine');
      assert.match(e.message, /nothing was filed/);
      return true;
    },
  );
});

test('bodies round trip through the block helpers for arbitrary text (the invariant)', async () => {
  const samples = [
    '',
    'one line',
    '\n',
    'a\n\nb\n',
    'trailing\n',
    `${'y'.repeat(2000)}\n${'z'.repeat(2001)}`,
    'unicode 日本語 emoji 🚀 tab\there',
  ];
  for (const body of samples) {
    assert.equal(
      blocksToText(bodyBlocks(body)),
      body,
      `bodyBlocks/blocksToText must be exact for ${JSON.stringify(body.slice(0, 24))}`,
    );
    // ...and the arithmetic behind it: one block per line, and no line split across two.
    assert.equal(bodyBlocks(body).length, body === '' ? 0 : body.split('\n').length);
  }
});
