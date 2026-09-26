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
 * 3. **Projections are rebuildable.** `resync()` re-derives every mirror item's state from the
 *    primary, so a mirror that drifted — or was never reachable — can be brought back without
 *    touching the primary. The id map is a cache, not a source of truth: losing it costs API calls,
 *    never correctness.
 * 4. **Identity is carried by a marker, not by hope.** The mirror item is created with
 *    `<!-- takumi:mirror:<primaryId> -->` in its body and an idempotency key derived from the
 *    primary's item, so the projection can be re-run without creating duplicates.
 * 5. **What is mirrored is what a PERSON reads**: the delivery state and the comments. The state
 *    RECORD is deliberately not mirrored: it is the control-flow surface, and a mirror is for
 *    readers — copying it would invite exactly the confusion rule 1 exists to prevent.
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

  /** The boards this one projects onto, for `takumi board --check` to report. */
  mirrorsList(): Array<{ id: string; canCreateWork: boolean; editableComment: boolean }> {
    return this.mirrors.map((m) => {
      const caps = m.board.capabilities();
      return { id: m.id, canCreateWork: caps.canCreateWork, editableComment: caps.editableComment };
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
        const ok = await this.projectItem(mirror, item.id, item.state, item.title, item.body ?? '');
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
      await this.projectItem(mirror, item.id, item.state, item.title, item.body ?? '');
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
      await this.projectItem(mirror, primaryItemId, state, item.title, item.body ?? '');
    }
  }

  private async projectComment(primaryItemId: string, body: string, runId: string): Promise<void> {
    for (const mirror of this.mirrors) {
      const mirrorItemId = await this.ensureMirrorItem(mirror, primaryItemId);
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
    primaryItemId: string,
    state: BoardWorkItemState,
    title: string,
    body: string,
  ): Promise<boolean> {
    const mirrorItemId = await this.ensureMirrorItem(mirror, primaryItemId, title, body);
    if (mirrorItemId === null) return false;
    try {
      const current = await mirror.board.getWork(mirrorItemId);
      if (current.state !== state) {
        await mirror.board.transition(mirrorItemId, state, { runId: this.runId, note: `mirror of ${this.primary.metadata().id}/${primaryItemId}` });
      }
      this.emit('mirror.written', mirror.id, primaryItemId, `state ${state} projected onto ${mirror.id}`);
      return true;
    } catch (error) {
      // The mirror's own state table (or its columns) may not accept this state. That is a fact
      // about the mirror to REPORT, not a reason to stop the work the primary already recorded.
      this.emit('mirror.failed', mirror.id, primaryItemId, `state ${state} not projected onto ${mirror.id}: ${reasonOf(error)}`);
      return false;
    }
  }

  /**
   * The mirror's id for a primary item, creating the mirror item when it is missing.
   *
   * The map is the fast path; creating is the slow path, and it is idempotent because the marker
   * and the idempotency key both derive from the primary item. A mirror that cannot create work is
   * reported (once per attempt) and skipped — never silently absent.
   */
  private async ensureMirrorItem(mirror: BoardMirror, primaryItemId: string, title?: string, body?: string): Promise<string | null> {
    const cached = this.map[primaryItemId]?.[mirror.id];
    if (cached !== undefined) return cached;
    if (!mirror.board.capabilities().canCreateWork) {
      this.emit('mirror.failed', mirror.id, primaryItemId, `${mirror.id} cannot create work, so it cannot be projected onto`);
      return null;
    }
    try {
      const created = await mirror.board.createWork({
        title: title ?? `mirror of ${primaryItemId}`,
        body: `${body ?? ''}\n\n${mirrorMarker(primaryItemId)}\n`,
        idempotencyKey: `mirror:${this.primary.metadata().id}:${primaryItemId}`,
        labels: [],
      });
      const mirrorItemId = created.item.id;
      this.map[primaryItemId] = { ...(this.map[primaryItemId] ?? {}), [mirror.id]: mirrorItemId };
      this.emit('mirror.written', mirror.id, primaryItemId, `created the mirror item as ${mirrorItemId}`);
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
