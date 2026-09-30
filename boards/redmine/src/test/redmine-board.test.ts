import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BoardError,
  BoardStateError,
  parseBoardStateRecord,
  renderBoardStateRecord,
  runTaskBoardProviderContractSuite,
} from '@takumi/core';
import type {
  BoardHttpRequest,
  BoardHttpResponse,
  BoardRequestFn,
  BoardStateRecord,
  BoardWorkItemState,
} from '@takumi/core';
import {
  createRedmineBoardProvider,
  createRedmineTransport,
  RedmineBoardProvider,
  runMarker,
} from '../index.js';

/**
 * An in-memory Redmine: no network, no API key. It answers exactly the endpoints
 * the adapter is allowed to use, stores the run record where Redmine would really
 * keep it (a text CUSTOM FIELD, not a hidden comment), and records every request so
 * the tests can pin the wire shape down.
 *
 * WHY a hand-written double instead of a mocking library: this repository ships
 * ZERO test dependencies, and the adapter must be provable offline. It is a test
 * double, NOT a Redmine emulator: only the endpoints, fields and statuses the
 * adapter touches are modelled, each documented with the API fact it stands for.
 */

const BASE = 'https://redmine.example.com';
const STATE_FIELD_ID = 21;
const STATE_FIELD_NAME = 'Takumi State';
/** The API key's user, i.e. the author Redmine attributes a written journal to. */
const BOT = 'takumi-bot';

interface SimStatus {
  id: number;
  name: string;
  /** A closed status is excluded by `status_id=open`, exactly as Redmine does. */
  closed?: boolean;
}

/** Redmine's status vocabulary. `Triage` is deliberately unmapped by the adapter. */
const STATUSES: readonly SimStatus[] = [
  { id: 1, name: 'ready' },
  { id: 2, name: 'claimed' },
  { id: 3, name: 'pr_open' },
  { id: 4, name: 'fix_needed' },
  { id: 5, name: 'merged' },
  { id: 6, name: 'blocked' },
  { id: 7, name: 'Triage' },
  { id: 8, name: 'Closed', closed: true },
];

interface SimJournal {
  id: number;
  notes: string;
  author: string;
  createdOn: string;
}

interface SimCustomField {
  id: number;
  name: string;
  value: unknown;
}

interface SimIssue {
  id: number;
  subject: string;
  description: string;
  statusId: number;
  assignee: string | null;
  updatedOn: string;
  customFields: SimCustomField[];
  journals: SimJournal[];
  /** The project this issue belongs to; `acme`/1 unless a test seeds a foreign one. */
  project?: { id: number; identifier: string; name: string };
}

/** The project every issue of this double belongs to unless a test says otherwise. */
const SIM_PROJECT = { id: 1, identifier: 'acme', name: 'Acme Inc' } as const;

interface Fault {
  matches: (req: BoardHttpRequest) => boolean;
  once: boolean;
  response: BoardHttpResponse;
}

function statusIdByName(name: string): number {
  const found = STATUSES.find((status) => status.name === name);
  if (found === undefined) throw new Error(`sim: the test asked for an unknown status ${JSON.stringify(name)}`);
  return found.id;
}

function statusNameById(id: number): string {
  return STATUSES.find((status) => status.id === id)?.name ?? 'unknown';
}

function makeIssue(id: number, statusName: string, extra: Partial<SimIssue> = {}): SimIssue {
  return {
    id,
    subject: `Issue ${id}`,
    description: `please do ${id}`,
    statusId: statusIdByName(statusName),
    assignee: null,
    updatedOn: '2026-09-15T00:00:00.000Z',
    customFields: [{ id: STATE_FIELD_ID, name: STATE_FIELD_NAME, value: null }],
    journals: [],
    ...extra,
  };
}

