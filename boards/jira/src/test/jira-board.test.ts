import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BoardError,
  BoardStateError,
  createKeyOf,
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

function jiraSimulator(
  seedIssues: SimIssue[],
  options: { projectStatuses?: readonly string[]; createInitialStatus?: string } = {},
) {
  const issues = seedIssues;
  const projectStatuses = options.projectStatuses ?? DEFAULT_PROJECT_STATUSES;
  /**
   * The status a NEW issue starts in. It is the WORKFLOW's decision in Jira, not the
   * caller's, which is exactly why `createWork` reads the created issue back; the
   * default here is a project whose workflow happens to start at `ready`.
   */
  const createInitialStatus = options.createInitialStatus ?? 'ready';
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
      // `text ~ "<term>"` is Jira's own text search: it matches the issue's TEXT
      // (summary + description), which is what a `query` scope means. The double
      // applies BOTH clauses the way Jira would, so a search that only worked
      // because the state filter happened to be absent could not pass here.
      const term = /text ~ "([^"]*)"/.exec(jql)?.[1];
      return json({
        issues: issues
          .filter((i) => names === undefined || names.includes(i.status))
          // Jira's full-text search is case-insensitive; a case-sensitive double made
          // the search look broken for a term that only appeared capitalised.
          .filter(
            (i) =>
              term === undefined ||
              `${i.summary}\n${adfToText(i.description)}`.toLowerCase().includes(term.toLowerCase()),
          )
          .map(toJiraShape),
      });
    }

    // The create's dedupe search: `GET /rest/api/3/search?jql=... text ~ "<key>"`. Jira's
    // `text ~` matches the issue's TEXT (summary and description), which is where the
    // create marker is written — the double matches the same way rather than on the key
    // alone, so it cannot pass for a search that would not really find the item.
    if (req.method === 'GET' && path === '/rest/api/3/search') {
      const jql = url.searchParams.get('jql') ?? '';
      const term = /text ~ "(.*)"/.exec(jql)?.[1] ?? '\u0000';
      return json({
        issues: issues
          .filter((issue) => `${issue.summary}\n${adfToText(issue.description)}`.includes(term))
          .map(toJiraShape),
      });
    }

    // What `POST /rest/api/3/issue` answers. The documented create body carries the
    // project, the summary, an ADF description and the ISSUE TYPE — Jira rejects a
    // create without the type, which is why the adapter refuses before sending one.
    if (req.method === 'POST' && path === '/rest/api/3/issue') {
      const fields = (body['fields'] ?? {}) as Record<string, unknown>;
      const project = (fields['project'] ?? {}) as { key?: string };
      const issuetype = (fields['issuetype'] ?? {}) as { name?: string };
      if (project.key === undefined || issuetype.name === undefined) {
        return json({ errorMessages: ['issuetype is required'] }, 400);
      }
      const number =
        issues.reduce((max, issue) => Math.max(max, Number(issue.key.replace(/^\D+/, '')) || 0), 0) + 1;
      const created = makeIssue(`${project.key}-${number}`, createInitialStatus, {
        summary: String(fields['summary'] ?? ''),
        description: fields['description'],
        labels: Array.isArray(fields['labels']) ? (fields['labels'] as string[]) : [],
      });
      issues.push(created);
      // Jira Cloud answers a create with the new issue's IDENTITY only: the status the
      // workflow gave it is not in this payload, so the adapter has to read it back.
      return json({ id: String(10_000 + number), key: created.key, self: `${BASE}/rest/api/3/issue/${String(10_000 + number)}` }, 201);
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
  // The suite files an item itself now, so the adapter needs the one thing it refuses
  // to guess: the issue type this project's issues are created as.
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  const out = await runTaskBoardProviderContractSuite(provider(sim, { issueType: 'Task' }), {
    id: 'jira',
    itemId: 'ACME-1',
  });
  assert.equal(out.gate, 'task-board-contract');
  // The suite's own verdict on the state-bootstrap and create ports, printed as a
  // diagnostic so the evidence is in the run's output and not only in an assertion.
  for (const note of out.notes.filter((n) => n.startsWith('bootstrapStates:') || n.startsWith('createWork:'))) {
    t.diagnostic(note);
  }
  // Jira passes everything except the trust-boundary check: without a configured
  // author allowlist there is no trust signal to prove, so the suite reports the
  // round-trip as PARTIAL instead of pretending.
  assert.equal(out.result, 'PASS_WITH_NOT_RUN');
  assert.ok(out.notes.some((n) => n.includes('trustedAuthorFilter=false')), out.notes.join('\n'));
  assert.ok(out.notes.some((n) => n.startsWith('claim: PASS')));
  assert.ok(out.notes.some((n) => n.startsWith('terminal: PASS')));
  // Filing: the created item appeared once among the ready work and was claimable, and
  // the suite's second create with the same key found the first instead of filing again.
  assert.ok(
    out.notes.some((n) => n.startsWith('createWork: PASS (idempotent on the key, claimable,')),
    out.notes.join('\n'),
  );
  // The suite calls bootstrapStates itself now: Jira can express all six states
  // (the seeded project has the six workflow statuses), but it reports them rather
  // than creating them — canCreate=false, nothing created, nothing not-creatable.
  assert.ok(
    out.notes.some((n) => n.startsWith('bootstrapStates: PASS (canCreate=false created=0 exists=6 notCreatable=0')),
    out.notes.join('\n'),
  );
  // The suite drives the free-text scope itself now: it files a probe item whose text
  // carries a distinctive word, requires the adapter to FIND it with `query`, and requires
  // it to return nothing for a word nothing carries. Both halves can only pass if the term
  // really reached Jira's own search — an adapter that ignored it would have returned the
  // probe for BOTH queries, and one that searched everything would have done the same.
  assert.ok(out.notes.some((n) => n.includes('canTextSearch=true')), out.notes.join('\n'));
  assert.ok(
    out.notes.some((n) => n.startsWith('query: PASS (1 hit(s), no false positive)')),
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
  assert.equal(caps.canCreateWork, true, 'POST /rest/api/3/issue files an issue, so filing is declared');
  assert.equal(caps.canTextSearch, true, 'the search takes one JQL, so a free-text scope rides in it');

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

// --- createWork --------------------------------------------------------------

test('createWork: files an ADF issue in the requested state, marker in the description', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  const board = provider(sim, { issueType: 'Task' });

  const first = await board.createWork({
    title: 'CI is red on main',
    body: 'the pipeline failed before this run started',
    labels: ['ci'],
    idempotencyKey: 'ci-red:acme:main',
  });
  assert.equal(first.created, true);
  assert.equal(first.item.id, 'ACME-2');
  assert.equal(first.item.state, 'ready', 'the created item starts in the requested state');
  assert.equal(first.item.title, 'CI is red on main');
  // The adapter's OWN description reader finds the marker again: that is what makes the
  // item adoptable by a later tick.
  assert.equal(createKeyOf(first.item.body), 'ci-red:acme:main');
  assert.equal(
    first.item.body,
    'the pipeline failed before this run started\n\n<!-- takumi:created=ci-red:acme:main -->',
  );

  // Search first (nothing filed yet), then the project's own workflow, then the create,
  // then the read-back that reveals the status the workflow gave the new issue.
  assert.deepEqual(
    sim.requests.map((req) => `${req.method} ${new URL(req.url).pathname}`),
    [
      'GET /rest/api/3/search',
      'GET /rest/api/3/project/ACME/statuses',
      'POST /rest/api/3/issue',
      'GET /rest/api/3/issue/ACME-2',
    ],
  );
  const search = sim.requests[0];
  assert.equal(
    search?.url,
    `${BASE}/rest/api/3/search?jql=${encodeURIComponent('project = ACME AND text ~ "ci-red:acme:main"')}` +
      '&fields=summary,description&maxResults=50',
    'the dedupe search is Jira text search, scoped to the project',
  );

  const create = sim.requests.find((req) => req.method === 'POST' && req.url.endsWith('/rest/api/3/issue'));
  assert.deepEqual(create?.body, {
    fields: {
      project: { key: 'ACME' },
      summary: 'CI is red on main',
      // Jira Cloud v3 takes ADF, not a plain string: the marker is a text node.
      description: textToAdf('the pipeline failed before this run started\n\n<!-- takumi:created=ci-red:acme:main -->'),
      issuetype: { name: 'Task' },
      labels: ['ci'],
    },
  });
  const adf = (create?.body as { fields: { description: unknown } }).fields.description;
  assert.match(adfToText(adf), /<!-- takumi:created=ci-red:acme:main -->/);
});

test('createWork: a retried tick adopts the first item instead of filing a second', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  const board = provider(sim, { issueType: 'Task' });

  const first = await board.createWork({ title: 'flaky spec', idempotencyKey: 'flaky:spec:9' });
  sim.clearRequests();
  const second = await board.createWork({ title: 'flaky spec', idempotencyKey: 'flaky:spec:9' });

  assert.equal(second.created, false, 'the key was already on the board');
  assert.equal(second.item.id, first.item.id, 'the FIRST item comes back, not a new one');
  assert.deepEqual(
    sim.requests.map((req) => req.method),
    ['GET'],
    'the retry searches and files nothing: no second create reached the host',
  );
  assert.equal(sim.issues.length, 2, 'the seeded issue plus ONE filed, not two');
});

