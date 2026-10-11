#!/usr/bin/env node
/**
 * LIVE end-to-end self-test for @takumi/delivery-forgejo against the operator's
 * REAL self-hosted Forgejo.
 *
 * What it does, in order, against the live instance:
 *
 *   1. creates the THROWAWAY repository `<owner>/<repo>` via the API;
 *   2. clones it, creates a branch and a REAL commit;
 *   3. runs the provider's `deliver()`: plain push, exactly one pull request;
 *   4. reads the pull request's `status()` and `checks()`;
 *   5. opens a REAL issue (`openIssue`);
 *   6. comments on the pull request (`commentOnPullRequest`);
 *   7. merges with the CORRECT `expectedHeadSha`;
 *   8. opens a second pull request and attempts a merge with a STALE
 *      `expectedHeadSha`, which the HOST refuses.
 *
 * The token is read from ~/.git-credentials at run time and is never printed,
 * never passed on a command line (git uses the stored credential helper; the
 * adapter's curl transport sends the header on stdin) and never written to a
 * file. Every API response body is passed through `redact()` before printing.
 *
 * Run it with the package built:
 *   node scripts/live-selftest.mjs
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createForgejoDeliveryProvider, createForgejoTransport, createGitRunner } from '../dist/index.js';

const BASE = process.env.FJ_BASE ?? 'http://forgejo.internal.invalid:3000';
const API = `${BASE}/api/v1`;
const OWNER = process.env.FJ_OWNER ?? 'dev';
const REPO = process.env.FJ_REPO ?? 'takumi-delivery-selftest';
const BASE_BRANCH = 'main';
/** renderRunMarker requires exactly 8 lowercase hex characters. */
const RUN_ID = randomBytes(4).toString('hex');
const ITEM_ID = 'SELFTEST-1';

// --- token handling (never printed) ----------------------------------------

