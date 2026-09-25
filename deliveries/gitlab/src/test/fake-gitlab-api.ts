/**
 * FakeGitLabApi — an in-process stand-in for the slice of the GitLab REST API v4
 * that {@link GitLabDeliveryProvider} uses.
 *
 * WHY hand-written instead of a mocking library: this repository ships ZERO test
 * dependencies, and the adapter must be provable with zero network and zero
 * credentials. The double records every request and answers exactly like GitLab
 * does — including the awkward parts (404 for an unknown iid, 409 when the merge
 * `sha` does not match the head, 405 when the merge request cannot be merged, and
 * a 200 that reports a state GitLab did not actually merge).
 *
 * It is a test double, NOT a GitLab emulator: only the endpoints, fields and
 * statuses the adapter touches are modelled, and each one is documented with the
 * API fact it stands for.
 */

import type { BoardHttpRequest, BoardHttpResponse, BoardRequestFn } from '@takumi/core';

export interface FakePipelineSeed {
  id?: number;
  name?: string;
  status?: string;
  webUrl?: string;
}

export interface FakeCommitStatusSeed {
  name?: string;
  status?: string;
  targetUrl?: string;
}

export interface FakeMergeRequestSeed {
  /** Default: the next free iid. */
  iid?: number;
  /** Default `opened`. */
  state?: string;
  /** Default: the head the source branch was last pushed with. */
  sha?: string;
  /** Default: `main`. */
  targetBranch?: string;
  /** Default: the fake's `sourceBranch` option. */
  sourceBranch?: string;
  webUrl?: string;
  /** Deprecated GitLab field; only written when seeded. */
  mergeableStatus?: string | null;
  /** Modern GitLab field; only written when seeded. */
  detailedMergeStatus?: string | null;
  pipelines?: FakePipelineSeed[];
  commitStatuses?: FakeCommitStatusSeed[];
}

export interface FakeGitLabApiOptions {
  /** Project path every URL must address (`group/project`). */
  project: string;
  /** API base the provider was configured with, e.g. `https://gitlab.test/api/v4`. */
  apiBase: string;
  /** The head the source branch currently carries (i.e. after the last push). */
  head: () => string;
  /** When set, a request without `PRIVATE-TOKEN: <token>` answers 401. */
  token?: string;
  /** Mergeability GitLab reports for a merge request it has not been told about (default `mergeable`). */
  mergeableStatus?: string;
  /** Pipelines every merge request answers with (default: none, so the commit-status fallback runs). */
  pipelines?: FakePipelineSeed[];
  /** Commit statuses the head commit answers with (default: none). */
  commitStatuses?: FakeCommitStatusSeed[];
  /** Source branch a seeded merge request belongs to (default `feature`). */
  sourceBranch?: string;
}

interface FakeMergeRequest {
  iid: number;
  state: string;
  sha: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  mergeableStatus: string | null;
  detailedMergeStatus: string | null;
  pipelines: FakePipelineSeed[];
  commitStatuses: FakeCommitStatusSeed[];
  /** A subsequent state the PUT should claim, to model a host that reports "no merge yet". */
  mergePutsState?: string;
}

/** A canned answer, optionally aimed at one kind of request. */
interface FakeFault {
  matches: (req: BoardHttpRequest) => boolean;
  once: boolean;
  response: BoardHttpResponse;
}

export class FakeGitLabApi {
  private readonly mergeRequests = new Map<number, FakeMergeRequest>();
  private readonly recorded: BoardHttpRequest[] = [];
  private readonly faults: FakeFault[] = [];
  private readonly mergePuts: Array<{ iid: number; body: Record<string, unknown> }> = [];
  private readonly options: FakeGitLabApiOptions;
  /** The base the provider must address: origin AND path, so a wrong base 404s. */
  private readonly apiOrigin: string;
  private readonly apiPath: string;
  private seq = 0;

  constructor(options: FakeGitLabApiOptions) {
    this.options = options;
    const base = new URL(options.apiBase);
    this.apiOrigin = base.origin;
    this.apiPath = base.pathname.replace(/\/+$/g, '');
  }

  /** The request function to inject into the provider. */
  get request(): BoardRequestFn {
    return (req) => this.handle(req);
  }

  // --- recorded facts -------------------------------------------------------

  /** Every request seen so far, in order, as deep copies. */
  requests(): readonly BoardHttpRequest[] {
    return this.recorded;
  }

  /** `METHOD url` per request, in order — the shape assertion for the adapter. */
  calls(): string[] {
    return this.recorded.map((req) => `${req.method} ${req.url}`);
  }

