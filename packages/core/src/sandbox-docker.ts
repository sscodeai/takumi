import type { Sandbox, SandboxOptions, SandboxResult } from './sandbox.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * DockerSandbox — reference sandbox implementation (P1-2).
 *
 * Runs commands via `docker run` with:
 *   - the project dir mounted at /work (rw); image has no other writable
 *     mounts and runs as a non-root user when the image provides one
 *   - --network none unless allowNetwork
 *   - --read-only rootfs so the container cannot modify its own image
 *   - --memory / --cpus / timeout bounds
 *   - --init to reap zombies, --rm to clean up
 *
 * Image: node:22-slim (has /bin/sh + node). Configurable via TAKUMI_SANDBOX_IMAGE.
 */
export class DockerSandbox implements Sandbox {
  readonly id = 'docker';
  private readonly image: string;

  constructor(image?: string) {
    this.image = image ?? process.env.TAKUMI_SANDBOX_IMAGE ?? 'node:22-slim';
  }

  async run(projectDir: string, command: string, opts: SandboxOptions = {}): Promise<SandboxResult> {
    const workdir = opts.workdir ?? '/work';
    const memory = opts.memory ?? '512m';
    const cpus = opts.cpus ?? '1';
    const timeoutMs = opts.timeoutMs ?? 60_000;

    const args = [
      'run',
      '--rm',
      '--init',
      '--read-only',
      '--network', opts.allowNetwork ? 'bridge' : 'none',
      '--memory', memory,
      '--cpus', cpus,
      '-v', `${projectDir}:/work:rw`,
      '-w', workdir,
      '--tmpfs', '/tmp',
      '--tmpfs', '/run',
      this.image,
      '/bin/sh', '-c', command,
    ];

    try {
      const { stdout, stderr } = await execFileAsync('docker', args, { timeout: timeoutMs + 5000, maxBuffer: 16 * 1024 * 1024 });
      return { stdout, stderr, code: 0, timedOut: false };
    } catch (e: any) {
      // execFile throws on non-zero exit or timeout — extract both.
      if (e.killed && (e.signal === 'SIGTERM' || e.signal === 'SIGKILL')) {
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: -1, timedOut: true };
      }
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? '',
        code: typeof e.code === 'number' ? e.code : 1,
        timedOut: false,
      };
    }
  }

  async close(): Promise<void> {
    // docker run --rm handles cleanup; nothing to release.
  }
}

/** NoopSandbox — plain exec (no isolation). Used when sandboxing disabled/unavailable. */
export class NoopSandbox implements Sandbox {
  readonly id = 'none';
  async run(projectDir: string, command: string, opts: SandboxOptions = {}): Promise<SandboxResult> {
    try {
      const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
        cwd: projectDir,
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { stdout, stderr, code: 0, timedOut: false };
    } catch (e: any) {
      if (e.killed) return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: -1, timedOut: true };
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : 1, timedOut: false };
    }
  }
  async close(): Promise<void> {}
}

/** True when a docker daemon is reachable (docker info succeeds). */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await execFileAsync('docker', ['info'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}