function redmineSimulator(seedIssues: SimIssue[]) {
  const issues = seedIssues;
  const requests: BoardHttpRequest[] = [];
  const faults: Fault[] = [];
  let journalSeq = 1000;

  const json = (payload: unknown, status = 200): BoardHttpResponse => ({ status, body: JSON.stringify(payload) });
  const noContent = (): BoardHttpResponse => ({ status: 204, body: '' });
  const notFound = (): BoardHttpResponse => json({ error: 'The requested resource does not exist' }, 404);

  const serialize = (issue: SimIssue, withJournals = false): Record<string, unknown> => ({
    id: issue.id,
    subject: issue.subject,
    description: issue.description,
    status: { id: issue.statusId, name: statusNameById(issue.statusId) },
    project: issue.project ?? SIM_PROJECT,
    assigned_to: issue.assignee === null ? null : { id: 9, name: issue.assignee },
    updated_on: issue.updatedOn,
    custom_fields: issue.customFields.map((field) => ({ id: field.id, name: field.name, value: field.value })),
    ...(withJournals
      ? {
          journals: issue.journals.map((journal) => ({
            id: journal.id,
            notes: journal.notes,
            user: { id: 2, name: journal.author },
            created_on: journal.createdOn,
          })),
          allowed_statuses: STATUSES.filter((status) => status.closed !== true).map((status) => ({
            id: status.id,
            name: status.name,
          })),
        }
      : {}),
  });

  const request: BoardRequestFn = async (req) => {
    requests.push(cloneRequest(req));

    const index = faults.findIndex((fault) => fault.matches(req));
    if (index !== -1) {
      const fault = faults[index] as Fault;
      if (fault.once) faults.splice(index, 1);
      return fault.response;
    }

    const url = new URL(req.url);
    const path = url.pathname;
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (req.method === 'GET' && path === '/issue_statuses.json') {
      // The documented shape: {issue_statuses: [{id, name, is_closed}]} — Redmine
      // also reports `is_default`, which this adapter deliberately ignores (the
      // configured STATUS NAME decides, never "whatever is default").
      return json({
        issue_statuses: STATUSES.map((status) => ({
          id: status.id,
          name: status.name,
          is_default: status.id === 1,
          is_closed: status.closed === true,
        })),
      });
    }

    if (req.method === 'GET' && path === '/issues.json') {
      const statusParam = url.searchParams.get('status_id') ?? 'open';
      const limit = intParam(url, 'limit', 25);
      const offset = intParam(url, 'offset', 0);
      const project = url.searchParams.get('project_id');
      const matching = issues
        .filter((issue) => statusParam === '*' || STATUSES.find((s) => s.id === issue.statusId)?.closed !== true)
        .filter((issue) => project === null || (issue.project ?? SIM_PROJECT).identifier === project);
      return json({
        issues: matching.slice(offset, offset + limit).map((issue) => serialize(issue)),
        total_count: matching.length,
        offset,
        limit,
      });
    }

    // Filing: createWork posts here, and searches with /search.json first.
    if (req.method === 'POST' && path === '/issues.json') {
      const fields = (body['issue'] ?? {}) as Record<string, unknown>;
      const statusId = fields['status_id'];
      if (STATUSES.find((status) => status.id === statusId) === undefined) {
        return json({ errors: ['Status is not valid'] }, 422);
      }
      const created: SimIssue = {
        id: Math.max(0, ...issues.map((issue) => issue.id)) + 1,
        subject: String(fields['subject'] ?? ''),
        description: String(fields['description'] ?? ''),
        statusId: Number(statusId),
        assignee: null,
        updatedOn: '2026-09-15T00:00:00Z',
        // A real instance gives the tracker's issues the state custom field, empty; a
        // created issue without it could not be claimed (the write would 422), which is
        // exactly what the suite caught when this double first omitted it.
        customFields: [{ id: STATE_FIELD_ID, name: STATE_FIELD_NAME, value: null }],
        journals: [],
      };
      issues.push(created);
      return json({ issue: serialize(created) }, 201);
    }

    if (req.method === 'GET' && path === '/search.json') {
      // Redmine's full-text search answers issues whose description contains the term.
      // `open_issues=1` is the documented filter that drops closed issues — the same
      // "open work" scope `/issues.json?status_id=open` gives the list path — so the
      // double applies it rather than letting a scoped query quietly return a closed
      // issue the list path would never return.
      const query = url.searchParams.get('q') ?? '';
      const openOnly = url.searchParams.get('open_issues') === '1';
      const hits = issues
        .filter((issue) => !openOnly || STATUSES.find((s) => s.id === issue.statusId)?.closed !== true)
        // Redmine's search is a full-text search: case-insensitive, over the subject AND
        // the description. A case-sensitive double made a capitalised subject invisible to
        // a lowercase term, which is how a real search never behaves.
        .filter((issue) => {
          const needle = query.toLowerCase();
          return (
            issue.subject.toLowerCase().includes(needle) || issue.description.toLowerCase().includes(needle)
          );
        });
      return json({ results: hits.map((issue) => ({ id: issue.id, type: 'issue', title: issue.subject })) });
    }

    // The documented lookup a scoped search needs to turn a project IDENTIFIER into the
    // numeric id Redmine's `project_id` really is (`GET /projects/<id-or-identifier>.json`),
    // and the source of the `project` block every issue is serialized with.
    const projectPath = /^\/projects\/([^/]+)\.json$/.exec(path);
    if (req.method === 'GET' && projectPath !== null) {
      const asked = projectPath[1] ?? '';
      if (asked !== 'acme' && asked !== '1') return notFound();
      return json({ project: { id: 1, identifier: 'acme', name: 'Acme Inc', status: 1 } });
    }

    const issuePath = /^\/issues\/(\d+)\.json$/.exec(path);
    if (issuePath !== null && req.method === 'GET') {
      // Redmine only returns the comment thread when `include=journals` is asked
      // for, so a request without it would silently look like an issue with none.
      if ((url.searchParams.get('include') ?? '').includes('journals') === false) {
        return json({ error: 'include=journals is required to read journals' }, 400);
      }
      const found = issues.find((issue) => String(issue.id) === issuePath[1]);
      return found === undefined ? notFound() : json(serialize(found, true));
    }

    if (issuePath !== null && req.method === 'PUT') {
      const found = issues.find((issue) => String(issue.id) === issuePath[1]);
      if (found === undefined) return notFound();
      const fields = (body['issue'] ?? {}) as Record<string, unknown>;

      if (fields['status_id'] !== undefined) {
        const status = STATUSES.find((candidate) => candidate.id === fields['status_id']);
        if (status === undefined) return json({ errors: ['Status is not valid'] }, 422);
        found.statusId = status.id;
      }
      if (typeof fields['notes'] === 'string' && fields['notes'].length > 0) {
        journalSeq += 1;
        found.journals.push({
          id: journalSeq,
          notes: fields['notes'],
          author: BOT,
          createdOn: found.updatedOn,
        });
      }
      if (Array.isArray(fields['custom_fields'])) {
        for (const raw of fields['custom_fields']) {
          const entry = (raw ?? {}) as { id?: number; value?: unknown };
          const field = found.customFields.find((candidate) => candidate.id === entry.id);
          // A custom field the issue does not carry cannot be written: Redmine
          // answers 422 (the field is not part of the issue's tracker/project).
          if (field === undefined) return json({ errors: ['Custom field is not valid'] }, 422);
          field.value = entry.value;
        }
      }
      found.updatedOn = '2026-09-15T01:00:00.000Z';
      return noContent();
    }

    const journalPath = /^\/journals\/(\d+)\.json$/.exec(path);
    if (journalPath !== null && req.method === 'PUT') {
      const issue = issues.find((candidate) =>
        candidate.journals.some((journal) => String(journal.id) === journalPath[1]),
      );
      const journal = issue?.journals.find((candidate) => String(candidate.id) === journalPath[1]);
      if (journal === undefined) return notFound();
      const journalBody = (body['journal'] ?? {}) as Record<string, unknown>;
      if (typeof journalBody['notes'] !== 'string') return json({ errors: ['Notes cannot be blank'] }, 422);
      journal.notes = journalBody['notes'];
      return noContent();
    }

    return notFound();
  };

  return {
    request,
    requests,
    issues,
    /** Forget the recorded requests, so a test can assert one phase at a time. */
    clearRequests(): void {
      requests.length = 0;
    },
    /** Put a journal straight on the board, as if another user wrote it. */
    appendJournal(issueId: number, notes: string, author: string): number {
      const issue = issues.find((candidate) => candidate.id === issueId);
      if (issue === undefined) throw new Error(`sim: no seeded issue ${issueId}`);
      journalSeq += 1;
      issue.journals.push({ id: journalSeq, notes, author, createdOn: issue.updatedOn });
      return journalSeq;
    },
    /** The raw value in an issue's state field, as Redmine would report it. */
    stateFieldValue(issueId: number): unknown {
      return issues.find((candidate) => candidate.id === issueId)?.customFields[0]?.value ?? null;
    },
    journalNotes(issueId: number): string[] {
      return (issues.find((candidate) => candidate.id === issueId)?.journals ?? []).map((journal) => journal.notes);
    },
    /** Answer the NEXT request with this response instead of routing it. */
    failNext(status: number, payload: unknown = { error: 'forced' }): void {
      faults.push({
        matches: () => true,
        once: true,
        response: { status, body: JSON.stringify(payload) },
      });
    },
  };
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) ? value : fallback;
}

