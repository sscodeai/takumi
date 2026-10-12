/**
 * Containment primitives for IN-PROCESS tool adapters (ADR-058 S5).
 *
 * The kernel boundary (sandbox-unshare.ts) confines a `bash` command with a
 * mount namespace. An in-process `read`/`write`/`edit`/`ls`/`find` cannot be
 * chrooted: the SDK calls `fs` directly. So the adapter wraps every path in
 * these functions, which resolve the path through `realpath` of its nearest
 * existing ancestor and refuse anything outside the allowed roots. That is a
 * TRUSTED-ADAPTER containment, not a kernel boundary — a bug in this file is a
 * hole, which is why it is small and unit-tested against symlink escapes.
 *
 * `bash` is the one tool that gets the kernel boundary; these primitives exist
 * because a bash-only slice while builtin `write`/`edit` stayed in-process
 * would be a false claim of confinement.
 */
import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A path the containment rules refused. Named, never a silent empty result. */
export class SandboxFsError extends Error {
  readonly code = 'SANDBOX_FS_DENIED';
  constructor(message: string) {
    super(message);
    this.name = 'SandboxFsError';
  }
}

function contains(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/**
 * The real path of `target`, resolving the nearest existing ancestor and then
 * re-appending the non-existent tail. A non-existent target is needed for a
 * write, and resolving only the ancestor is what makes a symlinked PARENT
 * escape visible while a new file underneath it is still checked.
 */
async function realpathOrNearest(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : path.join(real, ...tail.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/** Resolve `target` inside one of `roots`, or throw `SandboxFsError`. */
export async function resolveWithinRoots(roots: readonly string[], target: string): Promise<string> {
  if (!path.isAbsolute(target)) {
    throw new SandboxFsError(`path "${target}" is not absolute`);
  }
  const real = await realpathOrNearest(target);
  for (const root of roots) {
    if (contains(await realpathOrNearest(root), real)) return real;
  }
  throw new SandboxFsError(`path "${target}" is outside the allowed roots [${roots.join(', ')}]`);
}

/** Read a file that must be inside `roots`. */
export async function readFileWithin(roots: readonly string[], target: string): Promise<Buffer> {
  return readFile(await resolveWithinRoots(roots, target));
}

/** Assert a path is inside `roots` and has the requested access. */
export async function accessWithin(
  roots: readonly string[],
  target: string,
  mode: number = constants.R_OK,
): Promise<void> {
  await access(await resolveWithinRoots(roots, target), mode);
}

/** True when `target` exists inside `roots`; false when it is outside. */
export async function existsWithin(roots: readonly string[], target: string): Promise<boolean> {
  try {
    await access(await resolveWithinRoots(roots, target), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** `stat` a path that must be inside `roots`. */
export async function statWithin(roots: readonly string[], target: string): Promise<Awaited<ReturnType<typeof stat>>> {
  return stat(await resolveWithinRoots(roots, target));
}

/** List a directory that must be inside `roots`. */
export async function readdirWithin(roots: readonly string[], target: string): Promise<string[]> {
  return readdir(await resolveWithinRoots(roots, target));
}

/** Write a file that must be inside `rwRoots`, creating its parent directories. */
export async function writeFileWithin(
  rwRoots: readonly string[],
  target: string,
  content: string | Buffer,
): Promise<void> {
  const real = await resolveWithinRoots(rwRoots, target);
  await mkdir(path.dirname(real), { recursive: true });
  await writeFile(real, content);
}

/** Create a directory that must be inside `rwRoots`. */
export async function mkdirWithin(rwRoots: readonly string[], target: string): Promise<void> {
  await mkdir(await resolveWithinRoots(rwRoots, target), { recursive: true });
}

const GLOB_IGNORE_DIRS = new Set(['.git', 'node_modules']);

/**
 * A contained glob: walk `cwd` (which must be inside `roots`) and return the
 * relative paths matching `pattern`. `ignore` entries name basenames to skip
 * (the SDK passes `.gitignore`-derived patterns); the walk always skips `.git`
 * and `node_modules`, which no agent search needs and which can be huge.
 */
export async function globWithin(
  roots: readonly string[],
  pattern: string,
  cwd: string,
  options: { ignore?: string[]; limit?: number } = {},
): Promise<string[]> {
  const root = await resolveWithinRoots(roots, cwd);
  const ignore = new Set([...(options.ignore ?? []), ...GLOB_IGNORE_DIRS]);
  const limit = options.limit ?? 1000;
  const results: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (results.length >= limit) return;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (results.length >= limit) return;
        if (ignore.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const relative = path.relative(root, full);
        if (path.matchesGlob(relative, pattern) || path.matchesGlob(entry.name, pattern)) {
          results.push(relative);
        }
        if (entry.isDirectory()) await walk(full);
      }
    } catch {
      return;
    }
  };
  await walk(root);
  return results;
}
