/**
 * FakeGitRunner — a recorded, modelled worktree behind the {@link GitRunner} seam.
 *
 * WHY hand-written instead of a mocking library: this repository ships ZERO test
 * dependencies, and the delivery contract must be provable with no real git
 * repository, no network and no credentials. The double therefore answers the
 * SMALL argv vocabulary the adapter is allowed to use (`rev-parse`, `status`,
 * `merge-base --is-ancestor`, `fetch`, `merge --no-edit`, `merge --abort`,
 * `push`) and treats any other argv as an unexpected command, which the tests
 * assert never happened.
 *
 * It models the worktree as STATE, not as canned strings: a base absorption moves
 * `HEAD` to a new (deterministic) merge commit, a conflicting merge leaves a
 * conflicted worktree that `merge --abort` clears, and a push records the head
 * the remote branch would now carry.
 */

import { createHash } from 'node:crypto';
import type { GitResult, GitRunner } from '@takumi/core';

export interface FakeGitRunnerOptions {
  /** Branch the worktree is on. */
  branch: string;
  /** The committed head of the worktree. */
  head: string;
  /** The frozen base the worktree was created from. */
  frozenBase: string;
  /** Remote name the adapter should push to / fetch from (default `origin`). */
  remote?: string;
  /** Base branch name (default `main`). */
  baseBranch?: string;
  /** The remote base tip (default: the frozen base, i.e. nothing advanced). */
  remoteBase?: string;
  /** The agent left uncommitted changes behind. */
  dirty?: boolean;
  /** Absorbing the advanced base conflicts. */
  mergeConflict?: boolean;
  /** Extra shas already contained in `head` (beyond the frozen base). */
  ancestors?: readonly string[];
}

interface RecordedPush {
  argv: string[];
  head: string;
  forced: boolean;
}

/** Flags that make a push a rewrite. The adapter must never pass one. */
const FORCE_FLAGS = ['-f', '--force', '--force-with-lease', '--force-if-includes'];

/** A deterministic 40-hex sha for a derived commit (a merge commit). */
function synth(...parts: string[]): string {
  return createHash('sha1').update(parts.join(':')).digest('hex');
}

export class FakeGitRunner implements GitRunner {
  private readonly seen: string[][] = [];
  private readonly seenCwds: Array<string | null> = [];
  private readonly unexpected: string[][] = [];
  private readonly pushed: RecordedPush[] = [];
  private readonly contains: Set<string>;
  private branch: string;
  private head: string;
  private readonly frozenBase: string;
  private readonly remote: string;
  private readonly baseBranch: string;
  private remoteBase: string;
  private dirty: boolean;
  private conflict: boolean;
  private conflicted = false;
  private aborts = 0;
  private merges = 0;
  private fetched = 0;
  private pushRefusal: string | null = null;
  private lastPushedHead: string | null = null;

  constructor(options: FakeGitRunnerOptions) {
    this.branch = options.branch;
    this.head = options.head;
    this.frozenBase = options.frozenBase;
    this.remote = options.remote ?? 'origin';
    this.baseBranch = options.baseBranch ?? 'main';
    this.remoteBase = options.remoteBase ?? options.frozenBase;
    this.dirty = options.dirty ?? false;
    this.conflict = options.mergeConflict ?? false;
    // The frozen base is always an ancestor of the worktree head: that is what
    // "the worktree was created from it" means.
    this.contains = new Set([options.frozenBase, options.head, ...(options.ancestors ?? [])]);
    if (this.remoteBase === this.frozenBase) this.contains.add(this.remoteBase);
  }

