import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, runTask, type ProjectConfig } from '../commands.js';
import {
  createDeliveryFromSection,
  createDeliveryProvider,
  deliveryCloneUrl,
  deliveryOptionsFromSection,
  forgejoDeliveryOptions,
  githubDeliveryOptions,
  gitlabDeliveryOptions,
  splitOwnerRepo,
} from '../delivery-command.js';
import { createDeliveryWorktree } from '../worktree-command.js';
import type { GitRunner } from '@takumi/core';

/**
 * The delivery provider, reachable from `takumi.yaml` (ADR-007 / ADR-037).
 *
 * These tests drive the REAL CLI code path: `loadConfig` reads an actual `takumi.yaml`, and `runTask`
 * is the run the CLI performs. The front-door refusal is exercised through `runTask` — a workflow with
 * a `publish` step and no `delivery:` section must be refused BEFORE any step runs, because a run that
 * spends its work and only then discovers it cannot publish is the failure the refusal exists to
 * prevent. The positive test drives a REAL git worktree and the REAL Forgejo provider (no mock of the
 * thing under test): the provider is built from the config, pushes the branch, and fails on its
 * unconfigured transport — which is exactly how the test knows `ctx.delivery` is the Forgejo provider.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'takumi',
  GIT_AUTHOR_EMAIL: 't@example.invalid',
  GIT_COMMITTER_NAME: 'takumi',
  GIT_COMMITTER_EMAIL: 't@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
}

/** A project directory with a `takumi.yaml` and a workflow whose only step is `publish`. */
function project(deliveryLines: string[] | undefined): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-delivery-'));
  const yaml = [
    'runtime: fake',
    'registry:',
    '  skills: extensions/skills',
    '  tools: extensions/tools',
    '  workflows: extensions/workflows',
    '  runtimes: runtimes',
    'artifacts: .takumi/artifacts',
    ...(deliveryLines === undefined ? [] : ['delivery:', ...deliveryLines]),
    '',
  ].join('\n');
  writeFileSync(join(dir, 'takumi.yaml'), yaml);
  const wfDir = join(dir, 'extensions', 'workflows', 'publish-wf');
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(
    join(wfDir, 'workflow.yaml'),
    ['name: publish-wf', 'version: 0.0.1', 'description: a workflow whose only step is publish', 'steps:', '  - id: publish', '    type: publish', ''].join('\n'),
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A REAL git worktree on `task` with one commit AHEAD of `origin/main`, plus a bare `origin`. */
function gitWorktree(dir: string): string {
  const worktree = join(dir, 'worktree');
  mkdirSync(worktree, { recursive: true });
  git(['init', '-q', '-b', 'task'], worktree);
  writeFileSync(join(worktree, 'base.txt'), 'the frozen base\n');
  git(['add', '-A'], worktree);
  git(['commit', '-q', '-m', 'the base commit'], worktree);
  const remote = join(dir, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' });
  git(['remote', 'add', 'origin', remote], worktree);
  git(['push', '-q', 'origin', 'HEAD:main'], worktree);
  // A commit BEYOND the base: the publish step must have something to push.
  writeFileSync(join(worktree, 'feature.txt'), 'the delivered change\n');
  git(['add', '-A'], worktree);
  git(['commit', '-q', '-m', 'the delivered commit'], worktree);
  return worktree;
}

// --- the config → provider factory (mirrors board-command) ------------------------------------

test('delivery options: repo is owner/name and splits into the owner and repo the Forgejo adapter wants', () => {
  assert.deepEqual(splitOwnerRepo('dev/takumi-delivery-selftest'), { owner: 'dev', repo: 'takumi-delivery-selftest' });
  assert.throws(() => splitOwnerRepo('dev'), /repo must be owner\/name/);
  assert.throws(() => splitOwnerRepo('host/dev/name'), /repo must be owner\/name/);
  assert.throws(() => splitOwnerRepo('/name'), /repo must be owner\/name/);
  assert.throws(() => splitOwnerRepo('dev/'), /repo must be owner\/name/);

  const opts = forgejoDeliveryOptions({
    providerId: 'forgejo',
    providerOptions: { repo: 'dev/takumi-delivery-selftest', apiBase: 'https://forgejo.example/api/v1', remote: 'upstream' },
  });
  assert.deepEqual(opts, {
    owner: 'dev',
    repo: 'takumi-delivery-selftest',
    apiBase: 'https://forgejo.example/api/v1',
    remote: 'upstream',
  });
});

test('delivery options: baseBranch stays a RUN default, never forwarded to the provider as an option', () => {
  const section = {
    provider: 'forgejo',
    repo: 'dev/selftest',
    apiBase: 'https://forgejo.example/api/v1',
    baseBranch: 'develop',
    remote: 'origin',
  };
  const options = deliveryOptionsFromSection(section);
  assert.deepEqual(options.providerOptions, { repo: 'dev/selftest', apiBase: 'https://forgejo.example/api/v1', remote: 'origin' });
  assert.ok(!('baseBranch' in options.providerOptions), 'baseBranch is a run default, not a provider option');
});

test('createDeliveryProvider: the forgejo adapter is built, with its real capabilities and issue surface', async () => {
  const provider = await createDeliveryProvider({ providerId: 'forgejo', providerOptions: { repo: 'dev/selftest' } });
  assert.equal(provider.metadata().id, 'forgejo');
  assert.deepEqual(provider.capabilities(), { canPushBranch: true, canOpenPullRequest: true, canRunChecks: true, canMerge: true });
  // The issue surface is what the engine's pipeline-failure report uses.
  assert.equal(typeof provider.openIssue, 'function');
  assert.equal(typeof provider.commentOnPullRequest, 'function');
});

test('createDeliveryProvider: a provider without its required option fails fast, naming it', async () => {
  await assert.rejects(
    () => createDeliveryProvider({ providerId: 'forgejo', providerOptions: {} }),
    /provider forgejo needs repo owner\/name/,
  );
});

test('createDeliveryProvider: an unknown provider lists the known ones', async () => {
  await assert.rejects(() => createDeliveryProvider({ providerId: 'trello', providerOptions: { repo: 'a/b' } }), /unknown delivery provider: trello \(forgejo, gitlab, github\)/);
});

test('delivery options: a credential in configuration is refused, with the reason', async () => {
  await assert.rejects(
    () => createDeliveryProvider({ providerId: 'forgejo', providerOptions: { repo: 'dev/selftest', token: 'secret' } }),
    /token comes from the ENVIRONMENT/,
  );
});

test('delivery options: a key the adapter does not read is refused, and the readable ones are listed', async () => {
  await assert.rejects(
    () => createDeliveryProvider({ providerId: 'forgejo', providerOptions: { repo: 'dev/selftest', apiURL: 'x' } }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /unknown option "apiURL"/);
      assert.match(e.message, /repo, apiBase, remote/);
      return true;
    },
  );
  await assert.rejects(
    () => createDeliveryProvider({ providerId: 'forgejo', providerOptions: { repo: 'dev/selftest', git: 'x' } }),
    /set in code/,
  );
});

test('createDeliveryFromSection: a section with no provider says so', async () => {
  await assert.rejects(() => createDeliveryFromSection({ provider: '' }), /needs a `provider`/);
});

// --- gitlab: the same wiring as forgejo, onto the GitLab adapter (ADR-007 / ADR-037) -----------

test('delivery options: gitlab maps repo owner/name to the adapter project and keeps baseBranch a run default', () => {
  // The operator writes `owner/name`; the GitLab adapter names the repository `project`.
  const opts = gitlabDeliveryOptions({
    providerId: 'gitlab',
    providerOptions: { repo: 'aicodesh/takumi-e2e', apiBase: 'https://gitlab.com/api/v4', remote: 'upstream' },
  });
  assert.deepEqual(opts, {
    project: 'aicodesh/takumi-e2e',
    apiBase: 'https://gitlab.com/api/v4',
    remote: 'upstream',
  });

  // A malformed repo is refused with the SAME sentence the Forgejo mapper gives.
  assert.throws(() => gitlabDeliveryOptions({ providerId: 'gitlab', providerOptions: { repo: 'aicodesh' } }), /repo must be owner\/name/);
  assert.throws(() => gitlabDeliveryOptions({ providerId: 'gitlab', providerOptions: { repo: 'host/aicodesh/takumi-e2e' } }), /repo must be owner\/name/);

  // baseBranch stays OUT of the provider options, exactly as it does for forgejo.
  const section = {
    provider: 'gitlab',
    repo: 'aicodesh/takumi-e2e',
    apiBase: 'https://gitlab.com/api/v4',
    baseBranch: 'main',
    remote: 'origin',
  };
  const options = deliveryOptionsFromSection(section);
  assert.deepEqual(options.providerOptions, { repo: 'aicodesh/takumi-e2e', apiBase: 'https://gitlab.com/api/v4', remote: 'origin' });
  assert.ok(!('baseBranch' in options.providerOptions), 'baseBranch is a run default, not a provider option');
});

test('createDeliveryProvider: the gitlab adapter is built, with its real capabilities', async () => {
  const provider = await createDeliveryProvider({ providerId: 'gitlab', providerOptions: { repo: 'aicodesh/takumi-e2e' } });
  assert.equal(provider.metadata().id, 'gitlab');
  assert.deepEqual(provider.capabilities(), { canPushBranch: true, canOpenPullRequest: true, canRunChecks: true, canMerge: true });
});

test('createDeliveryProvider: gitlab without its required option fails fast, naming it', async () => {
  await assert.rejects(
    () => createDeliveryProvider({ providerId: 'gitlab', providerOptions: {} }),
    /provider gitlab needs repo owner\/name/,
  );
});

test('delivery options: a credential in configuration is refused for gitlab too, with the reason', async () => {
  await assert.rejects(
    () => createDeliveryProvider({ providerId: 'gitlab', providerOptions: { repo: 'aicodesh/takumi-e2e', token: 'secret' } }),
    /token comes from the ENVIRONMENT/,
  );
});

test('delivery options: a key the gitlab adapter does not read is refused, and the readable ones are listed', async () => {
  await assert.rejects(
    () => createDeliveryProvider({ providerId: 'gitlab', providerOptions: { repo: 'aicodesh/takumi-e2e', project: 'aicodesh/takumi-e2e' } }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /unknown option "project"/);
      assert.match(e.message, /repo, apiBase, remote/);
      return true;
    },
  );
  await assert.rejects(
    () => createDeliveryProvider({ providerId: 'gitlab', providerOptions: { repo: 'aicodesh/takumi-e2e', git: 'x' } }),
    /set in code/,
  );
});