function cloneRequest(req: BoardHttpRequest): BoardHttpRequest {
  const clone: BoardHttpRequest = { method: req.method, url: req.url };
  if (req.headers !== undefined) clone.headers = { ...req.headers };
  if (req.body !== undefined) clone.body = JSON.parse(JSON.stringify(req.body)) as unknown;
  return clone;
}

type Sim = ReturnType<typeof redmineSimulator>;

function provider(sim: Sim, extra: Record<string, unknown> = {}): RedmineBoardProvider {
  return createRedmineBoardProvider({
    baseUrl: BASE,
    project: 'acme',
    request: sim.request,
    stateFieldId: STATE_FIELD_ID,
    ...extra,
  });
}

const RUN = 'c0ffee01';

function stateRecord(overrides: Partial<BoardStateRecord> = {}): BoardStateRecord {
  return {
    schema: 1,
    runId: RUN,
    item: '101',
    reviewRound: 0,
    updatedAt: '2026-09-15T00:00:00.000Z',
    ...overrides,
  };
}

/** A `BoardError` predicate, so a rejection is pinned to the shared taxonomy. */
function boardError(kind: string, re?: RegExp) {
  return (e: unknown): boolean =>
    e instanceof BoardError && e.kind === kind && (re === undefined || re.test(e.message));
}

// --- the shared contract suite ---------------------------------------------

test('RedmineBoardProvider: shared task-board contract suite over an injected transport', async (t) => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  const out = await runTaskBoardProviderContractSuite(provider(sim, { trustedAuthors: [BOT] }), {
    id: 'redmine',
    itemId: '101',
    unknownItemId: '999999',
  });

  assert.equal(out.gate, 'task-board-contract');
  // The suite's own verdict on the state-bootstrap port, printed as a diagnostic so
  // the evidence is in the run's output and not only in an assertion message.
  for (const note of out.notes.filter((n) => n.startsWith('bootstrapStates:'))) t.diagnostic(note);
  // Every check runs because a state field and an author allowlist are configured.
  // The ONE thing the suite cannot inject is a foreign-authored record (a real
  // adapter writes as itself), so it reports that single check as PARTIAL instead
  // of pretending — the adapter test below proves the filter with a fixture.
  assert.equal(out.result, 'PASS_WITH_NOT_RUN');
  assert.ok(
    out.notes.some((note) => note.includes('trustedAuthorFilter=true but no writeUntrustedRecord injection point')),
    out.notes.join('\n'),
  );
  assert.ok(out.notes.some((note) => note.startsWith('claim: PASS')), out.notes.join('\n'));
  assert.ok(out.notes.some((note) => note.startsWith('transition: PASS')), out.notes.join('\n'));
  assert.ok(out.notes.some((note) => note.startsWith('terminal: PASS')), out.notes.join('\n'));
  assert.ok(out.notes.some((note) => note.startsWith('comment: PASS')), out.notes.join('\n'));
  assert.ok(
    out.notes.some((note) => note.includes('stateRecord: PARTIAL (round-trip PASS')),
    out.notes.join('\n'),
  );
  assert.ok(out.notes.some((note) => note.includes('credentials: NOT_REQUIRED')), out.notes.join('\n'));
  // The suite runs bootstrapStates itself now. Redmine's statuses live in
  // administration, so the adapter reports them: the instance has all six status
  // names, so canCreate=false with six exist and none to warn about.
  assert.ok(
    out.notes.some((note) => note.startsWith('bootstrapStates: PASS (canCreate=false created=0 exists=6 notCreatable=0')),
    out.notes.join('\n'),
  );
  // The suite drives the free-text scope itself: it files a probe item whose text carries a
  // distinctive word, requires the adapter to FIND it with `query`, and requires nothing for
  // a word nothing carries. Both halves only pass if the term really reached Redmine's own
  // search — and the positive half also proves the candidate read-back: a hit is mapped by
  // the same reader every other list path uses.
  assert.ok(out.notes.some((note) => note.includes('canTextSearch=true')), out.notes.join('\n'));
  assert.ok(
    out.notes.some((note) => note.startsWith('query: PASS (1 hit(s), no false positive)')),
    out.notes.join('\n'),
  );
});

test('capabilities: no delivery side, trust only when declared, state only with a field', () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);

  const caps = provider(sim).capabilities();
  assert.deepEqual(caps.states, ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked']);
  assert.deepEqual(caps.delivery, { canOpenPullRequest: false, canRunChecks: false, canMerge: false });
  assert.equal(caps.atomicClaim, false, 'Redmine has no conditional write, so the claim is read-then-write plus a re-read');
  assert.equal(caps.comments, true);
  assert.equal(caps.editableComment, true);
  assert.equal(caps.machineReadableState, true, 'a state field is configured');
  assert.equal(caps.trustedAuthorFilter, false, 'Redmine journals expose no role, so the default is honest');
  assert.equal(
    caps.canBootstrapStates,
    false,
    'Redmine issue statuses are administration data, so this adapter only reports them',
  );
  assert.equal(
    caps.canTextSearch,
    true,
    "the issue list has no free-text filter, but PUT /search.json is this instance's own text index",
  );

  const withTrust = provider(sim, { trustedAuthors: [BOT] }).capabilities();
  assert.equal(withTrust.trustedAuthorFilter, true);

  const noField = createRedmineBoardProvider({ baseUrl: BASE, project: 'acme', request: sim.request });
  assert.equal(noField.capabilities().machineReadableState, false, 'no custom field means nowhere to keep the record');
});

