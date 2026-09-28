/**
 * MirroringBoard — ONE authoritative board, plus N write-only projections of it.
 *
 * WHY THIS SHAPE (and not "several boards")
 *
 * A team often has two boards for one reality: the one takumi works from (GitHub, GitLab, Jira,
 * Redmine — the one that owns the work and where the pull request happens) and the one other
 * people actually look at (Notion, a second Redmine project, a dashboard board). They are not
 * alternatives, they are an EXTENSION: the second board is a projection of the first, for readers.
 *
 * This decorator implements exactly that, as a `TaskBoardProvider`, so the pilot, the delivery
 * loop and every delivery adapter need ZERO changes: the port boundary is the seam.
 *
 * THE RULES IT KEEPS (each one exists because the alternative is a specific kind of lie)
 *
 * 1. **Exactly one authority.** Reading, claiming, the state record, bootstrap and EVERY decision
 *    go to the primary. A mirror is never read for control flow: someone editing the Notion page
 *    must not be able to change what takumi does — which is the same rule as "control flow only
 *    follows trusted authors", applied one level up.
 * 2. **A mirror failure never fails the delivery — and is never silent.** The projection runs
 *    after the primary has already committed the fact, best-effort, and any failure is emitted as
 *    `mirror.failed` with the reason. Silently dropping it would leave a stale board that people
 *    trust; failing the tick for it would let a decorative board block real work. Both are wrong,
 *    so it is loud and non-fatal.
 * 3. **Projections are rebuildable.** `resync()` re-derives every mirror item from the primary —
 *    its state, its text and its labels — so a mirror that drifted, was never reachable, or was
 *    filed by an older version of this code can be brought back without touching the primary. It
 *    RE-ASSERTS the create for every item rather than trusting the id map, because the map knows
 *    only that a copy exists, never that the copy is complete. The map is a cache, not a source of
 *    truth: losing it costs API calls, never correctness.
 * 4. **Identity is carried by a marker, not by hope.** The mirror item is created with
 *    `<!-- takumi:mirror:<primaryId> -->` in its body and an idempotency key derived from the
 *    primary's item, so the projection can be re-run without creating duplicates.
 * 5. **What is mirrored is what a PERSON reads**: the delivery state, the text and the comments. The
 *    state RECORD is deliberately not mirrored: it is the control-flow surface, and a mirror is for
 *    readers — copying it would invite exactly the confusion rule 1 exists to prevent.
 * 6. **A projection is complete or it is loud.** The item's title, its text and its labels all go
 *    over together, and a mirror that can hold only some of them is a CONFIGURATION (`labels: false`),
 *    not a runtime decision made by guessing what someone else's error meant. Forgetting a field
 *    quietly is how a board becomes a summary of the truth that people nevertheless trust.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { BoardStateRecord } from './board-state-record.js';
import type { EventLog } from './events.js';
import { nullEventLog } from './events.js';
import type {
  BoardBootstrapReport,
  BoardCommentRef,
  BoardProviderMetadata,
  BoardWorkItem,
  BoardWorkItemSpec,
  BoardWorkItemState,
  BoardWorkQuery,
  BoardCapabilities,
  ClaimResult,
  BoardCommentAuthor,
  BoardTransitionEvidence,
  CreateWorkResult,
  TaskBoardProvider,
} from './task-board.js';


/** One write-only projection target. */
export interface BoardMirror {
  /** Name used in events and in the id map (e.g. `notion`). */
  id: string;
  /** The board to project onto. */
  board: TaskBoardProvider;
  /**
   * Project the authority's labels onto this mirror. Default **true**.
   *
   * WHY this is a choice and not a fallback: labels are part of what an item IS (they are how a
   * board says "flaky", "p1", "backend"), so dropping them silently is the one thing a projection
   * may not do. A mirror board that cannot record them REFUSES the create — correctly, fail-closed
   * — and the projection then fails loudly per item instead of quietly filing rows without them.
   * An operator whose mirror genuinely has no labels column sets `labels: false` here, once, and
   * gets the rows; nobody has to guess which failure was about labels.
   */
  labels?: boolean;
}

