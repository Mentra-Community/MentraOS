import { loadConfig } from './config.js';
import { resolveActivePair } from './rotate.js';
import { applyResolvedIds, openBlocking, parseResolveIds } from './findings.js';
import {
  createOctokit,
  listAllIssueComments,
  loadOrCreateState,
  prHasLabel,
  removeLabel,
  saveState,
} from './state.js';
import {
  fetchWorkflowStatuses,
  getChangedFiles,
  getPrHeadSha,
  isCiFailed,
  requiredWorkflowsForPaths,
} from './ci-gates.js';
import type { PlanOutput } from './types.js';

export async function runPlan(repoRoot: string): Promise<PlanOutput> {
  const config = loadConfig(repoRoot);
  const owner = process.env.GITHUB_REPOSITORY_OWNER!;
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]!;
  const prNumber = Number(process.env.PR_NUMBER);
  const author = process.env.PR_AUTHOR ?? '';
  const isFork = process.env.PR_IS_FORK === 'true';
  const forceRotation = process.env.FORCE_ROTATION === 'true';

  const octokit = createOctokit();

  if (await prHasLabel(octokit, owner, repo, prNumber, 'agent-stop')) {
    return {
      runBugbot: false,
      runStandards: false,
      runDepth: false,
      activePair: [],
      state: (await loadOrCreateState(octokit, owner, repo, prNumber)).state,
      shouldSkip: true,
      skipReason: 'agent-stop label',
    };
  }

  if (await prHasLabel(octokit, owner, repo, prNumber, 'ready-for-human-review')) {
    const hasResume = await prHasLabel(octokit, owner, repo, prNumber, 'agent-resume');
    if (!hasResume) {
      const { state } = await loadOrCreateState(octokit, owner, repo, prNumber);
      return {
        runBugbot: false,
        runStandards: false,
        runDepth: false,
        activePair: [],
        state,
        shouldSkip: true,
        skipReason: 'awaiting human handoff',
      };
    }
  }

  const labels = await octokit.issues.get({ owner, repo, issue_number: prNumber });
  const labelNames = (labels.data.labels ?? []).map((l) =>
    typeof l === 'string' ? l : l.name!,
  );

  if (config.authors.mode === 'allowlist' && !config.authors.allowlist.includes(author)) {
    return skipPlan(octokit, owner, repo, prNumber, 'author not in allowlist');
  }
  if (config.authors.mode === 'label_only' && !labelNames.includes('agent-review')) {
    return skipPlan(octokit, owner, repo, prNumber, 'missing agent-review label');
  }

  const { state: loadedState, commentId } = await loadOrCreateState(
    octokit,
    owner,
    repo,
    prNumber,
  );
  let state = loadedState;

  if (labelNames.includes('agent-resume')) {
    // Grant a fresh budget window. Without resetting cycle/fixRound, a PR
    // that already crossed maxOrchestratorCycles or maxFixRounds would
    // immediately re-trigger budget_exhausted on its very next cycle, making
    // agent-resume a near no-op for any long-lived PR. The finding ledger
    // (openFindings/resolvedFindings/mutedFingerprints) is preserved as-is.
    state = {
      ...state,
      status: 'in_progress',
      consecutiveNoNewReviews: 0,
      cycle: 0,
      fixRound: 0,
      stagnationFixRounds: 0,
    };
    await removeLabel(octokit, owner, repo, prNumber, 'agent-resume');
    await removeLabel(octokit, owner, repo, prNumber, 'ready-for-human-review');
    await removeLabel(octokit, owner, repo, prNumber, 'agent-needs-human');
    await removeLabel(octokit, owner, repo, prNumber, 'agent-ci-failing');
    await saveState(octokit, owner, repo, prNumber, state, commentId);
  }

  const resolveIds = parseResolveIds(
    (await listAllIssueComments(octokit, owner, repo, prNumber)).map((c) => c.body),
  );
  if (resolveIds.length > 0) {
    const applied = applyResolvedIds(state, resolveIds, state.cycle);
    if (applied.changed) {
      state = {
        ...state,
        openFindings: applied.openFindings,
        resolvedFindings: applied.resolvedFindings,
        mutedFingerprints: applied.mutedFingerprints,
      };
      await saveState(octokit, owner, repo, prNumber, state, commentId);
      console.log(`Resolved findings via agent-resolve: ${resolveIds.join(', ')}`);
    }
  }

  if (process.env.CI_RECHECK_ONLY === 'true') {
    if (state.status !== 'in_progress') {
      return {
        runBugbot: false,
        runStandards: false,
        runDepth: false,
        activePair: [],
        state,
        shouldSkip: true,
        skipReason: `ci recheck skipped: status ${state.status}`,
      };
    }
    return {
      runBugbot: false,
      runStandards: false,
      runDepth: false,
      activePair: [],
      state,
      shouldSkip: false,
      recheckOnly: true,
    };
  }

  if (state.status !== 'in_progress') {
    return {
      runBugbot: false,
      runStandards: false,
      runDepth: false,
      activePair: [],
      state,
      shouldSkip: true,
      skipReason: `status ${state.status}`,
    };
  }

  // Reviews already converged: no open blocking findings and enough clean
  // cycles for handoff. The only thing left to wait for is CI, so re-running
  // model reviews of an unchanged diff just burns credits (#3648 spent 8 full
  // review cycles — ~16 model runs — reaching a handoff that needed 2). Route
  // straight to the wait-ci -> recheck-handoff path instead.
  if (
    openBlocking(state.openFindings).length === 0 &&
    state.consecutiveNoNewReviews >= config.limits.consecutiveNoNewReviewsForHandoff
  ) {
    console.log(
      `Reviews clean (consecutiveNoNewReviews=${state.consecutiveNoNewReviews}); skipping model reviews, CI recheck only`,
    );
    await saveState(octokit, owner, repo, prNumber, state, commentId);
    return {
      runBugbot: false,
      runStandards: false,
      runDepth: false,
      activePair: [],
      state,
      shouldSkip: false,
      recheckOnly: true,
      skipReason: 'reviews clean; awaiting CI',
    };
  }

  if (state.cycle >= config.limits.maxOrchestratorCycles) {
    // Mirror aggregate: when CI is red and the fixer still has rounds left,
    // do not force budget_exhausted — continue with reviews skipped so
    // aggregate can set shouldFix and the fixer can react to the CI failure.
    let ciFailed = process.env.CI_TRIGGER_FAILED === 'true';
    if (!ciFailed && state.fixRound < config.limits.maxFixRounds) {
      try {
        const ref = await getPrHeadSha(octokit, owner, repo, prNumber);
        const changedFiles = await getChangedFiles(octokit, owner, repo, prNumber);
        const required = requiredWorkflowsForPaths(changedFiles, repoRoot);
        const ciChecks = await fetchWorkflowStatuses(octokit, owner, repo, ref, required);
        ciFailed = isCiFailed(ciChecks);
      } catch (err) {
        console.warn('plan: failed to fetch CI status for cycle-cap deferral', err);
      }
    }

    if (ciFailed && state.fixRound < config.limits.maxFixRounds) {
      console.log(
        `Cycle cap reached (${state.cycle}) but CI failed with fixRound=${state.fixRound}; deferring handoff for fixer`,
      );
      await saveState(octokit, owner, repo, prNumber, state, commentId);
      return {
        runBugbot: false,
        runStandards: false,
        runDepth: false,
        activePair: [],
        state,
        shouldSkip: false,
        skipReason: 'max cycles deferred for CI fix',
      };
    }

    const exhausted = { ...state, status: 'budget_exhausted' as const };
    await saveState(octokit, owner, repo, prNumber, exhausted, commentId);
    return {
      runBugbot: false,
      runStandards: false,
      runDepth: false,
      activePair: [],
      state: exhausted,
      shouldSkip: true,
      skipReason: 'max cycles',
      shouldHandoff: true,
      handoffReason: 'budget_exhausted',
    };
  }

  const activePair = resolveActivePair(state, forceRotation);

  const output: PlanOutput = {
    runBugbot: activePair.includes('bugbot'),
    runStandards: activePair.includes('standards'),
    runDepth: activePair.includes('depth'),
    activePair,
    state,
    shouldSkip: false,
  };

  if (isFork) {
    console.log('Fork PR: reviews only, fixer will be skipped');
  }

  await saveState(octokit, owner, repo, prNumber, state, commentId);
  return output;
}

async function skipPlan(
  octokit: ReturnType<typeof createOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  reason: string,
): Promise<PlanOutput> {
  const { state } = await loadOrCreateState(octokit, owner, repo, prNumber);
  return {
    runBugbot: false,
    runStandards: false,
    runDepth: false,
    activePair: [],
    state,
    shouldSkip: true,
    skipReason: reason,
  };
}

export async function writePlanOutputs(repoRoot: string, plan: PlanOutput): Promise<void> {
  const { appendFileSync } = await import('node:fs');
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;

  const set = (k: string, v: string) => appendFileSync(out, `${k}=${v}\n`);

  set('should_skip', String(plan.shouldSkip));
  set('skip_reason', plan.skipReason ?? '');
  set('run_bugbot', String(plan.runBugbot));
  set('run_standards', String(plan.runStandards));
  set('run_depth', String(plan.runDepth));
  set('active_pair', plan.activePair.join(','));
  set('is_dry_run', String(loadConfig(repoRoot).dryRun));
  set('should_handoff', String(plan.shouldHandoff ?? false));
  set('handoff_reason', plan.handoffReason ?? '');
  set('recheck_only', String(plan.recheckOnly ?? false));
}

export { getChangedFiles };
