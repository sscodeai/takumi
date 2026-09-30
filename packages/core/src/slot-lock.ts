/**
 * The slot lock: one runner per repository (or per work item) at a time.
 *
 * ADR-006's board adapters all declare `atomicClaim: false` — none of GitHub,
 * GitLab, Jira, Notion or Redmine can be made to accept a claim conditionally, so
 * two runners sharing one account can both believe they own the same item. Every
 * adapter test says so, and the documentation said the lock was "the caller's
 * job". A caller is not able to do that job: exclusion needs a primitive that
 * survives a crash, and this module is it.
 *
 * WHY NOT `fcntl.flock` (what orbi uses): Node exposes no flock, and adding a
 * native dependency to a zero-dependency project to get it is the wrong trade.
 * The portable equivalent here is an O_EXCL lock file holding the owner's
 * identity, with two independent ways to decide a lock is abandoned:
 *
 *   1. the owner's process is provably gone (signal 0 → ESRCH), or
 *   2. the lock has not been refreshed within `staleAfterSeconds` (a heartbeat
 *      touches it), which also covers a HUNG owner and PID reuse — the two cases
 *      a liveness check alone gets wrong.
 *
 * That difference is real and is not hidden: flock releases the instant the
 * process dies; this releases the instant someone notices. A healthy holder
 * heartbeats, so the window only ever opens for a dead or wedged runner.
 */

import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';

import { ProviderError } from './provider-error.js';

/** Identity recorded inside a held lock. Observational metadata, never the lock itself. */
export interface SlotOwner {
  runId: string;
  /** The work item being processed, when the slot is per-item. */
  itemId?: string;
  /** Process holding the lock (defaults to this process). */
  pid?: number;
  host?: string;
  /** ISO timestamp, for humans reading the file. */
  acquiredAt?: string;
}

export interface SlotLockOptions {
  /** Directory holding the lock files. Created if absent. */
  dir: string;
  /**
   * Slot key. Use a fixed key to serialise a whole repository (`repo`), or the
   * item id to serialise one work item while several run in parallel.
   */
  key: string;
  owner: SlotOwner;
  /** Take over a lock nobody refreshed for this long. Default 30 minutes. */
  staleAfterSeconds?: number;
  /** Heartbeat interval. Default a third of `staleAfterSeconds`. */
  heartbeatSeconds?: number;
}

export interface SlotHandle {
  readonly path: string;
  readonly owner: SlotOwner;
  /** Refresh the lock so it cannot be taken over as stale. */
  heartbeat(): void;
  /** Start refreshing automatically. Idempotent; the timer is unref'd. */
  startHeartbeat(): void;
  /** Releasing twice is safe. */
  release(): void;
}

export interface SlotAcquisition {
  acquired: boolean;
  /** Present when acquired. */
  handle?: SlotHandle;
  /** Present when not acquired: who holds it and why it is not stale. */
  heldBy?: SlotOwner;
  /** Present when not acquired: a human-readable reason. */
  reason?: string;
  /** The lock file involved. */
  path: string;
}

const DEFAULT_STALE_SECONDS = 30 * 60;

/** The lock file for a key. Keys are slugified so a work item id cannot escape the dir. */
export function slotLockPath(dir: string, key: string): string {
  const safe = key
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    // Dots survive for readability (`item-7.2.lock`), but a `..` run must not: even
    // though separators are already gone, a name that reads as traversal invites
    // the next reader to assume it is safe.
    .replace(/\.{2,}/g, '_')
    .replace(/^[._-]+/, '');
  return join(dir, `${safe.length === 0 ? 'slot' : safe}.lock`);
}

function readOwner(path: string): { owner: SlotOwner | null; mtimeMs: number } {
  const mtimeMs = statMtime(path);
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<SlotOwner>;
    return {
      owner: {
        runId: typeof parsed.runId === 'string' ? parsed.runId : 'unknown',
        ...(typeof parsed.itemId === 'string' ? { itemId: parsed.itemId } : {}),
        ...(typeof parsed.pid === 'number' ? { pid: parsed.pid } : {}),
        ...(typeof parsed.host === 'string' ? { host: parsed.host } : {}),
        ...(typeof parsed.acquiredAt === 'string' ? { acquiredAt: parsed.acquiredAt } : {}),
      },
      mtimeMs,
    };
  } catch {
    // An unreadable file (including one being written right now) is not an owner.
    return { owner: null, mtimeMs };
  }
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** True when a process with this pid exists (EPERM counts as alive: it is not ours). */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/**
 * Try to take `key` exclusively.
 *
 * Never throws for "someone else holds it" — that is a normal answer a runner
 * ticks on. Throws `ProviderError('precondition')` only for a malformed request
 * (no key, bad stale window).
 */