test('createWork: without a key the title never dedupes — the key is the guarantee', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  const board = provider(sim, { issueType: 'Task' });

  const first = await board.createWork({ title: 'same title' });
  const second = await board.createWork({ title: 'same title' });
  assert.equal(first.created, true);
  assert.equal(second.created, true);
  assert.notEqual(second.item.id, first.item.id);
  assert.ok(first.item.body === '', 'no key means no marker to find, and no invented one');
});

test('createWork: an item the workflow started elsewhere is moved to the requested state', async () => {
  // A project whose workflow starts new issues in `blocked`. The status a create lands
  // in is the WORKFLOW's decision, so the adapter reads it back and moves the item:
  // reporting that as `ready` would be the lie `statusMap` exists to prevent.
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')], { createInitialStatus: 'blocked' });
  const board = provider(sim, { issueType: 'Task' });

  const result = await board.createWork({ title: 'started somewhere else' });
  assert.equal(result.created, true);
  assert.equal(result.item.state, 'ready', 'the requested state is guaranteed, not assumed');
  const transition = sim.requests.find((req) => req.method === 'POST' && req.url.endsWith('/transitions'));
  assert.equal(transition?.url, `${BASE}/rest/api/3/issue/ACME-2/transitions`);
  assert.deepEqual(transition?.body, { transition: { id: 't-ready' } }, 'a REAL transition id, resolved by name');
  assert.equal(sim.issues[1]?.status, 'ready');
});

