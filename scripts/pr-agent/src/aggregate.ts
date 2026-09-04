import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { loadConfig } from './config.js';
import {
  mergeFindings,
  openBlocking,
  parseVerdictFromText,
  pruneStaleNitsFromSource,
  resolveStaleFindingsFromSource,
  sourceCounts,
  verdictToFindings,
} from './findings.js';
import { frozenPairFromFindings } from './rotate.js';
import { listAllIssueComments } from './state.js';
import { MARKER_BUGBOT_VERDICT, type AggregateOutput, type PrAgentState, type ReviewSlot } from './types.js';
import { isCiFailed, isCiGreen, type CiCheckStatus } from './ci-gates.js';
import { isExternalSource, type ExternalFindings } from './external-reviews.js';

export type ReviewOutputs = {
  standards?: string;
  depth?: string;
  codex?: string;
  bugbot?: string;
  bugbotCheckCompleted?: boolean;
  bugbotCheckSuccess?: boolean;
  /**
   * Whether Bugbot's check run appeared at all. `false` means Bugbot declined
   * the PR, which drops the slot from the effective pair rather than counting
   * as a negative review.
   */
  bugbotStarted?: boolean;
  /** Normalized live inline comments from allowlisted external bots. */
  external?: ExternalFindings;
};

/**
 * Slots that actually contributed an opinion this cycle. A Bugbot that never
 * opened a check run reviewed nothing, so scoring it as disapproval pinned
 * `consecutiveNoNewReviews` at 0 and stranded PRs that no CI event would ever
 * re-trigger (#3851 sat at cycle 1 with a clean standards approve). Bugbot
 * that *started* and then timed out keeps the conservative treatment.
 */
export function effectiveReviewPair(
  activePair: ReviewSlot[],
  reviews: ReviewOutputs,
): ReviewSlot[] {
  if (!activePair.includes('bugbot') || reviews.bugbotStarted !== false) {
    return activePair;
  }
  return activePair.filter((slot) => slot !== 'bugbot');
}

export function slotReviewSucceeded(slot: ReviewSlot, reviews: ReviewOutputs): boolean {
  if (slot === 'standards' || slot === 'depth' || slot === 'codex') {
    const text = reviews[slot];
    return !!text && !!parseVerdictFromText(text);
  }
  if (reviews.bugbotCheckCompleted !== true) return false;
  if (reviews.bugbot && parseVerdictFromText(reviews.bugbot)) return true;
  // Native Cursor Bugbot posts a GitHub review, not our marker comment.
  const reviewers = reviews.external?.reviewers ?? [];
  if (reviewers.includes('cursor[bot]')) return true;
  return (reviews.external?.current ?? []).some(
    (f) => String(f.source) === 'external:cursor[bot]',
  );
}

