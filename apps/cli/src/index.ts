#!/usr/bin/env node
import { listExtensions, loadConfig, runTask, workflowExitCode } from './commands.js';
import { runRequirementCommand } from './requirement-command.js';
import { initProject } from './init.js';
import { createBoardProvider, runBoardCommand } from './board-command.js';
import { runRunsCommand } from './runs-command.js';
import { eventLogFor, runOnce, type PilotConfig } from './run-command.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DeliveryProvider, TaskBoardProvider } from '@takumi/core';

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const cwd = process.cwd();

  switch (cmd) {
    case 'init': {
      const created = initProject(cwd);
      if (created.length === 0) {
        console.log('Takumi project already initialized.');
      } else {
        console.log('Initialized Takumi project:');
        for (const p of created) console.log(`  ✓ ${p}`);
      }
      return 0;
    }

    case 'runtime': {
      const sub = rest[0];
      if (sub === 'list') {
        const config = loadConfig(cwd);
        console.log(`default runtime: ${config.runtime}`);
        console.log('available runtimes:');
        console.log('  fake   Deterministic in-process runtime');
        console.log('  pi     Real Pi agent (opt-in; needs Pi SDK installed)');
        console.log('  cli:<cmd>  Bridge any external harness CLI (harness-agnostic)');
        return 0;
      }
      console.log('usage: takumi runtime list');
      return 1;
    }

    case 'extension': {
      const sub = rest[0];
      if (sub === 'list') {
        const config = loadConfig(cwd);
        const entries = await listExtensions(config, cwd);
        if (entries.length === 0) {
          console.log('No extensions found in registry.');
          return 0;
        }
        for (const e of entries) {
          console.log(`${e.kind.padEnd(8)} ${e.name.padEnd(24)} ${e.version.padEnd(8)} ${e.description}`);
        }
        return 0;
      }
      console.log('usage: takumi extension list');
      return 1;
    }

    case 'requirement': {
      return await runRequirementCommand(cwd, rest);
    }

    case 'board': {
      return await runBoardCommand(rest);
    }

    case 'runs': {
      return runRunsCommand(cwd, rest);
    }

    case 'pilot': {
      return await runPilotCommand(cwd, rest);
    }

    case 'run': {
      const positional: string[] = [];
      let runtimeId = 'fake';
      let workflow: string | undefined;
      let verbose = false;
      let sandbox: 'none' | 'unshare' | undefined;
      let resume = false;
      let requirement: string | undefined;
      let confirmedRequirement: string | undefined;
      let worktree: string | undefined;

      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i] ?? '';
        if (arg === '--runtime') {
          runtimeId = rest[++i] ?? 'fake';
        } else if (arg === '--workflow') {
          workflow = rest[++i];
        } else if (arg === '--verbose' || arg === '-v') {
          verbose = true;
        } else if (arg === '--sandbox') {
          sandbox = (rest[++i] as 'none' | 'unshare') ?? 'none';
        } else if (arg === '--resume') {
          resume = true;
        } else if (arg === '--requirement') {
          requirement = rest[++i];
        } else if (arg === '--confirmed-requirement') {
          confirmedRequirement = rest[++i];
        } else if (arg === '--worktree') {
          worktree = rest[++i];
        } else if (arg.startsWith('--runtime=')) {
          runtimeId = arg.slice('--runtime='.length);
        } else if (arg.startsWith('--workflow=')) {
          workflow = arg.slice('--workflow='.length);
        } else if (arg.startsWith('--sandbox=')) {
          sandbox = arg.slice('--sandbox='.length) as 'none' | 'unshare';
        } else if (arg.startsWith('--requirement=')) {
          requirement = arg.slice('--requirement='.length);
        } else if (arg.startsWith('--confirmed-requirement=')) {
          confirmedRequirement = arg.slice('--confirmed-requirement='.length);
        } else if (arg.startsWith('--worktree=')) {
          worktree = arg.slice('--worktree='.length);
        } else {
          positional.push(arg);
        }
      }

      const config = loadConfig(cwd);
      const promptArg = positional.join(' ');

      // ADR-025: a workflow that runs an `acceptance` step needs the digest a human confirmed, and
      // that digest is the token of the confirmation. The CLI therefore asks for it explicitly
      // instead of assuming the file it finds is the one that was approved — the whole point of the
      // binding is that an edit between confirmation and run is caught by name.
      let confirmation: { ref: string; digest: string } | undefined;
      if (requirement !== undefined || confirmedRequirement !== undefined) {
        if (requirement === undefined || confirmedRequirement === undefined) {
          console.error(
            '--requirement and --confirmed-requirement go together: run `takumi requirement digest <ref>` to get the digest a human confirmed, then pass both',
          );
          return 1;
        }
        confirmation = { ref: requirement, digest: confirmedRequirement.trim().replace(/^sha256:/i, '').toLowerCase() };
      }

      // Support: takumi run "prompt" | takumi run requirements.md (read file)
      let prompt = promptArg;
      if (promptArg && !promptArg.includes(' ') && (promptArg.endsWith('.md') || promptArg.endsWith('.txt'))) {
        const { readFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        prompt = readFileSync(join(cwd, promptArg), 'utf8');
      }

      if (runtimeId === 'pi') {
        console.log(`Using runtime: ${runtimeId} (real Pi AgentSession)`);
      }

      console.log(`⚙ Takumi run (runtime=${runtimeId}${workflow ? `, workflow=${workflow}` : ''})`);
      console.log(`  prompt: ${prompt.slice(0, 120)}${prompt.length > 120 ? '…' : ''}`);
      console.log('');

      const { events, summary, traceabilityMatrix, artifacts, status } = await runTask({ cwd, prompt, runtimeId, workflow, config, verbose, sandbox, resume, confirmedRequirement: confirmation, worktree });

      for (const ev of events) console.log(`  ${ev}`);
      console.log('');
      console.log(`✓ ${summary}`);

      if (traceabilityMatrix) {
        console.log('');
        console.log('Traceability Matrix:');
        console.log(traceabilityMatrix);
      }

      // Artifacts produced during this run.
      console.log('');
      if (artifacts.length > 0) {
        console.log('Artifacts:');
        for (const a of artifacts) console.log(`  • ${a}`);
      } else {
        console.log('Artifacts:');
        console.log('  (none produced in this run)');
      }
      // A failed (or cancelled) workflow is not a success: the exit code is the
      // only thing a CI job can read. The plain path has no status and stays 0.
      return workflowExitCode(status);
    }

    case 'loop': {
      const positional: string[] = [];
      let runtimeId = 'fake';
      let maxRounds = 5;
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i] ?? '';
        if (arg === '--runtime') runtimeId = rest[++i] ?? 'fake';
        else if (arg === '--max-rounds') maxRounds = Number(rest[++i] ?? 5);
        else if (arg.startsWith('--runtime=')) runtimeId = arg.slice('--runtime='.length);
        else if (arg.startsWith('--max-rounds=')) maxRounds = Number(arg.slice('--max-rounds='.length));
        else positional.push(arg);
      }
      const task = positional.join(' ') || 'Complete the task described in the workspace';
      const { runLoop } = await import('./loop-command.js');
      return await runLoop({ cwd, task, runtimeId, maxRounds });
    }

    case 'help':
    case undefined:
    case '--help':
    case '-h':
      console.log(`
Takumi — Open-source Agentic Software Engineering Platform

Usage:
  takumi init                          Initialize a Takumi project
  takumi run "<prompt>"                Run an agent task
  takumi run requirements.md [--runtime fake] [--workflow jp-si-standard]
                                       A workflow with a 'publish' step publishes through the
                                       'delivery:' section of takumi.yaml
                                       (e.g. delivery: { provider: forgejo, repo: owner/name });
                                       with no such section the run is refused BEFORE it starts.
                                       With one, the run creates its OWN worktree by cloning
                                       that repo and branching from its base
  takumi run "<prompt>" --worktree <path>
                                       Run in an EXISTING checkout instead (advanced). takumi
                                       refuses BEFORE the run unless it is a git repository, on
                                       a branch (not a detached HEAD), clean, and descended
                                       from <remote>/<baseBranch>
  takumi runtime list                  List available runtimes
  takumi board [--provider github --repo owner/name]
                                       Read-only view of a task board (ADR-006)
  takumi board --check | --bootstrap    Report or create the board's states (ADR-008)
  takumi runs [--dir <path>] [--json]   Aggregate the run records in .takumi/runs/: run count,
                                       success rate, median/worst duration, the most-failing step,
                                       and the total cost the runtimes reported
  takumi pilot --once                  One tick of the unattended runner (ADR-009)
  takumi extension list                List discovered extensions
  takumi requirement digest <ref>      Print the confirmation token for a requirement document
  takumi requirement confirm <ref>     Decide its open questions as bounded choices, and print the token
  takumi requirement confirm <ref> --dry-run
  takumi requirement feedback <ref>    List the acceptance failures written back into the document
  takumi requirement brief <ref>       What each failure is about, and the answers it could take instead
  takumi requirement resolve <ref> --id FB-001 --note "…"
                                       Record what addresses an open failure (exits 1 while one is open)
                                       Show what is still undecided (read-only; exits 1 while a
                                       blocking decision has no default and no choice)

Examples:
  takumi run "Implement user authentication API"
  takumi run requirements.md --runtime fake --workflow jp-si-standard
  takumi requirement confirm docs/requirements/feature.yaml
  takumi requirement digest docs/requirements/feature.yaml
  takumi run docs/requirements/feature.yaml --workflow blackbox-acceptance \
    --requirement docs/requirements/feature.yaml --confirmed-requirement sha256:<digest>
`);
      return 0;

    default:
      console.error(`unknown command: ${cmd}`);
      console.error('run "takumi --help" for usage');
      return 1;
  }
}

