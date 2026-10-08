import type { DeliveryProvider, PullRequestRef } from '@takumi/core';
import { createGitRunner } from '@takumi/core';

/**
 * The `delivery:` section of `takumi.yaml`, and the provider it selects (ADR-007 / ADR-037).
 *
 * WHY THIS EXISTS: the `publish` and `await_checks` steps have been able to drive a delivery
 * provider since ADR-037, but nothing could ever HAND one to them from a project's configuration —
 * `ctx.delivery` was only ever set by a caller writing code. A `publish` step in a configured
 * workflow therefore failed at run time with "no delivery provider", after the run had already
 * spent its work. This module makes the provider reachable from `takumi.yaml`, and it mirrors
 * `board-command.ts` exactly: a per-provider dynamic import, a per-provider option list, and a
 * refusal of any option nobody would read (a key the factory drops and a typo are the same silent
 * defect — see the live `labelsProperty` incident the board tests pin down).
 *
 * The token is NOT a configuration option: it comes from the environment (Forgejo reads
 * `FORGEJO_TOKEN`, then `GITEA_TOKEN`), because a secret in a config file is one commit away from
 * being a secret in a repository.
 */

/**
 * The reporting surface the engine's `ctx.delivery` declares: the delivery port, plus the optional
 * issue/comment operations a host that can record a failure exposes. Forgejo's provider carries
 * both; a bare git remote carries neither, and the engine reports that honestly instead of
 * pretending an issue exists.
 */
export type DeliveryProviderWithReporting = DeliveryProvider & {
  openIssue?: (req: { title: string; body: string; labels?: string[] }) => Promise<{ number: string; url: string }>;
  /** `unknown` (not `void`): the host answers with the comment's identity, which the caller ignores. */
  commentOnPullRequest?: (ref: PullRequestRef, body: string) => Promise<unknown>;
};

/**
 * The `delivery:` section of `takumi.yaml`.
 *
 * `repo` is `owner/name` (one path segment each), which is how every other takumi provider names a
 * repository; the Forgejo adapter wants `owner` and `repo` separately, so the split happens in the
 * option mapper below rather than in the operator's file.
 */
export interface DeliverySection {
  /** Which delivery adapter to build (currently `forgejo`). */
  provider: string;
  /** The repository, as `owner/name`. */
  repo?: string;
  /** The API base of a self-hosted host (e.g. `https://forgejo.example.com/api/v1`). */
  apiBase?: string;
  /**
   * The base branch a `publish` step targets when the step itself does not declare one.
   * The delivery PROVIDER has no such option (the base travels with each delivery request), so it
   * is carried here as a run default — see `WorkflowExecutionContext.deliveryDefaults`.
   */
  baseBranch?: string;
  /** The git remote a `publish` step pushes to (default `origin`). */
  remote?: string;
  /** Any other option the selected adapter documents, by its own name. */
  options?: Record<string, string>;
}

/** A provider id and the provider-specific options it was selected with. */
export interface DeliveryCommandOptions {
  providerId: string;
  providerOptions: Record<string, string>;
}

/**
 * Flatten a `delivery:` section into the provider id plus the option map the factory reads.
 *
 * `baseBranch` deliberately stays OUT of `providerOptions`: it is a run default for the `publish`
 * step, not an option the Forgejo adapter reads, and forwarding it to the adapter would be the very
 * "key the factory cannot reach" defect this module refuses elsewhere.
 */
export function deliveryOptionsFromSection(section: DeliverySection): DeliveryCommandOptions {
  const providerOptions: Record<string, string> = {};
  if (section.repo !== undefined) providerOptions['repo'] = section.repo;
  if (section.apiBase !== undefined) providerOptions['apiBase'] = section.apiBase;
  if (section.remote !== undefined) providerOptions['remote'] = section.remote;
  return { providerId: section.provider, providerOptions: { ...providerOptions, ...(section.options ?? {}) } };
}

/**
 * Every option each adapter DOCUMENTS, sorted by the only question that matters: who can set it.
 *
 * There are three answers and no fourth — configurable here, from the environment, or set in code —
 * exactly as `board-command.ts` answers it. A key the factory does not forward is invisible, and a
 * typo in a key is invisible in the same way.
 */
const CONFIGURABLE_OPTIONS: Record<string, readonly string[]> = {
  forgejo: ['repo', 'apiBase', 'remote'],
};

/** Credentials: read from the environment, never accepted from a config file. */
const ENVIRONMENT_OPTIONS: Record<string, readonly string[]> = {
  forgejo: ['token'],
};

/** Options that only mean something in code (an injected transport, a git runner, capabilities). */
const PROGRAMMATIC_OPTIONS: Record<string, readonly string[]> = {
  forgejo: ['request', 'git', 'capabilities'],
};

/**
 * Refuse a delivery option nobody would read.
 *
 * The same defect has two shapes and both are silent: a key the factory does not forward looks
 * exactly like a feature that does not work, and a typo in a key looks exactly like a feature that
 * was never configured. One of them costs a sentence here.
 */
export function assertKnownProviderOptions(options: DeliveryCommandOptions): void {
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
      throw new Error(`${provider}: ${key} is set in code (a transport, a git runner), not from configuration`);
    }
    throw new Error(`${provider}: unknown option ${JSON.stringify(key)} — this adapter reads ${configurable.join(', ')}`);
  }
}

