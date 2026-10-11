/**
 * The HTTP seam and the URL vocabulary for the Forgejo/Gitea REST v1 API.
 *
 * WHY a separate module: the delivery provider (a pull request + checks + merge)
 * and the issue surface (`openForgejoIssue` / `commentOnForgejoPullRequest`) are
 * two different capabilities on the SAME host, and the delivery port in core has
 * no issue operation. Keeping the transport and the target resolution here means
 * the issue functions are a SEPARATE export that reuses the same seam without
 * core ever learning that issues exist.
 *
 * Everything that performs I/O goes through an injected {@link BoardRequestFn}
 * (core's HTTP seam). The default is `curl` carrying the Forgejo token in the
 * `Authorization: token <PAT>` header — the same header the operator would send
 * by hand. Because the seam is injectable, the provider and the issue functions
 * are provable with ZERO network and ZERO credentials.
 *
 * The token is read lazily, at the one place that actually performs I/O, so a
 * rotated token is picked up between calls and the token never sits in a field
 * that could be logged.
 */

import {
  classifyBoardHttpStatus,
  createCurlRequestFn,
  DeliveryError,
  unconfiguredRequestFn,
  type BoardHttpRequest,
  type BoardHttpResponse,
  type BoardRequestFn,
  type DeliveryErrorKind,
} from '@takumi/core';

/** The Forgejo default when a self-hosted instance runs on its documented port. */
export const FORGEJO_DEFAULT_API_BASE = 'http://localhost:3000/api/v1';

/** The name used in fail-closed transport errors (the manifest `name`). */
export const FORGEJO_PROVIDER_LABEL = 'forgejo-delivery';

/** Forgejo's own token variable, with Gitea's as the historical fallback. */
const TOKEN_ENV = ['FORGEJO_TOKEN', 'GITEA_TOKEN'] as const;

// --- the HTTP seam ---------------------------------------------------------

export interface ForgejoTransportOptions {
  /** Personal access token; falls back to `FORGEJO_TOKEN`, then `GITEA_TOKEN`. */
  token?: string;
  /** Per-request timeout in seconds (default 30, applied by `curl -m`). */
  timeoutSeconds?: number;
  /** Override the curl binary (tests may point at a stub). */
  curlBinary?: string;
}

/**
 * The default transport: `curl` carrying Forgejo's `Authorization: token <PAT>`
 * header.
 *
 * The header is built lazily so the token is read per call, never captured at
 * construction time, and never placed in argv (`createCurlRequestFn` sends the
 * headers on stdin via `-K -` so they cannot be read from `ps`).
 */
export function createForgejoTransport(options: ForgejoTransportOptions = {}): BoardRequestFn {
  const token = options.token ?? readTokenFromEnv();
  return createCurlRequestFn({
    headers: () => {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (token !== undefined && token.length > 0) headers['Authorization'] = `token ${token}`;
      return headers;
    },
    ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
    ...(options.curlBinary === undefined ? {} : { curlBinary: options.curlBinary }),
  });
}

/** Read the token from the environment, treating a blank value as absent. */
export function readTokenFromEnv(): string | undefined {
  for (const name of TOKEN_ENV) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

// --- the target (owner/repo + transport) -----------------------------------

export interface ForgejoTargetOptions {
  /** Repository owner: a user or an organization (e.g. `dev`). */
  owner: string;
  /** Repository name (e.g. `takumi-delivery-selftest`). */
  repo: string;
  /** API base, default {@link FORGEJO_DEFAULT_API_BASE}. */
  apiBase?: string;
  /** Access token; falls back to the environment. */
  token?: string;
  /** Injected request function (tests). Without it a token is required. */
  request?: BoardRequestFn;
}

/** A resolved Forgejo host: the repository and the one seam that talks to it. */
export interface ForgejoTarget {
  owner: string;
  repo: string;
  apiBase: string;
  request: BoardRequestFn;
}

/** Validate the owner/repo pair the way the REST paths need it. */
export function assertForgejoTargetOptions(options: ForgejoTargetOptions): void {
  for (const key of ['owner', 'repo'] as const) {
    const value = options[key];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new DeliveryError('precondition', `Forgejo: \`${key}\` is required (e.g. "dev")`);
    }
    if (/[/\s]/.test(value.trim())) {
      throw new DeliveryError('precondition', `Forgejo: \`${key}\` must be a single path segment, got ${JSON.stringify(value)}`);
    }
  }
  if (options.apiBase !== undefined && options.apiBase.trim().replace(/\/+$/, '').length === 0) {
    throw new DeliveryError('precondition', 'Forgejo: `apiBase` must not be empty');
  }
}

