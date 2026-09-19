import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BoardError,
  BoardStateError,
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
import { adfToText, createJiraBoardProvider, JIRA_STATE_PROPERTY, JiraBoardProvider, runMarker, textToAdf } from '../index.js';

/**
 * An in-memory Jira: no network, no token. It answers exactly the endpoints the
 * adapter is allowed to use, stores the run record as an ISSUE PROPERTY (so the
 * tests prove the property path, not a comment hack), and records every request.
 */

interface SimIssue {
  key: string;
  summary: string;
  description: unknown;
  status: string;
  labels: string[];
  assignee: { displayName: string } | null;
  updated: string;
}

interface SimComment {
  id: string;
  body: unknown;
  author: { accountId: string; displayName: string };
}

const BASE = 'https://acme.atlassian.net';

/**
 * The statuses the seeded project's workflow offers.
 *
 * `GET /rest/api/3/project/<key>/statuses` is the ONE place an adapter can read
 * them from: a status that is not in this list is one nobody added to the project's
 * workflow, which is exactly what `bootstrapStates()` has to report.
 */
const DEFAULT_PROJECT_STATUSES: readonly string[] = [
  'ready',
  'claimed',
  'pr_open',
  'fix_needed',
  'merged',
  'blocked',
];

function makeIssue(key: string, status: string, extra: Partial<SimIssue> = {}): SimIssue {
  return {
    key,
    summary: `Issue ${key}`,
    description: textToAdf('please do the thing'),
    status,
    labels: [],
    assignee: null,
    updated: '2026-09-15T00:00:00.000Z',
    ...extra,
  };
}

/** The Jira read shape: every field lives under `fields`. */
function toJiraShape(issue: SimIssue) {
  return {
    key: issue.key,
    fields: {
      summary: issue.summary,
      description: issue.description,
      status: { name: issue.status },
      labels: issue.labels,
      assignee: issue.assignee,
      updated: issue.updated,
    },
  };
}

