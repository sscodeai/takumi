/**
 * Redmine board provider — Redmine issues (+ journals) as the task board.
 *
 * WHY issues and not a Redmine agile board / plugin: an issue is the unit of work
 * a team already discusses, and it is the only Redmine object that carries BOTH
 * halves of what takumi needs — the human delivery state (the issue STATUS, i.e.
 * a real Redmine status a person changes by hand) and somewhere to keep the
 * versioned run record (a text CUSTOM FIELD). Nothing here needs an agile board,
 * a version or a plugin, so nothing here depends on a Redmine plugin tier.
 *
 * The adapter never talks to the network itself: it receives a `BoardRequestFn`
 * (see `board-transport.ts`), so the same code runs offline against a recorded
 * fake, and the default transport (`createRedmineTransport`) is the only place
 * the API key is ever touched.
 *
 * HONEST LIMITS (declared in `capabilities()`, not hidden):
 *
 * 1. `machineReadableState` is TRUE **only when a state field is configured**
 *    (`stateFieldId`, preferred, or `stateFieldName`). Redmine has no hidden
 *    comment and no issue properties, so the one place a versioned record can
 *    live out of band is a text custom field. With neither configured,
 *    `readState`/`writeState` — and therefore `claim`, whose ownership proof IS
 *    the record — fail closed as `unsupported`. Never a silent no-op.
 * 2. `trustedAuthorFilter` is TRUE **only when the caller configured
 *    `trustedAuthors`**. A Redmine journal exposes `user{id,name}` and NO
 *    association/role and no signed authorship, so with no allowlist declared the
 *    adapter genuinely cannot tell a stranger's journal from a maintainer's and
 *    says so. `comment()` is where it bites: with an allowlist only trusted
 *    journals may be adopted (or overwritten) as takumi's progress comment.
 * 3. `atomicClaim: false`. Redmine has no conditional write — no ETag/If-Match on
 *    an issue — so two workers can both issue the status write. This adapter
 *    therefore does the strongest thing the API allows: write, RE-READ the
 *    custom-field record, and accept only when the re-read attributes the item to
 *    this run. A lost race is REPORTED (`claimed: false` plus a reason), never
 *    accepted quietly.
 * 4. No delivery side at all: a Redmine issue has no pull request, no pipeline and
 *    no merge, so `delivery` is all false and a caller that needs those is told so
 *    instead of discovering it in production.
 *
 * WHY A JOURNAL CANNOT FORGE THE RUN STATE: the record is addressed by CUSTOM
 * FIELD ID/NAME, not by scanning text. A commenter (or a bot with comment rights)
 * can paste `<!-- takumi:boardstate:v1 {...} -->` into a journal and `readState`
 * will never see it, because journals are never parsed for state. The only writer
 * of the field is this integration's API key, and a caller can additionally use a
 * Redmine field-permission rule to make the field unwritable by humans.
 */

