/**
 * The deterministic reviewer: rules that decide whether a change may be merged
 * unattended, run against what actually happened between the frozen base and the
 * delivered head.
 *
 * WHY RULES AND NOT A MODEL (first): a model reviewer is a second opinion whose failure
 * mode is "it said it was fine". These rules are the opposite: each one is a fact about
 * the diff, each one is testable, and none of them needs a token budget or a credential.
 * They exist because a check-only pipeline can be satisfied the wrong way — an agent that
 * deletes the failing test, skips it, or loosens its assertion turns CI green while making
 * the repository worse. That is the one failure that no CI can catch, because CI is what it
 * is gaming.
 *
 * PURE BY DESIGN: no git, no filesystem, no clock — content arrives as `baseContent` /
 * `headContent`. The plumbing that reads git lives in `review.ts`, so every rule here can
 * be tested with two strings.
 */

/** How a file differs between the base and the head. */
export interface ReviewFileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  /**
   * The path this file came from, for a rename.
   *
   * Its content at the base lives at THAT path: reading the new one would fail for exactly
   * the files that were renamed, which is how a reviewer ends up failing closed on
   * ordinary work.
   */
  previousPath?: string;
  /** Content at the frozen base; null when the file did not exist there. */
  baseContent: string | null;
  /** Content at the delivered head; null when the file does not exist there. */
  headContent: string | null;
}

/** Everything the rules are allowed to look at. */
export interface ReviewInput {
  baseSha: string;
  headSha: string;
  changes: readonly ReviewFileChange[];
  /**
   * The AMB-nnn ids the CONFIRMED requirement document carries (ADR-060, ledger #96).
   *
   * An unattended delivery answers decisions nobody read: a signed standing authorization takes the
   * document's own `default:` for them (ADR-045), and that fact lives in the document's front matter,
   * not in the code the delivery writes. An operator reviewing overnight then has a delivery whose
   * behaviour was partly chosen by a machine, with no way to find WHICH parts without reconstructing
   * the run. This field is what lets a deterministic rule ask for the anchors that close that gap.
   *
   * Absent means the caller is not a delivery of a requirement document (a review of something else),
   * so the rule that consumes it does not fire.
   */
  decisionIds?: readonly string[];
}

/**
 * What a finding demands:
 *
 * - `block` — a defect the AGENT must answer in a fix round (a weakened test is a bad fix,
 *   and the agent that wrote it is the one who can restore it honestly).
 * - `human` — a decision a machine may not make and an agent may not undo: the change is
 *   real and legitimate (a dependency bump, a CI tweak), so "fix it" would mean "revert
 *   legitimate work". The item WAITS for a person instead of burning rounds.
 * - `note` — an observation recorded next to the verdict, gating nothing.
 */
export type ReviewSeverity = 'block' | 'human' | 'note';

/**
 * Identity of the built-in rule set (ADR-018). A review digest binds to THIS string, and a test
 * asserts the engine's actual rule ids match the documented set — so adding a rule without bumping
 * the identity fails the build instead of silently changing what a past approval meant.
 */
export const REVIEW_RULESET_ID = 'rules@2';

export interface ReviewFinding {
  /** Stable rule id, so a board comment and a test can name the same thing. */
  rule: string;
  severity: ReviewSeverity;
  path?: string;
  /**
   * Line in the HEAD content, when the rule can point at one. A finding a person can locate is a
   * finding they can act on (and it is what a diff-anchored comment would need).
   */
  line?: number;
  detail: string;
}

export interface ReviewRules {
  /**
   * Forbid weakening the tests (deleted files, new skips, fewer assertions). ON by
   * default: a green pipeline that was bought by weakening its own proof is the failure
   * this reviewer exists for.
   */
  forbidTestWeakening?: boolean;
  /**
   * Paths whose change a machine may not wave through: CI configuration, dependency
   * manifests, the container build, takumi's own configuration. ADDED to the defaults;
   * pass `replaceProtectedPaths` to take over the list entirely.
   */
  protectedPaths?: readonly string[];
  /** Use ONLY `protectedPaths`, not the defaults. */
  replaceProtectedPaths?: boolean;
  /** Extra test-file patterns (regex sources), added to the defaults. */
  testPathPatterns?: readonly string[];
  /** What a change to a test FILE means, when the implementation did not change. */
  testOnlyChange?: 'note' | 'block' | 'ignore';
}

