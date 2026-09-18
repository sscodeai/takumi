/**
 * GitLab board provider — GitLab Issues (+ issue notes) as the task board.
 *
 * WHY issues and not GitLab's issue-board / epic APIs: an issue is the unit of
 * work a team already discusses, and it is the only GitLab object that carries
 * BOTH halves of what takumi needs — the human delivery state (labels) and the
 * note thread where the versioned state record lives. Nothing here needs a
 * project board, a milestone or a custom field, so nothing here depends on a
 * GitLab tier above Free.
 *
 * The adapter never talks to the network itself: it receives a
 * `BoardRequestFn` (see `board-transport.ts`), so the same code runs offline
 * against a recorded fake, and the default transport (`createGitLabTransport`)
 * is the only place a token is ever touched.
 *
 * HONEST LIMITS (declared in `capabilities()`, not hidden):
 *
 * 1. `atomicClaim: false`. GitLab cannot update labels conditionally: an issue
 *    PUT replaces the label set with no ETag/If-Match precondition, so two
 *    workers can both "win" the label write. This adapter therefore does the
 *    strongest thing the API allows — write, RE-READ, and accept only when the
 *    re-read attributes the item to this run. The window in which a lost race
 *    is invisible is documented next to `claim()`, never papered over.
 * 2. `trustedAuthorFilter` is TRUE **only when the caller configured
 *    `trustedAuthors`**. The issue-notes API returns a note body and an author
 *    username, but NO per-note association/role and no signed authorship — so
 *    with no allowlist declared the adapter genuinely cannot tell a stranger's
 *    note from a maintainer's, and says so. With an allowlist, only those
 *    usernames may drive control flow.
 * 3. One page per list call: the request seam exposes a status and a body but
 *    no response headers, so `X-Next-Page` pagination cannot be followed. Lists
 *    are therefore capped at 100 items per call (`per_page=100`).
 */

import {
  assertBoardHttpOk,
  assertBoardCapability,
  assertTransition,
  BoardError,
  BOARD_WORK_ITEM_STATES,
  createCurlRequestFn,
  newestBoardStateRecord,
  parseBoardStateRecord,
  renderBoardStateRecord,
  unconfiguredRequestFn,
} from '@takumi/core';
import type {
  BoardCapabilities,
  BoardCommentAuthor,
  BoardCommentRef,
  BoardHttpRequest,
  BoardProviderMetadata,
  BoardRequestFn,
  BoardStateRecord,
  BoardTransitionEvidence,
  BoardWorkItem,
  BoardWorkItemState,
  BoardWorkQuery,
  ClaimResult,
  TaskBoardProvider,
} from '@takumi/core';

const PROVIDER_ID = 'gitlab';
const PROVIDER_VERSION = '0.1.0';
const DEFAULT_API_BASE = 'https://gitlab.com/api/v4';
const DEFAULT_LABEL_PREFIX = 'takumi-';

/** GitLab's own page limit; also the ceiling of what this adapter can see (see header note 3). */
const PAGE_SIZE = 100;

/** Environment variable holding the personal/project access token. */
const TOKEN_ENV = 'GITLAB_TOKEN';

/**
 * `state → label suffix`. GitLab labels are case-sensitive free text, so the
 * mapping is explicit and prefix-configurable: a team that already uses
 * `takumi-`-prefixed labels gets the default, anyone else sets `labelPrefix`.
 */
const STATE_LABEL_SUFFIX: Readonly<Record<BoardWorkItemState, string>> = {
  ready: 'ready',
  claimed: 'claimed',
  pr_open: 'pr-open',
  fix_needed: 'fix-needed',
  merged: 'merged',
  blocked: 'blocked',
};

/**
 * Precedence when one issue carries several state labels (which GitLab happily
 * allows, and which a human can produce by hand). The order is deliberate:
 * a HUMAN decision first (`blocked`), then the most advanced delivery step, and
 * `ready` last — so a stale `takumi-ready` never silently reopens work that a
 * person blocked, and a half-applied label write never demotes a delivered
 * item back to `ready`.
 */
const STATE_LABEL_PRECEDENCE: readonly BoardWorkItemState[] = [
  'blocked',
  'merged',
  'fix_needed',
  'pr_open',
  'claimed',
  'ready',
];

/** Every state label this adapter knows is `<prefix><suffix>`. */
const STATE_LABEL_SUFFIXES: readonly string[] = Object.values(STATE_LABEL_SUFFIX);

