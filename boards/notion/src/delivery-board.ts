/**
 * NotionDeliveryBoard — the operator's Notion DATABASE as a delivery BOARD (ADR-044).
 *
 * WHY THIS IS NOT `NotionBoardProvider` (ADR-006). The task-board port is how a run FINDS and CLAIMS
 * work: list, get, claim, transition, the state record, comments. A black-box delivery run has none of
 * that — its work comes from a confirmed requirement DOCUMENT — and handing it a `TaskBoardProvider`
 * would hand it a capability it must not use. What the operator wants is the other direction: one row
 * in the board people already look at, saying "this delivery exists, its pipeline went green (or red),
 * this commit merged". That is a WRITE-ONLY projection, and it is exactly `DeliveryBoardPort`.
 *
 * So this adapter implements `project()` and NOTHING else: no read-back path is exposed, no claim, no
 * transition, no comment. The write it does is narrow and idempotent:
 *
 *   - ONE ROW PER RUN. The run id is the identity, and it is stored in this adapter's machine property
 *     as CORE's create marker (`renderCreateMarker`) — the SAME grammar `NotionBoardProvider.createWork`
 *     uses. Before anything is written the database is queried for that marker
 *     (`rich_text contains`), and a hit is confirmed with `createKeyOf`: a page whose text merely
 *     MENTIONS the run id is never adopted. A re-run therefore UPDATES the row it wrote before and
 *     never files a second one.
 *   - THE ROW ACCUMULATES. Labels are ADDITIVE (the port requires it): the labels already on the page
 *     are read and UNIONED with the step's, so a row that was `takumi-approved` and then `takumi-merged`
 *     carries both, and a reader can see the history of one delivery in one row. Nothing an earlier
 *     step set is cleared.
 *   - THE MACHINE PROPERTY CARRIES THE DETAIL. `Takumi State` (rich_text) holds the create marker and,
 *     after it, the reader-facing detail line: which step moved the row, the pull request, the merged
 *     SHA. A person reading the row sees that line; `parseBoardStateRecord` ignores text that is not a
 *     `takumi:boardstate:` block, so sharing the property with the task-board adapter is safe (that
 *     adapter's marker and record live there too, and this one never rewrites them — it writes the
 *     marker it owns and the detail, nothing else).
 *   - THE COLUMN TYPE IS LEARNED, NOT ASSUMED. Notion refuses a `select` value on a `status` property,
 *     so the database is read once to learn which one this board uses (the same defect the task-board
 *     adapter guards against).
 *
 * The token comes from the environment (`NOTION_TOKEN`) unless injected, exactly like the task-board
 * adapter: a secret in a config file is one commit away from a secret in a repository.
 */

import {
  BoardError,
  createKeyOf,
  renderCreateMarker,
  requestBoardJson,
  unconfiguredRequestFn,
} from '@takumi/core';
import type {
  BoardRequestFn,
  BoardWorkItemState,
  DeliveryBoardMetadata,
  DeliveryBoardPort,
  DeliveryBoardProjection,
  DeliveryBoardRef,
  DeliveryBoardState,
} from '@takumi/core';
import { createNotionTransport, normalizeDatabaseId, plainText } from './index.js';

/** Notion's per-run limit for one rich_text value. */
const MAX_RICH_TEXT_LENGTH = 2000;

