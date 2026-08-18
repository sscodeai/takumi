/**
 * Extension metadata for the four extension types:
 * Skill / Tool Plugin / Workflow Plugin / Runtime Adapter.
 * See CHATTER.md §3.
 */

export type ExtensionKind = 'skill' | 'tool' | 'workflow' | 'runtime';

export interface ExtensionManifest {
  /** Stable id, e.g. "jp-requirements", "excel", "jp-si-standard", "pi". */
  name: string;
  kind: ExtensionKind;
  version: string;
  description: string;
  /** Extra fields per kind (skills: prompts/checklists; workflows: steps...). */
  [key: string]: unknown;
}

export interface DiscoveredExtension {
  manifest: ExtensionManifest;
  /** Absolute path to the extension directory. */
  dir: string;
  /** When loaded, the executable entry (module path) for tool/runtime kinds. */
  entryPoint?: string;
}

/** Load-time metadata for a skill extension. */
export interface SkillMetadata {
  name: string;
  version: string;
  description: string;
  /** Relative paths inside the skill dir that exist: SKILL.md, prompts/, etc. */
  hasSkillDoc: boolean;
  hasPrompts: boolean;
  hasExamples: boolean;
  hasChecklists: boolean;
  hasSchemas: boolean;
}

/**
 * Discover extensions under a directory by scanning for manifest.yaml/manifest.json.
 * Returns entries sorted by name for deterministic `takumi extension list`.
 * Discovery is by scan, never hardcoded names (architecture invariant #9).
 */
export async function discoverExtensions(rootDir: string, kind?: ExtensionKind): Promise<DiscoveredExtension[]> {
  const { readdirSync, existsSync } = await import('node:fs');
  const path = await import('node:path');
  const { parse } = await import('yaml');

  const found: DiscoveredExtension[] = [];
  const root = path.resolve(rootDir);
  if (!existsSync(root)) return found;

  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifestFile = existsSync(path.join(dir, 'manifest.yaml'))
      ? path.join(dir, 'manifest.yaml')
      : existsSync(path.join(dir, 'manifest.json'))
        ? path.join(dir, 'manifest.json')
        : null;
    if (!manifestFile) continue;

    const raw = await import('node:fs/promises').then((fs) => fs.readFile(manifestFile, 'utf8'));
    const manifest = (manifestFile.endsWith('.json') ? JSON.parse(raw) : parse(raw)) as ExtensionManifest;
    if (!manifest.name || !manifest.kind) continue;

    manifest.name ??= entry.name;
    if (kind && manifest.kind !== kind) continue;

    found.push({
      manifest,
      dir,
      entryPoint: existsSync(path.join(dir, 'index.js'))
        ? path.join(dir, 'index.js')
        : existsSync(path.join(dir, 'dist', 'index.js'))
          ? path.join(dir, 'dist', 'index.js')
          : undefined,
    });
  }

  return found.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}