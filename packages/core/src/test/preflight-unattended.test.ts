import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'pf-target-'));
  const runtime = join(dir, 'index.js');
  writeFileSync(runtime, 'export const PiRuntimeAdapter = class {};\n');
  try {
    const r = preflight({ TAKUMI_PI_RUNTIME: runtime, TAKUMI_DELIVERY_REPO: 'torvalds/linux' });
    assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /REFUSED by the host/);
    assert.match(`${r.stdout}${r.stderr}`, /SELECTED for it/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