// --- github: the same wiring, onto the GitHub adapter (ADR-007 / ADR-037) ----------------------

test('delivery options: github keeps repo owner/name and baseBranch a run default', () => {
  const opts = githubDeliveryOptions({
    providerId: 'github',
    providerOptions: { repo: 'sscodeai/takumi-delivery-demo', apiBase: 'https://api.github.com', remote: 'upstream' },
  });
  assert.deepEqual(opts, {
    repo: 'sscodeai/takumi-delivery-demo',
    apiBase: 'https://api.github.com',
    remote: 'upstream',
  });

  // A malformed repo is refused with the SAME sentence the other mappers give.
  assert.throws(() => githubDeliveryOptions({ providerId: 'github', providerOptions: { repo: 'sscodeai' } }), /repo must be owner\/name/);
  assert.throws(() => githubDeliveryOptions({ providerId: 'github', providerOptions: { repo: 'host/sscodeai/takumi-delivery-demo' } }), /repo must be owner\/name/);

  // baseBranch stays OUT of the provider options, exactly as it does for forgejo and gitlab.
  const section = { provider: 'github', repo: 'sscodeai/takumi-delivery-demo', baseBranch: 'main', remote: 'origin' };
  const options = deliveryOptionsFromSection(section);
  assert.deepEqual(options.providerOptions, { repo: 'sscodeai/takumi-delivery-demo', remote: 'origin' });
  assert.ok(!('baseBranch' in options.providerOptions), 'baseBranch is a run default, not a provider option');
});