test('bootstrapStates: reads the installation statuses and names the status an operator must add', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  // `merged` is mapped to a status this installation does not have: the report has
  // to name it, and name BOTH steps of the fix.
  const board = provider(sim, { statusMap: { ready: 'ready', merged: 'Shipped' } });
  const desired: BoardWorkItemState[] = ['ready', 'merged', 'blocked'];

  const report = await board.bootstrapStates(desired);
  assert.deepEqual(
    sim.requests.map((req) => `${req.method} ${req.url}`),
    [`GET ${BASE}/issue_statuses.json`],
    'one read of the installation status list, and nothing else',
  );
  assert.equal(report.provider, 'redmine');
  assert.equal(report.applied, false, 'the REST API cannot create a status, so nothing was changed');
  assert.deepEqual(report.unsupported, [], 'the adapter declares all six states, so none is out of reach');
  assert.deepEqual(
    report.actions.map((action) => [action.state, action.name, action.outcome]),
    [
      ['ready', 'ready', 'exists'],
      ['merged', 'Shipped', 'not-creatable'],
      ['blocked', 'blocked', 'exists'],
    ],
    "the name comes from the adapter's OWN statusMap",
  );
  const missing = report.actions[1];
  assert.match(missing?.instruction ?? '', /no issue status named "Shipped"/, 'the report names the status to add');
  assert.match(missing?.instruction ?? '', /Administration/);
  assert.match(
    missing?.instruction ?? '',
    /--status-map "<delivery state>=<Status Name>"/,
    'and the mapping the adapter must be given afterwards',
  );

  // The status name is matched exactly the way the mapping resolves it: case-insensitively.
  const caseInsensitive = await provider(sim, { statusMap: { ready: 'READY' } }).bootstrapStates(['ready']);
  assert.equal(caseInsensitive.actions[0]?.outcome, 'exists', 'the same case-insensitive rule resolveStatusId uses');

  // A dry run and a real run are the SAME read: neither writes, so both report the
  // same facts and neither is `applied`. (No request appears below because
  // `statuses()` resolves `/issue_statuses.json` once per provider — which is why
  // the assertion is "no write was attempted", not "one read happened".)
  sim.clearRequests();
  const dry = await board.bootstrapStates(desired, { dryRun: true });
  assert.deepEqual(dry, report, 'a read-only report cannot differ between a dry run and a real one');
  assert.ok(sim.requests.every((req) => req.method === 'GET'), 'a dry run writes nothing');

  // Idempotent by construction, and it never claims creation.
  sim.clearRequests();
  const again = await board.bootstrapStates(desired);
  assert.deepEqual(again, report, 'the second call reports the same, unchanged facts');
  assert.equal(again.applied, false, 'a second call changes nothing');
  assert.ok(
    !again.actions.some((action) => action.outcome === 'created' || action.outcome === 'would-create'),
    'canBootstrapStates=false: nothing may ever be created or promised, not even on a dry run',
  );
});

// --- listWork ---------------------------------------------------------------

test('listWork: exact request shape, and pagination walks every page Redmine reports', async () => {
  const sim = redmineSimulator([
    makeIssue(101, 'ready'),
    makeIssue(102, 'claimed'),
    makeIssue(103, 'ready'),
    makeIssue(104, 'Closed'),
  ]);
  const board = provider(sim, { pageSize: 2 });

  const items = await board.listWork();
  assert.deepEqual(
    sim.requests.map((req) => `${req.method} ${req.url}`),
    [
      `GET ${BASE}/issues.json?project_id=acme&status_id=open&limit=2&offset=0`,
      `GET ${BASE}/issues.json?project_id=acme&status_id=open&limit=2&offset=2`,
    ],
    'total_count=3 with pageSize=2 is TWO requests, not one silently truncated page',
  );
  // These are the states each issue's own status maps onto.
  assert.deepEqual(items.map((item) => [item.id, item.state]), [
    ['101', 'ready'],
    ['102', 'claimed'],
    ['103', 'ready'],
  ]);
  assert.ok(!items.some((item) => item.id === '104'), 'a closed issue is not open work');

  // An issue in a status the adapter cannot map is a CONFIGURATION GAP, not a
  // filter outcome: it must be reported, never dropped. A dropped item makes a
  // board missing its statusMap look exactly like a board with no work.
  sim.issues.push(makeIssue(105, 'Triage'));
  sim.clearRequests();
  await assert.rejects(
    () => board.listWork(),
    boardError('precondition', /"Triage" map to no delivery state/),
    'an unmapped status must be reported, not silently skipped',
  );

  // `limit` bounds the COLLECTION, so one page is enough.
  sim.clearRequests();
  const limited = await board.listWork({ limit: 1 });
  assert.deepEqual(limited.map((item) => item.id), ['101']);
  assert.equal(sim.requests.length, 1);

  // A status that IS mapped but not asked for is the filter working as asked: no
  // error, just absence.
  sim.issues.pop();
  sim.issues.push(makeIssue(106, 'merged'));
  sim.clearRequests();
  const filtered = await board.listWork({ states: ['ready'] });
  assert.deepEqual(filtered.map((item) => item.id), ['101', '103'], 'the merged issue is filtered out, not flagged');

  // A label filter cannot be honoured: refusing beats returning unfiltered work.
  await assert.rejects(() => board.listWork({ labels: ['bug'] }), boardError('unsupported', /no labels/));
});

test('listWork: without a project the project_id parameter is simply absent', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  const board = createRedmineBoardProvider({ baseUrl: BASE, request: sim.request, stateFieldId: STATE_FIELD_ID });
  await board.listWork();
  assert.equal(sim.requests[0]?.url, `${BASE}/issues.json?status_id=open&limit=100&offset=0`);
});

// --- listWork: the free-text scope ------------------------------------------

test('listWork: a text scope goes through /search.json, then one read per candidate', async () => {
  const sim = redmineSimulator([
    makeIssue(101, 'ready', { subject: 'Nebula rollout kickoff' }),
    makeIssue(102, 'ready', { description: 'please do the nebula thing' }),
    makeIssue(103, 'ready', { subject: 'unrelated work' }),
    makeIssue(104, 'claimed', { subject: 'Nebula rollout, continued' }),
  ]);
  const board = provider(sim);

  const items = await board.listWork({ states: ['ready'], query: 'nebula' });

  // The whole cost of this scope, on the wire: the search, ONE read per candidate (the
  // search answers no status, so a hit is not work until it has been read), and the one
  // project-identifier lookup a slug-configured board needs to place those candidates.
  assert.deepEqual(
    sim.requests.map((req) => `${req.method} ${req.url}`),
    [
      `GET ${BASE}/search.json?issues=1&open_issues=1&q=nebula&limit=100&offset=0`,
      `GET ${BASE}/issues/101.json?include=journals,allowed_statuses`,
      `GET ${BASE}/projects/acme.json`,
      `GET ${BASE}/issues/102.json?include=journals,allowed_statuses`,
      `GET ${BASE}/issues/104.json?include=journals,allowed_statuses`,
    ],
    'search first, then a read per candidate, and the slug resolved exactly once',
  );
  // Redmine matches the term over the subject AND the description, and the STATE filter
  // still applies — at the point where the state can actually be known: 104 carries the
  // term but is claimed, 103 is ready but carries nothing.
  assert.deepEqual(
    items.map((item) => [item.id, item.state]),
    [
      ['101', 'ready'],
      ['102', 'ready'],
    ],
  );
  assert.deepEqual(items.map((item) => item.title), ['Nebula rollout kickoff', 'Issue 102']);
});

