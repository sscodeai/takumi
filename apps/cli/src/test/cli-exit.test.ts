/**
 * A CLI ENDS WHEN ITS COMMAND ENDS.
 *
 * Measured on the real machine (ADR-054, 2026-10-12): a `request-intake` run against the pi runtime
 * finished its workflow at 01:23:10Z — run record written, artifact written, summary printed — and the
 * CLI process was still alive at 01:25:30Z. An earlier foreground invocation of the same command had to
 * be killed at 600 s. Nothing was pending: the exit had been left to "the event loop drained", so a
 * finished run depended on EVERY library releasing EVERY socket.
 *
 * That is a contract error, not an inconvenience. An unattended chain is sequenced by a supervisor that
 * waits for a process to EXIT — that is how it knows a run is over, when to start the next one, and what
 * to record. A run that never exits cannot be sequenced, retried or measured: the whole "one sentence in,
 * delivery out" flow stalls at the first step because the pilot is still waiting for a process that has
 * already done its work.
 *
 * The test runs the BUILT CLI as a real child process. `TAKUMI_TEST_HOLD_ALIVE_MS` makes that child hold
 * its event loop open (the way the pi session pool did), so the assertion is about a process that WOULD
 * hang — not about one that happens to exit. It also checks the output arrived: exiting explicitly must
 * never truncate what the command printed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../init.js';

const CLI = fileURLToPath(new URL('../index.js', import.meta.url));

test('the CLI exits when its command is done, even with a handle left open — and prints everything first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-cli-exit-'));
  try {
    initProject(dir);
    const wfDir = join(dir, 'extensions/workflows/simple');
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(
      join(wfDir, 'workflow.yaml'),
      ['name: simple', 'version: 0.1.0', 'description: fixture', 'steps:', '  - id: say', '    type: tool', '    prompt: echo MARKER-FROM-THE-RUN', ''].join('\n'),
    );

    const started = Date.now();
    const out = await new Promise<{ code: number | null; stdout: string; killed: boolean }>((resolve) => {
      execFile(
        'node',
        [CLI, 'run', 'say hello', '--runtime', 'fake', '--workflow', 'simple'],
        {
          cwd: dir,
          timeout: 25_000, // far longer than the command needs: a timeout here MEANS the process hung
          env: { ...process.env, TAKUMI_TEST_HOLD_ALIVE_MS: '60000' },
        },
        (err, stdout) => {
          const e = err as (Error & { code?: number | null; killed?: boolean }) | null;
          resolve({ code: e ? (e.code ?? null) : 0, stdout, killed: Boolean(e && e.killed) });
        },
      );
    });
    const elapsedMs = Date.now() - started;

    assert.equal(out.killed, false, 'the process must END BY ITSELF, not be killed by the test timeout');
    assert.equal(out.code, 0, 'the command finished, so the process exits with ITS exit code');
    assert.ok(elapsedMs < 20_000, `it must exit promptly, not after the hold expires (took ${elapsedMs}ms)`);
    assert.match(
      out.stdout,
      /MARKER-FROM-THE-RUN/,
      'and it must print everything first: an explicit exit may not truncate the output',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('importing the CLI module runs nothing and exits nothing — the importer keeps running', async () => {
  /**
   * What this pins: the CLI entry is imported by tests (`apps/cli/src/test/run.test.ts` imports
   * `runPilotCommand`) and by anything embedding it. With the explicit exit in place and NO entry-point
   * guard, importing it started a command and then EXITED THE IMPORTER — which silently cut 16 tests off
   * the end of the suite while the suite still reported `0 fail` (1022 → 1006). A quiet loss of tests is
   * a defect, not a footnote: the count is what tells a reader the suite is intact.
   */
  const dir = mkdtempSync(join(tmpdir(), 'takumi-cli-import-'));
  try {
    const probe = join(dir, 'probe.mjs');
    writeFileSync(
      probe,
      `import(${JSON.stringify(CLI)}).then(() => console.log('IMPORTED-AND-STILL-RUNNING'));\n`,
    );
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('node', [probe], { timeout: 20_000 }, (err, out) => (err ? reject(err) : resolve(out)));
    });
    assert.match(
      stdout,
      /IMPORTED-AND-STILL-RUNNING/,
      'importing the module must not run a command or end the process that imported it',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
