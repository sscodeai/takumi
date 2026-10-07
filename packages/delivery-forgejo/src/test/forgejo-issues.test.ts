/**
 * The issue surface — offline tests.
 *
 * The issue operations are NOT part of the delivery port (see `issues.ts`), so
 * they get their own suite: the delivery contract suite cannot exercise them, and
 * pretending otherwise would hide that they are a separate capability.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeliveryError } from '@takumi/core';
import {
  commentOnForgejoPullRequest,
  createForgejoDeliveryProvider,
  openForgejoIssue,
} from '../index.js';
import { FakeForgejoApi } from './fake-forgejo-api.js';

const OWNER = 'dev';
const REPO = 'takumi-delivery-selftest';
const API_BASE = 'https://forgejo.test/api/v1';

function api(options: { labels?: Array<{ id: number; name: string }> } = {}): FakeForgejoApi {
  return new FakeForgejoApi({
    owner: OWNER,
    repo: REPO,
    apiBase: API_BASE,
    head: () => 'c'.repeat(40),
    ...(options.labels === undefined ? {} : { labels: options.labels }),
  });
}

const target = (sim: FakeForgejoApi) => ({ owner: OWNER, repo: REPO, apiBase: API_BASE, request: sim.request });

test('openForgejoIssue: creates an issue and returns its number and URL', async () => {
  const sim = api();
  const issue = await openForgejoIssue(target(sim), { title: 'Delivery failed', body: 'The push was refused.' });
  assert.equal(issue.number, '1');
  assert.match(issue.url, /\/dev\/takumi-delivery-selftest\/issues\/1$/);

  const post = sim.requestsMatching('/issues').find((req) => req.method === 'POST');
  assert.deepEqual(post?.body, { title: 'Delivery failed', body: 'The push was refused.' });
  assert.equal(sim.issue(1)?.title, 'Delivery failed');
});

test('openForgejoIssue: a title is required', async () => {
  const sim = api();
  await assert.rejects(
    () => openForgejoIssue(target(sim), { title: '   ', body: 'x' }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /title/.test(e.message),
  );
  assert.equal(sim.requests.length, 0, 'a rejected issue must not reach the host');
});

test('openForgejoIssue: numeric label ids are sent through', async () => {
  const sim = api();
  await openForgejoIssue(target(sim), { title: 'x', body: 'y', labels: [3, 4] });
  const post = sim.requestsMatching('/issues').find((req) => req.method === 'POST');
  assert.deepEqual((post?.body as Record<string, unknown>)['labels'], [3, 4]);
});

test('openForgejoIssue: label names are resolved against the repository', async () => {
  const sim = api({ labels: [{ id: 7, name: 'bug' }, { id: 9, name: 'delivery' }] });
  await openForgejoIssue(target(sim), { title: 'x', body: 'y', labels: ['delivery'] });
  const post = sim.requestsMatching('/issues').find((req) => req.method === 'POST');
  assert.deepEqual((post?.body as Record<string, unknown>)['labels'], [9]);
  assert.ok(sim.calls().some((call) => call.includes('/labels?limit=50')));
});

test('openForgejoIssue: an unknown label name is a precondition, not a dropped label', async () => {
  const sim = api({ labels: [{ id: 7, name: 'bug' }] });
  await assert.rejects(
    () => openForgejoIssue(target(sim), { title: 'x', body: 'y', labels: ['nope'] }),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'precondition' && /does not exist/.test(e.message),
  );
  assert.equal(sim.requestsMatching('/issues').filter((req) => req.method === 'POST').length, 0);
});

test('commentOnForgejoPullRequest: comments on the pull request index', async () => {
  const sim = api();
  // Seed an issue at index 1 so the host accepts the comment (a pull request is
  // an issue on Forgejo's API).
  await openForgejoIssue(target(sim), { title: 'seed', body: '' });
  const comment = await commentOnForgejoPullRequest(target(sim), { number: '1' }, 'Reviewed and merged.');
  assert.equal(comment.id, '1');
  assert.match(comment.url, /issues\/1#issuecomment-1$/);
  const post = sim.requestsMatching('/issues/1/comments').find((req) => req.method === 'POST');
  assert.deepEqual(post?.body, { body: 'Reviewed and merged.' });
});

test('commentOnForgejoPullRequest: an unknown pull request is not_found', async () => {
  const sim = api();
  await assert.rejects(
    () => commentOnForgejoPullRequest(target(sim), { number: '42' }, 'hi'),
    (e: unknown) => e instanceof DeliveryError && e.kind === 'not_found',
  );
});

test('the provider exposes the issue surface as extra methods', async () => {
  const sim = api();
  const provider = createForgejoDeliveryProvider({ owner: OWNER, repo: REPO, apiBase: API_BASE, request: sim.request });
  const issue = await provider.openIssue({ title: 'From the provider', body: 'body' });
  assert.equal(issue.number, '1');
  const comment = await provider.commentOnPullRequest({ number: '1' }, 'a comment');
  assert.equal(comment.id, '1');
});

test('fail closed: with no request and no token the issue surface refuses', async () => {
  const previous = { a: process.env['FORGEJO_TOKEN'], b: process.env['GITEA_TOKEN'] };
  delete process.env['FORGEJO_TOKEN'];
  delete process.env['GITEA_TOKEN'];
  try {
    await assert.rejects(
      () => openForgejoIssue({ owner: OWNER, repo: REPO, apiBase: API_BASE }, { title: 'x', body: 'y' }),
      (e: unknown) => e instanceof DeliveryError && e.kind === 'auth' && /no request transport configured/.test(e.message),
    );
  } finally {
    if (previous.a !== undefined) process.env['FORGEJO_TOKEN'] = previous.a;
    if (previous.b !== undefined) process.env['GITEA_TOKEN'] = previous.b;
  }
});