/**
 * `takumi pilot --once` — one tick of the unattended runner (ADR-009).
 *
 * The command reads the `pilot:` section of `takumi.yaml` and refuses to run without
 * it: everything a tick needs (which repository, which board, which agent) is a
 * deployment decision, and guessing one is how an agent ends up committing to the
 * wrong checkout.
 */
export async function runPilotCommand(cwd: string, rest: string[]): Promise<number> {
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(
      [
        'usage: takumi pilot --once [--json] [--resync]',
        '',
        '  Runs ONE tick: pick a ready item, lock it, prepare a worktree, run the',
        '  configured agent, then deliver and review it. Exits 1 only when a human',
        '  must act; every ordinary outcome (idle, busy, delivered, awaiting review,',
        '  retriable) exits 0 so a scheduler journal stays quiet.',
        '',
        '  --resync: do NOT run a tick. Rebuild every configured board mirror (ADR-017)',
        '  from the primary — what makes a projection that drifted, or never existed, a',
        '  five-minute problem instead of a lost one.',
        '',
        '  Configuration lives in the `pilot:` section of takumi.yaml.',
        '  Schedule it with a systemd timer or cron — do not run it in a loop here.',
      ].join('\n'),
    );
    return 0;
  }
  const json = rest.includes('--json');
  const resync = rest.includes('--resync');
  const config = loadConfig(cwd);
  if (config.pilot === undefined) {
    console.error('takumi.yaml has no `pilot:` section — see docs/adr/009 (the pilot) for what it needs');
    return 1;
  }
  const p = config.pilot;
  const pilot: PilotConfig = {
    repo: p.repo,
    worktreeRoot: p.worktreeRoot,
    slotDir: p.slotDir,
    baseBranch: p.baseBranch,
    ...(p.remote === undefined ? {} : { remote: p.remote }),
    agent: p.agent,
    ...(p.reviewer === undefined ? {} : { reviewer: p.reviewer }),
    ...(p.semgrep === undefined ? {} : { semgrep: p.semgrep }),
    ...(p.reporter === undefined ? {} : { reporter: p.reporter }),
    ...(p.reviewdog === undefined ? {} : { reviewdog: p.reviewdog }),
    policy: {
      reviewMode: p.policy.reviewMode,
      // The rules travel with the mode: a `rules` mode whose rules never arrived would
      // silently review with the defaults, which is the "config with no reader" defect in
      // a new costume.
      ...(p.policy.reviewRules === undefined ? {} : { reviewRules: p.policy.reviewRules }),
      ...(p.policy.approvalLabel === undefined ? {} : { approvalLabel: p.policy.approvalLabel }),
      ...(p.policy.maxReviewRounds === undefined ? {} : { maxReviewRounds: p.policy.maxReviewRounds }),
      ...(p.policy.retainWorktreesHours === undefined ? {} : { retainWorktreesHours: p.policy.retainWorktreesHours }),
      ...(p.policy.agentRetries === undefined ? {} : { agentRetries: p.policy.agentRetries }),
      ...(p.policy.agentRetryDelaySeconds === undefined ? {} : { agentRetryDelaySeconds: p.policy.agentRetryDelaySeconds }),
      ...(p.policy.blockStaleClaims === undefined ? {} : { blockStaleClaims: p.policy.blockStaleClaims }),
      ...(p.policy.staleClaimSeconds === undefined ? {} : { staleClaimSeconds: p.policy.staleClaimSeconds }),
      ...(p.policy.checksWaitSeconds === undefined ? {} : { checksWaitSeconds: p.policy.checksWaitSeconds }),
      ...(p.policy.checksPollSeconds === undefined ? {} : { checksPollSeconds: p.policy.checksPollSeconds }),
      ...(p.policy.mergeabilityReads === undefined ? {} : { mergeabilityReads: p.policy.mergeabilityReads }),
      ...(p.policy.mergeabilityReadSeconds === undefined
        ? {}
        : { mergeabilityReadSeconds: p.policy.mergeabilityReadSeconds }),
      ...(p.policy.progressIntervalSeconds === undefined ? {} : { progressIntervalSeconds: p.policy.progressIntervalSeconds }),
      ...(p.policy.fileIssueOnExhaustedChecks === undefined ? {} : { fileIssueOnExhaustedChecks: p.policy.fileIssueOnExhaustedChecks }),
      ...(p.policy.scopeQuery === undefined ? {} : { scopeQuery: p.policy.scopeQuery }),
    },
    ...(p.eventsFile === undefined ? {} : { eventsFile: p.eventsFile }),
    ...(p.metricsFile === undefined ? {} : { metricsFile: p.metricsFile }),
    ...(p.metricsTextfile === undefined ? {} : { metricsTextfile: p.metricsTextfile }),
  };

  // The log is created FIRST: the mirrors below are constructed with it, so their writes and their
  // failures are events rather than whatever the mirror felt like doing (ADR-017 rule 2).
  const log = await eventLogFor(p.eventsFile);
  const { board: primary, delivery } = await createProviders(
    p.board,
    p.boardOptions ?? {},
    p.delivery,
    p.deliveryOptions ?? {},
  );

  // --- board mirrors (ADR-017): one authority, N write-only projections for the people looking ----
  const mirrorSpecs = p.boardMirrors ?? [];
  let board: TaskBoardProvider = primary;
  let saveMirrorMap: (() => void) | undefined;
  if (mirrorSpecs.length > 0) {
    const { MirroringBoard, readMirrorIdMap, writeMirrorIdMap } = await import('@takumi/core');
    const mirrors = [];
    for (const spec of mirrorSpecs) {
      // A mirror is built through the SAME provider factory `takumi board` uses, so a projection can
      // never be something the CLI cannot also express or check on its own.
      const mirrorBoard = await createBoardProvider({
        providerId: spec.provider,
        providerOptions: spec.options ?? {},
        json: false,
      });
      mirrors.push({
        id: spec.id,
        board: mirrorBoard,
        // Passed only when it was set: the default belongs to the decorator, so a config that says
        // nothing and a config that says `true` cannot drift apart here.
        ...(spec.labels === undefined ? {} : { labels: spec.labels }),
      });
    }
    const composite = new MirroringBoard(primary, mirrors, { events: log });
    const idMapPath =
      mirrorSpecs.find((spec) => spec.idMapFile !== undefined)?.idMapFile ?? join(p.slotDir, 'mirror-ids.json');
    // The id map is a CACHE: loading a damaged one costs API calls, never correctness.
    composite.loadIdMap(readMirrorIdMap(idMapPath));
    board = composite;
    saveMirrorMap = (): void => {
      try {
        writeMirrorIdMap(idMapPath, composite.idMap());
      } catch (error) {
        // A cache that cannot be written costs calls on the next tick. It must never cost THIS tick,
        // which has already happened (ADR-017 rule 2, one layer down).
        console.error(
          `mirror   the id map could not be saved (${error instanceof Error ? error.message : String(error)}): the projections are still correct, and the next tick re-finds them by marker`,
        );
      }
    };
    if (!json) {
      // What is projected WHERE, and what each mirror can represent — the check ADR-017 asks for.
      for (const entry of composite.mirrorsList()) {
        console.log(
          `mirror   ${entry.id}: canCreateWork=${entry.canCreateWork}, editableComment=${entry.editableComment}, ` +
            `labels=${entry.labels}`,
        );
      }
    }
    if (resync) {
      for (const result of await composite.resync()) {
        console.log(`resync   ${result.mirror}: projected ${result.projected}, failed ${result.failed}`);
      }
      saveMirrorMap();
      return 0;
    }
  } else if (resync) {
    console.error('`pilot --resync` needs `boardMirrors` in takumi.yaml: there is nothing to rebuild.');
    return 1;
  }

  const { tick, exitCode } = await runOnce({
    board,
    delivery,
    pilot,
    log,
    out: (line) => {
      if (!json) console.log(line);
    },
  });
  saveMirrorMap?.();
  if (json) console.log(JSON.stringify(tick, null, 2));
  return exitCode;
}

