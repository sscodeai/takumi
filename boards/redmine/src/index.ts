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
 * WHAT `createWork` FILES, AND WHAT IT REFUSES TO GUESS: an issue is created through
 * `POST /issues.json` in the status the requested state maps to, with the idempotency
 * marker written into the DESCRIPTION (Redmine's issue query exposes a `description`
 * text filter, so the marker is findable server-side before a second create is sent —
 * see `createWork`). The project must be the NUMERIC id Redmine's `project_id` really
 * is, and a state whose status this installation does not have fails naming the state
 * rather than filing work into the wrong status. Labels are refused, not dropped,
 * because a core Redmine issue has nowhere to put them.
 *
 * WHY A JOURNAL CANNOT FORGE THE RUN STATE: the record is addressed by CUSTOM
 * FIELD ID/NAME, not by scanning text. A commenter (or a bot with comment rights)
 * can paste `<!-- takumi:boardstate:v1 {...} -->` into a journal and `readState`
 * will never see it, because journals are never parsed for state. The only writer
 * of the field is this integration's API key, and a caller can additionally use a
 * Redmine field-permission rule to make the field unwritable by humans.
 */

import {
  carryStateRecordForward,
  decideClaim,
  assertBoardCapability,
  renderCreateMarker,
  assertBoardHttpOk,
  assertTransition,
  BoardError,
  BOARD_WORK_ITEM_STATES,
  createCurlRequestFn,
  createKeyOf,
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
  BoardWorkItemSpec,
  BoardWorkItemState,
  BoardWorkQuery,
  ClaimResult,
  CreateWorkResult,
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
 * The most results a single `/search.json` page may carry.
 *
 * Redmine caps the search `limit` at 100 (Rest_Search), and this adapter will not ask
 * for more than the API will give: a page that silently came back short would look like
 * a complete answer.
 */
const MAX_SEARCH_LIMIT = 100;

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
   *
   * `createWork` is stricter for the same reason, because filing is a WRITE: a create
   * with a non-numeric project FAILS closed (naming the id to look up) rather than
   * filing work wherever Redmine would resolve an identifier to.
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

/** What `POST /issues.json` answers with: `{ issue: {...} }`. */
interface RedmineIssueEnvelope {
  issue?: RedmineIssuePayload;
}

interface RedmineIssuePage {
  issues?: RedmineIssuePayload[];
  total_count?: number;
  offset?: number;
  limit?: number;
}

/**
 * One hit of `GET /search.json?issues=1`.
 *
 * It carries `{id, type, title}` and — this is the whole reason the scoped search costs
 * an extra read per candidate — NO status, so a hit can never be mapped to a delivery
 * state on its own (Rest_Search).
 */
interface RedmineSearchHit {
  id?: number;
  type?: string;
  title?: string;
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
  /** The configured project's numeric id, resolved once per provider (see `projectId()`). */
  private resolvedProjectId: Promise<string> | undefined;

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
      // Redmine issue statuses are administration data: `/issue_statuses.json` is
      // read-only, so a status cannot be created through this API. The honest
      // answer is false, and `bootstrapStates()` only REPORTS.
      canBootstrapStates: false,
      // `POST /issues.json` files an issue. The idempotency marker goes into the
      // DESCRIPTION, because that is both where a human expects the reason and what
      // Redmine's `description` text filter can search BEFORE a second create is sent
      // (the state custom field already has exactly one writer: the run record).
      canCreateWork: true,
      // Redmine's issue LIST has no free-text parameter, but `/search.json` — the endpoint
      // `createWork` already dedupes through — is this instance's own text index, so a
      // caller's `query` really is scoped by the board rather than by takumi.
      canTextSearch: true,
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
   *
   * A free-text `query` cannot be expressed by this list at all (see `searchWork`), so
   * it takes the SEARCH path instead. It is never ignored: a scope this board dropped
   * would leave a runner working on exactly the items the operator excluded.
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

    if (query.query !== undefined) return await this.searchWork(query, query.query);

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

    return await this.mapWantedIssues(collected, wanted, max);
  }

  /**
   * A free-text scope: `GET /search.json?issues=1&open_issues=1&q=<term>`, then one read
   * per candidate so the answer is still a real `BoardWorkItem[]`.
   *
   * WHY THE SEARCH ENDPOINT: it is the only text index this adapter can reach — a
   * Redmine core issue carries no labels and the issue list exposes no free-text filter
   * (Rest_Issues), while `createWork` already dedupes through exactly this endpoint.
   *
   * THE HONEST COST OF `states`, since it decides the shape of this method: the search
   * answers `{id, type, title}` and NO status (Rest_Search), so `states` CANNOT be
   * honoured in one pass — and a hit is not work until the state the delivery hangs on
   * has been read. Every candidate is therefore fetched and mapped by the SAME code the
   * list path uses, which costs ONE EXTRA REQUEST PER CANDIDATE. The alternative is
   * returning hits whose state the caller asked to filter on without ever having read
   * it, which is the class of lie this port exists to prevent. `query.limit` bounds both
   * the search page and the reads, so a tightly scoped query ("this epic") stays cheap.
   *
   * WHAT A HIT MUST SURVIVE, in order: it must be an issue (a global search also answers
   * news, documents, wiki pages and changesets), it must belong to the configured
   * project (the documented search has no project parameter — only
   * `scope=all|my_project|subprojects` — so the check happens here, see
   * `inScopedProject`), and it must map onto a state the caller asked for. A hit whose
   * status maps to NO delivery state is reported through the same aggregated
   * `precondition` error the list path uses: a scoped query must not turn a
   * configuration gap into "no work".
   */
  private async searchWork(query: BoardWorkQuery, term: string): Promise<BoardWorkItem[]> {
    assertSearchableTerm(term);
    const max = query.limit ?? Number.POSITIVE_INFINITY;
    const wanted = new Set<BoardWorkItemState>(query.states ?? BOARD_WORK_ITEM_STATES);
    const found = await requestBoardJson<{ results?: RedmineSearchHit[] }>(
      this.request,
      { method: 'GET', url: this.searchUrl(term, max) },
      'listWork: search',
    );

    const collected: RedmineIssuePayload[] = [];
    for (const hit of found.results ?? []) {
      if (collected.length >= max) break;
      // A non-issue hit, or one Redmine answered without an id, cannot be read back and
      // is therefore not work this board can hand to a runner.
      if (hit.type !== 'issue' || typeof hit.id !== 'number') continue;
      // Read exactly like any other issue — the SAME reader `getWork` uses, so a candidate
      // cannot be described by a second, thinner code path that disagrees about what an
      // issue is. The project this reader returns is what `inScopedProject` checks.
      const issue = await this.fetchIssue(String(hit.id));
      if (!(await this.inScopedProject(issue))) continue;
      collected.push(issue);
    }
    return await this.mapWantedIssues(collected, wanted, max);
  }

  /**
   * Is this search hit one of THIS board's issues?
   *
   * The search endpoint is GLOBAL: its documented parameters offer `scope=all|my_project|
   * subprojects` and no project-id filter, whereas the list path is scoped server-side by
   * `project_id`. Without this check a board configured for one project would answer a
   * scoped query with another project's issues — a widened scope, which is the one thing
   * a scope must never do. The check uses the NUMERIC id Redmine reports on an issue
   * (`project.id`) because a slug cannot be compared to it; `projectId()` resolves a
   * slug through the documented `GET /projects/<id-or-identifier>.json` lookup.
   *
   * An issue that arrives without a project block cannot be placed, so it is not returned:
   * that is the same filter `/issues.json?project_id=` performs on the list path (a
   * foreign item is simply not this board's work), and `getWork(id)` can still read any
   * issue by id when a caller really wants it.
   */
  private async inScopedProject(issue: RedmineIssuePayload): Promise<boolean> {
    const wanted = await this.projectId();
    if (wanted === undefined) return true;
    const project = issue.project;
    return project !== null && project !== undefined && String(project.id) === wanted;
  }

  /**
   * The configured project as the NUMERIC id Redmine's `project_id` really is, resolved
   * once per provider.
   *
   * Needed because the search path has to place a candidate itself (see
   * `inScopedProject`), and the `project` option is documented as accepting an identifier
   * as well as a number. The lookup is the one this adapter's own option doc tells a
   * caller to make when they hold only an identifier, so it is done here instead of being
   * left as a configuration trap. A failed lookup is never cached: one transport blip
   * must not poison every later call.
   */
  private async projectId(): Promise<string | undefined> {
    const configured = this.project;
    if (configured === undefined) return undefined;
    if (/^\d+$/.test(configured)) return configured;
    this.resolvedProjectId ??= requestBoardJson<{ project?: { id?: number } }>(
      this.request,
      { method: 'GET', url: `${this.baseUrl}/projects/${encodeURIComponent(configured)}.json` },
      `project ${configured}`,
    )
      .then((body) => {
        const id = body.project?.id;
        if (typeof id !== 'number') {
          throw new BoardError(
            'precondition',
            `Redmine answered ${JSON.stringify(configured)} without a project id, so a scoped search cannot tell this ` +
              "board's issues from another project's — pass the numeric project id to the `project` option",
            { item: configured },
          );
        }
        return String(id);
      })
      .catch((error: unknown) => {
        this.resolvedProjectId = undefined;
        throw error;
      });
    return this.resolvedProjectId;
  }

  /**
   * Map already-collected issue payloads into work items: drop what the caller did not
   * ask for, and REFUSE to hide a status this adapter cannot map.
   *
   * An issue whose Redmine status maps to NO delivery state is a configuration gap, not a
   * filter outcome. Skipping it would make a board that is missing its statusMap look
   * exactly like a board with no work — an unattended runner would then sit idle forever
   * while its queue is full. So the status names are collected and reported together,
   * once, with the fix in the message.
   *
   * Shared by the issue LIST and the SEARCH path on purpose: a scoped query cannot be
   * allowed to report the same gap differently from an unscoped one.
   */
  private async mapWantedIssues(
    collected: readonly RedmineIssuePayload[],
    wanted: ReadonlySet<BoardWorkItemState>,
    max: number,
  ): Promise<BoardWorkItem[]> {
    const items: BoardWorkItem[] = [];
    const unmapped = new Map<string, string>();
    for (const issue of collected.slice(0, max)) {
      let item: BoardWorkItem;
      try {
        item = this.toWorkItem(issue);
      } catch (e) {
        if (e instanceof BoardError && e.kind === 'precondition' && /does not map/.test(e.message)) {
          const status = issue.status?.name ?? '(none)';
          if (!unmapped.has(status)) unmapped.set(status, String(issue.id ?? '?'));
          continue;
        }
        throw e;
      }
      // Mapped but not wanted is the filter working as asked.
      if (!wanted.has(item.state)) continue;
      items.push(item);
    }
    if (unmapped.size > 0) {
      const names = [...unmapped.keys()].map((n) => JSON.stringify(n)).join(', ');
      const example = [...unmapped.values()][0] ?? '?';
      throw new BoardError(
        'precondition',
        `${String(unmapped.size)} Redmine status(es) ${names} map to no delivery state, so issue ${example} (and any like it) ` +
          `would silently vanish from this board — configure statusMap (delivery state -> Redmine status name) ` +
          `instead of letting work disappear${await this.statusesHint()}`,
      );
    }
    return items;
  }

  /** Best-effort list of the statuses this Redmine actually has, for an error message. */
  private async statusesHint(): Promise<string> {
    try {
      const statuses = await this.statuses();
      const names = statuses.map((s) => s.name).filter((n): n is string => typeof n === 'string' && n.length > 0);
      return names.length === 0 ? '' : `. Available statuses: ${names.join(', ')}`;
    } catch {
      // The hint is a courtesy: never let it replace the real error.
      return '';
    }
  }

  async getWork(id: string): Promise<BoardWorkItem> {
    return this.toWorkItem(await this.fetchIssue(id));
  }

  /**
   * File an issue in the status the requested state maps to.
   *
   * Three things this refuses to guess, because each of them would put work in the wrong
   * place: an unmapped state (no `statusMap` entry, or a status this instance does not
   * have) fails naming the available statuses rather than filing something in the wrong
   * one; a `labels` request fails because Redmine core issues have no labels; and a
   * project is used exactly as the adapter already uses it (the numeric id), never
   * resolved from a name.
   *
   * Deduplication: the marker is written into the DESCRIPTION and looked for with
   * Redmine's full-text search first, then VERIFIED locally by fetching the candidates and
   * parsing the description with `createKeyOf`. The search is a prefilter, the local check
   * is authoritative — Redmine's search index can lag behind a write by seconds, and a
   * duplicate filed because the index had not caught up is the thing this prevents. That
   * lag is the known limit here; it is stated rather than hidden.
   */
  async createWork(spec: BoardWorkItemSpec): Promise<CreateWorkResult> {
    assertBoardCapability(this, 'canCreateWork');
    if (spec.labels !== undefined && spec.labels.length > 0) {
      throw new BoardError(
        'unsupported',
        'Redmine core issues carry no labels, so a create with labels cannot be honoured (refusing instead of dropping them)',
      );
    }

    const state = spec.state ?? 'ready';
    const marker = spec.idempotencyKey === undefined ? null : renderCreateMarker(spec.idempotencyKey);

    if (marker !== null) {
      const search = await requestBoardJson<{ results?: Array<{ id?: number; type?: string }> }>(
        this.request,
        {
          method: 'GET',
          url: `${this.baseUrl}/search.json?issues=1&limit=100&q=${encodeURIComponent(spec.idempotencyKey ?? '')}`,
        },
        'createWork: search',
      );
      const candidates = (search.results ?? []).filter((r) => r.type === 'issue' && typeof r.id === 'number');
      for (const candidate of candidates) {
        const issue = await this.fetchIssue(String(candidate.id));
        if (Object.values(this.issueDescription(issue)).some((text) => text.includes(marker))) {
          return { item: this.toWorkItem(issue), created: false };
        }
      }
    }

    const statusId = await this.resolveStatusId(this.statusMap[state]);
    const description = marker === null ? (spec.body ?? '') : `${spec.body ?? ''}\n\n${marker}`;
    const created = await requestBoardJson<RedmineIssueEnvelope>(
      this.request,
      {
        method: 'POST',
        url: `${this.baseUrl}/issues.json`,
        body: {
          issue: {
            ...(this.project === undefined ? {} : { project_id: this.project }),
            subject: spec.title,
            description,
            status_id: statusId,
          },
        },
      },
      'createWork',
    );
    const issue = created.issue;
    if (issue === undefined) {
      throw new BoardError('precondition', 'Redmine accepted the create but returned no issue');
    }
    return { item: this.toWorkItem(issue), created: true };
  }

  /** The description as this adapter sees it: one field today, and one place to look. */
  private issueDescription(issue: RedmineIssuePayload): Record<string, string> {
    return typeof issue.description === 'string' ? { description: issue.description } : {};
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
    // The rule lives in core (decideClaim): the board's STATE says whether the item is
    // held, the record only says who worked it last. Reading the record as a lock is how an
    // item becomes unrecoverable after the run that claimed it dies.
    const existing = this.recordOf(issue);
    const decision = decideClaim({ state: this.stateOf(issue), record: existing, runId });
    if (!decision.claimed) {
      return { item: id, runId, claimed: false, reason: decision.reason };
    }

    const record: BoardStateRecord = {
      schema: 1,
      runId,
      item: id,
      reviewRound: 0,
      updatedAt: new Date().toISOString(),
      ...(decision.takeoverFrom === undefined
        ? {}
        : { note: `took over from run ${decision.takeoverFrom} (its record named itself while the board said ready)` }),
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
    return { item: id, runId, claimed: true, ...(decision.takeoverFrom === undefined ? {} : { takeoverFrom: decision.takeoverFrom }) };
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

  /**
   * Report which of the delivery states this Redmine INSTALLATION can express.
   *
   * Redmine issue statuses live in ADMINISTRATION — `/issue_statuses.json` is a
   * read-only resource — so `canBootstrapStates` is false and this is a READ-ONLY
   * report, never a write. It answers, before any work is claimed, exactly the pain
   * this adapter already documents: a `statusMap` naming a status nobody created
   * makes every claim fail as `unsupported` with a list to compare against. Here the
   * same fact is reported with the two steps that fix it.
   *
   * The status name comes from the adapter's OWN `statusMap` (a second mapping would
   * drift), and the comparison is case-insensitive on purpose: that is the very rule
   * `resolveStatusId` uses, so a status this report calls `exists` is a status this
   * adapter can really resolve to an id.
   *
   * A status the installation has but NO state names (say `Triage`) is not an action
   * here — `actions` is exactly one entry per desired state — it is the
   * configuration gap `listWork` refuses to hide.
   *
   * A dry run is deliberately the SAME call: a report cannot change the
   * installation, so `applied` is false either way.
   */
  async bootstrapStates(
    desired: readonly BoardWorkItemState[],
    _opts?: { dryRun?: boolean },
  ): Promise<BoardBootstrapReport> {
    const available = new Set(
      (await this.statuses())
        .map((status) => status.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0)
        .map((name) => name.toLowerCase()),
    );
    const actions: BoardBootstrapAction[] = desired.map((state) => {
      const name = this.statusMap[state];
      if (available.has(name.toLowerCase())) return { state, name, outcome: 'exists' };
      return {
        state,
        name,
        outcome: 'not-creatable',
        instruction:
          `this Redmine has no issue status named ${JSON.stringify(name)}, so state ${JSON.stringify(state)} ` +
          `cannot be represented: create that status in Redmine administration (Administration → Issue statuses) ` +
          `and pass statusMap/--status-map "<delivery state>=<Status Name>" (here "${state}=${name}") so this ` +
          `adapter can resolve it to an id — the REST API cannot create issue statuses`,
      };
    });
    return {
      provider: PROVIDER_ID,
      // A report never changes the installation, so a real call and a dry run are
      // the same read — and neither is `applied`.
      applied: false,
      actions,
      unsupported: BOARD_WORK_ITEM_STATES.filter((state) => !this.capabilities().states.includes(state)),
    };
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

  /**
   * The search URL for a free-text scope.
   *
   * `issues=1` asks for issues only (a global search also answers news, documents, wiki
   * pages, changesets and messages), and `open_issues=1` keeps the SAME "open work" scope
   * the list path gets from `status_id=open` — without it a scoped query would answer
   * closed issues that `listWork()` never returns. The term is URL-encoded, so no term can
   * alter the query itself, and `limit` is capped at what the search API will honour.
   */
  private searchUrl(term: string, max: number): string {
    const limit = Number.isFinite(max)
      ? Math.min(Math.max(Math.trunc(max), 1), MAX_SEARCH_LIMIT)
      : DEFAULT_PAGE_SIZE;
    return (
      `${this.baseUrl}/search.json?issues=1&open_issues=1&q=${encodeURIComponent(term)}` +
      `&limit=${limit}&offset=0`
    );
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

/** Append the hidden marker unless the text already carries it. */
function withMarker(text: string, marker: string): string {
  return text.includes(marker) ? text : `${text}\n\n${marker}`;
}

/**
 * Refuse a term that names no scope.
 *
 * WHY AN EMPTY TERM IS REFUSED: Redmine reads a blank `q` as "everything" (every issue's
 * text contains the empty string), so honouring `query: ''` would answer with every open
 * issue in the project — the exact widening a scope exists to prevent. The refusal names
 * the problem instead. Any OTHER term is safe to send: it travels in the URL query string
 * through `encodeURIComponent`, so no term can add a parameter to the search or change
 * which endpoint is called — which is why this adapter escapes (URL encoding, the API's
 * own grammar) where the Jira one has to reject characters that would rewrite the JQL.
 */
function assertSearchableTerm(term: string): void {
  if (term.trim().length === 0) {
    throw new BoardError(
      'precondition',
      'a text scope must contain at least one non-whitespace character: an empty term names no scope, and Redmine ' +
        'reads a blank q as "everything" — sending it would widen the search to every open issue the caller meant to exclude',
    );
  }
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
  const note = evidence.note ?? existing?.note;
  return carryStateRecordForward(existing, {
    runId: existing?.runId ?? evidence.runId,
    item: id,
    ...(note === undefined ? {} : { note }),
  });
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