test('listWork: a term nothing carries returns nothing, not everything', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready'), makeIssue(102, 'claimed')]);
  const board = provider(sim);

  const items = await board.listWork({ states: ['ready'], query: 'takuredminenothingcarriesthis' });

  assert.deepEqual(items, [], 'a term the board does not know means no work, never all work');
  assert.deepEqual(
    sim.requests.map((req) => req.url),
    [`${BASE}/search.json?issues=1&open_issues=1&q=takuredminenothingcarriesthis&limit=100&offset=0`],
    'the miss is Redmine answering nothing, not this adapter dropping the term — and it read nobody back',
  );
});

test('listWork: a scoped search keeps the open-work scope and honours limit', async () => {
  const sim = redmineSimulator([
    makeIssue(101, 'ready', { subject: 'Nebula one' }),
    makeIssue(102, 'ready', { subject: 'Nebula two' }),
    makeIssue(103, 'Closed', { subject: 'Nebula shipped' }),
  ]);
  const board = provider(sim);

  const items = await board.listWork({ states: ['ready'], query: 'Nebula', limit: 1 });

  assert.deepEqual(items.map((item) => item.id), ['101'], 'limit bounds the collection');
  assert.match(sim.requests[0]?.url ?? '', /&limit=1&/, 'the search page is bounded by the same limit');
  assert.equal(
    sim.requests.filter((request) => request.url.includes('/issues/')).length,
    1,
    'limit bounds the READS too: a candidate the caller cannot see is not fetched',
  );
  // `open_issues=1` is the same open-work scope `status_id=open` gives the list path. Had
  // the search dropped it, the closed issue 103 would have been read back — and its status
  // maps to no delivery state, so the scoped query would have failed as a configuration
  // gap instead of answering with the open work it was asked about.
  assert.match(sim.requests[0]?.url ?? '', /open_issues=1/);
});

test('listWork: a scoped search never returns another project\'s issues', async () => {
  const sim = redmineSimulator([
    makeIssue(101, 'ready', { subject: 'Nebula ours' }),
    makeIssue(102, 'ready', {
      subject: 'Nebula theirs',
      project: { id: 7, identifier: 'other', name: 'Other Inc' },
    }),
  ]);
  const board = provider(sim);

  const items = await board.listWork({ states: ['ready'], query: 'Nebula' });

  // /search.json is a GLOBAL search — its only documented scope values are
  // all|my_project|subprojects, with no project-id filter — so the project check is this
  // adapter's job, exactly as `project_id` does it server-side on the list path.
  assert.deepEqual(items.map((item) => item.id), ['101'], "another project's issue is not this board's work");
  assert.deepEqual(
    sim.requests.filter((request) => request.url.includes('/issues/')).map((request) => request.url),
    [
      `${BASE}/issues/101.json?include=journals,allowed_statuses`,
      `${BASE}/issues/102.json?include=journals,allowed_statuses`,
    ],
    'both candidates were READ: the foreign one is checked against the configured project, not assumed away',
  );
});

test('listWork: a blank scope is refused, never sent as a search for everything', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  const board = provider(sim);

  // Redmine reads a blank `q` as "everything", so this is the one term that would widen
  // the query instead of narrowing it.
  await assert.rejects(
    () => board.listWork({ states: ['ready'], query: '   ' }),
    boardError('precondition', /non-whitespace/),
  );
  assert.deepEqual(sim.requests, [], 'nothing was sent');
});

test('getWork: one issue, asked for with journals, mapped onto BoardWorkItem', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready', { assignee: 'Aiko Tanaka' })]);
  const board = provider(sim);

  const item = await board.getWork('101');
  assert.equal(sim.requests[0]?.url, `${BASE}/issues/101.json?include=journals,allowed_statuses`);
  assert.equal(item.id, '101');
  assert.equal(item.title, 'Issue 101');
  assert.equal(item.body, 'please do 101');
  assert.equal(item.url, `${BASE}/issues/101`);
  assert.equal(item.state, 'ready');
  assert.deepEqual(item.labels, []);
  assert.deepEqual(item.assignees, ['Aiko Tanaka']);
  assert.equal(item.updatedAt, '2026-09-15T00:00:00.000Z');
  assert.ok(item.raw !== undefined, 'the adapter-native payload stays available for debugging');

  await assert.rejects(() => board.getWork('999999'), boardError('not_found'));
  await assert.rejects(() => board.getWork('not-a-number'), boardError('not_found'));
});

test('getWork: an unmapped status is a precondition error, never a guessed state', async () => {
  const sim = redmineSimulator([makeIssue(101, 'Triage')]);
  await assert.rejects(
    () => provider(sim).getWork('101'),
    boardError('precondition', /does not map \(mapped: ready, claimed/),
  );
});

// --- claim ------------------------------------------------------------------

test('claim: one PUT carries the mapped status id AND the record, then a re-read proves it', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  const board = provider(sim);

  const result = await board.claim('101', RUN);
  assert.deepEqual(result, { item: '101', runId: RUN, claimed: true });

  assert.deepEqual(
    sim.requests.map((req) => `${req.method} ${req.url}`),
    [
      `GET ${BASE}/issues/101.json?include=journals,allowed_statuses`,
      `GET ${BASE}/issue_statuses.json`,
      `PUT ${BASE}/issues/101.json`,
      `GET ${BASE}/issues/101.json?include=journals,allowed_statuses`,
    ],
    'read → resolve the status name → write both facts → re-read to prove the claim',
  );

  const put = sim.requests[2];
  assert.ok(put);
  const fields = (put.body as { issue: Record<string, unknown> }).issue;
  assert.equal(fields['status_id'], 2, 'the id of the STATUS NAMED "claimed", resolved from /issue_statuses.json');
  const customFields = fields['custom_fields'] as Array<{ id: number; value: string }>;
  assert.equal(customFields[0]?.id, STATE_FIELD_ID);
  assert.match(customFields[0]?.value ?? '', /takumi:boardstate:v1/);
  assert.equal(sim.issues[0]?.statusId, 2, 'the status really moved');
  assert.ok(
    String(sim.stateFieldValue(101)).includes(`"runId":"${RUN}"`),
    'the record really landed in the custom field, which is what the re-read proves',
  );
});