/**
 * The default notion of "a test file", across the languages this project has met so far.
 * Deliberately path-based: a rule that has to parse five languages is a rule nobody can
 * reason about at 3am, and a missed test file only means a finding is not raised, which is
 * the same posture as CI itself.
 */
const DEFAULT_TEST_PATTERNS: readonly string[] = [
  '(^|/)(tests?|spec|__tests__)/',
  '\\.(test|spec)\\.[A-Za-z0-9]+$',
  '(^|/)test_[^/]+\\.[A-Za-z0-9]+$',
  '_test\\.[A-Za-z0-9]+$',
  '(^|/)Test[^/]*\\.(java|kt|cs)$',
  '[^/]*Tests?\\.(java|kt|cs)$',
  '(^|/)conftest\\.py$',
];

/**
 * Paths a DELIVERY may never contain, however it got there. The protected-path rule covers a change to
 * something that already EXISTED (protection) and deliberately downgrades a CREATED protected path to a
 * note, because a delivery's worktree starts empty and a stack choice is written down in exactly those
 * files. A grant is not a stack choice: a delivery has no legitimate reason to create one, and a copy of
 * the PLATFORM's own authorization inside a target repository is a leak of the platform's internals and of
 * the operator's identity into a repository this run does not own. Measured 2026-10-13 (round 13,
 * ledger #87): a delivery did exactly that and the review reported it as a note, so the review passed.
 */
const NEVER_DELIVERED_PATTERNS: readonly string[] = ['(^|/)docs/authorizations/'];

const DEFAULT_PROTECTED_PATTERNS: readonly string[] = [
  '(^|/)\\.github/workflows/',
  '(^|/)\\.gitlab-ci\\.ya?ml$',
  '(^|/)Dockerfile(\\..*)?$',
  '(^|/)package\\.json$',
  '(^|/)pnpm-lock\\.ya?ml$',
  '(^|/)package-lock\\.json$',
  '(^|/)go\\.mod$',
  '(^|/)go\\.sum$',
  '(^|/)requirements[^/]*\\.txt$',
  '(^|/)pyproject\\.toml$',
  '(^|/)pom\\.xml$',
  '(^|/)build\\.gradle(\\.kts)?$',
  '(^|/)Cargo\\.(toml|lock)$',
  '(^|/)takumi\\.ya?ml$',
  '(^|/)\\.takumi/',
  // ADR-045: a run may never author, edit or revoke its OWN authorization. The grant that lets a
  // document be defaulted non-interactively is a human's artefact, and a machine that could rewrite it
  // would be widening its own reach — so `docs/authorizations/` is a protected path like CI config or a
  // dependency manifest, and a change to it is a `human` finding (ADR-032).
  '(^|/)docs/authorizations/',
];

/** Markers that silence a test rather than fix it, across the harnesses we have seen. */
const SKIP_MARKERS: readonly string[] = [
  'describe.skip',
  'it.skip',
  'test.skip',
  '\\bxit\\(',
  '\\bxdescribe\\(',
  '@Ignore',
  '@Disabled',
  'pytest.mark.skip',
  'pytest.skip\\(',
  't.Skip\\(',
  'SkipTest',
  '@unittest.skip',
  '\\bxfail\\b',
];

/**
 * What counts as an assertion. A COUNT of these, compared before and after, is a
 * deliberate heuristic: it cannot prove a test still means what it meant, but a test file
 * that lost assertions while gaining a green pipeline is the shape of the failure worth
 * catching. The false-positive direction (a refactor that adds a helper) is handled by the
 * finding being a defect the agent may answer rather than a permanent block.
 */