/** Fragment shared with `board-state-record.ts`; used to spot a record note cheaply. */
const STATE_RECORD_FRAGMENT = 'takumi:boardstate:';

import { renderRunMarker } from '@takumi/core';

/**
 * The run marker is CORE's (`renderRunMarker`): one grammar for one thing, so a
 * board comment and a pull request body cannot drift apart. A malformed run id is
 * reported as a `precondition` through this port's own error family instead of
 * escaping as a bare Error.
 */
function runMarker(runId: string): string {
  try {
    return renderRunMarker(runId);
  } catch (e) {
    throw new BoardError('precondition', e instanceof Error ? e.message : String(e), { cause: e });
  }
}

/** The subset of GitLab's issue JSON this adapter reads/writes. */
interface GitLabIssuePayload {
  iid?: number;
  title?: string | null;
  description?: string | null;
  web_url?: string | null;
  state?: string | null;
  labels?: string[] | null;
  assignees?: Array<{ username?: string | null }> | null;
  updated_at?: string | null;
}

/** The subset of GitLab's note JSON this adapter reads/writes. */
interface GitLabNotePayload {
  id?: number;
  body?: string | null;
  author?: { username?: string | null } | null;
  created_at?: string | null;
}

/** Construction options for {@link GitLabBoardProvider}. */
export interface GitLabBoardOptions {
  /** URL-encoded project path, e.g. `group/project` (a numeric project id also works). */
  project: string;
  /** Prefix of the delivery-state labels. Default `takumi-`. */
  labelPrefix?: string;
  /** Access token; falls back to `process.env.GITLAB_TOKEN`. */
  token?: string;
  /** API root, default `https://gitlab.com/api/v4` (set it for self-managed GitLab). */
  apiBase?: string;
  /**
   * Usernames allowed to drive control flow (the state records takumi reads).
   * Leaving it out is allowed and honest: `capabilities().trustedAuthorFilter`
   * is then FALSE, because GitLab notes carry no trust signal of their own.
   */
  trustedAuthors?: readonly string[];
  /** Injected request seam; when absent the adapter builds the curl transport. */
  request?: BoardRequestFn;
}

/** Options for {@link createGitLabTransport}. */
export interface GitLabTransportOptions {
  /** Access token; falls back to `process.env.GITLAB_TOKEN`. */
  token?: string;
  /** Per-request timeout in seconds (default 30, applied by `curl -m`). */
  timeoutSeconds?: number;
  /** Override the curl binary (tests may point at a stub). */
  curlBinary?: string;
}

/**
 * The default transport: `curl` carrying the GitLab auth header.
 *
 * WHY the header is injected here (and not by the provider): the provider must
 * stay usable with an injected request function and ZERO credentials, so the
 * token is resolved at the one place that actually performs I/O. The header is
 * built lazily so a rotated token is picked up between calls without rebuilding
 * the provider.
 */
export function createGitLabTransport(options: GitLabTransportOptions = {}): BoardRequestFn {
  const token = options.token ?? readTokenFromEnv();
  return createCurlRequestFn({
    headers: (): Record<string, string> => (token === undefined ? {} : { 'PRIVATE-TOKEN': token }),
    ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
    ...(options.curlBinary === undefined ? {} : { curlBinary: options.curlBinary }),
  });
}