test('claim: a second run, a non-ready item and a missing field are all refused non-silently', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready'), makeIssue(102, 'merged')]);
  const board = provider(sim);

  await board.claim('101', RUN);
  const second = await board.claim('101', 'deadbeef');
  assert.equal(second.claimed, false);
  assert.match(second.reason ?? '', /already claimed by c0ffee01/);

  const notReady = await board.claim('102', RUN);
  assert.equal(notReady.claimed, false);
  assert.match(notReady.reason ?? '', /item is in state merged, not ready/);
  assert.equal(sim.issues[1]?.statusId, statusIdByName('merged'), 'a refused claim writes nothing');

  // With no state field there is no record to prove ownership with: fail closed.
  const noField = createRedmineBoardProvider({ baseUrl: BASE, project: 'acme', request: sim.request });
  await assert.rejects(() => noField.claim('101', RUN), boardError('unsupported', /machineReadableState/));
});

test('claim: losing the race is REPORTED, never accepted', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  let issueReads = 0;
  // Wrap the transport so the RE-READ (the second issue read) reports a record
  // written by another worker: exactly what a lost race looks like on Redmine,
  // where two writes cannot be made conditional.
  const racing: BoardRequestFn = async (req) => {
    const response = await sim.request(req);
    if (req.method === 'GET' && req.url === `${BASE}/issues/101.json?include=journals,allowed_statuses`) {
      issueReads += 1;
      if (issueReads === 2) {
        const payload = JSON.parse(response.body) as Record<string, unknown>;
        payload['custom_fields'] = [
          {
            id: STATE_FIELD_ID,
            name: STATE_FIELD_NAME,
            value: renderBoardStateRecord(stateRecord({ runId: 'other-run' })),
          },
        ];
        return { status: response.status, body: JSON.stringify(payload) };
      }
    }
    return response;
  };
  const board = createRedmineBoardProvider({
    baseUrl: BASE,
    project: 'acme',
    request: racing,
    stateFieldId: STATE_FIELD_ID,
  });

  const result = await board.claim('101', RUN);
  assert.equal(result.claimed, false);
  assert.match(result.reason ?? '', /lost a concurrent claim to other-run/);
});

// --- transition -------------------------------------------------------------

test('transition: the target status is resolved BY NAME, the note rides along, the record is kept', async () => {
  const seeded = makeIssue(101, 'claimed');
  seeded.customFields[0] = {
    id: STATE_FIELD_ID,
    name: STATE_FIELD_NAME,
    value: renderBoardStateRecord({
      schema: 1,
      runId: 'previous-run',
      item: '101',
      baseBranch: 'main',
      reviewRound: 2,
      updatedAt: '2026-09-14T00:00:00.000Z',
    }),
  };
  const sim = redmineSimulator([seeded]);
  const board = provider(sim);

  await board.transition('101', 'pr_open', { runId: RUN, note: 'opening the PR' });

  const put = sim.requests.find((req) => req.method === 'PUT');
  assert.ok(put);
  assert.equal(put.url, `${BASE}/issues/101.json`);
  const fields = (put.body as { issue: Record<string, unknown> }).issue;
  assert.equal(fields['status_id'], 3, 'the id of the STATUS NAMED "pr_open"');
  assert.equal(fields['notes'], 'opening the PR', 'the evidence note travels in the SAME write as the status');

  const customFields = fields['custom_fields'] as Array<{ id: number; value: string }>;
  const stored = parseBoardStateRecord(customFields[0]?.value ?? '');
  assert.ok(stored);
  assert.equal(stored.runId, 'previous-run', 'a transition is not a re-claim: the record still names its run');
  assert.equal(stored.reviewRound, 2);
  assert.equal(stored.baseBranch, 'main');
  assert.equal(stored.note, 'opening the PR');

  assert.deepEqual(sim.journalNotes(101), ['opening the PR'], 'the note is a real Redmine journal');
  assert.equal(sim.issues[0]?.statusId, 3);
});

test('transition: an unknown status name is unsupported, and names the available statuses', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  const board = provider(sim, { statusMap: { ready: 'ready', claimed: 'Doing Something Nobody Defined' } });

  await assert.rejects(
    () => board.claim('101', RUN),
    boardError('unsupported', /no issue status named "Doing Something Nobody Defined" \(available: ready, claimed/),
  );
  assert.equal(sim.issues[0]?.statusId, 1, 'nothing moved: the id was never guessed');
});

test('transition: an illegal transition throws BoardStateError and writes nothing', async () => {
  const sim = redmineSimulator([makeIssue(101, 'merged')]);
  const board = provider(sim);

  await assert.rejects(() => board.transition('101', 'claimed', { runId: RUN }), BoardStateError);
  assert.deepEqual(
    sim.requests.map((req) => req.method),
    ['GET'],
    'only the state read is allowed before the pure table rejects the move',
  );
});

test('transition: a failed write is a classified BoardError, never a silent success', async () => {
  const sim = redmineSimulator([makeIssue(101, 'claimed')]);
  sim.failNext(500);
  await assert.rejects(
    () => provider(sim).transition('101', 'pr_open', { runId: RUN }),
    boardError('transport'),
  );
});

// --- comments ---------------------------------------------------------------

