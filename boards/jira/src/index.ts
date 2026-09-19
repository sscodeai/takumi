import {
  assertBoardCapability,
  boardErrorFromResponse,
  BoardError,
  assertTransition,
  BOARD_WORK_ITEM_STATES,
  BoardStateError,
  createCurlRequestFn,
  parseBoardStateRecord,
  renderBoardStateRecord,
  requestBoardJson,
  unconfiguredRequestFn,
} from '@takumi/core';
import type {
  BoardBootstrapAction,
  BoardBootstrapReport,
  BoardCapabilities,
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
 * JiraBoardProvider — Jira issues as the task board.
 *
 * Two Jira-specific decisions worth knowing before reading the code:
 *
 * 1. **The column is the STATUS, not a label.** A Jira workflow already owns the
 *    question "where is this issue?", so the adapter maps each of the six
 *    delivery states to a STATUS NAME (`statusMap`) and moves the issue with a
 *    workflow TRANSITION. The transition id is resolved at call time from the
 *    issue's own available transitions — a guessed id would silently do nothing.
 * 2. **The run record lives in an ISSUE PROPERTY, not a comment.** Jira renders
 *    comments as rich text, so a hidden HTML block is impossible; an issue
 *    property is takumi's own channel, carries no author, and cannot be forged
 *    by commenting. The stored payload is still the SAME versioned grammar
 *    (`renderBoardStateRecord` / `parseBoardStateRecord`) so the record stays
 *    board-agnostic.
 *
 * A Jira issue has no pull request, no pipeline and no merge: `delivery` is all
 * false, and a caller that needs those is told so instead of being left to
 * discover it in production.
 */

export type JiraStatusMap = Partial<Record<BoardWorkItemState, string>>;

export interface JiraBoardOptions {
  /** e.g. `https://your-site.atlassian.net` (no trailing slash, no `/rest/...`). */
  baseUrl: string;
  /** Restricts the default JQL to one project. */
  projectKey?: string;
  /** Explicit JQL; overrides the default built from `projectKey`. */
  jql?: string;
  /** Email for Basic auth (with `apiToken`). */
  email?: string;
  /** API token for Basic auth; falls back to `process.env.JIRA_API_TOKEN`. */
  apiToken?: string;
  /** Bearer token (alternative to email + API token); falls back to `process.env.JIRA_TOKEN`. */
  bearerToken?: string;
  /** Delivery state → Jira status name. Defaults to the state name itself. */
  statusMap?: JiraStatusMap;
  /** Author accountIds or display names allowed to supply decisions. */
  trustedAuthors?: string[];
  /** Search path; Jira Cloud is migrating `/search` → `/search/jql`. Default `/rest/api/3/search`. */
  searchPath?: string;
  /** Injected transport; tests pass a fake, production uses the curl default. */
  request?: BoardRequestFn;
}

const DEFAULT_STATUS_MAP: Record<BoardWorkItemState, string> = {
  ready: 'ready',
  claimed: 'claimed',
  pr_open: 'pr_open',
  fix_needed: 'fix_needed',
  merged: 'merged',
  blocked: 'blocked',
};

/** The issue property that carries the run record (versioned inside the block). */
export const JIRA_STATE_PROPERTY = 'takumi.boardstate.v1';

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

interface JiraIssue {
  key?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    status?: { name?: string };
    labels?: string[];
    assignee?: { displayName?: string } | null;
    updated?: string;
  };
}

interface JiraTransition {
  id?: string;
  name?: string;
  to?: { name?: string };
}

/**
 * The subset of `GET /rest/api/3/project/<key>/statuses` this adapter reads.
 *
 * Jira answers with ONE BUCKET PER ISSUE TYPE, each holding that type's statuses —
 * which is why a status name is never at the top level of this payload. An entry
 * without a bucket is tolerated as a flat status list, because that is what some
 * Jira status endpoints answer.
 */
interface JiraProjectStatus {
  id?: string;
  name?: string;
  statuses?: Array<{ id?: string; name?: string }>;
}

interface JiraComment {
  id?: string;
  body?: unknown;
  author?: { accountId?: string; displayName?: string };
}

export class JiraBoardProvider implements TaskBoardProvider {
  private readonly baseUrl: string;
  private readonly jql: string;
  private readonly projectKey: string | undefined;
  private readonly statusMap: Record<BoardWorkItemState, string>;
  private readonly trustedAuthors: Set<string> | undefined;
  private readonly searchPath: string;
  private readonly request: BoardRequestFn;
  private myselfPromise: Promise<string | undefined> | undefined;