test('createDeliveryProvider: the github adapter is built, with its real capabilities', async () => {
  const provider = await createDeliveryProvider({ providerId: 'github', providerOptions: { repo: 'sscodeai/takumi-delivery-demo' } });
  assert.equal(provider.metadata().id, 'github');
  assert.deepEqual(provider.capabilities(), { canPushBranch: true, canOpenPullRequest: true, canRunChecks: true, canMerge: true });
});

test('createDeliveryProvider: github without its required option fails fast, naming it', async () => {
  await assert.rejects(
    () => createDeliveryProvider({ providerId: 'github', providerOptions: {} }),
    /provider github needs repo owner\/name/,
  );
});

test('delivery options: a credential in configuration is refused for github too, with the reason', async () => {
  await assert.rejects(
    () => createDeliveryProvider({ providerId: 'github', providerOptions: { repo: 'sscodeai/takumi-delivery-demo', token: 'secret' } }),
    /token comes from the ENVIRONMENT/,
  );
});

test('delivery options: a key the github adapter does not read is refused, and the readable ones are listed', async () => {
  await assert.rejects(
    () => createDeliveryProvider({ providerId: 'github', providerOptions: { repo: 'sscodeai/takumi-delivery-demo', owner: 'sscodeai' } }),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /unknown option "owner"/);
      assert.match(e.message, /repo, apiBase, remote/);
      return true;
    },
  );
  await assert.rejects(
    () => createDeliveryProvider({ providerId: 'github', providerOptions: { repo: 'sscodeai/takumi-delivery-demo', git: 'x' } }),
    /set in code/,
  );
});

