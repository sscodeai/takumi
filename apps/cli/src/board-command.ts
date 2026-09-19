import { BOARD_WORK_ITEM_STATES } from '@takumi/core';
import type {
  BoardBootstrapReport,
  BoardCapabilities,
  TaskBoardProvider,
  BoardWorkItemState,
} from '@takumi/core';

/**
 * `takumi board` — a READ-ONLY view of a task board through the provider layer.
 *
 * Read-only is the point, not a limitation: the board owns the delivery state
 * (ADR-006), so this command never claims, transitions or comments. It answers
 * one question — "what is on the board right now?" — and it says out loud what
 * the provider can and cannot do, because a silent capability gap is how a
 * team ends up believing a Notion board can merge pull requests.
 */

export interface BoardCommandOptions {
  providerId: string;
  /** Provider-specific options, already parsed from the CLI. */
  providerOptions: Record<string, string>;
  /** Only these states (default: every declared state). */
  states?: string[];
  /**
   * Delivery state -> the board's own status name (Redmine needs it: its states
   * are numeric ids behind a per-site workflow). Parsed from `--status-map`.
   */
  statusMap?: Record<string, string>;
  /** Emit JSON instead of the text board. */
  json: boolean;
  /**
   * Report (or apply) the board's state bootstrap. `--check` reports what is
   * missing without changing anything; `--bootstrap` creates what the board allows.
   */
  bootstrap?: 'check' | 'apply';
}

/** Parse `takumi board` arguments. Unknown flags are rejected, never ignored. */
/** Parse the fake board's `items` option: a JSON array of work-item seeds. */
function parseBoardItems(raw: string): Array<{ id: string; title?: string; body?: string; state?: BoardWorkItemState }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--items must be a JSON array of {id,title,body,state}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) throw new Error('--items must be a JSON array');
  return parsed.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const id = item['id'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`--items[${index}] needs a non-empty string id`);
    }
    const state = item['state'];
    if (state !== undefined && !(BOARD_WORK_ITEM_STATES as readonly unknown[]).includes(state)) {
      // Fail closed: a typo in a seeded state would otherwise park the item in a state no
      // runner reads, and the tick would look idle for no visible reason.
      throw new Error(
        `--items[${index}] state ${JSON.stringify(state)} is not one of ${BOARD_WORK_ITEM_STATES.join(', ')}`,
      );
    }
    return {
      id,
      ...(typeof item['title'] === 'string' ? { title: item['title'] } : {}),
      ...(typeof item['body'] === 'string' ? { body: item['body'] } : {}),
      ...(state === undefined ? {} : { state: state as BoardWorkItemState }),
    };
  });
}

export function parseBoardArgs(rest: string[]): BoardCommandOptions {
  const providerOptions: Record<string, string> = {};
  let providerId = 'fake';
  let json = false;
  let bootstrap: 'check' | 'apply' | undefined;
  let states: string[] | undefined;
  let statusMap: Record<string, string> | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? '';
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? (arg.split(/=(.*)/s, 2) as [string, string]) : [arg, undefined];
    const next = (): string => inline ?? rest[++i] ?? '';
    switch (flag) {
      case '--provider':
        providerId = next();
        break;
      case '--repo':
        providerOptions['repo'] = next();
        break;
      case '--project':
        providerOptions['project'] = next();
        break;
      case '--base-url':
        providerOptions['baseUrl'] = next();
        break;
      case '--project-key':
        providerOptions['projectKey'] = next();
        break;
      case '--state-field':
        providerOptions['stateFieldName'] = next();
        break;
      case '--database':
        providerOptions['databaseId'] = next();
        break;
      case '--api-base':
        providerOptions['apiBase'] = next();
        break;
      case '--items':
        providerOptions['items'] = next();
        break;
      case '--states':
        states = next()
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        break;
      case '--status-map':
        statusMap = parseStatusMap(next());
        break;
      case '--json':
        json = true;
        break;
      case '--check':
        bootstrap = 'check';
        break;
      case '--bootstrap':
        bootstrap = 'apply';
        break;
      case '':
        break;
      default:
        throw new Error(`unknown option for "takumi board": ${arg} (see "takumi board --help")`);
    }
  }

  return {
    providerId,
    providerOptions,
    json,
    ...(states === undefined ? {} : { states }),
    ...(statusMap === undefined ? {} : { statusMap }),
    ...(bootstrap === undefined ? {} : { bootstrap }),
  };
}

/**
 * Render a bootstrap report for a human.
 *
 * The whole point of the report is the LAST column: when a board cannot create a
 * state, the operator must be told exactly what to do. A report that says only
 * "missing" is the "no such label" error with extra steps.
 */