  constructor(opts: JiraBoardOptions) {
    if (!/^https?:\/\/[^\s/]+$/.test(opts.baseUrl.replace(/\/+$/, ''))) {
      throw new BoardError('precondition', `baseUrl must be an origin like https://site.atlassian.net, got ${JSON.stringify(opts.baseUrl)}`);
    }
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.projectKey = opts.projectKey;
    this.jql = opts.jql ?? this.defaultJql();
    this.statusMap = { ...DEFAULT_STATUS_MAP, ...opts.statusMap };
    this.searchPath = opts.searchPath ?? '/rest/api/3/search';
    this.trustedAuthors = opts.trustedAuthors === undefined ? undefined : new Set(opts.trustedAuthors);

    const apiToken = opts.apiToken ?? process.env['JIRA_API_TOKEN'];
    const bearer = opts.bearerToken ?? process.env['JIRA_TOKEN'];
    this.request =
      opts.request ??
      (apiToken !== undefined && opts.email !== undefined
        ? createJiraTransport({ email: opts.email, apiToken })
        : bearer !== undefined && bearer.length > 0
          ? createJiraTransport({ bearerToken: bearer })
          : unconfiguredRequestFn('jira'));
  }

  metadata(): BoardProviderMetadata {
    return {
      id: 'jira',
      name: 'Jira Issues Board',
      version: '0.1.0',
      description: 'Jira issues as the task board: the delivery state is the workflow status.',
    };
  }

  capabilities(): BoardCapabilities {
    return {
      states: ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked'],
      comments: true,
      editableComment: true,
      // Jira exposes no per-comment role, so a trust boundary exists only when
      // the caller names the authors it trusts. Claiming one by default would be
      // an invented signal.
      trustedAuthorFilter: this.trustedAuthors !== undefined,
      // The run record is an issue property: machine-readable and written only
      // through this integration.
      machineReadableState: true,
      // Jira transitions are not conditional on a value we control, so the claim
      // is read-then-write plus a re-read verification.
      atomicClaim: false,
      // A Jira status belongs to a WORKFLOW, and creating one is administration
      // (or a workflow-scheme edit), not an API call this adapter may make. So the
      // honest answer is false, and `bootstrapStates()` only REPORTS.
      canBootstrapStates: false,
      delivery: { canOpenPullRequest: false, canRunChecks: false, canMerge: false },
    };
  }

  async listWork(query: BoardWorkQuery = {}): Promise<BoardWorkItem[]> {
    const states: BoardWorkItemState[] = query.states === undefined ? ['ready'] : [...query.states];
    const wanted = new Set(states);
    const result = await requestBoardJson<{ issues?: JiraIssue[] }>(
      this.request,
      {
        method: 'POST',
        url: `${this.baseUrl}${this.searchPath}`,
        body: {
          jql: this.scopedJql(states),
          fields: ['summary', 'description', 'status', 'labels', 'assignee', 'updated'],
          maxResults: query.limit ?? 100,
        },
      },
      'listWork',
    );
    const items: BoardWorkItem[] = [];
    for (const issue of result.issues ?? []) {
      const item = this.toWorkItemOrNull(issue);
      // The search is a scope filter (JQL), not a guarantee: an issue whose
      // status this adapter cannot map is skipped rather than mis-reported, and
      // getWork still reports it as an explicit precondition error.
      if (item === null || !wanted.has(item.state)) continue;
      if (query.labels !== undefined && !query.labels.every((label) => item.labels.includes(label))) continue;
      items.push(item);
    }
    return items;
  }

  async getWork(id: string): Promise<BoardWorkItem> {
    const issue = await this.fetchIssue(id);
    return this.toWorkItem(issue);
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

    await this.applyStatus(id, 'claimed');
    await this.writeState(id, {
      schema: 1,
      runId,
      item: id,
      reviewRound: 0,
      updatedAt: new Date().toISOString(),
    });

    // Not conditional on Jira's side: verify the claim with a re-read.
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
    // The pure table decides legality before any write reaches Jira.
    assertTransition(from, to, `requested by run ${evidence.runId}`);

    await this.applyStatus(id, to);

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
    const accountId = await this.authenticatedAccountId();
    const existing = (await this.fetchComments(id)).find(
      (c) => adfToText(c.body).includes(marker) && (accountId === undefined || c.author?.accountId === accountId),
    );
    const adf = textToAdf(`${body}\n\n${marker}`);

    if (existing?.id !== undefined) {
      await requestBoardJson<JiraComment>(
        this.request,
        { method: 'PUT', url: `${this.baseUrl}/rest/api/3/issue/${id}/comment/${existing.id}`, body: { body: adf } },
        `comment on ${id}`,
      );
      return { item: id, comment: existing.id, runId: opts.runId };
    }

    const created = await requestBoardJson<JiraComment>(
      this.request,
      { method: 'POST', url: `${this.baseUrl}/rest/api/3/issue/${id}/comment`, body: { body: adf } },
      `comment on ${id}`,
    );
    if (created.id === undefined) {
      throw new BoardError('transport', `Jira returned a comment without an id for ${id}`, { item: id });
    }
    return { item: id, comment: created.id, runId: opts.runId };
  }

