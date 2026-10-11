/**
 * The two CI/CD steps (ADR-037): writing the host's pipeline into the delivery, and waiting for the
 * host's pipeline result on the delivered head.
 *
 * WHY THIS IS A SEPARATE MODULE, NOT INLINE IN THE ENGINE: it mirrors `quality-gate.ts` — the engine's
 * dispatch branch stays a thin call and the behaviour that matters (what the generated file contains, when
 * it refuses, and when a wait passes or fails) is pure enough to test on its own. Nothing here spawns git
 * or talks to a host directly: the file write is a plain filesystem write into the worktree, and the host
 * is the delivery provider the caller passes in.
 *
 * THE HONESTY RULE THIS FILE EXISTS FOR: a step that "waits for CI" must fail CLOSED and name what it saw.
 * A pipeline that cannot be read (no provider, a host without the checks capability, a host that throws, or
 * a host that reports nothing at all) is a FAILURE, never a pass — and a `ci_config` that would run no
 * tests is refused rather than written as decoration.
 */

import { parse as parseYamlText } from 'yaml';
import type { CheckSummary, DeliveryProvider, PullRequestRef } from './delivery.js';
import type { ArtifactStore } from './artifact-store.js';
import { DEFAULT_RUN_TIMEOUT_MS, MIN_RUN_TIMEOUT_MS } from './requirement-decisions.js';

/**
 * The dialects this step can write. `forgejo` and `github` are both
 * GitHub-Actions-compatible YAML (only the path differs); `gitlab` is GitLab CI
 * YAML, a different language, so it has its own renderer.
 */
export const CI_DIALECTS = ['forgejo', 'github', 'gitlab'] as const;
export type CiDialect = (typeof CI_DIALECTS)[number];

export function isCiDialect(value: unknown): value is CiDialect {
  return typeof value === 'string' && (CI_DIALECTS as readonly string[]).includes(value);
}

/**
 * The dialect a delivery provider's host speaks, or `undefined` when the provider names no host takumi
 * writes a pipeline for (a bare git remote, the fake provider).
 *
 * `metadata().id` is the provider's OWN name for its host, and it is the same word the dialects use
 * (`github`, `gitlab`, `forgejo`), so the mapping is the identity: the provider IS the authority on which
 * pipeline file its host runs. A provider id that is not a dialect derives nothing, and the step's own
 * default stands — this never invents a dialect for a host it does not know.
 */
export function dialectForDeliveryProvider(providerId: string | undefined): CiDialect | undefined {
  return isCiDialect(providerId) ? providerId : undefined;
}

/**
 * Where a dialect keeps its pipeline file. Forgejo and Gitea read `.forgejo/workflows/`; GitHub reads
 * `.github/workflows/`; GitLab reads a single `.gitlab-ci.yml` at the repository root.
 */
export function ciConfigPath(dialect: CiDialect): string {
  if (dialect === 'gitlab') return '.gitlab-ci.yml';
  return dialect === 'github' ? '.github/workflows/ci.yml' : '.forgejo/workflows/ci.yml';
}

/** The protected-path pattern a dialect's file matches in the deterministic reviewer. */
export function ciConfigProtectedPattern(dialect: CiDialect): string {
  if (dialect === 'gitlab') return '(^|/)\\.gitlab-ci\\.ya?ml$';
  return dialect === 'github' ? '(^|/)\\.github/workflows/' : '(^|/)\\.forgejo/workflows/';
}

/**
 * The `deliverable.run` the requirement document declares (e.g. `bash summary.sh {csv}`), or undefined.
 * A document that cannot be parsed or declares no run is reported as such by the caller — never guessed.
 */
