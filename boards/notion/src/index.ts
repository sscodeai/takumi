import {
  decideClaim,
  assertBoardCapability,
  assertScopeQuery,
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
 * One paragraph block, carrying ONE LINE of a body.
 *
 * WHY a block per line, and runs inside it: the text a page reads back is the paragraph
 * text joined by newlines, so one block per line makes that round trip EXACT (an
 * invariant the tests assert) — while a line longer than Notion's 2000-char rich_text
 * ceiling still fits, as several runs of the SAME paragraph, which is the only way to
 * carry it without dropping or reflowing a character.
 */
function paragraphBlock(line: string): Record<string, unknown> {
  if (line.length === 0) {
    // An empty line is a paragraph with no runs: legal, and it reads back as '' so the
    // newline that separated it from its neighbours survives the round trip.
    return { object: 'block', type: 'paragraph', paragraph: { rich_text: [] } };
  }
  const runs: Array<Record<string, unknown>> = [];
  for (let at = 0; at < line.length; at += MAX_RICH_TEXT_LENGTH) {
    runs.push(richTextRun(line.slice(at, at + MAX_RICH_TEXT_LENGTH)));
  }
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: runs } };
}

/**
 * A body as page content. `bodyBlocks(b)` spell `b` exactly:
 * `blocksToText(bodyBlocks(b)) === b`, for every `b`, including one with long lines.
 */
export function bodyBlocks(body: string): Array<Record<string, unknown>> {
  if (body.length === 0) return [];
  return body.split('\n').map(paragraphBlock);
}

/**
 * The text page content spells: every paragraph's text, in order, joined by newline.
 *
 * A block of another type (a heading, an image, a to-do a human added in the Notion UI)
 * carries no text in this join: what this maps to is the port's `body` — the text of the
 * page — not a rendering of arbitrary content. This adapter writes paragraphs and reads
 * paragraphs, so a body it wrote comes back whole; a page a person wrote in other block
 * types reports the paragraphs among them and nothing else.
 */