export interface MirroringBoardOptions {
  /** The event trail. Mirror writes and failures are facts, and failures must not be silent. */
  events?: EventLog;
  /** The run this composite acts for, recorded in the events. */
  runId?: string;
}

/** `primaryItemId -> { mirrorId -> mirrorItemId }`. A cache: losing it costs calls, not truth. */
export type MirrorIdMap = Record<string, Record<string, string>>;

/** The marker that ties a mirror item back to the primary one. */
export function mirrorMarker(primaryItemId: string): string {
  return `<!-- takumi:mirror:${primaryItemId} -->`;
}

export class MirroringBoard implements TaskBoardProvider {
  private readonly events: EventLog;
  private readonly runId: string;
  private map: MirrorIdMap = {};

  constructor(
    private readonly primary: TaskBoardProvider,
    private readonly mirrors: BoardMirror[],
    private readonly options: MirroringBoardOptions = {},
  ) {
    this.events = options.events ?? nullEventLog();
    this.runId = options.runId ?? 'mirror000';
    if (mirrors.length === 0) {
      throw new Error('MirroringBoard needs at least one mirror: without one it is just the primary');
    }
    const ids = new Set(mirrors.map((m) => m.id));
    if (ids.size !== mirrors.length) throw new Error('mirror ids must be unique (they name the projections)');
  }

  /**
   * The boards this one projects onto, for `takumi board --check` and the pilot to report.
   *
   * `labels` is part of the report because it is part of what a projection CARRIES: an operator
   * reading a mirror's configuration must be able to see that this one is filed without its
   * labels, on purpose, rather than wonder why a column is always empty.
   */
  mirrorsList(): Array<{ id: string; canCreateWork: boolean; editableComment: boolean; labels: boolean }> {
    return this.mirrors.map((m) => {
      const caps = m.board.capabilities();
      return {
        id: m.id,
        canCreateWork: caps.canCreateWork,
        editableComment: caps.editableComment,
        labels: m.labels !== false,
      };
    });
  }

  /**
   * Re-derive every mirror's state from the primary — for a mirror that was unreachable, drifted,
   * or did not exist when the work started. Returns what was projected and what failed; it never
   * throws for a mirror's failure (rule 2).
   */
  async resync(): Promise<Array<{ mirror: string; projected: number; failed: number }>> {
    const states: BoardWorkItemState[] = ['ready', 'claimed', 'pr_open', 'fix_needed', 'merged', 'blocked'];
    const items = await this.primary.listWork({ states });
    const report = this.mirrors.map((mirror) => ({ mirror: mirror.id, projected: 0, failed: 0 }));
    for (const item of items) {
      for (const [index, mirror] of this.mirrors.entries()) {
        // `reassert`: a resync re-runs the create for EVERY item instead of trusting the id map,
        // because the map knows only THAT a copy exists — never that the copy is COMPLETE. An
        // adapter that can complete a page (Notion appends a body it never carried) does exactly
        // that here, which is what makes "a projection is rebuildable" a fact rather than a hope.
        const ok = await this.projectItem(mirror, item, { reassert: true });
        if (ok) report[index]!.projected += 1;
        else report[index]!.failed += 1;
      }
    }
    return report;
  }

  // --- control flow: the PRIMARY, always -----------------------------------------------------------------

  metadata(): BoardProviderMetadata {
    // The composite IS the primary as far as every caller is concerned: id, name, version are the
    // authority's. The mirrors are reported separately (mirrorsList) rather than impersonating it.
    return this.primary.metadata();
  }

  capabilities(): BoardCapabilities {
    return this.primary.capabilities();
  }

  listWork(query?: BoardWorkQuery): Promise<BoardWorkItem[]> {
    return this.primary.listWork(query);
  }

  getWork(id: string): Promise<BoardWorkItem> {
    return this.primary.getWork(id);
  }

  claim(id: string, runId: string): Promise<ClaimResult> {
    return this.primary.claim(id, runId);
  }

  readState(id: string): Promise<BoardStateRecord | null> {
    return this.primary.readState(id);
  }

  bootstrapStates(desired: readonly BoardWorkItemState[], opts?: { dryRun?: boolean }): Promise<BoardBootstrapReport> {
    return this.primary.bootstrapStates(desired, opts);
  }