/** Read the token from the environment, treating a blank value as absent. */
function readTokenFromEnv(): string | undefined {
  const raw = process.env[TOKEN_ENV];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * GitLab Issues as a {@link TaskBoardProvider}.
 *
 * Every mutating path is: read the current delivery state from the board,
 * decide, write, and RE-READ — because GitLab has no conditional update, the
 * re-read is the only evidence that the write landed, and an unverified write
 * is exactly the kind of silent success this port exists to prevent.
 */
export class GitLabBoardProvider implements TaskBoardProvider {
  private readonly projectId: string;
  private readonly labelPrefix: string;
  private readonly apiBase: string;
  private readonly trustedAuthors: ReadonlySet<string> | null;
  private readonly request: BoardRequestFn;

  constructor(options: GitLabBoardOptions) {
    const project = options.project.trim().replace(/^\/+|\/+$/g, '');
    if (project.length === 0) {
      throw new Error('GitLabBoardProvider: `project` is required (e.g. "group/project")');
    }
    const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/g, '');
    if (apiBase.length === 0) {
      throw new Error('GitLabBoardProvider: `apiBase` must not be empty');
    }
    const labelPrefix = options.labelPrefix ?? DEFAULT_LABEL_PREFIX;
    if (labelPrefix.length === 0) {
      throw new Error('GitLabBoardProvider: `labelPrefix` must not be empty (labels would be ambiguous)');
    }

    this.projectId = encodeURIComponent(project);
    this.labelPrefix = labelPrefix;
    this.apiBase = apiBase;
    // `undefined` means "the caller declared nothing" → no trust boundary.
    this.trustedAuthors = options.trustedAuthors === undefined ? null : new Set(options.trustedAuthors);
    this.request =
      options.request ??
      (() => {
        const token = options.token ?? readTokenFromEnv();
        // Fail closed: without a token there is nothing to authenticate with,
        // and an unconfigured request is an explicit `auth` error instead of an
        // anonymous call that may leak a private project's issues.
        return token === undefined ? unconfiguredRequestFn(PROVIDER_ID) : createGitLabTransport({ token });
      })();
  }

  metadata(): BoardProviderMetadata {
    return {
      id: PROVIDER_ID,
      name: 'GitLab Issues Board',
      version: PROVIDER_VERSION,
      description: `GitLab Issues in project ${this.projectId} as the task board (labels for delivery state, notes for the versioned state record).`,
    };
  }

  capabilities(): BoardCapabilities {
    return {
      // All six: every delivery state is one label, and labels are free.
      states: [...BOARD_WORK_ITEM_STATES],
      comments: true,
      // The notes API supports PUT /issues/:iid/notes/:note_id.
      editableComment: true,
      // Only true when the caller configured an allowlist: GitLab notes expose
      // an author username but no association/role, so the adapter cannot
      // distinguish a stranger from a maintainer on its own.
      trustedAuthorFilter: this.trustedAuthors !== null,
      machineReadableState: true,
      // GitLab label updates are not conditional; see the class doc note 1.
      atomicClaim: false,
      // GitLab has merge requests and pipelines, so the delivery side is real.
      delivery: { canOpenPullRequest: true, canRunChecks: true, canMerge: true },
    };
  }

  /**
   * List open issues. `query.labels` is passed straight to GitLab's `labels`
   * parameter (comma-separated = AND, every listed label must be present);
   * `query.states` is applied locally because six states map onto six labels
   * and GitLab's parameter cannot express OR without also matching unrelated
   * issues. At most `per_page=100` items are visible per call (see class note 3).
   */
  async listWork(query: BoardWorkQuery = {}): Promise<BoardWorkItem[]> {
    const issues = await this.send<GitLabIssuePayload[]>(
      { method: 'GET', url: this.issuesUrl('opened', query.labels) },
      'listIssues',
    );
    const items = asArray(issues).map((issue) => this.toWorkItem(issue));
    const filtered =
      query.states === undefined ? items : items.filter((item) => query.states?.includes(item.state) === true);
    return query.limit === undefined ? filtered : filtered.slice(0, query.limit);
  }

  /** Read one issue; an unknown iid is GitLab's 404 → `BoardError('not_found')`. */
  async getWork(id: string): Promise<BoardWorkItem> {
    return this.toWorkItem(await this.fetchIssue(id));
  }

  /**
   * Take ownership of one issue for `runId`.
   *
   * Order of operations, and why:
   *   1. read the issue + the state record — a record naming ANOTHER run means
   *      the item is taken, and that is answered with `claimed: false` and a
   *      reason (never by throwing, never by stealing the item);
   *   2. only a `ready` item may be claimed (an item already delivered, blocked
   *      or in review is not takumi's to grab);
   *   3. one PUT swaps `ready` → `claimed` (GitLab applies add/remove in one
   *      write, so the item is never left with two state labels);
   *   4. write this run's record, then RE-READ state + record and accept only
   *      when the board attributes the item to THIS run.
   *
   * Step 4 is where the honest caveat lives: because GitLab cannot update
   * labels conditionally, two workers racing the same issue can both complete
   * step 3. The claim is therefore accepted only when the newest trusted record
   * on the item is UNIQUELY this run's.
   *   - another run's newer record → refused, and its runId is in the reason;
   *   - another run's record with the SAME timestamp → refused as a tie (both
   *     racers lose rather than both "win", because "not silently twice" beats
   *     "probably once");
   *   - the winner's record write landing after this read → the loser's claim
   *     stands, and that residual window is exactly why
   *     `capabilities().atomicClaim` is FALSE: a caller that cannot tolerate it
   *     must serialise claims itself (or trust `readState` next tick).
   */
  async claim(id: string, runId: string): Promise<ClaimResult> {
    const item = await this.getWork(id);
    const existing = await this.readState(id);

    if (existing !== null) {
      if (existing.runId === runId) {
        return {
          item: id,
          runId,
          claimed: false,
          reason: `issue ${id} is already claimed by run ${runId}: claim is not repeatable (read the state record to resume)`,
        };
      }
      return {
        item: id,
        runId,
        claimed: false,
        reason: `issue ${id} is already claimed by run ${existing.runId} (state record on the board)`,
      };
    }

    if (item.state !== 'ready') {
      return { item: id, runId, claimed: false, reason: `issue ${id} is in state ${item.state}, not ready` };
    }

    await this.putStateLabels(id, 'claimed', item.labels);
    await this.writeState(id, recordFor(id, runId, null));

    const afterWrite = await this.getWork(id);
    if (afterWrite.state !== 'claimed') {
      return {
        item: id,
        runId,
        claimed: false,
        reason: `issue ${id} did not record the claim (still ${afterWrite.state} after the label write)`,
      };
    }
    const verdict = this.claimVerdict(await this.fetchNotes(id), runId);
    if (!verdict.ok) {
      const who = verdict.tie
        ? 'another run wrote its state record at the same instant'
        : verdict.winner === null
          ? 'no trusted record for this run is on the board'
          : `the board now attributes it to run ${verdict.winner}`;
      return {
        item: id,
        runId,
        claimed: false,
        reason: `lost the claim race on issue ${id}: ${who} (GitLab cannot update labels conditionally — see capabilities().atomicClaim)`,
      };
    }
    return { item: id, runId, claimed: true };
  }

  /**
   * Move the delivery state: read the current state, check the pure transition
   * table, then swap the state label and update the run's record.
   *
   * The table check happens BEFORE any write, so an illegal transition costs
   * one read and never mutates the board. `assertTransition` throws
   * `BoardStateError` (not a `BoardError`): an illegal transition is a caller
   * bug, not a transport condition, and must not be retried.
   *
   * The label write keeps exactly ONE state label: every *other* state label the
   * issue physically carries is removed in the same PUT, so the derived state is
   * never ambiguous. `evidence.runId` is recorded verbatim; this adapter does not
   * second-guess ownership here, because the claim is the caller's token and the
   * label change is the board-visible delivery fact.
   */
  async transition(id: string, to: BoardWorkItemState, evidence: BoardTransitionEvidence): Promise<void> {
    const item = await this.getWork(id);
    assertTransition(item.state, to, `issue ${id}`);
    const existing = await this.readState(id);
    await this.putStateLabels(id, to, item.labels);
    await this.writeState(
      id,
      recordFor(id, evidence.runId, existing?.runId === evidence.runId ? existing : null, evidence.note),
    );
  }

  /**
   * One progress note per run: an existing note carrying this run's hidden
   * marker is UPDATED in place, otherwise a note is created. The marker is
   * hidden HTML, so the human-readable progress text stays clean and the note
   * keeps its identity across a long run.
   *
   * With `trustedAuthors` configured only trusted notes are considered, so a
   * stranger cannot get their note adopted (or, worse, overwritten) as takumi's
   * progress comment. Without an allowlist the marker is matched on any note —
   * impersonation is then possible but NOT silent: the update PUT is authorised
   * by token, so taking over a foreign note fails with an `auth` error.
   */
  async comment(
    id: string,
    body: string,
    opts: { runId: string; author?: BoardCommentAuthor },
  ): Promise<BoardCommentRef> {
    assertBoardCapability(this, 'comments');
    const item = await this.getWork(id);
    const notes = await this.fetchNotes(id);
    const marker = runMarker(opts.runId);
    const text = withMarker(body, marker);
    const existing = this.trustedNotes(notes).find((note) => bodyOf(note).includes(marker));

    if (existing !== undefined) {
      // Editing in place is the whole point of `editableComment: true`.
      assertBoardCapability(this, 'editableComment');
      const noteId = String(existing.id);
      await this.sendVoid(
        { method: 'PUT', url: this.noteUrl(id, noteId), body: { body: text } },
        `updateNote ${noteId} on issue ${id}`,
        id,
      );
      return { item: id, comment: noteId, runId: opts.runId, url: `${item.url}#note_${noteId}` };
    }

    const created = await this.send<GitLabNotePayload>(
      { method: 'POST', url: this.notesPath(id), body: { body: text } },
      `createNote on issue ${id}`,
      id,
    );
    if (created?.id === undefined || created.id === null) {
      throw new BoardError('transport', `createNote on issue ${id} returned no note id`, { item: id });
    }
    const noteId = String(created.id);
    return { item: id, comment: noteId, runId: opts.runId, url: `${item.url}#note_${noteId}` };
  }

  /**
   * Edit a previously returned note. A 404 surfaces as `BoardError('not_found')`
   * through the shared taxonomy — never as a silent success, which would make a
   * deleted progress note look like a written one.
   *
   * The run marker is re-appended (it is infrastructure, not content): dropping
   * it would make the next `comment()` call for the same run create a SECOND
   * progress note and break "one comment per run".
   */
  async updateComment(ref: BoardCommentRef, body: string): Promise<void> {
    assertBoardCapability(this, 'editableComment');
    await this.sendVoid(
      {
        method: 'PUT',
        url: this.noteUrl(ref.item, ref.comment),
        body: { body: withMarker(body, runMarker(ref.runId)) },
      },
      `updateNote ${ref.comment} on issue ${ref.item}`,
      ref.item,
    );
  }

  /**
   * The newest state record carried by a TRUSTED note, or `null`.
   *
   * Untrusted notes are dropped before parsing, so public text can never drive
   * control flow. A malformed block in a trusted note throws
   * `BoardStateRecordError` (from core): a corrupted run must look corrupted,
   * not like a fresh one.
   */
  async readState(id: string): Promise<BoardStateRecord | null> {
    assertBoardCapability(this, 'machineReadableState');
    return recordFromNotes(this.trustedNotes(await this.fetchNotes(id)));
  }

  /**
   * Upsert this run's own record note: the note whose hidden block carries the
   * same `runId` is replaced, otherwise a new one is created (one record note
   * per run, and `readState` returns the newest).
   *
   * `opts.author` is deliberately IGNORED: GitLab assigns a note's author from
   * the token, so takumi cannot author as anybody else. The board's own
   * authorship is the only truth — a caller wanting to *simulate* a foreign
   * write must inject a note into the transport, which is exactly what the test
   * suite does.
   */
  async writeState(id: string, record: BoardStateRecord, _opts?: { author?: BoardCommentAuthor }): Promise<void> {
    assertBoardCapability(this, 'machineReadableState');
    if (record.item !== id) {
      throw new BoardError('precondition', `state record names item ${record.item} but was written to ${id}`, {
        item: id,
      });
    }
    // No extra GET: the notes endpoint 404s for an unknown issue, so the API
    // already proves the item exists before anything is written.
    const notes = this.trustedNotes(await this.fetchNotes(id));
    const own = notes.find((note) => recordRunId(bodyOf(note)) === record.runId);
    const body = renderBoardStateRecord(record);

    if (own !== undefined) {
      const noteId = String(own.id);
      await this.sendVoid(
        { method: 'PUT', url: this.noteUrl(id, noteId), body: { body } },
        `updateStateNote ${noteId} on issue ${id}`,
        id,
      );
      return;
    }
    await this.sendVoid(
      { method: 'POST', url: this.notesPath(id), body: { body } },
      `createStateNote on issue ${id}`,
      id,
    );
  }

  // --- URL building -------------------------------------------------------

  private get issuesPath(): string {
    // The project id is the URL-ENCODED full path: `group/project` → `group%2Fproject`.
    return `${this.apiBase}/projects/${this.projectId}/issues`;
  }

  private issuesUrl(state: 'opened' | 'closed' | 'all', labels?: readonly string[]): string {
    const params = [`state=${state}`, `per_page=${PAGE_SIZE}`];
    if (labels !== undefined && labels.length > 0) {
      // Comma-separated on purpose: GitLab reads `labels=a,b` as AND (all must
      // be present), which is the only filter shape it offers.
      params.push(`labels=${labels.map((label) => encodeURIComponent(label)).join(',')}`);
    }
    return `${this.issuesPath}?${params.join('&')}`;
  }

  private issueUrl(id: string): string {
    return `${this.issuesPath}/${encodeURIComponent(id)}`;
  }

  private notesUrl(id: string): string {
    // `sort=asc` so the newest record is last, which is what
    // `newestBoardStateRecord` (and a human reading the thread) expects.
    return `${this.notesPath(id)}?per_page=${PAGE_SIZE}&sort=asc`;
  }

  /** The note collection WITHOUT the list-only query parameters (writes must not carry them). */
  private notesPath(id: string): string {
    return `${this.issueUrl(id)}/notes`;
  }

  private noteUrl(id: string, noteId: string): string {
    return `${this.issueUrl(id)}/notes/${encodeURIComponent(noteId)}`;
  }

  // --- I/O ----------------------------------------------------------------

  /** Send a request, require 2xx, and parse the JSON body. */
  private async send<T>(req: BoardHttpRequest, what: string, item?: string): Promise<T> {
    const response = await this.request(req);
    assertBoardHttpOk(response, what, item);
    try {
      return JSON.parse(response.body) as T;
    } catch (e) {
      throw new BoardError(
        'transport',
        `${what} returned a non-JSON body (HTTP ${response.status}): ${e instanceof Error ? e.message : String(e)}`,
        { ...(item === undefined ? {} : { item }) },
      );
    }
  }

  /** Send a request and only require 2xx: the body of a label/note write carries nothing we need. */
  private async sendVoid(req: BoardHttpRequest, what: string, item?: string): Promise<void> {
    assertBoardHttpOk(await this.request(req), what, item);
  }

  private async fetchIssue(id: string): Promise<GitLabIssuePayload> {
    return this.send<GitLabIssuePayload>({ method: 'GET', url: this.issueUrl(id) }, `getIssue ${id}`, id);
  }

  private async fetchNotes(id: string): Promise<GitLabNotePayload[]> {
    return asArray(await this.send<GitLabNotePayload[]>({ method: 'GET', url: this.notesUrl(id) }, `listNotes ${id}`, id));
  }

  /**
   * Replace the issue's state label: add the target and drop every OTHER state
   * label the issue physically carries (see `transition`). Both keys are always
   * sent so the request shape is stable and one write is enough.
   */
  private async putStateLabels(id: string, to: BoardWorkItemState, present: readonly string[]): Promise<void> {
    const target = this.labelFor(to);
    const remove = present.filter((label) => this.isStateLabel(label) && label !== target);
    await this.sendVoid(
      { method: 'PUT', url: this.issueUrl(id), body: { add_labels: target, remove_labels: remove.join(',') } },
      `updateLabels ${id}`,
      id,
    );
  }

  // --- vocabulary ---------------------------------------------------------

  /**
   * Who owns the item, as the trusted records prove it — the evidence a claim is
   * accepted on.
   *
   * Deliberately strict: the newest trusted record must be UNIQUELY this run's.
   * A tie (two runs writing within the same millisecond, which GitLab's
   * non-conditional label write makes possible) is a refusal for both racers,
   * because the port forbids silently succeeding twice and a coin-flip is not
   * proof. Corrupted blocks are skipped HERE — `readState` is where they are
   * loud — so a mangled note cannot wedge a claim either way.
   */
  private claimVerdict(
    notes: readonly GitLabNotePayload[],
    runId: string,
  ): { ok: true } | { ok: false; winner: string | null; tie: boolean } {
    const holders = this.trustedNotes(notes)
      .map((note) => parseRecordSafely(bodyOf(note)))
      .filter((record): record is BoardStateRecord => record !== null)
      .map((record) => ({ runId: record.runId, at: Date.parse(record.updatedAt) }))
      .filter((holder) => Number.isFinite(holder.at));
    if (holders.length === 0) return { ok: false, winner: null, tie: false };

    const newest = Math.max(...holders.map((holder) => holder.at));
    const winners = holders.filter((holder) => holder.at === newest);
    if (winners.length === 1 && winners[0]?.runId === runId) return { ok: true };
    return {
      ok: false,
      winner: winners.find((holder) => holder.runId !== runId)?.runId ?? null,
      tie: winners.length > 1,
    };
  }

  private labelFor(state: BoardWorkItemState): string {
    return `${this.labelPrefix}${STATE_LABEL_SUFFIX[state]}`;
  }

  /** True when a label is one of OUR state labels (not just any prefixed label). */
  private isStateLabel(label: string): boolean {
    if (!label.startsWith(this.labelPrefix)) return false;
    return STATE_LABEL_SUFFIXES.includes(label.slice(this.labelPrefix.length));
  }

  /**
   * The delivery state a label set represents.
   *
   * An issue with NO `takumi-*` state label is treated as `ready` — the board's
   * own intake state. A label-less issue is exactly what a person files, and
   * calling that anything other than "available for work" would invent state
   * the board never held; the label appears the moment takumi touches the item.
   * Callers that must see only takumi-owned work pass
   * `listWork({ labels: ['takumi-ready'] })`.
   */
  private stateOf(labels: readonly string[]): BoardWorkItemState {
    for (const state of STATE_LABEL_PRECEDENCE) {
      if (labels.includes(this.labelFor(state))) return state;
    }
    return 'ready';
  }

  /**
   * The trust boundary. With no allowlist configured every note is "trusted",
   * because GitLab provides no per-note signal to filter on — that is precisely
   * why `capabilities().trustedAuthorFilter` is false in that case.
   */
  private trustedNotes(notes: readonly GitLabNotePayload[]): GitLabNotePayload[] {
    const allowlist = this.trustedAuthors;
    if (allowlist === null) return [...notes];
    return notes.filter((note) => {
      const username = note.author?.username;
      return typeof username === 'string' && allowlist.has(username);
    });
  }

  private toWorkItem(issue: GitLabIssuePayload): BoardWorkItem {
    const labels = asArray(issue.labels).filter((label): label is string => typeof label === 'string');
    return {
      id: String(issue.iid ?? ''),
      title: issue.title ?? '',
      body: issue.description ?? '',
      url: issue.web_url ?? '',
      state: this.stateOf(labels),
      labels,
      assignees: asArray(issue.assignees)
        .map((assignee) => assignee.username)
        .filter((username): username is string => typeof username === 'string' && username.length > 0),
      updatedAt: issue.updated_at ?? '',
      raw: issue,
    };
  }
}

