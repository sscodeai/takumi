#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const testDir = join(process.cwd(), 'dist', 'test');

if (!existsSync(testDir)) {
  console.log('No compiled tests found; skipping.');
  process.exit(0);
}

const testFiles = readdirSync(testDir)
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(testDir, name));

if (testFiles.length === 0) {
  console.log('No compiled tests found; skipping.');
  process.exit(0);
}

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(typeof result.status === 'number' ? result.status : 1);