import {
  assertBoardCapability,
  assertBoardHttpOk,
  assertTransition,
  BoardError,
  BOARD_WORK_ITEM_STATES,
  createCurlRequestFn,
  parseBoardStateRecord,
  renderBoardStateRecord,
  requestBoardJson,
  unconfiguredRequestFn,
} from '@takumi/core';
import type {
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

const PROVIDER_ID = 'redmine';
const PROVIDER_VERSION = '0.1.0';

/** Environment variable holding the Redmine API key (Redmine's `X-Redmine-API-Key`). */
const API_KEY_ENV = 'REDMINE_API_KEY';

/** Redmine's own default page size; also the pagination step of `listWork`. */
const DEFAULT_PAGE_SIZE = 100;

/**
 * The delivery state a Redmine STATUS NAME represents.
 *
 * The default is the state name itself, which is almost never what a real Redmine
 * installation uses (`New`, `In Progress`, `Feedback`, `Closed`, ...): the caller
 * MUST configure real status names, and the adapter resolves them to numeric ids
 * against `/issue_statuses.json` at call time rather than guessing one.
 */
const DEFAULT_STATUS_MAP: Record<BoardWorkItemState, string> = {
  ready: 'ready',
  claimed: 'claimed',
  pr_open: 'pr_open',
  fix_needed: 'fix_needed',
  merged: 'merged',
  blocked: 'blocked',
};

/** Delivery state → Redmine status name (partial: unset states keep the default). */
export type RedmineStatusMap = Partial<Record<BoardWorkItemState, string>>;

/** Construction options for {@link RedmineBoardProvider}. */
export interface RedmineBoardOptions {
  /** Redmine origin, e.g. `https://redmine.example.com` (a sub-path install such as `https://host/redmine` is allowed). */
  baseUrl: string;
  /**
   * Restricts every list to one project; a numeric id or an identifier, both
   * accepted by Redmine's own project resource.
   *
   * CAVEAT from the official docs (Rest_Issues): the `project_id` FILTER of
   * `/issues.json` is documented as "a numeric value, not a project identifier",
   * so a slug here yields Redmine's own (empty) answer rather than a client-side
   * guess. Callers that only hold an identifier should look the numeric id up with
   * `GET /projects/<identifier>.json`.
   */
  project?: string;
  /** API key for `X-Redmine-API-Key`; falls back to `process.env.REDMINE_API_KEY`. */
  apiKey?: string;
  /** Injected transport; tests pass a fake, production uses the curl default. */
  request?: BoardRequestFn;
  /**
   * Journal author names trusted to supply progress text. Leaving it out is
   * allowed and honest: `capabilities().trustedAuthorFilter` is then false,
   * because Redmine journals carry no role to filter on.
   */
  trustedAuthors?: readonly string[];
  /** Delivery state → Redmine status name. Defaults to the state name itself. */
  statusMap?: RedmineStatusMap;
  /** Numeric id of the text custom field holding the run record (preferred over the name). */
  stateFieldId?: number;
  /** Name of that custom field, used only when `stateFieldId` is absent. */
  stateFieldName?: string;
  /** `limit` per list request, default {@link DEFAULT_PAGE_SIZE}. */
  pageSize?: number;
}

/** The subset of Redmine's issue-status JSON this adapter reads. */
interface RedmineStatusPayload {
  id?: number;
  name?: string;
  is_default?: boolean;
}

/** The subset of Redmine's custom-field JSON this adapter reads/writes. */
interface RedmineCustomFieldPayload {
  id?: number;
  name?: string;
  value?: unknown;
}

/** The subset of Redmine's journal JSON this adapter reads. */
interface RedmineJournalPayload {
  id?: number;
  notes?: string;
  user?: { id?: number; name?: string } | null;
  created_on?: string;
}

/** The subset of Redmine's issue JSON this adapter reads. */
interface RedmineIssuePayload {
  id?: number;
  subject?: string;
  description?: string;
  status?: { id?: number; name?: string } | null;
  project?: { id?: number; identifier?: string; name?: string } | null;
  assigned_to?: { id?: number; name?: string } | null;
  updated_on?: string;
  custom_fields?: RedmineCustomFieldPayload[];
  journals?: RedmineJournalPayload[];
  allowed_statuses?: Array<{ id?: number; name?: string }>;
}

/** The envelope `/issues.json` answers with. */
interface RedmineIssuePage {
  issues?: RedmineIssuePayload[];
  total_count?: number;
  offset?: number;
  limit?: number;
}

export class RedmineBoardProvider implements TaskBoardProvider {
  private readonly baseUrl: string;
  private readonly project: string | undefined;
  private readonly pageSize: number;
  private readonly statusMap: Record<BoardWorkItemState, string>;
  private readonly trustedAuthors: ReadonlySet<string> | null;
  private readonly stateFieldId: number | undefined;
  private readonly stateFieldName: string | undefined;
  private readonly request: BoardRequestFn;
  /** `/issue_statuses.json` is resolved once per provider (see `statuses()`). */
  private statusListPromise: Promise<RedmineStatusPayload[]> | undefined;

  constructor(opts: RedmineBoardOptions) {
    this.baseUrl = normaliseBaseUrl(opts.baseUrl);
    this.project = opts.project;
    const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new BoardError('precondition', `pageSize must be a positive integer, got ${String(opts.pageSize)}`);
    }
    this.pageSize = pageSize;
    this.statusMap = { ...DEFAULT_STATUS_MAP, ...opts.statusMap };
    this.trustedAuthors = opts.trustedAuthors === undefined ? null : new Set(opts.trustedAuthors);
    this.stateFieldId = opts.stateFieldId;
    this.stateFieldName = opts.stateFieldName;

    const apiKey = opts.apiKey ?? process.env[API_KEY_ENV];
    this.request =
      opts.request ??
      (apiKey !== undefined && apiKey.length > 0
        ? createRedmineTransport({ apiKey })
        : unconfiguredRequestFn(PROVIDER_ID));
  }

  metadata(): BoardProviderMetadata {
    return {
      id: PROVIDER_ID,
      name: 'Redmine Issues Board',
      version: PROVIDER_VERSION,
      description: 'Redmine issues as the task board: the delivery state is the issue status.',
    };
  }

  capabilities(): BoardCapabilities {
    return {
      states: [...BOARD_WORK_ITEM_STATES],
      comments: true,
      editableComment: true,
      // Redmine exposes no per-journal role, so a trust boundary exists only when
      // the caller names the authors it trusts. Claiming one by default would be
      // an invented signal (see the header note 2).
      trustedAuthorFilter: this.trustedAuthors !== null,
      // The run record needs a text custom field to live in; without one there is
      // nowhere out of band to store it (see the header note 1).
      machineReadableState: this.stateFieldId !== undefined || this.stateFieldName !== undefined,
      // Redmine cannot write conditionally, so the claim is read-then-write plus a
      // re-read verification (see the header note 3).
      atomicClaim: false,
      delivery: { canOpenPullRequest: false, canRunChecks: false, canMerge: false },
    };
  }

  /**
   * Open issues of the configured project, walking EVERY page Redmine reports.
   *
   * Redmine answers with `total_count`, so stopping after one page would silently
   * truncate work: offsets advance by the number of issues actually returned until
   * `total_count` is covered (or `query.limit` is reached). `status_id=open` means
   * all open statuses, which is Redmine's own vocabulary for "still available".
   */
  async listWork(query: BoardWorkQuery = {}): Promise<BoardWorkItem[]> {
    // Redmine core issues have no labels. Refusing beats returning unfiltered work
    // that looks like it honoured a filter it never applied.
    if (query.labels !== undefined && query.labels.length > 0) {
      throw new BoardError(
        'unsupported',
        'Redmine core issues carry no labels, so a label filter cannot be honoured (refusing instead of returning unfiltered work)',
      );
    }

    const wanted = new Set<BoardWorkItemState>(query.states ?? BOARD_WORK_ITEM_STATES);
    const max = query.limit ?? Number.POSITIVE_INFINITY;
    const collected: RedmineIssuePayload[] = [];
    let offset = 0;

    for (;;) {
      const page = await requestBoardJson<RedmineIssuePage>(
        this.request,
        { method: 'GET', url: this.issuesListUrl(offset) },
        `listWork offset=${offset}`,
      );
      const batch = Array.isArray(page.issues) ? page.issues : [];
      collected.push(...batch);
      const total = page.total_count;
      if (batch.length === 0 || collected.length >= max) break;
      offset += batch.length;
      if (typeof total === 'number' && Number.isFinite(total) && offset >= total) break;
    }

    const items: BoardWorkItem[] = [];
    for (const issue of collected.slice(0, max)) {
      // The list is a scope filter, not a guarantee: an issue whose status this
      // adapter cannot map is skipped rather than mis-reported, and `getWork`
      // still reports it as an explicit precondition error.
      const item = this.toWorkItemOrNull(issue);
      if (item === null || !wanted.has(item.state)) continue;
      items.push(item);
    }
    return items;
  }

  async getWork(id: string): Promise<BoardWorkItem> {
    return this.toWorkItem(await this.fetchIssue(id));
  }

  /**
   * Take ownership of one item, PROVEN by the versioned record.
   *
   * Redmine offers no conditional write, so the sequence is: read the issue, refuse
   * if the stored record names a different run or the status is not the 'ready'
   * status, then write the status AND the record in ONE `PUT` (a status change with
   * no record would leave an unowned 'claimed' item behind), then RE-READ the field
   * and accept only when it names this run. A lost race is reported, never accepted.
   *
   * The record is the whole proof of ownership, so a provider with no state field
   * cannot claim at all: it fails closed as `unsupported` instead of claiming on
   * faith.
   */
  async claim(id: string, runId: string): Promise<ClaimResult> {
    assertBoardCapability(this, 'machineReadableState');

    const issue = await this.fetchIssue(id);
    const existing = this.recordOf(issue);
    if (existing !== null && existing.runId !== runId) {
      return { item: id, runId, claimed: false, reason: `already claimed by ${existing.runId}` };
    }
    const current = this.stateOf(issue);
    if (current !== 'ready') {
      return { item: id, runId, claimed: false, reason: `item is in state ${current}, not ready` };
    }

    const record: BoardStateRecord = {
      schema: 1,
      runId,
      item: id,
      reviewRound: 0,
      updatedAt: new Date().toISOString(),
    };
    await this.putIssue(
      id,
      {
        status_id: await this.resolveStatusId(this.statusMap.claimed),
        custom_fields: [this.stateFieldEntry(issue, renderBoardStateRecord(record))],
      },
      `claim ${id}`,
    );

    // Not conditional on Redmine's side: verify the claim with a re-read.
    const confirmed = this.recordOf(await this.fetchIssue(id));
    if (confirmed === null || confirmed.runId !== runId) {
      return {
        item: id,
        runId,
        claimed: false,
        reason: `lost a concurrent claim to ${confirmed === null ? 'a run that left no record' : confirmed.runId}`,
      };
    }
    return { item: id, runId, claimed: true };
  }

  /**
   * Move the issue to the status that represents `to`, keeping the run record.
   *
   * The pure table in `board-state.ts` decides legality FIRST — before the status
   * name is even resolved — so an illegal transition mutates nothing. The status
   * id is resolved from `/issue_statuses.json` by NAME (a guessed id would either
   * 422 or move the issue somewhere nobody asked for), and the record's
   * `runId`/`reviewRound` are carried over so the delivery stays resumable.
   *
   * When `evidence.note` is set it travels in the SAME `PUT` as the status, so the
   * board never shows a status change without its explanation.
   *
   * With no state field configured the status still moves: the record merge is
   * skipped (there is nowhere to put it), while a DIRECT `readState`/`writeState`
   * call still fails closed — that gate lives on those methods.
   */
  async transition(id: string, to: BoardWorkItemState, evidence: BoardTransitionEvidence): Promise<void> {
    const issue = await this.fetchIssue(id);
    const from = this.stateOf(issue);
    assertTransition(from, to, `issue ${id}, requested by run ${evidence.runId}`);

    const fields: Record<string, unknown> = { status_id: await this.resolveStatusId(this.statusMap[to]) };
    if (evidence.note !== undefined && evidence.note.length > 0) fields['notes'] = evidence.note;
    if (this.machineReadableState()) {
      const existing = this.recordOf(issue);
      fields['custom_fields'] = [
        this.stateFieldEntry(issue, renderBoardStateRecord(recordFor(id, existing, evidence))),
      ];
    }
    await this.putIssue(id, fields, `transition ${id} -> ${to}`);
  }

  /**
   * ONE progress comment per run: the journal whose notes carry this run's hidden
   * marker is EDITED in place, otherwise a new journal is created carrying the
   * marker as its last line.
   *
   * Redmine answers a note write with 204 and no journal id, so a created journal's
   * id is READ BACK from the issue (the journal carrying this run's marker is the
   * one just created). With `trustedAuthors` configured only trusted journals are
   * considered, so a stranger cannot get their journal adopted — or worse,
   * overwritten — as takumi's progress comment.
   *
   * `opts.author` is deliberately IGNORED: Redmine attributes a journal to the API
   * key's user, so takumi cannot author as anybody else. The board's own authorship
   * is the only truth.
   */
  async comment(
    id: string,
    body: string,
    opts: { runId: string; author?: BoardCommentAuthor },
  ): Promise<BoardCommentRef> {
    assertBoardCapability(this, 'comments');
    const marker = runMarker(opts.runId);
    const issue = await this.fetchIssue(id);
    const existing = this.trustedJournals(issue.journals).find((journal) => notesOf(journal).includes(marker));
    const text = withMarker(body, marker);

    if (existing?.id !== undefined) {
      // Editing in place is the whole point of `editableComment: true`.
      assertBoardCapability(this, 'editableComment');
      await this.putJournal(String(existing.id), text, `comment on ${id}`);
      return { item: id, comment: String(existing.id), runId: opts.runId, url: this.issueUrl(id) };
    }

    await this.putIssue(id, { notes: text }, `comment on ${id}`);
    const after = await this.fetchIssue(id);
    const created = this.trustedJournals(after.journals)
      .filter((journal) => notesOf(journal).includes(marker) && journal.id !== undefined)
      .pop();
    if (created?.id === undefined) {
      throw new BoardError(
        'transport',
        `Redmine accepted a note on ${id} but no journal carrying the run marker is visible to this adapter afterwards, ` +
          `so the progress comment cannot be addressed` +
          (this.trustedAuthors === null
            ? ''
            : ` (check that trustedAuthors names the API key's own user: ${[...this.trustedAuthors].join(', ')})`),
        { item: id },
      );
    }
    return { item: id, comment: String(created.id), runId: opts.runId, url: this.issueUrl(id) };
  }

  /**
   * Edit a previously returned journal. A 404 surfaces as `BoardError('not_found')`
   * through the shared taxonomy — never as a silent success, which would make a
   * deleted progress comment look like a written one.
   *
   * The run marker is re-appended (it is infrastructure, not content): dropping it
   * would make the next `comment()` call for the same run create a SECOND progress
   * journal and break "one comment per run".
   */
  async updateComment(ref: BoardCommentRef, body: string): Promise<void> {
    assertBoardCapability(this, 'editableComment');
    await this.putJournal(ref.comment, withMarker(body, runMarker(ref.runId)), `updateComment ${ref.comment}`);
  }

  /**
   * The run record carried by the issue's text custom field, or `null` when the
   * issue holds none.
   *
   * Journals are never parsed here: state is addressed by FIELD, so public comment
   * text can never drive control flow (see the header note on forgery). A
   * present-but-corrupt block throws `BoardStateRecordError` (from core), because a
   * corrupted run must look corrupted rather than brand new.
   */
  async readState(id: string): Promise<BoardStateRecord | null> {
    assertBoardCapability(this, 'machineReadableState');
    return this.recordOf(await this.fetchIssue(id));
  }

  /**
   * Upsert the record into the text custom field (one record per item).
   *
   * With `stateFieldId` the write is a single `PUT`. When only a NAME is configured
   * the numeric id is read from the issue's own `custom_fields[]` — a Redmine
   * custom field id is per tracker/project, so guessing one is not an option; an
   * issue that does not carry that field is a `precondition` failure, reported as
   * such.
   */
  async writeState(id: string, record: BoardStateRecord): Promise<void> {
    assertBoardCapability(this, 'machineReadableState');
    if (record.item !== id) {
      throw new BoardError('precondition', `state record names item ${record.item} but was written to ${id}`, {
        item: id,
      });
    }
    const block = renderBoardStateRecord(record);
    const entry =
      this.stateFieldId === undefined
        ? this.stateFieldEntry(await this.fetchIssue(id), block)
        : { id: this.stateFieldId, value: block };
    await this.putIssue(id, { custom_fields: [entry] }, `writeState ${id}`);
  }

  // --- URLs ---------------------------------------------------------------

  /**
   * The list URL: `project_id` (when configured), `status_id=open`, the page size
   * and the offset — Redmine's own pagination parameters.
   */
  private issuesListUrl(offset: number): string {
    const params: string[] = [];
    if (this.project !== undefined) params.push(`project_id=${encodeURIComponent(this.project)}`);
    params.push('status_id=open', `limit=${this.pageSize}`, `offset=${offset}`);
    return `${this.baseUrl}/issues.json?${params.join('&')}`;
  }

  /** The issue API resource (`.json`). */
  private issueApiUrl(id: string): string {
    return `${this.baseUrl}/issues/${encodeURIComponent(id)}.json`;
  }

  /** The issue as a HUMAN sees it (the web UI path, no `.json`). */
  private issueUrl(id: string): string {
    return `${this.baseUrl}/issues/${encodeURIComponent(id)}`;
  }

  // --- I/O ----------------------------------------------------------------

  /**
   * Read one issue, always asking for `journals` (the comment thread) and
   * `allowed_statuses`.
   *
   * `journals` is required for comments. `allowed_statuses` (Redmine >= 5.0.x) is
   * the workflow context Redmine reports for this issue — which statuses its
   * tracker/status/role combination allows. It is carried for the record, but the
   * LEGALITY decision stays with the pure table (`assertTransition`), not with the
   * workflow: an adapter that second-guessed the shared state machine would be
   * worse than one that refuses. Redmine ignores an unknown `include` value, so the
   * request is harmless on older versions.
   */
  private async fetchIssue(id: string): Promise<RedmineIssuePayload> {
    return requestBoardJson<RedmineIssuePayload>(
      this.request,
      { method: 'GET', url: `${this.issueApiUrl(id)}?include=journals,allowed_statuses` },
      `getWork ${id}`,
    );
  }

  /** One issue write (`PUT /issues/:id.json`); the body carries only what changed. */
  private async putIssue(id: string, fields: Record<string, unknown>, what: string): Promise<void> {
    const response = await this.request({
      method: 'PUT',
      url: this.issueApiUrl(id),
      body: { issue: fields },
    });
    assertBoardHttpOk(response, what, id);
  }

  /** One journal edit (`PUT /journals/:id.json`). A 404 becomes `not_found`. */
  private async putJournal(journalId: string, notes: string, what: string): Promise<void> {
    const response = await this.request({
      method: 'PUT',
      url: `${this.baseUrl}/journals/${encodeURIComponent(journalId)}.json`,
      body: { journal: { notes } },
    });
    assertBoardHttpOk(response, what);
  }

  /**
   * The issue statuses Redmine knows, resolved once per provider.
   *
   * The id is never hard-coded: a status id differs per installation, and a wrong
   * one either 422s or moves the issue somewhere nobody asked for. A failed fetch
   * clears the cache, so one transport blip cannot poison every later call.
   */
  private async statuses(): Promise<RedmineStatusPayload[]> {
    const cached = this.statusListPromise;
    if (cached !== undefined) return cached;
    const pending = requestBoardJson<{ issue_statuses?: RedmineStatusPayload[] }>(
      this.request,
      { method: 'GET', url: `${this.baseUrl}/issue_statuses.json` },
      'issue statuses',
    )
      .then((body) => (Array.isArray(body.issue_statuses) ? body.issue_statuses : []))
      .catch((error: unknown) => {
        this.statusListPromise = undefined;
        throw error;
      });
    this.statusListPromise = pending;
    return pending;
  }

  /** Resolve a configured STATUS NAME to its numeric id, or fail as `unsupported`. */
  private async resolveStatusId(name: string): Promise<number> {
    const statuses = await this.statuses();
    const match = statuses.find((status) => (status.name ?? '').toLowerCase() === name.toLowerCase());
    if (match === undefined || typeof match.id !== 'number') {
      // Never guess an id: naming the available statuses is what lets an operator
      // fix their `statusMap` instead of debugging a silent no-op.
      const available = statuses
        .map((status) => status.name ?? '?')
        .filter((label) => label.length > 0)
        .join(', ');
      throw new BoardError(
        'unsupported',
        `Redmine has no issue status named ${JSON.stringify(name)} (available: ${available || 'none'})`,
      );
    }
    return match.id;
  }

  // --- state record -------------------------------------------------------

  /** True when a state field is configured, i.e. the record has somewhere to live. */
  private machineReadableState(): boolean {
    return this.stateFieldId !== undefined || this.stateFieldName !== undefined;
  }

  /** The custom field the record lives in, for READING (absent → `null`). */
  private stateField(issue: RedmineIssuePayload): RedmineCustomFieldPayload | null {
    const fields = issue.custom_fields ?? [];
    if (this.stateFieldId !== undefined) {
      return fields.find((field) => field.id === this.stateFieldId) ?? null;
    }
    const name = this.stateFieldName;
    if (name === undefined) return null;
    const wanted = name.toLowerCase();
    return fields.find((field) => (field.name ?? '').toLowerCase() === wanted) ?? null;
  }

  /**
   * The `custom_fields` entry to WRITE.
   *
   * With `stateFieldId` it is known up front. With only a NAME the id must come
   * from the issue the record belongs to (Redmine custom field ids differ per
   * project/tracker); an issue that does not carry that field fails as
   * `precondition` and says so.
   */
  private stateFieldEntry(issue: RedmineIssuePayload, value: string): { id: number; value: string } {
    if (this.stateFieldId !== undefined) return { id: this.stateFieldId, value };
    const field = this.stateField(issue);
    if (field?.id === undefined) {
      throw new BoardError(
        'precondition',
        `issue ${issue.id === undefined ? '?' : String(issue.id)} does not carry a custom field named ` +
          `${JSON.stringify(this.stateFieldName ?? '')}, so the run record cannot be addressed by name ` +
          '(add the field to the issue\'s tracker or configure stateFieldId)',
        issue.id === undefined ? {} : { item: String(issue.id) },
      );
    }
    return { id: field.id, value };
  }

  /** The raw record block in an issue's state field, or `null` when it holds none. */
  private stateBlock(issue: RedmineIssuePayload): string | null {
    const field = this.stateField(issue);
    if (field === null) return null;
    const value = field.value;
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value.trim().length === 0 ? null : value;
    // A text custom field answers with a string; anything else means the wrong
    // field was configured, which must be loud rather than silently record-less.
    throw new BoardError(
      'precondition',
      `custom field ${JSON.stringify(field.name ?? String(field.id ?? '?'))} of issue ` +
        `${issue.id === undefined ? '?' : String(issue.id)} is not a text value, so it cannot hold the run record`,
      issue.id === undefined ? {} : { item: String(issue.id) },
    );
  }

  /** The parsed record of one already-fetched issue (`null` when there is none). */
  private recordOf(issue: RedmineIssuePayload): BoardStateRecord | null {
    const block = this.stateBlock(issue);
    // Same grammar as every other board; a corrupted block throws, never null.
    return block === null ? null : parseBoardStateRecord(block);
  }

  /**
   * The trust boundary. With no allowlist configured every journal is "trusted",
   * because Redmine provides no per-journal role to filter on — which is exactly
   * why `capabilities().trustedAuthorFilter` is false in that case.
   */
  private trustedJournals(journals: readonly RedmineJournalPayload[] | undefined): RedmineJournalPayload[] {
    const all = journals ?? [];
    const allowlist = this.trustedAuthors;
    if (allowlist === null) return [...all];
    return all.filter((journal) => {
      const name = journal.user?.name;
      return typeof name === 'string' && allowlist.has(name);
    });
  }

  // --- mapping ------------------------------------------------------------

  /** An issue's delivery state, read from its Redmine status name. */
  private stateOf(issue: RedmineIssuePayload): BoardWorkItemState {
    const status = issue.status?.name ?? '';
    const entry = (Object.entries(this.statusMap) as Array<[BoardWorkItemState, string]>).find(
      ([, name]) => name.toLowerCase() === status.toLowerCase(),
    );
    if (entry === undefined) {
      throw new BoardError(
        'precondition',
        `issue ${issue.id === undefined ? '?' : String(issue.id)} is in status ${JSON.stringify(status.length === 0 ? null : status)}, ` +
          `which this adapter does not map (mapped: ${Object.values(this.statusMap).join(', ')})`,
        issue.id === undefined ? {} : { item: String(issue.id) },
      );
    }
    return entry[0];
  }

  private toWorkItemOrNull(issue: RedmineIssuePayload): BoardWorkItem | null {
    try {
      return this.toWorkItem(issue);
    } catch (e) {
      if (e instanceof BoardError && e.kind === 'precondition') return null;
      throw e;
    }
  }

  private toWorkItem(issue: RedmineIssuePayload): BoardWorkItem {
    if (issue.id === undefined) throw new BoardError('precondition', 'Redmine returned an issue without an id');
    const id = String(issue.id);
    const assignee = issue.assigned_to?.name;
    return {
      id,
      title: issue.subject ?? '',
      body: issue.description ?? '',
      url: this.issueUrl(id),
      state: this.stateOf(issue),
      // Redmine core issues have no labels: inventing one (a tracker name, say)
      // would make a `labels` filter on this item look meaningful when it is not.
      labels: [],
      assignees: typeof assignee === 'string' && assignee.length > 0 ? [assignee] : [],
      // `updated_on` is always present on a real issue; the epoch is a last-resort
      // placeholder so a malformed payload fails the contract's shape check instead
      // of crashing on `undefined`.
      updatedAt:
        typeof issue.updated_on === 'string' && issue.updated_on.length > 0
          ? issue.updated_on
          : new Date(0).toISOString(),
      raw: issue,
    };
  }
}