export function renderBootstrapReport(report: BoardBootstrapReport): string {
  const lines: string[] = [];
  lines.push(
    `Takumi board bootstrap — ${report.provider} ` +
      `(${report.applied ? 'applied changes' : 'no changes made'})`,
  );
  lines.push('');
  const width = Math.max(...report.actions.map((a) => a.state.length), 5);
  for (const action of report.actions) {
    lines.push(`  ${pad(action.state, width)}  ${pad(action.outcome, 13)}  ${action.name}`);
    if (action.instruction !== undefined) lines.push(`  ${' '.repeat(width)}  ${' '.repeat(13)}  -> ${action.instruction}`);
  }
  if (report.unsupported.length > 0) {
    lines.push('');
    lines.push(`  this board cannot express: ${report.unsupported.join(', ')}`);
  }
  const missing = report.actions.filter((a) => a.outcome === 'not-creatable');
  if (missing.length > 0) {
    lines.push('');
    lines.push(`  ${missing.length} state(s) need a human. The instructions above are the whole fix.`);
  }
  return lines.join('\n');
}

/**
 * Build the provider behind the command.
 *
 * Each adapter is imported lazily so a board the operator never uses cannot
 * break the CLI, and so a provider that needs credentials only fails when it is
 * actually asked for.
 */
export async function createBoardProvider(options: BoardCommandOptions): Promise<TaskBoardProvider> {
  switch (options.providerId) {
    case 'fake': {
      const { FakeBoardProvider } = await import('@takumi/board-fake');
      // A demo board is only useful if the demo can be REAL: `items` lets a caller seed
      // actual work (a JSON array of {id,title,body,state}), which is what a pilot tick
      // with a real agent needs — a hardcoded "A ready item" title hands the agent a task
      // that says nothing. Without `items` the built-in demo pair stands.
      const seeded = options.providerOptions['items'];
      return new FakeBoardProvider({
        items:
          seeded === undefined
            ? [
                { id: 'DEMO-1', state: 'ready', title: 'A ready item (the fake board is a demo)' },
                { id: 'DEMO-2', state: 'pr_open', title: 'An item awaiting review' },
              ]
            : parseBoardItems(seeded),
      });
    }
    case 'github': {
      const { createGitHubBoardProvider } = await import('@takumi/board-github');
      return createGitHubBoardProvider({
        repo: required(options, 'repo', '--repo owner/name'),
        ...optional(options, 'apiBase'),
      });
    }
    case 'gitlab': {
      const { createGitLabBoardProvider } = await import('@takumi/board-gitlab');
      return createGitLabBoardProvider({
        project: required(options, 'project', '--project group/project'),
        ...optional(options, 'apiBase'),
      });
    }
    case 'jira': {
      const { createJiraBoardProvider } = await import('@takumi/board-jira');
      return createJiraBoardProvider({
        baseUrl: required(options, 'baseUrl', '--base-url https://your-site.atlassian.net'),
        ...optional(options, 'projectKey'),
      });
    }
    case 'notion': {
      const { NotionBoardProvider } = await import('@takumi/board-notion');
      return new NotionBoardProvider({
        databaseId: required(options, 'databaseId', '--database <notion database id or url>'),
        ...optional(options, 'apiBase'),
      });
    }
    case 'redmine': {
      const { createRedmineBoardProvider } = await import('@takumi/board-redmine');
      return createRedmineBoardProvider({
        baseUrl: required(options, 'baseUrl', '--base-url https://your-redmine.example.com'),
        ...optional(options, 'project'),
        // Without a state field Redmine has nowhere to keep the run record, and the
        // provider says so instead of pretending: the view reports stateRecord=false.
        ...optional(options, 'stateFieldName'),
        ...(options.statusMap === undefined ? {} : { statusMap: options.statusMap }),
      });
    }
    default:
      throw new Error(
        `unknown board provider: ${options.providerId} (fake | github | gitlab | jira | notion | redmine)`,
      );
  }
}

/** Render one board as text: a header naming the provider and its真 capabilities. */
export function renderBoard(provider: TaskBoardProvider, items: BoardWorkItemLike[], states: readonly BoardWorkItemState[]): string {
  const meta = provider.metadata();
  const caps = provider.capabilities();
  const lines: string[] = [];
  lines.push(`Takumi board — ${meta.name} (${meta.id} ${meta.version})`);
  lines.push(`  capabilities: ${describeCapabilities(caps)}`);
  lines.push('');

  let total = 0;
  for (const state of states) {
    const inState = items.filter((item) => item.state === state);
    total += inState.length;
    if (inState.length === 0) {
      lines.push(`${state} (0)`);
      continue;
    }
    lines.push(`${state} (${inState.length})`);
    for (const item of inState) {
      lines.push(`  ${pad(item.id, 10)} ${truncate(item.title, 60)}`);
      if (item.url) lines.push(`  ${' '.repeat(10)} ${item.url}`);
    }
  }
  lines.push('');
  lines.push(`${total} item(s). Read-only view: the board owns the delivery state, so takumi never writes here.`);
  return lines.join('\n');
}

interface BoardWorkItemLike {
  id: string;
  title: string;
  url: string;
  state: BoardWorkItemState;
}