function readToken() {
  const path = join(process.env.HOME ?? '/root', '.git-credentials');
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((l) => l.includes('forgejo.internal.invalid'));
  if (line === undefined) throw new Error('no credential line for the Forgejo host in ~/.git-credentials');
  const userinfo = line.replace(/^[^:]*:\/\//, '').split('@')[0];
  const colon = userinfo.indexOf(':');
  return colon === -1 ? userinfo : userinfo.slice(colon + 1);
}

const token = readToken();
if (token.length === 0) throw new Error('the stored Forgejo token is empty');

/** Strip the token from any text before it can reach stdout or a file. */
function redact(text) {
  const s = typeof text === 'string' ? text : String(text);
  return token.length > 0 ? s.split(token).join('<REDACTED-TOKEN>') : s;
}

// --- evidence + logging -----------------------------------------------------

const evidence = [];
let currentStep = 'setup';
const log = (...parts) => console.log(...parts);

function step(name) {
  currentStep = name;
  log(`\n=== ${name} ===`);
}

function record(entry) {
  evidence.push({ step: currentStep, ...entry });
}

const rawRequest = createForgejoTransport({ token });
const loggingRequest = async (req) => {
  const res = await rawRequest(req);
  const body = redact(res.body);
  log(`  ${req.method} ${req.url.replace(API, '')} -> HTTP ${res.status}${body.length === 0 ? '' : ` ${body.slice(0, 400)}`}`);
  record({ kind: 'http', method: req.method, url: req.url, status: res.status, body: body.slice(0, 4000) });
  return res;
};

async function api(method, path, body) {
  return loggingRequest({ method, url: `${API}${path}`, ...(body === undefined ? {} : { body }) });
}

function git(args, cwd) {
  log(`  $ git ${args.join(' ')}`);
  const out = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  record({ kind: 'git', args, cwd, stdout: redact(out.trim()).slice(0, 2000) });
  return out;
}

function fail(message) {
  log(`\nFAILED: ${message}`);
  writeReport();
  process.exit(1);
}

let reportPath = '';
function writeReport() {
  if (reportPath.length === 0) return;
  writeFileSync(reportPath, `${JSON.stringify({ base: BASE, owner: OWNER, repo: REPO, runId: RUN_ID, evidence }, null, 2)}\n`);
}

// --- the run ----------------------------------------------------------------

const workdir = mkdtempSync(join(tmpdir(), 'takumi-fj-selftest-'));
const repoDir = join(workdir, 'repo');
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');
reportPath = join(packageDir, 'live-selftest-evidence.json');

try {
  log(`Forgejo live self-test — ${BASE} — repo ${OWNER}/${REPO} — run ${RUN_ID}`);

  // 1. the throwaway repository -------------------------------------------------
  step('1. create the throwaway repository');
  const existing = await api('GET', `/repos/${OWNER}/${REPO}`);
  if (existing.status === 200) {
    log('  repository already exists (reusing it)');
  } else if (existing.status === 404) {
    const created = await api('POST', `/orgs/${OWNER}/repos`, {
      name: REPO,
      private: true,
      auto_init: true,
      default_branch: BASE_BRANCH,
    });
    if (created.status !== 201) fail(`repository creation returned HTTP ${created.status}`);
    const createdBody = JSON.parse(created.body);
    log(`  created ${createdBody.full_name} (clone_url ${createdBody.clone_url})`);
  } else {
    fail(`unexpected status probing the repository: ${existing.status}`);
  }

  // 2. a real clone with a real commit -----------------------------------------
  step('2. clone, branch and commit');
  git(['clone', `${BASE}/${OWNER}/${REPO}.git`, repoDir], workdir);
  git(['config', 'user.email', 'takumi-selftest@example.invalid'], repoDir);
  git(['config', 'user.name', 'takumi selftest'], repoDir);
  const frozenBase = git(['rev-parse', 'HEAD'], repoDir).trim();
  log(`  frozen base (${BASE_BRANCH}) = ${frozenBase}`);

  const branch1 = `takumi/selftest-${RUN_ID}`;
  git(['switch', '-c', branch1], repoDir);
  appendFileSync(join(repoDir, 'README.md'), `\n\nselftest run ${RUN_ID} (branch 1)\n`);
  git(['commit', '-am', `selftest: branch 1 (run ${RUN_ID})`], repoDir);
  const head1 = git(['rev-parse', 'HEAD'], repoDir).trim();

  const provider = createForgejoDeliveryProvider({
    owner: OWNER,
    repo: REPO,
    apiBase: API,
    request: loggingRequest,
    git: createGitRunner(),
    remote: 'origin',
  });

  // 3. deliver: plain push + exactly one pull request --------------------------
  step('3. deliver() — plain push, exactly one pull request');
  const out1 = await provider.deliver(
    {
      worktree: repoDir,
      branch: branch1,
      baseBranch: BASE_BRANCH,
      remote: 'origin',
      itemId: ITEM_ID,
      runId: RUN_ID,
      title: `takumi selftest ${RUN_ID}`,
      body: 'Live delivery self-test.',
    },
    { baseSha: frozenBase },
  );
  log(`  push: mode=${out1.push.mode} branch=${out1.push.branch} head=${out1.push.head}`);
  log(`  pull request: created=${out1.created} #${out1.pr?.number} ${out1.pr?.url}`);
  if (out1.push.mode !== 'plain') fail('the push was not plain');
  if (out1.created !== true) fail('the first deliver did not create a pull request');
  if (out1.pr === undefined) fail('no pull request was reported');
  record({ kind: 'deliver', created: out1.created, pr: out1.pr, push: out1.push, notes: out1.notes });

  // A second deliver must REUSE the same pull request (exactly one per delivery).
  const out1b = await provider.deliver(
    {
      worktree: repoDir,
      branch: branch1,
      baseBranch: BASE_BRANCH,
      remote: 'origin',
      itemId: ITEM_ID,
      runId: RUN_ID,
    },
    { baseSha: frozenBase },
  );
  log(`  second deliver: created=${out1b.created} pr=#${out1b.pr?.number}`);
  if (out1b.created !== false || out1b.pr?.number !== out1.pr.number) {
    fail('a second deliver must reuse the same pull request');
  }
  record({ kind: 'deliver-repeat', created: out1b.created, pr: out1b.pr, push: out1b.push, notes: out1b.notes });

  // 4. status + checks ---------------------------------------------------------
  step('4. status() and checks()');
  const status1 = await provider.status(out1.pr);
  const checks1 = await provider.checks(out1.pr);
  log(`  status: ${JSON.stringify(status1)}`);
  log(`  checks: ${JSON.stringify(checks1)}`);
  record({ kind: 'status', status: status1 });
  record({ kind: 'checks', checks: checks1 });

  // 5. the issue surface -------------------------------------------------------
  step('5. openIssue()');
  const issue = await provider.openIssue({
    title: `selftest issue ${RUN_ID}`,
    body: `Opened by the takumi delivery self-test for run ${RUN_ID}.`,
  });
  log(`  issue #${issue.number} ${issue.url}`);
  record({ kind: 'openIssue', issue });

  // 6. comment on the pull request ---------------------------------------------
  step('6. commentOnPullRequest()');
  const comment = await provider.commentOnPullRequest(out1.pr, `Live self-test comment for run ${RUN_ID}.`);
  log(`  comment #${comment.id} ${comment.url}`);
  record({ kind: 'commentOnPullRequest', comment });

  // 7. merge with the CORRECT head ---------------------------------------------
  step('7. merge() with the correct expectedHeadSha');
  const merged1 = await provider.merge(out1.pr, { expectedHeadSha: out1.pr.headSha, method: 'merge' });
  const statusAfter1 = await provider.status(out1.pr);
  log(`  merged: ${JSON.stringify(merged1)}`);
  log(`  status after merge: ${JSON.stringify(statusAfter1)}`);
  if (merged1.merged !== true) fail('the correct-head merge did not report merged=true');
  if (statusAfter1.state !== 'merged') fail(`status after merge is ${statusAfter1.state}, not 'merged'`);
  record({ kind: 'merge', merged: merged1, statusAfter: statusAfter1 });

  // 8. a second pull request, and a STALE-head merge that must fail ------------
  step('8. a second pull request and a STALE-head merge');
  git(['switch', BASE_BRANCH], repoDir);
  const branch2 = `takumi/selftest-stale-${RUN_ID}`;
  git(['switch', '-c', branch2], repoDir);
  // Touch a DIFFERENT region of the file than branch 1 did, so that absorbing the
  // advanced base (main now carries branch 1's change) is a clean merge rather
  // than an artificial conflict.
  const readmePath = join(repoDir, 'README.md');
  const readmeLines = readFileSync(readmePath, 'utf8').split('\n');
  readmeLines[0] = `# takumi selftest ${RUN_ID} (branch 2)`;
  writeFileSync(readmePath, readmeLines.join('\n'));
  git(['commit', '-am', `selftest: branch 2 (run ${RUN_ID})`], repoDir);
  const preDeliverHead2 = git(['rev-parse', 'HEAD'], repoDir).trim();
  const out2 = await provider.deliver(
    {
      worktree: repoDir,
      branch: branch2,
      baseBranch: BASE_BRANCH,
      remote: 'origin',
      itemId: ITEM_ID,
      runId: RUN_ID,
      title: `takumi selftest stale-head ${RUN_ID}`,
      body: 'Live stale-head merge self-test.',
    },
    { baseSha: frozenBase },
  );
  log(`  pull request #${out2.pr?.number} head=${out2.pr?.headSha}`);
  log(`  notes: ${out2.notes.join(' | ')}`);
  record({ kind: 'deliver2', pr: out2.pr, push: out2.push, notes: out2.notes });

  // The head the branch had BEFORE deliver absorbed the advanced base is a real
  // commit that is no longer the pull request's head — a genuine stale head.
  const staleHead = preDeliverHead2 !== out2.pr?.headSha ? preDeliverHead2 : frozenBase;
  log(`  stale expectedHeadSha = ${staleHead} (pull request head is ${out2.pr?.headSha})`);

  let staleError = '';
  let staleFailed = false;
  try {
    await provider.merge(out2.pr, { expectedHeadSha: staleHead, method: 'merge' });
  } catch (e) {
    staleFailed = true;
    staleError = `${e.name}(${e.kind}): ${e.message}`;
  }
  log(`  stale-head merge failed = ${staleFailed}${staleError === '' ? '' : ` — ${staleError}`}`);
  if (!staleFailed) fail('a merge with a STALE expectedHeadSha SUCCEEDED — the host did not enforce the exact head');
  record({ kind: 'staleHeadMerge', expectedHeadSha: staleHead, prHeadSha: out2.pr?.headSha, failed: staleFailed, error: staleError });

  // The pull request is still open and mergeable: the refusal was about the head.
  const status2 = await provider.status(out2.pr);
  log(`  status after the refused merge: ${JSON.stringify(status2)}`);
  record({ kind: 'status2', status: status2 });
  if (status2.state !== 'open') fail('the refused stale-head merge must leave the pull request open');

  const merged2 = await provider.merge(out2.pr, { expectedHeadSha: out2.pr.headSha, method: 'merge' });
  log(`  correct-head merge of #${out2.pr.number}: ${JSON.stringify(merged2)}`);
  record({ kind: 'merge2', merged: merged2 });

  writeReport();
  log(`\nALL LIVE STEPS PASSED. Evidence: ${reportPath}`);
  log(`NOTE: the throwaway repository ${OWNER}/${REPO} was CREATED by this script — delete it when done.`);
} catch (e) {
  log(`\nFAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  writeReport();
  log(`Partial evidence: ${reportPath}`);
  process.exitCode = 1;
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
