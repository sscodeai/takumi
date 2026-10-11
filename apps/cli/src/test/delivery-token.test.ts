import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertKnownProviderOptions, createDeliveryProvider, workflowNeedsHost } from '../delivery-command.js';

// A DELIVERY TOKEN IS RESOLVED BEFORE THE RUN, NOT AFTER IT (measured, 2026-10-11).
//
// The 2026-10-11 16:38 `request-to-delivery` run accepted the service 11/11 — and then the publish step
// was refused with `github-delivery: no request transport configured for GET …/pulls?… — inject one
// (tests) or provide credentials`, because `GITHUB_TOKEN` was not in the environment. The adapter is
// right to fail closed (an unauthenticated request is never sent), but the operator pays for the whole
// chain — the implementation, the delivered tests, the quality gate, the rule review and the acceptance
// — before hearing about a missing variable. So the refusal moves to the front, and it NAMES the
// variable to set.
//
// These tests drive the real factory the run path uses, with the environment manipulated explicitly.

/** Run `body` with a chosen set of token variables, restoring the environment afterwards. */
async function withEnv(vars: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
  const names = ['GITHUB_TOKEN', 'GITLAB_TOKEN', 'FORGEJO_TOKEN', 'GITEA_TOKEN', 'TAKUMI_TEST_TOKEN'];
  const saved = names.map((n) => [n, process.env[n]] as const);
  for (const name of names) delete process.env[name];
  for (const [name, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[name] = value;
  }
  try {
    await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const github = (extra: Record<string, string> = {}): { providerId: string; providerOptions: Record<string, string> } => ({
  providerId: 'github',
  providerOptions: { repo: 'sscodeai/takumi-delivery-demo', ...extra },
});

test('delivery token: a provider whose token is missing is refused BEFORE the run, naming the variable', async () => {
  await withEnv({}, async () => {
    await assert.rejects(
      () => createDeliveryProvider(github()),
      (error: Error) => {
        assert.match(error.message, /GITHUB_TOKEN/, `the refusal names the variable to set: ${error.message}`);
        assert.match(
          error.message,
          /publish|after/i,
          'the refusal says WHEN it would otherwise be discovered, so the cost of the silence is visible',
        );
        return true;
      },
    );
  });
});

test('delivery token: `tokenEnv` names the variable, and the named one WINS over the default', async () => {
  // `GITHUB_TOKEN` is set and `TAKUMI_TEST_TOKEN` is not: naming the missing one must still refuse,
  // because the name the operator wrote is the name that is read.
  await withEnv({ GITHUB_TOKEN: 'default-token' }, async () => {
    await assert.rejects(
      () => createDeliveryProvider(github({ tokenEnv: 'TAKUMI_TEST_TOKEN' })),
      /TAKUMI_TEST_TOKEN/,
      'the named variable is the one that is read',
    );
  });
});

test('delivery token: the token is read from the named variable when it is set', async () => {
  await withEnv({ TAKUMI_TEST_TOKEN: 'a-real-token' }, async () => {
    const provider = await createDeliveryProvider(github({ tokenEnv: 'TAKUMI_TEST_TOKEN' }));
    assert.ok(provider, 'the provider is built once the token resolves');
  });
});

test('delivery token: `tokenEnv` is a configurable key — a secret still never is', () => {
  // A NAME is configuration; a VALUE is not. The factory already refuses the second, and this pins the
  // first so `delivery: { tokenEnv: … }` is not rejected as an unknown option.
  assertKnownProviderOptions(github({ tokenEnv: 'TAKUMI_TEST_TOKEN' }));
  assert.throws(
    () => assertKnownProviderOptions(github({ token: 'a-secret-in-a-config-file' })),
    /ENVIRONMENT/,
    'a token value in configuration is still refused, with the reason',
  );
});

test('delivery token: a provider with no API token needs none (the bare-remote `git` provider)', () => {
  assert.doesNotThrow(() => assertKnownProviderOptions({ providerId: 'git', providerOptions: { repo: 'x' } }));
});

test('delivery token: a workflow that never talks to the host needs no token', () => {
  // `request-intake` produces a document and stops. Refusing it for a missing GITHUB_TOKEN would make
  // the FRONT of the chain impossible without a credential the run never uses — which is exactly what
  // happened on the first headless intake run (2026-10-11), and why the requirement is scoped to the
  // workflows that reach the host.
  assert.equal(workflowNeedsHost([{ type: 'agent' }, { type: 'quality_gate' }, { type: 'approval' }]), false);
  assert.equal(workflowNeedsHost([{ type: 'agent' }, { type: 'publish' }]), true);
  assert.equal(workflowNeedsHost([{ type: 'await_checks' }]), true);
  assert.equal(workflowNeedsHost([{ type: 'merge' }]), true);
});

test('delivery token: a run that never publishes is NOT refused for a missing token', async () => {
  await withEnv({}, async () => {
    // The provider is still built (the section exists) but without the up-front refusal: nothing in this
    // workflow will call it.
    const provider = await createDeliveryProvider(github(), { requireToken: false });
    assert.ok(provider, 'the provider is built when the workflow never reaches the host');
  });
});