export function acquireSlot(options: SlotLockOptions): SlotAcquisition {
  const { dir, key, owner } = options;
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_SECONDS;
  if (key.trim().length === 0) {
    throw new ProviderError('precondition', 'a slot lock needs a key');
  }
  if (!Number.isFinite(staleAfterSeconds) || staleAfterSeconds <= 0) {
    throw new ProviderError('precondition', `staleAfterSeconds must be positive, got ${String(staleAfterSeconds)}`);
  }
  mkdirSync(dir, { recursive: true });
  const path = slotLockPath(dir, key);

  const identity: SlotOwner = {
    runId: owner.runId,
    ...(owner.itemId === undefined ? {} : { itemId: owner.itemId }),
    pid: owner.pid ?? process.pid,
    host: owner.host ?? hostname(),
    acquiredAt: owner.acquiredAt ?? new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // O_EXCL: the create IS the lock, on POSIX and on Windows alike.
      const fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, `${JSON.stringify(identity)}\n`);
      } finally {
        closeSync(fd);
      }
      return { acquired: true, handle: makeHandle(path, identity, options), path };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    const { owner: holder, mtimeMs } = readOwner(path);
    const ageSeconds = (Date.now() - mtimeMs) / 1000;
    // Two independent abandonment rules: a provably dead owner, or a lock nobody
    // refreshed. The second covers a hung owner and a recycled pid.
    const dead = holder?.pid !== undefined && holder.pid !== identity.pid && !isProcessAlive(holder.pid);
    const stale = mtimeMs > 0 && ageSeconds > staleAfterSeconds;
    if (!dead && !stale && attempt === 0) {
      return {
        acquired: false,
        ...(holder === null ? {} : { heldBy: holder }),
        reason:
          holder === null
            ? `slot ${key} is held by an unreadable lock file at ${path}`
            : `slot ${key} is held by run ${holder.runId}${holder.itemId === undefined ? '' : ` (item ${holder.itemId})`} ` +
              `on ${holder.host ?? 'an unknown host'} since ${holder.acquiredAt ?? 'an unknown time'}`,
        path,
      };
    }
    try {
      unlinkSync(path);
    } catch {
      // Someone else cleaned it up first; the next attempt will tell us.
    }
    // Loop once more: either we win the O_EXCL create or the new owner wins.
  }

  return { acquired: false, reason: `slot ${key} was taken by another process while taking it over`, path };
}

function makeHandle(path: string, owner: SlotOwner, options: SlotLockOptions): SlotHandle {
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_SECONDS;
  const heartbeatMs = (options.heartbeatSeconds ?? Math.max(1, Math.floor(staleAfterSeconds / 3))) * 1000;
  let released = false;
  let timer: NodeJS.Timeout | undefined;

  const heartbeat = (): void => {
    if (released) return;
    const now = new Date();
    try {
      utimesSync(path, now, now);
    } catch {
      // The file is gone: someone took the slot over, or the state dir was wiped.
      // Nothing to refresh — the next acquisition decides.
    }
  };

  return {
    path,
    owner,
    heartbeat,
    startHeartbeat(): void {
      if (timer !== undefined || released) return;
      timer = setInterval(heartbeat, heartbeatMs);
      timer.unref();
    },
    release(): void {
      if (released) return;
      released = true;
      if (timer !== undefined) clearInterval(timer);
      // Only remove OUR lock: never delete a file another run has taken over.
      const { owner: current } = readOwner(path);
      if (current === null || current.runId !== owner.runId || (current.pid ?? 0) !== (owner.pid ?? 0)) return;
      try {
        unlinkSync(path);
      } catch {
        // Already gone; the desired state is reached either way.
      }
    },
  };
}

/** The outcome of running `fn` under a slot. */
export interface SlotRunResult<T> {
  /** `'ran'` when the slot was free, `'busy'` when another run holds it. */
  outcome: 'ran' | 'busy';
  /** Set when `outcome === 'ran'`. */
  value?: T;
  /** Set when `outcome === 'busy'`. */
  reason?: string;
}

/**
 * Run `fn` under the slot, releasing it whatever happens.
 *
 * The busy case is a RESULT, not an exception: a scheduled runner must be able to
 * journal "someone else is working on this repo" and exit 0.
 */
export async function withSlot<T>(
  options: SlotLockOptions,
  fn: (handle: SlotHandle) => Promise<T>,
): Promise<SlotRunResult<T>> {
  const acquisition = acquireSlot(options);
  if (!acquisition.acquired || acquisition.handle === undefined) {
    return { outcome: 'busy', ...(acquisition.reason === undefined ? {} : { reason: acquisition.reason }) };
  }
  const handle = acquisition.handle;
  handle.startHeartbeat();
  try {
    return { outcome: 'ran', value: await fn(handle) };
  } finally {
    handle.release();
  }
}