// --- the clone URL: provider-generic, so a `provider: github` section clones GitHub -------------

test('clone URL: github derives https://github.com/<owner>/<repo>.git', async () => {
  assert.equal(
    await deliveryCloneUrl({ provider: 'github', repo: 'sscodeai/takumi-delivery-demo' }),
    'https://github.com/sscodeai/takumi-delivery-demo.git',
  );
});

test('clone URL: github honours a GitHub Enterprise apiBase', async () => {
  assert.equal(
    await deliveryCloneUrl({ provider: 'github', repo: 'acme/widget', apiBase: 'https://ghe.example.com/api/v3' }),
    'https://ghe.example.com/acme/widget.git',
  );
});

test('clone URL: gitlab derives https://gitlab.com/<namespace>/<project>.git, and honours a self-hosted apiBase', async () => {
  assert.equal(
    await deliveryCloneUrl({ provider: 'gitlab', repo: 'aicodesh/takumi-e2e' }),
    'https://gitlab.com/aicodesh/takumi-e2e.git',
  );
  assert.equal(
    await deliveryCloneUrl({ provider: 'gitlab', repo: 'aicodesh/takumi-e2e', apiBase: 'https://gitlab.example.com/api/v4' }),
    'https://gitlab.example.com/aicodesh/takumi-e2e.git',
  );
});

test('clone URL: forgejo keeps its provider-resolved web base (unchanged behaviour)', async () => {
  assert.equal(
    await deliveryCloneUrl({ provider: 'forgejo', repo: 'dev/widget', apiBase: 'https://forgejo.example.com/api/v1' }),
    'https://forgejo.example.com/dev/widget.git',
  );
});

// --- `apiBase` is the API endpoint, NEVER the git host (docs/bugs-fixed.md #46) ------------------
//
// MEASURED live: three runs failed closed at the worktree-clone step because the git host was derived
// from `apiBase`. The shapes below are the exact ones those runs produced — GitHub's OWN API base (a
// host that is not the git host) and the committed Forgejo placeholder `apiBase` INHERITED through
// `takumi.local.yaml`'s per-key merge over `takumi.yaml` (omitting `apiBase` does not clear it).

test('clone URL: github ignores its OWN api.github.com base — that host is not the git host', async () => {
  assert.equal(
    await deliveryCloneUrl({ provider: 'github', repo: 'sscodeai/takumi-delivery-demo', apiBase: 'https://api.github.com' }),
    'https://github.com/sscodeai/takumi-delivery-demo.git',
  );
});

test('clone URL: an INHERITED forgejo placeholder apiBase does not become a github clone host', async () => {
  // The committed `takumi.yaml` apiBase, inherited by a `provider: github` section through the merge.
  assert.equal(
    await deliveryCloneUrl({
      provider: 'github',
      repo: 'sscodeai/takumi-delivery-demo',
      apiBase: 'http://forgejo.internal.invalid:3000/api/v1',
    }),
    'https://github.com/sscodeai/takumi-delivery-demo.git',
  );
});

test('clone URL: the same inherited placeholder does not become a gitlab clone host either', async () => {
  assert.equal(
    await deliveryCloneUrl({
      provider: 'gitlab',
      repo: 'aicodesh/takumi-e2e',
      apiBase: 'http://forgejo.internal.invalid:3000/api/v1',
    }),
    'https://gitlab.com/aicodesh/takumi-e2e.git',
  );
});

test('clone URL: a self-hosted host is honoured ONLY when apiBase carries the provider API path', async () => {
  // The provider's own API path is the discriminator: /api/v3 (GitHub Enterprise), /api/v4 (GitLab).
  assert.equal(
    await deliveryCloneUrl({ provider: 'github', repo: 'acme/widget', apiBase: 'https://ghe.example.com/api/v3/' }),
    'https://ghe.example.com/acme/widget.git',
  );
  assert.equal(
    await deliveryCloneUrl({ provider: 'gitlab', repo: 'group/widget', apiBase: 'https://gitlab.example.com/api/v4' }),
    'https://gitlab.example.com/group/widget.git',
  );
  // A host carrying ANOTHER provider's API path is not this provider's endpoint, so it is NOT the git host.
  assert.equal(
    await deliveryCloneUrl({ provider: 'github', repo: 'acme/widget', apiBase: 'https://gitlab.example.com/api/v4' }),
    'https://github.com/acme/widget.git',
  );
});

