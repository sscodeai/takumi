import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverExtensions } from '../extensions.js';

// Acceptance Gate 7 — Extension Discovery.
// New extensions must be auto-discovered with ZERO Core changes; removing
// them must stop discovery. Core source code is untouched (import only).
function makeRegistry(): { dir: string; mk(name: string, kind: string): void; rm(name: string): void } {
  const dir = mkdtempSync(join(tmpdir(), 'ext-discovery-'));
  return {
    dir,
    mk(name: string, kind: string) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(
        join(dir, name, 'manifest.yaml'),
        `name: ${name}\nkind: ${kind}\nversion: 0.1.0\ndescription: hello ${kind}\n`,
      );
    },
    rm(name: string) {
      rmSync(join(dir, name), { recursive: true, force: true });
    },
  };
}

test('Gate 7: skills auto-discovered, removed stops discovery, Core untouched', async () => {
  const reg = makeRegistry();
  try {
    // Discover with nothing → empty
    assert.equal((await discoverExtensions(reg.dir, 'skill')).length, 0);

    // Add a skill → discovered without Core changes
    reg.mk('hello-skill', 'skill');
    const skills = await discoverExtensions(reg.dir, 'skill');
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.manifest.name, 'hello-skill');
    assert.equal(skills[0]?.manifest.kind, 'skill');

    // Remove → no longer discovered
    reg.rm('hello-skill');
    assert.equal((await discoverExtensions(reg.dir, 'skill')).length, 0);
  } finally {
    rmSync(reg.dir, { recursive: true, force: true });
  }
});

test('Gate 7: tool / workflow / runtime extensions also auto-discover', async () => {
  const reg = makeRegistry();
  try {
    reg.mk('hello-tool', 'tool');
    reg.mk('hello-workflow', 'workflow');
    reg.mk('hello-runtime', 'runtime');

    const tools = await discoverExtensions(reg.dir, 'tool');
    const workflows = await discoverExtensions(reg.dir, 'workflow');
    const runtimes = await discoverExtensions(reg.dir, 'runtime');

    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.manifest.name, 'hello-tool');
    assert.equal(workflows.length, 1);
    assert.equal(workflows[0]?.manifest.name, 'hello-workflow');
    assert.equal(runtimes.length, 1);
    assert.equal(runtimes[0]?.manifest.name, 'hello-runtime');
  } finally {
    rmSync(reg.dir, { recursive: true, force: true });
  }
});

test('Gate 7: kind filtering excludes other kinds', async () => {
  const reg = makeRegistry();
  try {
    reg.mk('hello-skill', 'skill');
    reg.mk('hello-workflow', 'workflow');
    const skills = await discoverExtensions(reg.dir, 'skill');
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.manifest.name, 'hello-skill'); // workflow not leaked
    const all = await discoverExtensions(reg.dir);
    assert.equal(all.length, 2);
  } finally {
    rmSync(reg.dir, { recursive: true, force: true });
  }
});