export function readDeliverableRun(documentText: string): string | undefined {
  try {
    const doc = parseYamlText(documentText) as { deliverable?: { run?: unknown } } | null;
    const run = doc?.deliverable?.run;
    return typeof run === 'string' && run.trim().length > 0 ? run.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `deliverable.input_format.sample` the document declares, used to build the smoke fixture the
 * pipeline runs the deliverable against. Undefined when the document declares none.
 */
export function readDeliverableSample(documentText: string): string | undefined {
  try {
    const doc = parseYamlText(documentText) as { deliverable?: { input_format?: { sample?: unknown } } } | null;
    const sample = doc?.deliverable?.input_format?.sample;
    return typeof sample === 'string' && sample.trim().length > 0 ? sample.replace(/\n+$/, '') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `deliverable.timeoutMs` the document declares — the bound on ONE invocation of the deliverable
 * (ADR-046) — or undefined when it declares none (the caller applies `DEFAULT_RUN_TIMEOUT_MS`). A
 * declared value below the floor is ignored here and refused by the front door, so this reader never
 * invents a bound: it returns what the document actually says, or nothing.
 */
export function readDeliverableRunTimeoutMs(documentText: string): number | undefined {
  try {
    const doc = parseYamlText(documentText) as { deliverable?: { timeoutMs?: unknown } } | null;
    const value = doc?.deliverable?.timeoutMs;
    return typeof value === 'number' && Number.isFinite(value) && value >= MIN_RUN_TIMEOUT_MS ? value : undefined;
  } catch {
    return undefined;
  }
}

export interface RenderCiConfigInput {
  dialect: CiDialect;
  /** The command that runs the DELIVERED project's own tests. Required by the caller. */
  testCommand: string;
  /** `deliverable.run` from the requirement document, when it declares one. */
  runCommand?: string;
  /** `deliverable.input_format.sample`, when the document declares one. */
  sampleCsv?: string;
  /**
   * `deliverable.timeoutMs` (ADR-046): the bound on the `deliverable` job's command. When absent the
   * generated job still gets a bound — `DEFAULT_RUN_TIMEOUT_MS` — because a start-and-serve command never
   * exits and an unbounded job would wait out the host's own limit.
   */
  deliverableTimeoutMs?: number;
  /** The confirmed requirement document ref, recorded in the file's header for a human reading it. */
  requirementRef?: string;
}

/**
 * The shell script a generated job runs, with `set -o pipefail` in front of the command.
 *
 * WHY THIS EXISTS, AND WHY IT IS UNCONDITIONAL. GitHub Actions runs a `run:` block with `bash -e`,
 * which does NOT set `pipefail`: the exit status of a pipeline is the LAST command's. The generated
 * test command is a discovery snippet whose every branch ends in `| tail -60` (the tail exists so the
 * log stays readable), so a FAILING delivered suite exited 0 and the job read GREEN — a false green in
 * CI, the worst kind of defect this project can ship (docs/bugs-fixed.md #49). `set -o pipefail` makes
 * the pipeline fail when ANY part of it fails, while KEEPING the tail. It is harmless for a command
 * with no pipe, so it is emitted for every job and every dialect rather than sniffed for: a guard that
 * depends on recognising the shape would go blind the day the shape changed, which is the same defect
 * one level up. The deliverable job gets it too, for the identical reason.
 */
export function renderCiJobScript(command: string): string {
  return ['set -o pipefail', ...command.split('\n')].join('\n');
}

/** Single-quote a value for a POSIX shell, escaping any single quote it contains. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** The seconds a declared millisecond bound means, never below one. */
export function runTimeoutSeconds(timeoutMs: number | undefined): number {
  return Math.max(1, Math.ceil((timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS) / 1000));
}

/**
 * The shell script the generated `deliverable` job runs: the declared run command, BOUNDED (ADR-046).
 *
 * WHY THIS IS NOT `renderCiJobScript`. The `deliverable` job runs `deliverable.run`, and for a SERVICE
 * that command STARTS the thing and never exits — so a `run:` block that just invoked it would sit in
 * the runner until the host's own job limit (GitHub's default is six hours) and then report a timeout
 * for the wrong reason, with the command nowhere in the message. Here the command runs under `timeout`,
 * and when the bound is hit the job prints the command by name and exits 124: a bounded FAILURE that
 * names what hung, never a pass and never a six-hour wait. The `|| { … }` keeps the message reachable
 * under `bash -e` (the shell GitHub uses), where a bare failing command would abort before it printed.
 */
export function renderBoundedCiJobScript(command: string, timeoutSeconds: number): string {
  const message = `the deliverable command did not exit within ${timeoutSeconds}s and was killed, so this job fails instead of waiting out the runner's own limit: ${command}`;
  return [
    'set -o pipefail',
    `timeout ${timeoutSeconds}s bash -c ${shellSingleQuote(command)} || {`,
    '  rc=$?',
    '  if [ "$rc" = 124 ]; then',
    `    echo ${shellSingleQuote(message)} >&2`,
    '  fi',
    '  exit "$rc"',
    '}',
  ].join('\n');
}

/**
 * Render the pipeline YAML. It runs the DELIVERED project's own tests — not takumi's — and, when the
 * document declares a `deliverable.run`, a second job that runs the deliverable against the sample the
 * document itself declares. `{csv}` in the run command resolves to that sample file.
 */
export function renderCiConfig(input: RenderCiConfigInput): string {
  const { dialect, testCommand, runCommand, sampleCsv, requirementRef } = input;
  if (dialect === 'gitlab') return renderGitlabCiConfig(input);
  const lines: string[] = [
    '# Generated by takumi ci_config (ADR-037). This file is the DELIVERY\'S own pipeline: it runs the',
    "# delivered project's OWN tests, not takumi's, so a green pipeline is evidence about THIS delivery.",
    '# A repair round may rewrite it; a human reads it in the delivery.',
    `# dialect: ${dialect} (${ciConfigPath(dialect)})`,
  ];
  if (requirementRef !== undefined && requirementRef.length > 0) lines.push(`# requirement: ${requirementRef}`);
  lines.push(
    'name: ci',
    'on:',
    '  push:',
    '  pull_request:',
    'jobs:',
    '  tests:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    "      - name: run the delivered project's own tests",
    '        run: |',
  );
  for (const line of renderCiJobScript(testCommand).split('\n')) lines.push(`          ${line}`);

  if (runCommand !== undefined && runCommand.length > 0) {
    lines.push(
      '  deliverable:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
    );
    if (sampleCsv !== undefined && sampleCsv.length > 0) {
      lines.push('      - name: write the sample input the requirement document declares', '        run: |');
      lines.push("          cat > takumi-sample.csv <<'TAKUMI_SAMPLE'");
      for (const line of sampleCsv.split('\n')) lines.push(`          ${line}`);
      lines.push('          TAKUMI_SAMPLE');
    }
    const runLine = sampleCsv !== undefined && sampleCsv.length > 0 ? runCommand.replace(/\{csv\}/g, 'takumi-sample.csv') : runCommand;
    lines.push('      - name: run the deliverable as the requirement document declares', '        run: |');
    for (const line of renderBoundedCiJobScript(runLine, runTimeoutSeconds(input.deliverableTimeoutMs)).split('\n')) lines.push(`          ${line}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Render GitLab CI YAML (`.gitlab-ci.yml`).
 *
 * GitLab CI is a DIFFERENT language from GitHub Actions, so this is a second renderer, not a second
 * path: the same two facts drive it — the DELIVERED project's own test command, and the requirement
 * document's `deliverable.run` run against the sample the document declares. A `tests` job is always
 * written (the caller refuses when there is no test command); a `deliverable` job is added only when
 * the document declares a run, with `{csv}` resolved to the sample file.
 */
export function renderGitlabCiConfig(input: RenderCiConfigInput): string {
  const { testCommand, runCommand, sampleCsv, requirementRef } = input;
  const lines: string[] = [
    "# Generated by takumi ci_config (ADR-037). This file is the DELIVERY'S own pipeline: it runs the",
    "# delivered project's OWN tests, not takumi's, so a green pipeline is evidence about THIS delivery.",
    '# A repair round may rewrite it; a human reads it in the delivery.',
    `# dialect: gitlab (${ciConfigPath('gitlab')})`,
  ];
  if (requirementRef !== undefined && requirementRef.length > 0) lines.push(`# requirement: ${requirementRef}`);
  const hasDeliverable = runCommand !== undefined && runCommand.length > 0;
  lines.push('stages:', '  - test');
  if (hasDeliverable) lines.push('  - deliverable');
  lines.push(
    '',
    'tests:',
    '  stage: test',
    "  # the DELIVERED project's own tests, not takumi's",
    '  script:',
    '    - |',
  );
  for (const line of renderCiJobScript(testCommand).split('\n')) lines.push(`      ${line}`);

  if (hasDeliverable) {
    lines.push('', 'deliverable:', '  stage: deliverable', '  script:', '    - |');
    if (sampleCsv !== undefined && sampleCsv.length > 0) {
      lines.push("      cat > takumi-sample.csv <<'TAKUMI_SAMPLE'");
      for (const line of sampleCsv.split('\n')) lines.push(`      ${line}`);
      lines.push('      TAKUMI_SAMPLE');
    }
    const runLine = sampleCsv !== undefined && sampleCsv.length > 0 ? runCommand.replace(/\{csv\}/g, 'takumi-sample.csv') : runCommand;
    for (const line of renderBoundedCiJobScript(runLine, runTimeoutSeconds(input.deliverableTimeoutMs)).split('\n')) lines.push(`      ${line}`);
  }
  return `${lines.join('\n')}\n`;
}

export interface CiConfigStepContext {
  stepId: string;
  runId: string;
  /** The project directory — where the requirement document lives (the acceptance step reads it here too). */
  projectDir: string;
  /** The delivery worktree the pipeline file is written into. */
  worktree: string;
  /** The command that runs the delivered project's own tests. Required: refused when absent. */
  testCommand?: string;
  /**
   * The dialect to write, when the step declares one — an explicit declaration WINS over the delivery
   * provider. `forgejo` (also Gitea) and `github` are both GitHub-Actions YAML (only the path differs);
   * `gitlab` is GitLab CI YAML, a different language. When the step declares none, the dialect is
   * DERIVED from `deliveryProviderId`; failing that, `forgejo` is the default.
   */
  dialect?: string;
  /**
   * The delivery provider's host id (`metadata().id`). Consulted ONLY when the step declares no
   * `dialect`: the dialect is then DERIVED from the provider, so a run whose `delivery:` section names
   * `provider: github` writes `.github/workflows/ci.yml` rather than a file its host never runs
   * (docs/bugs-fixed.md #48). A provider id that is not a dialect derives nothing, and the default stands.
   */
  deliveryProviderId?: string;
  /** The confirmed requirement document, relative to `projectDir`. */
  requirementRef?: string;
  /** When present, the generated file is also recorded as a run artifact a human can read. */
  artifacts?: ArtifactStore;
  trace?: string[];
}

export interface CiConfigStepResult {
  status: 'completed' | 'failed';
  summary: string;
  /** Paths written into the worktree, relative to it. */
  files: string[];
  /** Artifact-store paths, when an artifact store was supplied. */
  artifacts: string[];
}

/**
 * Write the host's pipeline configuration into the delivery worktree.
 *
 * Refused (fails closed) when the step declares no test command: a pipeline file that runs no tests would
 * run nothing and still report green, which is the decoration this step exists to avoid. The generated
 * file is a real file in the worktree — a human can read it and a repair round can fix it — and the
 * summary says out loud that the delivery now CONTAINS the pipeline that will judge it, plus the
 * protected-path consequence (ADR-032).
 */
export async function executeCiConfigStep(input: CiConfigStepContext): Promise<CiConfigStepResult> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const testCommand = (input.testCommand ?? '').trim();
  if (testCommand.length === 0) {
    return {
      status: 'failed',
      summary:
        'ci_config FAILED: the workflow declares no testCommand, so the pipeline would run nothing and still report green: refusing to write a CI file that judges nothing (a pipeline that runs no tests is decoration)',
      files: [],
      artifacts: [],
    };
  }
  // The dialect: an explicit declaration WINS; otherwise it is DERIVED from the delivery provider, so a
  // run against a GitHub host writes the file GitHub actually runs (docs/bugs-fixed.md #48); and failing
  // both, the historical `forgejo` default stands. The ORIGIN is carried into the summary, so a transcript
  // says WHY this path was chosen rather than only which one — the derivation is invisible otherwise.
  const declaredDialect = isCiDialect(input.dialect) ? input.dialect : undefined;
  const derivedDialect = declaredDialect === undefined ? dialectForDeliveryProvider(input.deliveryProviderId) : undefined;
  const dialect: CiDialect = declaredDialect ?? derivedDialect ?? 'forgejo';
  const dialectOrigin =
    declaredDialect !== undefined
      ? 'declared by the step'
      : derivedDialect !== undefined
        ? `derived from the delivery provider "${input.deliveryProviderId}"`
        : 'the default: the step declares no dialect and the delivery provider names no host takumi writes a pipeline for';
  const relPath = ciConfigPath(dialect);

  // The document the pipeline is derived from. When one is named it must be readable: a pipeline that
  // claims to be derived from a document nobody could read is a pipeline derived from nothing.
  const requirementRef = (input.requirementRef ?? '').trim();
  let documentText: string | undefined;
  if (requirementRef.length > 0) {
    try {
      documentText = await fs.readFile(path.join(input.projectDir, requirementRef), 'utf8');
    } catch (e) {
      return {
        status: 'failed',
        summary: `ci_config FAILED: the requirement document "${requirementRef}" could not be read (${e instanceof Error ? e.message : String(e)}), so the pipeline cannot be derived from what it declares`,
        files: [],
        artifacts: [],
      };
    }
  }
  const runCommand = documentText === undefined ? undefined : readDeliverableRun(documentText);
  const sampleCsv = documentText === undefined ? undefined : readDeliverableSample(documentText);
  // ADR-046: the bound on the deliverable job's command. A start-and-serve `run` never exits, so the job
  // is always bounded — by the document's own `deliverable.timeoutMs` when it declares one, and by the
  // default otherwise. A declared value below the floor is ignored here and refused by the front door.
  const deliverableTimeoutMs = documentText === undefined ? undefined : readDeliverableRunTimeoutMs(documentText);

  const content = renderCiConfig({
    dialect,
    testCommand,
    ...(runCommand === undefined ? {} : { runCommand }),
    ...(sampleCsv === undefined ? {} : { sampleCsv }),
    ...(deliverableTimeoutMs === undefined ? {} : { deliverableTimeoutMs }),
    ...(requirementRef.length === 0 ? {} : { requirementRef }),
  });
  const absPath = path.join(input.worktree, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, 'utf8');

  const runLine =
    runCommand === undefined
      ? `deliverable run: (${requirementRef.length === 0 ? 'no requirement document was named' : 'the document declares no deliverable.run'})`
      : `deliverable run (declared by ${requirementRef}): ${runCommand}`;
  // ADR-046: the deliverable job is BOUNDED. A start-and-serve `run` never exits, so an unbounded job
  // would wait out the host's own limit; the bound is recorded here so a transcript says which one applied.
  const boundLine =
    runCommand === undefined
      ? undefined
      : `deliverable bound: ${runTimeoutSeconds(deliverableTimeoutMs)}s (${deliverableTimeoutMs === undefined ? 'the default' : `declared by ${requirementRef}`}), so a command that never exits fails the job naming itself instead of waiting out the runner`;
  const summary = [
    `ci_config: wrote ${relPath} (${dialect} dialect, ${dialectOrigin}) into the delivery worktree at ${input.worktree}`,
    "the delivery now CONTAINS the pipeline that will judge it: the host runs this file against the delivered head, and it runs the DELIVERED project's own tests, not takumi's",
    `test command: ${testCommand}`,
    runLine,
    ...(boundLine === undefined ? [] : [boundLine]),
    `protected path: CI configuration is a protected path (packages/core/src/review-rules.ts); created by this delivery it is reported by the deterministic reviewer as a note inside the delivery (ADR-032), never silently waved through`,
  ].join('\n');

  const artifactPaths: string[] = [];
  if (input.artifacts !== undefined) {
    try {
      const artifact = await input.artifacts.write({
        taskId: `${input.runId}:${input.stepId}`,
        kind: 'ci_config',
        fileName: `${input.stepId}.md`,
        content: `# ${input.stepId} (ci_config)\n\n${summary}\n\n## ${relPath}\n\n\`\`\`yaml\n${content}\`\`\`\n`,
        contentType: 'text/markdown',
        trace: input.trace ?? [],
      });
      artifactPaths.push(artifact.path);
    } catch {
      // The file is already in the worktree — the artifact is a convenience, and failing the step over it
      // would fail a delivery for a store problem. The summary still reports what was written where.
    }
  }
  return { status: 'completed', summary, files: [relPath], artifacts: artifactPaths };
}

export interface AwaitChecksStepContext {
  stepId: string;
  /** The delivery provider. Absent means the run cannot read any pipeline result — a FAILURE. */
  delivery?: DeliveryProvider;
  /** The delivered head to poll (a pull request, or a pushed branch when the host has no review surface). */
  ref?: PullRequestRef;
  /** How long to wait, in seconds. Default 300, hard ceiling 1800. */
  waitSeconds?: number;
  /** Poll interval, in seconds. Default 15, never longer than the remaining budget. */
  pollSeconds?: number;
  onEvent?: (message: string) => void;
  /** Injectable sleep, so a test need not wait in real time. Defaults to a real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock. Defaults to Date.now. */
  now?: () => number;
}

export interface AwaitChecksStepResult {
  status: 'completed' | 'failed';
  summary: string;
  waitedSeconds: number;
  checks: CheckSummary[];
}

const AWAIT_CHECKS_DEFAULT_SECONDS = 300;
const AWAIT_CHECKS_CEILING_SECONDS = 1800;
const AWAIT_CHECKS_POLL_SECONDS = 15;

/** One check as a line a human can act on: its name, and its URL when the host gave one. */
function describeCheck(check: CheckSummary): string {
  return check.url !== undefined && check.url.length > 0 ? `${check.name} (${check.url})` : check.name;
}

function refLabel(ref: PullRequestRef | undefined): string {
  if (ref === undefined) return 'the delivered head';
  if (ref.url.length > 0) return ref.url;
  return ref.number.length > 0 ? ref.number : 'the delivered head';
}

/**
 * Wait for the host's pipeline result on the delivered head, and fail CLOSED when it is not green.
 *
 * `success` for EVERY check is the only pass. A `failure` fails immediately, naming the failing checks and
 * their URLs; checks still `pending` when the budget runs out fail, naming what is still pending; and a
 * host that cannot report checks at all (no provider, no `canRunChecks` capability, a `checks()` that
 * throws, or a host that reports nothing) fails with that said plainly. There is no path here that reports
 * a green pipeline the step did not actually read.
 */
export async function executeAwaitChecksStep(input: AwaitChecksStepContext): Promise<AwaitChecksStepResult> {
  const stepId = input.stepId;
  const fail = (summary: string, checks: CheckSummary[] = [], waitedSeconds = 0): AwaitChecksStepResult => ({
    status: 'failed',
    summary: `await_checks FAILED: ${summary}`,
    waitedSeconds,
    checks,
  });

  const delivery = input.delivery;
  if (delivery === undefined) {
    return fail('the run has no delivery provider (ctx.delivery), so the pipeline result cannot be read: a pipeline nobody could read is not a green pipeline');
  }
  if (input.ref === undefined) {
    return fail('no delivered head to poll (no ref and no delivery worktree to derive one from), so the pipeline result cannot be read');
  }
  let caps: { canRunChecks?: boolean };
  try {
    caps = delivery.capabilities();
  } catch (e) {
    return fail(`the host could not even report its capabilities (${e instanceof Error ? e.message : String(e)}), so the pipeline result cannot be read`);
  }
  if (caps.canRunChecks !== true) {
    return fail('the host cannot report checks (capabilities.canRunChecks is false), so the pipeline result cannot be read: refusing to report a green pipeline that was never read');
  }

  const waitSeconds = Number.isInteger(input.waitSeconds)
    ? Math.min(Math.max(input.waitSeconds as number, 1), AWAIT_CHECKS_CEILING_SECONDS)
    : AWAIT_CHECKS_DEFAULT_SECONDS;
  const pollSeconds = Math.min(
    Number.isInteger(input.pollSeconds) ? Math.max(input.pollSeconds as number, 1) : AWAIT_CHECKS_POLL_SECONDS,
    Math.max(waitSeconds, 1),
  );
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + waitSeconds * 1000;
  const label = refLabel(input.ref);
  let waitedSeconds = 0;

  for (;;) {
    let checks: CheckSummary[];
    try {
      checks = await delivery.checks(input.ref);
    } catch (e) {
      return fail(`the host could not report checks for ${label} (${e instanceof Error ? e.message : String(e)})`, [], waitedSeconds);
    }
    if (!Array.isArray(checks)) {
      return fail(`the host reported checks for ${label} in a shape that is not a list, so the pipeline result cannot be read`, [], waitedSeconds);
    }
    if (checks.length === 0) {
      return fail(`the host reported NO checks for ${label}: there is no pipeline result to wait for, and "no checks" is not a pass`, [], waitedSeconds);
    }

    const failed = checks.filter((c) => c.conclusion === 'failure');
    if (failed.length > 0) {
      return fail(
        `${failed.length} check(s) FAILED on ${label}: ${failed.map(describeCheck).join(', ')}`,
        checks,
        waitedSeconds,
      );
    }

    const pending = checks.filter((c) => c.conclusion === 'pending');
    if (pending.length > 0) {
      const remainingMs = deadline - now();
      if (remainingMs <= 0) {
        return fail(
          `the pipeline was still PENDING after ${waitSeconds}s on ${label}: pending checks — ${pending.map(describeCheck).join(', ')}`,
          checks,
          waitedSeconds,
        );
      }
      const sleepMs = Math.min(pollSeconds * 1000, remainingMs);
      input.onEvent?.(`waiting for ${pending.length} pending check(s) on ${label} (${Math.ceil(sleepMs / 1000)}s)`);
      await sleep(sleepMs);
      waitedSeconds += Math.ceil(sleepMs / 1000);
      continue;
    }

    // Not failing, not pending: the only remaining acceptable state is success for every check.
    const notSuccess = checks.filter((c) => c.conclusion !== 'success');
    if (notSuccess.length > 0) {
      return fail(
        `${notSuccess.length} check(s) on ${label} are neither success nor pending: ${notSuccess.map(describeCheck).join(', ')} — "success" is the only conclusion that passes`,
        checks,
        waitedSeconds,
      );
    }

    return {
      status: 'completed',
      summary: `await_checks: all ${checks.length} check(s) succeeded on ${label} after ${waitedSeconds}s: ${checks.map(describeCheck).join(', ')}`,
      waitedSeconds,
      checks,
    };
  }
}
