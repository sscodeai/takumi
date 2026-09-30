#!/usr/bin/env node
import { listExtensions, loadConfig, runTask } from './commands.js';
import { initProject } from './init.js';
import { runBoardCommand } from './board-command.js';
import { eventLogFor, runOnce, type PilotConfig } from './run-command.js';
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

    case 'board': {
      return await runBoardCommand(rest);
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
        } else if (arg.startsWith('--runtime=')) {
          runtimeId = arg.slice('--runtime='.length);
        } else if (arg.startsWith('--workflow=')) {
          workflow = arg.slice('--workflow='.length);
        } else if (arg.startsWith('--sandbox=')) {
          sandbox = arg.slice('--sandbox='.length) as 'none' | 'unshare';
        } else {
          positional.push(arg);
        }
      }

      const config = loadConfig(cwd);
      const promptArg = positional.join(' ');

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

      const { events, summary, traceabilityMatrix, artifacts } = await runTask({ cwd, prompt, runtimeId, workflow, config, verbose, sandbox, resume });

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
      return 0;
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
  takumi runtime list                  List available runtimes
  takumi board [--provider github --repo owner/name]
                                       Read-only view of a task board (ADR-006)
  takumi board --check | --bootstrap    Report or create the board's states (ADR-008)
  takumi pilot --once                  One tick of the unattended runner (ADR-009)
  takumi extension list                List discovered extensions

Examples:
  takumi run "Implement user authentication API"
  takumi run requirements.md --runtime fake --workflow jp-si-standard
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
        'usage: takumi pilot --once [--json]',
        '',
        '  Runs ONE tick: pick a ready item, lock it, prepare a worktree, run the',
        '  configured agent, then deliver and review it. Exits 1 only when a human',
        '  must act; every ordinary outcome (idle, busy, delivered, awaiting review,',
        '  retriable) exits 0 so a scheduler journal stays quiet.',
        '',
        '  Configuration lives in the `pilot:` section of takumi.yaml.',
        '  Schedule it with a systemd timer or cron — do not run it in a loop here.',
      ].join('\n'),
    );
    return 0;
  }
  const json = rest.includes('--json');
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

  const { board, delivery } = await createProviders(p.board, p.boardOptions ?? {}, p.delivery, p.deliveryOptions ?? {});
  const log = await eventLogFor(p.eventsFile);
  const { tick, exitCode } = await runOnce({
    board,
    delivery,
    pilot,
    log,
    out: (line) => {
      if (!json) console.log(line);
    },
  });
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
    return { board, delivery: createGitHubDeliveryProvider({ repo: deliveryOptions['repo'] ?? '', ...(deliveryOptions['apiBase'] === undefined ? {} : { apiBase: deliveryOptions['apiBase'] }) }) };
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
    return { board, delivery: createGitLabDeliveryProvider({ project: deliveryOptions['project'] ?? '', ...(deliveryOptions['apiBase'] === undefined ? {} : { apiBase: deliveryOptions['apiBase'] }) }) };
  }
  throw new Error(`unknown delivery provider: ${deliveryId} (fake | github | gitlab)`);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);