// --- module-private helpers ------------------------------------------------

/**
 * The hidden marker that ties one progress journal to one run. The same marker on
 * every board, so a human reading a thread recognises it and a tool can grep it.
 */
export function runMarker(runId: string): string {
  return `<!-- takumi:run=${runId} -->`;
}

/** Append the hidden marker unless the text already carries it. */
function withMarker(text: string, marker: string): string {
  return text.includes(marker) ? text : `${text}\n\n${marker}`;
}

/** A journal's notes as a string (Redmine may answer with `null`). */
function notesOf(journal: RedmineJournalPayload): string {
  return typeof journal.notes === 'string' ? journal.notes : '';
}

/**
 * The record a transition should store: this event's note, plus what is still true
 * of the delivery. `runId` and `reviewRound` are KEPT from the stored record (a
 * transition is not a re-claim), and a record that does not exist yet starts from
 * the transition's own run.
 */
function recordFor(
  id: string,
  existing: BoardStateRecord | null,
  evidence: BoardTransitionEvidence,
): BoardStateRecord {
  const record: BoardStateRecord = {
    schema: 1,
    runId: existing?.runId ?? evidence.runId,
    item: id,
    reviewRound: existing?.reviewRound ?? 0,
    updatedAt: new Date().toISOString(),
  };
  const baseBranch = existing?.baseBranch;
  if (baseBranch !== undefined) record.baseBranch = baseBranch;
  const deliveryRef = existing?.deliveryRef;
  if (deliveryRef !== undefined) record.deliveryRef = deliveryRef;
  const note = evidence.note ?? existing?.note;
  if (note !== undefined) record.note = note;
  return record;
}

