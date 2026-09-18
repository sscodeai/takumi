import { BOARD_WORK_ITEM_STATES } from '@takumi/core';
import type { BoardCapabilities, TaskBoardProvider, BoardWorkItemState } from '@takumi/core';

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
}

/** Parse `takumi board` arguments. Unknown flags are rejected, never ignored. */
export function parseBoardArgs(rest: string[]): BoardCommandOptions {
  const providerOptions: Record<string, string> = {};
  let providerId = 'fake';
  let json = false;
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
  };
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
      return new FakeBoardProvider({
        items: [
          { id: 'DEMO-1', state: 'ready', title: 'A ready item (the fake board is a demo)' },
          { id: 'DEMO-2', state: 'pr_open', title: 'An item awaiting review' },
        ],
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