  /** The JSON body of each request in order (`undefined` when the request had none). */
  bodies(): unknown[] {
    return this.recorded.map((req) => req.body);
  }

  /** Requests whose URL contains `fragment` (path or query). */
  requestsMatching(fragment: string): readonly BoardHttpRequest[] {
    return this.recorded.filter((req) => req.url.includes(fragment));
  }

  /** Merge requests created by the adapter. */
  createdCount(): number {
    return this.seq;
  }

  /** Successful merge calls (i.e. merges that actually happened). */
  mergedCount(): number {
    return this.mergePuts.length;
  }

  /** Merge requests physically in state `merged`. */
  mergedRequests(): number {
    let merged = 0;
    for (const mr of this.mergeRequests.values()) if (mr.state === 'merged') merged += 1;
    return merged;
  }

  /** The iids of the merge requests currently open, ascending. */
  openMergeRequestIids(): number[] {
    return [...this.mergeRequests.values()]
      .filter((mr) => mr.state === 'opened')
      .map((mr) => mr.iid)
      .sort((a, b) => a - b);
  }

  /** Forget the recorded requests (seeding never records anything). */
  clear(): void {
    this.recorded.length = 0;
  }

  // --- state control --------------------------------------------------------

  /** Seed a merge request the adapter did not create. */
  seedMergeRequest(seed: FakeMergeRequestSeed = {}): number {
    const iid = seed.iid ?? this.nextIid();
    this.mergeRequests.set(iid, {
      iid,
      state: seed.state ?? 'opened',
      sha: seed.sha ?? this.options.head(),
      sourceBranch: seed.sourceBranch ?? this.options.sourceBranch ?? 'feature',
      targetBranch: seed.targetBranch ?? 'main',
      webUrl: seed.webUrl ?? `https://gitlab.test/${this.options.project}/-/merge_requests/${iid}`,
      mergeableStatus: seed.mergeableStatus === undefined ? (seed.detailedMergeStatus === undefined ? (this.options.mergeableStatus ?? 'mergeable') : null) : seed.mergeableStatus,
      detailedMergeStatus: seed.detailedMergeStatus ?? (seed.mergeableStatus === undefined ? (this.options.mergeableStatus ?? 'mergeable') : null),
      pipelines: seed.pipelines ?? this.options.pipelines ?? [],
      commitStatuses: seed.commitStatuses ?? this.options.commitStatuses ?? [],
    });
    return iid;
  }

  /** Move the source branch head the way another push (or a rebase) would. */
  setSha(iid: number, sha: string): void {
    const mr = this.require(iid);
    mr.sha = sha;
  }

  setState(iid: number, state: string): void {
    this.require(iid).state = state;
  }

  /** Make the PUT answer 200 while claiming GitLab did not merge (a queued merge). */
  setMergePutsState(iid: number, state: string | undefined): void {
    this.require(iid).mergePutsState = state;
  }

  setMergeableStatus(iid: number, status: string | null): void {
    const mr = this.require(iid);
    mr.detailedMergeStatus = status;
    mr.mergeableStatus = status;
  }

  setPipelines(iid: number, pipelines: FakePipelineSeed[]): void {
    this.require(iid).pipelines = pipelines;
  }

  setCommitStatuses(iid: number, statuses: FakeCommitStatusSeed[]): void {
    this.require(iid).commitStatuses = statuses;
  }

  /** Answer the NEXT request with this response instead of routing it. */
  failNext(status: number, body = '{"message":"forced"}'): FakeGitLabApi {
    this.faults.push({ matches: () => true, once: true, response: { status, body } });
    return this;
  }

  /** Answer every request matching `matches` with this response. */
  failWhen(matches: (req: BoardHttpRequest) => boolean, status: number, body = '{"message":"forced"}'): FakeGitLabApi {
    this.faults.push({ matches, once: false, response: { status, body } });
    return this;
  }

  clearFaults(): FakeGitLabApi {
    this.faults.length = 0;
    return this;
  }

  // --- routing --------------------------------------------------------------

  /** The bodies of the merge calls that succeeded, in order. */
  mergePutBodies(): Array<Record<string, unknown>> {
    return this.mergePuts.map((put) => ({ ...put.body }));
  }

