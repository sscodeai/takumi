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
  /** Which delivery adapter to build (currently `forgejo`, `gitlab` or `github`). */
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
 *
 * `tokenEnv` is CONFIGURATION because it is a NAME: `delivery: { tokenEnv: GITHUB_TOKEN }` says where
 * the secret lives without being one. The secret itself stays an ENVIRONMENT option (below), because a
 * secret in a config file is one commit away from a secret in a repository.
 */
const CONFIGURABLE_OPTIONS: Record<string, readonly string[]> = {
  forgejo: ['repo', 'apiBase', 'remote', 'tokenEnv'],
  gitlab: ['repo', 'apiBase', 'remote', 'tokenEnv'],
  github: ['repo', 'apiBase', 'remote', 'tokenEnv'],
};

/** Credentials: read from the environment, never accepted from a config file. */
const ENVIRONMENT_OPTIONS: Record<string, readonly string[]> = {
  forgejo: ['token'],
  gitlab: ['token'],
  github: ['token'],
};

/** Options that only mean something in code (an injected transport, a git runner, capabilities). */
const PROGRAMMATIC_OPTIONS: Record<string, readonly string[]> = {
  forgejo: ['request', 'git', 'capabilities'],
  gitlab: ['request', 'git', 'capabilities'],
  github: ['request', 'git'],
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

/**
 * The environment variable each API-backed provider reads its token from, in the order the ADAPTER
 * itself tries them. `delivery.tokenEnv` names one instead — a name, never a value.
 */
export const DEFAULT_TOKEN_ENV: Record<string, readonly string[]> = {
  forgejo: ['FORGEJO_TOKEN', 'GITEA_TOKEN'],
  gitlab: ['GITLAB_TOKEN'],
  github: ['GITHUB_TOKEN'],
};

/**
 * The providers that CANNOT do anything without a token: their adapter builds a fail-closed "no
 * request transport" function and refuses every call, so a run that reaches `publish` without one has
 * spent the whole chain for nothing.
 *
 * `forgejo` is deliberately NOT in this list: its transport reads the token lazily and sends the
 * request without one, which is legitimate against a host that allows it. That difference is stated
 * rather than left to be discovered (ADR-051).
 */
const TOKEN_REQUIRED: readonly string[] = ['gitlab', 'github'];

/**
 * The token a delivery provider will use, and the names it looked for — or the refusal.
 *
 * WHY THIS EXISTS: without it a missing token is discovered at the PUBLISH step, after the
 * implementation, the delivered tests, the quality gate, the rule review and the acceptance have all
 * run. Measured on 2026-10-11: a `request-to-delivery` run accepted a service 11/11 and was then
 * refused at `publish` with `no request transport configured … — inject one (tests) or provide
 * credentials`, because `GITHUB_TOKEN` was not in the environment. The adapter is right to fail closed
 * — an unauthenticated request is never sent — but the operator should not pay for the chain first.
 */
export function deliveryToken(
  providerId: string,
  options: DeliveryCommandOptions,
  env: NodeJS.ProcessEnv = process.env,
): { token?: string; names: readonly string[] } {
  const named = options.providerOptions['tokenEnv'];
  const names =
    named !== undefined && named.trim().length > 0 ? [named.trim()] : (DEFAULT_TOKEN_ENV[providerId] ?? []);
  for (const name of names) {
    const raw = env[name];
    if (raw !== undefined && raw.trim().length > 0) return { token: raw.trim(), names };
  }
  return { names };
}

/** The resolved token, refusing BY NAME when the provider cannot run without one. */
export function assertDeliveryToken(
  providerId: string,
  options: DeliveryCommandOptions,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const { token, names } = deliveryToken(providerId, options, env);
  if (token !== undefined) return token;
  if (!TOKEN_REQUIRED.includes(providerId)) return undefined;
  const named = options.providerOptions['tokenEnv'];
  throw new Error(
    `${providerId}: the delivery section names this provider but no token is configured — set the ` +
      `environment variable ${names.join(' or ')}` +
      (named === undefined ? ' (or name another one with delivery.tokenEnv)' : '') +
      ', because the publish step is refused without one AFTER the implementation, the delivered tests ' +
      'and the acceptance have all run, and an unauthenticated request is never sent',
  );
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
 * `gitlab`'s options, as the adapter documents them (the token and the transport are excluded).
 *
 * GitLab names the repository `project` (a URL-encoded `group/project` path), but the operator writes
 * `owner/name` exactly as they do for Forgejo: the same `splitOwnerRepo` validates it, and the join
 * into the one `project` value happens here rather than in the operator's file.
 */
export function gitlabDeliveryOptions(
  options: DeliveryCommandOptions,
): Omit<import('@takumi/delivery-gitlab').GitLabDeliveryOptions, 'token' | 'request' | 'git' | 'capabilities'> {
  const { owner, repo } = splitOwnerRepo(required(options, 'repo', 'repo owner/name'));
  return {
    project: `${owner}/${repo}`,
    ...optional(options, 'apiBase'),
    ...optional(options, 'remote'),
  };
}

/**
 * `github`'s options, as the adapter documents them (the token and the transport are excluded).
 *
 * GitHub names the repository `owner/name` — exactly the shape the operator writes — so the value is
 * re-joined after the same `splitOwnerRepo` validation every other provider's mapper uses (the refusal
 * sentence an operator gets is therefore identical, whatever host they configured).
 */
export function githubDeliveryOptions(
  options: DeliveryCommandOptions,
): Omit<import('@takumi/delivery-github').GitHubDeliveryOptions, 'token' | 'request' | 'git'> {
  const { owner, repo } = splitOwnerRepo(required(options, 'repo', 'repo owner/name'));
  return {
    repo: `${owner}/${repo}`,
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
      // The option mapper runs FIRST, so a section that is malformed (no `repo`) says so before the
      // token question is asked. Then the token (ADR-051): `forgejo` may legitimately have none, so an
      // unresolvable one is passed as absent and the adapter's own lazy read decides.
      const mapped = forgejoDeliveryOptions(options);
      const token = assertDeliveryToken(options.providerId, options);
      // The git runner is a PROGRAMMATIC option (never read from config), and it is REQUIRED for the
      // provider to do anything: without it every git call is the fail-closed "no git runner
      // configured" error. The CLI is a real caller, so it injects the real spawn-based runner.
      return createForgejoDeliveryProvider({
        ...mapped,
        ...(token === undefined ? {} : { token }),
        git: createGitRunner(),
      });
    }
    case 'gitlab': {
      const { createGitLabDeliveryProvider } = await import('@takumi/delivery-gitlab');
      const mapped = gitlabDeliveryOptions(options);
      const token = assertDeliveryToken(options.providerId, options);
      // The git runner is a PROGRAMMATIC option (never read from config). The GitLab adapter's default is
      // already the real spawn-based runner, but the CLI injects it explicitly so the two adapters are
      // wired identically and a future default change cannot silently leave git unconfigured. The token
      // is passed explicitly so the variable the operator NAMED (`delivery.tokenEnv`) is the one read.
      return createGitLabDeliveryProvider({ ...mapped, ...(token === undefined ? {} : { token }), git: createGitRunner() });
    }
    case 'github': {
      const { createGitHubDeliveryProvider } = await import('@takumi/delivery-github');
      const mapped = githubDeliveryOptions(options);
      const token = assertDeliveryToken(options.providerId, options);
      // Same as GitLab: the runner is injected explicitly, and the token is passed so the named
      // variable is the one that is read.
      return createGitHubDeliveryProvider({ ...mapped, ...(token === undefined ? {} : { token }), git: createGitRunner() });
    }
    default:
      throw new Error(`unknown delivery provider: ${options.providerId} (forgejo, gitlab, github)`);
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
 * The URL a git clone of the configured repository uses, for whichever provider the section selects.
 *
 * WHY IT LIVES HERE AND HOW IT REUSES THE PROVIDER: a clone URL derived a second way would be a
 * second definition of "where this repository is", and the two would drift the day the provider's
 * base handling changed. So the owner/name split is the SAME `splitOwnerRepo` the adapters' option
 * mappers use, and Forgejo's apiBase is resolved by the provider's OWN exported target resolver
 * (`resolveForgejoTarget`) — the exact call the provider makes, so the trailing-slash trimming and
 * the single-path-segment validation are shared, not re-implemented.
 *
 * Forgejo KEEPS its original derivation: git is served over HTTP at the WEB base, the API base with
 * its `/api/v1` suffix removed (`<host>/<owner>/<repo>.git`), which is what the live self-test clones.
 * GitHub and GitLab derive the git host from the PROVIDER — `https://github.com/<owner>/<repo>.git`,
 * `https://gitlab.com/<namespace>/<project>.git` — with a self-hosted host honoured through an
 * `apiBase` that really is this provider's API base. See {@link cloneWebBase}.
 *
 * The URL never carries a credential: authentication is the operator's git credential helper, the
 * same way the live self-test clones (the token stays environment-only).
 */
export async function deliveryCloneUrl(section: DeliverySection): Promise<string> {
  if (section.provider === 'forgejo') return forgejoCloneUrl(section);
  const host = CLONE_WEB_BASES[section.provider];
  if (host === undefined) {
    throw new Error(
      `a clone URL is only defined for provider ${JSON.stringify(section.provider)} (forgejo, gitlab, github)`,
    );
  }
  if (section.repo === undefined) {
    throw new Error(`provider ${section.provider} needs repo owner/name`);
  }
  const { owner, repo } = splitOwnerRepo(section.repo);
  return `${cloneWebBase(host, section.apiBase)}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`;
}

/**
 * The web base each provider serves git over HTTP at, and the API path suffix its own `apiBase` ends in.
 *
 * WHY THE PROVIDER NAMES ITS GIT HOST AND `apiBase` DOES NOT (docs/bugs-fixed.md #46): for Forgejo the
 * API and git servers share ONE host, so deriving the git host from `apiBase` happens to work — and
 * that coincidence was generalised, which is the defect. It does NOT hold for GitHub (`api.github.com`
 * is not `github.com`) nor GitLab (`gitlab.com/api/v4` is the API, not the git server). Deriving the
 * git host from `apiBase` therefore cloned the API endpoint: MEASURED live, three runs failed closed at
 * the clone step — one against `https://api.github.com/<owner>/<repo>.git`, and two against an
 * INHERITED Forgejo placeholder `apiBase`, because `takumi.local.yaml` merges PER KEY over
 * `takumi.yaml` and omitting `apiBase` does not clear the committed value. `apiBase` is the API
 * endpoint ONLY; the git host comes from the provider.
 *
 * A SELF-HOSTED host is still honoured, but only when the configured `apiBase` really is THIS
 * provider's API base — it carries the provider's own API path (`/api/v3` for GitHub Enterprise,
 * `/api/v4` for GitLab) — so the git host is that host with the API path removed. An `apiBase` that
 * does not carry the suffix is another host's endpoint (the committed Forgejo placeholder, or GitHub's
 * own `https://api.github.com`, whose host is not the git host) and NEVER becomes the git host: the
 * provider's default web base is used instead. Forgejo is deliberately absent — it keeps its original,
 * provider-resolved derivation, where the apiBase host IS the git host.
 */
const CLONE_WEB_BASES: Record<string, { defaultWebBase: string; apiSuffixes: readonly string[] }> = {
  github: { defaultWebBase: 'https://github.com', apiSuffixes: ['/api/v3'] },
  gitlab: { defaultWebBase: 'https://gitlab.com', apiSuffixes: ['/api/v4'] },
};

/**
 * The web base a provider's git server lives at, from an optional configured `apiBase`.
 *
 * FAIL-CLOSED-TO-THE-PROVIDER, NOT-TO-THE-CONFIGURED-HOST: an `apiBase` that does not carry this
 * provider's API suffix is not this provider's endpoint, so it must not become the git host. Returning
 * it verbatim is what cloned `api.github.com` (and an inherited Forgejo placeholder) instead of the
 * provider's real git host.
 */
function cloneWebBase(host: { defaultWebBase: string; apiSuffixes: readonly string[] }, apiBase: string | undefined): string {
  const configured = (apiBase ?? '').trim().replace(/\/+$/, '');
  if (configured.length === 0) return host.defaultWebBase;
  for (const suffix of host.apiSuffixes) {
    if (configured.endsWith(suffix)) return configured.slice(0, configured.length - suffix.length);
  }
  // Not this provider's API base: the provider's own git host, never another host's API endpoint.
  return host.defaultWebBase;
}

/**
 * `forgejo`'s clone URL, kept as its own function so Forgejo's behaviour and messages are unchanged by
 * the generic {@link deliveryCloneUrl} that now sits in front of it.
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
