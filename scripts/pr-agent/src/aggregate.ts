import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { loadConfig } from './config.js';
import {
  mergeFindings,
  openBlocking,
  parseVerdictFromText,
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
  bugbot?: string;
  bugbotCheckCompleted?: boolean;
  bugbotCheckSuccess?: boolean;
  /** Normalized live inline comments from allowlisted external bots. */
  external?: ExternalFindings;
};

function slotReviewSucceeded(slot: ReviewSlot, reviews: ReviewOutputs): boolean {
  if (slot === 'standards' || slot === 'depth') {
    const text = slot === 'standards' ? reviews.standards : reviews.depth;
    return !!text && !!parseVerdictFromText(text);
  }
  if (reviews.bugbotCheckCompleted !== true) return false;
  return !!reviews.bugbot && !!parseVerdictFromText(reviews.bugbot);
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
    }
  };

  if (activePair.includes('standards')) ingest(reviews.standards, 'standards');
  if (activePair.includes('depth')) ingest(reviews.depth, 'depth');
  if (activePair.includes('bugbot')) {
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
  // They deliberately do NOT touch newBlockingFingerprints, allApproved, or
  // stagnation counters: external bots re-review on their own schedule, so our
  // convergence bookkeeping cannot key off their cadence. Their lifecycle is:
  // live comment => open finding; comment outdated/deleted => resolved.
  if (reviews.external) {
    const extBlocking = reviews.external.current.filter(
      (f) => f.severity === 'blocking' && !muted.has(f.fingerprint),
    );
    const extNits = reviews.external.current.filter(
      (f) => f.severity === 'nit' && !muted.has(f.fingerprint),
    );
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
    }
  }

  const allSlotsSucceeded = activePair.every((slot) => slotReviewSucceeded(slot, reviews));

  const newBlockingCount = newBlockingFingerprints.length;
  const ciFailed =
    isCiFailed(ciChecks) || process.env.CI_TRIGGER_FAILED === 'true';
  const ciGreen = isCiGreen(ciChecks);

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
    lastPair: activePair,
    status,
    stagnationFixRounds,
    lastOpenCount: internalOpenCount,
  };

  return {
    state: nextState,
    shouldFix,
    shouldHandoff,
    handoffReason,
    ciFailed,
    newBlockingCount,
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