test('comments: one journal per run, the marker last, edited in place', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  const board = provider(sim);
  const marker = runMarker(RUN);
  assert.equal(marker, `<!-- takumi:run=${RUN} -->`);

  const ref = await board.comment('101', 'plan ready', { runId: RUN });
  assert.deepEqual(
    sim.requests.map((req) => `${req.method} ${req.url}`),
    [
      `GET ${BASE}/issues/101.json?include=journals,allowed_statuses`,
      `PUT ${BASE}/issues/101.json`,
      `GET ${BASE}/issues/101.json?include=journals,allowed_statuses`,
    ],
    'a created journal is READ BACK, because Redmine answers a write with 204 and no id',
  );
  assert.deepEqual(sim.journalNotes(101), [`plan ready\n\n${marker}`], 'the marker is the LAST line');
  const journalId = String(sim.issues[0]?.journals[0]?.id ?? '');
  assert.equal(ref.item, '101');
  assert.equal(ref.runId, RUN);
  assert.equal(ref.comment, journalId);
  assert.equal(ref.url, `${BASE}/issues/101`);

  sim.clearRequests();
  const again = await board.comment('101', 'tests passed', { runId: RUN });
  assert.equal(again.comment, ref.comment, 'editableComment=true returns the SAME ref for the same runId');
  assert.equal(sim.issues[0]?.journals.length, 1, 'one progress comment per run');
  const edit = sim.requests.find((req) => req.method === 'PUT');
  assert.ok(edit);
  assert.equal(edit.url, `${BASE}/journals/${journalId}.json`);
  assert.deepEqual(edit.body, { journal: { notes: `tests passed\n\n${marker}` } });
  assert.deepEqual(sim.journalNotes(101), [`tests passed\n\n${marker}`]);

  const other = await board.comment('101', 'another run', { runId: 'deadbeef' });
  assert.notEqual(other.comment, ref.comment);
  assert.equal(sim.issues[0]?.journals.length, 2, 'a different run gets its own journal');
});

test('comments: updateComment edits the journal, re-appends the marker, and 404s loudly', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  const board = provider(sim);
  const ref = await board.comment('101', 'plan ready', { runId: RUN });

  sim.clearRequests();
  await board.updateComment(ref, 'progress v3');
  const put = sim.requests[0];
  assert.ok(put);
  assert.equal(put.method, 'PUT');
  assert.equal(put.url, `${BASE}/journals/${ref.comment}.json`);
  assert.deepEqual(put.body, { journal: { notes: `progress v3\n\n${runMarker(RUN)}` } });

  // A foreign or deleted journal must fail loudly, never look like progress.
  await assert.rejects(
    () => board.updateComment({ ...ref, comment: 'takumi-no-such-comment' }, 'x'),
    boardError('not_found'),
  );
  const missing = sim.requests[sim.requests.length - 1];
  assert.ok(missing);
  assert.equal(missing.url, `${BASE}/journals/takumi-no-such-comment.json`);
});

test('comments: trustedAuthors stops a stranger journal from being adopted or overwritten', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  const strangerId = sim.appendJournal(101, `injected\n\n${runMarker(RUN)}`, 'stranger');
  const board = provider(sim, { trustedAuthors: [BOT] });

  const ref = await board.comment('101', 'real progress', { runId: RUN });
  assert.notEqual(ref.comment, String(strangerId), 'the stranger journal is not takumi progress');
  assert.equal(sim.issues[0]?.journals.length, 2);
  assert.match(String(sim.journalNotes(101)[0]), /^injected/, "the stranger's text is untouched");
  assert.equal(sim.journalNotes(101)[1], `real progress\n\n${runMarker(RUN)}`);

  // Without an allowlist the marker is matched on ANY journal (documented, and
  // authorised by the API key on the write, so at worst it fails with `auth`).
  const openBoard = provider(sim);
  const adopted = await openBoard.comment('101', 'no allowlist', { runId: RUN });
  assert.equal(adopted.comment, String(strangerId));
});

// --- the versioned state record ---------------------------------------------

test('state record: written into the custom field, read back, and corrupt blocks stay loud', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready'), makeIssue(102, 'ready')]);
  const board = provider(sim);

  assert.equal(await board.readState('101'), null, 'no record yet is a normal state, not a failure');

  const record = stateRecord({ baseBranch: 'main', deliveryRef: '#1' });
  await board.writeState('101', record);
  const put = sim.requests.find((req) => req.method === 'PUT');
  assert.ok(put);
  assert.deepEqual(put.body, {
    issue: { custom_fields: [{ id: STATE_FIELD_ID, value: renderBoardStateRecord(record) }] },
  });
  assert.deepEqual(await board.readState('101'), record, 'the SAME versioned grammar round-trips');

  await assert.rejects(
    () => board.writeState('102', stateRecord({ item: '999' })),
    boardError('precondition', /state record names item 999 but was written to 102/),
  );

  // A present-but-corrupt block must look corrupted, never like a fresh run.
  const issue = sim.issues[0];
  assert.ok(issue);
  issue.customFields[0]!.value = '<!-- takumi:boardstate:v1 {oops} -->';
  await assert.rejects(() => board.readState('101'), /not valid JSON/);
});

test('state record: a stranger journal carrying a block cannot forge the state', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  const board = provider(sim, { trustedAuthors: [BOT] });
  const record = stateRecord();
  await board.writeState('101', record);

  // Public text says otherwise — a commenter pastes a whole hostile record.
  sim.appendJournal(101, renderBoardStateRecord({ ...record, runId: 'deadbeef' }), 'stranger');
  const read = await board.readState('101');
  assert.equal(read?.runId, RUN, 'journal text never drives control flow: the record is addressed by FIELD');
});

test('state record: with only a NAME configured the id comes from the issue itself', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready'), makeIssue(102, 'ready', { customFields: [] })]);
  const board = createRedmineBoardProvider({
    baseUrl: BASE,
    project: 'acme',
    request: sim.request,
    stateFieldName: 'takumi state',
  });
  const record = stateRecord();

  await board.writeState('101', record);
  const put = sim.requests.find((req) => req.method === 'PUT');
  assert.ok(put);
  assert.deepEqual(put.body, {
    issue: { custom_fields: [{ id: STATE_FIELD_ID, value: renderBoardStateRecord(record) }] },
  });
  assert.deepEqual(await board.readState('101'), record, 'the name is matched case-insensitively');

  await assert.rejects(
    () => board.writeState('102', stateRecord({ item: '102' })),
    boardError('precondition', /does not carry a custom field named "takumi state"/),
  );
});

