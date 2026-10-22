import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `scripts/autopilot.sh` is the one-shot entry point of the unattended chain (ADR-045): one sentence in,
// a delivered change out. It had NO test for as long as it existed, and ledger #93 is what that cost —
// three missing environment variables were each discovered by RUNNING it, one of them after the intake
// had already burned both repair rounds.
//
// These tests cover the CHEAP half: every path that refuses before an agent turn is paid for. They do
// not, and deliberately cannot, exercise the three acts themselves — those spend a model's money and
// minutes, and a test that did would be a test nobody runs in CI. What they pin is the property that
// makes the expensive runs worth trusting: NOTHING IS SPENT UNTIL THE ENVIRONMENT IS PROVEN.
const SCRIPT = fileURLToPath(new URL('../../../../scripts/autopilot.sh', import.meta.url));

/** Run autopilot.sh from a scratch project root with whatever files the case needs. */
function run(root: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env });
}

/**
 * A minimal project root: the CLI path the script checks for, and (optionally) the authorization and
 * preflight it looks for. `autopilot.sh` resolves its own root from `$BASH_SOURCE`, so a scratch tree
 * cannot redirect it — the cases below therefore only drive paths that refuse BEFORE the root is used,
 * plus `--dry-run`, which touches nothing.
 */
function message(r: { stdout: string; stderr: string }): string {
  return `${r.stdout}${r.stderr}`;
}

test('autopilot: --dry-run prints the three acts and executes nothing', () => {
  // The dry run is the one path that must never need a credential, a runtime or an agent. It exists so
  // an operator can see the plan before spending, so it is also the safest thing to pin.
  const r = run('/tmp', ['--dry-run', 'a sentence'], { ...process.env });
  assert.equal(r.status, 0, message(r));
  const text = message(r);
  assert.match(text, /1\/3 intake/);
  assert.match(text, /2\/3 confirm/);
  assert.match(text, /3\/3 delivery/);
  // It must not have resolved anything: a dry run that reads the credential store is not a dry run.
  assert.doesNotMatch(text, /token: read from git's credential store/);
  assert.doesNotMatch(text, /runtime: TAKUMI_PI_RUNTIME=/);
});

test('autopilot: no request is a usage error, not a run', () => {
  const r = run('/tmp', ['--dry-run'], { ...process.env });
  assert.equal(r.status, 2, 'usage exits 2, so a caller can tell it apart from a refusal (1)');
  assert.match(message(r), /Usage|scripts\/autopilot\.sh/);
});

test('autopilot: an unknown option is refused, never treated as a request', () => {
  const r = run('/tmp', ['--nonsense', 'a sentence'], { ...process.env });
  assert.equal(r.status, 2);
  assert.match(message(r), /unknown option: --nonsense/);
});

// Ledger #91/#93: the script resolves the token and the runtime from the machine, and REFUSES by name
// when it cannot. The refusal must happen BEFORE the preflight and before any step, because the whole
// point is that the discovery is cheap.
test('autopilot: refuses by name when no token can be resolved, spending nothing', () => {
  // A credential store that yields nothing: an isolated HOME with no .git-credentials, and no helper
  // that could reach a real one. The script's `git credential fill` then returns no password.
  const home = mkdtempSync(join(tmpdir(), 'autopilot-nohome-'));
  try {
    writeFileSync(join(home, '.gitconfig'), '[credential]\n\thelper = \n');
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1' };
    delete env.GITHUB_TOKEN;
    const r = run('/tmp', ['a sentence'], env);
    assert.equal(r.status, 1, message(r));
    const text = message(r);
    assert.match(text, /no GITHUB_TOKEN in the environment/, 'the missing credential is NAMED');
    assert.match(text, /Nothing has been spent|nothing has been spent/i, 'and the cost of the refusal is stated');
    // It must refuse at the resolution step, not later: no preflight line, no act.
    assert.doesNotMatch(text, /== 1\/3 intake/, 'a step was reached with no token — the resolution is in the wrong place');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('autopilot: a supplied token is never second-guessed', () => {
  // An operator who exports GITHUB_TOKEN must be honoured exactly: the script resolves NOTHING and
  // overwrites NOTHING. (The run then stops at the preflight in a scratch root, which is the point —
  // the assertion is about the resolution block, not about reaching an act.)
  const r = run('/tmp', ['a sentence'], { ...process.env, GITHUB_TOKEN: 'operator-supplied-token' });
  const text = message(r);
  assert.doesNotMatch(text, /token: read from git's credential store/, 'an explicit token is not replaced');
  assert.doesNotMatch(text, /no GITHUB_TOKEN in the environment/);
});