function jiraSimulator(seedIssues: SimIssue[], options: { projectStatuses?: readonly string[] } = {}) {
  const issues = seedIssues;
  const projectStatuses = options.projectStatuses ?? DEFAULT_PROJECT_STATUSES;
  const comments: SimComment[] = [];
  const properties = new Map<string, string>();
  const requests: BoardHttpRequest[] = [];
  let commentSeq = 100;

  const json = (payload: unknown, status = 200): BoardHttpResponse => ({ status, body: JSON.stringify(payload) });
  const notFound = () => json({ errorMessages: ['Issue does not exist or you do not have permission to see it.'] }, 404);

  const request: BoardRequestFn = async (req) => {
    requests.push(req);
    const url = new URL(req.url);
    const path = url.pathname;
    const body = (req.body ?? {}) as Record<string, unknown>;

    if (req.method === 'GET' && path === '/rest/api/3/myself') return json({ accountId: 'acc-bot', displayName: 'Takumi Bot' });

    // What a Jira project's workflow offers, per ISSUE TYPE — the documented shape
    // of `GET /rest/api/3/project/<key>/statuses`, and the only way an adapter can
    // learn which statuses exist without guessing.
    const projectStatusesMatch = /^\/rest\/api\/3\/project\/([^/]+)\/statuses$/.exec(path);
    if (req.method === 'GET' && projectStatusesMatch) {
      return json([
        {
          id: '10001',
          name: 'Task',
          statuses: projectStatuses.map((name, index) => ({ id: String(2000 + index), name })),
        },
      ]);
    }

    if (req.method === 'POST' && path === '/rest/api/3/search') {
      const jql = String(body['jql'] ?? '');
      const wanted = /status in \(([^)]*)\)/.exec(jql)?.[1];
      const names = wanted === undefined ? undefined : wanted.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
      return json({ issues: issues.filter((i) => names === undefined || names.includes(i.status)).map(toJiraShape) });
    }
    const issueMatch = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && issueMatch) {
      const found = issues.find((i) => i.key === issueMatch[1]);
      return found
        ? json({
            key: found.key,
            fields: {
              summary: found.summary,
              description: found.description,
              status: { name: found.status },
              labels: found.labels,
              assignee: found.assignee,
              updated: found.updated,
            },
          })
        : notFound();
    }
    const transitionMatch = /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/.exec(path);
    if (transitionMatch) {
      const found = issues.find((i) => i.key === transitionMatch[1]);
      if (!found) return notFound();
      if (req.method === 'GET') {
        return json({
          transitions: ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked']
            .filter((status) => status !== found.status)
            .map((status) => ({ id: `t-${status}`, name: `to ${status}`, to: { name: status } })),
        });
      }
      const id = (body['transition'] as { id?: string } | undefined)?.id ?? '';
      const target = id.replace(/^t-/, '');
      if (!['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked'].includes(target)) {
        return json({ errorMessages: ['Transition id is not valid'] }, 400);
      }
      found.status = target;
      return json({}, 204);
    }
    const commentsMatch = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(path);
    if (commentsMatch) {
      const found = issues.find((i) => i.key === commentsMatch[1]);
      if (!found) return notFound();
      if (req.method === 'GET') return json({ comments });
      commentSeq += 1;
      const created: SimComment = {
        id: String(commentSeq),
        body: body['body'],
        author: { accountId: 'acc-bot', displayName: 'Takumi Bot' },
      };
      comments.push(created);
      return json(created, 201);
    }
    const commentMatch = /^\/rest\/api\/3\/issue\/([^/]+)\/comment\/(\d+)$/.exec(path);
    if (req.method === 'PUT' && commentMatch) {
      const found = comments.find((c) => c.id === commentMatch[2]);
      if (!found) return notFound();
      found.body = body['body'];
      return json(found);
    }
    const propertyMatch = /^\/rest\/api\/3\/issue\/([^/]+)\/properties\/([^/]+)$/.exec(path);
    if (propertyMatch) {
      const id = propertyMatch[1] as string;
      const found = issues.find((i) => i.key === id);
      if (!found) return notFound();
      const key = `${id}/${propertyMatch[2]}`;
      if (req.method === 'GET') {
        const stored = properties.get(key);
        return stored === undefined ? json({ errorMessages: ['Property does not exist'] }, 404) : json({ key: propertyMatch[2], value: JSON.parse(stored) });
      }
      properties.set(key, JSON.stringify(body));
      return json({}, 200);
    }
    return notFound();
  };

  return {
    request,
    requests,
    issues,
    comments,
    properties,
    /** Forget the recorded requests, so a test can assert one phase at a time. */
    clearRequests(): void {
      requests.length = 0;
    },
  };
}

function provider(sim: ReturnType<typeof jiraSimulator>, extra: Record<string, unknown> = {}) {
  return createJiraBoardProvider({ baseUrl: BASE, projectKey: 'ACME', request: sim.request, ...extra });
}

const RUN = 'c0ffee01';

test('JiraBoardProvider: shared task-board contract suite', async (t) => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  const out = await runTaskBoardProviderContractSuite(provider(sim), { id: 'jira', itemId: 'ACME-1' });
  assert.equal(out.gate, 'task-board-contract');
  // The suite's own verdict on the state-bootstrap port, printed as a diagnostic so
  // the evidence is in the run's output and not only in an assertion message.
  for (const note of out.notes.filter((n) => n.startsWith('bootstrapStates:'))) t.diagnostic(note);
  // Jira passes everything except the trust-boundary check: without a configured
  // author allowlist there is no trust signal to prove, so the suite reports the
  // round-trip as PARTIAL instead of pretending.
  assert.equal(out.result, 'PASS_WITH_NOT_RUN');
  assert.ok(out.notes.some((n) => n.includes('trustedAuthorFilter=false')), out.notes.join('\n'));
  assert.ok(out.notes.some((n) => n.startsWith('claim: PASS')));
  assert.ok(out.notes.some((n) => n.startsWith('terminal: PASS')));
  // The suite calls bootstrapStates itself now: Jira can express all six states
  // (the seeded project has the six workflow statuses), but it reports them rather
  // than creating them — canCreate=false, nothing created, nothing not-creatable.
  assert.ok(
    out.notes.some((n) => n.startsWith('bootstrapStates: PASS (canCreate=false created=0 exists=6 notCreatable=0')),
    out.notes.join('\n'),
  );
});

