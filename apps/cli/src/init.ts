import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Scaffold a Takumi project layout in cwd:
 *
 *   takumi.yaml          (project config: registry paths, default runtime)
 *   .takumi/artifacts/   (artifact store root)
 *   .takumi/sessions/    (event/session logs)
 *   extensions/{skills,tools,workflows}/  (registry roots)
 *   runtimes/
 */
export function initProject(cwd: string): string[] {
  const created: string[] = [];

  const configPath = join(cwd, 'takumi.yaml');
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      [
        '# Takumi project configuration',
        'runtime: fake',
        'registry:',
        '  skills: extensions/skills',
        '  tools: extensions/tools',
        '  workflows: extensions/workflows',
        '  runtimes: runtimes',
        'artifacts: .takumi/artifacts',
        '',
      ].join('\n'),
    );
    created.push(configPath);
  }

  for (const dir of ['.takumi/artifacts', '.takumi/sessions', 'extensions/skills', 'extensions/tools', 'extensions/workflows', 'runtimes']) {
    if (!existsSync(join(cwd, dir))) {
      mkdirSync(join(cwd, dir), { recursive: true });
      created.push(dir + '/');
    }
  }

  return created;
}