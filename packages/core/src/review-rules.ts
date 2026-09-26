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
export const REVIEW_RULESET_ID = 'rules@1';

export interface ReviewFinding {
  /** Stable rule id, so a board comment and a test can name the same thing. */
  rule: string;
  severity: ReviewSeverity;
  path?: string;
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
      findings.push({
        rule: 'protected-path',
        severity: 'human',
        path: change.path,
        detail: `this path is protected (CI configuration, dependency manifest, container build or takumi's own configuration): a machine must not wave it through, and an agent must not "fix" a legitimate change by reverting it — a human decides`,
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
    .map((finding) => `${finding.rule}${finding.path === undefined ? '' : ` (${finding.path})`}: ${finding.detail}`)
    .join('; ');
}