  async updateComment(ref: BoardCommentRef, body: string): Promise<void> {
    assertBoardCapability(this, 'editableComment');
    const res = await this.request({
      method: 'PUT',
      url: `${this.baseUrl}/rest/api/3/issue/${ref.item}/comment/${ref.comment}`,
      body: { body: textToAdf(body) },
    });
    // A foreign or deleted comment must fail loudly, never look like progress.
    if (res.status < 200 || res.status >= 300) throw boardErrorFromResponse(res, `updateComment ${ref.comment}`, ref.item);
  }

  async readState(id: string): Promise<BoardStateRecord | null> {
    assertBoardCapability(this, 'machineReadableState');
    const res = await this.request({
      method: 'GET',
      url: `${this.baseUrl}/rest/api/3/issue/${id}/properties/${JIRA_STATE_PROPERTY}`,
    });
    // No property yet is a normal state, not a failure.
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) throw boardErrorFromResponse(res, `readState ${id}`, id);
    // Jira wraps a property as {"key": ..., "value": {...}} — the record lives
    // inside `value`, and reading the top level would make every run look new.
    const property = parseJsonObject(res.body, `readState ${id}`);
    const value = property['value'];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new BoardError('precondition', `issue property ${JIRA_STATE_PROPERTY} of ${id} carries no value object`, { item: id });
    }
    const block = (value as Record<string, unknown>)['block'];
    if (typeof block !== 'string' || block.length === 0) {
      throw new BoardError('precondition', `issue property ${JIRA_STATE_PROPERTY} of ${id} carries no record block`, { item: id });
    }
    // Same grammar as every other board; a corrupted block throws, never null.
    return parseBoardStateRecord(block);
  }

  async writeState(id: string, record: BoardStateRecord): Promise<void> {
    assertBoardCapability(this, 'machineReadableState');
    if (record.item !== id) {
      throw new BoardError('precondition', `state record names item ${record.item} but was written to ${id}`, { item: id });
    }
    const res = await this.request({
      method: 'PUT',
      url: `${this.baseUrl}/rest/api/3/issue/${id}/properties/${JIRA_STATE_PROPERTY}`,
      body: { block: renderBoardStateRecord(record) },
    });
    if (res.status < 200 || res.status >= 300) throw boardErrorFromResponse(res, `writeState ${id}`, id);
  }

  /**
   * Report which of the delivery states this Jira PROJECT can express.
   *
   * Jira keeps statuses in a WORKFLOW, and creating one is administration (or a
   * workflow-scheme edit), not an API call this adapter may make — so
   * `canBootstrapStates` is false and this is a READ-ONLY report, never a write.
   * It answers the question the first minute of a deployment actually has: "which
   * of the statuses this adapter's `statusMap` names does this project not have
   * yet?". The status names are taken from the adapter's OWN `statusMap` (a second
   * mapping would drift), and they are compared the way the rest of this adapter
   * compares them — case-insensitively.
   *
   * Nothing here throws for a state the project is missing: `not-creatable` plus an
   * instruction naming the exact status to add IS the answer, because the error
   * this port exists to abolish was a runner dying with "no such status" while the
   * operator had nothing to act on.
   *
   * A dry run is deliberately the SAME call: a report cannot change the project, so
   * `applied` is false either way.
   */
  async bootstrapStates(
    desired: readonly BoardWorkItemState[],
    _opts?: { dryRun?: boolean },
  ): Promise<BoardBootstrapReport> {
    const provider = this.metadata().id;
    const unsupported = BOARD_WORK_ITEM_STATES.filter((state) => !this.capabilities().states.includes(state));
    const projectKey = this.projectKey;

    // With no project configured there is no status list to read and no workflow to
    // name, so every state is a configuration gap the operator is told about
    // instead of a thrown error (and no request is made at all).
    if (projectKey === undefined) {
      const actions: BoardBootstrapAction[] = desired.map((state) => ({
        state,
        name: this.statusMap[state],
        outcome: 'not-creatable',
        instruction:
          `no Jira project is configured, so this adapter cannot tell which statuses are available: ` +
          `pass projectKey (and, once status ${JSON.stringify(this.statusMap[state])} exists in the project's ` +
          `workflow, the statusMap entry for state ${JSON.stringify(state)})`,
      }));
      return { provider, applied: false, actions, unsupported };
    }

    const available = await this.projectStatusNames(projectKey);
    const actions: BoardBootstrapAction[] = desired.map((state) => {
      const name = this.statusMap[state];
      if (available.has(name.toLowerCase())) return { state, name, outcome: 'exists' };
      return {
        state,
        name,
        outcome: 'not-creatable',
        instruction:
          `Jira reports no status named ${JSON.stringify(name)} in project ${projectKey}, so state ` +
          `${JSON.stringify(state)} cannot be represented: add that status to the project's workflow in Jira ` +
          `administration (Project settings → Issues → Workflows, or the workflow scheme the project uses), then ` +
          `this adapter's statusMap must name it — Jira statuses cannot be created through the REST API`,
      };
    });
    return { provider, applied: false, actions, unsupported };
  }

  /**
   * The STATUS NAMES a project offers, lowercased for the case-insensitive
   * comparison this adapter already uses in `stateOf`/`applyStatus`.
   *
   * Jira answers `GET /rest/api/3/project/<key>/statuses` as one bucket per ISSUE
   * TYPE, each holding that type's statuses; an entry carrying no bucket is taken as
   * a status itself (see {@link JiraProjectStatus}).
   */
  private async projectStatusNames(projectKey: string): Promise<Set<string>> {
    const payload = await requestBoardJson<JiraProjectStatus[]>(
      this.request,
      { method: 'GET', url: `${this.baseUrl}/rest/api/3/project/${encodeURIComponent(projectKey)}/statuses` },
      `project statuses of ${projectKey}`,
    );
    const names = new Set<string>();
    for (const entry of Array.isArray(payload) ? payload : []) {
      const bucket = entry.statuses;
      if (Array.isArray(bucket)) {
        for (const status of bucket) {
          if (typeof status?.name === 'string' && status.name.length > 0) names.add(status.name.toLowerCase());
        }
        continue;
      }
      if (typeof entry.name === 'string' && entry.name.length > 0) names.add(entry.name.toLowerCase());
    }
    return names;
  }

  /** Move the issue to the status that represents `to`, via a real transition. */
  private async applyStatus(id: string, to: BoardWorkItemState): Promise<void> {
    const target = this.statusMap[to];
    const available = await requestBoardJson<{ transitions?: JiraTransition[] }>(
      this.request,
      { method: 'GET', url: `${this.baseUrl}/rest/api/3/issue/${id}/transitions` },
      `transitions of ${id}`,
    );
    const match = (available.transitions ?? []).find(
      (t) => (t.to?.name ?? '').toLowerCase() === target.toLowerCase() || (t.name ?? '').toLowerCase() === target.toLowerCase(),
    );
    if (match?.id === undefined) {
      // Never guess a transition id: a wrong one either 400s or moves the issue
      // somewhere nobody asked for.
      const names = (available.transitions ?? []).flatMap((t) => (t.to?.name === undefined ? [] : [t.to.name]));
      throw new BoardError(
        'unsupported',
        `issue ${id} has no transition to status ${JSON.stringify(target)} (available: ${names.join(', ') || 'none'})`,
        { item: id },
      );
    }
    const res = await this.request({
      method: 'POST',
      url: `${this.baseUrl}/rest/api/3/issue/${id}/transitions`,
      body: { transition: { id: match.id } },
    });
    if (res.status < 200 || res.status >= 300) throw boardErrorFromResponse(res, `transition ${id} → ${target}`, id);
  }

  private async fetchIssue(id: string): Promise<JiraIssue> {
    return requestBoardJson<JiraIssue>(
      this.request,
      {
        method: 'GET',
        url: `${this.baseUrl}/rest/api/3/issue/${id}?fields=summary,description,status,labels,assignee,updated`,
      },
      `getWork ${id}`,
    );
  }

  private async fetchComments(id: string): Promise<JiraComment[]> {
    const result = await requestBoardJson<{ comments?: JiraComment[] }>(
      this.request,
      { method: 'GET', url: `${this.baseUrl}/rest/api/3/issue/${id}/comment?maxResults=100&orderBy=created` },
      `comments of ${id}`,
    );
    return result.comments ?? [];
  }

  private async authenticatedAccountId(): Promise<string | undefined> {
    this.myselfPromise ??= requestBoardJson<{ accountId?: string }>(
      this.request,
      { method: 'GET', url: `${this.baseUrl}/rest/api/3/myself` },
      'authenticated user',
    ).then((me) => me.accountId);
    return this.myselfPromise;
  }

  private defaultJql(): string {
    return this.projectKey === undefined
      ? 'statusCategory != Done ORDER BY created ASC'
      : `project = ${this.projectKey} AND statusCategory != Done ORDER BY created ASC`;
  }

  /** Narrow the JQL to the mapped status names of the requested states. */
  private scopedJql(states: BoardWorkItemState[]): string {
    const names = states.map((state) => this.statusMap[state]).filter((name) => name.length > 0);
    const quoted = names.map((name) => `"${name.replace(/"/g, '\\"')}"`).join(', ');
    if (quoted.length === 0) return this.jql;
    return `${this.jql.includes(' AND ') || this.jql.includes(' WHERE ') ? this.jql : this.jql} AND status in (${quoted})`;
  }

  /** An issue's delivery state, read from its workflow status. */
  private stateOf(issue: JiraIssue): BoardWorkItemState {
    const status = issue.fields?.status?.name;
    const entry = Object.entries(this.statusMap).find(([, name]) => name.toLowerCase() === (status ?? '').toLowerCase());
    if (entry === undefined) {
      throw new BoardError(
        'precondition',
        `issue ${issue.key ?? '?'} is in status ${JSON.stringify(status ?? null)}, which this adapter does not map ` +
          `(mapped: ${Object.values(this.statusMap).join(', ')})`,
        issue.key === undefined ? {} : { item: issue.key },
      );
    }
    return entry[0] as BoardWorkItemState;
  }

  private toWorkItemOrNull(issue: JiraIssue): BoardWorkItem | null {
    try {
      return this.toWorkItem(issue);
    } catch (e) {
      if (e instanceof BoardError && e.kind === 'precondition') return null;
      throw e;
    }
  }

  private toWorkItem(issue: JiraIssue): BoardWorkItem {
    if (issue.key === undefined) throw new BoardError('precondition', 'Jira returned an issue without a key');
    return {
      id: issue.key,
      title: issue.fields?.summary ?? '',
      body: issue.fields?.description === undefined ? '' : adfToText(issue.fields.description),
      url: `${this.baseUrl}/browse/${issue.key}`,
      state: this.stateOf(issue),
      labels: issue.fields?.labels ?? [],
      assignees: issue.fields?.assignee?.displayName === undefined ? [] : [issue.fields.assignee.displayName],
      updatedAt: issue.fields?.updated ?? new Date(0).toISOString(),
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

/** Flatten a Jira ADF document (or a legacy string) into plain text. */
export function adfToText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body === null || typeof body !== 'object') return '';
  const node = body as AdfNode;
  if (typeof node.text === 'string') return node.text;
  const children = node.content ?? [];
  // A document's block nodes are lines: join with a single newline and KEEP the
  // empty ones, because an empty paragraph is how ADF spells a blank line.
  // Inline nodes are concatenated (a paragraph's spans form one sentence).
  if (node.type === 'doc') return children.map(adfToText).join('\n');
  return children.map(adfToText).filter((text) => text.length > 0).join('');
}

