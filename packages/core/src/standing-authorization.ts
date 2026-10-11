/**
 * A standing authorization (ADR-045), PIN-ONLY (v1).
 *
 * Today a run is bound to a requirement document a human confirmed interactively (ADR-025, ADR-027), and
 * a NON-TTY confirmation is refused outright — deliberately, because the human gives the criteria and
 * the machine implements. That refusal stays. But it means a person must be at the keyboard twice per
 * run: to write and confirm the requirement, and to adjudicate a failure afterwards.
 *
 * A standing authorization is the second way to produce the SAME token: a human signs, once, a committed
 * file that says which ONE revision of which ONE requirement document may be confirmed by the document's
 * OWN `default:` answers, for which classes of decision. The confirmation still happens; the digest is
 * still the token; the acceptance still binds to it. What changes is who wrote the `chosen:` lines, and
 * what the record says about it.
 *
 * Two properties carry the whole design:
 *
 *   1. IT MAY ONLY NARROW, NEVER WIDEN. The licensable set is fixed in code (`AUTHORIZATION_CLASSES`,
 *      `AUTHORIZATION_POLICIES`); the authorization is a filter over it. A field that would add to it —
 *      a scope over a family of documents, `allowProtectedPaths`, `anyDecision`, `override` — is refused
 *      at load, BY NAME. That is what makes the rule a rule rather than a list somebody maintains.
 *   2. IT LICENSES AN ANSWER THE DOCUMENT ALREADY OFFERS; IT NEVER LICENSES A CHANGE THE DOCUMENT DOES
 *      NOT CONTAIN. The complete set of writes it permits is `chosen:` filled from the decision's own
 *      `default:`, the `confirmation:` block, and — later, and never in v1 — a repair round. The
 *      deliverable contract, the protected paths and the document's own `human: true` markers are out of
 *      reach by construction, not by a list of forbidden cases.
 *
 * v1 is deliberately narrow (the operator's four decisions): PIN-ONLY (one document, never a family);
 * NO extra repair rounds (a failure always stops and asks a human); an explicit `human: true` marker on a
 * decision; and the intake's `checkedAs` placement fixed at its source.
 */

import { parse as parseYaml } from 'yaml';
import { requirementDigest } from './review-digest.js';
import {
  JUDGE_RELATION_VOCABULARY,
  parseDecisionBindings,
  parseRequirements,
  type Decision,
  type DecisionBinding,
} from './requirement-decisions.js';
import { parseFeedback } from './requirement-feedback.js';

/**
 * The class of a decision no declared check exercises (ADR-045 §1). It must be a NON-BLOCKING decision:
 * the validator already refuses a blocking decision nothing checks (ADR-028), so this class can only
 * ever name a decision whose answer is recorded but not yet mechanised.
 */
export const UNMECHANISED_CLASS = 'unmechanised';

/**
 * The classes an authorization may name: the project's own relation vocabulary, plus `unmechanised`.
 * A class outside it is refused at load, the same way a document naming an unimplemented relation is
 * refused (ADR-031) — a class a judge cannot act on is not a class an authorization may default.
 */
export const AUTHORIZATION_CLASSES: readonly string[] = [...JUDGE_RELATION_VOCABULARY, UNMECHANISED_CLASS];

/**
 * The policy vocabulary: one word. `document-default` means accept the decision's own `default:` as its
 * answer. There is no second policy, and no policy that invents an answer — a decision with no `default:`
 * cannot be licensed by it, because a default is an argument and not an absence (ADR-036).
 */
export const AUTHORIZATION_POLICIES = ['document-default'] as const;

/** The ONE failure closure a machine may apply (ADR-045 §6): it changes the implementation, never the requirement. */
export const AUTHORIZATION_FAILURE_CLASSES = ['implementation-changes'] as const;

/** The fields that would WIDEN the licensable set, and why each is refused. */
const WIDENING_FIELDS: Record<string, string> = {
  scope: 'a standing authorization pins ONE document, never a family of them',
  documents: 'a standing authorization pins ONE document, never a list of them',
  paths: 'a standing authorization pins ONE document, never a set of paths',
  allowProtectedPaths: 'a standing authorization never lowers a protected path (ADR-032)',
  allowProtected: 'a standing authorization never lowers a protected path (ADR-032)',
  anyDecision: 'a standing authorization licenses the classes it names, never every decision',
  override: 'a standing authorization never overrides an answer the document already records',
};