/** Build a provider with the default GitLab transport (or an injected one). */
export function createGitLabBoardProvider(options: GitLabBoardOptions): GitLabBoardProvider {
  return new GitLabBoardProvider(options);
}

// --- module-private helpers ------------------------------------------------

/** The record a write should store: this run's facts, carrying forward what is still true. */
function recordFor(
  id: string,
  runId: string,
  existing: BoardStateRecord | null,
  note?: string,
): BoardStateRecord {
  const record: BoardStateRecord = {
    schema: 1,
    runId,
    item: id,
    reviewRound: existing?.reviewRound ?? 0,
    updatedAt: new Date().toISOString(),
  };
  const baseBranch = existing?.baseBranch;
  if (baseBranch !== undefined) record.baseBranch = baseBranch;
  const deliveryRef = existing?.deliveryRef;
  if (deliveryRef !== undefined) record.deliveryRef = deliveryRef;
  const noteText = note ?? existing?.note;
  if (noteText !== undefined) record.note = noteText;
  return record;
}

/** The newest record among trusted note bodies, or `null`. */
function recordFromNotes(notes: readonly GitLabNotePayload[]): BoardStateRecord | null {
  return newestBoardStateRecord(notes.map((note) => bodyOf(note)));
}

/**
 * The `runId` of a well-formed state block in `text`, or `null`. A corrupted
 * block is ignored HERE (it must not block an upsert) — `readState` still fails
 * loudly on it, which is where it matters.
 */
function recordRunId(text: string): string | null {
  return parseRecordSafely(text)?.runId ?? null;
}

/**
 * Parse a state block without throwing: `null` when the text carries no block OR
 * carries a corrupted one. Used only on paths that must keep working (upserts,
 * claim verdicts); `readState` calls `newestBoardStateRecord` directly so that a
 * corrupted record stays loud for the port's caller.
 */
function parseRecordSafely(text: string): BoardStateRecord | null {
  if (!text.includes(STATE_RECORD_FRAGMENT)) return null;
  try {
    return parseBoardStateRecord(text);
  } catch {
    return null;
  }
}

/** A note body, normalised to a string (GitLab may return `null`). */
function bodyOf(note: GitLabNotePayload): string {
  return typeof note.body === 'string' ? note.body : '';
}

/** Append the hidden run marker unless the text already carries it. */
function withMarker(text: string, marker: string): string {
  return text.includes(marker) ? text : `${text}\n\n${marker}`;
}

/** GitLab list endpoints return `[]`; anything else (e.g. an error object) is treated as empty. */
function asArray<T>(value: T[] | null | undefined): T[];
function asArray(value: unknown): unknown[];
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