interface NotionRich {
  plain_text?: string;
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

interface NotionPage {
  id: string;
  url?: string;
  properties?: Record<string, NotionProperty>;
}

interface NotionDatabase {
  properties?: Record<string, { type?: string }>;
}

/** One `rich_text` run in Notion's WRITE shape. */
function richTextRun(content: string): Record<string, unknown> {
  return { type: 'text', text: { content } };
}

/** The write shape of a `multi_select` value. */
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

/** Union, order-preserving: what was there first stays first, and nothing is dropped. */
function unionLabels(existing: string[], added: string[]): string[] {
  const out = [...existing];
  for (const label of added) if (!out.includes(label)) out.push(label);
  return out;
}

const DEFAULT_STATE_MAP: Record<BoardWorkItemState, string> = {
  ready: 'ready',
  claimed: 'claimed',
  pr_open: 'pr_open',
  fix_needed: 'fix_needed',
  merged: 'merged',
  blocked: 'blocked',
};

export interface NotionDeliveryBoardOptions {
  /** The Notion database id, UUID or app URL. */
  databaseId: string;
  /** Bearer token; falls back to `process.env.NOTION_TOKEN`. */
  token?: string;
  /** API base, overridable for tests and proxies. Default `https://api.notion.com/v1`. */
  apiBase?: string;
  /** Property holding the title. Default `Name`. */
  titleProperty?: string;
  /** Property holding the create marker + detail (rich_text). Default `Takumi State`. */
  stateProperty?: string;
  /** Property holding the column (select or status). Default `Status`. */
  columnProperty?: string;
  /** Optional multi_select property carrying the verdict labels. */
  labelsProperty?: string;
  /** Column option names, when they differ from the state names. */
  stateMap?: Partial<Record<DeliveryBoardState, string>>;
  /** Injected transport; tests pass a fake, production uses the curl default. */
  request?: BoardRequestFn;
}

export class NotionDeliveryBoard implements DeliveryBoardPort {
  private readonly databaseId: string;
  private readonly apiBase: string;
  private readonly titleProperty: string;
  private readonly stateProperty: string;
  private readonly columnProperty: string;
  private readonly labelsProperty: string | undefined;
  private readonly stateMap: Record<BoardWorkItemState, string>;
  private readonly request: BoardRequestFn;
  /** Learned from the database on first write; `select` is the documented default. */
  private columnType: 'select' | 'status' = 'select';
  private columnTypeKnown = false;

  constructor(opts: NotionDeliveryBoardOptions) {
    this.databaseId = normalizeDatabaseId(opts.databaseId);
    this.apiBase = (opts.apiBase ?? 'https://api.notion.com/v1').replace(/\/+$/, '');
    this.titleProperty = opts.titleProperty ?? 'Name';
    this.stateProperty = opts.stateProperty ?? 'Takumi State';
    this.columnProperty = opts.columnProperty ?? 'Status';
    this.labelsProperty = opts.labelsProperty;
    this.stateMap = { ...DEFAULT_STATE_MAP, ...opts.stateMap };
    const token = opts.token ?? process.env['NOTION_TOKEN'];
    // Fail closed: without a token there is nothing to authenticate with, so an accidental call is an
    // explicit `auth` error instead of an unauthenticated request against a workspace.
    this.request =
      opts.request ??
      (token === undefined || token.length === 0
        ? unconfiguredRequestFn('notion')
        : createNotionTransport({ token, apiBase: this.apiBase }));
  }

  metadata(): DeliveryBoardMetadata {
    return {
      id: 'notion',
      name: 'Notion Delivery Board',
      version: '0.1.0',
      description: 'A Notion database as the delivery board: one write-only row per delivery run.',
    };
  }

  /**
   * Find the row for `input.runId` and set its title, state, labels and detail — creating it when it is
   * absent. Idempotent on the run id (see the class doc): a re-run updates the row it wrote before.
   */
  async project(input: DeliveryBoardProjection): Promise<DeliveryBoardRef> {
    // Fail closed BEFORE touching the board: a label the board cannot record must not be dropped
    // silently, and the fix is a construction option, not a retry.
    if (input.labels !== undefined && input.labels.length > 0 && this.labelsProperty === undefined) {
      throw new BoardError(
        'precondition',
        `${this.metadata().id}: this board has no labels property configured, so ${input.labels.length} label(s) ` +
          `(e.g. ${JSON.stringify(input.labels[0] ?? '')}) cannot be recorded — pass labelsProperty in ` +
          'NotionDeliveryBoardOptions to project verdict labels',
      );
    }
    let marker: string;
    try {
      marker = renderCreateMarker(input.runId);
    } catch (e) {
      throw new BoardError('precondition', e instanceof Error ? e.message : String(e), { cause: e });
    }
    const stateText = input.detail === undefined || input.detail.length === 0 ? marker : `${marker}\n${input.detail}`;
    if (stateText.length > MAX_RICH_TEXT_LENGTH) {
      throw new BoardError(
        'precondition',
        `${this.metadata().id}: the run detail is ${stateText.length} chars, over Notion's ${MAX_RICH_TEXT_LENGTH}-char ` +
          'rich_text limit — shorten the detail rather than dropping it',
      );
    }

    const existing = await this.findByRunId(input.runId, marker);
    await this.learnColumnType();

    const properties: Record<string, unknown> = {
      [this.titleProperty]: { title: [richTextRun(input.title)] },
      ...this.columnPatch(input.state),
      [this.stateProperty]: { rich_text: [richTextRun(stateText)] },
    };
    if (this.labelsProperty !== undefined) {
      const merged = unionLabels(existing === null ? [] : readLabels(existing, this.labelsProperty), input.labels ?? []);
      if (merged.length > 0) properties[this.labelsProperty] = multiSelect(merged);
    }

    if (existing !== null) {
      const patched = await this.patchPage(existing.id, properties);
      return { id: existing.id, url: patched?.url ?? existing.url ?? '', created: false };
    }

    const created = await requestBoardJson<NotionPage>(
      this.request,
      {
        method: 'POST',
        url: `${this.apiBase}/pages`,
        body: { parent: { database_id: this.databaseId }, properties },
      },
      'project',
    );
    return { id: created.id, url: created.url ?? '', created: true };
  }

