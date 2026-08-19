import { createHash } from 'node:crypto';
import { resolve as pathResolve, sep as pathSep } from 'node:path';
import type { Artifact, TraceId } from './types.js';

/**
 * Artifact store: writes artifacts to disk and keeps traceability links.
 * Layout (CHATTER.md §10):
 *   artifacts/<kind>/<file>
 * Every stored artifact carries `trace` links (REQ-001 → DESIGN-001 → ...).
 */

export class ArtifactStore {
  constructor(private readonly root: string) {}

  get rootPath(): string {
    return this.root;
  }

  /**
   * Join under root, rejecting any path that escapes it (path traversal
   * guard, security baseline). kind/fileName come from step/artifact inputs,
   * which may be runtime-controlled — never let them write outside the store.
   */
  private safeJoin(...parts: string[]): string {
    const abs = pathResolve(this.root, ...parts);
    if (abs !== this.root && !abs.startsWith(this.root + pathSep)) {
      throw new Error(`artifact path escapes store root: ${parts.join('/')}`);
    }
    return abs;
  }

  async write(opts: {
    taskId: string;
    kind: string;
    fileName: string;
    content: string | Buffer;
    contentType: string;
    trace: TraceId[];
  }): Promise<Artifact> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const dir = this.safeJoin(opts.kind);
    await fs.mkdir(dir, { recursive: true });
    const filePath = this.safeJoin(opts.kind, opts.fileName);
    const data = typeof opts.content === 'string' ? Buffer.from(opts.content, 'utf8') : opts.content;
    await fs.writeFile(filePath, data);

    const rel = path.relative(this.root, filePath).split(path.sep).join('/');
    const sha256 = createHash('sha256').update(data).digest('hex');

    const artifact: Artifact = {
      id: rel,
      taskId: opts.taskId,
      kind: opts.kind,
      path: rel,
      contentType: opts.contentType,
      sizeBytes: data.byteLength,
      trace: opts.trace,
      createdAt: Date.now(),
      sha256,
    };

    // Persist metadata (esp. trace links) next to the artifact so that
    // list() can reconstruct a full traceability view after restart.
    const metaDir = path.join(this.root, '.meta');
    await fs.mkdir(metaDir, { recursive: true });
    await fs.writeFile(
      path.join(metaDir, `${encodeURIComponent(rel)}.json`),
      JSON.stringify(artifact, null, 2),
      'utf8',
    );

    return artifact;
  }

  async read(artifact: Artifact): Promise<Buffer> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    return fs.readFile(path.join(this.root, artifact.path));
  }

  async list(kind?: string): Promise<Artifact[]> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const metaDir = path.join(this.root, '.meta');

    // Prefer persisted metadata (has trace links + taskId); fall back to
    // walking files for artifacts without metadata.
    let metaFiles: string[] = [];
    try {
      metaFiles = await fs.readdir(metaDir);
    } catch {
      metaFiles = [];
    }
    const fromMeta: Artifact[] = [];
    for (const f of metaFiles) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(metaDir, f), 'utf8');
        fromMeta.push(JSON.parse(raw) as Artifact);
      } catch {
        // skip corrupt metadata
      }
    }

    const walk = async (dir: string): Promise<Artifact[]> => {
      const out: Artifact[] = [];
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return out;
      }
      for (const e of entries) {
        if (e.isDirectory()) {
          out.push(...(await walk(path.join(dir, e.name))));
        } else {
          const full = path.join(dir, e.name);
          const rel = path.relative(this.root, full).split(path.sep).join('/');
          const stat = await fs.stat(full);
          out.push({
            id: rel,
            taskId: '',
            kind: rel.split('/')[0] ?? 'unknown',
            path: rel,
            contentType: 'application/octet-stream',
            sizeBytes: stat.size,
            trace: [],
            createdAt: stat.mtimeMs,
          });
        }
      }
      return out;
    };
    const all = [...fromMeta];
    if (fromMeta.length === 0) {
      all.push(...(await walk(this.root)));
    }
    return kind ? all.filter((a) => a.kind === kind) : all;
  }
}