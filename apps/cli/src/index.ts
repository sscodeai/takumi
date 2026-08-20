#!/usr/bin/env node
import { listExtensions, loadConfig, runTask } from './commands.js';
import { initProject } from './init.js';

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

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);