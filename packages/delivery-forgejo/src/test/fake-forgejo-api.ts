/**
 * A recorded Forgejo REST v1 double for the adapter's tests.
 *
 * It models the endpoints the adapter uses — list/create/get/merge pull requests,
 * the combined commit status, and the issue surface — and it models the HOST-SIDE
 * guards the adapter relies on:
 *
 *   - `POST /pulls` answers 409 when an open pull request for the same head
 *     branch already exists (Forgejo's own rule, and how "exactly one" is kept);
 *   - `POST /pulls/{index}/merge` answers 409 when `head_commit_id` is not the
 *     pull request's current head, and 405 when the pull request is not
 *     mergeable. That 409 is the exact-head requirement the adapter leans on
 *     instead of a client-side comparison.
 *
 * Every request is recorded, so a test can assert the adapter's HTTP behaviour
 * (and that it did not send a merge it should not have).
 */

import type { BoardHttpRequest, BoardHttpResponse, BoardRequestFn } from '@takumi/core';

interface SimPull {
  number: number;
  headRef: string;
  headSha: string;
  baseRef: string;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean | null;
  title: string;
  body: string;
}

interface SimStatus {
  context: string;
  status: string;
  target_url?: string;
}

interface SimIssue {
  number: number;
  url: string;
  title: string;
  body: string;
  labels: number[];
}

interface SimComment {
  id: number;
  url: string;
  body: string;
  issueIndex: number;
}

export interface FakeForgejoApiOptions {
  owner: string;
  repo: string;
  apiBase: string;
  /** The head the source branch currently points at — i.e. what the last push delivered. */
  head: () => string;
  baseBranch?: string;
  /** Per-head commit statuses. An absent head has none. */
  statuses?: Record<string, SimStatus[]>;
  /** Default mergeability for a freshly opened pull request. */
  mergeable?: boolean | null;
  /** Labels that exist on the repository (id + name), for the issue surface. */
  labels?: Array<{ id: number; name: string }>;
  /**
   * Answer the first N merge attempts with Forgejo's TRANSIENT
   * `405 {"message":"Please try again later"}` (mergeability recomputation),
   * then merge normally.
   */
  mergeBusyAttempts?: number;
}

export class FakeForgejoApi {
  readonly requests: BoardHttpRequest[] = [];
  readonly request: BoardRequestFn;

  private readonly options: FakeForgejoApiOptions;
  private readonly pulls: SimPull[] = [];
  private readonly issues: SimIssue[] = [];
  private readonly comments: SimComment[] = [];
  private readonly labels: Array<{ id: number; name: string }>;
  private pullSeq = 0;
  private issueSeq = 0;
  private commentSeq = 0;
  private created = 0;
  private merged = 0;
  private mergeBusy = 0;

  constructor(options: FakeForgejoApiOptions) {
    this.options = options;
    this.labels = options.labels ?? [];
    this.request = async (req) => {
      this.requests.push({ ...req, ...(req.body === undefined ? {} : { body: structuredClone(req.body) }) });
      return this.handle(req);
    };
  }

  // --- recorders ---

  createdCount(): number {
    return this.created;
  }

  mergedCount(): number {
    return this.merged;
  }

  requestsMatching(substring: string): BoardHttpRequest[] {
    return this.requests.filter((req) => req.url.includes(substring));
  }

  calls(): string[] {
    return this.requests.map((req) => `${req.method} ${req.url}`);
  }

  openPullNumbers(): number[] {
    return this.pulls.filter((pull) => pull.state === 'open').map((pull) => pull.number);
  }

  /** Seed a pull request that a test then drives directly. */
  seedPull(options: { headSha: string; headRef?: string; baseRef?: string; mergeable?: boolean | null; state?: 'open' | 'closed'; merged?: boolean }): number {
    this.pullSeq += 1;
    const number = this.pullSeq;
    this.pulls.push({
      number,
      headRef: options.headRef ?? 'takumi/seed',
      headSha: options.headSha,
      baseRef: options.baseRef ?? this.options.baseBranch ?? 'main',
      url: `${this.options.apiBase}/../${this.options.owner}/${this.options.repo}/pulls/${number}`,
      state: options.state ?? 'open',
      merged: options.merged ?? false,
      mergeable: options.mergeable === undefined ? true : options.mergeable,
      title: 'seeded',
      body: '',
    });
    return number;
  }

  setMergeable(number: number, mergeable: boolean | null): void {
    const pull = this.pulls.find((p) => p.number === number);
    if (pull === undefined) throw new Error(`no such pull request: ${number}`);
    pull.mergeable = mergeable;
  }

  pull(number: number): SimPull | undefined {
    return this.pulls.find((p) => p.number === number);
  }

  issue(number: number): SimIssue | undefined {
    return this.issues.find((i) => i.number === number);
  }

  commentCount(): number {
    return this.comments.length;
  }

  // --- the simulator ---

  private json(payload: unknown, status = 200): BoardHttpResponse {
    return { status, body: JSON.stringify(payload) };
  }

