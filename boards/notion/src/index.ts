import {
  assertBoardCapability,
  boardErrorFromResponse,
  BoardError,
  assertTransition,
  BoardUnsupportedError,
  BOARD_WORK_ITEM_STATES,
  createCurlRequestFn,
  parseBoardStateRecord,
  renderBoardStateRecord,
  renderRunMarker,
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
 * The run marker is CORE's (`renderRunMarker`): one grammar for one thing, so a
 * Notion comment and a pull request body stay greppable alike. A malformed run id
 * surfaces as this port's own `precondition` instead of a bare Error.
 */
function runMarker(runId: string): string {
  try {
    return renderRunMarker(runId);
  } catch (e) {
    throw new BoardError('precondition', e instanceof Error ? e.message : String(e), { cause: e });
  }
}

/**
 * NotionBoardProvider — a Notion DATABASE used as the task board.
 *
 * This adapter exists to keep the abstraction honest. GitHub, GitLab and Jira
 * are one SHAPE: labels or statuses, comment threads, pull requests. A Notion
 * database is not:
 *
 *   - the board column is a `select` (or `status`) property, not a label;
 *   - comments are append-only (no PATCH /v1/comments), so a run cannot keep ONE
 *     progress comment (editableComment: false) — a caller must publish
 *     milestones rather than a heartbeat, or it floods the page feed;
 *   - there is no pull request, no pipeline and no merge, so `delivery` is all
 *     false and a caller that needs them gets a BoardUnsupportedError instead of
 *     a silent no-op;
 *   - a comment carries `created_by` (a user id) only: Notion exposes no
 *     role/association, so `trustedAuthorFilter` is false. The adapter says so
 *     rather than pretending it can tell a maintainer from a passer-by.
 *   - the column's OPTIONS are reported but never created
 *     (`canBootstrapStates: false`): adding one means PATCHing the property with
 *     the WHOLE options array, which rewrites a human's curated list and races
 *     with anyone editing that property in the Notion UI. `bootstrapStates()`
 *     therefore answers `not-creatable` with the exact UI step — the first
 *     minute of a deployment must produce instructions, not a "no such option"
 *     error, and not a silent concurrent write either.
 *
 * The run state record keeps the SAME versioned grammar as every other adapter
 * (renderBoardStateRecord / parseBoardStateRecord); only its storage differs —
 * a rich-text property instead of a hidden comment block. The storage is
 * board-specific, the contract is not.
 */

/** State → Notion column option name. Defaults to the state name itself. */
export type NotionStateMap = Partial<Record<BoardWorkItemState, string>>;

export interface NotionBoardOptions {
  /** The Notion database id, UUID or app URL. */
  databaseId: string;
  /** Bearer token; falls back to `process.env.NOTION_TOKEN`. */
  token?: string;
  /** API base, overridable for tests and proxies. Default `https://api.notion.com/v1`. */
  apiBase?: string;
  /** Property holding the title. Default `Name`. */
  titleProperty?: string;
  /** Property holding the run state record (rich_text). Default `Takumi State`. */
  stateProperty?: string;
  /** Property holding the column (select or status). Default `Status`. */
  columnProperty?: string;
  /** Optional multi_select property exposed as `BoardWorkItem.labels`. */
  labelsProperty?: string;
  /** Column option names, when they differ from the state names. */
  stateMap?: NotionStateMap;
  /** Injected transport; tests pass a fake, production uses the curl default. */
  request?: BoardRequestFn;
}

const DEFAULT_STATE_MAP: Record<BoardWorkItemState, string> = {
  ready: 'ready',
  claimed: 'claimed',
  pr_open: 'pr_open',
  fix_needed: 'fix_needed',
  merged: 'merged',
  blocked: 'blocked',
};

/** Notion's per-run limit for one rich_text value. */
const MAX_RICH_TEXT_LENGTH = 2000;

interface NotionRich {
  plain_text?: string;
}

interface NotionProperty {
  type?: string;
  title?: NotionRich[];
  rich_text?: NotionRich[];
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  multi_select?: Array<{ name?: string }>;
}

interface NotionPage {
  id: string;
  url?: string;
  last_edited_time?: string;
  properties?: Record<string, NotionProperty>;
}

interface NotionComment {
  id: string;
  created_by?: { id?: string };
  rich_text?: NotionRich[];
}

/**
 * The subset of Notion's DATABASE JSON this adapter reads.
 *
 * Only the column property's OPTIONS matter here: `bootstrapStates()` asks which
 * option names exist, and whether the property exists at all (`undefined` means
 * it does not, which is a different instruction for the operator).
 */
interface NotionDatabaseProperty {
  type?: string;
  select?: { options?: Array<{ name?: string }> } | null;
  status?: { options?: Array<{ name?: string }> } | null;
}

interface NotionDatabase {
  id?: string;
  properties?: Record<string, NotionDatabaseProperty>;
}

export class NotionBoardProvider implements TaskBoardProvider {
  private readonly databaseId: string;
  private readonly apiBase: string;
  private readonly titleProperty: string;
  private readonly stateProperty: string;
  private readonly columnProperty: string;
  private readonly labelsProperty: string | undefined;
  private readonly stateMap: Record<BoardWorkItemState, string>;
  private readonly request: BoardRequestFn;
  /** Learned from the first page read; `select` is the documented default. */
  private columnType: 'select' | 'status' = 'select';

  constructor(opts: NotionBoardOptions) {
    this.databaseId = normalizeDatabaseId(opts.databaseId);
    this.apiBase = (opts.apiBase ?? 'https://api.notion.com/v1').replace(/\/+$/, '');
    this.titleProperty = opts.titleProperty ?? 'Name';
    this.stateProperty = opts.stateProperty ?? 'Takumi State';
    this.columnProperty = opts.columnProperty ?? 'Status';
    this.labelsProperty = opts.labelsProperty;
    this.stateMap = { ...DEFAULT_STATE_MAP, ...opts.stateMap };
    const token = opts.token ?? process.env['NOTION_TOKEN'];
    // Fail closed like every other adapter: without a token there is nothing to
    // authenticate with, so an accidental call must be an explicit `auth` error
    // instead of an unauthenticated request that leaks a workspace's pages.
    this.request =
      opts.request ??
      (token === undefined || token.length === 0
        ? unconfiguredRequestFn('notion')
        : createNotionTransport({ token, apiBase: this.apiBase }));
  }

  metadata(): BoardProviderMetadata {
    return {
      id: 'notion',
      name: 'Notion Database Board',
      version: '0.1.0',
      description: 'A Notion database as the task board: the column is a select/status property.',
    };
  }

  capabilities(): BoardCapabilities {
    return {
      states: ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked'],
      comments: true,
      editableComment: false,
      trustedAuthorFilter: false,
      machineReadableState: true,
      atomicClaim: false,
      // Honest and deliberate: the column options are NOT creatable from here
      // without rewriting the whole options array behind a human's back (see the
      // class doc). `bootstrapStates()` reports what is missing, with the UI step.
      canBootstrapStates: false,
      delivery: { canOpenPullRequest: false, canRunChecks: false, canMerge: false },
    };
  }

  async listWork(query: BoardWorkQuery = {}): Promise<BoardWorkItem[]> {
    const states: readonly BoardWorkItemState[] = query.states ?? ['ready'];
    const body: Record<string, unknown> = { page_size: query.limit ?? 100 };
    const filter = buildColumnFilter(
      this.columnProperty,
      states.map((s) => this.stateMap[s]),
    );
    if (filter !== undefined) body['filter'] = filter;

    const result = await requestBoardJson<{ results?: NotionPage[] }>(
      this.request,
      { method: 'POST', url: `${this.apiBase}/databases/${this.databaseId}/query`, body },
      'listWork',
    );
    const items = (result.results ?? []).map((page) => this.toWorkItem(page));
    if (query.labels === undefined) return items;
    return items.filter((item) => query.labels?.every((label) => item.labels.includes(label)));
  }

  async getWork(id: string): Promise<BoardWorkItem> {
    return this.toWorkItem(await this.fetchPage(id));
  }

  async claim(id: string, runId: string): Promise<ClaimResult> {
    const page = await this.fetchPage(id);
    const existing = this.readRecord(page);
    if (existing !== null && existing.runId !== runId) {
      return { item: id, runId, claimed: false, reason: `already claimed by ${existing.runId}` };
    }
    const current = this.readColumn(page);
    if (current !== 'ready') {
      return { item: id, runId, claimed: false, reason: `item is in state ${current}, not ready` };
    }

    await this.patchPage(id, this.columnPatch('claimed'), 'claim');
    await this.writeState(id, {
      schema: 1,
      runId,
      item: id,
      reviewRound: 0,
      updatedAt: new Date().toISOString(),
    });

    // Notion offers no conditional update, so the claim is read-then-write plus
    // a re-read verification: losing the race must be visible, never silent.
    const confirmed = this.readRecord(await this.fetchPage(id));
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
    const page = await this.fetchPage(id);
    const from = this.readColumn(page);
    // The pure table decides legality, before any request is sent.
    assertTransition(from, to, `requested by run ${evidence.runId}`);

    await this.patchPage(id, this.columnPatch(to), `transition ${from}→${to}`);
    const existing = this.readRecord(page);
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
    const created = await requestBoardJson<NotionComment>(
      this.request,
      {
        method: 'POST',
        url: `${this.apiBase}/comments`,
        body: {
          parent: { page_id: id },
          // The marker comes from core, not a local template: one grammar for one
          // thing, so a Notion comment and a pull request body stay greppable alike.
          rich_text: [{ type: 'text', text: { content: `${body}\n\n${runMarker(opts.runId)}` } }],
        },
      },
      'comment',
    );
    return { item: id, comment: created.id, runId: opts.runId };
  }

  async updateComment(ref: BoardCommentRef, body: string): Promise<void> {
    // Gated, not silently ignored: a caller that needs an editable comment must
    // choose a board that has one (GitHub, GitLab, Jira).
    void ref;
    void body;
    throw new BoardUnsupportedError(
      'editableComment',
      'notion',
      'Notion comments are append-only; publish milestones instead of patching progress',
    );
  }

  async readState(id: string): Promise<BoardStateRecord | null> {
    assertBoardCapability(this, 'machineReadableState');
    return this.readRecord(await this.fetchPage(id));
  }

  async writeState(id: string, record: BoardStateRecord): Promise<void> {
    assertBoardCapability(this, 'machineReadableState');
    if (record.item !== id) {
      throw new BoardError('precondition', `state record names item ${record.item} but was written to ${id}`, { item: id });
    }
    const block = renderBoardStateRecord(record);
    if (block.length > MAX_RICH_TEXT_LENGTH) {
      throw new BoardError(
        'precondition',
        `state record is ${block.length} chars, over Notion's ${MAX_RICH_TEXT_LENGTH}-char rich_text limit`,
      );
    }
    await this.patchPage(
      id,
      { [this.stateProperty]: { rich_text: [{ type: 'text', text: { content: block } }] } },
      'writeState',
    );
  }

  /**
   * The other delivery operations are not in the port yet (M2); the flags in
   * `capabilities().delivery` are what a caller must consult before asking. */

  /**
   * Report how this database stands against the states the adapter needs.
   * READ-ONLY, because `canBootstrapStates` is false: the report is the answer.
   *
   * WHY nothing is created here: an option lives in the column property, and
   * `PATCH /v1/databases/:id` replaces the WHOLE options array. A write would
   * therefore rewrite options a human curated, and it races with anyone editing
   * that property in the Notion UI — the loser is silently overwritten, with no
   * version/precondition to detect it. Notion's own UI makes the change visible
   * to the person who owns the database, so the instruction is both safer and
   * more honest than a write that pretends to be safe.
   *
   * A missing OPTION and a missing PROPERTY need different instructions, so the
   * database read decides which one this board needs. Neither is an error: this
   * never throws for something the operator can fix, and it never reports
   * `created`/`would-create` — the capability flag above forbids pretending.
   *
   * `opts.dryRun` changes nothing here by construction: the call reads one
   * database and writes nothing, so a dry run and a real call are the same
   * report. It is accepted (and ignored) because the port defines it, and the
   * suite calls both.
   */
  async bootstrapStates(
    desired: readonly BoardWorkItemState[],
    _opts: { dryRun?: boolean } = {},
  ): Promise<BoardBootstrapReport> {
    const database = await requestBoardJson<NotionDatabase>(
      this.request,
      { method: 'GET', url: `${this.apiBase}/databases/${this.databaseId}` },
      'bootstrapStates',
    );
    const property = database.properties?.[this.columnProperty];
    const options = new Set(columnOptionNames(property));
    // The database retrieve is the authoritative source for the property's type;
    // learn it the same way a page read does (see readColumn) so a later patch
    // sends `status` when the board uses a status column.
    if (property?.type === 'select' || property?.type === 'status') this.columnType = property.type;

    const isColumn = property?.type === 'select' || property?.type === 'status';
    const actions: BoardBootstrapAction[] = desired.map((state) => {
      // The option name comes from THIS instance's own state map — never a second
      // copy of the vocabulary that could drift from what `transition()` writes.
      const name = this.stateMap[state];
      if (options.has(name)) return { state, name, outcome: 'exists' };
      return {
        state,
        name,
        outcome: 'not-creatable',
        instruction: isColumn
          ? `add an option named ${JSON.stringify(name)} to the ${this.columnProperty} property of this database ` +
            `(Notion UI: database settings -> property -> Edit options), then re-run \`takumi board --check\``
          : `create a select property named ${JSON.stringify(this.columnProperty)} on this database with an option ` +
            `named ${JSON.stringify(name)} (Notion UI: database settings -> + -> Property -> Select), then re-run ` +
            '`takumi board --check`',
      };
    });

    const supported = this.capabilities().states;
    return {
      // Read from metadata() rather than a second literal: the suite checks this
      // field against `metadata().id`, so one of them has to be the source.
      provider: this.metadata().id,
      // Nothing was created, and nothing ever is: a read-only report is not an
      // application of anything.
      applied: false,
      actions,
      unsupported: BOARD_WORK_ITEM_STATES.filter((state) => !supported.includes(state)),
    };
  }

  private async fetchPage(id: string): Promise<NotionPage> {
    return requestBoardJson<NotionPage>(this.request, { method: 'GET', url: `${this.apiBase}/pages/${id}` }, `getWork ${id}`);
  }

  private async patchPage(id: string, properties: Record<string, unknown>, what: string): Promise<void> {
    const res = await this.request({ method: 'PATCH', url: `${this.apiBase}/pages/${id}`, body: { properties } });
    if (res.status < 200 || res.status >= 300) throw boardErrorFromResponse(res, `${what} on ${id}`, id);
  }

  /** The column patch, in the property type the page actually carries. */
  private columnPatch(to: BoardWorkItemState): Record<string, unknown> {
    return this.columnType === 'status'
      ? { [this.columnProperty]: { status: { name: this.stateMap[to] } } }
      : { [this.columnProperty]: { select: { name: this.stateMap[to] } } };
  }

  private toWorkItem(page: NotionPage): BoardWorkItem {
    const column = page.properties?.[this.columnProperty];
    if (column?.type === 'status' || column?.type === 'select') this.columnType = column.type;
    const record = this.readRecord(page);
    const labels =
      this.labelsProperty === undefined
        ? []
        : (page.properties?.[this.labelsProperty]?.multi_select ?? []).flatMap((entry) =>
            entry.name === undefined ? [] : [entry.name],
          );
    return {
      id: page.id,
      title: plainText(page.properties?.[this.titleProperty]?.title) || page.id,
      body: '',
      url: page.url ?? '',
      state: this.readColumn(page),
      labels,
      assignees: [],
      updatedAt: page.last_edited_time ?? new Date(0).toISOString(),
      raw: { column: column?.select?.name ?? column?.status?.name ?? null, record },
    };
  }

  /** Read the column back as a contract state; an unknown option is a precondition error. */
  private readColumn(page: NotionPage): BoardWorkItemState {
    const column = page.properties?.[this.columnProperty];
    // Learn the property type here, not only in toWorkItem: claim() and
    // transition() read the column without ever building a work item, and they
    // must patch the type the board actually uses.
    if (column?.type === 'status' || column?.type === 'select') this.columnType = column.type;
    const option = column?.select?.name ?? column?.status?.name;
    const entry = Object.entries(this.stateMap).find(([, name]) => name === option);
    if (entry === undefined) {
      throw new BoardError(
        'precondition',
        `Notion column ${this.columnProperty} option ${JSON.stringify(option ?? null)} is not one of this adapter's states ` +
          `(${Object.values(this.stateMap).join(', ')})`,
        { item: page.id },
      );
    }
    return entry[0] as BoardWorkItemState;
  }

  private readRecord(page: NotionPage): BoardStateRecord | null {
    const text = plainText(page.properties?.[this.stateProperty]?.rich_text);
    if (text.length === 0) return null;
    // A present-but-corrupt record throws BoardStateRecordError: a mangled
    // record must never look like a fresh, claimable item.
    return parseBoardStateRecord(text);
  }
}

/** Notion accepts a bare id, a UUID or a full app URL — normalize all three. */
export function normalizeDatabaseId(value: string): string {
  const match =
    /([0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:[?#].*)?$/.exec(
      value.trim(),
    );
  if (match?.[1] === undefined) {
    throw new BoardError('precondition', `not a Notion database id or URL: ${JSON.stringify(value)}`);
  }
  return match[1].replace(/-/g, '');
}

/** Flatten Notion rich text into a plain string. */
export function plainText(rich: NotionRich[] | undefined): string {
  return (rich ?? []).map((entry) => entry.plain_text ?? '').join('');
}

/**
 * The option names a column property carries.
 *
 * Empty for a property that is missing or is not a select/status property: the
 * caller reports that case as `not-creatable`, so "no options" and "no property"
 * must never be confused with "the option is already there". This is the only
 * place the two Notion option shapes (`select` / `status`) are read, so a change
 * to the API lands in one spot.
 */
function columnOptionNames(property: NotionDatabaseProperty | undefined): string[] {
  const options = property?.select?.options ?? property?.status?.options ?? [];
  return options.flatMap((option) =>
    typeof option.name === 'string' && option.name.length > 0 ? [option.name] : [],
  );
}

/** `or` requires at least two conditions in Notion; a single one is sent bare. */
function buildColumnFilter(property: string, options: string[]): Record<string, unknown> | undefined {
  // No options means no filter at all; the caller must not send an empty `or`,
  // which Notion rejects. The signal is the missing value, not an empty object.
  if (options.length === 0) return undefined;
  const conditions = options.map((name) => ({ property, select: { equals: name } }));
  return conditions.length === 1 ? conditions[0] : { or: conditions };
}

/** The default transport: Notion's REST API over curl. */
export function createNotionTransport(
  opts: { token?: string; apiBase?: string } & CurlRequestFnOptions = {},
): BoardRequestFn {
  const token = opts.token ?? process.env['NOTION_TOKEN'];
  const { token: _token, apiBase: _apiBase, ...curl } = opts;
  void _token;
  void _apiBase;
  return createCurlRequestFn({
    headers: () => {
      const headers: Record<string, string> = { 'Notion-Version': '2022-06-28', Accept: 'application/json' };
      if (token !== undefined && token.length > 0) headers['Authorization'] = `Bearer ${token}`;
      return headers;
    },
    ...curl,
  });
}
