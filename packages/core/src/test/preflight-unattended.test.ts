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
  const r = preflight({ TAKUMI_PI_RUNTIME: join(tmpdir(), 'definitely-not-here', 'index.js') });
  assert.equal(r.status, 3, 'an unusable environment is a REFUSAL (3), never a silent pass');
  assert.match(`${r.stdout}${r.stderr}`, /PREFLIGHT FAIL: .*pi runtime dist is missing/);
});

test('the preflight refuses a dist that EXISTS but does not load, naming the real cause', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-broken-'));
  const broken = join(dir, 'index.js');
  writeFileSync(broken, "import { nope } from './does-not-exist.js';\nexport const PiRuntimeAdapter = class {};\n");
  try {
    const r = preflight({ TAKUMI_PI_RUNTIME: broken });
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
  const r = preflight({ TAKUMI_PI_RUNTIME: real });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /PREFLIGHT ok: pi runtime loads and exports PiRuntimeAdapter/);
});