/** Build the board and delivery providers named in the config. */
async function createProviders(
  boardId: string,
  boardOptions: Record<string, string>,
  deliveryId: string,
  deliveryOptions: Record<string, string>,
): Promise<{ board: TaskBoardProvider; delivery: DeliveryProvider }> {
  const { createBoardProvider } = await import('./board-command.js');
  const board = await createBoardProvider({
    providerId: boardId,
    providerOptions: boardOptions,
    json: false,
  });

  if (deliveryId === 'fake') {
    const { FakeDeliveryProvider } = await import('@takumi/delivery-fake');
    return { board, delivery: new FakeDeliveryProvider({ baseSha: deliveryOptions['baseSha'] ?? 'a'.repeat(40), headSha: deliveryOptions['headSha'] }) };
  }
  if (deliveryId === 'github') {
    const { createGitHubDeliveryProvider } = await import('@takumi/delivery-github');
    // The token is resolved BEFORE the run starts (ADR-051): a run that reaches `publish` without one
    // has already paid for the implementation, the tests and the acceptance. `delivery.tokenEnv` names
    // the variable; the default is GITHUB_TOKEN.
    const { assertDeliveryToken } = await import('./delivery-command.js');
    const token = assertDeliveryToken(deliveryId, { providerId: deliveryId, providerOptions: deliveryOptions });
    return { board, delivery: createGitHubDeliveryProvider({ repo: deliveryOptions['repo'] ?? '', ...(token === undefined ? {} : { token }), ...(deliveryOptions['apiBase'] === undefined ? {} : { apiBase: deliveryOptions['apiBase'] }) }) };
  }
  if (deliveryId === 'git') {
    // A bare remote: the branch is pushed and READ BACK, and integration is a fast-forward of the
    // base branch. It needs a checkout of the same remote (for the calls that outlive one
    // worktree) and the base branch a merge would move — both from the delivery options.
    const { createGitDeliveryProvider } = await import('@takumi/delivery-git');
    return {
      board,
      delivery: createGitDeliveryProvider({
        repo: deliveryOptions['repo'] ?? '',
        baseBranch: deliveryOptions['baseBranch'] ?? 'main',
        ...(deliveryOptions['remote'] === undefined ? {} : { remote: deliveryOptions['remote'] }),
      }),
    };
  }

  if (deliveryId === 'gitlab') {
    const { createGitLabDeliveryProvider } = await import('@takumi/delivery-gitlab');
    // Same as GitHub: the token is resolved before the run starts (ADR-051).
    const { assertDeliveryToken } = await import('./delivery-command.js');
    const token = assertDeliveryToken(deliveryId, { providerId: deliveryId, providerOptions: deliveryOptions });
    return { board, delivery: createGitLabDeliveryProvider({ project: deliveryOptions['project'] ?? '', ...(token === undefined ? {} : { token }), ...(deliveryOptions['apiBase'] === undefined ? {} : { apiBase: deliveryOptions['apiBase'] }) }) };
  }
  throw new Error(`unknown delivery provider: ${deliveryId} (fake | github | gitlab)`);
}

