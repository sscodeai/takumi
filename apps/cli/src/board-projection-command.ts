import type { DeliveryBoardPort } from '@takumi/core';

/**
 * The `board:` section of `takumi.yaml`, and the delivery board it selects (ADR-044).
 *
 * WHY THIS EXISTS: the engine's board projection (`ctx.board`, `DeliveryBoardPort`) was only ever set
 * by a caller writing code — exactly the gap `delivery-command.ts` closed for `ctx.delivery`. Without
 * this module a configured black-box run projects nowhere and nothing in a transcript says why: the
 * engine's own rule is that a run with no board port projects nowhere and that is not an error, so
 * the absence is silent by design. This module makes the board reachable from `takumi.yaml` so an
 * operator can say WHICH board a delivery writes its row to, and it mirrors `delivery-command.ts`
 * exactly: a per-provider dynamic import, a per-provider option list, and a refusal of any option
 * nobody would read (a key the factory drops and a typo are the same silent defect).
 *
 * It is NOT the task board. The `board:` section here names the DELIVERY board — the write-only row a
 * run files for a human to read (ADR-044). The task board (list/claim/transition, ADR-006) is the
 * `pilot:` section's business; a black-box run has no task board and must not be handed one.
 *
 * The token is NOT a configuration option: it comes from the environment (`NOTION_TOKEN`), because a
 * secret in a config file is one commit away from being a secret in a repository.
 */

/**
 * The `board:` section of `takumi.yaml`.
 *
 * `provider` names the delivery-board adapter to build (`notion` today); `options` carries whatever
 * else the adapter documents, by its own name.
 */
export interface BoardSection {
  /** Which delivery-board adapter to build (currently `notion`). */
  provider: string;
  /** Any other option the selected adapter documents, by its own name. */
  options?: Record<string, string>;
}

/** A provider id and the provider-specific options it was selected with. */
export interface BoardCommandOptions {
  providerId: string;
  providerOptions: Record<string, string>;
}

/**
 * Every option each adapter DOCUMENTS, sorted by the only question that matters: who can set it.
 *
 * The same three answers as `delivery-command.ts` and no fourth — configurable here, from the
 * environment, or set in code. A key the factory does not forward is invisible, and a typo in a key
 * is invisible in the same way.
 */
const CONFIGURABLE_OPTIONS: Record<string, readonly string[]> = {
  notion: ['databaseId', 'apiBase', 'titleProperty', 'stateProperty', 'columnProperty', 'labelsProperty'],
};

/** Credentials: read from the environment, never accepted from a config file. */
const ENVIRONMENT_OPTIONS: Record<string, readonly string[]> = {
  notion: ['token'],
};

/** Options that only mean something in code (an injected transport). */
const PROGRAMMATIC_OPTIONS: Record<string, readonly string[]> = {
  notion: ['request'],
};

/**
 * Refuse a board option nobody would read.
 *
 * The same defect has two shapes and both are silent: a key the factory does not forward looks
 * exactly like a feature that does not work, and a typo in a key looks exactly like a feature that
 * was never configured. One of them costs a sentence here.
 */
export function assertKnownBoardOptions(options: BoardCommandOptions): void {
  const provider = options.providerId;
  const configurable = CONFIGURABLE_OPTIONS[provider];
  // An unknown PROVIDER is the switch's business: it has a better message (it lists them).
  if (configurable === undefined) return;
  for (const key of Object.keys(options.providerOptions)) {
    if (configurable.includes(key)) continue;
    if ((ENVIRONMENT_OPTIONS[provider] ?? []).includes(key)) {
      throw new Error(
        `${provider}: ${key} comes from the ENVIRONMENT, never from configuration — a secret in a config ` +
          'file is one commit away from being a secret in a repository',
      );
    }
    if ((PROGRAMMATIC_OPTIONS[provider] ?? []).includes(key)) {
      throw new Error(`${provider}: ${key} is set in code (an injected transport), not from configuration`);
    }
    throw new Error(`${provider}: unknown option ${JSON.stringify(key)} — this adapter reads ${configurable.join(', ')}`);
  }
}

/**
 * Build the delivery board named by a `board:` section.
 *
 * Each adapter is imported lazily so a board the operator never uses cannot break the CLI, and so a
 * board that needs credentials only fails when it is actually asked for — the same shape
 * `createDeliveryProvider` uses.
 */
export async function createBoardProvider(options: BoardCommandOptions): Promise<DeliveryBoardPort> {
  // Before anything is built: every option must be one this adapter READS.
  assertKnownBoardOptions(options);
  switch (options.providerId) {
    case 'notion': {
      const { createNotionDeliveryBoard } = await import('@takumi/board-notion');
      const databaseId = options.providerOptions['databaseId'];
      if (databaseId === undefined || databaseId.trim().length === 0) {
        throw new Error('provider notion needs databaseId (the Notion database that is the delivery board)');
      }
      const opts = options.providerOptions;
      return createNotionDeliveryBoard({
        databaseId: databaseId.trim(),
        ...(opts['apiBase'] === undefined ? {} : { apiBase: opts['apiBase'] }),
        ...(opts['titleProperty'] === undefined ? {} : { titleProperty: opts['titleProperty'] }),
        ...(opts['stateProperty'] === undefined ? {} : { stateProperty: opts['stateProperty'] }),
        ...(opts['columnProperty'] === undefined ? {} : { columnProperty: opts['columnProperty'] }),
        ...(opts['labelsProperty'] === undefined ? {} : { labelsProperty: opts['labelsProperty'] }),
      });
    }
    default:
      throw new Error(`unknown board provider: ${options.providerId} (notion)`);
  }
}

/** Build the delivery board named by a `board:` section, refusing a section with no provider. */
export async function createBoardFromSection(section: BoardSection): Promise<DeliveryBoardPort> {
  if (typeof section.provider !== 'string' || section.provider.trim().length === 0) {
    throw new Error('the `board:` section needs a `provider` (e.g. `provider: notion`)');
  }
  return createBoardProvider({ providerId: section.provider, providerOptions: { ...(section.options ?? {}) } });
}