test('capabilities: no delivery side at all, and trust only when the caller declares it', () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  const caps = provider(sim).capabilities();
  assert.deepEqual(caps.delivery, { canOpenPullRequest: false, canRunChecks: false, canMerge: false });
  assert.equal(caps.trustedAuthorFilter, false, 'Jira exposes no per-comment role, so the default is honest');
  assert.equal(caps.machineReadableState, true);
  assert.equal(caps.atomicClaim, false);
  assert.equal(
    caps.canBootstrapStates,
    false,
    'a Jira status lives in a workflow and is created in administration, so this adapter only reports',
  );

  const withTrust = createJiraBoardProvider({
    baseUrl: BASE,
    request: sim.request,
    trustedAuthors: ['acc-maintainer'],
  }).capabilities();
  assert.equal(withTrust.trustedAuthorFilter, true);
});

test('bootstrapStates: a READ-ONLY report of the project workflow, with the exact fix named', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')], {
    projectStatuses: ['ready', 'claimed', 'pr_open', 'fix_needed', 'blocked'],
  });
  // `merged` is mapped to a status nobody added to this project's workflow: the
  // report has to say so, and name the status to add.
  const board = provider(sim, { statusMap: { merged: 'Shipped' } });
  const desired: BoardWorkItemState[] = ['ready', 'merged', 'claimed'];

  const report = await board.bootstrapStates(desired);
  // ONE request, and it is a read of the project's own status list.
  assert.deepEqual(
    sim.requests.map((req) => `${req.method} ${req.url}`),
    [`GET ${BASE}/rest/api/3/project/ACME/statuses`],
  );
  assert.equal(report.provider, 'jira');
  assert.equal(report.applied, false, 'the adapter cannot create a Jira status, so it never changed anything');
  assert.deepEqual(report.unsupported, [], 'the adapter declares all six states, so none is out of reach');
  assert.deepEqual(
    report.actions.map((action) => [action.state, action.name, action.outcome]),
    [
      ['ready', 'ready', 'exists'],
      ['merged', 'Shipped', 'not-creatable'],
      ['claimed', 'claimed', 'exists'],
    ],
    "the name comes from the adapter's OWN statusMap, and the comparison is case-insensitive",
  );
  const missing = report.actions[1];
  assert.match(missing?.instruction ?? '', /no status named "Shipped" in project ACME/);
  assert.match(missing?.instruction ?? '', /statusMap/);
  assert.match(missing?.instruction ?? '', /administration/);

  // A dry run is the same read (a report cannot change a workflow), so it reports
  // exactly the same facts and still writes nothing.
  sim.clearRequests();
  const dry = await board.bootstrapStates(desired, { dryRun: true });
  assert.deepEqual(dry, report, 'a read-only report cannot differ between a dry run and a real one');
  assert.deepEqual(sim.requests.map((req) => req.method), ['GET'], 'a dry run is one read and no write');

  // Idempotent by construction: the second call re-reads and reports the same.
  sim.clearRequests();
  const again = await board.bootstrapStates(desired);
  assert.deepEqual(again, report);
  assert.equal(again.applied, false, 'a second call changes nothing');
  assert.ok(
    !again.actions.some((action) => action.outcome === 'created' || action.outcome === 'would-create'),
    'canBootstrapStates=false: nothing may ever be created or promised, not even on a dry run',
  );
});

