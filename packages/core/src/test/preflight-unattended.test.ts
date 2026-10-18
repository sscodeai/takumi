import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The unattended chain's preflight (ledger #76): an environment that cannot finish the chain must
// be refused BEFORE it is measured, because a refused measurement is not evidence about the
// chain. The check is deliberately about the ENVIRONMENT, not about the delivery.
const SCRIPT = fileURLToPath(new URL('../../../../scripts/preflight-unattended.sh', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));

function preflight(env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { ...process.env, ...env } });
}

test('the preflight refuses when the pi runtime dist is missing, and says where it looked', () => {
  // TAKUMI_DELIVERY_REPO='' pins the target check OFF: these tests are about the RUNTIME, and the
  // operator's gitignored takumi.local.yaml must not decide whether they pass.
  const r = preflight({ TAKUMI_PI_RUNTIME: join(tmpdir(), 'definitely-not-here', 'index.js'), TAKUMI_DELIVERY_REPO: '' });
  assert.equal(r.status, 3, 'an unusable environment is a REFUSAL (3), never a silent pass');
  assert.match(`${r.stdout}${r.stderr}`, /PREFLIGHT FAIL: .*pi runtime dist is missing/);
});

test('the preflight refuses a dist that EXISTS but does not load, naming the real cause', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-broken-'));
  const broken = join(dir, 'index.js');
  writeFileSync(broken, "import { nope } from './does-not-exist.js';\nexport const PiRuntimeAdapter = class {};\n");
  try {
    const r = preflight({ TAKUMI_PI_RUNTIME: broken, TAKUMI_DELIVERY_REPO: '' });
    assert.equal(r.status, 3);
    assert.match(`${r.stdout}${r.stderr}`, /PREFLIGHT FAIL: the pi runtime does not load/);
    assert.match(`${r.stdout}${r.stderr}`, /does-not-exist|Cannot find|ERR_MODULE_NOT_FOUND/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Ledger #88: the source carried the confined tools at 2026-10-13 00:48 JST, but the GITIGNORED
// artifact that ran was the 2026-10-12 20:20 build. runtimes/pi is not a pnpm workspace member (its
// @earendil-works/pi-coding-agent SDK is an unpublished peer dependency), so `pnpm -r build` and CI
// never rebuild it — and the two checks above cannot see it, because a stale build EXISTS and LOADS.
// Refuse it by its AGE: an artifact older than its newest source is a boundary that is not there.
test('the preflight refuses a runtime dist OLDER than its source, naming the cause (ledger #88)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-stale-'));
  try {
    const dist = join(dir, 'dist');
    const src = join(dir, 'src');
    mkdirSync(dist, { recursive: true });
    mkdirSync(src, { recursive: true });
    writeFileSync(join(dist, 'index.js'), 'export const PiRuntimeAdapter = class {};\n');
    writeFileSync(join(src, 'confinement.ts'), 'export const x = 1;\n');
    // The source is NEWER than the artifact: exactly the 2026-10-13 shape.
    const older = new Date(Date.now() - 60_000);
    utimesSync(join(dist, 'index.js'), older, older);
    const r = preflight({ TAKUMI_PI_RUNTIME: join(dist, 'index.js'), TAKUMI_DELIVERY_REPO: '' });
    assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /PREFLIGHT FAIL: .*OLDER than its source/);
    assert.match(`${r.stdout}${r.stderr}`, /confinement\.ts/, 'the refusal NAMES the file that is newer');
    assert.match(`${r.stdout}${r.stderr}`, /pnpm build/, 'and the command that fixes it');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the preflight passes a runtime dist that is NEWER than its source', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-current-'));
  try {
    const dist = join(dir, 'dist');
    const src = join(dir, 'src');
    mkdirSync(dist, { recursive: true });
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'confinement.ts'), 'export const x = 1;\n');
    writeFileSync(join(dist, 'index.js'), 'export const PiRuntimeAdapter = class {};\n');
    const older = new Date(Date.now() - 60_000);
    utimesSync(join(src, 'confinement.ts'), older, older);
    const r = preflight({ TAKUMI_PI_RUNTIME: join(dist, 'index.js'), TAKUMI_DELIVERY_REPO: '' });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /PREFLIGHT ok: pi runtime loads and exports PiRuntimeAdapter/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the preflight passes on this machine when the runtime is really built', (t) => {
  const real = join(REPO, 'runtimes', 'pi', 'dist', 'index.js');
  if (!existsSync(real)) {
    // CI cannot build runtimes/pi (it needs the unpublished SDK), so there is nothing to pass here.
    // The two refusals above are the contract that holds everywhere.
    t.skip('runtimes/pi/dist is not built on this machine');
    return;
  }
  const r = preflight({ TAKUMI_PI_RUNTIME: real, TAKUMI_DELIVERY_REPO: '' });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /PREFLIGHT ok: pi runtime loads and exports PiRuntimeAdapter/);
});

