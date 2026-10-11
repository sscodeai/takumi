import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../commands.js';

/**
 * The local config override (`takumi.local.yaml`).
 *
 * The committed `takumi.yaml` is the SHAREABLE example: its `delivery:` section names the
 * placeholder host `forgejo.internal.invalid`, never an operator's real endpoint. An operator
 * keeps the real one in `takumi.local.yaml` (gitignored), which is merged OVER the committed file
 * before the config is used — objects recursively, scalars and arrays replaced, and an explicit
 * `null` CLEARING an inherited key (omitting it does NOT: the merge is per key, which is how two
 * live runs inherited the placeholder host — docs/bugs-fixed.md #47). The loader prints exactly one
 * line naming the file AND the keys the override set or cleared. A local file that cannot be read as
 * a mapping fails LOUDLY, because silently ignoring it would run the whole thing against the placeholders.
 *
 * These tests drive the REAL loader (`loadConfig`), not a copy of its merge rule.
 */

const COMMITTED = [
  '# Takumi project configuration',
  'runtime: fake',
  'registry:',
  '  skills: extensions/skills',
  '  tools: extensions/tools',
  '  workflows: extensions/workflows',
  '  runtimes: runtimes',
  '  boards: boards',
  '  deliveries: deliveries',
  'artifacts: .takumi/artifacts',
  'delivery:',
  '  provider: forgejo',
  '  repo: dev/takumi-delivery-selftest',
  '  apiBase: http://forgejo.internal.invalid:3000/api/v1',
  '  baseBranch: main',
  '  remote: origin',
  '',
].join('\n');

/** A project directory with the committed `takumi.yaml`, and optionally a local override. */
function project(local?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-local-config-'));
  writeFileSync(join(dir, 'takumi.yaml'), COMMITTED);
  if (local !== undefined) {
    writeFileSync(join(dir, 'takumi.local.yaml'), local);
  }
  return dir;
}

/** Capture everything the loader writes to stdout while `fn` runs. */
function captureStdout<T>(fn: () => T): { value: T; lines: string[] } {
  const original = console.log;
  const lines: string[] = [];
  console.log = (line?: unknown) => lines.push(String(line ?? ''));
  try {
    return { value: fn(), lines };
  } finally {
    console.log = original;
  }
}

test('takumi.local.yaml overrides a scalar, and prints one line naming the file', () => {
  const dir = project('runtime: deepseek\n');
  try {
    const { value: cfg, lines } = captureStdout(() => loadConfig(dir));
    assert.equal(cfg.runtime, 'deepseek', 'the local scalar must win');
    assert.equal(cfg.registry.skills, 'extensions/skills', 'untouched keys survive');
    assert.equal(lines.length, 1, `exactly one line, got ${JSON.stringify(lines)}`);
    assert.match(lines[0]!, /local override applied/);
    assert.match(lines[0]!, /takumi\.local\.yaml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takumi.local.yaml overrides one key inside delivery, the rest of the section survives', () => {
  const dir = project([
    'delivery:',
    '  apiBase: http://real-forgejo.example.com:3000/api/v1',
    '',
  ].join('\n'));
  try {
    const cfg = loadConfig(dir);
    assert.equal(cfg.delivery?.apiBase, 'http://real-forgejo.example.com:3000/api/v1');
    assert.equal(cfg.delivery?.provider, 'forgejo', 'provider survives the merge');
    assert.equal(cfg.delivery?.repo, 'dev/takumi-delivery-selftest', 'repo survives the merge');
    assert.equal(cfg.delivery?.baseBranch, 'main', 'baseBranch survives the merge');
    assert.equal(cfg.delivery?.remote, 'origin', 'remote survives the merge');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no takumi.local.yaml: nothing changes and no line is printed', () => {
  const dir = project();
  try {
    const { value: cfg, lines } = captureStdout(() => loadConfig(dir));
    assert.equal(cfg.runtime, 'fake');
    assert.equal(cfg.delivery?.apiBase, 'http://forgejo.internal.invalid:3000/api/v1');
    assert.equal(lines.length, 0, `expected silence, got ${JSON.stringify(lines)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a malformed takumi.local.yaml fails loudly, it is never ignored', () => {
  const dir = project('runtime: fake\n\tbroken: indentation\n');
  try {
    assert.throws(() => loadConfig(dir), /takumi\.local\.yaml in .* is not valid YAML/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a takumi.local.yaml that is not a mapping fails loudly', () => {
  const dir = project('just a scalar, not a mapping\n');
  try {
    assert.throws(() => loadConfig(dir), /must contain a YAML mapping/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit null CLEARS an inherited key: it is gone, not merely shadowed', () => {
  // The case that cost two live runs (docs/bugs-fixed.md #47): the operator switched the provider to
  // github and meant to DROP the committed Forgejo placeholder `apiBase`. Writing a local file that
  // omitted `apiBase` inherited the placeholder (per-key merge) and the clone went to the wrong host.
  const dir = project(['delivery:', '  provider: github', '  apiBase: null', ''].join('\n'));
  try {
    const { value: cfg, lines } = captureStdout(() => loadConfig(dir));
    assert.equal(cfg.delivery?.provider, 'github', 'the local provider wins');
    assert.equal(cfg.delivery?.apiBase, undefined, 'the inherited placeholder apiBase is gone');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(cfg.delivery ?? {}, 'apiBase'),
      'the key is ABSENT, so no provider default is shadowed by a leftover placeholder',
    );
    // The per-key merge still keeps the rest of the committed section.
    assert.equal(cfg.delivery?.repo, 'dev/takumi-delivery-selftest', 'repo survives the merge');
    assert.equal(cfg.delivery?.baseBranch, 'main', 'baseBranch survives the merge');
    assert.equal(cfg.delivery?.remote, 'origin', 'remote survives the merge');
    // One line — and it NAMES the keys: the one set and the one cleared.
    assert.equal(lines.length, 1, `exactly one line, got ${JSON.stringify(lines)}`);
    assert.match(lines[0]!, /local override applied/);
    assert.match(lines[0]!, /set delivery\.provider/);
    assert.match(lines[0]!, /cleared delivery\.apiBase/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the printed line names EVERY key the override changed, sorted within each kind', () => {
  const dir = project(['runtime: deepseek', 'delivery:', '  repo: sscodeai/other', '  apiBase: null', ''].join('\n'));
  try {
    const { value: cfg, lines } = captureStdout(() => loadConfig(dir));
    assert.equal(lines.length, 1, `exactly one line, got ${JSON.stringify(lines)}`);
    const line = lines[0]!;
    assert.match(line, /set delivery\.repo, runtime/, 'the set keys are named, sorted');
    assert.match(line, /cleared delivery\.apiBase/, 'the cleared key is named');
    assert.equal(cfg.runtime, 'deepseek');
    assert.equal(cfg.delivery?.repo, 'sscodeai/other');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a key the override does not mention keeps its committed value, and an empty override changes nothing', () => {
  // Unchanged behaviour, stated as a test so the null rule cannot quietly grow teeth.
  const dir = project('{}\n');
  try {
    const { value: cfg, lines } = captureStdout(() => loadConfig(dir));
    assert.equal(cfg.runtime, 'fake');
    assert.equal(cfg.delivery?.apiBase, 'http://forgejo.internal.invalid:3000/api/v1', 'nothing was touched');
    assert.equal(cfg.delivery?.provider, 'forgejo');
    assert.equal(lines.length, 1, `the file was applied, so one line, got ${JSON.stringify(lines)}`);
    assert.match(lines[0]!, /no keys changed/, 'an override that changes nothing says so');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
