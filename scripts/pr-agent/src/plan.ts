import { loadConfig } from './config.js';
import { resolveActivePair } from './rotate.js';
import {
  createOctokit,
  loadOrCreateState,
  prHasLabel,
  saveState,
} from './state.js';
import { getChangedFiles } from './ci-gates.js';
import type { PlanOutput } from './types.js';

export async function runPlan(repoRoot: string): Promise<PlanOutput> {
  const config = loadConfig(repoRoot);
  const owner = process.env.GITHUB_REPOSITORY_OWNER!;
  const repo = process.env.GITHUB_REPOSITORY?.split('/')[1]!;
  const prNumber = Number(process.env.PR_NUMBER);
  const author = process.env.PR_AUTHOR ?? '';
  const isDraft = process.env.PR_DRAFT === 'true';
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

  if (isDraft && !labelNames.includes('agent-review')) {
    return skipPlan(octokit, owner, repo, prNumber, 'draft PR');
  }

  const { state, commentId } = await loadOrCreateState(octokit, owner, repo, prNumber);

  if (state.status !== 'in_progress' && !labelNames.includes('agent-resume')) {
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

  if (state.cycle >= config.limits.maxOrchestratorCycles) {
    return {
      runBugbot: false,
      runStandards: false,
      runDepth: false,
      activePair: [],
      state: { ...state, status: 'budget_exhausted' },
      shouldSkip: true,
      skipReason: 'max cycles',
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

export async function writePlanOutputs(plan: PlanOutput): Promise<void> {
  const { appendFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;

  const set = (k: string, v: string) => appendFileSync(out, `${k}=${v}\n`);

  set('should_skip', String(plan.shouldSkip));
  set('skip_reason', plan.skipReason ?? '');
  set('run_bugbot', String(plan.runBugbot));
  set('run_standards', String(plan.runStandards));
  set('run_depth', String(plan.runDepth));
  set('active_pair', plan.activePair.join(','));
  set('is_dry_run', String(loadConfig(process.cwd()).dryRun));
}

export { getChangedFiles };