test('bootstrapStates: with no project configured every state is a reported configuration gap', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  const board = new JiraBoardProvider({ baseUrl: BASE, request: sim.request });

  const report = await board.bootstrapStates(['merged']);
  assert.equal(report.provider, 'jira');
  assert.equal(report.applied, false);
  assert.equal(report.actions.length, 1, 'exactly one action per desired state');
  assert.equal(report.actions[0]?.state, 'merged');
  assert.equal(report.actions[0]?.name, 'merged');
  assert.equal(report.actions[0]?.outcome, 'not-creatable');
  assert.match(report.actions[0]?.instruction ?? '', /no Jira project is configured/);
  assert.match(report.actions[0]?.instruction ?? '', /projectKey/);
  assert.equal(sim.requests.length, 0, 'with no project there is nothing to read, so no request is made');
});

test('request shapes: search is JQL-scoped to the mapped status, transitions are resolved by name', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready'), makeIssue('ACME-2', 'claimed')]);
  const board = provider(sim);

  const ready = await board.listWork();
  const search = sim.requests[0];
  assert.equal(search?.method, 'POST');
  assert.equal(search?.url, `${BASE}/rest/api/3/search`);
  assert.deepEqual(search?.body, {
    jql: 'project = ACME AND statusCategory != Done ORDER BY created ASC AND status in ("ready")',
    fields: ['summary', 'description', 'status', 'labels', 'assignee', 'updated'],
    maxResults: 100,
  });
  assert.deepEqual(ready.map((i) => i.id), ['ACME-1']);
  assert.equal(ready[0]?.state, 'ready');
  assert.equal(ready[0]?.body, 'please do the thing');

  const claimed = await board.listWork({ states: ['claimed'] });
  assert.deepEqual(claimed.map((i) => i.id), ['ACME-2']);

  const transitions = await board.getWork('ACME-1');
  assert.equal(transitions.url, `${BASE}/browse/ACME-1`);
});

test('claim: resolves a real transition id, writes the ISSUE PROPERTY, verifies the re-read', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  const board = provider(sim);
  const result = await board.claim('ACME-1', RUN);
  assert.deepEqual(result, { item: 'ACME-1', runId: RUN, claimed: true });
  assert.equal(sim.issues[0]?.status, 'claimed', 'the workflow status is the column');

  const transitionPost = sim.requests.find((r) => r.method === 'POST' && String(r.url).endsWith('/transitions'));
  assert.deepEqual(transitionPost?.body, { transition: { id: 't-claimed' } });

  const propertyPut = sim.requests.find((r) => r.method === 'PUT' && String(r.url).includes('/properties/'));
  assert.match(String(propertyPut?.url), new RegExp(`/properties/${JIRA_STATE_PROPERTY}$`));
  const stored = sim.properties.get(`ACME-1/${JIRA_STATE_PROPERTY}`) ?? '';
  assert.match(stored, /takumi:boardstate:v1/);

  const record = (await board.readState('ACME-1')) as BoardStateRecord;
  assert.equal(record.runId, RUN);
  assert.equal(record.schema, 1);
});

test('claim: a second run is refused, and a non-ready issue is refused', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready'), makeIssue('ACME-2', 'blocked')]);
  const board = provider(sim);
  await board.claim('ACME-1', RUN);
  const second = await board.claim('ACME-1', 'deadbeef');
  assert.equal(second.claimed, false);
  assert.match(second.reason ?? '', /already claimed by c0ffee01/);

  const blocked = await board.claim('ACME-2', RUN);
  assert.equal(blocked.claimed, false);
  assert.match(blocked.reason ?? '', /item is in state blocked, not ready/);
});

test('transition: an illegal transition throws BoardStateError and writes nothing', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'merged')]);
  const board = provider(sim);
  await assert.rejects(() => board.transition('ACME-1', 'claimed', { runId: RUN }), BoardStateError);
  assert.deepEqual(sim.requests.map((r) => r.method), ['GET'], 'only the state read is allowed');
});

test('transition: a status with no workflow transition is unsupported, never guessed', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  // A caller-mapped status that this workflow simply does not have.
  const board = provider(sim, { statusMap: { ready: 'ready', claimed: 'Doing Something Nobody Defined' } });
  await assert.rejects(
    () => board.claim('ACME-1', RUN),
    (e: unknown) => e instanceof BoardError && e.kind === 'unsupported' && /no transition to status/.test(e.message),
  );
  assert.equal(sim.issues[0]?.status, 'ready', 'nothing moved');
});