/**
 * Validate and normalise the Redmine origin.
 *
 * A sub-path install (`https://host/redmine`) is deliberately accepted: Redmine is
 * commonly mounted under one, and refusing it would push operators towards a
 * rewrite rule. Trailing slashes are stripped so URL building is unambiguous.
 */
function normaliseBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new BoardError(
      'precondition',
      `baseUrl must be an http(s) origin like https://redmine.example.com, got ${JSON.stringify(raw)}`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BoardError('precondition', `baseUrl must use http or https, got ${JSON.stringify(raw)}`);
  }
  return trimmed;
}

// --- transport + factory ---------------------------------------------------

/** Transport options: the Redmine API key travels in `X-Redmine-API-Key`. */
export interface RedmineTransportOptions {
  /** Redmine API key (REST API → "API key" on the user's account page). */
  apiKey: string;
  /** Extra curl options (timeout, binary, output cap). */
  curl?: CurlRequestFnOptions;
}

/**
 * The default transport: the Redmine REST API over curl, authenticating with
 * `X-Redmine-API-Key`.
 *
 * Why curl and not a client library: it keeps every adapter dependency-free (this
 * repository ships zero HTTP clients), and `board-transport.ts` already takes care
 * of keeping the key off the process list by sending the whole request on stdin.
 */
export function createRedmineTransport(opts: RedmineTransportOptions): BoardRequestFn {
  return createCurlRequestFn({
    headers: () => ({ 'X-Redmine-API-Key': opts.apiKey, Accept: 'application/json' }),
    ...(opts.curl ?? {}),
  });
}

export function createRedmineBoardProvider(options: RedmineBoardOptions): RedmineBoardProvider {
  return new RedmineBoardProvider(options);
}

/** Re-exported so a caller can catch the pure-table rejection by name. */
export { BoardStateError } from '@takumi/core';
