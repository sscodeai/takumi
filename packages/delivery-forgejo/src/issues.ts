/**
 * The issue surface for the same Forgejo/Gitea host.
 *
 * WHY THIS IS A SEPARATE MODULE (and not a method on the delivery port): the
 * delivery port (ADR-007) models "how a committed change reaches the host" — a
 * pull request, checks, a merge. An ISSUE is a different capability: the
 * black-box flow needs to file a report on the host and to comment on the pull
 * request it opened, and neither belongs in the port's vocabulary. Adding an
 * issue operation to `DeliveryProvider` would have forced every other delivery
 * adapter (a bare git remote included) to lie about supporting issues.
 *
 * So these are exported FUNCTIONS over the same {@link ForgejoTarget}, and the
 * provider exposes them as extra convenience methods that delegate here.
 * `packages/core` is not modified.
 *
 * HONEST LIMITS:
 *
 *   1. Forgejo's create-issue API takes LABEL IDS, not label names. A string in
 *      `labels` is therefore resolved against the repository's labels first; an
 *      unknown name is a `precondition` failure rather than a silently dropped
 *      label.
 *   2. One page per list call: the request seam exposes a status and a body but
 *      no response headers, so label pagination cannot be followed. The label
 *      lookup asks for the host's maximum page and is documented here.
 */

import { DeliveryError, type PullRequestRef } from '@takumi/core';
import {
  forgejoJson,
  repoUrl,
  resolveForgejoTarget,
  snip,
  type ForgejoTarget,
  type ForgejoTargetOptions,
} from './transport.js';

export interface ForgejoIssueInput {
  title: string;
  body: string;
  /** Label ids, or label names that are resolved against the repository first. */
  labels?: Array<number | string>;
}

/** What {@link openForgejoIssue} returns: the host's own issue identity. */
export interface ForgejoIssueRef {
  number: string;
  url: string;
}

/** What {@link commentOnForgejoPullRequest} returns. */
export interface ForgejoCommentRef {
  id: string;
  url: string;
}

/** The subset of Forgejo's issue JSON this module reads. */
interface ForgejoIssuePayload {
  number?: number;
  html_url?: string | null;
}

/** The subset of Forgejo's comment JSON this module reads. */
interface ForgejoCommentPayload {
  id?: number;
  html_url?: string | null;
}

/** The subset of Forgejo's label JSON this module reads. */
interface ForgejoLabelPayload {
  id?: number;
  name?: string | null;
}

const LABEL_PAGE_SIZE = 50;

/**
 * Open an issue and return its number and URL.
 *
 * `number` is the host's issue index (a number in the API, returned as a string
 * here so a caller never has to reason about Forgejo's integer width).
 */
export async function openForgejoIssue(
  options: ForgejoTargetOptions,
  input: ForgejoIssueInput,
): Promise<ForgejoIssueRef> {
  const target = resolve(options);
  const title = input.title.trim();
  if (title.length === 0) {
    throw new DeliveryError('precondition', 'openForgejoIssue: `title` is required');
  }
  const labelIds = await resolveLabelIds(target, input.labels);
  const issue = await forgejoJson<ForgejoIssuePayload>(
    target,
    {
      method: 'POST',
      url: `${repoUrl(target)}/issues`,
      body: {
        title,
        body: input.body,
        ...(labelIds.length === 0 ? {} : { labels: labelIds }),
      },
    },
    'create issue',
  );
  const number = issue.number;
  if (typeof number !== 'number' || !Number.isInteger(number)) {
    throw new DeliveryError('transport', `Forgejo answered with an issue that carries no number: ${snip(JSON.stringify(issue))}`);
  }
  return { number: String(number), url: issue.html_url ?? '' };
}

/**
 * Comment on a pull request.
 *
 * A pull request is an issue on Forgejo's API, so the comment endpoint is the
 * issue-comment one under the pull request's index. `ref` accepts a
 * {@link PullRequestRef} or anything with a `number`.
 */
export async function commentOnForgejoPullRequest(
  options: ForgejoTargetOptions,
  ref: Pick<PullRequestRef, 'number'> | { number: string },
  body: string,
): Promise<ForgejoCommentRef> {
  const target = resolve(options);
  const index = String(ref.number).trim();
  if (index.length === 0) {
    throw new DeliveryError('precondition', 'commentOnForgejoPullRequest: the pull request number is required');
  }
  const comment = await forgejoJson<ForgejoCommentPayload>(
    target,
    {
      method: 'POST',
      url: `${repoUrl(target)}/issues/${encodeURIComponent(index)}/comments`,
      body: { body },
    },
    `comment on pull request ${index}`,
    index,
  );
  const id = comment.id;
  if (typeof id !== 'number' || !Number.isInteger(id)) {
    throw new DeliveryError('transport', `Forgejo answered with a comment that carries no id: ${snip(JSON.stringify(comment))}`, {
      item: index,
    });
  }
  return { id: String(id), url: comment.html_url ?? '' };
}

/** Resolve label names to ids, passing numeric ids through untouched. */
async function resolveLabelIds(target: ForgejoTarget, labels: Array<number | string> | undefined): Promise<number[]> {
  if (labels === undefined || labels.length === 0) return [];
  const ids: number[] = [];
  const names: string[] = [];
  for (const label of labels) {
    if (typeof label === 'number') {
      if (!Number.isInteger(label)) {
        throw new DeliveryError('precondition', `openForgejoIssue: label id must be an integer, got ${String(label)}`);
      }
      ids.push(label);
    } else {
      const name = label.trim();
      if (name.length === 0) continue;
      names.push(name);
    }
  }
  if (names.length === 0) return ids;

  const available = await forgejoJson<ForgejoLabelPayload[]>(
    target,
    { method: 'GET', url: `${repoUrl(target)}/labels?limit=${LABEL_PAGE_SIZE}` },
    'list repository labels',
  );
  for (const name of names) {
    const found = available.find((label) => label.name === name);
    if (found === undefined || typeof found.id !== 'number') {
      const known = available.map((label) => label.name).filter((n): n is string => typeof n === 'string');
      throw new DeliveryError(
        'precondition',
        `openForgejoIssue: label ${JSON.stringify(name)} does not exist on ${target.owner}/${target.repo}` +
          (known.length === 0 ? ' (the repository has no labels)' : ` (known: ${known.join(', ')})`),
      );
    }
    ids.push(found.id);
  }
  return ids;
}

/** Resolve the target the same way the provider does, without constructing a provider. */
function resolve(options: ForgejoTargetOptions): ForgejoTarget {
  return resolveForgejoTarget(options);
}