test('createWork: a missing issue type is refused, naming the option, before any request', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);

  await assert.rejects(
    () => provider(sim).createWork({ title: 'no issue type' }),
    (e: unknown) => e instanceof BoardError && e.kind === 'precondition' && /issueType/.test(e.message),
  );
  // A create also needs a project, and that is the option it names when it is missing.
  const noProject = new JiraBoardProvider({ baseUrl: BASE, request: sim.request, issueType: 'Task' });
  await assert.rejects(
    () => noProject.createWork({ title: 'no project' }),
    (e: unknown) => e instanceof BoardError && e.kind === 'precondition' && /projectKey/.test(e.message),
  );
  assert.equal(sim.requests.length, 0, 'a create this adapter cannot shape correctly is never sent to Jira');
});

test('createWork: an unmapped status is refused, so nothing is filed in a status nobody asked for', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')], { projectStatuses: ['claimed', 'merged'] });
  const board = provider(sim, { issueType: 'Task' });

  await assert.rejects(
    () => board.createWork({ title: 'nowhere to start' }),
    (e: unknown) =>
      e instanceof BoardError && e.kind === 'precondition' && /no workflow status named "ready"/.test(e.message),
  );
  assert.ok(
    sim.requests.every((req) => req.method === 'GET'),
    'the project workflow was read; no create was sent',
  );
  assert.equal(sim.issues.length, 1, 'nothing was filed');

  // An unmapped state NAMES the state, so the operator knows which mapping to fix.
  const mapped = provider(sim, { issueType: 'Task', statusMap: { ready: 'Nowhere' } });
  await assert.rejects(
    () => mapped.createWork({ title: 'still nowhere' }),
    (e: unknown) =>
      e instanceof BoardError &&
      e.kind === 'precondition' &&
      /state "ready"/.test(e.message) &&
      /"Nowhere"/.test(e.message),
  );
});

test('createWork: a malformed idempotency key fails as precondition, never an unfindable marker', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  await assert.rejects(
    () => provider(sim, { issueType: 'Task' }).createWork({ title: 'bad key', idempotencyKey: 'not a key!' }),
    (e: unknown) => e instanceof BoardError && e.kind === 'precondition' && /invalid idempotency key/.test(e.message),
  );
  assert.equal(sim.requests.length, 0, 'the key is validated before anything is sent');
});