  // --- writes that a reader would want to see: primary first, then project ------------------------------

  async createWork(spec: BoardWorkItemSpec): Promise<CreateWorkResult> {
    const created = await this.primary.createWork(spec);
    const item = created.item;
    for (const mirror of this.mirrors) {
      // The item as the PRIMARY returns it: title, text and labels all travel, and the state it is
      // already in is the state the copy opens in.
      await this.projectItem(mirror, item);
    }
    return created;
  }

  async transition(id: string, to: BoardWorkItemState, evidence: BoardTransitionEvidence): Promise<void> {
    // The primary decides and records; a mirror must never be able to veto or delay that.
    await this.primary.transition(id, to, evidence);
    await this.projectState(id, to);
  }

  async comment(id: string, body: string, opts: { runId: string; author?: BoardCommentAuthor }): Promise<BoardCommentRef> {
    const ref = await this.primary.comment(id, body, opts);
    await this.projectComment(id, body, opts.runId);
    return ref;
  }

  /** Editing a comment is a primary concern: a mirror that cannot edit (Notion) would need a new
   *  comment per edit, which is a decision for the projection, not for the caller. */
  updateComment(ref: BoardCommentRef, body: string): Promise<void> {
    return this.primary.updateComment(ref, body);
  }

  /** The state record is the CONTROL-FLOW surface and is never mirrored (rule 5). */
  writeState(id: string, record: BoardStateRecord, opts?: { author?: BoardCommentAuthor }): Promise<void> {
    return this.primary.writeState(id, record, opts);
  }

  // --- the projection itself ----------------------------------------------------------------------------

  private async projectState(primaryItemId: string, state: BoardWorkItemState): Promise<void> {
    const item = await this.primary.getWork(primaryItemId);
    for (const mirror of this.mirrors) {
      // The state is passed explicitly rather than read off `item`: it is the state the caller just
      // asked for, and reading it back would make the projection depend on a second read agreeing.
      await this.projectItem(mirror, item, { state });
    }
  }

  private async projectComment(primaryItemId: string, body: string, runId: string): Promise<void> {
    for (const mirror of this.mirrors) {
      // A comment can be the FIRST thing a mirror hears about an item (a mirror configured while work
      // was already in flight), so the state is READ from the authority rather than assumed: creating
      // the copy at `ready` would state something false about work that is already merged.
      const known = this.map[primaryItemId]?.[mirror.id] !== undefined;
      const state = known ? undefined : (await this.primary.getWork(primaryItemId)).state;
      const mirrorItemId = await this.ensureMirrorItem(mirror, primaryItemId, { state });
      if (mirrorItemId === null) continue;
      try {
        await mirror.board.comment(mirrorItemId, body, { runId });
        this.emit('mirror.written', mirror.id, primaryItemId, `comment projected onto ${mirror.id}`);
      } catch (error) {
        this.emit('mirror.failed', mirror.id, primaryItemId, `comment not projected onto ${mirror.id}: ${reasonOf(error)}`);
      }
    }
  }

  /** Ensure the mirror's copy exists and says `state`. Returns false when the mirror could not take it. */
  private async projectItem(
    mirror: BoardMirror,
    item: BoardWorkItem,
    opts: { state?: BoardWorkItemState; reassert?: boolean } = {},
  ): Promise<boolean> {
    const state = opts.state ?? item.state;
    const mirrorItemId = await this.ensureMirrorItem(
      mirror,
      item.id,
      { state, title: item.title, body: item.body ?? '', labels: item.labels },
      { reassert: opts.reassert === true },
    );
    if (mirrorItemId === null) return false;
    try {
      const current = await mirror.board.getWork(mirrorItemId);
      if (current.state !== state) {
        await mirror.board.transition(mirrorItemId, state, { runId: this.runId, note: `mirror of ${this.primary.metadata().id}/${item.id}` });
      }
      this.emit('mirror.written', mirror.id, item.id, `state ${state} projected onto ${mirror.id}`);
      return true;
    } catch (error) {
      // The mirror's own state table (or its columns) may not accept this state. That is a fact
      // about the mirror to REPORT, not a reason to stop the work the primary already recorded.
      this.emit('mirror.failed', mirror.id, item.id, `state ${state} not projected onto ${mirror.id}: ${reasonOf(error)}`);
      return false;
    }
  }