function describeCapabilities(caps: BoardCapabilities): string {
  const delivery = [
    caps.delivery.canOpenPullRequest ? 'pr' : null,
    caps.delivery.canRunChecks ? 'ci' : null,
    caps.delivery.canMerge ? 'merge' : null,
  ].filter((v): v is string => v !== null);
  return [
    `states=${caps.states.length}`,
    `comments=${caps.comments}`,
    `editableComment=${caps.editableComment}`,
    `stateRecord=${caps.machineReadableState}`,
    `trustFilter=${caps.trustedAuthorFilter}`,
    `atomicClaim=${caps.atomicClaim}`,
    `delivery=[${delivery.length === 0 ? 'none' : delivery.join(',')}]`,
  ].join(' ');
}

/**
 * Parse `--status-map "ready=New,pr_open=In Progress"` into delivery-state → status
 * name. A key that is not a delivery state is rejected here: the adapter would
 * ignore it, and a silently ignored mapping is a board that lies about its columns.
 */
export function parseStatusMap(spec: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of spec.split(',')) {
    const trimmed = pair.trim();
    if (trimmed.length === 0) continue;
    const at = trimmed.indexOf('=');
    if (at <= 0 || at === trimmed.length - 1) {
      throw new Error(`invalid --status-map entry: ${JSON.stringify(trimmed)} (expected state=Status Name)`);
    }
    const state = trimmed.slice(0, at).trim();
    const name = trimmed.slice(at + 1).trim();
    if (!(BOARD_WORK_ITEM_STATES as readonly string[]).includes(state)) {
      throw new Error(
        `invalid --status-map state: ${JSON.stringify(state)} (one of ${BOARD_WORK_ITEM_STATES.join(', ')})`,
      );
    }
    map[state] = name;
  }
  return map;
}

function required(options: BoardCommandOptions, key: string, flag: string): string {
  const value = options.providerOptions[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`provider ${options.providerId} needs ${flag}`);
  }
  return value;
}

function optional(options: BoardCommandOptions, key: string): Record<string, string> {
  const value = options.providerOptions[key];
  return value === undefined || value.length === 0 ? {} : { [key]: value };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** The command entry point. */
export async function runBoardCommand(rest: string[]): Promise<number> {
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(
      [
        'usage: takumi board [--provider fake|github|gitlab|jira|notion|redmine] [--json]',
        '',
        '  --provider fake                 a demo board (default)',
        '  --provider github  --repo owner/name [--api-base URL]',
        '  --provider gitlab  --project group/project [--api-base URL]',
        '  --provider jira    --base-url https://site.atlassian.net [--project-key ABC]',
        '  --provider notion  --database <id|url>',
        '  --provider redmine --base-url https://redmine.example.com [--project ID] [--state-field NAME]',
        '  --states ready,claimed          limit the states shown',
        '  --status-map "ready=New,pr_open=In Progress"  delivery state -> board status name',
        '  --json                          print work items as JSON',
        '  --check                         report the states this board is missing (read-only)',
        '  --bootstrap                     create the missing states where the board allows it',
        '',
        'Read-only: takumi never claims, transitions or comments from this command.',
        'Credentials come from the environment (GITHUB_TOKEN, GITLAB_TOKEN,',
        'JIRA_API_TOKEN or JIRA_TOKEN, NOTION_TOKEN, REDMINE_API_KEY).',
        'Note: a Redmine board without --state-field cannot store the versioned run',
        'record, and reports stateRecord=false instead of pretending otherwise.',
      ].join('\n'),
    );
    return 0;
  }

  const options = parseBoardArgs(rest);
  const provider = await createBoardProvider(options);

  if (options.bootstrap !== undefined) {
    const caps0 = provider.capabilities();
    // A dry run goes through the SAME call with dryRun set, so what an operator
    // reviews is exactly what `--bootstrap` will do, not a second implementation.
    const report = await provider.bootstrapStates(caps0.states, { dryRun: options.bootstrap === 'check' });
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderBootstrapReport(report));
      if (options.bootstrap === 'check' && report.actions.some((a) => a.outcome !== 'exists')) {
        console.log('\nRe-run with --bootstrap to create what this board allows.');
      }
    }
    return report.actions.every((a) => a.outcome !== 'not-creatable') ? 0 : 1;
  }

  const caps = provider.capabilities();
  const wanted = options.states === undefined ? caps.states : validateStates(options.states, caps.states);
  const items = await provider.listWork({ states: wanted });

  if (options.json) {
    console.log(JSON.stringify({ provider: provider.metadata(), capabilities: caps, items }, null, 2));
    return 0;
  }
  console.log(renderBoard(provider, items, wanted));
  return 0;
}

function validateStates(requested: string[], declared: readonly BoardWorkItemState[]): BoardWorkItemState[] {
  return requested.map((state) => {
    if (!(BOARD_WORK_ITEM_STATES as readonly string[]).includes(state)) {
      throw new Error(`unknown state: ${state} (${BOARD_WORK_ITEM_STATES.join(', ')})`);
    }
    const typed = state as BoardWorkItemState;
    if (!declared.includes(typed)) {
      throw new Error(`provider does not declare the state: ${state} (declared: ${declared.join(', ')})`);
    }
    return typed;
  });
}
