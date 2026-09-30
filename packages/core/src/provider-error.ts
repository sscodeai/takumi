/**
 * The error vocabulary shared by every provider port.
 *
 * A board provider and a delivery provider fail in the same few ways, and a
 * caller must be able to react to the KIND of failure without knowing which
 * board or host produced it. Keeping one taxonomy module means the two ports
 * cannot drift apart, and `retriable` stays a single rule: only `transport`
 * failures are worth another attempt on the next tick — everything else is a
 * decision, not a hiccup.
 */

export type ProviderErrorKind = 'auth' | 'transport' | 'precondition' | 'not_found' | 'unsupported';

export interface ProviderErrorOptions {
  /** The work item / pull request / resource the failure concerns. */
  item?: string;
  cause?: unknown;
}

/** A classified provider failure. `kind` is what callers branch on. */
export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly item?: string;

  constructor(kind: ProviderErrorKind, message: string, opts?: ProviderErrorOptions) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'ProviderError';
    this.kind = kind;
    if (opts?.item !== undefined) this.item = opts.item;
  }

  /** True when retrying on a later tick is a sane reaction. */
  get retriable(): boolean {
    return this.kind === 'transport';
  }
}

/** True when the failure means "this provider cannot do that at all". */
export function isUnsupported(error: unknown): boolean {
  return error instanceof ProviderError && error.kind === 'unsupported';
}

/** True when retrying later could plausibly succeed. */
export function isRetriable(error: unknown): boolean {
  return error instanceof ProviderError && error.retriable;
}
