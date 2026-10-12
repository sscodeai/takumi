/**
 * Sandbox abstraction — P1-2 (Isolation / security red line).
 *
 * Runtimes execute agent shell commands in the project cwd. Without a sandbox
 * an agent can read/write anywhere the process can (host files, network,
 * /etc, other projects). The Sandbox interface lets a runtime run a command
 * inside an isolated environment:
 *
 *   - filesystem: project dir mounted rw, everything else read-only/no access
 *   - network:    disabled (unless allowNetwork: true)
 *   - process:    isolated pid namespace
 *   - resources:  bounded CPU/memory/time
 *
 * Implementations: DockerSandbox (docker run --network none --read-only ...)
 * is the reference; a NoopSandbox (plain exec) is used when sandboxing is
 * disabled or unavailable — so the default remains "unsandboxed" and the
 * capability 'sandbox' is only advertised when a real sandbox is available.
 */
export interface SandboxResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}

export interface SandboxOptions {
  /** working directory inside the sandbox (default: /work) */
  workdir?: string;
  /** allow network (default: false) */
  allowNetwork?: boolean;
  /** memory limit, e.g. '512m' (default: 512m) */
  memory?: string;
  /** cpu limit, e.g. '1' (default: 1) */
  cpus?: string;
  /** timeout ms (default: 60_000) */
  timeoutMs?: number;
}

export interface Sandbox {
  /** Human-readable id (e.g. 'docker', 'none'). */
  readonly id: string;
  /** Run a command inside the sandbox with the project mounted at /work (rw). */
  run(projectDir: string, command: string, opts?: SandboxOptions): Promise<SandboxResult>;
  /** Release resources. */
  close(): Promise<void>;
}