test('clone URL: a malformed repo and an unknown provider are refused, naming the provider', async () => {
  await assert.rejects(() => deliveryCloneUrl({ provider: 'github', repo: 'sscodeai' }), /repo must be owner\/name/);
  await assert.rejects(() => deliveryCloneUrl({ provider: 'github' }), /provider github needs repo owner\/name/);
  await assert.rejects(
    () => deliveryCloneUrl({ provider: 'trello', repo: 'a/b' }),
    /a clone URL is only defined for provider "trello" \(forgejo, gitlab, github\)/,
  );
});

test('createDeliveryWorktree: the REAL clone of a github section uses the derived github URL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-clone-url-'));
  try {
    // The git seam is injected so the assertion is about the argv the REAL worktree creation builds.
    const argv: string[][] = [];
    const git: GitRunner = {
      run: async (args: string[]) => {
        argv.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const created = await createDeliveryWorktree({
      cwd: dir,
      section: { provider: 'github', repo: 'sscodeai/takumi-delivery-demo', baseBranch: 'main', remote: 'origin' },
      branch: 'takumi/run-test',
      git,
    });
    assert.equal(created.cloneUrl, 'https://github.com/sscodeai/takumi-delivery-demo.git');
    assert.deepEqual(argv[0], ['clone', '--branch', 'main', 'https://github.com/sscodeai/takumi-delivery-demo.git', created.path]);
    assert.equal(created.baseBranch, 'main');
    assert.equal(created.remote, 'origin');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createDeliveryWorktree: an inherited forgejo apiBase still clones the github host (the live defect)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'takumi-clone-url-'));
  try {
    const argv: string[][] = [];
    const git: GitRunner = {
      run: async (args: string[]) => {
        argv.push(args);
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const created = await createDeliveryWorktree({
      cwd: dir,
      // The section a merged `takumi.local.yaml` actually produces: provider github + the INHERITED apiBase.
      section: {
        provider: 'github',
        repo: 'sscodeai/takumi-delivery-demo',
        apiBase: 'http://forgejo.internal.invalid:3000/api/v1',
        baseBranch: 'main',
        remote: 'origin',
      },
      branch: 'takumi/run-test',
      git,
    });
    assert.equal(created.cloneUrl, 'https://github.com/sscodeai/takumi-delivery-demo.git');
    assert.deepEqual(argv[0], ['clone', '--branch', 'main', 'https://github.com/sscodeai/takumi-delivery-demo.git', created.path]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the front door: refuse BEFORE the run starts ---------------------------------------------

test('run: a publish workflow with NO delivery configuration is refused BEFORE it runs, naming what is missing', async () => {
  const p = project(undefined);
  try {
    const config = loadConfig(p.dir);
    await assert.rejects(
      () => runTask({ cwd: p.dir, prompt: 'do the work', runtimeId: 'fake', workflow: 'publish-wf', config }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /declares a publish step \[publish\] but takumi\.yaml has no `delivery:` section/);
        assert.match(e.message, /there is no host to publish to/);
        return true;
      },
    );
  } finally {
    p.cleanup();
  }
});

test('run: a delivery section with no provider is refused at the front door', async () => {
  const p = project(['  repo: dev/selftest']);
  try {
    const config = loadConfig(p.dir);
    await assert.rejects(
      () => runTask({ cwd: p.dir, prompt: 'do the work', runtimeId: 'fake', workflow: 'publish-wf', config }),
      /needs a `provider`/,
    );
  } finally {
    p.cleanup();
  }
});

test('run: a delivery section whose provider is missing a required option is refused at the front door', async () => {
  const p = project(['  provider: forgejo']);
  try {
    const config = loadConfig(p.dir);
    await assert.rejects(
      () => runTask({ cwd: p.dir, prompt: 'do the work', runtimeId: 'fake', workflow: 'publish-wf', config }),
      /provider forgejo needs repo owner\/name/,
    );
  } finally {
    p.cleanup();
  }
});

// --- the positive path: config → ctx.delivery → the REAL provider ------------------------------

test('run: a configured delivery reaches ctx.delivery — the publish step drives the REAL Forgejo provider', async () => {
  const previousForgejo = process.env['FORGEJO_TOKEN'];
  const previousGitea = process.env['GITEA_TOKEN'];
  // No token: the provider is built with its fail-closed unconfigured transport, so the delivery
  // attempt is provable without any network and without a credential.
  delete process.env['FORGEJO_TOKEN'];
  delete process.env['GITEA_TOKEN'];
  const p = project([
    '  provider: forgejo',
    '  repo: dev/selftest',
    '  apiBase: http://127.0.0.1:1/api/v1',
    '  baseBranch: main',
    '  remote: origin',
  ]);
  try {
    const worktree = gitWorktree(p.dir);
    const config = loadConfig(p.dir) as ProjectConfig;
    const result = await runTask({
      cwd: p.dir,
      prompt: 'do the work',
      runtimeId: 'fake',
      workflow: 'publish-wf',
      config,
      worktree,
    });
    // The run reached the publish step (so it was NOT refused) and the failure is the Forgejo
    // provider's own — which is how we know `ctx.delivery` is the provider the config selected.
    assert.equal(result.status, 'failed', result.events.join('\n'));
    const log = result.events.join('\n');
    assert.match(log, /forgejo-delivery: no request transport configured/);
    assert.ok(!log.includes('no delivery provider (ctx.delivery)'), 'the provider WAS constructed into ctx.delivery');
  } finally {
    if (previousForgejo !== undefined) process.env['FORGEJO_TOKEN'] = previousForgejo;
    if (previousGitea !== undefined) process.env['GITEA_TOKEN'] = previousGitea;
    p.cleanup();
  }
});

test('run: a configured gitlab delivery reaches ctx.delivery — the publish step drives the REAL GitLab provider', async () => {
  const previousGitlab = process.env['GITLAB_TOKEN'];
  // No token: the provider is built with its fail-closed unconfigured transport, so the delivery
  // attempt is provable without any network and without a credential.
  delete process.env['GITLAB_TOKEN'];
  const p = project([
    '  provider: gitlab',
    '  repo: aicodesh/takumi-e2e',
    '  apiBase: http://127.0.0.1:1/api/v4',
    '  baseBranch: main',
    '  remote: origin',
  ]);
  try {
    const worktree = gitWorktree(p.dir);
    const config = loadConfig(p.dir) as ProjectConfig;
    const result = await runTask({
      cwd: p.dir,
      prompt: 'do the work',
      runtimeId: 'fake',
      workflow: 'publish-wf',
      config,
      worktree,
    });
    // The run reached the publish step (so it was NOT refused) and the failure is the GitLab
    // provider's own — which is how we know `ctx.delivery` is the provider the config selected.
    assert.equal(result.status, 'failed', result.events.join('\n'));
    const log = result.events.join('\n');
    assert.match(log, /gitlab-delivery: no request transport configured/);
    assert.ok(!log.includes('no delivery provider (ctx.delivery)'), 'the provider WAS constructed into ctx.delivery');
  } finally {
    if (previousGitlab !== undefined) process.env['GITLAB_TOKEN'] = previousGitlab;
    p.cleanup();
  }
});

test('run: a configured github delivery reaches ctx.delivery — the publish step drives the REAL GitHub provider', async () => {
  const previousGithub = process.env['GITHUB_TOKEN'];
  // No token: the provider is built with its fail-closed unconfigured transport, so the delivery
  // attempt is provable without any network and without a credential.
  delete process.env['GITHUB_TOKEN'];
  const p = project([
    '  provider: github',
    '  repo: sscodeai/takumi-delivery-demo',
    '  apiBase: http://127.0.0.1:1/api/v3',
    '  baseBranch: main',
    '  remote: origin',
  ]);
  try {
    const worktree = gitWorktree(p.dir);
    const config = loadConfig(p.dir) as ProjectConfig;
    const result = await runTask({
      cwd: p.dir,
      prompt: 'do the work',
      runtimeId: 'fake',
      workflow: 'publish-wf',
      config,
      worktree,
    });
    // The run reached the publish step (so it was NOT refused) and the failure is the GitHub
    // provider's own — which is how we know `ctx.delivery` is the provider the config selected.
    assert.equal(result.status, 'failed', result.events.join('\n'));
    const log = result.events.join('\n');
    assert.match(log, /github-delivery: no request transport configured/);
    assert.ok(!log.includes('no delivery provider (ctx.delivery)'), 'the provider WAS constructed into ctx.delivery');
  } finally {
    if (previousGithub !== undefined) process.env['GITHUB_TOKEN'] = previousGithub;
    p.cleanup();
  }
});
