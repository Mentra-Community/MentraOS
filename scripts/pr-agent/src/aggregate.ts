import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Octokit } from '@octokit/rest';
import { loadConfig } from './config.js';
import {
  mergeFindings,
  openBlocking,
  parseVerdictFromText,
  resolveOpenFindingsFromSource,
  sourceCounts,
  verdictToFindings,
} from './findings.js';
import { frozenPairFromFindings } from './rotate.js';
import { listAllIssueComments } from './state.js';
import { MARKER_BUGBOT_VERDICT, type AggregateOutput, type PrAgentState, type ReviewSlot } from './types.js';
import { isCiFailed, isCiGreen, type CiCheckStatus } from './ci-gates.js';

export type ReviewOutputs = {
  standards?: string;
  depth?: string;
  bugbot?: string;
  bugbotCheckSuccess?: boolean;
};

function slotReviewSucceeded(slot: ReviewSlot, reviews: ReviewOutputs): boolean {
  if (slot === 'standards' || slot === 'depth') {
    const text = slot === 'standards' ? reviews.standards : reviews.depth;
    return !!text && !!parseVerdictFromText(text);
  }
  if (reviews.bugbot && parseVerdictFromText(reviews.bugbot)) return true;
  return reviews.bugbotCheckSuccess === true;
}

export function aggregateCycle(
  repoRoot: string,
  state: PrAgentState,
  reviews: ReviewOutputs,
  ciChecks: CiCheckStatus[],
  activePair: ReviewSlot[],
): AggregateOutput {
  const config = loadConfig(repoRoot);
  let cycle = state.cycle;
  let openFindings = [...state.openFindings];
  let resolvedFindings = [...state.resolvedFindings];
  let nitFindings = [...state.nitFindings];
  let newBlockingFingerprints: string[] = [];
  let allApproved = true;

  const ingest = (text: string | undefined, source: ReviewSlot) => {
    if (!text) return;
    const verdict = parseVerdictFromText(text);
    if (!verdict) return;
    if (verdict.verdict !== 'approve') allApproved = false;
    const { blocking, nits } = verdictToFindings(verdict, source, cycle);
    const mergedOpen = mergeFindings(openFindings, blocking, cycle);
    openFindings = mergedOpen.merged;
    newBlockingFingerprints.push(...mergedOpen.newFingerprints);
    const mergedNits = mergeFindings(nitFindings, nits, cycle);
    nitFindings = mergedNits.merged;
    if (verdict.verdict === 'approve' && blocking.length === 0) {
      const resolved = resolveOpenFindingsFromSource(
        openFindings,
        resolvedFindings,
        source,
        cycle,
      );
      openFindings = resolved.open;
      resolvedFindings = resolved.resolved;
    }
  };

  if (activePair.includes('standards')) ingest(reviews.standards, 'standards');
  if (activePair.includes('depth')) ingest(reviews.depth, 'depth');
  if (activePair.includes('bugbot')) {
    if (reviews.bugbot) {
      ingest(reviews.bugbot, 'bugbot');
    }
    if (reviews.bugbotCheckSuccess === false) {
      allApproved = false;
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
  let stagnationFixRounds = state.stagnationFixRounds;
  if (state.lastOpenCount !== undefined && openCount === state.lastOpenCount && openCount > 0) {
    stagnationFixRounds += 1;
  } else if (openCount < (state.lastOpenCount ?? openCount)) {
    stagnationFixRounds = 0;
  }

  if (state.fixRound >= config.limits.maxFixRounds) {
    status = 'budget_exhausted';
    handoffReason = 'budget_exhausted';
  } else if (state.cycle >= config.limits.maxOrchestratorCycles) {
    status = 'budget_exhausted';
    handoffReason = 'budget_exhausted';
  } else if (newBlockingCount >= config.limits.maxNewBlockingPerCycle) {
    status = 'diverging';
    handoffReason = 'diverging';
  } else if (stagnationFixRounds >= 2 && openCount > 0) {
    status = 'diverging';
    handoffReason = 'diverging';
  } else if (newBlockingCount >= 3 && state.fixRound >= 2) {
    status = 'diverging';
    handoffReason = 'diverging';
  }

  const cleanHandoff =
    ciGreen &&
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
    lastOpenCount: openCount,
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
  const verdictComment = [...comments]
    .reverse()
    .find((c) => c.body?.includes(MARKER_BUGBOT_VERDICT));
  return verdictComment?.body ?? undefined;
}