test('request shapes: search is JQL-scoped to the mapped status, transitions are resolved by name', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready'), makeIssue('ACME-2', 'claimed')]);
  const board = provider(sim);

  const ready = await board.listWork();
  const search = sim.requests[0];
  assert.equal(search?.method, 'POST');
  assert.equal(search?.url, `${BASE}/rest/api/3/search`);
  // The state clause sits BEFORE `ORDER BY`, not after it: `ORDER BY` terminates a JQL
  // query, so a clause appended behind it is a syntax error that fails the whole search.
  assert.deepEqual(search?.body, {
    jql: 'project = ACME AND statusCategory != Done AND status in ("ready") ORDER BY created ASC',
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

// --- listWork: the free-text scope ------------------------------------------

test('listWork: a text scope is a `text ~` clause in the SAME JQL, and the board decides the hits', async () => {
  const sim = jiraSimulator([
    makeIssue('ACME-1', 'ready', { summary: 'Nebula rollout kickoff' }),
    makeIssue('ACME-2', 'ready', { description: textToAdf('please do the nebula thing') }),
    makeIssue('ACME-3', 'ready', { summary: 'unrelated work' }),
    makeIssue('ACME-4', 'claimed', { summary: 'Nebula rollout, continued' }),
  ]);
  const board = provider(sim);

  const items = await board.listWork({ states: ['ready'], query: 'nebula' });

  // The scope reaches the BOARD in the same JQL the state filter travels in — one
  // request, and the term is inside the literal, never a clause of its own.
  const search = sim.requests[0];
  assert.equal(sim.requests.length, 1, 'a scope must not cost a second round trip');
  assert.equal(search?.url, `${BASE}/rest/api/3/search`);
  assert.deepEqual(search?.body, {
    jql:
      'project = ACME AND statusCategory != Done AND status in ("ready") AND text ~ "nebula" ORDER BY created ASC',
    fields: ['summary', 'description', 'status', 'labels', 'assignee', 'updated'],
    maxResults: 100,
  });
  // Jira's text index covers the summary AND the description, so an item whose words
  // live in the body is found too — and the STATE filter still applies: ACME-4 carries
  // the term but is not ready, and ACME-3 is ready but carries nothing.
  assert.deepEqual(items.map((item) => item.id), ['ACME-1', 'ACME-2']);
  assert.deepEqual(items.map((item) => item.state), ['ready', 'ready']);
});

test('listWork: a term nothing carries returns nothing, not everything', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready'), makeIssue('ACME-2', 'claimed')]);
  const board = provider(sim);

  const items = await board.listWork({ states: ['ready'], query: 'takujiranothingcarriesthis' });

  assert.deepEqual(items, [], 'a term the board does not know means no work, never all work');
  assert.equal(sim.requests.length, 1, 'the search still reached the host');
  assert.match(
    String((sim.requests[0]?.body as { jql?: string }).jql),
    /text ~ "takujiranothingcarriesthis"/,
    'the miss is the host answering nothing, not this adapter dropping the term',
  );
});

test('listWork: a term that would break the JQL is refused before anything is sent', async () => {
  const sim = jiraSimulator([makeIssue('ACME-1', 'ready')]);
  const board = provider(sim);

  // A quote would end the literal and let the rest of the term become JQL of its own
  // (so a scope could widen what it was asked to narrow); a backslash is JQL's escape
  // character, whose meaning varies by version. Neither is guessed at: both are refused.
  for (const term of ['nebula" OR project = OTHER', 'back\\slash']) {
    await assert.rejects(
      () => board.listWork({ states: ['ready'], query: term }),
      (e: unknown) =>
        e instanceof BoardError &&
        e.kind === 'precondition' &&
        /must not contain a double quote or a backslash/.test(e.message),
      `term ${JSON.stringify(term)} must be refused, not escaped or dropped`,
    );
  }
  // An empty scope names nothing, so honouring it would search for EVERYTHING — the one
  // thing a scope must never do.
  await assert.rejects(
    () => board.listWork({ query: '   ' }),
    (e: unknown) => e instanceof BoardError && e.kind === 'precondition' && /non-whitespace/.test(e.message),
  );
  assert.equal(sim.requests.length, 0, 'a term this adapter cannot build JQL from never reaches the host');
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