test('the preflight refuses a delivery target this credential cannot push to (ledger #81)', () => {
  // Measured 2026-10-13: three runs (1.5 h) implemented a deliverable FROM SCRATCH, passed their own
  // quality gates and were ACCEPTED by their forged judges against a fresh repository — and then all
  // three died at `publish` with `remote: Permission to sscodeai/takumi-delivery-demo-2.git denied`.
  // A fine-grained token only reaches the repositories selected for it, and that is a fact worth
  // checking BEFORE an implementation is paid for.
  //
  // The check is a dry-run push, because the cheap API answer lies: `repos/<r>.permissions.push`
  // describes the USER's permission, not what the token was selected for, and it returned true for
  // exactly the repository this test proves unusable. torvalds/linux is never pushable by this
  // credential, and `--dry-run` writes nothing on the host.
  //
  // The test brings its OWN runtime. The preflight checks the MACHINE before the TARGET, and
  // runtimes/pi is not built on CI (it needs the unpublished SDK), so without a fixture this test
  // never reached the check it is named after: it passed locally, where dist exists, and on CI it
  // failed with 'the pi runtime dist is missing' — a test whose outcome depends on machine state is
  // not a test of the target check. (Same family as #69-#73: local green, CI red.)
  //
  // AND IT MUST NOT DEPEND ON THE MACHINE'S OWN CREDENTIAL EITHER (ledger #89): on 2026-10-18 this
  // machine's stored credential was rejected for EVERY repository, so a real dry run to
  // torvalds/linux fails at AUTHENTICATION and this test — which is about an UNGRANTED repository —
  // never reached the case it is named after. That is the same defect the paragraph above was written
  // about, one layer down. The host's answers are therefore driven by a stub `git` that reports the
  // UNGRANTED word for granted credentials, so the case is exercised on any machine.
  const dir = mkdtempSync(join(tmpdir(), 'pf-target-'));
  const runtime = join(dir, 'index.js');
  writeFileSync(runtime, 'export const PiRuntimeAdapter = class {};\n');
  const stub = join(dir, 'git');
  writeFileSync(
    stub,
    '#!/usr/bin/env bash\ncase "$*" in\n  *push*) echo "remote: Permission to torvalds/linux.git denied to sscodeai." >&2; echo "fatal: unable to access \'https://github.com/torvalds/linux.git/\': The requested URL returned error: 403" >&2; exit 128;;\nesac\nexit 0\n',
  );
  chmodSync(stub, 0o755);
  try {
    const r = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, TAKUMI_PI_RUNTIME: runtime, TAKUMI_DELIVERY_REPO: 'torvalds/linux', PATH: `${dir}:${process.env.PATH}` },
    });
    assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /REFUSED by the host/);
    assert.match(`${r.stdout}${r.stderr}`, /SELECTED for it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Ledger #89: TWO failures wore the SAME message. A push refused because the host rejected the
// CREDENTIAL (`Invalid username or token` / `Authentication failed`) was reported as "this token does
// not select this repository" — which sent the operator to the GitHub UI to add a repository that was
// already selected. Measured 2026-10-18: on this machine the stored credential fails for EVERY
// repository (the working target included), while the same token pushed with http.extraheader
// succeeds for both, so the fault is the credential transport and NOT the target's selection.
//
// This test drives the classification directly, with a stub `git` on PATH that fails the way the host
// does, because the real credential is the machine's, not the test's: a test that could only pass on a
// machine with the right broken credential would be worthless on CI. The two cases assert the two
// MESSAGES — the whole point of #89 is that the operator can tell them apart.
test('the preflight tells a REJECTED CREDENTIAL apart from an UNGRANTED REPOSITORY (ledger #89)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-auth-'));
  const runtime = join(dir, 'index.js');
  writeFileSync(runtime, 'export const PiRuntimeAdapter = class {};\n');
  const stub = join(dir, 'git');
  try {
    // (a) The host rejects the credential. `git push` here always fails this way.
    writeFileSync(
      stub,
      '#!/usr/bin/env bash\ncase "$*" in\n  *push*) echo "remote: Invalid username or token. Password authentication is not supported for Git operations." >&2; echo "fatal: Authentication failed for \'https://github.com/x/y.git/\'" >&2; exit 128;;\nesac\nexit 0\n',
    );
    chmodSync(stub, 0o755);
    const rejected = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, TAKUMI_PI_RUNTIME: runtime, TAKUMI_DELIVERY_REPO: 'sscodeai/some-repo', PATH: `${dir}:${process.env.PATH}` },
    });
    const rejectText = `${rejected.stdout}${rejected.stderr}`;
    assert.equal(rejected.status, 3, rejectText);
    assert.match(rejectText, /credential .*REJECTED by the host/, 'the credential cause is NAMED');
    assert.match(rejectText, /could not push to ANY repository/, 'and it says this is NOT about the target');
    assert.doesNotMatch(rejectText, /SELECTED for it/, 'the token-repository-list advice must NOT be given here — it is the wrong fix (ledger #89)');

    // (b) The credential authenticates and the repository is simply not granted to it.
    writeFileSync(
      stub,
      '#!/usr/bin/env bash\ncase "$*" in\n  *push*) echo "remote: Permission to sscodeai/some-repo.git denied to sscodeai." >&2; echo "fatal: unable to access \'https://github.com/sscodeai/some-repo.git/\': The requested URL returned error: 403" >&2; exit 128;;\nesac\nexit 0\n',
    );
    chmodSync(stub, 0o755);
    const ungranted = spawnSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, TAKUMI_PI_RUNTIME: runtime, TAKUMI_DELIVERY_REPO: 'sscodeai/some-repo', PATH: `${dir}:${process.env.PATH}` },
    });
    const ungrantedText = `${ungranted.stdout}${ungranted.stderr}`;
    assert.equal(ungranted.status, 3, ungrantedText);
    assert.match(ungrantedText, /REFUSED by the host/);
    assert.match(ungrantedText, /SELECTED for it/, 'the ledger #81 advice is given for the case it was written for');
    assert.doesNotMatch(ungrantedText, /REJECTED by the host/, 'a granted-but-missing repository is not a credential fault');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
