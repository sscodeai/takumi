import {
  assertBoardCapability,
  assertScopeQuery,
  BOARD_WORK_ITEM_STATES,
  boardErrorFromResponse,
  renderCreateMarker,
  BoardError,
  assertTransition,
  createCurlRequestFn,
  newestBoardStateRecord,
  parseBoardStateRecord,
  renderBoardStateRecord,
  requestBoardJson,
  unconfiguredRequestFn,
} from '@takumi/core';
import type {
  BoardBootstrapAction,
  BoardBootstrapReport,
  BoardCapabilities,
  BoardWorkItemSpec,
  CreateWorkResult,
  BoardCommentAuthor,
  BoardCommentRef,
  BoardProviderMetadata,
  BoardRequestFn,
  BoardStateRecord,
  BoardTransitionEvidence,
  BoardWorkItem,
  BoardWorkItemState,
  BoardWorkQuery,
  ClaimResult,
  CurlRequestFnOptions,
  TaskBoardProvider,
} from '@takumi/core';

/**
 * GitHubBoardProvider — GitHub Issues as the task board.
 *
 * The delivery state is a label on the issue, the resumable run record is a
 * hidden versioned block inside a comment takumi itself wrote, and every READ
 * of that record is filtered by the comment's `author_association`: a stranger
 * who comments a copy of the block does not become the run.
 *
 * Two things this adapter does NOT claim, because GitHub cannot give them:
 *
 *   - `atomicClaim: false`. Adding and removing labels is not conditional, so a
 *     claim is read-then-write followed by a re-read that proves we won. A lost
 *     race is reported as `claimed: false` with a reason, never accepted.
 *   - nothing about a pull request. Opening one, running checks and merging are
 *     declared in `delivery` for the M2 `DeliveryProvider` port (ADR-006) — this
 *     adapter does not create branches, PRs or merges today.
 */

export interface GitHubBoardOptions {
  /** `owner/name`. */
  repo: string;
  /** Bearer token; falls back to `process.env.GITHUB_TOKEN`. */
  token?: string;
  /** API base, overridable for GitHub Enterprise and tests. Default `https://api.github.com`. */
  apiBase?: string;
  /** Label prefix for the six states. Default `takumi-`. */
  labelPrefix?: string;
  /** Author associations treated as trusted. Default OWNER, MEMBER, COLLABORATOR. */
  trustedAssociations?: string[];
  /** Injected transport; tests pass a fake, production uses the curl default. */
  request?: BoardRequestFn;
}

export const GITHUB_STATE_LABELS: Record<BoardWorkItemState, string> = {
  ready: 'ready',
  claimed: 'claimed',
  pr_open: 'pr-open',
  fix_needed: 'fix-needed',
  merged: 'merged',
  blocked: 'blocked',
};

/** GitHub's comment association values that grant trust by default. */
export const DEFAULT_TRUSTED_ASSOCIATIONS = ['OWNER', 'MEMBER', 'COLLABORATOR'];

/** The colour every state label gets (GitHub's format: hex, no leading '#'). */
export const STATE_LABEL_COLOR = '1f6feb';

/** The subset of GitHub's label JSON this adapter reads. */
interface GitHubLabel {
  name?: string;
  color?: string;
}

interface GitHubIssue {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  state?: string;
  labels?: Array<{ name?: string } | string>;
  assignees?: Array<{ login?: string }> | null;
  updated_at?: string;
  pull_request?: unknown;
}

interface GitHubComment {
  id?: number;
  body?: string | null;
  author_association?: string;
  user?: { login?: string } | null;
  html_url?: string;
}

export class GitHubBoardProvider implements TaskBoardProvider {
  private readonly repo: string;
  private readonly apiBase: string;
  private readonly labelPrefix: string;
  private readonly trustedAssociations: Set<string>;
  private readonly request: BoardRequestFn;
  /** Memoized authenticated login, so a comment can be recognized as ours. */
  private loginPromise: Promise<string> | undefined;