  private async handle(req: BoardHttpRequest): Promise<BoardHttpResponse> {
    const clone: BoardHttpRequest = {
      method: req.method,
      url: req.url,
      ...(req.headers === undefined ? {} : { headers: { ...req.headers } }),
      ...(req.body === undefined ? {} : { body: structuredClone(req.body) }),
    };
    this.recorded.push(clone);

    const index = this.faults.findIndex((fault) => fault.matches(clone));
    if (index !== -1) {
      const fault = this.faults[index] as FakeFault;
      if (fault.once) this.faults.splice(index, 1);
      return fault.response;
    }

    // GitLab authenticates with `PRIVATE-TOKEN` and rejects anything else with 401.
    if (this.options.token !== undefined && clone.headers?.['PRIVATE-TOKEN'] !== this.options.token) {
      return json(401, { message: '401 Unauthorized' });
    }

    return this.route(clone) ?? json(404, { message: '404 Not Found' });
  }

  private route(req: BoardHttpRequest): BoardHttpResponse | null {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return json(400, { message: '400 Bad Request' });
    }
    // The provider must address the base it was configured with: a request to a
    // different host or path prefix is not this project's API.
    if (url.origin !== this.apiOrigin || !url.pathname.startsWith(this.apiPath)) return null;
    const segments = url.pathname
      .slice(this.apiPath.length)
      .split('/')
      .filter((part) => part.length > 0)
      .map((part) => decodeURIComponent(part));

    // `/projects/:id/...` — the project segment is the URL-encoded full path, so
    // a decoded `group/project` arrives as exactly ONE element.
    if (segments[0] !== 'projects' || segments[1] !== this.options.project) return null;

    if (segments[2] === 'commits' && segments[4] === 'statuses' && req.method === 'GET') {
      const sha = segments[3] ?? '';
      if (!this.commitKnown(sha)) return json(404, { message: '404 Not Found' });
      const statuses = this.statusesForSha(sha) ?? [];
      // MEASURED on gitlab.com: a commit the host KNOWS and that has no statuses at all answers
      // 404, not an empty array. This double answered `200 []`, which is exactly why the
      // adapter's fallback stayed wrong through every offline run: the double never produced
      // the response the host does.
      return statuses.length === 0 ? json(404, { message: '404 Not Found' }) : json(200, statuses);
    }
    // `/repository/commits/:sha` — how the adapter asks whether a 404 from the statuses read
    // means "nothing published" or "unknown commit".
    if (segments[2] === 'repository' && segments[3] === 'commits' && segments.length === 5 && req.method === 'GET') {
      const sha = segments[4] ?? '';
      return this.commitKnown(sha)
        ? json(200, { id: sha, short_id: sha.slice(0, 8) })
        : json(404, { message: '404 Not Found' });
    }
    if (segments[2] !== 'merge_requests') return null;

    if (segments.length === 3) {
      if (req.method === 'GET') return json(200, this.listOpen(url.searchParams.get('source_branch'), url.searchParams));
      if (req.method === 'POST') return this.create(req);
      return json(405, { message: '405 Method Not Allowed' });
    }

    const iid = Number.parseInt(segments[3] ?? '', 10);
    if (!Number.isInteger(iid)) return json(400, { message: '400 Bad Request' });
    const mergeRequest = this.mergeRequests.get(iid);
    if (mergeRequest === undefined) return json(404, { message: '404 Not Found' });

