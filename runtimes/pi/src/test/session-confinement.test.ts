import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSandboxPolicy, sandboxCapability, shQuote, UnshareSandbox } from '@takumi/core';
import { PiRuntimeAdapter } from '../index.js';
import type { Confinement } from '../confinement.js';

// S5 (ADR-058): what the adapter's SESSION really holds.
//
// `confinement.test.ts` measures `createConfinedTools` — the call. That test stayed green
// while the delivery agent ran with the SDK's BUILTIN tools, because the artifact that ran
// (`runtimes/pi/dist/index.js`) was a stale build that predated these tools entirely
// (2026-10-12 20:20 JST, ~4.5 h before the source landed at 2026-10-13 00:48 JST; see
// docs/bugs-fixed.md #88). A test of the CALL cannot see that. These tests measure the
// ARTIFACT: they ask the adapter for the session it would hand a confined task and inspect
// the session's OWN tools — which is what the model would actually be given.

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

// The boundary cannot mirror a project root under `/tmp` (guard G4), so the worktree lives
// outside it, exactly like the core boundary tests.
const SCRATCH_ROOT = path.join(homedir(), '.cache', 'takumi-pi-confinement-tests');

/** The tiny slice of the Pi SDK's AgentSession these tests measure. */
interface SessionTool {
  name: string;
  execute(callId: string, args: unknown, signal?: unknown, onUpdate?: unknown, ctx?: unknown): Promise<unknown>;
}
interface ProbeSession {
  getActiveToolNames(): string[];
  getToolDefinition(name: string): SessionTool | undefined;
}
interface SessionAcquirer {
  acquireSession(
    cwd: string,
    taskId: string,
    emit: (ev: unknown) => void,
    confinement?: Confinement,
  ): Promise<{ session: ProbeSession; isReused: boolean }>;
}

interface Fixture {
  adapter: PiRuntimeAdapter;
  session: ProbeSession;
  worktree: string;
  cleanup(): void;
}

/**
 * The adapter's OWN session for a confined task, built over a real boundary.
 *
 * `acquireSession` is private in TypeScript but is exactly the seam that builds the
 * session; calling it here measures the session the adapter returns, not
 * `createConfinedTools`. When the host cannot establish a boundary the test SKIPS with a
 * named reason rather than reporting a green it did not measure.
 */
async function confinedSession(t: { skip(reason: string): void }): Promise<Fixture | null> {
  const capability = await sandboxCapability();
  if (!capability.available) {
    t.skip(`the boundary cannot be established on this host: ${capability.reason ?? 'unknown'}`);
    return null;
  }

  const runId = `run-session-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const base = mkdtempSync(path.join(SCRATCH_ROOT, 'pi-session-'));
  const worktree = path.join(base, 'worktree');
  const judgeDir = path.join(REPO_ROOT, '.takumi', 'acceptance', runId, 'step-1');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(judgeDir, { recursive: true });

  const adapter = new PiRuntimeAdapter();
  try {
    const policy = buildSandboxPolicy({ projectRoot: REPO_ROOT, worktree, judgeDir, runId });
    const confinement: Confinement = {
      sandbox: new UnshareSandbox(policy),
      roots: { rw: [...policy.rw], ro: [...policy.ro], cwd: policy.cwd },
    };
    const { session } = await (adapter as unknown as SessionAcquirer).acquireSession(
      worktree,
      'probe-session',
      () => {},
      confinement,
    );
    return {
      adapter,
      session,
      worktree,
      cleanup: () => {
        adapter.close();
        rmSync(base, { recursive: true, force: true });
        rmSync(path.join(REPO_ROOT, '.takumi', 'acceptance', runId), { recursive: true, force: true });
      },
    };
  } catch (e) {
    adapter.close();
    rmSync(base, { recursive: true, force: true });
    rmSync(path.join(REPO_ROOT, '.takumi', 'acceptance', runId), { recursive: true, force: true });
    throw e;
  }
}

test('session confinement: a confined task gets the contained tools, not the builtins', async (t) => {
  const fixture = await confinedSession(t);
  if (fixture === null) return;
  try {
    // The contained set has NO grep: confinement.ts drops it by name because its search
    // shells out to ripgrep, which no operations override can contain.
    const active = fixture.session.getActiveToolNames();
    assert.ok(
      !active.includes('grep'),
      `a confined session must not offer grep (confinement.ts drops it by name): ${active.join(', ')}`,
    );
    for (const name of ['read', 'write', 'edit', 'ls', 'find', 'bash']) {
      assert.ok(active.includes(name), `a confined session must offer ${name}: ${active.join(', ')}`);
    }
  } finally {
    fixture.cleanup();
  }
});

test('session confinement: the session bash cannot read the platform repository', async (t) => {
  const fixture = await confinedSession(t);
  if (fixture === null) return;
  try {
    const platformFile = path.join(REPO_ROOT, 'package.json');
    // `cat` the platform's OWN package.json. Inside the boundary the project root is not
    // mirrored, so the file is absent and `cat` fails; the stale build's builtin bash
    // prints the host's copy (that is the incident this test exists for).
    const command = `echo probe-start; cat ${shQuote(platformFile)}; echo cat_rc=$?`;

    // Non-vacuity: on the HOST the very same command prints the platform file, so the
    // refusal below is the boundary's doing and not a broken command.
    const hostRead = execSync(`/bin/sh -c ${shQuote(command)}`, { cwd: fixture.worktree, encoding: 'utf8' });
    assert.match(hostRead, /"name": "takumi"/, 'non-vacuity: the command reads the platform file on the host');

    // DECISIVE: execute the session's own bash tool. A contained bash runs through
    // `sandbox.runStep`; the builtin one runs the host's shell.
    const bash = fixture.session.getToolDefinition('bash');
    assert.ok(bash, 'the session has a bash tool');
    const result = await bash.execute('probe-bash', { command }, undefined, undefined, undefined);
    const text = JSON.stringify(result);
    assert.ok(!text.includes('"name": "takumi"'), `a confined bash must not read the platform: ${text}`);
    assert.match(text, /cat_rc=[1-9]/, `the platform file must be absent inside the boundary: ${text}`);
  } finally {
    fixture.cleanup();
  }
});