test('fail closed: with no state field configured the gated ops never reach the network', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  const board = createRedmineBoardProvider({ baseUrl: BASE, project: 'acme', request: sim.request });

  assert.equal(board.capabilities().machineReadableState, false);
  await assert.rejects(() => board.readState('101'), boardError('unsupported', /machineReadableState/));
  await assert.rejects(() => board.writeState('101', stateRecord()), boardError('unsupported', /machineReadableState/));
  await assert.rejects(() => board.claim('101', RUN), boardError('unsupported', /machineReadableState/));
  assert.equal(sim.requests.length, 0, 'the capability gate refused BEFORE any request was made');

  // The delivery state is still fully usable without a record: only the record is gated.
  await board.transition('101', 'claimed', { runId: RUN });
  assert.equal(sim.issues[0]?.statusId, statusIdByName('claimed'));
  assert.deepEqual(
    sim.requests.map((req) => `${req.method} ${req.url}`),
    [`GET ${BASE}/issues/101.json?include=journals,allowed_statuses`, `GET ${BASE}/issue_statuses.json`, `PUT ${BASE}/issues/101.json`],
  );
  const put = sim.requests[2];
  assert.ok(put);
  assert.deepEqual(put.body, { issue: { status_id: 2 } }, 'no record merge when there is no field to merge into');
});

// --- errors, credentials, options, transport --------------------------------

test('errors: HTTP statuses map onto the shared taxonomy', async () => {
  const statuses: Array<[number, string]> = [
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not_found'],
    [400, 'precondition'],
    [422, 'precondition'],
    [429, 'transport'],
    [500, 'transport'],
  ];
  for (const [status, kind] of statuses) {
    const board = new RedmineBoardProvider({
      baseUrl: BASE,
      request: async () => ({ status, body: JSON.stringify({ error: 'forced' }) }),
    });
    await assert.rejects(
      () => board.getWork('101'),
      boardError(kind),
      `HTTP ${status} must map to ${kind}`,
    );
  }
});

test('fail closed without credentials: an unconfigured adapter never calls out', async () => {
  const previous = process.env['REDMINE_API_KEY'];
  delete process.env['REDMINE_API_KEY'];
  try {
    const board = createRedmineBoardProvider({ baseUrl: BASE, project: 'acme' });
    await assert.rejects(() => board.getWork('101'), boardError('auth', /no request transport configured/));
  } finally {
    if (previous !== undefined) process.env['REDMINE_API_KEY'] = previous;
  }
});

test('options: a malformed baseUrl or pageSize is rejected at construction', () => {
  const request: BoardRequestFn = async () => ({ status: 200, body: '{}' });
  assert.throws(() => new RedmineBoardProvider({ baseUrl: 'not a url', request }), /baseUrl/);
  assert.throws(() => new RedmineBoardProvider({ baseUrl: 'ftp://redmine.example.com', request }), /http or https/);
  assert.throws(() => new RedmineBoardProvider({ baseUrl: BASE, request, pageSize: 0 }), /pageSize/);

  // A sub-path install is a normal Redmine deployment, so it is accepted.
  const board = new RedmineBoardProvider({ baseUrl: `${BASE}/redmine/`, request });
  assert.equal(board.metadata().id, 'redmine');
});

test('transport: the API key travels as X-Redmine-API-Key (curl stub, no network)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-redmine-curl-'));
  const stub = join(dir, 'curl');
  const captured = join(dir, 'stdin.txt');
  writeFileSync(stub, `#!/bin/sh\ncat > ${captured}\nprintf '\\n200'\n`);
  chmodSync(stub, 0o755);
  try {
    const request = createRedmineTransport({ apiKey: 'sekrit-key', curl: { curlBinary: stub } });
    const response = await request({ method: 'GET', url: `${BASE}/issues.json` });
    assert.equal(response.status, 200);

    const config = readFileSync(captured, 'utf8');
    assert.match(config, /header = "X-Redmine-API-Key: sekrit-key"/);
    assert.match(config, /header = "Accept: application\/json"/);
    assert.match(config, /url = "https:\/\/redmine\.example\.com\/issues\.json"/);
    assert.match(config, /request = "GET"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- createWork: filing a failure as work, once ------------------------------

test('createWork: files in the mapped status, and the same key never files twice', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  const board = provider(sim);

  const first = await board.createWork({
    title: 'CI is red on main',
    body: 'the build failed before this run started',
    idempotencyKey: 'ci-red:101:7',
  });
  assert.equal(first.created, true);
  assert.equal(first.item.state, 'ready');
  assert.equal(first.item.title, 'CI is red on main');

  const create = sim.requests.find((r) => r.method === 'POST' && r.url.endsWith('/issues.json'));
  const fields = (create?.body as { issue?: Record<string, unknown> } | undefined)?.issue ?? {};
  assert.equal(fields['status_id'], statusIdByName('ready'), 'the created issue starts in the status the state maps to');
  assert.match(String(fields['description']), /<!-- takumi:created=ci-red:101:7 -->/);

  // The retry: the search finds it, the description check confirms it, nothing is filed.
  const second = await board.createWork({ title: 'CI is red on main', idempotencyKey: 'ci-red:101:7' });
  assert.equal(second.created, false);
  assert.equal(second.item.id, first.item.id);
  assert.equal(
    sim.requests.filter((r) => r.method === 'POST' && r.url.endsWith('/issues.json')).length,
    1,
    'exactly one create ever reached the instance',
  );
  assert.equal(sim.requests.some((r) => r.url.includes('/search.json')), true, 'the search is what dedupes');
});

test('createWork: a state whose status this instance lacks fails instead of filing in the wrong one', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  const strict = provider(sim, { statusMap: { ready: 'No Such Status' } });
  await assert.rejects(
    () => strict.createWork({ title: 'unmapped' }),
    (e: unknown) => {
      assert.ok(e instanceof BoardError);
      assert.equal(e.kind, 'unsupported');
      assert.match(e.message, /No Such Status/);
      return true;
    },
  );
  assert.equal(sim.requests.some((r) => r.method === 'POST'), false, 'nothing was filed');
});

test('createWork: labels are refused, not silently dropped', async () => {
  const sim = redmineSimulator([makeIssue(101, 'ready')]);
  const board = provider(sim);
  await assert.rejects(
    () => board.createWork({ title: 'labelled', labels: ['urgent'] }),
    (e: unknown) => {
      assert.ok(e instanceof BoardError);
      assert.equal(e.kind, 'unsupported');
      assert.match(e.message, /no labels/);
      return true;
    },
  );
  assert.equal(sim.requests.some((r) => r.method === 'POST'), false, 'a refused create must not reach the instance');
});