/** The failure closures that are a HUMAN's to make, and the reason a machine may not. */
const REFUSED_FAILURE_CLASSES: Record<string, string> = {
  'answer-wrong':
    'it re-decides a decision, i.e. it changes the criteria the human gave, and a machine-written decision would be a decision nobody made (ADR-029)',
  'check-at-fault':
    'it is a CLAIM by a human with a stated basis, and a machine that could declare it would auto-dismiss every failing check (ADR-038)',
  addressed: 'an undifferentiated "somebody said so" is the record ADR-030 replaced',
};

/** The fields a standing authorization is made of. Its shape is CLOSED: an unknown field is refused. */
const AUTHORIZATION_FIELDS: readonly string[] = [
  'id',
  'signedBy',
  'signedAt',
  'expiresAt',
  'revoked',
  'reason',
  'pin',
  'decisions',
  'failures',
];

/** The ONE document revision an authorization licenses. */
export interface AuthorizationPin {
  ref: string;
  digest: string;
}

/** One class the authorization may default, and with which policy. */
export interface AuthorizationGrant {
  class: string;
  policy: string;
}

/** The one failure closure it may act on (v1: never, but it may be declared). */
export interface AuthorizationFailureGrant {
  class: string;
}

export interface StandingAuthorization {
  id: string;
  /** A NAME, not an identity (ADR-018). */
  signedBy: string;
  signedAt: string;
  expiresAt: string;
  revoked: boolean;
  reason: string;
  pin: AuthorizationPin;
  decisions: AuthorizationGrant[];
  failures: AuthorizationFailureGrant[];
}

/** The result of loading an authorization: a value, or the reasons it is refused — never a half-loaded one. */
export interface AuthorizationLoad {
  authorization?: StandingAuthorization;
  issues: string[];
}

/**
 * The digest of an authorization file's text, by the SAME canonicalisation the requirement documents use
 * (CRLF → LF, trailing whitespace stripped): one hash function, one notion of "the same text".
 */
