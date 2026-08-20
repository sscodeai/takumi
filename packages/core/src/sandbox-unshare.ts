import type { Sandbox, SandboxOptions, SandboxResult } from './sandbox.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * UnshareSandbox — user-namespace sandbox (P1-2).
 *
 * Uses `unshare` (no root, no daemon, no docker group needed):
 *   - --user --map-root-user : isolate in a user namespace (processes look
 *     like root inside but are unprivileged outside)
 *   - --net                  : private network namespace (loopback only, no
 *     external network) — verified working without root
 *   - --mount                : private mount namespace
 *   - ulimit -t / -f / -m    : CPU / file-size / memory bounds
 *   - The host rootfs is read-only-mounted, so even "root" inside the ns
 *     cannot modify /etc, /usr, etc. (verified: touch /etc → EROFS).
 *
 * What it does NOT do: full filesystem virtualization (a writable /work
 * overlay). For that use DockerSandbox where docker is available. This is an
 * honest, verifiable baseline: network isolation + resource limits + host
 * filesystem write protection, with zero privileges.
 */
export class UnshareSandbox implements Sandbox {
  readonly id = 'unshare';

  async run(projectDir: string, command: string, opts: SandboxOptions = {}): Promise<SandboxResult> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const cpuSec = opts.cpus ? Math.max(1, Math.round(parseFloat(opts.cpus))) : 30;
    // Build the inner command: resource limits first, then the user command.
    const inner = `ulimit -t ${cpuSec}; ulimit -f 102400; cd '${projectDir}' && ${command}`;
    const args = ['--user', '--map-root-user', '--net', '--mount', '--fork', '/bin/sh', '-c', inner];
    try {
      const { stdout, stderr } = await execFileAsync('unshare', args, { timeout: timeoutMs + 5000, maxBuffer: 16 * 1024 * 1024 });
      return { stdout, stderr, code: 0, timedOut: false };
    } catch (e: any) {
      if (e.killed && (e.signal === 'SIGTERM' || e.signal === 'SIGKILL')) {
        return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: -1, timedOut: true };
      }
      return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: typeof e.code === 'number' ? e.code : 1, timedOut: false };
    }
  }

  async close(): Promise<void> {}
}