  constructor(opts: GitHubBoardOptions) {
    if (!/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) {
      throw new BoardError('precondition', `repo must be "owner/name", got ${JSON.stringify(opts.repo)}`);
    }
    this.repo = opts.repo;
    this.apiBase = (opts.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.labelPrefix = opts.labelPrefix ?? 'takumi-';
    this.trustedAssociations = new Set(opts.trustedAssociations ?? DEFAULT_TRUSTED_ASSOCIATIONS);
    const token = opts.token ?? process.env['GITHUB_TOKEN'];
    this.request =
      opts.request ??
      (token === undefined || token.length === 0 ? unconfiguredRequestFn('github') : createGitHubTransport({ token, apiBase: this.apiBase }));
  }

  metadata(): BoardProviderMetadata {
    return {
      id: 'github',
      name: 'GitHub Issues Board',
      version: '0.1.0',
      description: 'GitHub Issues as the task board: labels are the columns, comments carry the record.',
    };
  }

  capabilities(): BoardCapabilities {
    return {
      states: ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked'],
      comments: true,
      editableComment: true,
      trustedAuthorFilter: true,
      machineReadableState: true,
      // GitHub cannot add/remove a label conditionally: the claim is verified by
      // a re-read instead, and the adapter says so rather than implying more.
      atomicClaim: false,
      // GitHub labels are creatable through the API, so a fresh repository can be
      // made ready by takumi itself instead of by hand.
      canBootstrapStates: true,
      // Issues are creatable. Filing is how a failure becomes work instead of a comment.
      canCreateWork: true,
      // Search is what lets a caller scope a tick to an epic or a component without
      // takumi inventing an epic model (ADR-012).
      canTextSearch: true,
      delivery: { canOpenPullRequest: true, canRunChecks: true, canMerge: true },
    };
  }

  async listWork(query: BoardWorkQuery = {}): Promise<BoardWorkItem[]> {
    // A text scope goes through the SEARCH API, not the issue list: the list endpoint
    // has no free-text parameter, and a filter that cannot be expressed is not one this
    // adapter may quietly drop (an ignored scope means working on excluded items).
    if (query.query !== undefined) {
      return await this.searchWork(query, query.query);
    }

    // One label-filtered request per requested state: GitHub's `labels` query
    // parameter means AND, not OR, so asking for two states at once would return
    // nothing. Cross-state work has to be assembled here.
    const states: BoardWorkItemState[] = query.states === undefined ? ['ready'] : [...query.states];
    const labelFilter = query.labels ?? states.map((state) => this.labelFor(state));

    const seen = new Map<string, BoardWorkItem>();
    for (const label of labelFilter) {
      const params = new URLSearchParams({ state: 'open', per_page: String(query.limit ?? 100), labels: label });
      const issues = await requestBoardJson<GitHubIssue[]>(
        this.request,
        { method: 'GET', url: `${this.apiBase}/repos/${this.repo}/issues?${params.toString()}` },
        'listWork',
      );
      for (const issue of issues) {
        // The list endpoint also returns pull requests; they are not work items.
        if (issue.pull_request !== undefined) continue;
        if (issue.number === undefined) continue;
        const item = this.toWorkItemOrNull(issue);
        // An issue tagged with something this adapter cannot resolve is skipped
        // here (the caller asked for specific states) and still surfaces as an
        // explicit precondition error from getWork.
        if (item !== null) seen.set(item.id, item);
      }
    }
    return [...seen.values()];
  }

  async getWork(id: string): Promise<BoardWorkItem> {
    return this.toWorkItem(await this.fetchIssue(id));
  }

  /**
   * A search-API listing, filtered to the states the caller asked for.
   *
   * GitHub's search has its own query syntax, so the term is passed as a quoted phrase
   * and the repository scope is added by this adapter — never by the caller, who should
   * not have to know which board they are talking to. Search matches issue text, which
   * is what "this epic" means in practice; the state filter is applied HERE because
   * search knows nothing about takumi's labels.
   */
  private async searchWork(query: BoardWorkQuery, term: string): Promise<BoardWorkItem[]> {
    // The term travels inside a quoted phrase, so a quote in it would close the phrase and
    // change the query's meaning. Stripping it searched for something the operator did not
    // write (a difference nobody sees until the wrong items run), so it is REFUSED with the
    // fix in the message — the same choice every other adapter makes (ADR-012).
    const safe = assertScopeQuery(term) ?? '';
    if (safe.includes('"')) {
      throw new BoardError(
        'precondition',
        'a GitHub text scope cannot contain a double quote (the term is sent as a quoted phrase): remove the quote or search for the words around it',
      );
    }
    const states: BoardWorkItemState[] = query.states === undefined ? ['ready'] : [...query.states];
    const terms = `repo:${this.repo} is:issue "${safe}"`;
    const params = new URLSearchParams({ q: terms, per_page: String(query.limit ?? 100) });
    const found = await requestBoardJson<{ items?: GitHubIssue[] }>(
      this.request,
      { method: 'GET', url: `${this.apiBase}/search/issues?${params.toString()}` },
      'listWork: search',
    );
    const items: BoardWorkItem[] = [];
    for (const issue of found.items ?? []) {
      if (issue.pull_request !== undefined || issue.number === undefined) continue;
      const item = this.toWorkItemOrNull(issue);
      if (item === null || !states.includes(item.state)) continue;
      items.push(item);
    }
    return items;
  }

  /**
   * File an issue, idempotently.
   *
   * The state is the label, so the new issue starts with the state's label attached —
   * which means the label must exist: GitHub rejects an issue carrying an unknown label
   * with a 422. That failure is re-thrown with the fix in it (run `takumi board
   * --bootstrap`), because the raw "Validation Failed" tells an operator nothing.
   *
   * Deduplication goes through the search API rather than a scan of the issue list: a
   * scan is one page wide (the same limitation `listWork` documents), and a duplicate
   * filed because the first page did not contain it is exactly what this prevents.
   */
  async createWork(spec: BoardWorkItemSpec): Promise<CreateWorkResult> {
    assertBoardCapability(this, 'canCreateWork');
    const state = spec.state ?? 'ready';
    const marker = spec.idempotencyKey === undefined ? null : renderCreateMarker(spec.idempotencyKey);

    if (marker !== null) {
      const query = encodeURIComponent(`repo:${this.repo} "${marker}"`);
      const found = await requestBoardJson<{ items?: GitHubIssue[] }>(
        this.request,
        { method: 'GET', url: `${this.apiBase}/search/issues?q=${query}&per_page=10` },
        'createWork: search',
      );
      const hit = (found.items ?? []).find((issue) => (issue.body ?? '').includes(marker));
      if (hit !== undefined) return { item: this.toWorkItem(hit), created: false };
    }

    const body = marker === null ? (spec.body ?? '') : `${spec.body ?? ''}\n\n${marker}`;
    const labels = [...(spec.labels ?? []), this.labelFor(state)];
    try {
      const created = await requestBoardJson<GitHubIssue>(
        this.request,
        {
          method: 'POST',
          url: `${this.apiBase}/repos/${this.repo}/issues`,
          body: { title: spec.title, body, labels },
        },
        'createWork',
      );
      return { item: this.toWorkItem(created), created: true };
    } catch (e) {
      if (e instanceof BoardError && e.kind === 'precondition' && /label/i.test(e.message)) {
        throw new BoardError(
          'precondition',
          `${e.message} — the state label ${JSON.stringify(this.labelFor(state))} may not exist on ${this.repo}; run \`takumi board --bootstrap\` to create the state labels`,
          { item: this.repo },
        );
      }
      throw e;
    }
  }

  async claim(id: string, runId: string): Promise<ClaimResult> {
    const issue = await this.fetchIssue(id);
    const existing = await this.readState(id);
    if (existing !== null && existing.runId !== runId) {
      return { item: id, runId, claimed: false, reason: `already claimed by ${existing.runId}` };
    }
    const current = this.stateOf(issue);
    if (current !== 'ready') {
      return { item: id, runId, claimed: false, reason: `item is in state ${current}, not ready` };
    }

    await this.addLabel(id, this.labelFor('claimed'));
    await this.removeLabel(id, this.labelFor('ready'));
    await this.writeState(id, {
      schema: 1,
      runId,
      item: id,
      reviewRound: 0,
      updatedAt: new Date().toISOString(),
    });

    // Labels are not conditional on GitHub, so prove the claim with a re-read.
    const confirmed = await this.readState(id);
    if (confirmed === null || confirmed.runId !== runId) {
      return {
        item: id,
        runId,
        claimed: false,
        reason: `lost a concurrent claim to ${confirmed?.runId ?? 'an unknown run'}`,
      };
    }
    return { item: id, runId, claimed: true };
  }

  async transition(id: string, to: BoardWorkItemState, evidence: BoardTransitionEvidence): Promise<void> {
    const issue = await this.fetchIssue(id);
    const from = this.stateOf(issue);
    // The pure table decides legality before any write reaches GitHub.
    assertTransition(from, to, `requested by run ${evidence.runId}`);

    await this.addLabel(id, this.labelFor(to));
    for (const state of Object.keys(GITHUB_STATE_LABELS) as BoardWorkItemState[]) {
      if (state !== to) await this.removeLabel(id, this.labelFor(state), { ignoreMissing: true });
    }

    const existing = await this.readState(id);
    await this.writeState(id, {
      schema: 1,
      runId: existing?.runId ?? evidence.runId,
      item: id,
      reviewRound: existing?.reviewRound ?? 0,
      updatedAt: new Date().toISOString(),
      ...(evidence.note === undefined ? {} : { note: evidence.note }),
      ...(existing?.baseBranch === undefined ? {} : { baseBranch: existing.baseBranch }),
      ...(existing?.deliveryRef === undefined ? {} : { deliveryRef: existing.deliveryRef }),
    });
  }

  async comment(id: string, body: string, opts: { runId: string; author?: BoardCommentAuthor }): Promise<BoardCommentRef> {
    assertBoardCapability(this, 'comments');
    const marker = runMarker(opts.runId);
    const login = await this.authenticatedLogin();
    const existing = (await this.fetchComments(id)).find(
      (c) => (c.body ?? '').includes(marker) && c.user?.login === login,
    );
    if (existing?.id !== undefined) {
      await this.patchComment(existing.id, body, id);
      return { item: id, comment: String(existing.id), runId: opts.runId, ...(existing.html_url === undefined ? {} : { url: existing.html_url }) };
    }

    const created = await requestBoardJson<GitHubComment>(
      this.request,
      {
        method: 'POST',
        url: `${this.apiBase}/repos/${this.repo}/issues/${id}/comments`,
        body: { body: `${body}\n\n${marker}` },
      },
      'comment',
    );
    if (created.id === undefined) throw new BoardError('transport', `GitHub returned a comment without an id for ${id}`, { item: id });
    return { item: id, comment: String(created.id), runId: opts.runId, ...(created.html_url === undefined ? {} : { url: created.html_url }) };
  }

  async updateComment(ref: BoardCommentRef, body: string): Promise<void> {
    assertBoardCapability(this, 'editableComment');
    const res = await this.request({
      method: 'PATCH',
      url: `${this.apiBase}/repos/${this.repo}/issues/comments/${ref.comment}`,
      body: { body },
    });
    // A foreign or deleted comment id must fail loudly: silently accepting it
    // would leave a run believing its progress was published.
    if (res.status < 200 || res.status >= 300) throw boardErrorFromResponse(res, `updateComment ${ref.comment}`, ref.item);
  }

  async readState(id: string): Promise<BoardStateRecord | null> {
    assertBoardCapability(this, 'machineReadableState');
    const trusted = (await this.fetchComments(id)).filter((c) => this.isTrusted(c));
    return newestBoardStateRecord(trusted.map((c) => c.body ?? '').filter((body) => parseBoardStateRecord(body) !== null));
  }

  async writeState(id: string, record: BoardStateRecord): Promise<void> {
    assertBoardCapability(this, 'machineReadableState');
    if (record.item !== id) {
      throw new BoardError('precondition', `state record names item ${record.item} but was written to ${id}`, { item: id });
    }
    const block = renderBoardStateRecord(record);
    const login = await this.authenticatedLogin();
    const existing = (await this.fetchComments(id)).find(
      (c) => c.user?.login === login && parseBoardStateRecord(c.body ?? '') !== null,
    );
    if (existing?.id !== undefined) {
      await this.patchComment(existing.id, block, id);
      return;
    }
    await requestBoardJson<GitHubComment>(
      this.request,
      { method: 'POST', url: `${this.apiBase}/repos/${this.repo}/issues/${id}/comments`, body: { body: block } },
      'writeState',
    );
  }

  /** The label a state maps to. */
  labelFor(state: BoardWorkItemState): string {
    return `${this.labelPrefix}${GITHUB_STATE_LABELS[state]}`;
  }

  /**
   * Create the six state labels if the repository does not have them yet.
   *
   * This is the first minute of a real deployment: without these labels the adapter
   * cannot claim anything, and "no such label" teaches an operator nothing. Labels
   * are creatable through the API, so takumi does it rather than printing advice.
   *
   * Idempotent by construction (an existing label is reported, never re-created),
   * and the same reasoning as orbi's `align_labels`: the board's own state set is
   * infrastructure, not a manual prerequisite.
   */
  async bootstrapStates(
    desired: readonly BoardWorkItemState[],
    opts: { dryRun?: boolean } = {},
  ): Promise<BoardBootstrapReport> {
    const present = new Map<string, string>();
    const existing = await requestBoardJson<GitHubLabel[]>(
      this.request,
      { method: 'GET', url: `${this.apiBase}/repos/${this.repo}/labels?per_page=100` },
      'bootstrapStates: list labels',
    );
    for (const label of existing) {
      if (typeof label.name === 'string') present.set(label.name.toLowerCase(), label.color ?? '');
    }

    const actions: BoardBootstrapAction[] = [];
    let applied = false;
    for (const state of desired) {
      const name = this.labelFor(state);
      if (present.has(name.toLowerCase())) {
        actions.push({ state, name, outcome: 'exists' });
        continue;
      }
      if (opts.dryRun === true) {
        actions.push({ state, name, outcome: 'would-create' });
        continue;
      }
      await requestBoardJson<GitHubLabel>(
        this.request,
        {
          method: 'POST',
          url: `${this.apiBase}/repos/${this.repo}/labels`,
          // GitHub wants a hex colour without '#', so the six states share one:
          // the state is in the NAME, and six colours would imply a priority or a
          // category that takumi does not mean.
          body: { name, color: STATE_LABEL_COLOR, description: 'takumi delivery state' },
        },
        `bootstrapStates: create ${name}`,
      );
      present.set(name.toLowerCase(), STATE_LABEL_COLOR);
      applied = true;
      actions.push({ state, name, outcome: 'created' });
    }
    return {
      provider: this.metadata().id,
      applied,
      actions,
      unsupported: BOARD_WORK_ITEM_STATES.filter((state) => !this.capabilities().states.includes(state)),
    };
  }

  private async fetchIssue(id: string): Promise<GitHubIssue> {
    return requestBoardJson<GitHubIssue>(
      this.request,
      { method: 'GET', url: `${this.apiBase}/repos/${this.repo}/issues/${id}` },
      `getWork ${id}`,
    );
  }

  private async fetchComments(id: string): Promise<GitHubComment[]> {
    return requestBoardJson<GitHubComment[]>(
      this.request,
      { method: 'GET', url: `${this.apiBase}/repos/${this.repo}/issues/${id}/comments?per_page=100` },
      `comments of ${id}`,
    );
  }

  private async patchComment(commentId: number, body: string, item: string): Promise<void> {
    const res = await this.request({
      method: 'PATCH',
      url: `${this.apiBase}/repos/${this.repo}/issues/comments/${commentId}`,
      body: { body },
    });
    if (res.status < 200 || res.status >= 300) throw boardErrorFromResponse(res, `patch comment ${commentId}`, item);
  }

  private async addLabel(id: string, label: string): Promise<void> {
    const res = await this.request({
      method: 'POST',
      url: `${this.apiBase}/repos/${this.repo}/issues/${id}/labels`,
      body: { labels: [label] },
    });
    if (res.status < 200 || res.status >= 300) throw boardErrorFromResponse(res, `add label ${label}`, id);
  }

  private async removeLabel(id: string, label: string, opts: { ignoreMissing?: boolean } = {}): Promise<void> {
    const res = await this.request({
      method: 'DELETE',
      url: `${this.apiBase}/repos/${this.repo}/issues/${id}/labels/${encodeURIComponent(label)}`,
    });
    if (res.status === 404 && opts.ignoreMissing === true) return;
    if (res.status < 200 || res.status >= 300) throw boardErrorFromResponse(res, `remove label ${label}`, id);
  }

  private isTrusted(comment: GitHubComment): boolean {
    return this.trustedAssociations.has(comment.author_association ?? '');
  }

  private async authenticatedLogin(): Promise<string> {
    // Resolved once per provider: it is the only way to tell OUR progress
    // comment from a stranger's copy of the marker.
    this.loginPromise ??= requestBoardJson<{ login?: string }>(this.request, { method: 'GET', url: `${this.apiBase}/user` }, 'authenticated user').then(
      (user) => {
        if (user.login === undefined || user.login.length === 0) {
          throw new BoardError('auth', 'GitHub returned a user without a login');
        }
        return user.login;
      },
    );
    return this.loginPromise;
  }

  /**
   * The delivery state of an issue, derived from its `takumi-*` labels.
   *
   * The rule, stated once so it cannot drift: an issue carrying exactly one
   * known state label has that state; an issue carrying several (a human added
   * one by hand) is resolved in lifecycle order `blocked > merged > fix_needed >
   * pr_open > claimed > ready`, because a board that shows two columns at once
   * must resolve to the one furthest along the delivery; an issue with no
   * `takumi-*` label is `ready` only if the ready label is absent because the
   * item was never dispatched — and if it has no label at all it is not a
   * takumi item, which is an explicit error rather than a silent `ready`.
   */
  private stateOf(issue: GitHubIssue): BoardWorkItemState {
    const names = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? '')));
    const matched = (Object.keys(GITHUB_STATE_LABELS) as BoardWorkItemState[]).filter((state) =>
      names.includes(this.labelFor(state)),
    );
    if (matched.length === 0) {
      throw new BoardError(
        'precondition',
        `issue ${String(issue.number ?? '?')} carries no ${this.labelPrefix}* label, so it is not a takumi work item`,
        issue.number === undefined ? {} : { item: String(issue.number) },
      );
    }
    const order: BoardWorkItemState[] = ['blocked', 'merged', 'fix_needed', 'pr_open', 'claimed', 'ready'];
    for (const state of order) {
      if (matched.includes(state)) return state;
    }
    throw new BoardError('precondition', `issue ${String(issue.number ?? '?')} has an unresolvable state`);
  }

  /** A work item, or null when the issue cannot be resolved to a takumi state. */
  private toWorkItemOrNull(issue: GitHubIssue): BoardWorkItem | null {
    try {
      return this.toWorkItem(issue);
    } catch (e) {
      if (e instanceof BoardError && e.kind === 'precondition') return null;
      throw e;
    }
  }

  private toWorkItem(issue: GitHubIssue): BoardWorkItem {
    return {
      id: String(issue.number ?? ''),
      title: issue.title ?? '',
      body: issue.body ?? '',
      url: issue.html_url ?? '',
      state: this.stateOf(issue),
      labels: (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))),
      assignees: (issue.assignees ?? []).flatMap((a) => (a.login === undefined ? [] : [a.login])),
      updatedAt: issue.updated_at ?? new Date(0).toISOString(),
      raw: issue,
    };
  }
}