const ASSERTION_MARKERS: readonly string[] = [
  '\\bassert[A-Z_(]',
  '\\bassert\\b',
  '\\bexpect\\(',
  '\\bshould\\b',
  '\\brequire\\.[A-Z]',
  '\\bAssert\\.',
  '\\bassertEquals?\\(',
  '\\bassertThat\\(',
  '\\bto\\.(be|equal|throw)',
];

/**
 * Is this path a test file, by the same patterns the rules use?
 *
 * Exported so the plumbing (which decides whose content to read) and the rules (which
 * decide what a change means) can never disagree about what a test file is.
 */
export function isTestPath(path: string, extraPatterns: readonly string[] = []): boolean {
  return matchesAny(path, compile([...DEFAULT_TEST_PATTERNS, ...extraPatterns]));
}

/** Compile only patterns that actually compile; a broken pattern is not worth a crash. */
function compile(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const source of patterns) {
    try {
      out.push(new RegExp(source));
    } catch {
      // Ignored on purpose: a bad operator-supplied pattern must not take the reviewer
      // down. The failure direction is "one rule is weaker", never "nothing was reviewed".
    }
  }
  return out;
}

function matchesAny(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

/** Count non-overlapping matches of every marker in a document. */
function countMarkers(text: string, markers: readonly string[]): number {
  let total = 0;
  for (const marker of markers) {
    const found = text.match(new RegExp(marker, 'g'));
    if (found !== null) total += found.length;
  }
  return total;
}

/**
 * Run every rule and return what they found, in a stable order.
 *
 * The caller decides what the findings MEAN (see `review.ts`): a `block` finding is work
 * for the agent, and there are findings this file never produces because they are not
 * defects at all — that distinction is the difference between a reviewer and a nuisance.
 */
/**
 * Credential shapes precise enough to BLOCK on: a known prefix of a real token format, or a private
 * key header. Deliberately narrow — a pattern that also matches ordinary code would block honest
 * deliveries, and a gate that cries wolf gets switched off, which is worse than no gate.
 */
const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  /glpat-[A-Za-z0-9_-]{20,}/, // GitLab personal/project access token
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /\bsk-[A-Za-z0-9]{20,}/, // OpenAI-style API key
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, // Slack token
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // private key material
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
];

/** 1-based line number of an offset. */
function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) if (content[i] === '\n') line += 1;
  return line;
}

/**
 * A long run that LOOKS like a secret but is not provably one.
 *
 * The test is a mix of cases and digits plus length, which excludes the false positive that
 * matters: a plain hex digest (a lockfile entry, a git sha) has no upper/lower/digit MIX, so it is
 * never reported. This is a heuristic, so it goes to a HUMAN, never to a block.
 */
function highEntropyRun(content: string): { value: string; line: number } | null {
  const re = /[A-Za-z0-9+/=_-]{32,}/g;
  for (let match = re.exec(content); match !== null; match = re.exec(content)) {
    const value = match[0];
    if (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/[0-9]/.test(value)) continue;
    const distinct = new Set(value).size;
    if (distinct < 16) continue;
    return { value, line: lineOf(content, match.index) };
  }
  return null;
}