/** Build the ADF document for plain text: one paragraph per line. */
export function textToAdf(text: string): AdfNode {
  const lines = text.split('\n');
  return {
    type: 'doc',
    version: 1,
    content: lines.map((line) => ({
      type: 'paragraph',
      content: line.length === 0 ? [] : [{ type: 'text', text: line }],
    })),
  } as AdfNode;
}

function parseJsonObject(body: string, what: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    throw new BoardError('transport', `${what} returned a non-object JSON body: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Transport options: Jira Cloud takes either Basic (email + API token) or a Bearer token. */
export type JiraTransportOptions = ({ email: string; apiToken: string } | { bearerToken: string }) & {
  /** Extra curl options (timeout, binary, output cap). */
  curl?: CurlRequestFnOptions;
};

/** The default transport: Jira Cloud REST v3 over curl. */
export function createJiraTransport(opts: JiraTransportOptions): BoardRequestFn {
  const authorization =
    'bearerToken' in opts
      ? `Bearer ${opts.bearerToken}`
      : `Basic ${Buffer.from(`${opts.email}:${opts.apiToken}`, 'utf8').toString('base64')}`;
  return createCurlRequestFn({
    headers: () => ({ Authorization: authorization, Accept: 'application/json' }),
    ...(opts.curl ?? {}),
  });
}

export function createJiraBoardProvider(options: JiraBoardOptions): JiraBoardProvider {
  return new JiraBoardProvider(options);
}

/** Re-exported so a caller can catch the pure-table rejection by name. */
export { BoardStateError };
