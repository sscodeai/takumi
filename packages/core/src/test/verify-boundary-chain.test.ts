import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The instrument for ledger #75: the boundary's own tests passed 12/12 while the CHAIN was dead,
// because the chain was never run with the boundary on. This script is that run, made repeatable.
//
// What a fast test can pin is the part that costs nothing: the check REFUSES to run when its
// result would be meaningless (the escape hatch is set) or impossible (an unhealthy environment).
// The chain run itself costs a real delivery and is run by hand on a machine with user namespaces
// — see ADR-058 "What CI cannot verify".
const SCRIPT = fileURLToPath(new URL('../../../../scripts/verify-boundary-chain.sh', import.meta.url));

function check(env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [SCRIPT, 'a sentence that must never be attempted'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60000,
  });
}

test('the boundary chain check REFUSES to run when the unsafe override is set', () => {
  const r = check({ TAKUMI_UNSAFE_NO_SANDBOX: '1' });
  assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /TAKUMI_UNSAFE_NO_SANDBOX is set/);
  assert.match(`${r.stdout}${r.stderr}`, /would say nothing about the boundary/);
});

test('the boundary chain check REFUSES on an unhealthy environment instead of reporting a delivery failure', () => {
  const r = check({ TAKUMI_UNSAFE_NO_SANDBOX: '', TAKUMI_PI_RUNTIME: join(tmpdir(), 'not-built', 'index.js') });
  assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /PREFLIGHT FAIL|environment is not healthy/);
});