  private handle(req: BoardHttpRequest): Promise<BoardHttpResponse> {
    const url = new URL(req.url);
    const prefix = `${new URL(this.options.apiBase).pathname}/repos/${this.options.owner}/${this.options.repo}`;
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const baseBranch = this.options.baseBranch ?? 'main';

    if (req.method === 'GET' && path === '/pulls') {
      const state = url.searchParams.get('state') ?? 'open';
      const pulls = this.pulls
        .filter((pull) => (state === 'all' ? true : pull.state === state))
        .map((pull) => this.pullPayload(pull));
      return Promise.resolve(this.json(pulls));
    }

    if (req.method === 'POST' && path === '/pulls') {
      const headRef = String(body['head'] ?? '');
      if (this.pulls.some((pull) => pull.state === 'open' && pull.headRef === headRef)) {
        // Forgejo's own rule: one open pull request per head branch.
        return Promise.resolve(this.json({ message: 'pull request already exists for these branches' }, 409));
      }
      this.pullSeq += 1;
      const pull: SimPull = {
        number: this.pullSeq,
        headRef,
        headSha: this.options.head(),
        baseRef: String(body['base'] ?? baseBranch),
        url: `${this.options.apiBase.replace(/\/api\/v1$/, '')}/${this.options.owner}/${this.options.repo}/pulls/${this.pullSeq}`,
        state: 'open',
        merged: false,
        mergeable: this.options.mergeable === undefined ? true : this.options.mergeable,
        title: String(body['title'] ?? ''),
        body: String(body['body'] ?? ''),
      };
      this.pulls.push(pull);
      this.created += 1;
      return Promise.resolve(this.json(this.pullPayload(pull), 201));
    }

    const getPull = /^\/pulls\/(\d+)$/.exec(path);
    if (req.method === 'GET' && getPull) {
      const pull = this.pulls.find((p) => String(p.number) === getPull[1]);
      if (pull === undefined) return Promise.resolve(this.json({ message: 'The target couldn\'t be found.' }, 404));
      return Promise.resolve(this.json(this.pullPayload(pull)));
    }

    const mergePull = /^\/pulls\/(\d+)\/merge$/.exec(path);
    if (req.method === 'POST' && mergePull) {
      const pull = this.pulls.find((p) => String(p.number) === mergePull[1]);
      if (pull === undefined) return Promise.resolve(this.json({ message: 'The target couldn\'t be found.' }, 404));
      // The host's exact-head requirement: the reviewed commit and nothing else.
      if (body['head_commit_id'] !== undefined && body['head_commit_id'] !== pull.headSha) {
        return Promise.resolve(this.json({ message: 'head out of date' }, 409));
      }
      if (this.mergeBusy < (this.options.mergeBusyAttempts ?? 0)) {
        this.mergeBusy += 1;
        return Promise.resolve(this.json({ message: 'Please try again later' }, 405));
      }
      if (pull.mergeable !== true) {
        return Promise.resolve({ status: 405, body: '' });
      }
      pull.merged = true;
      pull.state = 'closed';
      this.merged += 1;
      return Promise.resolve(this.json({ merged: true, message: 'Pull request has been merged successfully' }));
    }

    const commitStatus = /^\/commits\/([^/]+)\/status$/.exec(path);
    if (req.method === 'GET' && commitStatus) {
      const sha = commitStatus[1] ?? '';
      const statuses = this.options.statuses?.[sha] ?? [];
      return Promise.resolve(this.json({ sha, state: combinedState(statuses), statuses, total_count: statuses.length }));
    }

    if (req.method === 'GET' && path === '/labels') {
      return Promise.resolve(this.json(this.labels.map((label) => ({ id: label.id, name: label.name }))));
    }

    if (req.method === 'POST' && path === '/issues') {
      this.issueSeq += 1;
      const number = this.issueSeq;
      const issue: SimIssue = {
        number,
        url: `${this.options.apiBase.replace(/\/api\/v1$/, '')}/${this.options.owner}/${this.options.repo}/issues/${number}`,
        title: String(body['title'] ?? ''),
        body: String(body['body'] ?? ''),
        labels: Array.isArray(body['labels']) ? (body['labels'] as number[]) : [],
      };
      this.issues.push(issue);
      return Promise.resolve(this.json({ number: issue.number, html_url: issue.url, title: issue.title, body: issue.body }, 201));
    }

    const issueComment = /^\/issues\/(\d+)\/comments$/.exec(path);
    if (req.method === 'POST' && issueComment) {
      const index = Number.parseInt(issueComment[1] ?? '', 10);
      if (!Number.isInteger(index) || !this.issues.some((issue) => issue.number === index)) {
        return Promise.resolve(this.json({ message: 'The target couldn\'t be found.' }, 404));
      }
      this.commentSeq += 1;
      const comment: SimComment = {
        id: this.commentSeq,
        url: `${this.options.apiBase.replace(/\/api\/v1$/, '')}/${this.options.owner}/${this.options.repo}/issues/${index}#issuecomment-${this.commentSeq}`,
        body: String(body['body'] ?? ''),
        issueIndex: index,
      };
      this.comments.push(comment);
      return Promise.resolve(this.json({ id: comment.id, html_url: comment.url, body: comment.body }, 201));
    }

    return Promise.resolve(this.json({ message: 'The target couldn\'t be found.' }, 404));
  }

  private pullPayload(pull: SimPull): Record<string, unknown> {
    return {
      number: pull.number,
      html_url: pull.url,
      state: pull.state,
      merged: pull.merged,
      mergeable: pull.mergeable,
      title: pull.title,
      body: pull.body,
      head: { ref: pull.headRef, sha: pull.headSha, label: pull.headRef },
      base: { ref: pull.baseRef, sha: pull.baseRef, label: pull.baseRef },
    };
  }
}

function combinedState(statuses: SimStatus[]): string {
  if (statuses.length === 0) return 'pending';
  if (statuses.some((s) => s.status === 'pending')) return 'pending';
  if (statuses.some((s) => s.status === 'failure' || s.status === 'error')) return 'failure';
  if (statuses.every((s) => s.status === 'success')) return 'success';
  return 'pending';
}