    if (segments.length === 4 && req.method === 'GET') return json(200, this.render(mergeRequest));
    if (segments.length === 4 && req.method === 'PUT') {
      // The merge-request update endpoint is deliberately NOT modelled: the
      // delivery adapter must never rewrite a reviewed merge request.
      return json(405, { message: '405 Method Not Allowed' });
    }
    if (segments.length === 5 && segments[4] === 'pipelines' && req.method === 'GET') {
      // GitLab documents this endpoint as returning `{id, sha, ref, status}` (and
      // a `web_url` in practice) — it does NOT document a pipeline `name`, so a
      // seeded name/url is opt-in and the default answer carries neither.
      return json(
        200,
        mergeRequest.pipelines.map((pipeline, index) => ({
          id: pipeline.id ?? index + 1,
          ...(pipeline.name === undefined ? {} : { name: pipeline.name }),
          status: pipeline.status ?? 'success',
          ...(pipeline.webUrl === undefined ? {} : { web_url: pipeline.webUrl }),
        })),
      );
    }
    if (segments.length === 5 && segments[4] === 'merge' && req.method === 'PUT') return this.merge(mergeRequest, req);
    return json(404, { message: '404 Not Found' });
  }

  /** `GET /merge_requests?source_branch=..&state=opened&per_page=100` — GitLab filters server-side. */
  private listOpen(sourceBranch: string | null, params: URLSearchParams): unknown[] {
    const state = params.get('state');
    return [...this.mergeRequests.values()]
      .filter((mr) => state === null || mr.state === state)
      .filter((mr) => sourceBranch === null || mr.sourceBranch === sourceBranch)
      .map((mr) => this.render(mr));
  }

  private create(req: BoardHttpRequest): BoardHttpResponse {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sourceBranch = typeof body['source_branch'] === 'string' ? body['source_branch'] : '';
    if (sourceBranch.length === 0) return json(400, { message: '400 Bad Request' });
    const iid = this.nextIid();
    this.mergeRequests.set(iid, {
      iid,
      state: 'opened',
      // GitLab reports the SOURCE BRANCH head as the merge request sha.
      sha: this.options.head(),
      sourceBranch,
      targetBranch: typeof body['target_branch'] === 'string' ? body['target_branch'] : 'main',
      webUrl: `https://gitlab.test/${this.options.project}/-/merge_requests/${iid}`,
      mergeableStatus: this.options.mergeableStatus ?? 'mergeable',
      detailedMergeStatus: this.options.mergeableStatus ?? 'mergeable',
      pipelines: this.options.pipelines ?? [],
      commitStatuses: this.options.commitStatuses ?? [],
    });
    return json(201, this.render(this.mergeRequests.get(iid) as FakeMergeRequest));
  }

  /**
   * `PUT /merge_requests/:iid/merge`.
   *
   * GitLab's own guards are modelled, because they are the SECOND half of the
   * anti-swap rule: a `sha` that is not the current head is refused (409), and a
   * merge request that is not mergeable in its current state is refused (405).
   */
  private merge(mergeRequest: FakeMergeRequest, req: BoardHttpRequest): BoardHttpResponse {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sha = typeof body['sha'] === 'string' ? body['sha'] : '';
    if (sha !== mergeRequest.sha) {
      return json(409, { message: `SHA mismatch: expected ${mergeRequest.sha}, got ${sha}` });
    }
    if (mergeRequest.state !== 'opened' || isUnmergeable(mergeRequest)) {
      return json(405, { message: '405 Method Not Allowed' });
    }
    if (mergeRequest.mergePutsState !== undefined) {
      // A 2xx that did NOT merge the change (GitLab answers this way while a
      // merge is queued behind a pipeline): the adapter must not call it a merge.
      return json(200, this.render(mergeRequest));
    }
    mergeRequest.state = 'merged';
    this.mergePuts.push({ iid: mergeRequest.iid, body: { ...body } });
    return json(200, this.render(mergeRequest));
  }

  /** Does this instance know the commit (a merge request points at it)? */
  private commitKnown(sha: string): boolean {
    return this.statusesForSha(sha) !== null;
  }

  private statusesForSha(sha: string): unknown[] | null {
    for (const mr of this.mergeRequests.values()) {
      if (mr.sha === sha) {
        return mr.commitStatuses.map((status) => ({
          name: status.name ?? 'commit status',
          status: status.status ?? 'success',
          target_url: status.targetUrl ?? `https://gitlab.test/${this.options.project}/-/commit/${sha}`,
        }));
      }
    }
    return null;
  }

  /** The JSON body GitLab would answer for one merge request. */
  private render(mergeRequest: FakeMergeRequest): Record<string, unknown> {
    return {
      iid: mergeRequest.iid,
      state: mergeRequest.state,
      sha: mergeRequest.sha,
      source_branch: mergeRequest.sourceBranch,
      target_branch: mergeRequest.targetBranch,
      web_url: mergeRequest.webUrl,
      ...(mergeRequest.mergeableStatus === null ? {} : { mergeable_status: mergeRequest.mergeableStatus }),
      ...(mergeRequest.detailedMergeStatus === null ? {} : { detailed_merge_status: mergeRequest.detailedMergeStatus }),
    };
  }

  private nextIid(): number {
    this.seq += 1;
    return this.seq;
  }

  private require(iid: number): FakeMergeRequest {
    const mergeRequest = this.mergeRequests.get(iid);
    if (mergeRequest === undefined) throw new Error(`FakeGitLabApi: no merge request !${iid}`);
    return mergeRequest;
  }
}

/** The `detailed_merge_status` values that mean "a conflict blocks this". */
function isUnmergeable(mergeRequest: FakeMergeRequest): boolean {
  return mergeRequest.detailedMergeStatus === 'conflict' || mergeRequest.detailedMergeStatus === 'not_mergeable';
}

function json(status: number, body: unknown): BoardHttpResponse {
  return { status, body: JSON.stringify(body) };
}