export function aggregateCycle(
  repoRoot: string,
  state: PrAgentState,
  reviews: ReviewOutputs,
  ciChecks: CiCheckStatus[],
  activePair: ReviewSlot[],
): AggregateOutput {
  const config = loadConfig(repoRoot);
  const cycle = state.cycle;
  let openFindings = [...state.openFindings];
  let resolvedFindings = [...state.resolvedFindings];
  let nitFindings = [...state.nitFindings];
  const newBlockingFingerprints: string[] = [];
  let allApproved = true;

  const muted = new Set(state.mutedFingerprints);

  const ingest = (
    text: string | undefined,
    source: ReviewSlot,
    options?: { resolveOnApprove?: boolean },
  ) => {
    if (!text) return;
    const verdict = parseVerdictFromText(text);
    if (!verdict) return;
    if (verdict.verdict !== 'approve') allApproved = false;
    const { blocking: rawBlocking, nits } = verdictToFindings(verdict, source, cycle, [
      ...openFindings,
      ...nitFindings,
    ]);
    // Drop findings a human marked as false positive via `agent-resolve`.
    const blocking = rawBlocking.filter((b) => !muted.has(b.fingerprint));
    const mergedOpen = mergeFindings(openFindings, blocking, cycle);
    openFindings = mergedOpen.merged;
    newBlockingFingerprints.push(...mergedOpen.newFingerprints);
    const mergedNits = mergeFindings(nitFindings, nits, cycle);
    nitFindings = mergedNits.merged;

    // `source` gave a genuine, current read on the PR this cycle: drop any of
    // its previously-open findings that it did not repeat (see
    // resolveStaleFindingsFromSource doc comment). Skipped when the caller
    // says this cycle's report can't be trusted (e.g. bugbot's GitHub Check
    // itself failed even though the parsed verdict text looked clean).
    const trustThisReport = options?.resolveOnApprove ?? true;
    if (trustThisReport) {
      const currentFingerprints = new Set(blocking.map((b) => b.fingerprint));
      const staleResolved = resolveStaleFindingsFromSource(
        openFindings,
        resolvedFindings,
        source,
        currentFingerprints,
        cycle,
      );
      openFindings = staleResolved.open;
      resolvedFindings = staleResolved.resolved;
      // Same reasoning for nits: one this source no longer reports is fixed.
      nitFindings = pruneStaleNitsFromSource(
        nitFindings,
        source,
        new Set(nits.map((n) => n.fingerprint)),
      );
    }
  };

  const effectivePair = effectiveReviewPair(activePair, reviews);

  if (effectivePair.includes('standards')) ingest(reviews.standards, 'standards');
  if (effectivePair.includes('depth')) ingest(reviews.depth, 'depth');
  if (effectivePair.includes('codex')) ingest(reviews.codex, 'codex');
  if (effectivePair.includes('bugbot')) {
    if (reviews.bugbotCheckCompleted === true && reviews.bugbot) {
      ingest(reviews.bugbot, 'bugbot', {
        resolveOnApprove: reviews.bugbotCheckSuccess === true,
      });
    }
    if (reviews.bugbotCheckCompleted === false) {
      allApproved = false;
    }
  }

  // External bot inline comments (Bugbot native, cubic, …) become findings so
  // the fixer addresses them without a human copy/pasting them into the loop.
  // They do not increment newBlockingFingerprints or stagnation counters
  // (external bots re-review on their own schedule). Live blocking comments
  // do flip allApproved so a native Bugbot defect cannot look like a clean
  // cycle. Lifecycle: live comment => open finding; outdated/deleted => resolved.
  if (reviews.external) {
    const extBlocking = reviews.external.current.filter(
      (f) => f.severity === 'blocking' && !muted.has(f.fingerprint),
    );
    const extNits = reviews.external.current.filter(
      (f) => f.severity === 'nit' && !muted.has(f.fingerprint),
    );
    if (extBlocking.length > 0) allApproved = false;
    openFindings = mergeFindings(openFindings, extBlocking, cycle).merged;
    nitFindings = mergeFindings(nitFindings, extNits, cycle).merged;

    const liveFingerprints = new Set(reviews.external.current.map((f) => f.fingerprint));
    const extSources = new Set([
      ...reviews.external.sources,
      ...openFindings.map((f) => String(f.source)).filter(isExternalSource),
    ]);
    for (const source of extSources) {
      const stale = resolveStaleFindingsFromSource(
        openFindings,
        resolvedFindings,
        source,
        liveFingerprints,
        cycle,
      );
      openFindings = stale.open;
      resolvedFindings = stale.resolved;
      nitFindings = pruneStaleNitsFromSource(nitFindings, source, liveFingerprints);
    }
  }

  const allSlotsSucceeded = effectivePair.every((slot) => slotReviewSucceeded(slot, reviews));

  const newBlockingCount = newBlockingFingerprints.length;
  const ciFailed =
    isCiFailed(ciChecks) || process.env.CI_TRIGGER_FAILED === 'true';
  const ciGreen = isCiGreen(ciChecks);

  // A cycle where reviewers were scheduled but none produced a usable verdict
  // (agent run failed, artifact missing, Bugbot never completed) carries zero
  // review signal. Consuming cycle budget or stagnation counters here produced
  // false diverging/budget_exhausted exits (#3716 cycle 4: "No model reviews
  // ran this cycle" still bumped both). Persist any external-comment ledger
  // updates, but leave every convergence counter untouched and schedule
  // nothing — the next genuine cycle re-runs the same pair.
  const anyReviewIngested = effectivePair.some((slot) => slotReviewSucceeded(slot, reviews));
  if (activePair.length > 0 && !anyReviewIngested) {
    return {
      state: {
        ...state,
        openFindings,
        resolvedFindings,
        nitFindings,
        lastPair: effectivePair,
      },
      shouldFix: false,
      shouldHandoff: false,
      handoffReason: undefined,
      ciFailed,
      newBlockingCount: 0,
      newBlockingFindings: [],
      emptyCycle: true,
    };
  }

  let consecutiveNoNewReviews = state.consecutiveNoNewReviews;
  if (newBlockingCount === 0 && allApproved && allSlotsSucceeded) {
    consecutiveNoNewReviews += 1;
  } else {
    consecutiveNoNewReviews = 0;
  }

  let phase = state.phase;
  let frozenPair = state.frozenPair;
  if (state.fixRound > 0 || openFindings.length > 0) {
    phase = 'convergence';
    if (!frozenPair || frozenPair.length < 2) {
      frozenPair = frozenPairFromFindings(sourceCounts(openFindings));
    }
  }

  let status = state.status;
  let handoffReason: AggregateOutput['handoffReason'];

  const openCount = openBlocking(openFindings).length;
  // Stagnation tracks the *fixer* failing to reduce open findings. It is only
  // meaningful when the fixer actually runs — never accumulate it in dry run,
  // where unchanged findings across review cycles are expected (no fixes land).
  // External findings are excluded: their resolution depends on GitHub marking
  // the underlying comment outdated, which lags our cycles and must not be
  // read as the fixer stalling.
  const internalOpenCount = openBlocking(openFindings).filter(
    (f) => !isExternalSource(String(f.source)),
  ).length;
  let stagnationFixRounds = state.stagnationFixRounds;
  if (config.dryRun) {
    stagnationFixRounds = 0;
  } else if (
    state.lastOpenCount !== undefined &&
    internalOpenCount === state.lastOpenCount &&
    internalOpenCount > 0
  ) {
    stagnationFixRounds += 1;
  } else if (internalOpenCount < (state.lastOpenCount ?? internalOpenCount)) {
    stagnationFixRounds = 0;
  }

  // When path-scoped CI is red and the fixer still has budget, do not let the
  // shared cycle counter force a human-ready handoff (#3224 / #3671). The
  // fixer's own maxFixRounds cap governs that case instead.
  const deferCycleCapForCiFix =
    ciFailed && state.fixRound < config.limits.maxFixRounds;

  if (state.fixRound >= config.limits.maxFixRounds) {
    status = 'budget_exhausted';
    handoffReason = 'budget_exhausted';
  } else if (
    state.cycle >= config.limits.maxOrchestratorCycles &&
    !deferCycleCapForCiFix
  ) {
    status = 'budget_exhausted';
    handoffReason = 'budget_exhausted';
  } else if (newBlockingCount >= config.limits.maxNewBlockingPerCycle) {
    status = 'diverging';
    handoffReason = 'diverging';
  } else if (stagnationFixRounds >= 2 && internalOpenCount > 0) {
    status = 'diverging';
    handoffReason = 'diverging';
  } else if (newBlockingCount >= 3 && state.fixRound >= 2) {
    status = 'diverging';
    handoffReason = 'diverging';
  }

  const cleanHandoff =
    ciGreen &&
    !ciFailed &&
    openCount === 0 &&
    consecutiveNoNewReviews >= config.limits.consecutiveNoNewReviewsForHandoff;

  if (cleanHandoff && status === 'in_progress') {
    status = 'human_handoff';
    handoffReason = 'human_handoff';
  }

  const shouldHandoff =
    status === 'human_handoff' || status === 'budget_exhausted' || status === 'diverging';

  const shouldFix =
    !shouldHandoff &&
    status === 'in_progress' &&
    (openCount > 0 || ciFailed) &&
    state.fixRound < config.limits.maxFixRounds;

  const nextState: PrAgentState = {
    ...state,
    cycle: cycle + 1,
    totalReviewerRuns: state.totalReviewerRuns + 1,
    openFindings,
    resolvedFindings,
    nitFindings,
    consecutiveNoNewReviews,
    phase,
    frozenPair,
    lastPair: effectivePair,
    status,
    stagnationFixRounds,
    lastOpenCount: internalOpenCount,
  };

  const newFingerprintSet = new Set(newBlockingFingerprints);
  const newBlockingFindings = openFindings.filter(
    (f) => newFingerprintSet.has(f.fingerprint) && f.status === 'open',
  );

  // No CI gate matches this diff, so no `workflow_run` completion will ever
  // arrive, and with no fix scheduled there is no push either. This cycle was
  // the last event the PR would get; ask the workflow to self-dispatch so the
  // clean-cycle counter can still reach the handoff threshold.
  const needsContinuation = !shouldHandoff && !shouldFix && ciChecks.length === 0;

  return {
    state: nextState,
    shouldFix,
    shouldHandoff,
    handoffReason,
    ciFailed,
    newBlockingCount,
    newBlockingFindings,
    needsContinuation,
  };
}

export function loadReviewOutput(repoRoot: string, slot: ReviewSlot): string | undefined {
  const path = join(repoRoot, `.pr-agent/review-${slot}.txt`);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8');
}

export async function loadBugbotVerdict(
  octokit: Octokit,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<string | undefined> {
  const comments = await listAllIssueComments(octokit, owner, repo, issueNumber);

  const triggerComments = comments.filter(
    (c) => c.body?.trim() === 'bugbot run' || c.body?.includes('bugbot run'),
  );
  const latestTrigger = [...triggerComments].sort(
    (a, b) =>
      new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
  )[0];
  if (!latestTrigger?.created_at) return undefined;

  const triggerTime = new Date(latestTrigger.created_at).getTime();
  const verdictComment = [...comments]
    .filter(
      (c) =>
        c.body?.includes(MARKER_BUGBOT_VERDICT) &&
        new Date(c.created_at ?? 0).getTime() >= triggerTime,
    )
    .sort(
      (a, b) =>
        new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
    )[0];

  return verdictComment?.body ?? undefined;
}