function required(options: DeliveryCommandOptions, key: string, what: string): string {
  const value = options.providerOptions[key];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`provider ${options.providerId} needs ${what}`);
  }
  return value.trim();
}

function optional(options: DeliveryCommandOptions, key: string): Record<string, string> {
  const value = options.providerOptions[key];
  return value === undefined || value.trim().length === 0 ? {} : { [key]: value.trim() };
}

/**
 * Split `owner/name` into its two path segments, refusing anything that is not exactly that.
 *
 * The Forgejo adapter validates each segment as a single path component, so a three-part value
 * (`host/owner/name`) would otherwise reach the adapter and fail there with a message about the
 * wrong field. The operator gets the sentence about the field they actually wrote.
 */
export function splitOwnerRepo(value: string): { owner: string; repo: string } {
  const at = value.indexOf('/');
  if (at <= 0 || at === value.length - 1 || value.slice(at + 1).includes('/')) {
    throw new Error(`repo must be owner/name (a single owner and a single repository), got ${JSON.stringify(value)}`);
  }
  const owner = value.slice(0, at).trim();
  const repo = value.slice(at + 1).trim();
  if (owner.length === 0 || repo.length === 0 || /[/\s]/.test(owner) || /[/\s]/.test(repo)) {
    throw new Error(`repo must be owner/name (a single owner and a single repository), got ${JSON.stringify(value)}`);
  }
  return { owner, repo };
}

/** `forgejo`'s options, as the adapter documents them (the token and the transport are excluded). */
export function forgejoDeliveryOptions(
  options: DeliveryCommandOptions,
): Omit<import('@takumi/delivery-forgejo').ForgejoDeliveryOptions, 'token' | 'request' | 'git' | 'capabilities'> {
  const { owner, repo } = splitOwnerRepo(required(options, 'repo', 'repo owner/name'));
  return {
    owner,
    repo,
    ...optional(options, 'apiBase'),
    ...optional(options, 'remote'),
  };
}

/**
 * Build the provider named by a `delivery:` section.
 *
 * Each adapter is imported lazily so a host the operator never uses cannot break the CLI, and so a
 * provider that needs credentials only fails when it is actually asked for — the same shape
 * `createBoardProvider` uses.
 */
export async function createDeliveryProvider(options: DeliveryCommandOptions): Promise<DeliveryProviderWithReporting> {
  // Before anything is built: every option must be one this adapter READS.
  assertKnownProviderOptions(options);
  switch (options.providerId) {
    case 'forgejo': {
      const { createForgejoDeliveryProvider } = await import('@takumi/delivery-forgejo');
      // The git runner is a PROGRAMMATIC option (never read from config), and it is REQUIRED for the
      // provider to do anything: without it every git call is the fail-closed "no git runner
      // configured" error. The CLI is a real caller, so it injects the real spawn-based runner.
      return createForgejoDeliveryProvider({ ...forgejoDeliveryOptions(options), git: createGitRunner() });
    }
    default:
      throw new Error(`unknown delivery provider: ${options.providerId} (forgejo)`);
  }
}

/** Build the provider named by a `delivery:` section, refusing a section with no provider. */
export async function createDeliveryFromSection(section: DeliverySection): Promise<DeliveryProviderWithReporting> {
  if (typeof section.provider !== 'string' || section.provider.trim().length === 0) {
    throw new Error('the `delivery:` section needs a `provider` (e.g. `provider: forgejo`)');
  }
  return createDeliveryProvider(deliveryOptionsFromSection(section));
}

/**
 * The URL a git clone of the configured repository uses.
 *
 * WHY IT LIVES HERE AND HOW IT REUSES THE PROVIDER: a clone URL derived a second way would be a
 * second definition of "where this repository is", and the two would drift the day the provider's
 * base handling changed. So the owner/name split is the SAME `splitOwnerRepo` the adapter's option
 * mapper uses, and the apiBase is resolved by the provider's OWN exported target resolver
 * (`resolveForgejoTarget`) — the exact call the provider makes, so the trailing-slash trimming and
 * the single-path-segment validation are shared, not re-implemented.
 *
 * Forgejo serves git over HTTP at the WEB base: the API base with its `/api/v1` suffix removed.
 * That is the URL the live self-test clones (`<host>/<owner>/<repo>.git`), and it is the only part
 * of the derivation the provider itself never needs — it talks to the API, not to git.
 *
 * The URL never carries a credential: authentication is the operator's git credential helper, the
 * same way the live self-test clones (the token stays environment-only).
 */
export async function forgejoCloneUrl(section: DeliverySection): Promise<string> {
  if (section.provider !== 'forgejo') {
    throw new Error(`a clone URL is only defined for provider "forgejo", not ${JSON.stringify(section.provider)}`);
  }
  if (section.repo === undefined) {
    throw new Error('provider forgejo needs repo owner/name');
  }
  const { owner, repo } = splitOwnerRepo(section.repo);
  // The provider's own resolution: same apiBase normalisation, same owner/repo validation.
  const { resolveForgejoTarget } = await import('@takumi/delivery-forgejo');
  const target = resolveForgejoTarget({ owner, repo, ...(section.apiBase === undefined ? {} : { apiBase: section.apiBase }) });
  const webBase = target.apiBase.replace(/\/api\/v1$/, '');
  return `${webBase}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`;
}