  /**
   * The page this run already filed, or `null`.
   *
   * The query filters this adapter's OWN machine property (`rich_text contains <marker>`) rather than
   * listing the board, and a hit is confirmed with `createKeyOf`: only a page carrying the real marker
   * is adopted, never one whose text merely mentions the run id. The query is one page (100 results) and
   * does not follow `has_more` — the honest limit this board's `createWork` also has.
   */
  private async findByRunId(runId: string, marker: string): Promise<NotionPage | null> {
    const result = await requestBoardJson<{ results?: NotionPage[] }>(
      this.request,
      {
        method: 'POST',
        url: `${this.apiBase}/databases/${this.databaseId}/query`,
        body: { page_size: 100, filter: { property: this.stateProperty, rich_text: { contains: marker } } },
      },
      'project: search',
    );
    return (result.results ?? []).find((page) => createKeyOf(this.stateTextOf(page)) === runId) ?? null;
  }

  /** The text this adapter's machine property carries on a page (`''` when absent). */
  private stateTextOf(page: NotionPage): string {
    return plainText(page.properties?.[this.stateProperty]?.rich_text);
  }

  /** The column patch, in the property type the board actually uses. */
  private columnPatch(to: DeliveryBoardState): Record<string, unknown> {
    return this.columnType === 'status'
      ? { [this.columnProperty]: { status: { name: this.stateMap[to] } } }
      : { [this.columnProperty]: { select: { name: this.stateMap[to] } } };
  }

  /**
   * Read the column property's TYPE from the database, once.
   *
   * Notion rejects a `select` value on a `status` property (and vice versa), so a projection that
   * guessed would be refused by the board for a reason the caller cannot see. One database read buys a
   * write that cannot be refused for a shape this adapter assumed.
   */
  private async learnColumnType(): Promise<void> {
    if (this.columnTypeKnown) return;
    const database = await requestBoardJson<NotionDatabase>(
      this.request,
      { method: 'GET', url: `${this.apiBase}/databases/${this.databaseId}` },
      'project: database',
    );
    const type = database.properties?.[this.columnProperty]?.type;
    if (type === 'select' || type === 'status') {
      this.columnType = type;
      this.columnTypeKnown = true;
    }
  }

  /** Patch a page's properties, returning the page Notion echoes back (`null` when it answers no JSON). */
  private async patchPage(id: string, properties: Record<string, unknown>): Promise<NotionPage | null> {
    const res = await this.request({ method: 'PATCH', url: `${this.apiBase}/pages/${id}`, body: { properties } });
    if (res.status < 200 || res.status >= 300) {
      throw new BoardError(
        'precondition',
        `${this.metadata().id}: the board refused the update of row ${id} (HTTP ${res.status}): ${res.body.slice(0, 300)}`,
      );
    }
    try {
      return JSON.parse(res.body) as NotionPage;
    } catch {
      return null;
    }
  }
}

/** Build a Notion delivery board from a `board:` section's options. */
export function createNotionDeliveryBoard(opts: NotionDeliveryBoardOptions): NotionDeliveryBoard {
  return new NotionDeliveryBoard(opts);
}
