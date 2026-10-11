/**
 * A recorded git runner for the Forgejo adapter's tests.
 *
 * The adapter must never call `child_process` itself; it performs its git work
 * through the injected {@link GitRunner}. That is what makes "did it force-push?"
 * a question a test can answer from the recorded argv instead of something the
 * adapter merely reports about itself.
 *
 * This double models exactly the commands the adapter issues — and NOTHING else.
 * `unexpectedArgv()` is the assertion that keeps it honest: if the adapter ever
 * grows a new git call, the test fails loudly instead of the fake silently
 * answering it.
 */

import type { GitResult, GitRunner } from '@takumi/core';

export interface FakeGitRunnerOptions {
  /** The branch the worktree is checked out on. */
  branch: string;
  /** The worktree's committed head. */
  head: string;
  /** The frozen base takumi created the worktree from. */
  frozenBase: string;
  remote?: string;
  baseBranch?: string;
  /** What `<remote>/<baseBranch>` points at (differs from the frozen base when the base advanced). */
  remoteBase?: string;
  /** Simulate a base-absorption conflict. */
  mergeConflict?: boolean;
}

export interface RecordedPush {
  argv: string[];
  head: string;
}

/** The head the fake reports after a successful plain base merge. */
export const MERGED_HEAD = `${'e'.repeat(12)}merged0000000`;

export class FakeGitRunner implements GitRunner {
  branch: string;
  head: string;
  frozenBase: string;
  remote: string;
  baseBranch: string;
  remoteBase: string;
  mergeConflict: boolean;

  dirty = false;
  rejectPush = false;
  baseAbsorbed = false;
  /** When set, the exact set of commits that are ancestors of HEAD. */
  ancestry: string[] | null = null;

  private readonly argvLog: string[][] = [];
  private pushed: string | null = null;

  constructor(options: FakeGitRunnerOptions) {
    this.branch = options.branch;
    this.head = options.head;
    this.frozenBase = options.frozenBase;
    this.remote = options.remote ?? 'origin';
    this.baseBranch = options.baseBranch ?? 'main';
    this.remoteBase = options.remoteBase ?? options.frozenBase;
    this.mergeConflict = options.mergeConflict ?? false;
  }

  async run(args: string[]): Promise<GitResult> {
    this.argvLog.push([...args]);
    const ok = (stdout = ''): GitResult => ({ stdout, stderr: '', exitCode: 0 });
    const fail = (stderr: string): GitResult => ({ stdout: '', stderr, exitCode: 1 });

    switch (args[0]) {
      case 'rev-parse':
        return args[1] === '--abbrev-ref' ? ok(`${this.branch}\n`) : ok(`${this.head}\n`);
      case 'status':
        return ok(this.dirty ? ' M README.md\n' : '');
      case 'fetch':
        return ok('');
      case 'merge-base': {
        // ['merge-base', '--is-ancestor', <ancestor>, <descendant>]
        const ancestor = args[2] ?? '';
        if (this.ancestry !== null) return { stdout: '', stderr: '', exitCode: this.ancestry.includes(ancestor) ? 0 : 1 };
        if (ancestor.startsWith(`${this.remote}/`)) {
          return { stdout: '', stderr: '', exitCode: this.remoteBase === this.frozenBase || this.baseAbsorbed ? 0 : 1 };
        }
        return { stdout: '', stderr: '', exitCode: ancestor === this.frozenBase ? 0 : 1 };
      }
      case 'merge': {
        if (args[1] === '--abort') return ok('');
        if (this.mergeConflict) return fail('CONFLICT (content): merge conflict in README.md');
        this.baseAbsorbed = true;
        this.head = MERGED_HEAD;
        return ok('Merge made by the ort strategy.\n');
      }
      case 'push': {
        if (this.rejectPush) {
          return fail(`! [rejected] ${this.branch} -> ${this.branch} (non-fast-forward)`);
        }
        this.pushed = this.head;
        return ok('');
      }
      default:
        return fail(`unknown command: ${args.join(' ')}`);
    }
  }

  // --- recorders (what the adapter actually did) ---

  argv(): string[][] {
    return this.argvLog.map((args) => [...args]);
  }

  commands(): string[] {
    return this.argvLog.map((args) => `git ${args.join(' ')}`);
  }

  pushes(): RecordedPush[] {
    return this.argvLog
      .filter((args) => args[0] === 'push')
      .map((argv) => ({ argv: [...argv], head: this.pushed ?? '' }));
  }

  forcePushes(): string[][] {
    return this.argvLog.filter((args) => args.some((a) => a.startsWith('--force') || a === '-f'));
  }

  baseMerges(): number {
    return this.argvLog.filter((args) => args[0] === 'merge' && args[1] !== '--abort').length;
  }

  mergeAborts(): number {
    return this.argvLog.filter((args) => args[0] === 'merge' && args[1] === '--abort').length;
  }

  fetchCount(): number {
    return this.argvLog.filter((args) => args[0] === 'fetch').length;
  }

  pushedHead(): string | null {
    return this.pushed;
  }

  currentHead(): string {
    return this.head;
  }

  /** Git invocations the fake does not model — a test must assert this is empty. */
  unexpectedArgv(): string[][] {
    const modelled = new Set(['rev-parse', 'status', 'fetch', 'merge-base', 'merge', 'push']);
    return this.argvLog.filter((args) => !modelled.has(args[0] ?? ''));
  }

  // --- state hooks used by the contract suite ---

  setDirty(dirty: boolean): void {
    this.dirty = dirty;
  }

  setHead(head: string): void {
    this.head = head;
  }

  setBranch(branch: string): void {
    this.branch = branch;
  }

  setAncestry(ancestors: string[] | null): void {
    this.ancestry = ancestors;
  }

  setPushRefusal(refuse: boolean): void {
    this.rejectPush = refuse;
  }
}
