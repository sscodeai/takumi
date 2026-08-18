import { createHash } from 'node:crypto';
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
    const dir = path.join(this.root, opts.kind);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, opts.fileName);
    const data = typeof opts.content === 'string' ? Buffer.from(opts.content, 'utf8') : opts.content;
    await fs.writeFile(filePath, data);

    const rel = path.relative(this.root, filePath).split(path.sep).join('/');
    const sha256 = createHash('sha256').update(data).digest('hex');

    return {
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
  }

  async read(artifact: Artifact): Promise<Buffer> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    return fs.readFile(path.join(this.root, artifact.path));
  }

  async list(kind?: string): Promise<Artifact[]> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
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
    const all = await walk(this.root);
    return kind ? all.filter((a) => a.kind === kind) : all;
  }
}