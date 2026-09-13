#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const testDir = join(process.cwd(), 'dist', 'test');

/**
 * A package with no compiled tests must NOT report a green run: the whole point
 * of the evidence-native gate is that "no tests" is a failure, not a pass.
 * (Before this, a package with zero tests printed "skipping" and exited 0, so
 * apps/console shipped with no coverage and CI still looked healthy.)
 */
function failNoTests(reason) {
  console.error(
    `${reason} — refusing to report success for a package with zero tests.`,
  );
  console.error(
    'Add tests under src/test/ (they are compiled to dist/test/) or remove the test script.',
  );
  process.exit(1);
}

if (!existsSync(testDir)) {
  failNoTests(`No compiled test directory at ${testDir}`);
}

const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(testDir, name));

if (testFiles.length === 0) {
  failNoTests(`No compiled tests found in ${testDir}`);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(typeof result.status === 'number' ? result.status : 1);