import { renderRunMarker } from '@takumi/core';

/**
 * The run marker is CORE's (`renderRunMarker`): one grammar for one thing, so a
 * board comment and a pull request body cannot drift apart. A malformed run id is
 * reported as a `precondition` through this port's own error family instead of
 * escaping as a bare Error.
 */
export function runMarker(runId: string): string {
  try {
    return renderRunMarker(runId);
  } catch (e) {
    throw new BoardError('precondition', e instanceof Error ? e.message : String(e), { cause: e });
  }
}

/** The default transport: GitHub's REST API over curl. */
export function createGitHubTransport(
  opts: { token?: string; apiBase?: string } & CurlRequestFnOptions = {},
): BoardRequestFn {
  const token = opts.token ?? process.env['GITHUB_TOKEN'];
  const { token: _token, apiBase: _apiBase, ...curl } = opts;
  void _token;
  void _apiBase;
  return createCurlRequestFn({
    headers: () => {
      const headers: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'takumi-board',
      };
      if (token !== undefined && token.length > 0) headers['Authorization'] = `Bearer ${token}`;
      return headers;
    },
    ...curl,
  });
}

export function createGitHubBoardProvider(options: GitHubBoardOptions): GitHubBoardProvider {
  return new GitHubBoardProvider(options);
}