export function blocksToText(blocks: NotionBlock[]): string {
  return blocks
    .flatMap((block) => (block.type === 'paragraph' ? [plainText(block.paragraph?.rich_text)] : []))
    .join('\n');
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
 *   - a page has no body FIELD, so a body travels as page CONTENT: `createWork`
 *     writes `spec.body` onto the page as paragraph blocks (one block per line, at
 *     most one rich_text run per 2000 characters — Notion's ceiling — appended in
 *     batches of 100 blocks), and a READ path reads that content back into
 *     `BoardWorkItem.body`. Nothing is dropped and nothing is truncated; the one
 *     thing this adapter never does is rewrite content it did not write.
 *     WHY the read is on by default (`readContent`): the pilot hands an item's body
 *     to the agent as `TAKUMI_ITEM_BODY`, so a board that stores text it will not
 *     return hands every agent an empty task — the exact silent degradation this
 *     port's rules exist to prevent. The cost is one request per page, plus one per
 *     100 blocks of content, and `listWork` pays it per ROW: that cost is real and
 *     stated, and `readContent: false` is the documented trade (cheap reads, `body`
 *     is `''` — never "the body is empty", which only an empty body means).
 *   - a `BoardWorkQuery.query` SEARCHES TITLES ONLY (`canTextSearch: true`): Notion
 *     can filter a title property with `title.contains`, and it exposes NO search over
 *     page CONTENT — reading a page back does not change that, and this adapter does
 *     not pretend otherwise by sending content text to a query. A caller scoping a
 *     tick to an epic must therefore carry that epic in the item's TITLE or the scope
 *     will not find it — and the capability's own doc demands exactly this disclosure:
 *     say what is searched when it is narrower than "everything". The search is not
 *     silently widened to compensate, because a scope that quietly means less than the
 *     caller asked for is how a runner works on items the operator excluded.
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
  /**
   * Read page CONTENT back into `BoardWorkItem.body`. Default **true**.
   *
   * TRUE because `body` is not decoration: the pilot passes it to the agent, and an
   * item's text silently reading as empty is how an agent gets sent to work on a
   * description nobody gave it. The price is one request per page (plus one per 100
   * blocks of content) and `listWork` pays it once per ROW, sequentially, because
   * Notion rate-limits concurrent reads.
   *
   * FALSE is the documented trade, not a silent one: reads cost nothing extra and
   * every `body` is `''` — which then means "not read", not "no description".
   */
  readContent?: boolean;
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

/** Notion's ceiling for the `children` of one write, and for one page of a content read. */
const MAX_BLOCKS_PER_REQUEST = 100;

interface NotionRich {
  plain_text?: string;
  /** Present on a run this adapter WROTE (a read echoes `plain_text` instead). */
  text?: { content?: string };
}

interface NotionProperty {
  type?: string;
  title?: NotionRich[];
  rich_text?: NotionRich[];
  select?: { name?: string } | null;
  status?: { name?: string } | null;
  multi_select?: Array<{ name?: string }>;
}

/** The write shape of a `multi_select` value: one place, so a read and a write cannot disagree. */
function multiSelect(names: string[]): Record<string, unknown> {
  return { multi_select: names.map((name) => ({ name })) };
}

/** The labels a page carries in its labels property (`[]` when the board has none). */
function readLabels(page: NotionPage, property: string | undefined): string[] {
  if (property === undefined) return [];
  return (page.properties?.[property]?.multi_select ?? []).flatMap((entry) =>
    entry.name === undefined ? [] : [entry.name],
  );
}

/** One block of a page's content, in the shape both a read and a write use. */
export interface NotionBlock {
  type?: string;
  paragraph?: { rich_text?: NotionRich[] };
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
  /** Read page content into `body` (see the option: on by default, and why). */
  private readonly readContent: boolean;
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
    this.readContent = opts.readContent ?? true;
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
      // True, and NARROWER than "everything": this searches the TITLE property only.
      // Notion's query filter can do `title.contains`, and there is no page-body search
      // to offer (the class doc says so where a caller will read it) — declaring it
      // any other way would promise a scope this board cannot apply.
      canTextSearch: true,
      delivery: { canOpenPullRequest: false, canRunChecks: false, canMerge: false },
    };
  }

  /**
   * Query the database for work.
   *
   * `query.states` becomes the column filter (one condition, or an `or` over several);
   * `query.query` adds a TITLE filter (`title.contains`) and nothing more, because a
   * title is the only text Notion lets this adapter search (see the class doc). A blank
   * term is treated as absent — see {@link textSearchTerm}. `query.labels` is applied
   * locally: a `multi_select` AND is not one of the filter shapes this adapter keeps to.
   */
  async listWork(query: BoardWorkQuery = {}): Promise<BoardWorkItem[]> {
    const states: readonly BoardWorkItemState[] = query.states ?? ['ready'];
    const body: Record<string, unknown> = { page_size: query.limit ?? 100 };
    const columnFilter = buildColumnFilter(
      this.columnProperty,
      states.map((s) => this.stateMap[s]),
    );
    const term = textSearchTerm(query.query);
    const titleFilter =
      term === undefined ? undefined : { property: this.titleProperty, title: { contains: term } };
    const filter = combineFilters(columnFilter, titleFilter);
    if (filter !== undefined) body['filter'] = filter;

    const result = await requestBoardJson<{ results?: NotionPage[] }>(
      this.request,
      { method: 'POST', url: `${this.apiBase}/databases/${this.databaseId}/query`, body },
      'listWork',
    );
    const items: BoardWorkItem[] = [];
    // Sequential on purpose: with `readContent` on, each row's body is a separate content
    // request, and Notion rate-limits a burst of concurrent reads. The cost is stated in the
    // class doc and switchable off — and a board used only as a projection never pays it,
    // because a projection is written to, never listed.
    for (const page of result.results ?? []) items.push(await this.toWorkItem(page));
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
   * — with an idempotency key — CORE's create marker in this adapter's own machine
   * property (see the class doc for why that property and what it costs), and
   * `spec.body` as page CONTENT: one paragraph block per line, the first 100 in this
   * create and the rest appended. A body is never truncated and never reflowed.
   *
   * An idempotent hit is not merely reported: the page it found is brought up to the
   * spec's body first (see {@link adoptExisting}), so a projection filed before this
   * adapter carried bodies — or one whose appends were cut short — is repaired by the
   * re-run that was going to happen anyway, instead of staying half-empty forever.
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
   * reading Notion's own wording. A CONTENT write that fails is classified the same way
   * but says what it is: the page was filed, its content is incomplete, and re-running the
   * same key appends the missing lines.
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
      if (existing !== null) return { item: await this.adoptExisting(existing, spec), created: false };
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
      properties[this.labelsProperty] = multiSelect(spec.labels);
    }
    const blocks = bodyBlocks(spec.body ?? '');

    let created: NotionPage;
    try {
      created = await requestBoardJson<NotionPage>(
        this.request,
        {
          method: 'POST',
          url: `${this.apiBase}/pages`,
          // The parent is the DATABASE: this adapter files rows, not sub-pages.
          body: {
            parent: { database_id: this.databaseId },
            properties,
            ...(blocks.length === 0 ? {} : { children: blocks.slice(0, MAX_BLOCKS_PER_REQUEST) }),
          },
        },
        'createWork',
      );
    } catch (e) {
      throw this.createFailure(e, state);
    }
    if (blocks.length > MAX_BLOCKS_PER_REQUEST) {
      await this.appendBlocks(created.id, blocks.slice(MAX_BLOCKS_PER_REQUEST));
    }
    return { item: await this.toWorkItem(created), created: true };
  }

  async claim(id: string, runId: string): Promise<ClaimResult> {
    const page = await this.fetchPage(id);
    // The rule lives in core (decideClaim): the board's STATE says whether the item is
    // held, the record only says who worked it last. Reading the record as a lock is how an
    // item becomes unrecoverable after the run that claimed it dies.
    const existing = this.readRecord(page);
    const decision = decideClaim({ state: this.readColumn(page), record: existing, runId });
    if (!decision.claimed) {
      return { item: id, runId, claimed: false, reason: decision.reason };
    }

    await this.patchPage(id, this.columnPatch('claimed'), 'claim');
    await this.writeState(id, {
      // Carry what we do not own: `branch`, `reviewed`, `approval` belong to the run, and a state
      // move is no reason to forget them (found on a real instance: they were being dropped here).
      ...(existing ?? {}),
      schema: 1,
      runId,
      item: id,
      reviewRound: 0,
      updatedAt: new Date().toISOString(),
      // A takeover is written down: the record is evidence a human reads later, and "this run
      // took the item over from one that had died" is exactly the kind of fact it exists for.
      ...(decision.takeoverFrom === undefined
        ? {}
        : { note: `took over from run ${decision.takeoverFrom} (its record named itself while the board said ready)` }),
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
    return { item: id, runId, claimed: true, ...(decision.takeoverFrom === undefined ? {} : { takeoverFrom: decision.takeoverFrom }) };
  }

  async transition(id: string, to: BoardWorkItemState, evidence: BoardTransitionEvidence): Promise<void> {
    const page = await this.fetchPage(id);
    const from = this.readColumn(page);
    // The pure table decides legality, before any request is sent.
    assertTransition(from, to, `requested by run ${evidence.runId}`);

    await this.patchPage(id, this.columnPatch(to), `transition ${from}→${to}`);
    const existing = this.readRecord(page);
    await this.writeState(id, {
      // Carry what we do not own: `branch`, `reviewed`, `approval` belong to the run, and a state
      // move is no reason to forget them (found on a real instance: they were being dropped here).
      ...(existing ?? {}),
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

  /**
   * Patch a page's properties.
   *
   * Returns the page Notion answers with (it echoes the patched page) so a caller that has just
   * written something can report the page as it NOW is; `null` when the host did not answer with
   * JSON, in which case the caller keeps its own view rather than inventing one.
   */
  private async patchPage(
    id: string,
    properties: Record<string, unknown>,
    what: string,
  ): Promise<NotionPage | null> {
    const res = await this.request({ method: 'PATCH', url: `${this.apiBase}/pages/${id}`, body: { properties } });
    if (res.status < 200 || res.status >= 300) throw boardErrorFromResponse(res, `${what} on ${id}`, id);
    try {
      return JSON.parse(res.body) as NotionPage;
    } catch {
      return null;
    }
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
        // TWO causes reach here, and naming only the first would send an operator to edit a
        // column that is fine: Notion answers 400 both for a column option the database does
        // not have AND for page content it refuses (a block it does not accept, a body that
        // broke its limits). The host's own message is quoted above, so the instruction
        // covers both and starts from what the host actually said.
        `${e.message} — nothing was filed. Read the host's message above: it is either a ${this.columnProperty} ` +
          `option this database does not have (Notion UI: database settings -> property -> Edit options, looking for ` +
          `${JSON.stringify(this.stateMap[state])}) or CONTENT the host refused (a body is written in chunks of ` +
          `${MAX_BLOCKS_PER_REQUEST} blocks and runs of ${MAX_RICH_TEXT_LENGTH} characters, so a refusal means the ` +
          'host rejected a block, not that the body was dropped). Re-run `takumi board --check` afterwards',
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

  /**
   * A page a create key already filed, brought up to the spec's `body`.
   *
   * WHY a re-create repairs rather than only reporting: the same create key is how a
   * retried tick, and a `pilot --resync`, ask for the item — and a page filed before
   * this adapter carried bodies (or one whose appends were cut short) would otherwise
   * stay half-empty for as long as nobody deletes it. Rebuilding it instead is not the
   * same thing: recreating loses the comments, and any note a person left on the page.
   *
   * The rules that keep this from being vandalism: only content that is a strict PREFIX of
   * the spec's text is completed, only the MISSING lines are APPENDED, and a page whose
   * content is anything else — a human's own writing, some other tool's — is returned
   * untouched with its own text as its `body`. Nothing is ever rewritten or removed.
   */
  private async adoptExisting(page: NotionPage, spec: BoardWorkItemSpec): Promise<BoardWorkItem> {
    const text = spec.body ?? '';
    let content: string | undefined;
    if (text.length > 0 && this.readContent) {
      const existing = blocksToText(await this.readBlocks(page.id));
      content = existing;
      if (existing !== text && text.startsWith(existing)) {
        // One block per line, so the lines already written are exactly `existing.split('\n')`.
        const written = existing.length === 0 ? 0 : existing.split('\n').length;
        const missing = bodyBlocks(text).slice(written);
        if (missing.length > 0) {
          await this.appendBlocks(page.id, missing);
          content = text;
        }
      }
    }
    const filled = await this.fillLabels(page, spec.labels ?? []);
    return await this.toWorkItem(filled ?? page, content);
  }

  /**
   * Write the labels a page never got, when the spec carries some.
   *
   * WHY a "create" touches properties on a page that already exists: the same key is how a
   * `pilot --resync` asks for the item, and a page filed before labels were projected carries
   * none — leaving it that way would make the projection's completeness depend on WHEN it was
   * built, which is the one thing a rebuild must not depend on.
   *
   * The limit is deliberate: only a page with NO labels is filled. A page a person has labelled is
   * theirs; this adapter appends what is missing and never rewrites what is there.
   */
  private async fillLabels(page: NotionPage, labels: string[]): Promise<NotionPage | null> {
    if (labels.length === 0 || this.labelsProperty === undefined) return null;
    if (readLabels(page, this.labelsProperty).length > 0) return null;
    return await this.patchPage(page.id, { [this.labelsProperty]: multiSelect(labels) }, 'adoptLabels');
  }

  /**
   * Read a page's content.
   *
   * `has_more` is followed (a body can be longer than one page of 100 blocks) and the loop
   * stops when the host stops advancing its cursor — a host that answers `has_more: true`
   * with the same cursor forever must not turn a read into a hang.
   */
  private async readBlocks(pageId: string): Promise<NotionBlock[]> {
    const blocks: NotionBlock[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query = cursor === undefined
        ? `?page_size=${MAX_BLOCKS_PER_REQUEST}`
        : `?page_size=${MAX_BLOCKS_PER_REQUEST}&start_cursor=${encodeURIComponent(cursor)}`;
      const result = await requestBoardJson<{
        results?: NotionBlock[];
        has_more?: boolean;
        next_cursor?: string | null;
      }>(
        this.request,
        { method: 'GET', url: `${this.apiBase}/blocks/${pageId}/children${query}` },
        `readContent ${pageId}`,
      );
      blocks.push(...(result.results ?? []));
      const next = result.has_more === true ? result.next_cursor ?? undefined : undefined;
      if (next === undefined || next === cursor) return blocks;
      cursor = next;
    }
  }

  /**
   * Append blocks to a page, in batches of Notion's per-request ceiling.
   *
   * A failure is classified AND explicit about the state it leaves: the page exists with
   * part of its content, which is not something a caller may discover by reading a body
   * that looks short. The message names the page, the count, and the way out (re-run the
   * same create key — the missing lines are appended, never duplicated).
   */
  private async appendBlocks(pageId: string, blocks: Array<Record<string, unknown>>): Promise<void> {
    for (let at = 0; at < blocks.length; at += MAX_BLOCKS_PER_REQUEST) {
      const batch = blocks.slice(at, at + MAX_BLOCKS_PER_REQUEST);
      const res = await this.request({
        method: 'PATCH',
        url: `${this.apiBase}/blocks/${pageId}/children`,
        body: { children: batch },
      });
      if (res.status < 200 || res.status >= 300) {
        const classified = boardErrorFromResponse(res, `content write on ${pageId}`, pageId);
        const kind = classified instanceof BoardError ? classified.kind : 'transport';
        throw new BoardError(
          kind,
          `${this.metadata().id}: page ${pageId} was filed, but its content is incomplete — ${at} of ${blocks.length} ` +
            `block(s) were appended and the host refused the next batch (${classified.message}). Re-running the same ` +
            'create key appends the missing lines',
          { cause: classified },
        );
      }
    }
  }

  private async toWorkItem(page: NotionPage, content?: string): Promise<BoardWorkItem> {
    const column = page.properties?.[this.columnProperty];
    this.rememberColumnType(column?.type);
    const record = this.readRecord(page);
    const labels = readLabels(page, this.labelsProperty);
    return {
      id: page.id,
      title: plainText(page.properties?.[this.titleProperty]?.title) || page.id,
      // `content` is the caller's already-read text: reading it twice would cost a request
      // per page and could report a state the caller has just changed.
      body: content ?? (this.readContent ? blocksToText(await this.readBlocks(page.id)) : ''),
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

/**
 * Flatten Notion rich text into a plain string.
 *
 * A READ answers a run as `plain_text` (the flattened text) beside the `text` it came from;
 * a WRITE carries only `text.content`. Both are read here, because the same runs are handed
 * to this function on the way out of a write and on the way back in from a read — and a
 * helper that answered `''` for its own write shape would make the body round trip
 * (`blocksToText(bodyBlocks(b)) === b`) hold only for pages fetched from a live API.
 */
export function plainText(rich: NotionRich[] | undefined): string {
  return (rich ?? []).map((entry) => entry.plain_text ?? entry.text?.content ?? '').join('');
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

/**
 * The term to send as Notion's `title.contains`, or `undefined` for "no text scope".
 *
 * A blank (whitespace-only) term is treated as ABSENT rather than turned into
 * `contains: ''`: an empty `contains` is not a narrower scope, it matches every page —
 * a filter that looks applied and is not, which is the silent widening this contract
 * forbids. A real term is sent as written; Notion's `contains` is case-insensitive and
 * substring-based, so the board, not this adapter, decides how it matches.
 */
function textSearchTerm(value: string | undefined): string | undefined {
  // Core owns the rule (carry the scope faithfully or refuse it). This used to return
  // `undefined` for a blank term — which sent no filter at all and returned the whole
  // board, the exact silent widening the rule forbids, hidden behind a comment that
  // claimed to be avoiding it.
  return assertScopeQuery(value);
}

/**
 * Combine the column scope with an optional TITLE scope into ONE Notion filter.
 *
 * Notion needs at least two conditions for a compound filter (the same rule as `or`), so
 * a single condition is sent BARE — which also keeps a plain `listWork()` request
 * byte-identical to what it was before search existed, so adding a scope cannot change
 * what an unscoped call asks for.
 *
 * The column filter is nested whole, so an `or` over several states stays intact inside
 * the `and`: `{and: [{or: [...states]}, {title: ...}]}` is the shape Notion documents.
 */
function combineFilters(
  ...filters: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const present = filters.filter((filter): filter is Record<string, unknown> => filter !== undefined);
  if (present.length === 0) return undefined;
  // `present` may hold exactly one condition: send it, not a one-element `and`.
  if (present.length === 1) return present[0];
  return { and: present };
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