  /**
   * The mirror's id for a primary item, creating (or re-asserting) the mirror item.
   *
   * The map is the fast path; creating is the slow path, and it is idempotent because the marker
   * and the idempotency key both derive from the primary item. A mirror that cannot create work is
   * reported (once per attempt) and skipped — never silently absent.
   *
   * `reassert` re-runs that create even when the map already knows the id. It costs a query per
   * item and it is the ONLY way a projection that exists but is incomplete can be completed: what
   * is missing lives on the mirror's side, and an id in a cache cannot tell anyone about it.
   */
  private async ensureMirrorItem(
    mirror: BoardMirror,
    primaryItemId: string,
    spec: { state?: BoardWorkItemState; title?: string; body?: string; labels?: string[] },
    opts: { reassert?: boolean } = {},
  ): Promise<string | null> {
    const cached = this.map[primaryItemId]?.[mirror.id];
    if (cached !== undefined && opts.reassert !== true) return cached;
    if (!mirror.board.capabilities().canCreateWork) {
      this.emit('mirror.failed', mirror.id, primaryItemId, `${mirror.id} cannot create work, so it cannot be projected onto`);
      return null;
    }
    // The labels the authority carries. A mirror board that cannot record them refuses the create
    // (correctly, fail-closed), so an operator whose mirror has no labels property opts OUT here —
    // once, in the config — instead of this decorator guessing, from someone else's error string,
    // that a refused create was about nothing but labels.
    const labels = mirror.labels === false ? [] : spec.labels ?? [];
    try {
      // The mirror item is created IN the state it is being projected for, not at `ready` and then
      // walked there. The walk does not exist: the state table allows `ready -> claimed` and nothing
      // else out of `ready`, so a projection of an in-flight item (pr_open, merged) could never be
      // built — which is exactly what a resync of real work does. Found by wiring this decorator to a
      // caller for the first time; every adapter already honoured `spec.state`.
      const created = await mirror.board.createWork({
        title: spec.title ?? `mirror of ${primaryItemId}`,
        body: `${spec.body ?? ''}\n\n${mirrorMarker(primaryItemId)}\n`,
        idempotencyKey: `mirror:${this.primary.metadata().id}:${primaryItemId}`,
        labels,
        ...(spec.state === undefined ? {} : { state: spec.state }),
      });
      const mirrorItemId = created.item.id;
      this.map[primaryItemId] = { ...(this.map[primaryItemId] ?? {}), [mirror.id]: mirrorItemId };
      if (cached === undefined) this.emit('mirror.written', mirror.id, primaryItemId, `created the mirror item as ${mirrorItemId}`);
      return mirrorItemId;
    } catch (error) {
      this.emit('mirror.failed', mirror.id, primaryItemId, `could not create the mirror item: ${reasonOf(error)}`);
      return null;
    }
  }

  /**
   * The id map, for the caller to persist. It is a CACHE: a projection can always be rebuilt from
   * the primary (see `resync`), so nothing here is load-bearing for correctness.
   */
  idMap(): MirrorIdMap {
    return this.map;
  }

  loadIdMap(map: MirrorIdMap): void {
    this.map = map;
  }

  private emit(kind: 'mirror.written' | 'mirror.failed', mirror: string, primaryItemId: string, message: string): void {
    this.events.emit({
      kind,
      runId: this.runId,
      itemId: primaryItemId,
      fields: { mirror, primary: this.primary.metadata().id, primaryItemId },
      message,
    });
  }
}

function reasonOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Read a persisted id map, tolerating absence and damage (it is a cache, not a source of truth). */
export function readMirrorIdMap(path: string): MirrorIdMap {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as MirrorIdMap) : {};
  } catch {
    return {};
  }
}

/** Persist the id map. A failure here is reported by the CALLER, never thrown at a delivery. */
export function writeMirrorIdMap(path: string, map: MirrorIdMap): void {
  writeFileSync(path, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
}