/**
 * Resolve a target: normalise the API base and pick the transport.
 *
 * Fail closed: with no injected request and no token there is nothing to
 * authenticate with, and an unconfigured transport is an explicit `auth` error
 * instead of an anonymous call against a private repository.
 */
export function resolveForgejoTarget(options: ForgejoTargetOptions): ForgejoTarget {
  assertForgejoTargetOptions(options);
  const apiBase = (options.apiBase ?? FORGEJO_DEFAULT_API_BASE).trim().replace(/\/+$/, '');
  const token = options.token ?? readTokenFromEnv();
  const request =
    options.request ??
    (token === undefined ? unconfiguredRequestFn(FORGEJO_PROVIDER_LABEL) : createForgejoTransport({ token }));
  return { owner: options.owner.trim(), repo: options.repo.trim(), apiBase, request };
}

/** The `/repos/{owner}/{repo}` prefix every endpoint of this host hangs off. */
export function repoUrl(target: ForgejoTarget): string {
  return `${target.apiBase}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
}

// --- JSON requests with the delivery error vocabulary ----------------------

/** Classify a non-2xx response. 405 is a refusal for THIS request, never "unsupported". */
export function forgejoErrorKind(status: number): DeliveryErrorKind {
  return classifyBoardHttpStatus(status);
}

/** Build the classified delivery error for a non-2xx response (body redacted to one line). */
export function forgejoErrorFromResponse(res: BoardHttpResponse, what: string, item?: string): DeliveryError {
  const kind = forgejoErrorKind(res.status);
  const detail = res.body.trim().replace(/\s+/g, ' ').slice(0, 300);
  return new DeliveryError(kind, `${what} failed with HTTP ${res.status}${detail ? `: ${detail}` : ''}`, {
    ...(item === undefined ? {} : { item }),
  });
}

/** Send a request and require 2xx, returning the parsed JSON body. */
export async function forgejoJson<T>(
  target: ForgejoTarget,
  req: BoardHttpRequest,
  what: string,
  item?: string,
): Promise<T> {
  let res: BoardHttpResponse;
  try {
    res = await target.request(req);
  } catch (e) {
    // The transport seam fails in its own vocabulary (`BoardError`/`ProviderError`
    // — e.g. an unconfigured transport, or a curl that could not start). A caller
    // of THIS port must never have to catch two error families, so the failure is
    // re-classified into `DeliveryError` with the same kind.
    if (e instanceof DeliveryError) throw e;
    const rawKind = (e as { kind?: unknown }).kind;
    const kind: DeliveryErrorKind = typeof rawKind === 'string' ? (rawKind as DeliveryErrorKind) : 'transport';
    throw new DeliveryError(kind, e instanceof Error ? e.message : String(e), {
      ...(item === undefined ? {} : { item }),
      cause: e,
    });
  }
  if (res.status < 200 || res.status >= 300) throw forgejoErrorFromResponse(res, what, item);
  try {
    return JSON.parse(res.body) as T;
  } catch (e) {
    throw new DeliveryError(
      'transport',
      `${what} returned a non-JSON body (HTTP ${res.status}): ${e instanceof Error ? e.message : String(e)}`,
      { ...(item === undefined ? {} : { item }) },
    );
  }
}

/** One-line, length-bounded description of a response body, for an error message. */
export function snip(text: string, limit = 200): string {
  const oneLine = text.trim().replace(/\s+/g, ' ');
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit)}…`;
}
