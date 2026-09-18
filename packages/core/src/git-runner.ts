/**
 * The git seam every delivery adapter uses.
 *
 * A delivery adapter must never call `child_process` itself: the operations it
 * performs (verify the commit boundary, absorb an advanced base, push a branch)
 * are exactly the ones a test must be able to observe and to refuse. Injecting a
 * {@link GitRunner} makes "did it force-push?" a question a test can answer from
 * the argv it recorded, instead of something the adapter merely reports.
 *
 * The default runner spawns ASYNCHRONOUSLY (`spawn`, never `spawnSync`): a
 * blocking call would freeze the event loop that drives the rest of the tick and
 * deadlock any in-process test server.
 */

import { spawn } from 'node:child_process';
import { ProviderError } from './provider-error.js';

export interface GitResult {
  stdout: string;
  stderr: string;
  /** The process exit code. A non-zero code is a RESULT, not an exception. */
  exitCode: number;
}

export interface GitRunner {
  /**
   * Run one git command and return its outcome.
   *
   * Never throws for a non-zero exit code (that is ordinary git behaviour the
   * caller must classify); throws `ProviderError('transport')` only when git
   * could not be run at all or exceeded its timeout.
   */
  run(args: string[], opts?: { cwd?: string }): Promise<GitResult>;
}

export interface GitRunnerOptions {
  /** Override the git binary (tests point this at a stub). */
  gitBinary?: string;
  /** Hard per-command timeout; a git call must never hang a tick. Default 120s. */
  timeoutSeconds?: number;
  /** Refuse output larger than this instead of buffering it. Default 16 MiB. */
  maxOutputBytes?: number;
}

/** One-line description of a failed git command, for an error message. */
export function gitFailure(args: string[], result: GitResult): string {
  return `git ${args.join(' ')} exited ${result.exitCode}: ${result.stderr.trim().split('\n')[0] ?? ''}`;
}

/** The default runner: async `git`, bounded by a timeout and an output cap. */
export function createGitRunner(opts: GitRunnerOptions = {}): GitRunner {
  const gitBinary = opts.gitBinary ?? 'git';
  const maxOutputBytes = opts.maxOutputBytes ?? 16 * 1024 * 1024;
  return {
    run: (args, runOpts = {}) => {
      const timeoutSeconds = opts.timeoutSeconds ?? 120;
      return new Promise<GitResult>((resolve, reject) => {
        const child = spawn(gitBinary, args, {
          cwd: runOpts.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const what = `git ${args.join(' ')}`;

        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(killTimer);
          fn();
        };

        const killTimer = setTimeout(() => {
          child.kill('SIGKILL');
          finish(() =>
            reject(new ProviderError('transport', `${what} exceeded ${timeoutSeconds}s and was killed`)),
          );
        }, timeoutSeconds * 1000);
        killTimer.unref();

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
          if (stdout.length + stderr.length > maxOutputBytes) {
            child.kill('SIGKILL');
            finish(() => reject(new ProviderError('transport', `${what} produced more than ${maxOutputBytes} bytes`)));
          }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        child.on('error', (e: Error) => {
          finish(() => reject(new ProviderError('transport', `${what} could not be started: ${e.message}`, { cause: e })));
        });
        child.on('close', (code: number | null) => {
          finish(() => resolve({ stdout, stderr, exitCode: code ?? -1 }));
        });
      });
    },
  };
}

/**
 * A runner that refuses every command.
 *
 * The safe default when no runner is injected: an accidental git operation on the
 * operator's real repository becomes an explicit `unsupported` error instead of a
 * push to whatever remote happens to be configured.
 */
export function unconfiguredGitRunner(): GitRunner {
  return {
    run: async (args) => {
      throw new ProviderError(
        'unsupported',
        `no git runner configured for "git ${args.join(' ')}" — inject one (tests) or construct the provider with a runner`,
      );
    },
  };
}