export function authorizationDigest(text: string): string {
  return requirementDigest(text);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** `sha256:<64 hex>` or bare hex → the bare lowercase hex, or undefined when it is not a digest. */
function normalizeDigest(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const hex = value.replace(/^sha256:/i, '').trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

function normalizeRef(ref: string): string {
  return ref.replace(/^\.\//, '').replace(/\/+$/, '');
}

/**
 * Load a standing authorization, refusing anything that would widen the licensable set or that a
 * machine may not decide. Everything refused is refused BY NAME, because a grant a human cannot read
 * the edges of is a grant they cannot revoke with confidence.
 */
export function parseStandingAuthorization(text: string): AuthorizationLoad {
  const issues: string[] = [];
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (e) {
    return { issues: [`the authorization is not valid YAML (${e instanceof Error ? e.message : String(e)})`] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { issues: [`the authorization is not a mapping: it has to declare ${AUTHORIZATION_FIELDS.join(', ')}`] };
  }
  const block = parsed as Record<string, unknown>;

  // A closed shape, and the widening fields named with the reason they are refused rather than as an
  // unknown key: the operator reading the message has to know which rule they ran into.
  for (const key of Object.keys(block)) {
    if (AUTHORIZATION_FIELDS.includes(key)) continue;
    const widening = WIDENING_FIELDS[key];
    issues.push(
      widening === undefined
        ? `the authorization carries "${key}", which is not a field of a standing authorization (fields: ${AUTHORIZATION_FIELDS.join(', ')})`
        : `the authorization carries "${key}", which would WIDEN the licensable set: ${widening}`,
    );
  }

  const id = stringOf(block['id']);
  if (id === undefined || !/^SA-[0-9]{3}$/.test(id)) {
    issues.push('the authorization needs an id of the form SA-nnn: it names the committed file docs/authorizations/<id>.yaml');
  }
  const signedBy = stringOf(block['signedBy']);
  if (signedBy === undefined) {
    issues.push('the authorization names no signedBy: a name, not an identity (ADR-018) — but a name, so a reader can ask');
  }
  const signedAt = stringOf(block['signedAt']);
  if (signedAt === undefined) issues.push('the authorization names no signedAt');
  const expiresAt = stringOf(block['expiresAt']);
  if (expiresAt === undefined) {
    issues.push('the authorization has no expiresAt: an authorization that never expires is refused');
  }
  const reason = stringOf(block['reason']);
  if (reason === undefined) {
    issues.push('the authorization states no reason: a grant whose intent nobody can read is a grant nobody can revoke with confidence');
  }
  const revokedRaw = block['revoked'];
  if (revokedRaw !== undefined && typeof revokedRaw !== 'boolean') {
    issues.push(`the authorization declares revoked: ${JSON.stringify(revokedRaw)}, which is not true or false`);
  }

  let pin: AuthorizationPin | undefined;
  const rawPin = block['pin'];
  if (rawPin === null || typeof rawPin !== 'object' || Array.isArray(rawPin)) {
    issues.push('the authorization has no pin: it pins exactly ONE document ({ref, digest}), and that document is the only thing it may confirm');
  } else {
    const entry = rawPin as Record<string, unknown>;
    const ref = stringOf(entry['ref']);
    const digest = normalizeDigest(stringOf(entry['digest']));
    if (ref === undefined) issues.push('the authorization pin names no ref');
    if (digest === undefined) {
      issues.push('the authorization pin names no digest: it is the sha256 of the document AS IT WAS REVIEWED, so the revision a human read is the revision that gets defaulted');
    }
    if (ref !== undefined && digest !== undefined) pin = { ref, digest };
  }

  const decisions: AuthorizationGrant[] = [];
  const rawDecisions = block['decisions'];
  if (!Array.isArray(rawDecisions) || rawDecisions.length === 0) {
    issues.push('the authorization grants no decision classes: a grant with nothing in it confirms nothing');
  } else {
    const seen = new Set<string>();
    rawDecisions.forEach((raw, index) => {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        issues.push(`decisions[${index + 1}] is not a mapping of class and policy`);
        return;
      }
      const entry = raw as Record<string, unknown>;
      const cls = stringOf(entry['class']);
      // The policy vocabulary is ONE word (ADR-045 §1): `document-default`. Because there is no second
      // policy, an omitted `policy` is not ambiguous — it IS `document-default` — so it is filled in
      // rather than refused, and only a policy that is present and is not that word is refused by name.
      const policy = stringOf(entry['policy']) ?? AUTHORIZATION_POLICIES[0];
      if (cls === undefined) {
        issues.push(`decisions[${index + 1}] names no class`);
        return;
      }
      if (!AUTHORIZATION_CLASSES.includes(cls)) {
        issues.push(
          `the authorization grants the class "${cls}", which no judge can act on (implemented: ${AUTHORIZATION_CLASSES.join(', ')}): a class outside the vocabulary is refused the same way a document naming an unimplemented relation is (ADR-031)`,
        );
        return;
      }
      if (seen.has(cls)) {
        issues.push(`the authorization grants the class "${cls}" twice: one class, one policy`);
        return;
      }
      seen.add(cls);
      if (policy === undefined || !(AUTHORIZATION_POLICIES as readonly string[]).includes(policy)) {
        issues.push(
          `the authorization grants "${cls}" with the policy ${policy === undefined ? '(none)' : `"${policy}"`}: the only policy is ${AUTHORIZATION_POLICIES.join(', ')}, and no policy invents an answer`,
        );
        return;
      }
      decisions.push({ class: cls, policy });
    });
  }

  const failures: AuthorizationFailureGrant[] = [];
  const rawFailures = block['failures'];
  if (rawFailures !== undefined) {
    if (!Array.isArray(rawFailures)) {
      issues.push('the failures block is not a list of classes');
    } else {
      rawFailures.forEach((raw, index) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          issues.push(`failures[${index + 1}] is not a mapping of class`);
          return;
        }
        const entry = raw as Record<string, unknown>;
        const cls = stringOf(entry['class']);
        if (cls === undefined) {
          issues.push(`failures[${index + 1}] names no class`);
          return;
        }
        if (Object.prototype.hasOwnProperty.call(entry, 'maxRounds')) {
          issues.push(
            `the authorization grants maxRounds for "${cls}": a standing authorization may not spend repair rounds (v1) — when the run's own bounded rounds are exhausted the failure stops and asks a human (ADR-034)`,
          );
          return;
        }
        // The two vocabularies are DISJOINT: a class is either a decision class (something a judge can
        // act on, from JUDGE_RELATION_VOCABULARY ∪ {unmechanised}) or the one failure closure a machine
        // may apply — never both. A class that appears in both lists is the same class granted twice,
        // and a grant a reader cannot tell the role of is a grant they cannot revoke with confidence.
        if (decisions.some((grant) => grant.class === cls)) {
          issues.push(
            `the authorization grants the class "${cls}" twice: it is already granted as a decision class and is named again as a failure class, and one class cannot hold two roles`,
          );
          return;
        }
        if (cls !== 'implementation-changes') {
          const why = REFUSED_FAILURE_CLASSES[cls];
          issues.push(
            why === undefined
              ? `the authorization names the failure class "${cls}", which is not a closure a machine may apply (implementable: ${AUTHORIZATION_FAILURE_CLASSES.join(', ')})`
              : `the authorization names the failure class "${cls}", which a machine may never apply: ${why}`,
          );
          return;
        }
        failures.push({ class: cls });
      });
    }
  }

  if (issues.length > 0) return { issues };
  return {
    authorization: {
      id: id as string,
      signedBy: signedBy as string,
      signedAt: signedAt as string,
      expiresAt: expiresAt as string,
      revoked: revokedRaw === true,
      reason: reason as string,
      pin: pin as AuthorizationPin,
      decisions,
      failures,
    },
    issues: [],
  };
}

/** The class of a decision: the relation kind that settles it, or `unmechanised` (ADR-045 §1). */
export function decisionClass(decisionId: string, bindings: readonly DecisionBinding[]): string {
  const binding = bindings.find((b) => b.decides === decisionId);
  return binding?.relation ?? UNMECHANISED_CLASS;
}

/** One decision the authorization answered, and what nobody read. */
export interface DefaultedDecision {
  id: string;
  question: string;
  chosen: string;
  class: string;
  policy: string;
  checkedAs?: string;
}

/** What the licence check found: the decisions it may default, or why it may not confirm at all. */
export interface StandingLicence {
  defaulted: DefaultedDecision[];
  refusals: string[];
}

export interface StandingLicenceInput {
  authorization: StandingAuthorization;
  /** The document's ref as the command was given it. */
  documentRef: string;
  documentText: string;
  /** The clock, injectable so expiry is testable without waiting. */
  now?: Date;
}

/**
 * Decide whether this authorization may confirm this document (ADR-045 §2), and what it would default.
 *
 * It is ALL-OR-NOTHING, as ADR-027's rule 3 is: nothing is written unless the last check passes, so a
 * document that fails any condition is left byte-identical and produces no token. The refusal is the
 * feature — a decision outside the scope STOPS the confirmation and asks; it never falls back to a
 * default.
 */
export function licenseStandingConfirmation(input: StandingLicenceInput): StandingLicence {
  const { authorization } = input;
  const refusals: string[] = [];
  const now = input.now ?? new Date();

  // The pin first: it licenses ONE revision of ONE document, and a check about decisions is meaningless
  // once the document is not the one that was signed.
  if (normalizeRef(authorization.pin.ref) !== normalizeRef(input.documentRef)) {
    refusals.push(
      `the authorization pins "${authorization.pin.ref}", and this document is "${input.documentRef}": a standing authorization confirms the one document it pins, never a family`,
    );
  }
  const digest = requirementDigest(input.documentText);
  if (digest !== authorization.pin.digest) {
    refusals.push(
      `the document has changed since the authorization was signed: the pin is sha256:${authorization.pin.digest} and "${input.documentRef}" now hashes to sha256:${digest} — read the document again and sign a new pin`,
    );
  }
  if (authorization.revoked) {
    refusals.push(`the authorization ${authorization.id} is revoked (revoked: true, a commit): a human confirms from a terminal`);
  }
  const expiresAt = Date.parse(authorization.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
    refusals.push(`the authorization ${authorization.id} expired at ${authorization.expiresAt}: an authorization that is over is not an authorization`);
  }
  if (refusals.length > 0) return { defaulted: [], refusals };

  const decisions = parseRequirements(input.documentText);
  const bindings = parseDecisionBindings(input.documentText);
  const granted = new Map(authorization.decisions.map((grant) => [grant.class, grant.policy]));
  const defaulted: DefaultedDecision[] = [];

  for (const decision of decisions) {
    // A decision that already carries an answer is a HUMAN's answer and is left exactly as it is: the
    // authorization has no path that rewrites a recorded answer (ADR-045 §2).
    if (decision.chosen !== undefined) continue;
    if (decision.human === true) {
      refusals.push(`${decision.id} is marked human: true — the document says a person decides it, and an authorization cannot unsay that`);
      continue;
    }
    const cls = decisionClass(decision.id, bindings);
    const policy = granted.get(cls);
    if (policy === undefined) {
      const names = authorization.decisions.map((grant) => grant.class).join(', ');
      refusals.push(`${decision.id} (${cls}) — class not in the authorization's decisions (granted: ${names.length === 0 ? 'none' : names})`);
      continue;
    }
    if (decision.default === undefined) {
      refusals.push(`${decision.id} — no default: a default is an argument, and where there is no argument a human makes one (ADR-036)`);
      continue;
    }
    defaulted.push({
      id: decision.id,
      question: decision.question,
      chosen: decision.default,
      class: cls,
      policy,
      ...(decision.checkedAs === undefined ? {} : { checkedAs: decision.checkedAs }),
    });
  }

  // The second moment, refused in v1: a failure is never a machine's to close here. Closing
  // `implementation-changes` means re-entering the repair loop, and v1 spends no repair rounds — so an
  // open failure stops the confirmation and asks, rather than being waved through by the default path.
  for (const entry of parseFeedback(input.documentText)) {
    if (entry.status !== 'open') continue;
    refusals.push(
      `${entry.id} is an open acceptance failure: a standing authorization may not close it (v1 spends no repair rounds and writes no resolution) — a human confirms from a terminal`,
    );
  }

  if (refusals.length > 0) return { defaulted: [], refusals };
  return { defaulted, refusals };
}

/** The authorization an authorization-confirmed document cites: the file, and the grant behind it. */
export interface ConfirmedAuthorization {
  ref: string;
  digest: string;
  signedBy: string;
  signedAt: string;
  expiresAt: string;
}

/**
 * HOW a requirement document was confirmed (ADR-045 §4), read from the document itself.
 *
 * The three modes are distinguishable and the two that matter are disjoint: `interactive` (a human
 * answered), `standing-authorization` (a signed grant defaulted it, and `defaulted` names every answer
 * nobody read), and `digest-only` (a digest approved out of band, ADR-025 — `by` and `method` are null
 * and the reason is stated, rather than folding it into one of the other two).
 */
export interface RequirementConfirmation {
  mode: 'interactive' | 'standing-authorization' | 'digest-only';
  by: string | null;
  at: string | null;
  method: string | null;
  authorization: ConfirmedAuthorization | null;
  defaulted: DefaultedDecision[];
}

const DIGEST_ONLY: RequirementConfirmation = {
  mode: 'digest-only',
  by: null,
  at: null,
  method: null,
  authorization: null,
  defaulted: [],
};

/** The authorization citation a confirmation block carries: the mapping form, or the `ref@sha256:…` form. */
function parseAuthorizationCitation(raw: unknown): ConfirmedAuthorization | null {
  if (typeof raw === 'string') {
    const at = raw.lastIndexOf('@sha256:');
    const ref = at === -1 ? raw : raw.slice(0, at);
    const digest = at === -1 ? '' : raw.slice(at + '@sha256:'.length).trim().toLowerCase();
    return ref.length === 0 ? null : { ref, digest, signedBy: '', signedAt: '', expiresAt: '' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  const ref = stringOf(entry['ref']);
  if (ref === undefined) return null;
  return {
    ref,
    digest: normalizeDigest(stringOf(entry['digest'])) ?? '',
    signedBy: stringOf(entry['signedBy']) ?? '',
    signedAt: stringOf(entry['signedAt']) ?? '',
    expiresAt: stringOf(entry['expiresAt']) ?? '',
  };
}

/** The `defaulted:` list a confirmation block carries: mappings, or bare `AMB-nnn` ids. */
function parseDefaulted(raw: unknown): DefaultedDecision[] {
  if (!Array.isArray(raw)) return [];
  const entries: DefaultedDecision[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.length > 0) {
      entries.push({ id: item, question: '', chosen: '', class: '', policy: '' });
      continue;
    }
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const id = stringOf(entry['id']);
    if (id === undefined) continue;
    entries.push({
      id,
      question: stringOf(entry['question']) ?? '',
      chosen: stringOf(entry['chosen']) ?? '',
      class: stringOf(entry['class']) ?? '',
      policy: stringOf(entry['policy']) ?? '',
      ...(stringOf(entry['checkedAs']) === undefined ? {} : { checkedAs: stringOf(entry['checkedAs']) }),
    });
  }
  return entries;
}

/**
 * Read the `confirmation:` block out of a requirement document. A document with no block (or one that
 * cannot be read) is `digest-only` — the honest third case — never one of the other two by default.
 */
export function readRequirementConfirmation(text: string): RequirementConfirmation {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return { ...DIGEST_ONLY, defaulted: [] };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DIGEST_ONLY, defaulted: [] };
  const block = (parsed as Record<string, unknown>)['confirmation'];
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return { ...DIGEST_ONLY, defaulted: [] };
  const entry = block as Record<string, unknown>;
  const method = stringOf(entry['method']) ?? null;
  const authorization = parseAuthorizationCitation(entry['authorization']);
  const defaulted = parseDefaulted(entry['defaulted']);
  return {
    mode: method === 'standing-authorization' && authorization !== null ? 'standing-authorization' : 'interactive',
    by: stringOf(entry['by']) ?? null,
    at: stringOf(entry['at']) ?? null,
    method,
    authorization,
    defaulted,
  };
}
