/**
 * `takumi runs` — the aggregator over the run records in `.takumi/runs/`.
 *
 * Answers, from data rather than from a person reading logs: how many runs, how often they are
 * accepted, the median and worst duration, which step fails most often (and how many runs it failed
 * in), and what the runs cost — stating plainly when the runtime reported no cost. The records are
 * written by every workflow run (see @takumi/core's run-record.ts).
 *
 * A malformed record is NAMED and skipped, never fatal: the point of the command is the picture the
 * healthy records still support, and one damaged file must not blank it. The unreadable files are
 * printed LAST, always, so a summary computed from a partial set can never be mistaken for one
 * computed from everything.
 */

import { readRunRecords, renderRunAggregate, summarizeRuns, RUN_RECORD_DIR } from '@takumi/core';
import { join } from 'node:path';

export interface RunsCommandOptions {
  /** Where the records live (default `.takumi/runs` under the project directory). */
  dir: string;
  json: boolean;
}

/** Parse `takumi runs` arguments. Unknown flags are refused, never ignored. */
export function parseRunsArgs(cwd: string, rest: string[]): RunsCommandOptions {
  let dir = join(cwd, RUN_RECORD_DIR);
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    if (arg === '--json') {
      json = true;
    } else if (arg === '--dir') {
      const value = rest[++i];
      if (value === undefined || value.length === 0) throw new Error('--dir needs a path');
      dir = value;
    } else if (arg.startsWith('--dir=')) {
      dir = arg.slice('--dir='.length);
    } else {
      throw new Error(`unknown argument: ${arg} (usage: takumi runs [--dir <path>] [--json])`);
    }
  }
  return { dir, json };
}

/**
 * Read the records, aggregate them, and print the result. Returns 0 whenever the aggregation ran —
 * an unreadable file is reported, not a failure of the command.
 */
export function runRunsCommand(cwd: string, rest: string[], out: (line: string) => void = (line) => console.log(line)): number {
  if (rest.includes('--help') || rest.includes('-h')) {
    out(
      [
        'usage: takumi runs [--dir <path>] [--json]',
        '',
        '  Aggregates the run records in .takumi/runs/ (one per workflow run):',
        '  how many runs, the success rate, the median and worst duration, the step',
        '  that fails most often, and the total cost the runtimes reported.',
        '',
        '  --dir <path>   read records from somewhere else (default .takumi/runs)',
        '  --json         print the aggregate as JSON',
        '',
        'A record that cannot be read is named and skipped, never fatal.',
      ].join('\n'),
    );
    return 0;
  }

  const options = parseRunsArgs(cwd, rest);
  const { records, unreadable } = readRunRecords(options.dir);
  const aggregate = summarizeRuns(records, unreadable);

  if (options.json) {
    out(JSON.stringify(aggregate, null, 2));
  } else {
    out(renderRunAggregate(aggregate));
  }
  return 0;
}