export function runReviewRules(input: ReviewInput, rules: ReviewRules = {}): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const testPatterns = compile([...DEFAULT_TEST_PATTERNS, ...(rules.testPathPatterns ?? [])]);
  const protectedPatterns = rules.replaceProtectedPaths === true
    ? compile(rules.protectedPaths ?? [])
    : compile([...DEFAULT_PROTECTED_PATTERNS, ...(rules.protectedPaths ?? [])]);

  const isTest = (path: string): boolean => matchesAny(path, testPatterns);
  const changes = input.changes;
  const testChanges = changes.filter((change) => isTest(change.path));
  const implementationChanges = changes.filter((change) => !isTest(change.path));

  // --- the tests may not be weakened ----------------------------------------
  if (rules.forbidTestWeakening !== false) {
    for (const change of testChanges) {
      if (change.status === 'deleted') {
        findings.push({
          rule: 'test-weakening/deleted',
          severity: 'block',
          path: change.path,
          detail: `the test file exists at ${input.baseSha.slice(0, 12)} and not at ${input.headSha.slice(0, 12)}: a deleted test is a removed proof, not a fix`,
        });
        continue;
      }
      if (change.baseContent === null || change.headContent === null) continue;

      const skipsBefore = countMarkers(change.baseContent, SKIP_MARKERS);
      const skipsAfter = countMarkers(change.headContent, SKIP_MARKERS);
      if (skipsAfter > skipsBefore) {
        findings.push({
          rule: 'test-weakening/skipped',
          severity: 'block',
          path: change.path,
          detail: `skip markers went from ${skipsBefore} to ${skipsAfter}: a skipped test is a test that no longer runs`,
        });
      }

      const assertionsBefore = countMarkers(change.baseContent, ASSERTION_MARKERS);
      const assertionsAfter = countMarkers(change.headContent, ASSERTION_MARKERS);
      if (assertionsAfter < assertionsBefore) {
        findings.push({
          rule: 'test-weakening/assertions-removed',
          severity: 'block',
          path: change.path,
          detail: `assertions went from ${assertionsBefore} to ${assertionsAfter}: fewer assertions is a weaker claim that still passes`,
        });
      }
    }
  }

  // --- a test that changed while the code under it did not ------------------
  // Only when nothing ALREADY has this change under suspicion: the note exists to flag the
  // ambiguous case ("is this item about the tests, or is it buying a green pipeline?"), and
  // stacking it on top of a weakening finding is noise on a defect rather than a question.
  const alreadySuspicious = findings.some((finding) => finding.rule.startsWith('test-weakening/'));
  const testOnly = rules.testOnlyChange ?? 'note';
  if (!alreadySuspicious && testOnly !== 'ignore' && testChanges.length > 0 && implementationChanges.length === 0) {
    findings.push({
      rule: 'test-only-change',
      severity: testOnly,
      detail:
        'no file outside the tests changed: legitimate when the item IS the tests, and the shape of "make the pipeline green by editing what it measures" when it is not — a human should see the item title next to this',
    });
  }

  // --- paths a machine may not approve --------------------------------------
  for (const change of implementationChanges) {
    if (matchesAny(change.path, protectedPatterns)) {
      // A protected path the delivery CREATES is the delivery. The implementer chooses the language and
      // the stack, and a stack choice is written down in exactly these files (package.json, go.mod,
      // Cargo.toml, a CI workflow); the delivery's own worktree starts empty, so "nothing of the sort
      // existed at the base" is the normal shape of a first delivery. The rule exists to stop a machine
      // from waving through a CHANGE to the configuration that builds a project that was already there —
      // so it keeps its teeth where a protected path existed (modified, renamed, deleted), and a creation
      // is reported as a note inside the delivery the human reads, which is where a black-box run makes
      // that decision (ADR-032). Without the distinction the rule stops every delivery with a manifest,
      // which is every delivery: a guard whose scope does not survive the path it runs on (ledger #27).
      const created = change.status === 'added';
      findings.push({
        rule: 'protected-path',
        severity: created ? 'note' : 'human',
        path: change.path,
        detail: created
          ? `this delivery CREATES a protected path (nothing of the sort existed at the base): how the implementer writes down a stack choice, reported for the human reading the delivery rather than treated as a change to configuration that was already there`
          : `this path is protected (CI configuration, dependency manifest, container build or takumi's own configuration): a machine must not wave it through, and an agent must not "fix" a legitimate change by reverting it — a human decides`,
        });
    }
  }

  // --- paths a delivery may never CONTAIN, however it got there (ledger #87) --
  // Distinct from the protected-path rule above: that one guards a change to something that existed, and
  // reports a CREATION as a note. This one is about a delivery that creates the platform's own file, and
  // its severity is `block` because the fix is mechanical — take it out of your delivery — and because no
  // delivery is legitimately about a grant. A MODIFICATION of one stays a human's call (ADR-045): a person
  // may legitimately update a grant, and the agent must never be told to revert that.
  //
  // `status === 'added'` IS NOT THE SAME AS "THIS DELIVERY CREATED IT" (ledger #90). The delivery review
  // runs with `baseRef: root` — the ROOT commit of the repository under review — so `git diff root..HEAD`
  // calls EVERY file the target repository ever added "added", including files that were already on its
  // main before this run started. Measured 2026-10-19: `takumi-delivery-demo` had carried copies of these
  // grants since its own `90c18a8`, and every subsequent delivery was refused for paths it never touched
  // (2 of 2 attempts, `verify-boundary-chain.sh`). A rule that reports a STANDING file as this delivery's
  // creation can never stop firing on that target, which is a guard whose scope does not survive the repo
  // it runs on (the same defect as ledger #27, one layer up).
  //
  // The check is `baseContent`: the file's content AT THE BASE the review compares against. When it is
  // present the path already existed at that base, so this delivery did not create it — and the finding is
  // NOT dropped, it is downgraded to the `human` severity a standing copy deserves. The `block` is kept for
  // the case the rule was written for: a path that did not exist at the base and appears in the change set.
  for (const change of input.changes) {
    if (change.status !== 'added') continue;
    if (!matchesAny(change.path, compile(NEVER_DELIVERED_PATTERNS))) continue;
    const stoodAtBase = (change.baseContent ?? '') !== '';
    findings.push({
      rule: 'never-delivered-path',
      severity: stoodAtBase ? 'human' : 'block',
      path: change.path,
      detail: stoodAtBase
        ? `a copy of the PLATFORM's own artefact was ALREADY at this review's base: this delivery did not create it, and no attempt to remove it belongs in its change set — a copy of a grant in a repository this run does not own leaks the platform's internals and the operator's identity, so a HUMAN must remove it from the TARGET (ledger #90). Until it is removed, every delivery to this repository reports this finding`
        : 'a delivery may never create this path: it is the PLATFORM\'s own artefact, and a copy of it in a target repository leaks the platform\'s internals and the operator\'s identity into a repository this run does not own — remove it from the change set',
    });
  }

  // --- credentials committed in the change (ADR-019) --------------------------
  // The rules above catch an agent WEAKENING its own tests. Nothing caught an agent committing a
  // credential, which is the other way a delivery can be worse than no delivery at all: a committed
  // secret is a leaked secret, and removing it in the next commit does not un-leak it.
  for (const change of input.changes) {
    const head = change.headContent ?? '';
    if (head.length === 0) continue;
    const base = change.baseContent ?? '';
    for (const pattern of DEFAULT_SECRET_PATTERNS) {
      const match = pattern.exec(head);
      if (match === null) continue;
      // A secret already at the BASE is not this change's doing. Reporting it every round would
      // bury the one that is — and the reviewer's subject is the change.
      if (base.includes(match[0])) continue;
      findings.push({
        rule: 'secret/committed',
        severity: 'block',
        path: change.path,
        line: lineOf(head, match.index),
        detail: `a credential appears in this change (…${match[0].slice(-6)}): remove it AND ROTATE IT — a committed secret is leaked the moment it is pushed`,
      });
      break; // one finding per file is enough to stop the delivery
    }
    const suspicious = highEntropyRun(head);
    if (suspicious !== null && !base.includes(suspicious.value)) {
      findings.push({
        rule: 'secret/suspected',
        severity: 'human',
        path: change.path,
        line: suspicious.line,
        detail: `a long high-entropy string (…${suspicious.value.slice(-6)}) looks like a credential; a person decides — if it is one, it must be rotated, not just removed`,
      });
    }
  }

  // --- a machine-answered decision must be FINDABLE IN THE DELIVERY (ADR-060, ledger #96) --------
  //
  // An unattended delivery answers decisions nobody read: the standing authorization took the
  // document's own `default:` for each one (ADR-045), and the record of that is the document's front
  // matter — not the code the agent just wrote. An operator reviewing overnight therefore holds a
  // delivery whose behaviour was partly chosen by a machine, with no way to find WHICH parts without
  // reconstructing the whole run. That is the difference between a delivery that is REVIEWABLE and one
  // that is merely finished, and it is the reason someone has to sit with it in the morning.
  //
  // The rule asks for the cheap thing that closes it: a `docs/decisions.md` naming every AMB-nnn, and
  // an `AMB-nnn` marker somewhere in the delivered files so `grep -rn 'AMB-002' .` LANDS on the code
  // that enacts it. It does NOT ask for the anchors to be correct — that is not mechanically checkable
  // (a comment can lie), and a rule that pretended otherwise would be the kind of gate that passes
  // because it was satisfied, not because it was true.
  //
  // Severity is `block`, not `human`: the fix is mechanical and entirely the AGENT's — add a table and
  // a one-line comment — and leaving it to a person means the person does the typing, which is the
  // thing this rule exists to avoid. `human` here would ALSO stop an unattended run, which is the
  // opposite of the intent: the point is that nobody has to wait.
  if (input.decisionIds !== undefined && input.decisionIds.length > 0) {
    const delivered = changes.filter((c) => c.status !== 'deleted');
    const fileText = (path: string): string => {
      const c = delivered.find((x) => x.path === path);
      return c?.headContent ?? '';
    };
    const decisionsDoc = fileText('docs/decisions.md');
    // Every delivered file EXCEPT the decisions table, as one haystack. The table names every id by
    // construction, so including it would make the marker check pass for free — the first version of
    // this rule did exactly that, and the test caught it (`both decisions are listed but neither is
    // findable`, 0 findings where 2 were owed). The marker has to be somewhere a reviewer would look
    // for the CODE, which is precisely not the file that lists the ids.
    const haystack = delivered
      .filter((c) => c.path !== 'docs/decisions.md')
      .map((c) => c.headContent ?? '')
      .join('\n');
    for (const id of input.decisionIds) {
      const inDoc = decisionsDoc.includes(id);
      const anchored = haystack.includes(id);
      if (inDoc && anchored) continue;
      const missing: string[] = [];
      if (!inDoc) missing.push(`\`docs/decisions.md\` does not mention ${id}`);
      if (!anchored) missing.push(`no delivered file carries an \`${id}\` marker, so \`grep -rn '${id}' .\` would not find where it is honoured`);
      findings.push({
        rule: 'decision-anchor',
        severity: 'block',
        path: inDoc ? undefined : 'docs/decisions.md',
        detail: `a machine answered ${id} from the document's own default, and this delivery cannot be reviewed without finding it: ${missing.join(', ')} (ADR-060). Record every AMB-nnn in docs/decisions.md with the answer and where it is implemented, and put a one-line \`${id}: <what it does>\` comment above the code that enacts it`,
      });
    }
  }

  return findings;
}

/** True when a finding is work the agent must do before this can merge. */
export function hasBlockingFinding(findings: readonly ReviewFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'block');
}

/** True when a finding needs a person — and must not be handed back to the agent. */
export function hasHumanFinding(findings: readonly ReviewFinding[]): boolean {
  return findings.some((finding) => finding.severity === 'human');
}

/** One line per finding, for a board comment or an event message. */
export function describeFindings(findings: readonly ReviewFinding[]): string {
  return findings
    .map((finding) => {
      // The LINE belongs in the rendered form. A finding a person cannot locate is a finding they
      // cannot act on, and this string is what travels to the board comment — recording the line in
      // the object and dropping it here left the field unavailable everywhere it is read.
      const where =
        finding.path === undefined
          ? ''
          : ` (${finding.path}${finding.line === undefined ? '' : `:${finding.line}`})`;
      return `${finding.rule}${where}: ${finding.detail}`;
    })
    .join('; ');
}