/**
 * Run the command only when this file IS the entry point.
 *
 * A test that imports this module (`apps/cli/src/test/run.test.ts` imports `runPilotCommand`) must not
 * start a command — and, now that a finished command EXITS (see `exitWhenFlushed`), it must certainly
 * not terminate the importer: before this guard, adding the explicit exit silently cut 16 tests off the
 * end of the suite (1022 → 1006), which is exactly the kind of quiet loss this repository treats as a
 * defect rather than a footnote.
 */
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  holdEventLoopForTest();
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      void exitWhenFlushed(code);
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
      void exitWhenFlushed(1);
    },
  );
}

/**
 * TEST SEAM: hold the event loop open for this many milliseconds — the way a library that forgot to
 * release a socket does. It exists so the exit contract can be tested against a process that WOULD
 * hang, on a machine with no API key: the real instance was the pi adapter's session pool (ADR-054),
 * reproducible only with a live model.
 *
 * Deliberately NOT `unref()`'d: the leak is the point.
 */
function holdEventLoopForTest(): void {
  const raw = Number(process.env['TAKUMI_TEST_HOLD_ALIVE_MS'] ?? '');
  if (Number.isFinite(raw) && raw > 0) setTimeout(() => {}, raw);
}

/**
 * FINISH: hand stdio to the OS, then EXIT.
 *
 * A command-line program ends when its command ends. Leaving the exit to "the event loop drained"
 * makes a finished run depend on EVERY library releasing EVERY socket — which is how a run that had
 * written its record and printed its summary stayed alive for minutes afterwards (ADR-054 measured it:
 * workflow done at 01:23:10Z, process alive at 01:25:30Z). A supervisor sequences unattended runs by
 * waiting for that exit, so the exit is this program's contract, not a side effect of other people's
 * cleanup. Stdio is flushed first so a piped or redirected run loses none of its output.
 */
async function exitWhenFlushed(code: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let pending = 2;
    const done = (): void => {
      pending -= 1;
      if (pending === 0) resolve();
    };
    process.stdout.write('', done);
    process.stderr.write('', done);
  });
  process.exit(code);
}