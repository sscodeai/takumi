import {
  assertBoardCapability,
  boardErrorFromResponse,
  BoardError,
  assertTransition,
  BoardUnsupportedError,
  BOARD_WORK_ITEM_STATES,
  createKeyOf,
  createCurlRequestFn,
  parseBoardStateRecord,
  renderCreateMarker,
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
  BoardWorkItemSpec,
  BoardWorkItemState,
  BoardWorkQuery,
  ClaimResult,
  CreateWorkResult,
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
 * The create marker is CORE's (`renderCreateMarker`), and `createWork` is the only
 * caller: it is what makes a repeated create return the FIRST page instead of filing a
 * second one.
 *
 * A malformed key fails HERE, as this port's own `precondition`, before any request: a
 * marker nothing can find again files a duplicate on every retry — the exact outcome the
 * marker exists to prevent.
 */
function markerFor(key: string): string {
  try {
    return renderCreateMarker(key);
  } catch (e) {
    throw new BoardError('precondition', e instanceof Error ? e.message : String(e), { cause: e });
  }
}

/**
 * One `rich_text` run in Notion's WRITE shape (a read echoes `plain_text` next to it).
 *
 * Every rich_text this adapter writes goes through here, so the machine property has one
 * shape: the create marker's run and a state record's run are built the same way.
 */
function richTextRun(content: string): Record<string, unknown> {
  return { type: 'text', text: { content } };
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
 *   - a page has no body FIELD: `BoardWorkItem.body` is therefore always `''`, and a
 *     `createWork` spec's `body` cannot be stored (page content is a separate blocks
 *     API this adapter does not speak). A caller that must record detail has to put
 *     it in the title or file on a board that has a body — the adapter says so here
 *     rather than quietly dropping the text.
 *
 * The run state record keeps the SAME versioned grammar as every other adapter
 * (renderBoardStateRecord / parseBoardStateRecord); only its storage differs —
 * a rich-text property instead of a hidden comment block. The storage is
 * board-specific, the contract is not.
 *
 * `createWork()` files pages (`canCreateWork: true`) and is idempotent through the same
 * kind of marker, stored in the machine property this adapter already owns and searched
 * for with a database query before anything is written. WHY that property: a page's
 * properties are the only machine-writable surface a Notion board has, the marker and
 * the state record therefore share ONE property (the marker in its own run, in front of
 * the record), and `writeState()` carries the marker forward — Notion replaces a
 * rich_text value wholesale, so a record write that dropped the marker would make the
 * next retry file a second page for the same failure. The state-record READER is
 * unaffected: `parseBoardStateRecord` ignores text that carries no `takumi:boardstate:`
 * block, so a page whose property holds only the marker reads as "no run yet", which is
 * exactly what it is. What the sharing costs: the marker is visible in the UI's rendered
 * property text, exactly like the record block that already lives there, so it is not a
 * hidden comment — the least-bad option on a board with no hidden-comment surface.
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
  /**
   * Whether {@link columnType} was actually OBSERVED (from a page or from the database)
   * rather than assumed. `createWork` consults it — and reads the database once when it
   * is false — because Notion rejects a `select` value on a `status` property, so a
   * create that guessed would be refused by the board for a reason the caller cannot see.
   */
  private columnTypeKnown = false;

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
      // Pages ARE creatable, and that is a different thing entirely: a failure has to
      // become work somewhere, and a database row is that somewhere on this board.
      canCreateWork: true,
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

  /**
   * File a page — idempotently, or not at all.
   *
   * WHAT is written: one page whose title property carries `spec.title`, whose column
   * property is the requested state's option (the SAME shape `claim`/`transition` write,
   * built from this instance's `columnProperty`/`columnType`/`stateMap` rather than a
   * second copy of the vocabulary), the caller's labels when a labels property exists,
   * and — with an idempotency key — CORE's create marker in this adapter's own machine
   * property (see the class doc for why that property and what it costs).
   *
   * WHAT is NOT written, stated rather than dropped quietly: `spec.body`. A page has no
   * body field, `BoardWorkItem.body` is always `''` on this board, and page content is a
   * separate blocks API. A caller that must record detail puts it in the title or files
   * on a board with a body.
   *
   * Idempotency: Notion has no native idempotency key, so a create with a key QUERIES
   * the database for the marker (`rich_text contains <marker>`) before writing, and
   * confirms the hit with `createKeyOf` — a page whose text merely mentions the key is
   * not adopted. The query is one page (100 results); `createWork` does not follow
   * `has_more`, so a key whose page sits beyond the first 100 matches would not be found
   * and a second page would be filed. That is the honest limit of the guarantee on this
   * board (the same one `listWork` has), and the marker keeps the duplicate greppable.
   *
   * A create the host rejects — Notion answers a column option the database does not have
   * with `400 validation_error` — is re-thrown as the port's classified error with the
   * option name and the UI step in the message: the caller can act on it instead of
   * reading Notion's own wording.
   */
  async createWork(spec: BoardWorkItemSpec): Promise<CreateWorkResult> {
    assertBoardCapability(this, 'canCreateWork');
    const state = spec.state ?? 'ready';
    const key = spec.idempotencyKey;
    // Fail closed BEFORE touching the board: a label that cannot be recorded must not
    // be filed and forgotten, and the fix is a construction option, not a retry.
    if (spec.labels !== undefined && spec.labels.length > 0 && this.labelsProperty === undefined) {
      throw new BoardError(
        'precondition',
        `${this.metadata().id}: this board has no labels property configured, so ${spec.labels.length} label(s) ` +
          '(e.g. ' +
          `${JSON.stringify(spec.labels[0] ?? '')}) cannot be recorded — pass labelsProperty in NotionBoardOptions ` +
          'to file labelled work',
      );
    }
    const marker = key === undefined ? null : markerFor(key);

    if (key !== undefined && marker !== null) {
      const existing = await this.findByCreateKey(key, marker);
      if (existing !== null) return { item: this.toWorkItem(existing), created: false };
    }

    await this.learnColumnType();
    const properties: Record<string, unknown> = {
      [this.titleProperty]: { title: [richTextRun(spec.title)] },
      ...this.columnPatch(state),
    };
    if (marker !== null) {
      properties[this.stateProperty] = { rich_text: [richTextRun(marker)] };
    }
    if (this.labelsProperty !== undefined && spec.labels !== undefined && spec.labels.length > 0) {
      properties[this.labelsProperty] = { multi_select: spec.labels.map((name) => ({ name })) };
    }

    try {
      const created = await requestBoardJson<NotionPage>(
        this.request,
        {
          method: 'POST',
          url: `${this.apiBase}/pages`,
          // The parent is the DATABASE: this adapter files rows, not sub-pages.
          body: { parent: { database_id: this.databaseId }, properties },
        },
        'createWork',
      );
      return { item: this.toWorkItem(created), created: true };
    } catch (e) {
      throw this.createFailure(e, state);
    }
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
    // The property is SHARED with the create marker, and Notion's PATCH replaces a
    // rich_text value wholesale: writing only the record would delete the key a retried
    // create searches for, and the retry would file a SECOND page for the same failure —
    // the duplicate this port exists to prevent. So the marker is read first and carried
    // forward in its own run, IN FRONT of the record (the reader takes the first marker
    // in the text, so order is not cosmetic).
    const key = createKeyOf(this.stateTextOf(await this.fetchPage(id)));
    const marker = key === null ? null : renderCreateMarker(key);
    const runs = [
      ...(marker === null ? [] : [richTextRun(marker)]),
      richTextRun(block),
    ];
    // The limit is Notion's, applied to the whole property: the marker counts, because
    // the write carries it.
    const length = block.length + (marker?.length ?? 0);
    if (length > MAX_RICH_TEXT_LENGTH) {
      throw new BoardError(
        'precondition',
        `state record is ${length} chars, over Notion's ${MAX_RICH_TEXT_LENGTH}-char rich_text limit`,
      );
    }
    await this.patchPage(id, { [this.stateProperty]: { rich_text: runs } }, 'writeState');
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
    this.rememberColumnType(property?.type);

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

  /**
   * Read the column property's TYPE from the database, once.
   *
   * `claim` and `transition` learn it from the page they already read; a create has no
   * such page, and writing `select` to a `status` property is rejected by Notion. One
   * database read (only until the type is actually observed) buys a create that cannot
   * be refused for a shape this adapter assumed — and a `status` board is exactly the
   * modern Notion default, so assuming is not a hypothetical risk.
   */
  private async learnColumnType(): Promise<void> {
    if (this.columnTypeKnown) return;
    const database = await requestBoardJson<NotionDatabase>(
      this.request,
      { method: 'GET', url: `${this.apiBase}/databases/${this.databaseId}` },
      'createWork: database',
    );
    this.rememberColumnType(database.properties?.[this.columnProperty]?.type);
  }

  /**
   * Remember the column property's type the first time a read OBSERVES it.
   *
   * Called from every place that sees the property (a page read, a transition, the
   * database retrieve), so the assumption `select` only ever stands in until the board
   * says otherwise — the property's own type is the authority, never this adapter's.
   */
  private rememberColumnType(type: string | undefined): void {
    if (type === 'select' || type === 'status') {
      this.columnType = type;
      this.columnTypeKnown = true;
    }
  }

  /**
   * The page a create key already filed, or `null`.
   *
   * The query filters the adapter's OWN machine property (`rich_text contains <marker>`)
   * rather than listing the board: a list would be page wide, would have to walk every
   * column, and would still miss a page the column filter excludes — a delivered item is
   * exactly the one a retried tick must not file again.
   *
   * A hit is not proof, so it is confirmed with `createKeyOf`: only a page that carries
   * the real marker is adopted, never one whose text merely mentions the key.
   */
  private async findByCreateKey(key: string, marker: string): Promise<NotionPage | null> {
    const result = await requestBoardJson<{ results?: NotionPage[] }>(
      this.request,
      {
        method: 'POST',
        url: `${this.apiBase}/databases/${this.databaseId}/query`,
        body: { page_size: 100, filter: { property: this.stateProperty, rich_text: { contains: marker } } },
      },
      'createWork: search',
    );
    return (result.results ?? []).find((page) => createKeyOf(this.stateTextOf(page)) === key) ?? null;
  }

  /**
   * Translate a rejected create into this port's classified error, naming what to fix.
   *
   * Notion refuses a page whose column value names an option the database does not have
   * with `400 validation_error` — correctly classified as `precondition` by the shared
   * status table (retrying changes nothing), and unhelpful to an operator. The adapter
   * therefore names the option it tried to write and the step that creates it; anything
   * else (`auth`, `transport`, `not_found`) is returned untouched, because the taxonomy
   * already said what it was.
   */
  private createFailure(e: unknown, state: BoardWorkItemState): unknown {
    if (e instanceof BoardError && e.kind === 'precondition') {
      return new BoardError(
        'precondition',
        `${e.message} — nothing was filed: check that the ${this.columnProperty} property of this database has an ` +
          `option named ${JSON.stringify(this.stateMap[state])} (Notion UI: database settings -> property -> Edit ` +
          'options), then re-run `takumi board --check`',
        { cause: e },
      );
    }
    return e;
  }

  /** The text this adapter's machine property carries on a page (`''` when absent). */
  private stateTextOf(page: NotionPage): string {
    return plainText(page.properties?.[this.stateProperty]?.rich_text);
  }

  /** The column patch, in the property type the page actually carries. */
  private columnPatch(to: BoardWorkItemState): Record<string, unknown> {
    return this.columnType === 'status'
      ? { [this.columnProperty]: { status: { name: this.stateMap[to] } } }
      : { [this.columnProperty]: { select: { name: this.stateMap[to] } } };
  }

  private toWorkItem(page: NotionPage): BoardWorkItem {
    const column = page.properties?.[this.columnProperty];
    this.rememberColumnType(column?.type);
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
    this.rememberColumnType(column?.type);
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
    const text = this.stateTextOf(page);
    if (text.length === 0) return null;
    // A present-but-corrupt record throws BoardStateRecordError: a mangled
    // record must never look like a fresh, claimable item. A property holding ONLY a
    // create marker is not corrupt — it carries no `takumi:boardstate:` block, so
    // `parseBoardStateRecord` answers `null`, which is the truth: no run has started on
    // the page yet. That is what lets one property hold both facts.
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
