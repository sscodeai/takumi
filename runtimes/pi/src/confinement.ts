/**
 * Confined tool definitions for the Pi runtime (ADR-058 S5).
 *
 * The Pi SDK builds its coding tools with a per-tool `operations` seam. A
 * confined delivery agent gets tools whose operations are routed through
 * `@takumi/core`'s containment primitives instead of the local filesystem, so
 * `read`/`write`/`edit`/`ls`/`find` cannot reach outside the boundary's roots
 * even though they run in-process.
 *
 * `bash` is the one tool that gets the KERNEL boundary: its operations call
 * `StepSandbox.runStep`, so the command runs in the mount/net/pid namespace.
 *
 * `grep` is deliberately NOT offered. Its operations seam only exposes
 * `isDirectory`/`readFile`; the search itself shells out to ripgrep, a host
 * process with the host's filesystem, which no operations override can contain.
 * Offering it would be a false claim of confinement, so it is dropped by name
 * and the drop is recorded in the task's events.
 */
import { constants } from 'node:fs';
import {
  accessWithin,
  existsWithin,
  globWithin,
  mkdirWithin,
  readFileWithin,
  readdirWithin,
  statWithin,
  writeFileWithin,
  type SandboxRoots,
  type StepSandbox,
} from '@takumi/core';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

/** A confined-run configuration handed to a task by the engine. */
export interface Confinement {
  sandbox: StepSandbox;
  roots: SandboxRoots;
}

/** Read the confinement a task carries, or `undefined` for an open run. */
export function confinementOf(options: Record<string, unknown> | undefined): Confinement | undefined {
  const sandbox = options?.['sandbox'];
  const roots = options?.['sandboxRoots'] as SandboxRoots | undefined;
  if (sandbox === undefined && roots === undefined) return undefined;
  if (sandbox === undefined || roots === undefined) {
    throw new Error(
      'a confined run must carry both `sandbox` and `sandboxRoots` in the task options: the kernel boundary ' +
        'and the in-process containment roots are set together, so a half-configured run is refused rather than ' +
        'run with builtin tools that could reach the host',
    );
  }
  return { sandbox: sandbox as StepSandbox, roots };
}

/** The read roots: the staged read-only roots plus everything writable. */
function readRoots(roots: SandboxRoots): string[] {
  return [...roots.ro, ...roots.rw];
}

function bashOperations(sandbox: StepSandbox, roots: SandboxRoots, onDrop: (name: string, reason: string) => void): BashOperations {
  void onDrop;
  return {
    exec: async (command, cwd, options) => {
      const res = await sandbox.runStep({
        shell: command,
        cwd: cwd.length > 0 ? cwd : roots.cwd,
        timeoutMs: options.timeout,
      });
      if (res.stdout.length > 0) options.onData(Buffer.from(res.stdout));
      if (res.stderr.length > 0) options.onData(Buffer.from(res.stderr));
      return { exitCode: res.code };
    },
  };
}

/**
 * Build the confined coding tools. `cwd` is the session's working directory
 * (the delivery worktree); `roots` are the paths containment allows.
 */
export function createConfinedTools(
  cwd: string,
  confinement: Confinement,
  onDrop: (name: string, reason: string) => void = () => {},
): ToolDefinition[] {
  const { sandbox, roots } = confinement;
  const readable = readRoots(roots);
  onDrop('grep', 'its search shells out to ripgrep, which this in-process seam cannot contain');
  return [
    createReadToolDefinition(cwd, {
      operations: {
        readFile: (p) => readFileWithin(readable, p),
        access: (p) => accessWithin(readable, p, constants.R_OK),
      },
    }),
    createWriteToolDefinition(cwd, {
      operations: {
        writeFile: (p, content) => writeFileWithin(roots.rw, p, content),
        mkdir: (d) => mkdirWithin(roots.rw, d),
      },
    }),
    createEditToolDefinition(cwd, {
      operations: {
        readFile: (p) => readFileWithin(roots.rw, p),
        writeFile: (p, content) => writeFileWithin(roots.rw, p, content),
        access: (p) => accessWithin(roots.rw, p, constants.R_OK | constants.W_OK),
      },
    }),
    createLsToolDefinition(cwd, {
      operations: {
        exists: (p) => existsWithin(readable, p),
        stat: (p) => statWithin(readable, p),
        readdir: (p) => readdirWithin(readable, p),
      },
    }),
    createFindToolDefinition(cwd, {
      operations: {
        exists: (p) => existsWithin(readable, p),
        glob: (pattern, searchPath, options) => globWithin(readable, pattern, searchPath, options),
      },
    }),
    createBashToolDefinition(cwd, { operations: bashOperations(sandbox, roots, onDrop) }),
  ] as ToolDefinition[];
}