  async run(args: string[], opts?: { cwd?: string }): Promise<GitResult> {
    this.seen.push([...args]);
    const cwd = opts?.cwd ?? null;
    this.seenCwds.push(cwd);
    // The adapter must name the worktree explicitly: running git in whatever the
    // process cwd happens to be is a delivery into the wrong repository.
    if (cwd === null) return this.unknownArgv(args);

    const [command, ...rest] = args;
    if (command === 'rev-parse') {
      if (rest.length === 2 && rest[0] === '--abbrev-ref' && rest[1] === 'HEAD') return ok(`${this.branch}\n`);
      if (rest.length === 1 && rest[0] === 'HEAD') return ok(`${this.head}\n`);
    }
    if (command === 'status' && rest.length === 1 && rest[0] === '--porcelain') {
      return ok(this.conflicted ? 'UU src/index.ts\n' : this.dirty ? ' M src/index.ts\n' : '');
    }
    if (command === 'merge-base' && rest.length === 3 && rest[0] === '--is-ancestor' && rest[2] === 'HEAD') {
      const ancestor = this.resolve(rest[1] as string);
      return ancestor !== undefined && this.contains.has(ancestor) ? ok('') : { stdout: '', stderr: '', exitCode: 1 };
    }
    if (command === 'fetch' && rest.length === 2 && rest[0] === this.remote && rest[1] === this.baseBranch) {
      this.fetched += 1;
      return ok('');
    }
    if (command === 'merge' && rest.length === 1 && rest[0] === '--abort') {
      if (!this.conflicted) return this.unknownArgv(args);
      this.conflicted = false;
      this.aborts += 1;
      return ok('');
    }
    if (command === 'merge' && rest.length === 2 && rest[0] === '--no-edit' && rest[1] === `${this.remote}/${this.baseBranch}`) {
      if (this.conflict) {
        this.conflicted = true;
        return { stdout: '', stderr: 'CONFLICT (content): Merge conflict in src/index.ts\n', exitCode: 1 };
      }
      // A plain merge of the advanced base: a NEW commit on top of both tips.
      const mergeCommit = synth('merge', this.head, this.remoteBase);
      this.contains.add(this.head);
      this.contains.add(this.remoteBase);
      this.head = mergeCommit;
      this.contains.add(mergeCommit);
      this.merges += 1;
      return ok('');
    }
    if (command === 'push' && rest.length === 2 && rest[0] === this.remote && rest[1] === this.branch) {
      if (this.pushRefusal !== null) {
        // A plain push the host rejects: the adapter must NOT retry it with a
        // force flag, and must not pretend the branch reached the host.
        return { stdout: '', stderr: this.pushRefusal, exitCode: 1 };
      }
      this.pushed.push({ argv: [...args], head: this.head, forced: args.some((a) => FORCE_FLAGS.includes(a)) });
      this.lastPushedHead = this.head;
      return ok('');
    }
    return this.unknownArgv(args);
  }

  // --- recorded facts -------------------------------------------------------

  /** Every argv the adapter issued, in order, as deep copies. */
  argv(): string[][] {
    return this.seen.map((args) => [...args]);
  }

  /** `git <argv>` per command, in order — the readable form of {@link argv}. */
  commands(): string[] {
    return this.seen.map((args) => `git ${args.join(' ')}`);
  }

  /** The `cwd` of every command (`null` when the adapter did not name one). */
  cwds(): Array<string | null> {
    return [...this.seenCwds];
  }

  /** Every push, in order, with the head it carried. */
  pushes(): RecordedPush[] {
    return this.pushed.map((push) => ({ ...push, argv: [...push.argv] }));
  }

  /** Commands matching the adapter's vocabulary that the fake could not answer. */
  unexpectedArgv(): string[][] {
    return this.unexpected.map((args) => [...args]);
  }

  /** Pushes that carried a force flag — must always be empty. */
  forcePushes(): RecordedPush[] {
    return this.pushed.filter((push) => push.forced);
  }

  /** Times an advanced base was merged into the task branch. */
  baseMerges(): number {
    return this.merges;
  }

  /** Times a conflicting merge was aborted. */
  mergeAborts(): number {
    return this.aborts;
  }

  fetchCount(): number {
    return this.fetched;
  }

  /** The worktree's committed head right now. */
  currentHead(): string {
    return this.head;
  }

  /** The head the source branch carries on the remote (i.e. after the last push). */
  pushedHead(): string | null {
    return this.lastPushedHead;
  }

  // --- state control --------------------------------------------------------

  setBranch(branch: string): void {
    this.branch = branch;
  }

  setHead(head: string): void {
    this.head = head;
  }

  /** Simulate the remote base advancing past the frozen base. */
  setRemoteBase(remoteBase: string): void {
    this.remoteBase = remoteBase;
    this.contains.add(remoteBase);
  }

  /**
   * Replace the ancestry of the worktree head. Used to model a REWRITTEN branch:
   * a head that no longer contains the frozen base.
   */
  setAncestry(shas: readonly string[]): void {
    this.contains.clear();
    for (const sha of shas) this.contains.add(sha);
  }

  setDirty(dirty: boolean): void {
    this.dirty = dirty;
  }

  setMergeConflict(conflict: boolean): void {
    this.conflict = conflict;
  }

  /** Make every push fail with this stderr (a rejected non-fast-forward, an auth failure). */
  setPushRefusal(stderr: string | null): void {
    this.pushRefusal = stderr;
  }

  /** Resolve a ref the adapter may name (`<remote>/<baseBranch>`) to a sha. */
  private resolve(ref: string): string | undefined {
    if (ref === `${this.remote}/${this.baseBranch}`) return this.remoteBase;
    if (ref === this.frozenBase) return this.frozenBase;
    return ref.length > 0 ? ref : undefined;
  }

  private unknownArgv(args: string[]): GitResult {
    this.unexpected.push([...args]);
    return { stdout: '', stderr: `fake-git: unexpected argv: git ${args.join(' ')}`, exitCode: 127 };
  }
}

function ok(stdout: string): GitResult {
  return { stdout, stderr: '', exitCode: 0 };
}
