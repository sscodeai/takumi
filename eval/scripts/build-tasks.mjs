#!/usr/bin/env node
/**
 * Build eval/tasks/tasks.json from the TS task definitions.
 * Run: node eval/scripts/build-tasks.mjs
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Import the compiled task definitions (eval/dist if built via tsc, else inline).
// Simplest: the tasks are plain data — load via dynamic import of the TS file
// after a quick tsc compile into eval/.compiled.
import { execFileSync } from 'node:child_process';

const ROOT = join(import.meta.dirname, '..');
const COMPILED = join(ROOT, '.compiled');

try {
  execFileSync('node', [join(ROOT, '..', 'node_modules', 'typescript', 'bin', 'tsc'), '--outDir', COMPILED, '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--esModuleInterop', join(ROOT, 'tasks', 'ts-tasks.ts'), join(ROOT, 'tasks', 'hard-tasks.ts'), join(ROOT, 'types.ts')], { stdio: 'pipe' });
} catch (e) {
  // fallback: tsc from repo root node_modules
  execFileSync('node', [join(ROOT, '..', 'node_modules', 'typescript', 'bin', 'tsc'), '--outDir', COMPILED, '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--esModuleInterop', join(ROOT, 'tasks', 'ts-tasks.ts'), join(ROOT, 'tasks', 'hard-tasks.ts'), join(ROOT, 'types.ts')], { stdio: 'pipe' });
}

const { tsTasks } = await import(join(COMPILED, 'tasks', 'ts-tasks.js'));
const { hardTasks } = await import(join(COMPILED, 'tasks', 'hard-tasks.js'));
const all = [...tsTasks, ...hardTasks];
writeFileSync(join(ROOT, 'tasks', 'tasks.json'), JSON.stringify(all, null, 2));
console.log(`Wrote eval/tasks/tasks.json with ${all.length} tasks (${tsTasks.length} easy + ${hardTasks.length} hard)`);