test('comments: ADF body with the run marker, one comment per run, edited in place', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  const board = provider(sim);
  const first = await board.comment('ACME-1', 'plan ready', { runId: RUN });
  assert.equal(adfToText(sim.comments[0]?.body), `plan ready\n\n${runMarker(RUN)}`);
  const second = await board.comment('ACME-1', 'tests passed', { runId: RUN });
  assert.equal(second.comment, first.comment, 'one progress comment per run');
  assert.equal(sim.comments.length, 1);
  assert.match(adfToText(sim.comments[0]?.body), /^tests passed/);

  const other = await board.comment('ACME-1', 'another run', { runId: 'deadbeef' });
  assert.notEqual(other.comment, first.comment);
  assert.equal(sim.comments.length, 2);
});

test('comments: patching an unknown comment fails loudly', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  const board = provider(sim);
  const ref = await board.comment('ACME-1', 'x', { runId: RUN });
  await assert.rejects(
    () => board.updateComment({ ...ref, comment: '999999' }, 'nope'),
    (e: unknown) => e instanceof BoardError && e.kind === 'not_found',
  );
});

test('state record: absent property is null; a corrupt block throws instead of looking fresh', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  const board = provider(sim);
  assert.equal(await board.readState('ACME-1'), null);
  sim.properties.set(`ACME-1/${JIRA_STATE_PROPERTY}`, JSON.stringify({ block: '<!-- takumi:boardstate:v1 {oops} -->' }));
  await assert.rejects(() => board.readState('ACME-1'), /not valid JSON|corrupt/i);
});

test('getWork: an unmapped status is a precondition error, never a guessed state', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'Waiting for Triage')]);
  await assert.rejects(
    () => provider(sim).getWork('ACME-1'),
    (e: unknown) => e instanceof BoardError && e.kind === 'precondition' && /does not map/.test(e.message),
  );
});

test('errors: HTTP statuses map onto the taxonomy', async () => {
  const statuses: Array<[number, BoardError['kind']]> = [
    [401, 'auth'],
    [404, 'not_found'],
    [400, 'precondition'],
    [500, 'transport'],
  ];
  for (const [status, kind] of statuses) {
    const board = new JiraBoardProvider({ baseUrl: BASE, request: async () => ({ status, body: '{}' }) });
    await assert.rejects(
      () => board.getWork('ACME-1'),
      (e: unknown) => e instanceof BoardError && e.kind === kind,
      `HTTP ${status} must map to ${kind}`,
    );
  }
});

test('fail closed without credentials: an unauthenticated adapter never calls out', async () => {
  const previousToken = process.env['JIRA_TOKEN'];
  const previousApi = process.env['JIRA_API_TOKEN'];
  delete process.env['JIRA_TOKEN'];
  delete process.env['JIRA_API_TOKEN'];
  try {
    const board = createJiraBoardProvider({ baseUrl: BASE, projectKey: 'ACME' });
    await assert.rejects(
      () => board.getWork('ACME-1'),
      (e: unknown) => e instanceof BoardError && e.kind === 'auth',
    );
  } finally {
    if (previousToken !== undefined) process.env['JIRA_TOKEN'] = previousToken;
    if (previousApi !== undefined) process.env['JIRA_API_TOKEN'] = previousApi;
  }
});

test('ADF helpers: text round-trips through paragraphs, block nodes keep their line breaks', () => {
  assert.equal(adfToText(textToAdf('a\nb\n\nc')), 'a\nb\n\nc');
  assert.equal(adfToText('a plain legacy string'), 'a plain legacy string');
  assert.equal(adfToText(null), '');
  const doc = textToAdf('one line') as { content?: Array<{ type?: string }> };
  assert.equal(doc.content?.[0]?.type, 'paragraph');
});

test('options: a malformed baseUrl is rejected at construction', () => {
  assert.throws(() => new JiraBoardProvider({ baseUrl: 'not a url', request: async () => ({ status: 200, body: '{}' }) }), /baseUrl/);
});
